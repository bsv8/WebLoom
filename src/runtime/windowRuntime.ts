// Window Runtime 装配。

import type { Capability, CapabilityClient } from "../contracts/capability.js";
import { RUNTIME_PROTOCOL_VERSION } from "./runtimeProtocol.js";
import type { PluginManifest } from "../contracts/plugin.js";
import { createPluginHost, StartupPluginError, type CreatePluginHostOptions, type HostInspection, type PluginHost } from "../host/createPluginHost.js";
import { createRuntimeUnitImplementationRegistry } from "../host/runtimeUnitImplementationRegistry.js";
import type { LifecycleDisposeResult, RuntimeSnapshot } from "../contracts/lifecycle.js";
import type { RuntimePluginDefinition } from "./pluginDefinitions.js";
import { materializePluginDefinitions } from "./pluginDefinitions.js";
import { RuntimeInitializationError, RuntimeUnavailableError, type RuntimeStatusListener, type RuntimeStatusSnapshot, type WindowApp } from "./runtimeTypes.js";
import { cloneFrozenAttributes } from "../transport/dto.js";

export interface CreateWindowAppOptions extends Omit<CreatePluginHostOptions, "runtime" | "runtimeUnitImplementationRegistry" | "runtimeInstanceId" | "runtimeId" | "capabilityBridge"> {
  /** Window Runtime 逻辑标识。 */
  readonly id?: string;
  /** 当前 Window realm 的插件定义。 */
  readonly plugins: readonly RuntimePluginDefinition[];
}

export interface CreateWindowAppFromHostOptions extends Omit<CreatePluginHostOptions, "runtime" | "runtimeUnitImplementationRegistry" | "capabilityBridge"> {
  /** Window Runtime 逻辑标识。 */
  readonly id?: string;
  /** 已创建且所有权转移给 App 的 v4 Host。 */
  readonly host: PluginHost;
}

const appHosts = new WeakMap<object, PluginHost>();
const ownedHosts = new WeakSet<object>();

function makeRuntimeInstanceId(runtimeId: string): string {
  try { if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return `${runtimeId}:${crypto.randomUUID()}`; } catch { /* fallback */ }
  return `${runtimeId}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function snapshotFromHost(host: PluginHost, id: string, instanceId: string, state: RuntimeSnapshot["state"] = "ready"): RuntimeStatusSnapshot {
  const units = host.installed().flatMap((pluginId) => host.state(pluginId).units.map((unit) => ({ pluginId: unit.pluginId, unitId: unit.unitId, runtime: unit.runtime, ...(unit.instanceId !== undefined ? { instanceId: unit.instanceId } : {}), state: unit.kind })));
  const services = state === "ready" ? host.serviceReferences().map((service) => ({ kind: service.kind, capabilityId: service.capabilityId, contractVersion: service.contractVersion, serviceInstanceId: service.serviceInstanceId, attributes: cloneFrozenAttributes(service.attributes), ...(service.grantId !== undefined ? { grantId: service.grantId } : {}), ...(service.authorizationRevision !== undefined ? { authorizationRevision: service.authorizationRevision } : {}) })) : [];
  return Object.freeze({ protocolVersion: RUNTIME_PROTOCOL_VERSION, runtimeId: id, runtimeKind: "window-main", runtimeInstanceId: instanceId, revision: Math.max(1, host.version()), state, units: Object.freeze(units), services: Object.freeze(services) });
}

async function createAppFromHost(id: string, instanceId: string, host: PluginHost): Promise<WindowApp> {
  if (ownedHosts.has(host as object)) throw new Error("This WebLoom Host is already owned by a WindowApp");
  let current = snapshotFromHost(host, id, instanceId, "starting");
  let disposed = false;
  let disposePromise: Promise<LifecycleDisposeResult> | undefined;
  const listeners = new Set<RuntimeStatusListener>();
  const emit = (state?: RuntimeSnapshot["state"]): void => {
    current = snapshotFromHost(host, id, instanceId, state ?? (disposed ? "disposed" : "ready"));
    for (const listener of [...listeners]) { try { listener(current); } catch { /* observers isolated */ } }
  };
  const removeHost = host.subscribe(() => emit());
  const app: WindowApp = {
    runtimeKind: "window-main",
    runtimeId: id,
    runtimeInstanceId: instanceId,
    state: () => current,
    pluginState: (pluginId) => host.state(pluginId),
    capability<C extends Capability>(capability: C): CapabilityClient<C> {
      if (disposed) throw new RuntimeUnavailableError("Window Runtime has been disposed");
      return host.capability(capability);
    },
    optionalCapability<C extends Capability>(capability: C): CapabilityClient<C> | undefined {
      if (disposed) return undefined;
      return host.optionalCapability(capability);
    },
    inspect(): HostInspection { return host.inspect(); },
    subscribe(listener) { listeners.add(listener); listener(current); return () => listeners.delete(listener); },
    dispose(reason = "window runtime disposed") {
      if (disposePromise) return disposePromise;
      disposed = true;
      emit("stopping");
      removeHost();
      disposePromise = host.dispose(reason).then((result) => { emit("disposed"); return result; }, (error) => { emit("failed"); throw error; });
      return disposePromise;
    },
  };
  appHosts.set(app as object, host);
  ownedHosts.add(host as object);
  emit("ready");
  return app;
}

/** 创建当前 Window 的 v4 Runtime；本地插件启动完成后 resolve。 */
export async function createWindowApp(options: CreateWindowAppOptions): Promise<WindowApp> {
  const id = options.id ?? "window-main";
  const instanceId = makeRuntimeInstanceId(id);
  let materialized: ReturnType<typeof materializePluginDefinitions>;
  try { materialized = materializePluginDefinitions(options.plugins, "window-main"); }
  catch (error) { throw new RuntimeInitializationError({ phase: "validate", error: message(error) }); }
  const implementations = createRuntimeUnitImplementationRegistry(materialized.map((item) => ({ pluginId: item.manifest.id, unitId: item.unitId, setup: item.setup, capabilities: item.capabilities })));
  const { id: _id, plugins: _plugins, ...hostOptions } = options;
  const host = createPluginHost({ ...hostOptions, runtime: "window-main", runtimeId: id, runtimeInstanceId: instanceId, runtimeUnitImplementationRegistry: implementations });
  try {
    await host.registerAll(materialized.map((item) => item.manifest));
  } catch (error) {
    await host.dispose("window Runtime initialization failed").catch(() => undefined);
    if (error instanceof StartupPluginError) throw new RuntimeInitializationError({ pluginId: error.details.pluginId, unitId: error.details.unitId, phase: "startup", error: error.details.error ?? error.message });
    throw new RuntimeInitializationError({ phase: "startup", error: message(error) });
  }
  return createAppFromHost(id, instanceId, host);
}

/** advanced：接管一个现有 v4 Host，不复制 Host。 */
export async function createWindowAppFromHost(options: CreateWindowAppFromHostOptions): Promise<WindowApp> {
  const id = options.id ?? options.host.runtimeId;
  if (options.host.runtimeKind !== "window-main") throw new TypeError("createWindowAppFromHost requires a window-main Host");
  return createAppFromHost(id, options.host.runtimeInstanceId, options.host);
}

/** advanced 装配层查询 App 所拥有的 Host。 */
export function hostForWindowApp(app: WindowApp): PluginHost {
  const host = appHosts.get(app as object);
  if (!host) throw new Error("WindowApp is not owned by a WebLoom Host");
  return host;
}
