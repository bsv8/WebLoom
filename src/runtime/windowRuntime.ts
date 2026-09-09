import type {
  LifecycleDisposeResult,
  RemoteServiceReference,
} from "../contracts/lifecycle.js";
import type { PluginManifest } from "../contracts/plugin.js";
import {
  createPluginHost,
  type CreatePluginHostOptions,
  type PluginHost,
} from "../host/createPluginHost.js";
import { createRuntimeUnitImplementationRegistry } from "../host/runtimeUnitImplementationRegistry.js";
import { StartupPluginError } from "../host/createPluginHost.js";
import type { RuntimePluginDefinition } from "./pluginDefinitions.js";
import { materializePluginDefinitions } from "./pluginDefinitions.js";
import { unitSnapshotFromState } from "./runtimeProtocol.js";
import {
  RuntimeInitializationError,
  RuntimeUnavailableError,
  type RuntimeStatusListener,
  type RuntimeStatusSnapshot,
  type RuntimeHandle,
  type WindowApp,
} from "./runtimeTypes.js";

export interface CreateWindowAppOptions extends Omit<CreatePluginHostOptions, "runtime" | "runtimeUnitImplementationRegistry"> {
  /** 逻辑 Runtime 标识；同一页面通常只创建一个 App。 */
  id?: string;
  /** 当前 Window 的插件定义；setup 只在当前 Window realm 执行。 */
  plugins: readonly RuntimePluginDefinition[];
  /**
   * 供领域适配层接管分阶段注册时复用已经创建的 Window Host。
   * 普通插件应省略该字段；传入后由调用方负责后续 register，App 仍负责
   * Window Runtime 快照、远端投影和最终 dispose。
   */
  host?: PluginHost;
  /** 可选的 SharedWorker Runtime；Window 单元只投影其状态，不创建 Worker 假实例。 */
  remoteRuntime?: RuntimeHandle;
}

