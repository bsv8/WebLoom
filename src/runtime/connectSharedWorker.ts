import type {
  RemoteServiceCallContext,
  RemoteServiceTransport,
} from "../contracts/lifecycle.js";
import { createServiceBridge } from "../transport/serviceBridge.js";
import { createMessagePortServiceTransport } from "../transport/messagePortServiceTransport.js";
import {
  createRuntimeMessageCodec,
  isRuntimeError,
  isRuntimeSnapshot,
  isRuntimeSnapshotProtocol,
  RUNTIME_PROTOCOL_VERSION,
  type RuntimeErrorMessage,
  type RuntimeSnapshot,
} from "./runtimeProtocol.js";
import {
  RuntimeInitializationError,
  RuntimeUnavailableError,
  type RuntimeHandle,
  type RuntimeStatusListener,
  type RuntimeStatusSnapshot,
} from "./runtimeTypes.js";

export interface SharedWorkerLike {
  readonly port: MessagePort;
  onerror?: (event: Event) => void;
  addEventListener?(type: "error", listener: (event: Event) => void): void;
  removeEventListener?(type: "error", listener: (event: Event) => void): void;
}

export type SharedWorkerFactory = (
  url: string | URL,
  options: { type: "module"; name?: string; credentials?: RequestCredentials },
) => SharedWorkerLike;

/**
 * 临时迁移接缝：下游 typed transfer API 完成前允许领域代码在同一
 * 物理端口安装 listener。它不参与 Runtime 授权，也不传 connectionId。
 */
export interface SharedWorkerConnectionContext {
  readonly worker: SharedWorkerLike;
  readonly port: MessagePort;
}

export interface ConnectSharedWorkerOptions {
  id: string;
  url: string | URL;
  name?: string;
  credentials?: RequestCredentials;
  defaultCallTimeoutMs?: number;
  /** SWCF-009 完成前的临时同端口迁移接缝。 */
  onConnection?: (context: SharedWorkerConnectionContext) => void;
}

interface InternalConnectSharedWorkerOptions extends ConnectSharedWorkerOptions {
  workerFactory?: SharedWorkerFactory;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ensureTimeout(value: number | undefined): number {
  const timeout = value ?? 30_000;
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new TypeError("defaultCallTimeoutMs must be a finite number greater than zero");
  }
  return timeout;
}

function addMessageListener(port: MessagePort, listener: (event: MessageEvent) => void): () => void {
  port.addEventListener("message", listener);
  return () => port.removeEventListener("message", listener);
}

/** 给极简测试端口补齐事件目标；真实 MessagePort 不改变其行为。 */
function ensureMessageEventTarget(port: MessagePort): void {
  const target = port as unknown as {
    onmessage: ((this: MessagePort, event: MessageEvent) => unknown) | null;
    addEventListener?: (this: MessagePort, type: string, listener: (event: MessageEvent) => void) => void;
    removeEventListener?: (this: MessagePort, type: string, listener: (event: MessageEvent) => void) => void;
  };
  if (target.addEventListener && target.removeEventListener) return;
  const listeners = new Set<(event: MessageEvent) => void>();
  const original = target.onmessage;
  target.addEventListener = function add(type, listener) {
    if (type === "message") listeners.add(listener);
  };
  target.removeEventListener = function remove(type, listener) {
    if (type === "message") listeners.delete(listener);
  };
  target.onmessage = (event) => {
    original?.call(port, event);
    for (const listener of [...listeners]) listener(event);
  };
}

function makeWorker(options: InternalConnectSharedWorkerOptions): SharedWorkerLike {
  const workerOptions = {
    type: "module" as const,
    ...(options.name ? { name: options.name } : {}),
    ...(options.credentials ? { credentials: options.credentials } : {}),
  };
  if (options.workerFactory) return options.workerFactory(options.url, workerOptions);
  const WorkerConstructor = (globalThis as unknown as {
    SharedWorker?: new (
      url: string | URL,
      options: { type: "module"; name?: string; credentials?: RequestCredentials },
    ) => SharedWorkerLike;
  }).SharedWorker;
  if (!WorkerConstructor) throw new RuntimeUnavailableError("SharedWorker is not supported by this browser");
  return new WorkerConstructor(options.url, workerOptions);
}

