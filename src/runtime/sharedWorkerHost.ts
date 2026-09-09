import type {
  LifecycleDisposeResult,
  RemoteServiceReference,
  RemoteServiceSnapshot,
} from "../contracts/lifecycle.js";
import type { PluginManifest } from "../contracts/plugin.js";
import {
  createPluginHost,
  type CreatePluginHostOptions,
  type PluginHost,
} from "../host/createPluginHost.js";
import { StartupPluginError } from "../host/createPluginHost.js";
import { createRuntimeUnitImplementationRegistry } from "../host/runtimeUnitImplementationRegistry.js";
import { createMessagePortServiceProvider, type MessagePortServiceProvider } from "../transport/messagePortServiceProvider.js";
import type { RemoteServicePortCallMessage } from "../transport/messagePortServiceTransport.js";
import type { RuntimePluginDefinition } from "./pluginDefinitions.js";
import { materializePluginDefinitions } from "./pluginDefinitions.js";
import {
  createRuntimeMessageCodec,
  isRuntimeHello,
  isRuntimeResync,
  RUNTIME_ERROR_TYPE,
  RUNTIME_PROTOCOL_VERSION,
  RUNTIME_SNAPSHOT_TYPE,
  type RuntimeErrorMessage,
  type RuntimeHelloMessage,
  type RuntimeSnapshot,
  type RuntimeSnapshotUnit,
} from "./runtimeProtocol.js";
import {
  RuntimeInitializationError,
  type RuntimeStatusListener,
  type RuntimeStatusSnapshot,
  type RuntimeAppState,
} from "./runtimeTypes.js";

export interface SharedWorkerScopeLike {
  onconnect: ((event: { ports: MessagePort[] }) => void) | null;
}

export interface StartSharedWorkerAppOptions extends Omit<CreatePluginHostOptions, "runtime" | "runtimeUnitImplementationRegistry"> {
  /** SharedWorker 的逻辑稳定标识。 */
  id: string;
  /** 只在 SharedWorker realm 执行的插件定义。 */
  plugins: readonly RuntimePluginDefinition[];
  /** 测试 fixture 可注入结构等价的 SharedWorkerGlobalScope。 */
  globalScope?: SharedWorkerScopeLike;
  /**
   * 复用已有领域 Worker 入口的 onconnect 装配。回调只负责安装领域协议
   * listener；WebLoom 仍在同一端口上安装自己的 Runtime listener，不会创建
   * 第二个 Worker 或第二条物理连接。
   */
  onPortConnect?: (event: { ports: MessagePort[] }) => void;
}

export interface SharedWorkerApp {
  readonly runtimeKind: "shared-worker";
  readonly runtimeId: string;
  readonly runtimeInstanceId: string;
  ready(): Promise<void>;
  /** 重新按当前外部身份/意图对账运行单元；不会创建第二个 Worker。 */
  reconcile(): Promise<void>;
  state(): RuntimeStatusSnapshot;
  subscribe(listener: RuntimeStatusListener): () => void;
  dispose(reason?: string): Promise<LifecycleDisposeResult>;
}

interface WorkerEndpoint {
  port: MessagePort;
  connectionId: string;
  provider: MessagePortServiceProvider;
  removeMessage: () => void;
  closed: boolean;
}