function makeRuntimeInstanceId(runtimeId: string): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return `${runtimeId}:${crypto.randomUUID()}`;
    }
  } catch {
    // 仅用于实例身份，不承担授权或密钥语义。
  }
  return `${runtimeId}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isStartupPluginError(error: unknown): error is StartupPluginError {
  return error instanceof StartupPluginError
    && typeof error.details?.pluginId === "string";
}

function buildLocalServices(
  host: PluginHost,
  manifests: readonly PluginManifest[],
  runtimeInstanceId: string,
  revision: number,
): readonly RemoteServiceReference[] {
  const services: RemoteServiceReference[] = [];
  for (const manifest of manifests) {
    const state = host.state(manifest.id);
    const unit = manifest.units?.find((candidate) => candidate.id === state.unitId)
      ?? manifest.units?.[0];
    if (!unit || unit.runtime === undefined || !state.instanceId || state.kind !== "enabled") continue;
    const scopeId = host.scope(manifest.id)?.identity.scopeId ?? `scope:${state.instanceId}`;
    for (const capability of unit.provides ?? []) {
      services.push({
        capabilityId: capability,
        providerInstanceId: state.instanceId,
        runtime: unit.runtime,
        contractVersion: unit.providedContracts?.[capability] ?? `${capability}.v1`,
        authorityInstanceId: runtimeInstanceId,
        scopeId,
        handoverGeneration: 0,
        attributes: Object.freeze({}),
        status: "ready",
        snapshotRevision: revision,
      });
    }
  }
  return services;
}

/** 创建当前 Window 的唯一 window-main Runtime。 */
export async function createWindowApp(options: CreateWindowAppOptions): Promise<WindowApp> {
  const runtimeId = options.id ?? "window-main";
  const remoteRuntime = options.remoteRuntime;
  const runtimeInstanceId = makeRuntimeInstanceId(runtimeId);
  let currentState: RuntimeStatusSnapshot = {
    runtimeId,
    runtimeKind: "window-main",
    runtimeInstanceId,
    state: "starting",
    snapshotRevision: 0,
    units: [],
    services: [],
  };
  const listeners = new Set<RuntimeStatusListener>();
  let disposed = false;
  let disposePromise: Promise<LifecycleDisposeResult> | undefined;

  const emit = (next: RuntimeStatusSnapshot): void => {
    currentState = Object.freeze({
      ...next,
      units: Object.freeze([...next.units]),
      services: Object.freeze([...next.services]),
    });
    for (const listener of [...listeners]) {
      try { listener(currentState); } catch { /* 观察者不能改变 Runtime 状态。 */ }
    }
  };

  let materialized: ReturnType<typeof materializePluginDefinitions>;
  try {
    materialized = materializePluginDefinitions(options.plugins, "window-main");
  } catch (error) {
    throw new RuntimeInitializationError({ phase: "validate", error: errorMessage(error) });
  }
  const manifests = materialized.map((item) => item.manifest);
  let implementations: ReturnType<typeof createRuntimeUnitImplementationRegistry>;
  try {
    const duplicate = manifests.find((manifest, index) => (
      manifests.findIndex((candidate) => candidate.id === manifest.id) !== index
    ));
    if (duplicate) throw new Error(`Plugin "${duplicate.id}" is declared more than once`);
    implementations = createRuntimeUnitImplementationRegistry(
      materialized.map((item) => ({
        pluginId: item.manifest.id,
        unitId: item.unitId,
        setup: item.setup,
      })),
    );
  } catch (error) {
    throw new RuntimeInitializationError({ phase: "validate", error: errorMessage(error) });
  }

  let host: PluginHost;
  const suppliedHost = options.host;
  try {
    const {
      id: _id,
      plugins: _plugins,
      host: _host,
      remoteRuntime: _remoteRuntime,
      ...hostOptions
    } = options;
    const suppliedBridgeFactory = hostOptions.serviceBridgeForPlugin;
    host = suppliedHost ?? createPluginHost({
        ...hostOptions,
        runtime: "window-main",
        externalRuntimeDependencies: remoteRuntime !== undefined || hostOptions.externalRuntimeDependencies,
        remoteServiceReferences: () => remoteRuntime?.state().services ?? hostOptions.remoteServiceReferences?.() ?? [],
        runtimeSnapshots: () => remoteRuntime
          ? remoteRuntime.state().units.map((unit) => ({
              pluginId: unit.pluginId,
              unitId: unit.unitId,
              runtime: unit.runtime,
              ...(unit.instanceId !== undefined ? { instanceId: unit.instanceId } : {}),
              state: unit.state,
            }))
          : hostOptions.runtimeSnapshots?.() ?? [],
        serviceBridgeForPlugin: (pluginId, instanceId) => (
          suppliedBridgeFactory?.(pluginId, instanceId) ?? remoteRuntime?.serviceBridge
        ),
        rootAttributes: {
          ...(hostOptions.rootAttributes ?? {}),
          runtimeId,
          runtimeInstanceId,
        },
        runtimeUnitImplementationRegistry: implementations,
      });
  } catch (error) {
    throw new RuntimeInitializationError({ phase: "validate", error: errorMessage(error) });
  }

  let removeRemoteSubscription: (() => void) | undefined;

  const manifestsForSnapshot = (): readonly PluginManifest[] => {
    if (!suppliedHost) return manifests;
    return suppliedHost.manifests()
      .map((pluginId) => suppliedHost.getManifest(pluginId))
      .filter((manifest): manifest is PluginManifest => manifest !== undefined);
  };

  const refresh = (): void => {
    const snapshotManifests = manifestsForSnapshot();
    const units = snapshotManifests.flatMap((manifest) => {
      const state = host.state(manifest.id);
      return (state.units ?? []).map((unit) => unitSnapshotFromState(
        unit,
        unit.runtime,
      ));
    });
    const revision = Math.max(currentState.snapshotRevision + 1, host.version());
    emit({
      ...currentState,
      snapshotRevision: revision,
      units,
      services: [
        ...buildLocalServices(host, snapshotManifests, runtimeInstanceId, revision),
        ...(remoteRuntime?.state().services ?? []),
      ],
    });
  };
  const removeHostSubscription = host.subscribe(refresh);

  try {
    if (!suppliedHost) await host.registerAll(manifests);
    const failedRequired = suppliedHost ? undefined : manifests.find((manifest) => {
      const required = manifest.meta.startup === "required" || manifest.meta.canDisable === false;
      return required && host.state(manifest.id).kind !== "enabled";
    });
    if (failedRequired) {
      const state = host.state(failedRequired.id);
      throw new StartupPluginError({
        pluginId: failedRequired.id,
        unitId: state.unitId ?? failedRequired.units?.[0]?.id ?? failedRequired.id,
        capabilities: [],
        state: state.kind,
        error: state.error ?? `Required plugin is ${state.kind}${state.blockedBy ? `: ${state.blockedBy.join(", ")}` : ""}`,
      });
    }
  } catch (error) {
    refresh();
    const pluginId = isStartupPluginError(error) ? error.details.pluginId : undefined;
    const manifest = pluginId ? manifests.find((candidate) => candidate.id === pluginId) : undefined;
    const required = manifest?.meta.startup === "required" || manifest?.meta.canDisable === false;
    if (required || !isStartupPluginError(error)) {
      removeHostSubscription();
      removeRemoteSubscription?.();
      await host.dispose("window runtime initialization failed").catch(() => undefined);
      if (error instanceof RuntimeInitializationError) throw error;
      throw new RuntimeInitializationError({
        pluginId,
        unitId: isStartupPluginError(error) ? error.details.unitId : manifest?.units?.[0]?.id,
        phase: "startup",
        error: errorMessage(error),
      });
    }
    // 非 required 插件的失败保留在 Host 快照中；App 本身仍可观察并继续运行。
  }
  refresh();
  emit({ ...currentState, state: "ready" });
  removeRemoteSubscription = remoteRuntime?.subscribe(() => {
    host.refreshRuntimeUnitSnapshots();
    void host.reconcile().catch(() => undefined);
  });

  const app: WindowApp = {
    runtimeKind: "window-main",
    runtimeId,
    runtimeInstanceId,
    host,
    state: () => currentState,
    capability<T>(capabilityId: string): T {
      if (disposed || currentState.state === "disposed" || currentState.state === "stopping") {
        throw new RuntimeUnavailableError("Window Runtime has been disposed");
      }
      return host.capabilities.get<T>(capabilityId);
    },
    subscribe(listener) {
      listeners.add(listener);
      listener(currentState);
      return () => listeners.delete(listener);
    },
    dispose(reason = "window runtime disposed") {
      if (disposePromise) return disposePromise;
      disposed = true;
      emit({ ...currentState, state: "stopping" });
      removeHostSubscription();
      removeRemoteSubscription?.();
      disposePromise = host.dispose(reason).then((result) => {
        emit({ ...currentState, state: "disposed" });
        return result;
      }, (error) => {
        emit({ ...currentState, state: "failed", error: errorMessage(error) });
        throw error;
      });
      return disposePromise;
    },
  };
  return app;
}
