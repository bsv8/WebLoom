// WebLoom v4 advanced 装配入口。
// 这些 API 是同一套 Host/transport 实现的显式扩展，不提供旧 API 兼容层。

export * from "./host/createPluginHost.js";
export * from "./host/pluginGraph.js";
export * from "./host/capabilityRegistry.js";
export * from "./host/runtimeUnitImplementationRegistry.js";
export * from "./lifecycle/resourceScope.js";
export * from "./lifecycle/permissionLease.js";
export * from "./lifecycle/permissionVerifier.js";
export * from "./lifecycle/pluginIntentController.js";
export * from "./lifecycle/taskScheduler.js";
export * from "./lifecycle/scopedRegistry.js";
export * from "./lifecycle/upgradeGate.js";
export { createResourceRegistry, registerOwnedResource } from "./resources/resourceRegistry.js";
/** Resource Store 的 advanced 类型出口；显式 alias 可被 dts bundler 保留。 */
export type ResourceStoreApi = import("./resources/resourceStore.js").ResourceStoreApi;
export * from "./transport/serviceBridge.js";
export * from "./transport/messagePortServiceTransport.js";
export * from "./transport/messagePortServiceProvider.js";
export { createWindowAppFromHost, hostForWindowApp } from "./runtime/windowRuntime.js";
export { bridgeForRuntimeHandle } from "./runtime/connectSharedWorker.js";
export type { PeerController, PeerExposureOptions, StartSharedWorkerAppOptions, StartSharedWorkerAppForTestingOptions, SharedWorkerApp } from "./runtime/sharedWorkerHost.js";
export * from "./runtime/runtimeProtocol.js";

import type { RuntimeHandle, WindowApp } from "./runtime/runtimeTypes.js";
import type { RuntimePluginDefinition } from "./runtime/pluginDefinitions.js";
import { materializePluginDefinitions } from "./runtime/pluginDefinitions.js";
import { hostForWindowApp } from "./runtime/windowRuntime.js";
import { bridgeForRuntimeHandle } from "./runtime/connectSharedWorker.js";
import type { CapabilityBridge } from "./contracts/capability.js";

/** 分阶段向已经拥有的 App 注册新的 typed plugin definitions。 */
export async function registerPlugins(app: WindowApp, definitions: readonly RuntimePluginDefinition[]): Promise<void> {
  const host = hostForWindowApp(app);
  const materialized = materializePluginDefinitions(definitions, app.runtimeKind);
  for (const definition of materialized) host.registerImplementation({ pluginId: definition.manifest.id, unitId: definition.unitId, setup: definition.setup, capabilities: definition.capabilities });
  await host.registerAll(materialized.map((definition) => definition.manifest));
}

/** 把一个连接绑定到现有 WindowApp；替换时先撤销旧 bridge。 */
export async function attachRemote(app: WindowApp, runtime: RuntimeHandle): Promise<() => void> {
  const host = hostForWindowApp(app);
  const bridge: CapabilityBridge = bridgeForRuntimeHandle(runtime);
  host.attachRemote(bridge);
  await host.reconcile();
  return () => host.detachRemote("Remote Runtime detached");
}
