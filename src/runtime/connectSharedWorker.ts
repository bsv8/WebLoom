// Window → SharedWorker 的 v4 双向连接。

import type { CapabilityBridge, CapabilityClient, CapabilityPeer, RemoteCapability, ServiceReference } from "../contracts/capability.js";
import { capabilityKey } from "../contracts/capability.js";
import type { LifecycleDisposeResult, RuntimeSnapshot } from "../contracts/lifecycle.js";
import { WebLoomError } from "../contracts/lifecycle.js";
import { createCapabilityPeerView, createPeerScopeView } from "./peerView.js";
import { cloneFrozenAttributes, createRuntimeBudget, normalizeRuntimeLimits, type RuntimeBudget, type RuntimeLimitsInput } from "../transport/dto.js";
import type { WindowApp, RuntimeHandle, RuntimeStatusListener, RuntimeStatusSnapshot } from "./runtimeTypes.js";
import { RuntimeUnavailableError } from "./runtimeTypes.js";
import { createCapabilityBridge } from "../transport/serviceBridge.js";
import { createMessagePortRuntimeTransport, type MessagePortLike } from "../transport/messagePortServiceTransport.js";
import { createMessagePortServiceProvider } from "../transport/messagePortServiceProvider.js";
import { invokeCapabilityHandler } from "../host/capabilityRegistry.js";
import { hostForWindowApp } from "./windowRuntime.js";
import { RUNTIME_ERROR_TYPE, RUNTIME_PROTOCOL_VERSION, RUNTIME_SNAPSHOT_TYPE } from "./runtimeProtocol.js";

export interface SharedWorkerLike {
  /** SharedWorker 主端口。 */
  readonly port: MessagePort;
  /** Worker error callback。 */
  onerror?: (event: Event) => void;
  addEventListener?(type: "error", listener: (event: Event) => void): void;
  removeEventListener?(type: "error", listener: (event: Event) => void): void;
}

export type SharedWorkerFactory = (url: string | URL, options: { type: "module"; name?: string; credentials?: RequestCredentials }) => SharedWorkerLike;

export interface SharedWorkerClientExposure {
  /** 已完成本地初始化的 WindowApp。 */
  readonly app: WindowApp;
  /** 明确暴露给 Worker 的 RPC/stream capability。 */
  readonly expose?: readonly RemoteCapability[];
}

export interface ConnectSharedWorkerOptions {
  /** Worker Runtime 逻辑标识。 */
  readonly id: string;
  /** Worker 构建 URL。 */
  readonly url: string | URL;
  /** SharedWorker name。 */
  readonly name?: string;
  /** 请求 credentials。 */
  readonly credentials?: RequestCredentials;
  /** 默认 call 预算。 */
  readonly defaultCallTimeoutMs?: number;
  /** 可信 transport 配额；只能使用默认值或收紧。 */
  readonly limits?: RuntimeLimitsInput;
  /** 可选的页面反向能力。 */
  readonly client?: SharedWorkerClientExposure;
}

interface InternalOptions extends ConnectSharedWorkerOptions { readonly workerFactory?: SharedWorkerFactory; }
const handleBridges = new WeakMap<object, CapabilityBridge>();

