// WebLoom v4 advanced 装配入口。
// 这些 API 是同一套 Host/transport 实现的显式扩展，不提供旧 API 兼容层。

export * from "./host/createPluginHost.js";
export * from "./host/pluginGraph.js";
export * from "./host/capabilityRegistry.js";
export * from "./host/runtimeUnitImplementationRegistry.js";
export * from "./lifecycle/resourceScope.js";
export * from "./lifecycle/permissionLease.js";
export * from "./lifecycle/permissionVerifier.js";
export * from "./lifecycle/taskScheduler.js";
export * from "./lifecycle/scopedRegistry.js";
export * from "./lifecycle/upgradeGate.js";
export * from "./runtime/pluginPackage.js";
export { createResourceRegistry, registerOwnedResource } from "./resources/resourceRegistry.js";
/** Resource Store 的 advanced 类型出口；显式 alias 可被 dts bundler 保留。 */
export type ResourceStoreApi = import("./resources/resourceStore.js").ResourceStoreApi;
export * from "./transport/serviceBridge.js";
export * from "./transport/messagePortServiceTransport.js";
export * from "./transport/messagePortServiceProvider.js";
export { createWindowAppFromHost, hostForWindowApp } from "./runtime/windowRuntime.js";
export { bridgeForRuntimeHandle } from "./runtime/connectSharedWorker.js";
export type { ActivePeerSnapshot, PeerController, PeerExposureOptions, PeerLifecycleEvent, StartSharedWorkerAppOptions, StartSharedWorkerAppForTestingOptions, SharedWorkerApp } from "./runtime/sharedWorkerHost.js";
export * from "./runtime/runtimeProtocol.js";
export * from "./runtime/runtimeSession.js";

import type { RuntimeHandle, WindowApp } from "./runtime/runtimeTypes.js";
import type { RuntimePluginDefinition } from "./runtime/pluginDefinitions.js";
import { materializePluginDefinitions } from "./runtime/pluginDefinitions.js";
import { hostForWindowApp } from "./runtime/windowRuntime.js";
import { bridgeForRuntimeHandle } from "./runtime/connectSharedWorker.js";
import { capabilityKey, type Capability, type CapabilityBridge } from "./contracts/capability.js";

/** 分阶段向已经拥有的 App 注册新的 typed plugin definitions。 */
export async function registerPlugins(app: WindowApp, definitions: readonly RuntimePluginDefinition[]): Promise<void> {
  const host = hostForWindowApp(app);
  const materialized = materializePluginDefinitions(definitions, app.runtimeKind);
  for (const definition of materialized) host.registerImplementation({ pluginId: definition.manifest.id, unitId: definition.unitId, setup: definition.setup, capabilities: definition.capabilities });
  await host.registerAll(materialized.map((definition) => definition.manifest));
}

/**
 * 把一个连接绑定到现有 WindowApp 的运行时槽位。
 *
 * 同一个 Window 可以并存多个 Worker：每个 `slot` 一个 bridge，新增槽位不会撤销已有
 * 槽位。返回的卸载函数只断开它自己注册的那条连接，并且只在该槽位仍然是它注册的那条
 * 连接时才生效——替换后的新连接不会被旧卸载函数断开（PSM-R12）。
 */
export async function attachRemote(
  app: WindowApp,
  runtime: RuntimeHandle,
  slot: string | { readonly slotId: string } = "default",
): Promise<() => void> {
  const host = hostForWindowApp(app);
  const bridge: CapabilityBridge = bridgeForRuntimeHandle(runtime);
  const slotId = typeof slot === "string" ? slot : slot.slotId;
  // 记录本次挂接的连接世代：同槽位被新连接替换后，旧 cleanup 变成空操作。
  const connection = host.attachRemote(bridge, slotId);
  await host.reconcile();
  let detached = false;
  return () => {
    if (detached) return;
    detached = true;
    host.detachRemote("Remote Runtime detached", { slotId, generation: connection.generation });
  };
}

/**
 * 绑定单元的远端依赖到具体运行时槽位（PSM-R12）。
 *
 * 返回的绑定信息交给 HostOptions.runtimeSlotBindings；它决定某个单元的远端依赖从哪个
 * Worker 解析，而不是按 kind 扫描第一个服务。
 */
export function bindUnitSlot(input: {
  readonly pluginId: string;
  readonly unitId: string;
  readonly slotId: string;
  readonly capabilities?: readonly { readonly capability: Capability }[];
}): Record<string, string> {
  const prefix = `${input.pluginId}\u0000${input.unitId}`;
  const bindings: Record<string, string> = { [prefix]: input.slotId };
  for (const item of input.capabilities ?? []) {
    bindings[`${prefix}\u0000${capabilityKey(item.capability)}`] = input.slotId;
  }
  return bindings;
}