function makeRuntimeInstanceId(runtimeId: string): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return `${runtimeId}:${crypto.randomUUID()}`;
    }
  } catch {
    // 仅用于 Runtime 身份去重。
  }
  return `${runtimeId}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
}

function makeConnectionId(): never {
  // connectionId 必须由 Window 端生成并在 hello 中回显，Worker 不能根据
  // port 对象或 Window 名称猜测它。该函数用于类型上阻止 Worker 生成连接。
  throw new Error("SharedWorker connectionId must be supplied by the Window handshake");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function startupDetails(error: unknown): { pluginId?: string; unitId?: string; message: string } {
  if (error instanceof StartupPluginError) {
    return {
      pluginId: error.details.pluginId,
      unitId: error.details.unitId,
      message: error.details.error ?? error.message,
    };
  }
  if (error instanceof RuntimeInitializationError) {
    return {
      pluginId: error.details.pluginId,
      unitId: error.details.unitId,
      message: error.message,
    };
  }
  return { message: errorMessage(error) };
}

function addPortListener(port: MessagePort, listener: (event: MessageEvent) => void): () => void {
  // 浏览器 MessagePort 同时支持 onmessage 和 addEventListener；测试宿主和
  // 少数嵌入环境则可能只实现 onmessage，或把 addEventListener 简化成覆盖
  // onmessage。Worker 的领域协议 listener 已经由 onPortConnect 安装在同一
  // 端口上，因此这里必须保留它，不能让 Runtime 握手吞掉领域消息。
  const target = port as unknown as {
    onmessage: ((this: MessagePort, event: MessageEvent) => unknown) | null;
    addEventListener?: (this: MessagePort, type: string, listener: (event: MessageEvent) => void) => void;
    removeEventListener?: (this: MessagePort, type: string, listener: (event: MessageEvent) => void) => void;
  };
  const add = target.addEventListener;
  const remove = target.removeEventListener;
  if (add && remove) {
    const before = target.onmessage;
    const probe = (): void => undefined;
    add.call(port, "message", probe);
    const overwritesProperty = target.onmessage === probe;
    remove.call(port, "message", probe);
    if (!overwritesProperty) {
      add.call(port, "message", listener);
      return () => remove.call(port, "message", listener);
    }

    const listeners = new Set<(event: MessageEvent) => void>();
    const dispatch = (event: MessageEvent): void => {
      before?.call(port, event);
      for (const current of [...listeners]) current(event);
    };
    target.addEventListener = function addMessageListener(type, current) {
      if (type === "message") listeners.add(current);
      else add.call(port, type, current);
    };
    target.removeEventListener = function removeMessageListener(type, current) {
      if (type === "message") listeners.delete(current);
      else remove.call(port, type, current);
    };
    target.onmessage = dispatch;
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  const listeners = new Set<(event: MessageEvent) => void>();
  const before = target.onmessage;
  const dispatch = (event: MessageEvent): void => {
    before?.call(port, event);
    for (const current of [...listeners]) current(event);
  };
  target.addEventListener = function addMessageListener(type, current) {
    if (type === "message") listeners.add(current);
  };
  target.removeEventListener = function removeMessageListener(type, current) {
    if (type === "message") listeners.delete(current);
  };
  target.onmessage = dispatch;
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function post(port: MessagePort, message: unknown): void {
  try { port.postMessage(message); } catch { /* 端口已断开时由连接状态收敛。 */ }
}

/** 在当前 SharedWorkerGlobalScope 中安装唯一的 Worker Runtime。 */
export function startSharedWorkerApp(options: StartSharedWorkerAppOptions): SharedWorkerApp {
  if (!options || typeof options.id !== "string" || options.id.trim() === "") {
    throw new Error("SharedWorker runtime id must be a non-empty string");
  }
  const workerScope = options.globalScope
    ?? ("onconnect" in globalThis
      ? globalThis as unknown as SharedWorkerScopeLike
      : undefined);
  if (!workerScope) {
    throw new RuntimeInitializationError({
      phase: "validate",
      error: "startSharedWorkerApp must run in a SharedWorkerGlobalScope",
    });
  }

  const runtimeId = options.id;
  const runtimeInstanceId = makeRuntimeInstanceId(runtimeId);
  const listeners = new Set<RuntimeStatusListener>();
  const endpoints = new Set<WorkerEndpoint>();
  const codec = createRuntimeMessageCodec();
  let runtimeState: Exclude<RuntimeAppState, "connecting" | "disconnected"> = "starting";
  let revision = 0;
  let host: PluginHost | undefined;
  let manifests: readonly PluginManifest[] = [];
  let disposed = false;
  let disposePromise: Promise<LifecycleDisposeResult> | undefined;

  const emit = (): void => {
    const snapshot = currentSnapshot();
    for (const listener of [...listeners]) {
      try { listener(snapshot); } catch { /* observer isolation */ }
    }
  };

  const currentSnapshot = (): RuntimeStatusSnapshot => Object.freeze({
    runtimeId,
    runtimeKind: "shared-worker",
    runtimeInstanceId,
    state: runtimeState,
    snapshotRevision: revision,
    units: Object.freeze(host && runtimeState !== "failed"
      ? manifests.flatMap((manifest) => {
          const state = host?.state(manifest.id);
          return (state?.units ?? []).map((unit) => ({
            pluginId: unit.pluginId,
            unitId: unit.unitId,
            runtime: unit.runtime,
            ...(unit.instanceId !== undefined ? { instanceId: unit.instanceId } : {}),
            state: unit.kind,
          } satisfies RuntimeSnapshotUnit));
        })
      : []),
    services: Object.freeze(host && runtimeState !== "failed" ? serviceReferences("", revision) : []),
  });

  const serviceReferences = (connectionId: string, snapshotRevision: number): RemoteServiceReference[] => {
    if (!host || runtimeState === "failed" || runtimeState === "disposed") return [];
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
          snapshotRevision,
          // The same service object is never valid through another port.
          ...(connectionId ? { connectionId } : {}),
        });
      }
    }
    return services;
  };

  const runtimeSnapshotFor = (
    endpoint: Pick<WorkerEndpoint, "connectionId">,
    baseline: boolean,
  ): RuntimeSnapshot => ({
    type: RUNTIME_SNAPSHOT_TYPE,
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    runtimeId,
    runtimeKind: "shared-worker",
    runtimeInstanceId,
    connectionId: endpoint.connectionId,
    snapshotRevision: revision,
    baseline,
    state: runtimeState,
    units: currentSnapshot().units,
    services: serviceReferences(endpoint.connectionId, revision),
  });

  const serviceSnapshotFor = (
    endpoint: Pick<WorkerEndpoint, "connectionId">,
    baseline: boolean,
  ): RemoteServiceSnapshot => ({
    connectionId: endpoint.connectionId,
    authorityInstanceId: runtimeInstanceId,
    snapshotRevision: revision,
    baseline,
    services: serviceReferences(endpoint.connectionId, revision),
  });

  const publishEndpoint = (endpoint: WorkerEndpoint, baseline: boolean): void => {
    if (endpoint.closed || disposed) return;
    const serviceSnapshot = serviceSnapshotFor(endpoint, baseline);
    endpoint.provider.publishSnapshot(serviceSnapshot);
    post(endpoint.port, codec.encode(runtimeSnapshotFor(endpoint, baseline) as unknown as Record<string, unknown>));
  };

  const publishAll = (baseline = false): void => {
    for (const endpoint of [...endpoints]) publishEndpoint(endpoint, baseline);
  };

  const closeEndpoint = (endpoint: WorkerEndpoint, reason: string): void => {
    if (endpoint.closed) return;
    endpoint.closed = true;
    endpoints.delete(endpoint);
    endpoint.removeMessage();
    endpoint.provider.disconnect(reason);
  };

  const sendError = (
    port: MessagePort,
    code: RuntimeErrorMessage["code"],
    message: string,
    details: { pluginId?: string; unitId?: string; phase?: string } = {},
  ): void => {
    const error: RuntimeErrorMessage = {
      type: RUNTIME_ERROR_TYPE,
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      code,
      message,
      ...(details.pluginId !== undefined ? { pluginId: details.pluginId } : {}),
      ...(details.unitId !== undefined ? { unitId: details.unitId } : {}),
      ...(details.phase !== undefined ? { phase: details.phase } : {}),
    };
    post(port, error);
  };

  const handleCall = async (
    connectionId: string,
    input: { message: RemoteServicePortCallMessage; signal: AbortSignal },
  ): Promise<unknown> => {
    if (!host || runtimeState !== "ready") throw new Error("SharedWorker Runtime is not ready");
    const message = input.message;
    if (message.connectionId !== connectionId) throw new Error("Runtime connection mismatch");
    const reference = message.reference;
    if (message.providerInstanceId !== reference.providerInstanceId
      || reference.authorityInstanceId !== runtimeInstanceId
      || reference.connectionId !== connectionId
      || reference.runtime !== "shared-worker"
      || reference.status !== "ready"
      || reference.snapshotRevision !== revision
      || reference.handoverGeneration !== 0) {
      throw new Error("Runtime service reference is stale");
    }
    const manifest = manifests.find((candidate) => {
      const state = host?.state(candidate.id);
      return state?.instanceId === reference.providerInstanceId;
    });
    if (!manifest) throw new Error("Runtime service provider is no longer active");
    const state = host.state(manifest.id);
    if (state.kind !== "enabled" || state.instanceId !== reference.providerInstanceId) {
      throw new Error("Runtime service provider is no longer active");
    }
    const unit = manifest.units?.find((candidate) => candidate.id === state.unitId);
    if (!unit || unit.runtime !== "shared-worker" || !unit.provides?.includes(reference.capabilityId)) {
      throw new Error("Runtime capability is not declared");
    }
    const expectedScopeId = host.scope(manifest.id)?.identity.scopeId ?? `scope:${state.instanceId}`;
    if (reference.scopeId !== expectedScopeId) throw new Error("Runtime service scope is stale");
    const expectedVersion = unit.providedContracts?.[reference.capabilityId] ?? `${reference.capabilityId}.v1`;
    if (expectedVersion !== reference.contractVersion) throw new Error("Runtime capability contract mismatch");
    const value = host.capabilities.get<unknown>(reference.capabilityId);
    if (input.signal.aborted) throw input.signal.reason ?? new Error("Runtime service request cancelled");
    const request = message.request as unknown;
    if (typeof value === "function") return await (value as (request: unknown, signal: AbortSignal) => unknown)(request, input.signal);
    if (value && typeof value === "object") {
      const object = value as Record<string, unknown>;
      if (typeof object.handle === "function") return await (object.handle as (request: unknown, signal: AbortSignal) => unknown)(request, input.signal);
      if (request && typeof request === "object" && typeof (request as { method?: unknown }).method === "string") {
        const method = (request as { method: string }).method;
        const methodValue = object[method];
        if (typeof methodValue === "function") {
          const args = (request as { args?: unknown[] }).args;
          return await (methodValue as (...args: unknown[]) => unknown)(...(Array.isArray(args) ? args : []));
        }
      }
    }
    throw new Error(`Runtime capability "${reference.capabilityId}" does not expose an RPC handler`);
  };

  const attachPort = (port: MessagePort): void => {
    let endpoint: WorkerEndpoint | undefined;
    let helloSeen = false;
    let removeMessage: () => void = () => undefined;
    const onMessage = (event: MessageEvent): void => {
      if (endpoint?.closed) return;
      const decoded = codec.decode(event.data);
      if (!helloSeen) {
        if (!isRuntimeHello(event.data)) return;
        const hello = event.data as RuntimeHelloMessage;
        helloSeen = true;
        if (hello.protocolVersion !== RUNTIME_PROTOCOL_VERSION) {
          sendError(port, "runtime.protocol_mismatch", "Runtime protocol version mismatch", { phase: "handshake" });
          try { port.close(); } catch { /* noop */ }
          return;
        }
        if (hello.runtimeId !== runtimeId) {
          sendError(port, "runtime.invalid_connection", "Runtime id mismatch", { phase: "handshake" });
          try { port.close(); } catch { /* noop */ }
          return;
        }
        if (runtimeState === "failed") {
          const detail = startupDetails(startupError);
          sendError(port, "runtime.initialization_failed", detail.message, {
            pluginId: detail.pluginId,
            unitId: detail.unitId,
            phase: "startup",
          });
          try { port.close(); } catch { /* noop */ }
          return;
        }
        if (runtimeState === "stopping" || runtimeState === "disposed") {
          sendError(port, "runtime.invalid_connection", "SharedWorker Runtime is no longer accepting connections", { phase: "handshake" });
          try { port.close(); } catch { /* noop */ }
          return;
        }
        if (endpointsHasConnection(hello.connectionId)) {
          sendError(port, "runtime.invalid_connection", "Connection id is already active", { phase: "handshake" });
          try { port.close(); } catch { /* noop */ }
          return;
        }
        const candidate = { port, connectionId: hello.connectionId } as WorkerEndpoint;
        const provider = createMessagePortServiceProvider({
          port,
          codec,
          handshake: {
            connectionId: hello.connectionId,
            authorityInstanceId: runtimeInstanceId,
            protocolVersion: RUNTIME_PROTOCOL_VERSION,
          },
          snapshot: serviceSnapshotFor(candidate, true),
          handleCall: (input) => handleCall(hello.connectionId, input),
        });
        endpoint = { ...candidate, provider, removeMessage, closed: false };
        endpoints.add(endpoint);
        if (runtimeState === "ready") publishEndpoint(endpoint, true);
        return;
      }
      if (!endpoint) return;
      if (isRuntimeResync(event.data)) {
        if (event.data.connectionId === endpoint.connectionId) publishEndpoint(endpoint, true);
        return;
      }
      if (decoded?.type === codec.type("disconnect")) {
        closeEndpoint(endpoint, typeof decoded.reason === "string" ? decoded.reason : "Window disconnected");
      }
    };
    removeMessage = addPortListener(port, onMessage);
    port.start();
  };

  const endpointsHasConnection = (connectionId: string): boolean => (
    [...endpoints].some((endpoint) => endpoint.connectionId === connectionId)
  );
  let startupError: unknown;

  // Install onconnect before asynchronous plugin startup so the browser never
  // loses an initial port. Ports remain pending until the Host is ready.
  workerScope.onconnect = (event) => {
    try {
      options.onPortConnect?.(event);
    } catch (error) {
      // The existing product protocol is allowed to install listeners before
      // WebLoom attaches its own Runtime listener. If that migration hook
      // fails, none of the event's ports may remain in an unowned pending
      // state: notify every Window with the same structured initialization
      // error, then close every physical port without calling attachPort().
      const detail = startupDetails(error);
      for (const port of event.ports ?? []) {
        sendError(port, "runtime.initialization_failed", detail.message, {
          pluginId: detail.pluginId,
          unitId: detail.unitId,
          phase: "handshake",
        });
      }
      for (const port of event.ports ?? []) {
        try { port.close(); } catch { /* noop */ }
      }
      return;
    }
    for (const port of event.ports ?? []) attachPort(port);
  };

  let materialized: ReturnType<typeof materializePluginDefinitions> = [];
  let readyPromise: Promise<void>;
  try {
    materialized = materializePluginDefinitions(options.plugins, "shared-worker");
    manifests = materialized.map((item) => item.manifest);
    const implementations = createRuntimeUnitImplementationRegistry(
      materialized.map((item) => ({
        pluginId: item.manifest.id,
        unitId: item.unitId,
        setup: item.setup,
      })),
    );
    const { id: _id, plugins: _plugins, globalScope: _scope, onPortConnect: _onPortConnect, ...hostOptions } = options;
    host = createPluginHost({
      ...hostOptions,
      runtime: "shared-worker",
      rootAttributes: {
        ...(hostOptions.rootAttributes ?? {}),
        runtimeId,
        runtimeInstanceId,
      },
      runtimeUnitImplementationRegistry: implementations,
    });
    host.subscribe(() => {
      if (runtimeState !== "ready" || disposed) return;
      revision += 1;
      publishAll(false);
      emit();
    });
    readyPromise = host.registerAll(manifests).then(() => {
      if (disposed) return;
      const runtimeHost = host;
      if (!runtimeHost) throw new Error("SharedWorker Plugin Host is unavailable");
      const failedRequired = manifests.find((manifest) => {
        const required = manifest.meta.startup === "required" || manifest.meta.canDisable === false;
        return required && runtimeHost.state(manifest.id).kind !== "enabled";
      });
      if (failedRequired) {
        const state = runtimeHost.state(failedRequired.id);
        throw new StartupPluginError({
          pluginId: failedRequired.id,
          unitId: state.unitId ?? failedRequired.units?.[0]?.id ?? failedRequired.id,
          capabilities: [],
          state: state.kind,
          error: state.error ?? `Required plugin is ${state.kind}${state.blockedBy ? `: ${state.blockedBy.join(", ")}` : ""}`,
        });
      }
      runtimeState = "ready";
      revision = Math.max(1, revision + 1);
      publishAll(true);
      emit();
    }).catch((error) => {
      startupError = error;
      runtimeState = "failed";
      emit();
      const detail = startupDetails(error);
      for (const endpoint of [...endpoints]) {
        sendError(endpoint.port, "runtime.initialization_failed", detail.message, {
          pluginId: detail.pluginId,
          unitId: detail.unitId,
          phase: "startup",
        });
        closeEndpoint(endpoint, "Runtime initialization failed");
      }
      throw new RuntimeInitializationError({
        pluginId: detail.pluginId,
        unitId: detail.unitId,
        phase: "startup",
        error: detail.message,
      });
    });
  } catch (error) {
    startupError = error;
    runtimeState = "failed";
    emit();
    readyPromise = Promise.reject(error instanceof RuntimeInitializationError
      ? error
      : new RuntimeInitializationError({ phase: "validate", error: errorMessage(error) }));
  }

  const app: SharedWorkerApp = {
    runtimeKind: "shared-worker",
    runtimeId,
    runtimeInstanceId,
    ready: () => readyPromise,
    async reconcile() {
      if (!host) {
        await readyPromise;
        return;
      }
      if (runtimeState === "failed" || runtimeState === "disposed" || disposed) {
        await readyPromise;
        return;
      }
      await host.reconcile();
    },
    state: currentSnapshot,
    subscribe(listener) {
      listeners.add(listener);
      listener(currentSnapshot());
      return () => listeners.delete(listener);
    },
    dispose(reason = "shared worker runtime disposed") {
      if (disposePromise) return disposePromise;
      disposed = true;
      runtimeState = "stopping";
      emit();
      disposePromise = (async () => {
        for (const endpoint of [...endpoints]) closeEndpoint(endpoint, reason);
        const result = host
          ? await host.dispose(reason)
          : { scopeId: `runtime:${runtimeInstanceId}`, state: "stopped" as const, attempted: 0, released: 0, pending: [], errors: [], cleanupIncomplete: false };
        runtimeState = "disposed";
        emit();
        return result;
      })();
      return disposePromise;
    },
  };
  return app;
}