function makeWorker(options: InternalOptions): SharedWorkerLike {
  const workerOptions = { type: "module" as const, ...(options.name !== undefined ? { name: options.name } : {}), ...(options.credentials !== undefined ? { credentials: options.credentials } : {}) };
  if (options.workerFactory) return options.workerFactory(options.url, workerOptions);
  const WorkerConstructor = (globalThis as unknown as { SharedWorker?: new (url: string | URL, options: typeof workerOptions) => SharedWorkerLike }).SharedWorker;
  if (!WorkerConstructor) throw new RuntimeUnavailableError("SharedWorker is not supported by this browser");
  return new WorkerConstructor(options.url, workerOptions);
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function snapshotForClient(app: WindowApp, runtimeId: string, runtimeInstanceId: string, exposed: readonly RemoteCapability[], revision: number): RuntimeSnapshot & { readonly type: typeof RUNTIME_SNAPSHOT_TYPE } {
  const allowed = new Set(exposed.map((capability) => capabilityKey(capability)));
  const state = app.state();
  const runtimeState: RuntimeSnapshot["state"] = state.state === "disconnected" ? "failed" : state.state;
  return {
    type: RUNTIME_SNAPSHOT_TYPE,
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    runtimeId,
    runtimeKind: "window-main",
    runtimeInstanceId,
    revision,
    state: runtimeState,
    units: state.units,
    services: runtimeState === "ready" ? state.services.filter((service) => allowed.has(capabilityKey({ kind: service.kind, id: service.capabilityId, version: service.contractVersion }))).map((service) => ({ kind: service.kind, capabilityId: service.capabilityId, contractVersion: service.contractVersion, serviceInstanceId: service.serviceInstanceId, attributes: cloneFrozenAttributes(service.attributes), ...(service.grantId !== undefined ? { grantId: service.grantId } : {}), ...(service.authorizationRevision !== undefined ? { authorizationRevision: service.authorizationRevision } : {}) })) : [],
  };
}

function connectInternal(options: InternalOptions): RuntimeHandle {
  if (!options || typeof options.id !== "string" || options.id.trim() === "") throw new TypeError("SharedWorker runtime id must be a non-empty string");
  const requestedClientHost = options.client ? hostForWindowApp(options.client.app) : undefined;
  const exposed = options.client?.expose ?? [];
  for (const capability of exposed) {
    if ((capability as { readonly kind?: string }).kind !== "rpc" && (capability as { readonly kind?: string }).kind !== "stream") throw new TypeError(`Capability "${(capability as { readonly id?: string }).id ?? "unknown"}" is not remotely exposable`);
    if (!requestedClientHost?.capabilities.registration(capability)) throw new TypeError(`Capability "${capability.id}" is not registered by the WindowApp`);
  }
  const worker = makeWorker(options);
  const port = worker.port;
  if (!port) throw new RuntimeUnavailableError("SharedWorker did not expose a MessagePort");
  const limits = normalizeRuntimeLimits(options.limits);
  const transport = createMessagePortRuntimeTransport({
    addEventListener(type, listener) { port.addEventListener(type, listener); },
    removeEventListener(type, listener) { port.removeEventListener(type, listener); },
    postMessage(messageValue, transfer) { (port as unknown as MessagePortLike).postMessage(messageValue, transfer ? [...transfer] : undefined); },
    start() { port.start(); },
    close() { try { port.close(); } catch { /* noop */ } },
  }, { limits });
  const outboundBudget: RuntimeBudget = createRuntimeBudget(limits);
  const inboundBudget: RuntimeBudget = createRuntimeBudget(limits);
  const bridge = createCapabilityBridge({ transport, remoteRuntimeKind: "shared-worker", remoteRuntimeId: options.id, defaultCallTimeoutMs: options.defaultCallTimeoutMs, limits, budget: outboundBudget });
  const listeners = new Set<RuntimeStatusListener>();
  const workerInstanceId = { value: "" };
  const localRuntimeInstanceId = options.client?.app.runtimeInstanceId ?? `window:${Date.now().toString(36)}`;
  let revision = 0;
  let disposed = false;
  let current: RuntimeStatusSnapshot = Object.freeze({ protocolVersion: RUNTIME_PROTOCOL_VERSION, runtimeId: options.id, runtimeKind: "shared-worker", runtimeInstanceId: "", state: "starting", revision: 0, units: [], services: [] });
  const clientHost = requestedClientHost;
  const clientPeerScope = options.client && clientHost
    ? clientHost.rootScope.child("peer", { attributes: { peerId: `peer:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}` } })
    : undefined;
  const clientPeerScopeView = clientPeerScope ? createPeerScopeView(clientPeerScope) : undefined;
  const clientPeer: CapabilityPeer | undefined = clientPeerScope && clientPeerScopeView ? createCapabilityPeerView({
    peerId: clientPeerScope.identity.attributes.peerId as string,
    scope: clientPeerScopeView,
    bridge,
    capabilityScope: clientPeerScope,
  }) : undefined;
  const provider = options.client && clientHost ? createMessagePortServiceProvider({
    transport,
    peerScope: clientPeerScope,
    peer: clientPeer,
    budget: inboundBudget,
    limits,
    services: () => clientHost.serviceReferences().filter((service) => exposed.some((capability) => capabilityKey(capability) === capabilityKey({ kind: service.kind, id: service.capabilityId, version: service.contractVersion }))),
    peerForCall: (_call, reference) => {
      const registration = clientHost.capabilities.registration({ kind: reference.kind, id: reference.capabilityId, version: reference.contractVersion });
      return clientPeerScope && clientPeerScopeView ? createCapabilityPeerView({
        peerId: clientPeerScope.identity.attributes.peerId as string,
        scope: clientPeerScopeView,
        bridge,
        allowed: registration?.peerDependencies ?? [],
        capabilityScope: clientPeerScope,
      }) : undefined;
    },
    prepareRequest: (call) => {
      const registration = clientHost.capabilities.registration({ kind: call.mode === "stream" ? "stream" : "rpc", id: call.capabilityId, version: call.contractVersion });
      if (!registration || registration.capability.kind !== (call.mode === "stream" ? "stream" : "rpc")) throw new WebLoomError("service_stale", "Window service exposure is stale", "dispatch");
      const capability = registration.capability as typeof registration.capability & { request: { parse(value: unknown): unknown }; transfer?: { request?: (value: unknown) => readonly Transferable[] } };
      let value: unknown;
      try { value = capability.request.parse(call.request); } catch { throw new WebLoomError("request_validation_failed", "Capability request failed validation", "receive"); }
      return { value, transfer: capability.transfer?.request?.(value) };
    },
    handleCall: async ({ request, reference, signal, deadlineAt, peer }) => {
      const registration = clientHost.capabilities.registration({ kind: reference.kind, id: reference.capabilityId, version: reference.contractVersion });
      if (!registration) throw new WebLoomError("service_stale", "Window exposure is no longer available", "dispatch");
      const handler = registration.handler as ((value: unknown, context: import("../contracts/capability.js").HandlerCallContext) => unknown | Promise<unknown>) | undefined;
      if (!handler) throw new WebLoomError("service_stale", "Window service handler is unavailable", "dispatch");
      return handler(request, { signal, deadlineAt, reference, origin: "remote", peer });
    },
    prepareResult: (value, call) => {
      const registration = clientHost.capabilities.registration({ kind: "rpc", id: call.capabilityId, version: call.contractVersion });
      if (!registration || registration.capability.kind !== "rpc") throw new Error("Window RPC registration disappeared");
      const rpc = registration.capability as typeof registration.capability & { response: { parse(value: unknown): unknown }; transfer?: { response?: (value: unknown) => readonly Transferable[] } };
      const parsed = rpc.response.parse(value);
      return { value: parsed, transfer: rpc.transfer?.response?.(parsed) };
    },
    prepareItem: (value, call) => {
      const registration = clientHost.capabilities.registration({ kind: "stream", id: call.capabilityId, version: call.contractVersion });
      if (!registration || registration.capability.kind !== "stream") throw new Error("Window stream registration disappeared");
      const stream = registration.capability as typeof registration.capability & { item: { parse(value: unknown): unknown }; transfer?: { item?: (value: unknown) => readonly Transferable[] } };
      const parsed = stream.item.parse(value);
      return { value: parsed, transfer: stream.transfer?.item?.(parsed) };
    },
  }) : undefined;

  const emit = (next: RuntimeStatusSnapshot): void => { current = Object.freeze({ ...next, units: Object.freeze([...next.units]), services: Object.freeze([...next.services]) }); for (const listener of [...listeners]) { try { listener(current); } catch { /* observer isolation */ } } };
  const sendClientSnapshot = (): void => { if (!options.client || disposed) return; revision += 1; try { transport.send(snapshotForClient(options.client.app, `${options.client.app.runtimeId}`, localRuntimeInstanceId, exposed, revision)); } catch { /* bridge deadline handles disconnect */ } };
  const removeRaw = transport.subscribe((messageValue) => {
    if (messageValue.type === RUNTIME_SNAPSHOT_TYPE && messageValue.runtimeKind === "shared-worker") {
      const applied = bridge.applySnapshot(messageValue);
      if (applied.accepted) {
        workerInstanceId.value = messageValue.runtimeInstanceId;
        emit({ protocolVersion: RUNTIME_PROTOCOL_VERSION, runtimeId: messageValue.runtimeId, runtimeKind: messageValue.runtimeKind, runtimeInstanceId: messageValue.runtimeInstanceId, state: messageValue.state, revision: messageValue.revision, units: messageValue.units, services: messageValue.services });
      }
    } else if (messageValue.type === RUNTIME_ERROR_TYPE) {
      bridge.invalidate(messageValue.message);
      emit({ ...current, state: "failed", error: messageValue.message, units: [], services: [] });
    }
  });
  const onError = (): void => { if (!disposed) { clientPeerScope?.revoke("SharedWorker disconnected"); provider?.dispose(); bridge.disconnect("SharedWorker disconnected"); emit({ ...current, state: "disconnected", runtimeInstanceId: "", revision: 0, units: [], services: [], error: "SharedWorker disconnected" }); } };
  port.addEventListener("messageerror", onError);
  if (worker.addEventListener) worker.addEventListener("error", onError);
  else worker.onerror = onError;
  sendClientSnapshot();
  const removeClient = options.client?.app.subscribe(() => sendClientSnapshot());

  const handle: RuntimeHandle = {
    runtimeKind: "shared-worker", runtimeId: options.id,
    get runtimeInstanceId() { return workerInstanceId.value; },
    state: () => current,
    capability<C extends RemoteCapability>(capability: C): CapabilityClient<C> { return bridge.getClient(capability); },
    optionalCapability<C extends RemoteCapability>(capability: C): CapabilityClient<C> | undefined { return bridge.services().some((service) => service.kind === capability.kind && service.capabilityId === capability.id && service.contractVersion === capability.version) ? bridge.getClient(capability) : undefined; },
    inspect: () => Object.freeze({ ...current, pendingCallCount: bridge.pendingCallCount, activeStreamCount: bridge.activeStreamCount, peerCount: current.state === "ready" ? 1 : 0 }),
    subscribe(listener) { listeners.add(listener); listener(current); return () => listeners.delete(listener); },
    dispose(reason = "SharedWorker connection disposed"): Promise<void> { if (disposed) return Promise.resolve(); disposed = true; emit({ ...current, state: "stopping" }); removeClient?.(); removeRaw(); clientPeerScope?.revoke(reason); provider?.dispose(); bridge.dispose(reason); port.removeEventListener("messageerror", onError); worker.removeEventListener?.("error", onError); transport.close?.(); emit({ ...current, state: "disposed", runtimeInstanceId: "", revision: 0, units: [], services: [] }); return clientPeerScope ? clientPeerScope.dispose({ reason }).then(() => undefined) : Promise.resolve(); },
  };
  handleBridges.set(handle as object, bridge);
  return handle;
}

/** 同步创建 RuntimeHandle；ready 由 state/capability Promise 观察。 */
export function connectSharedWorker(options: ConnectSharedWorkerOptions): RuntimeHandle { return connectInternal(options); }

/** testing 入口才允许注入可控 Worker 工厂。 */
export function connectSharedWorkerForTesting(options: ConnectSharedWorkerOptions, workerFactory: SharedWorkerFactory): RuntimeHandle { return connectInternal({ ...options, workerFactory }); }

/** advanced 装配层取得连接 bridge；普通 RuntimeHandle 不暴露该实现细节。 */
export function bridgeForRuntimeHandle(handle: RuntimeHandle): CapabilityBridge {
  const bridge = handleBridges.get(handle as object);
  if (!bridge) throw new Error("RuntimeHandle is not owned by WebLoom");
  return bridge;
}