/**
 * 同步创建本地 RuntimeHandle。
 *
 * 该函数只执行参数校验、SharedWorker 构造、监听器/Transport 安装和
 * port.start()；它不等待任何 Worker 回包。远端就绪、协议不兼容和服务
 * 不存在都在 capability().call() 的 Promise 边界收敛。
 */
function connectSharedWorkerInternal(options: InternalConnectSharedWorkerOptions): RuntimeHandle {
  if (!options || typeof options.id !== "string" || options.id.trim() === "") {
    throw new Error("SharedWorker runtime id must be a non-empty string");
  }
  const defaultCallTimeoutMs = ensureTimeout(options.defaultCallTimeoutMs);
  const worker = makeWorker(options);
  const port = worker.port;
  if (!port) throw new RuntimeUnavailableError("SharedWorker did not expose a MessagePort");
  ensureMessageEventTarget(port);

  const listeners = new Set<RuntimeStatusListener>();
  const codec = createRuntimeMessageCodec();
  let disposed = false;
  let runtimeInstanceId: string | undefined;
  let removeRuntimeMessage: (() => void) | undefined;
  let transport: (RemoteServiceTransport & { dispose(): void }) | undefined;
  let restoreWorkerError = (): void => undefined;

  let currentSnapshot: RuntimeStatusSnapshot = {
    runtimeId: options.id,
    runtimeKind: "shared-worker",
    runtimeInstanceId: "",
    state: "starting",
    revision: 0,
    units: [],
    services: [],
  };

  const emit = (next: RuntimeStatusSnapshot): void => {
    currentSnapshot = Object.freeze({
      ...next,
      units: Object.freeze([...next.units]),
      services: Object.freeze([...next.services]),
    });
    for (const listener of [...listeners]) {
      try { listener(currentSnapshot); } catch { /* observer isolation */ }
    }
  };

  const bridgeTransport: RemoteServiceTransport = {
    call<TRequest, TResult>(request: TRequest, context: RemoteServiceCallContext): Promise<TResult> {
      if (!transport) {
        return Promise.reject(new RuntimeUnavailableError("SharedWorker connection is unavailable"));
      }
      return transport.call<TRequest, TResult>(request, context);
    },
  };
  const bridge = createServiceBridge({
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    transport: bridgeTransport,
    defaultCallTimeoutMs,
  });

  const cleanup = (): void => {
    removeRuntimeMessage?.();
    removeRuntimeMessage = undefined;
    port.removeEventListener("messageerror", onWorkerError);
    transport?.dispose();
    transport = undefined;
    try { port.close(); } catch { /* noop */ }
    if (worker.removeEventListener) worker.removeEventListener("error", onWorkerError);
    restoreWorkerError();
    restoreWorkerError = () => undefined;
  };

  const disconnect = (reason: string, failure?: unknown): void => {
    if (disposed) return;
    cleanup();
    bridge.disconnect(reason);
    emit({
      ...currentSnapshot,
      state: "disconnected",
      runtimeInstanceId: "",
      revision: 0,
      units: [],
      services: [],
      error: failure ? errorMessage(failure) : reason,
    });
    runtimeInstanceId = undefined;
  };

  const onRuntimeError = (message: RuntimeErrorMessage): void => {
    const error = new RuntimeInitializationError({
      pluginId: message.pluginId,
      unitId: message.unitId,
      phase: message.phase === "snapshot" ? "snapshot" : "startup",
      error: message.message,
    });
    if (message.code === "protocol_mismatch") bridge.markProtocolMismatch(message.message);
    else if (message.code === "runtime_initialization_failed") bridge.markInitializationFailed(message.message);
    else bridge.disconnect(message.message);
    emit({ ...currentSnapshot, state: "failed", error: error.message, units: [], services: [] });
  };

  const onSnapshot = (snapshot: RuntimeSnapshot): void => {
    if (snapshot.runtimeId !== options.id || snapshot.runtimeKind !== "shared-worker") return;
    if (!isRuntimeSnapshotProtocol(snapshot)) {
      bridge.markProtocolMismatch(`Runtime protocol ${snapshot.protocolVersion} is not supported`);
      emit({
        ...currentSnapshot,
        state: "failed",
        error: `Runtime protocol ${snapshot.protocolVersion} is not supported`,
        units: [],
        services: [],
      });
      return;
    }
    const applied = bridge.applySnapshot(snapshot);
    if (!applied.accepted) return;
    runtimeInstanceId = snapshot.runtimeInstanceId;
    emit({
      runtimeId: snapshot.runtimeId,
      runtimeKind: snapshot.runtimeKind,
      runtimeInstanceId: snapshot.runtimeInstanceId,
      state: snapshot.state === "ready" ? "ready" : snapshot.state,
      revision: snapshot.revision,
      units: snapshot.units,
      services: snapshot.services,
    });
  };

  const onWorkerError = (event: Event): void => {
    const detail = event.type ? `SharedWorker error: ${event.type}` : "SharedWorker error";
    disconnect(detail);
  };

  const onMessage = (event: MessageEvent): void => {
    if (disposed) return;
    if (isRuntimeError(event.data)) {
      onRuntimeError(event.data);
      return;
    }
    if (isRuntimeSnapshot(event.data)) {
      onSnapshot(event.data);
      return;
    }
    // 完全无法解析的对端消息不改变状态；正在等待的 call 由自己的
    // deadline 收敛为 call_timeout，而不是伪造一个握手错误。
    const decoded = codec.decode(event.data);
    if (decoded?.type === codec.type("error")) {
      // Remote service transport owns response matching. Runtime 只处理它的
      // own snapshot/error namespace。
    }
  };

  try {
    // 临时迁移钩子必须先于 Runtime listener 安装，以便复用同一端口。
    options.onConnection?.({ worker, port });
    transport = createMessagePortServiceTransport({
      port,
      codec,
      defaultCallTimeoutMs,
      closeOnDispose: false,
    });
    removeRuntimeMessage = addMessageListener(port, onMessage);
    port.addEventListener("messageerror", onWorkerError);
    if (worker.addEventListener) worker.addEventListener("error", onWorkerError);
    else {
      const previous = worker.onerror;
      const fallbackHandler = (event: Event): void => {
        previous?.(event);
        onWorkerError(event);
      };
      worker.onerror = fallbackHandler;
      restoreWorkerError = () => {
        if (worker.onerror === fallbackHandler) worker.onerror = previous;
      };
    }
    port.start();
  } catch (error) {
    cleanup();
    throw error;
  }

  // 供 Window Runtime 的内部装配使用；不写入 RuntimeHandle 公共接口，
  // 也不暴露原始 MessagePort。
  const handle = {
    runtimeKind: "shared-worker" as const,
    runtimeId: options.id,
    get runtimeInstanceId() { return runtimeInstanceId; },
    serviceBridge: bridge,
    state: () => currentSnapshot,
    capability<T = unknown>(capabilityId: string, capabilityOptions: { contractVersion?: string } = {}) {
      const proxy = bridge.requireProxy({
        capabilityId,
        contractVersion: capabilityOptions.contractVersion ?? `${capabilityId}.v1`,
      });
      return proxy as typeof proxy & { readonly serviceType?: T };
    },
    subscribe(listener: RuntimeStatusListener) {
      listeners.add(listener);
      listener(currentSnapshot);
      return () => listeners.delete(listener);
    },
    dispose(reason = "SharedWorker connection disposed"): Promise<void> {
      if (disposed) return Promise.resolve();
      // 先同步撤销代理并拒绝 transport pending，再做端口清理。
      disposed = true;
      emit({ ...currentSnapshot, state: "stopping" });
      bridge.dispose(reason);
      cleanup();
      runtimeInstanceId = undefined;
      emit({
        ...currentSnapshot,
        state: "disposed",
        runtimeInstanceId: "",
        revision: 0,
        units: [],
        services: [],
      });
      return Promise.resolve();
    },
  };
  return handle as RuntimeHandle;
}

/** 创建生产 RuntimeHandle；测试工厂不属于生产公共选项。 */
export function connectSharedWorker(options: ConnectSharedWorkerOptions): RuntimeHandle {
  return connectSharedWorkerInternal(options);
}

/** 仅由 `webloom-framework/testing` 暴露的 SharedWorker 工厂注入入口。 */
export function connectSharedWorkerForTesting(
  options: ConnectSharedWorkerOptions,
  workerFactory: SharedWorkerFactory,
): RuntimeHandle {
  return connectSharedWorkerInternal({ ...options, workerFactory });
}
