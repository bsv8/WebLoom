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
  RUNTIME_ERROR_TYPE,
  RUNTIME_HELLO_TYPE,
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
  /** 浏览器 SharedWorker 的错误事件；测试 fake 可省略。 */
  addEventListener?(type: "error", listener: (event: Event) => void): void;
  removeEventListener?(type: "error", listener: (event: Event) => void): void;
}

export type SharedWorkerFactory = (
  url: string | URL,
  options: { type: "module"; name?: string },
) => SharedWorkerLike;

/**
 * 供仍需在同一物理连接上承载产品 RPC 的装配层使用。
 *
 * 普通调用方不需要这个接缝；它们只使用 RuntimeHandle 的状态和
 * serviceBridge。已有大量领域 RPC 的应用迁移时可以先把
 * Runtime 握手与旧 RPC 复用同一 MessagePort，再逐步把领域调用收敛到
 * capability service，而不会偷偷创建第二个 SharedWorker 连接。
 */
export interface SharedWorkerConnectionContext {
  readonly worker: SharedWorkerLike;
  readonly port: MessagePort;
  readonly connectionId: string;
}

export interface ConnectSharedWorkerOptions {
  /** Worker 入口的逻辑 Runtime 标识。 */
  id: string;
  /** module SharedWorker URL；默认直接传给 new SharedWorker。 */
  url: string | URL;
  /** 可选的浏览器 SharedWorker name；不传时由 URL 参与实例隔离。 */
  name?: string;
  /** 断线后是否建立新连接；旧代理仍永久失效。默认为 true。 */
  autoReconnect?: boolean;
  /** 自动重连等待毫秒数。 */
  reconnectDelayMs?: number;
  /** 首个 runtime snapshot 到达前的握手超时；默认 10000ms。 */
  handshakeTimeoutMs?: number;
  /** 测试 fixture 使用；生产默认使用 globalThis.SharedWorker。 */
  workerFactory?: SharedWorkerFactory;
  /**
   * 每次建立实际物理连接时调用一次；自动重连会再次调用。
   * 回调可以在同一端口上安装产品协议，但不得替换 Runtime 的消息
   * 监听器，也不得把旧端口保存为可重用连接。
   */
  onConnection?: (context: SharedWorkerConnectionContext) => void | Promise<void>;
}

function makeConnectionId(runtimeId: string): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return `${runtimeId}:connection:${crypto.randomUUID()}`;
    }
  } catch {
    // connection id is not an authorization secret.
  }
  return `${runtimeId}:connection:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface Deferred<T> {
  promise: Promise<T>;
  settled: boolean;
  resolve(value: T): void;
  reject(error: unknown): void;
}

interface ConnectionResources {
  readonly generation: number;
  readonly worker: SharedWorkerLike;
  readonly port: MessagePort;
  readonly connectionId: string;
  removeMessage?: () => void;
  removeWorkerError?: () => void;
  transport?: RemoteServiceTransport & { dispose(): void };
  handshakeTimer?: ReturnType<typeof setTimeout>;
  cleaned: boolean;
}

function createDeferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const deferred: Deferred<T> = {
    promise: new Promise<T>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    }),
    settled: false,
    resolve(value) {
      if (deferred.settled) return;
      deferred.settled = true;
      resolvePromise(value);
    },
    reject(error) {
      if (deferred.settled) return;
      deferred.settled = true;
      rejectPromise(error);
    },
  };
  return deferred;
}

function post(port: MessagePort, message: unknown): void {
  try { port.postMessage(message); } catch { /* disconnect path converges through state */ }
}

function addMessageListener(port: MessagePort, listener: (event: MessageEvent) => void): () => void {
  // 真实 MessagePort 的 onmessage 与 addEventListener 可以并存；测试宿主
  // 和少数嵌入环境可能把 addEventListener 简化成覆盖 onmessage。检测这
  // 一类实现并保留已有领域 listener，避免 Runtime 握手吞掉产品协议。
  const before = port.onmessage;
  port.addEventListener("message", listener);
  if (port.onmessage === listener && before && before !== listener) {
    port.removeEventListener("message", listener);
    const composed = (event: MessageEvent): void => {
      before.call(port, event);
      listener(event);
    };
    port.addEventListener("message", composed);
    return () => port.removeEventListener("message", composed);
  }
  return () => port.removeEventListener("message", listener);
}

/**
 * 保留标准 MessagePort API；极简测试宿主有时只实现 onmessage。这个适配
 * 只补 listener 注册面，不改变真实浏览器端口或其消息语义。
 */
function ensureMessageEventTarget(port: MessagePort): void {
  const target = port as unknown as {
    onmessage: ((this: MessagePort, event: MessageEvent) => unknown) | null;
    addEventListener?: (this: MessagePort, type: string, listener: (event: MessageEvent) => void) => void;
    removeEventListener?: (this: MessagePort, type: string, listener: (event: MessageEvent) => void) => void;
  };
  const add = target.addEventListener;
  const remove = target.removeEventListener;
  if (add && remove) {
    // Detect a minimal fake whose addEventListener implementation overwrites
    // onmessage. Standard MessagePort leaves the property untouched.
    const before = target.onmessage;
    const probe = (): void => undefined;
    add.call(port, "message", probe);
    const overwritesProperty = target.onmessage === probe;
    remove.call(port, "message", probe);
    if (!overwritesProperty) return;
    const listeners = new Set<(event: MessageEvent) => void>();
    const dispatch = (event: MessageEvent): void => {
      before?.call(port, event);
      for (const listener of [...listeners]) listener(event);
    };
    target.addEventListener = function addMessageListener(type, listener) {
      if (type === "message") listeners.add(listener);
      else add.call(port, type, listener);
    };
    target.removeEventListener = function removeMessageListener(type, listener) {
      if (type === "message") listeners.delete(listener);
      else remove.call(port, type, listener);
    };
    target.onmessage = dispatch;
    return;
  }

  const listeners = new Set<(event: MessageEvent) => void>();
  const original = target.onmessage;
  const dispatch = (event: MessageEvent): void => {
    original?.call(port, event);
    for (const listener of [...listeners]) listener(event);
  };
  target.addEventListener = function addMessageListener(type, listener) {
    if (type === "message") listeners.add(listener);
  };
  target.removeEventListener = function removeMessageListener(type, listener) {
    if (type === "message") listeners.delete(listener);
  };
  target.onmessage = dispatch;
}

function makeWorker(options: ConnectSharedWorkerOptions): SharedWorkerLike {
  const workerOptions = {
    type: "module" as const,
    ...(options.name ? { name: options.name } : {}),
  };
  if (options.workerFactory) return options.workerFactory(options.url, workerOptions);
  const WorkerConstructor = (globalThis as unknown as {
    SharedWorker?: new (url: string | URL, options: { type: "module"; name?: string }) => SharedWorkerLike;
  }).SharedWorker;
  if (!WorkerConstructor) throw new RuntimeUnavailableError("SharedWorker is not supported by this browser");
  return new WorkerConstructor(options.url, workerOptions);
}

/**
 * 从 Window 连接真实 module SharedWorker。
 *
 * Promise 只在首个完整 baseline 快照到达后成功；调用方得到的代理均绑定
 * 当前 connection/runtime/provider/revision，断线或重启不会静默换绑旧代理。
 */
export async function connectSharedWorker(options: ConnectSharedWorkerOptions): Promise<RuntimeHandle> {
  if (!options || typeof options.id !== "string" || options.id.trim() === "") {
    throw new Error("SharedWorker runtime id must be a non-empty string");
  }
  const codec = createRuntimeMessageCodec();
  const listeners = new Set<RuntimeStatusListener>();
  const autoReconnect = options.autoReconnect ?? true;
  const reconnectDelayMs = Math.max(0, options.reconnectDelayMs ?? 25);
  const handshakeTimeoutMs = Math.max(1, options.handshakeTimeoutMs ?? 10_000);
  let disposed = false;
  let currentWorker: SharedWorkerLike | undefined;
  let currentPort: MessagePort | undefined;
  let currentTransport: (RemoteServiceTransport & { dispose(): void }) | undefined;
  let removeMessage: (() => void) | undefined;
  let removeWorkerError: (() => void) | undefined;
  let handshakeTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let connectionGeneration = 0;
  let currentConnection: ConnectionResources | undefined;
  let readyDeferred = createDeferred<void>();
  let initialConnection = true;
  let runtimeInstanceId: string | undefined;
  let connectionId: string | undefined;
  let currentSnapshot: RuntimeStatusSnapshot = {
    runtimeId: options.id,
    runtimeKind: "shared-worker",
    runtimeInstanceId: "",
    state: "connecting",
    snapshotRevision: 0,
    units: [],
    services: [],
  };

  const bridgeTransport: RemoteServiceTransport = {
    call<TRequest, TResult>(request: TRequest, context: RemoteServiceCallContext): Promise<TResult> {
      if (!currentTransport) return Promise.reject(new RuntimeUnavailableError("SharedWorker connection is unavailable"));
      return currentTransport.call<TRequest, TResult>(request, context);
    },
  };
  const bridge = createServiceBridge({ protocolVersion: RUNTIME_PROTOCOL_VERSION, transport: bridgeTransport });

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

  const rejectReady = (error: unknown): void => {
    readyDeferred.reject(error);
    // A rejected readiness is also exposed through RuntimeHandle.ready() after
    // the transition. Mark the promise as observed here so a caller that only
    // subscribes to state does not create an unhandled-rejection noise source.
    void readyDeferred.promise.catch(() => undefined);
  };

  const beginReadinessGeneration = (reason: string): void => {
    rejectReady(new RuntimeUnavailableError(reason));
    readyDeferred = createDeferred<void>();
  };

  const replaceWithRejectedReadiness = (error: unknown): void => {
    rejectReady(error);
    readyDeferred = createDeferred<void>();
    rejectReady(error);
  };

  const scheduleReconnect = (): void => {
    if (disposed || !autoReconnect || reconnectTimer !== undefined) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      void openConnection().catch((error) => {
        if (disposed) return;
        // makeWorker() can fail before a port exists (bad URL/unsupported
        // constructor). Settle this connection generation as well; it must not
        // leave callers waiting on a forever-pending ready() promise.
        if (currentSnapshot.state !== "disconnected") {
          emit({ ...currentSnapshot, state: "disconnected", error: errorMessage(error), units: [], services: [] });
        }
        rejectReady(error);
        beginReadinessGeneration("SharedWorker reconnecting");
        scheduleReconnect();
      });
    }, reconnectDelayMs);
  };

  const cleanupConnection = (connection: ConnectionResources | undefined): void => {
    if (!connection || connection.cleaned) return;
    connection.cleaned = true;
    const timer = connection.handshakeTimer;
    const removeMessageForConnection = connection.removeMessage;
    const removeWorkerErrorForConnection = connection.removeWorkerError;
    const transport = connection.transport;
    if (timer !== undefined) clearTimeout(timer);
    connection.handshakeTimer = undefined;
    removeMessageForConnection?.();
    connection.removeMessage = undefined;
    removeWorkerErrorForConnection?.();
    connection.removeWorkerError = undefined;
    transport?.dispose();
    connection.transport = undefined;
    if (currentConnection === connection) currentConnection = undefined;
    if (currentWorker === connection.worker) currentWorker = undefined;
    if (currentPort === connection.port) currentPort = undefined;
    if (currentTransport === transport) currentTransport = undefined;
    if (removeMessage === removeMessageForConnection) removeMessage = undefined;
    if (removeWorkerError === removeWorkerErrorForConnection) removeWorkerError = undefined;
    if (handshakeTimer === timer) handshakeTimer = undefined;
    try { connection.port.close(); } catch { /* noop */ }
  };

  const disconnect = (reason: string, failure?: unknown, fatal = false): void => {
    if (disposed) return;
    const connection = currentConnection;
    const port = connection?.port ?? currentPort;
    cleanupConnection(connection);
    currentTransport = undefined;
    currentWorker = undefined;
    currentPort = undefined;
    connectionId = undefined;
    bridge.disconnect(reason);
    emit({
      ...currentSnapshot,
      state: fatal ? "failed" : "disconnected",
      error: failure ? errorMessage(failure) : reason,
      runtimeInstanceId: "",
      connectionId: undefined,
      units: [],
      services: [],
    });
    runtimeInstanceId = undefined;
    const unavailable = failure ?? new RuntimeUnavailableError(reason);
    if (!initialConnection && !fatal && autoReconnect) {
      beginReadinessGeneration("SharedWorker reconnecting");
      scheduleReconnect();
    } else {
      // No new baseline can make this generation ready. Replace the current
      // promise as well as rejecting the old one so ready() called after a
      // terminal/non-reconnecting transition remains rejected.
      replaceWithRejectedReadiness(unavailable);
    }
  };

  const onRuntimeError = (message: RuntimeErrorMessage): void => {
    const error = new RuntimeInitializationError({
      pluginId: message.pluginId,
      unitId: message.unitId,
      phase: message.phase === "handshake" ? "handshake" : "startup",
      error: message.message,
    });
    const fatal = message.code === "runtime.protocol_mismatch"
      || message.code === "runtime.initialization_failed";
    disconnect(message.message, error, fatal);
  };

  const onSnapshot = (snapshot: RuntimeSnapshot): void => {
    if (snapshot.runtimeId !== options.id || snapshot.connectionId !== connectionId) return;
    if (snapshot.runtimeKind !== "shared-worker") {
      onRuntimeError({
        type: RUNTIME_ERROR_TYPE,
        protocolVersion: RUNTIME_PROTOCOL_VERSION,
        code: "runtime.protocol_mismatch",
        message: "Connected Runtime is not a SharedWorker Runtime",
        phase: "handshake",
      });
      return;
    }
    const isNewAuthority = runtimeInstanceId !== snapshot.runtimeInstanceId;
    if (isNewAuthority || bridge.state === "disconnected") {
      const result = bridge.handshake({
        connectionId: snapshot.connectionId,
        authorityInstanceId: snapshot.runtimeInstanceId,
        protocolVersion: snapshot.protocolVersion,
      });
      if (!result.accepted) {
        onRuntimeError({
          type: RUNTIME_ERROR_TYPE,
          protocolVersion: RUNTIME_PROTOCOL_VERSION,
          code: "runtime.protocol_mismatch",
          message: "Runtime protocol version mismatch",
          phase: "handshake",
        });
        return;
      }
    }
    runtimeInstanceId = snapshot.runtimeInstanceId;
    const applied = bridge.applySnapshot({
      connectionId: snapshot.connectionId,
      authorityInstanceId: snapshot.runtimeInstanceId,
      snapshotRevision: snapshot.snapshotRevision,
      baseline: snapshot.baseline,
      services: snapshot.services,
    });
    if (!applied.accepted) {
      if (applied.reason === "revision-gap" || applied.reason === "baseline-required") {
        beginReadinessGeneration(`Runtime snapshot ${applied.reason}`);
        emit({
          ...currentSnapshot,
          state: "disconnected",
          error: `Runtime snapshot ${applied.reason}`,
          units: [],
          services: [],
        });
        const port = currentPort;
        if (port && connectionId) post(port, { type: "webloom.runtime.resync", connectionId });
      }
      return;
    }
    emit({
      runtimeId: snapshot.runtimeId,
      runtimeKind: snapshot.runtimeKind,
      runtimeInstanceId: snapshot.runtimeInstanceId,
      state: snapshot.state === "ready" ? "ready" : snapshot.state,
      snapshotRevision: snapshot.snapshotRevision,
      connectionId: snapshot.connectionId,
      units: snapshot.units,
      services: snapshot.services,
    });
    if (snapshot.baseline && snapshot.state === "ready" && bridge.state === "ready") {
      if (handshakeTimer !== undefined) clearTimeout(handshakeTimer);
      handshakeTimer = undefined;
      readyDeferred.resolve(undefined);
      initialConnection = false;
    }
  };

  async function openConnection(): Promise<void> {
    if (disposed) return;
    const generation = ++connectionGeneration;
    if (readyDeferred.settled) readyDeferred = createDeferred<void>();
    let connection: ConnectionResources | undefined;
    try {
      const worker = makeWorker(options);
      const port = worker.port;
      const nextConnectionId = makeConnectionId(options.id);
      connection = {
        generation,
        worker,
        port,
        connectionId: nextConnectionId,
        cleaned: false,
      };
      currentConnection = connection;
      currentWorker = worker;
      currentPort = port;
      connectionId = nextConnectionId;
      emit({
        ...currentSnapshot,
        state: "connecting",
        connectionId: nextConnectionId,
        error: undefined,
      });

      // This callback runs before WebLoom installs its own listeners so an
      // existing product protocol can share the same physical port. A thrown
      // callback is still a failed physical connection: the generation owns
      // the port from this point and must close it before rejecting ready().
      await options.onConnection?.({
        worker,
        port,
        connectionId: nextConnectionId,
      });
      if (disposed || currentConnection !== connection) {
        cleanupConnection(connection);
        return;
      }

      ensureMessageEventTarget(port);
      connection.transport = createMessagePortServiceTransport({ port, codec });
      currentTransport = connection.transport;
      const onWorkerError = (event: Event): void => {
        if (disposed || generation !== connectionGeneration || worker !== currentWorker) return;
        disconnect(`SharedWorker error${event.type ? `: ${event.type}` : ""}`);
      };
      if (worker.addEventListener) {
        worker.addEventListener("error", onWorkerError);
        connection.removeWorkerError = () => worker.removeEventListener?.("error", onWorkerError);
        removeWorkerError = connection.removeWorkerError;
      } else {
        const workerWithOnError = worker as SharedWorkerLike & {
          onerror?: (event: Event) => void;
        };
        const previousOnError = workerWithOnError.onerror;
        const composedOnError = (event: Event): void => {
          previousOnError?.(event);
          onWorkerError(event);
        };
        workerWithOnError.onerror = composedOnError;
        connection.removeWorkerError = () => {
          if (workerWithOnError.onerror === composedOnError) workerWithOnError.onerror = previousOnError;
        };
        removeWorkerError = connection.removeWorkerError;
      }
      const onMessage = (event: MessageEvent): void => {
        if (disposed || generation !== connectionGeneration || port !== currentPort) return;
        if (isRuntimeError(event.data)) {
          onRuntimeError(event.data);
          return;
        }
        if (isSnapshot(event.data)) {
          onSnapshot(event.data);
          return;
        }
        const decoded = codec.decode(event.data);
        if (decoded?.type === codec.type("disconnect")) {
          disconnect(typeof decoded.reason === "string" ? decoded.reason : "SharedWorker disconnected");
        }
      };
      connection.removeMessage = addMessageListener(port, onMessage);
      removeMessage = connection.removeMessage;
      port.start();
      const timer = setTimeout(() => {
        if (disposed || generation !== connectionGeneration || port !== currentPort) return;
        const error = new RuntimeInitializationError({
          phase: "handshake",
          error: `SharedWorker handshake timed out after ${handshakeTimeoutMs}ms`,
        });
        disconnect(error.message, error, false);
      }, handshakeTimeoutMs);
      connection.handshakeTimer = timer;
      handshakeTimer = timer;
      post(port, {
        type: RUNTIME_HELLO_TYPE,
        protocolVersion: RUNTIME_PROTOCOL_VERSION,
        connectionId: nextConnectionId,
        runtimeId: options.id,
      });
      await readyDeferred.promise;
    } catch (error) {
      // disconnect() already owns cleanup and reconnection when the failure
      // came from a live connection (handshake/error/runtime message). For a
      // callback/setup failure, no RuntimeHandle exists yet, so this catch is
      // the last safe owner of the generation's physical port.
      if (connection && !connection.cleaned && currentConnection === connection) {
        disconnect("SharedWorker connection setup failed", error, false);
      } else if (connection && !connection.cleaned) {
        cleanupConnection(connection);
      } else if (!connection && !disposed && initialConnection) {
        replaceWithRejectedReadiness(error);
      }
      throw error;
    }
  }

  function isSnapshot(input: unknown): input is RuntimeSnapshot {
    return isRuntimeSnapshot(input);
  }

  const app: RuntimeHandle = {
    runtimeKind: "shared-worker",
    runtimeId: options.id,
    serviceBridge: bridge,
    get runtimeInstanceId() { return runtimeInstanceId; },
    get connectionId() { return connectionId; },
    state: () => currentSnapshot,
    ready: () => readyDeferred.promise,
    capability<T = unknown>(capabilityId: string, capabilityOptions: { contractVersion?: string } = {}) {
      if (disposed || currentSnapshot.state !== "ready") {
        throw new RuntimeUnavailableError(`Capability "${capabilityId}" is not ready`);
      }
      return bridge.requireProxy({
        capabilityId,
        contractVersion: capabilityOptions.contractVersion ?? `${capabilityId}.v1`,
      }) as ReturnType<typeof bridge.requireProxy> & { readonly serviceType?: T };
    },
    subscribe(listener) {
      listeners.add(listener);
      listener(currentSnapshot);
      return () => listeners.delete(listener);
    },
    dispose(reason = "SharedWorker connection disposed") {
      if (disposed) return Promise.resolve();
      disposed = true;
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      replaceWithRejectedReadiness(new RuntimeUnavailableError(reason));
      const connection = currentConnection;
      const port = connection?.port ?? currentPort;
      if (port) post(port, codec.encode({ type: codec.type("disconnect"), reason }));
      cleanupConnection(connection);
      currentWorker = undefined;
      currentPort = undefined;
      connectionId = undefined;
      runtimeInstanceId = undefined;
      currentTransport?.dispose();
      currentTransport = undefined;
      bridge.disconnect(reason);
      emit({
        ...currentSnapshot,
        state: "disposed",
        runtimeInstanceId: "",
        connectionId: undefined,
        units: [],
        services: [],
      });
      return Promise.resolve();
    },
  };

  try {
    await openConnection();
  } catch (error) {
    if (!disposed) {
      emit({ ...currentSnapshot, state: "failed", error: errorMessage(error) });
    }
    throw error;
  }
  return app;
}
