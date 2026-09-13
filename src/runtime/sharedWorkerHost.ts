// SharedWorkerGlobalScope 内的 v4 Runtime。

import type { CapabilityPeer, RemoteCapability, ServiceReference } from "../contracts/capability.js";
import { capabilityKey } from "../contracts/capability.js";
import { WebLoomError, type LifecycleDisposeResult, type LifecycleScope, type RuntimeEndpointBinding, type RuntimeEndpointState, type RuntimeSnapshot } from "../contracts/lifecycle.js";
import { createRuntimeBudget, normalizeRuntimeLimits, validateDto, type RuntimeBudget, type RuntimeLimitsInput } from "../transport/dto.js";
import type { PluginManifest } from "../contracts/plugin.js";
import { createPluginHost, type CreatePluginHostOptions, type HostInspection, type PluginHost } from "../host/createPluginHost.js";
import { createRuntimeUnitImplementationRegistry } from "../host/runtimeUnitImplementationRegistry.js";
import { invokeCapabilityHandler } from "../host/capabilityRegistry.js";
import { materializePluginDefinitions, type RuntimePluginDefinition } from "./pluginDefinitions.js";
import { createCapabilityBridge } from "../transport/serviceBridge.js";
import { createMessagePortRuntimeTransport } from "../transport/messagePortServiceTransport.js";
import { createMessagePortServiceProvider } from "../transport/messagePortServiceProvider.js";
import { cloneFrozenAttributes } from "../transport/dto.js";
import { createRuntimeMessageCodec, RUNTIME_PROTOCOL_VERSION, RUNTIME_SNAPSHOT_TYPE } from "./runtimeProtocol.js";
import { RuntimeInitializationError, type RuntimeStatusListener, type RuntimeStatusSnapshot } from "./runtimeTypes.js";
import { createCapabilityPeerView, createPeerScopeView } from "./peerView.js";
import { createRuntimeEndpointBinding, createRuntimeEndpointSession, type RuntimeEndpointSession } from "./runtimeSession.js";

export interface SharedWorkerScopeLike {
  /** SharedWorker 连接事件。 */
  onconnect: ((event: { ports: MessagePort[] }) => void) | null;
}

export interface PeerExposureOptions {
  /** 领域授权标识。 */
  readonly grantId?: string;
  /** 授权修订。 */
  readonly authorizationRevision?: number;
  /** 无环公开属性。 */
  readonly attributes?: Readonly<Record<string, unknown>>;
  /** 领域授权检查。 */
  readonly authorize?: (context: import("../contracts/capability.js").HandlerCallContext, request: unknown) => boolean | Promise<boolean>;
  /** 领域 Scope。 */
  readonly scope?: LifecycleScope;
}

export interface PeerController {
  /** peer 标识。 */
  readonly peerId: string;
  /** 当前物理 endpoint 的不可复用框架 binding。 */
  readonly binding: RuntimeEndpointBinding;
  /** 当前物理 endpoint 的关闭阶段。 */
  readonly endpointState: RuntimeEndpointState;
  /** 已观察到的页面 Runtime 实例；首个页面快照前为空。 */
  readonly runtimeInstanceId?: string;
  /** 对端 Window Runtime 类型。 */
  readonly runtime: "window-main";
  /** peer 子作用域。 */
  readonly scope: LifecycleScope;
  /** 传给普通 handler 的最小 PeerView。 */
  readonly view: CapabilityPeer;
  /** 获取页面暴露的 typed remote capability。 */
  capability<C extends RemoteCapability>(capability: C): import("../contracts/capability.js").CapabilityClient<C>;
  /** 暴露 Worker 已注册的 capability。 */
  expose<C extends RemoteCapability>(capability: C, options?: PeerExposureOptions): { revoke(): void };
  /** 原子暴露一组 capability；任一项非法时不得部分开放。 */
  exposeGroup(entries: readonly { readonly capability: RemoteCapability; readonly options?: PeerExposureOptions }[]): { revoke(): void };
  /** 断开此 peer，不影响其它页面。 */
  disconnect(reason?: string): void;
  /** 同步停止新调用与暴露；后续由 drain/close 完成异步收尾。 */
  beginClose(reason?: string): void;
  /** 等待该 peer endpoint 的 bounded drain。 */
  drain(timeoutMs?: number): Promise<import("../contracts/lifecycle.js").RuntimeDrainResult>;
  /** peer 诊断。 */
  inspect(): Readonly<Record<string, unknown>>;
}

/** 可信 Host 可观察的 peer 生命周期事件；不包含 owner/lease 等领域字段。 */
export interface PeerLifecycleEvent {
  /** active 建立、handoff 通知或关闭阶段。 */
  readonly event: "active" | "handoff" | "closing" | "closed";
  /** peer 物理连接的 opaque 标识。 */
  readonly peerId: string;
  /** 当前物理 endpoint 的框架 binding。 */
  readonly binding: RuntimeEndpointBinding;
  /** endpoint 的框架生命周期。 */
  readonly state: RuntimeEndpointState;
  /** closed 事件的真实 bounded drain 结果。 */
  readonly drain?: import("../contracts/lifecycle.js").RuntimeDrainResult;
  /** 可信 Host 提供的 handoff 修订；WebLoom 不解释或选择 owner。 */
  readonly handoffRevision?: number;
}

/** 可信 Host 查询到的 active peer 只读投影。 */
export type ActivePeerSnapshot = Omit<PeerLifecycleEvent, "event" | "drain" | "handoffRevision"> & { readonly event: "active" };

export interface StartSharedWorkerAppOptions extends Omit<CreatePluginHostOptions, "runtime" | "runtimeUnitImplementationRegistry" | "runtimeId" | "runtimeInstanceId"> {
  /** Worker Runtime 逻辑标识。 */
  readonly id: string;
  /** Worker realm 的插件定义。 */
  readonly plugins: readonly RuntimePluginDefinition[];
  /** 对每个新 peer 顶层暴露的能力。 */
  readonly expose?: readonly RemoteCapability[];
  /** 同步配置 peer 级策略。 */
  readonly configurePeer?: (peer: PeerController) => void;
  /** configurePeer 可管理的显式 capability allowlist；未设置时不开放动态能力。 */
  readonly peerExposureAllowlist?: readonly RemoteCapability[];
  /** 可信 transport 配额；只能使用默认值或收紧。 */
  readonly limits?: RuntimeLimitsInput;
}

export interface StartSharedWorkerAppForTestingOptions extends StartSharedWorkerAppOptions {
  /** testing 入口注入的 SharedWorkerGlobalScope 替身。 */
  readonly globalScope: SharedWorkerScopeLike;
  /** 仅测试用：观察每次向所有 peer 广播前构建的公共快照。 */
  readonly snapshotObserver?: (snapshot: RuntimeStatusSnapshot) => void;
}

export interface SharedWorkerApp {
  readonly runtimeKind: "shared-worker";
  readonly runtimeId: string;
  readonly runtimeInstanceId: string;
  ready(): Promise<void>;
  reconcile(): Promise<void>;
  state(): RuntimeStatusSnapshot;
  subscribe(listener: RuntimeStatusListener): () => void;
  inspect(): HostInspection;
  /** 只读查询当前仍处于 active 的物理 peer。 */
  activePeers(): readonly ActivePeerSnapshot[];
  /** 订阅 Host 可见的 peer active/closing/closed/handoff 事件。 */
  subscribePeerLifecycle(listener: (event: PeerLifecycleEvent) => void): () => void;
  /** 可信领域在完成自己的 owner/session 交接后报告 handoff；框架不选择 owner。 */
  notifyPeerHandoff(peerId: string, handoffRevision?: number): boolean;
  dispose(reason?: string): Promise<LifecycleDisposeResult>;
}

interface Endpoint {
  readonly port: MessagePort;
  readonly scope: LifecycleScope;
  readonly binding: RuntimeEndpointBinding;
  readonly session: RuntimeEndpointSession;
  readonly transport: ReturnType<typeof createMessagePortRuntimeTransport>;
  readonly bridge: ReturnType<typeof createCapabilityBridge>;
  readonly provider: ReturnType<typeof createMessagePortServiceProvider>;
  readonly exposures: Map<string, ServiceReference>;
  readonly installTopLevelExposures: () => void;
  closed: boolean;
  revision: number;
  /** 已启动的 endpoint 收尾 Promise；保证 close 调用幂等且可等待。 */
  closePromise?: Promise<void>;
}

function makeId(prefix: string): string {
  try { if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return `${prefix}:${crypto.randomUUID()}`; } catch { /* fallback */ }
  return `${prefix}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

/** 启动一个真实 SharedWorker Runtime；setup 异步完成前也会发布空 services 快照。 */
function startSharedWorkerAppInternal(options: StartSharedWorkerAppOptions & Pick<StartSharedWorkerAppForTestingOptions, "snapshotObserver">, injectedScope?: SharedWorkerScopeLike): SharedWorkerApp {
  if (!options || typeof options.id !== "string" || options.id.trim() === "") throw new TypeError("SharedWorker runtime id must be a non-empty string");
  const scope = injectedScope ?? ((globalThis as unknown as { onconnect?: unknown }).onconnect !== undefined ? globalThis as unknown as SharedWorkerScopeLike : undefined);
  if (!scope) throw new RuntimeInitializationError({ phase: "validate", error: "startSharedWorkerApp must run in a SharedWorkerGlobalScope" });
  const runtimeInstanceId = makeId(options.id);
  const limits = normalizeRuntimeLimits(options.limits);
  // One counter per direction is shared by every endpoint in this Runtime;
  // per-peer limits remain enforced inside each bridge/provider.
  const outboundBudget: RuntimeBudget = createRuntimeBudget(limits);
  const inboundBudget: RuntimeBudget = createRuntimeBudget(limits);
  const runtimeCodec = createRuntimeMessageCodec();
  const peerExposureAllowlist = options.peerExposureAllowlist === undefined
    ? undefined
    : new Set(options.peerExposureAllowlist.map((capability) => capabilityKey(capability)));
  const listeners = new Set<RuntimeStatusListener>();
  const peerLifecycleListeners = new Set<(event: PeerLifecycleEvent) => void>();
  const endpoints = new Set<Endpoint>();
  let manifests: readonly PluginManifest[] = [];
  let runtimeState: RuntimeSnapshot["state"] = "starting";
  let revision = 0;
  let disposed = false;
  let accepting = true;
  let host: PluginHost | undefined;
  let disposePromise: Promise<LifecycleDisposeResult> | undefined;

  const emitPeerLifecycle = (event: PeerLifecycleEvent): void => {
    const frozen = Object.freeze({
      ...event,
      binding: Object.freeze({ ...event.binding }),
      ...(event.drain !== undefined ? { drain: Object.freeze({ ...event.drain }) } : {}),
    });
    for (const listener of [...peerLifecycleListeners]) {
      try { listener(frozen); } catch { /* observer isolation */ }
    }
  };

  const localSnapshot = (): RuntimeStatusSnapshot => {
    const currentHost = host;
    const units = currentHost ? currentHost.installed().flatMap((pluginId) => currentHost.state(pluginId).units.map((unit) => ({ pluginId: unit.pluginId, unitId: unit.unitId, runtime: unit.runtime, ...(unit.instanceId !== undefined ? { instanceId: unit.instanceId } : {}), state: unit.kind }))) : [];
    const services = runtimeState === "ready" && host ? host.serviceReferences().map((service) => ({ kind: service.kind, capabilityId: service.capabilityId, contractVersion: service.contractVersion, serviceInstanceId: service.serviceInstanceId, attributes: cloneFrozenAttributes(service.attributes), ...(service.grantId !== undefined ? { grantId: service.grantId } : {}), ...(service.authorizationRevision !== undefined ? { authorizationRevision: service.authorizationRevision } : {}) })) : [];
    return Object.freeze({ protocolVersion: RUNTIME_PROTOCOL_VERSION, runtimeId: options.id, runtimeKind: "shared-worker", runtimeInstanceId, revision, state: runtimeState, units: Object.freeze(units), services: Object.freeze(services) });
  };
  const emit = (snapshot: RuntimeStatusSnapshot = localSnapshot()): void => { for (const listener of [...listeners]) { try { listener(snapshot); } catch { /* observer isolation */ } } };
  const projectedUnits = (exposures: ReadonlyMap<string, ServiceReference>): readonly RuntimeSnapshot["units"][number][] => {
    if (!host || exposures.size === 0) return Object.freeze([]);
    // A peer may only learn about the provider units behind services explicitly
    // visible in its projection. The local Host snapshot remains complete for
    // trusted inspection; the wire projection must not be a hidden-provider
    // index.
    const owners = new Set(
      host.capabilities.registrations()
        .filter((registration) => exposures.has(capabilityKey(registration.capability)))
        .map((registration) => registration.ownerId),
    );
    if (owners.size === 0) return Object.freeze([]);
    return Object.freeze(host.installed().flatMap((pluginId) => host!.state(pluginId).units
      .filter((unit) => unit.instanceId !== undefined && owners.has(unit.instanceId))
      .map((unit) => ({ pluginId: unit.pluginId, unitId: unit.unitId, runtime: unit.runtime, ...(unit.instanceId !== undefined ? { instanceId: unit.instanceId } : {}), state: unit.kind }))));
  };
  const wireSnapshot = (endpoint: Endpoint, nextRevision = endpoint.revision, exposures: ReadonlyMap<string, ServiceReference> = endpoint.exposures, base = localSnapshot()): RuntimeSnapshot & { readonly type: typeof RUNTIME_SNAPSHOT_TYPE; readonly binding: RuntimeEndpointBinding } => {
    const services = [...exposures.values()].map((service) => ({ kind: service.kind, capabilityId: service.capabilityId, contractVersion: service.contractVersion, serviceInstanceId: service.serviceInstanceId, attributes: cloneFrozenAttributes(service.attributes), ...(service.grantId !== undefined ? { grantId: service.grantId } : {}), ...(service.authorizationRevision !== undefined ? { authorizationRevision: service.authorizationRevision } : {}) }));
    const state: RuntimeSnapshot["state"] = base.state === "disconnected" ? "failed" : base.state;
    return { type: RUNTIME_SNAPSHOT_TYPE, protocolVersion: base.protocolVersion, runtimeId: base.runtimeId, runtimeKind: base.runtimeKind, runtimeInstanceId: base.runtimeInstanceId, revision: nextRevision, state, units: projectedUnits(exposures), services: state === "ready" ? services : [], binding: endpoint.binding };
  };
  const validateProjectedSnapshot = (endpoint: Endpoint, exposures: ReadonlyMap<string, ServiceReference>): void => {
    if (exposures.size > limits.maxSnapshotServices) throw new WebLoomError("resource_limit_exceeded", "Runtime service exposure limit exceeded", "dispatch");
    const snapshot = wireSnapshot(endpoint, endpoint.revision + 1, exposures);
    runtimeCodec.encode(snapshot);
    validateDto(snapshot, { limits: { maxDepth: limits.maxDtoDepth, maxNodes: limits.maxDtoNodes, maxEdges: limits.maxDtoEdges, maxBudgetBytes: limits.maxMessageBudgetBytes }, phase: "dispatch" });
  };
  const publish = (endpoint: Endpoint, exposures = endpoint.exposures, base?: RuntimeStatusSnapshot, allowClosed = false): void => {
    if (endpoint.closed && !allowClosed) return;
    const nextRevision = endpoint.revision + 1;
    const snapshot = wireSnapshot(endpoint, nextRevision, exposures, base);
    endpoint.transport.send(snapshot);
    // postMessage performs structured-clone synchronously. Advance the
    // per-peer revision only after that operation has succeeded.
    endpoint.revision = nextRevision;
  };
  const publishAll = (): void => {
    const base = localSnapshot();
    options.snapshotObserver?.(base);
    for (const endpoint of endpoints) {
      try { publish(endpoint, endpoint.exposures, base); } catch { closeEndpoint(endpoint, "Runtime snapshot publication failed"); }
    }
    emit(base);
  };

  const createEndpoint = (port: MessagePort): Endpoint => {
    if (!host) throw new Error("SharedWorker Host is unavailable");
    const peerScope = host.rootScope.child("peer", { attributes: { peerId: makeId("peer") } });
    const transport = createMessagePortRuntimeTransport(port, { limits });
    const binding = createRuntimeEndpointBinding(runtimeInstanceId);
    const session = createRuntimeEndpointSession(binding);
    const bridge = createCapabilityBridge({ transport, remoteRuntimeKind: "window-main", limits, budget: outboundBudget, binding, session });
    const exposures = new Map<string, ServiceReference>();
    const exposurePolicies = new Map<string, PeerExposureOptions>();
    const peerId = peerScope.identity.attributes.peerId as string | undefined ?? makeId("peer");
    const peerScopeView = createPeerScopeView(peerScope);
    const peerView: CapabilityPeer = createCapabilityPeerView({ peerId, binding, scope: peerScopeView, bridge, capabilityScope: peerScope });
    let endpointForDisconnect: Endpoint | undefined;
    const exposeGroup = (entries: readonly { readonly capability: RemoteCapability; readonly options?: PeerExposureOptions }[], source: "dynamic" | "top-level" = "dynamic"): { revoke(): void } => {
      if (peerScope.state !== "active") throw new WebLoomError("service_revoked", "Peer scope is not active", "dispatch", { capabilityId: entries[0]?.capability.id });
      const prepared: { key: string; reference: ServiceReference; options: PeerExposureOptions }[] = [];
      const keys = new Set<string>();
      for (const entry of entries) {
        const capability = entry.capability;
        const exposureOptions = entry.options ?? {};
        const key = capabilityKey(capability);
        if (source === "dynamic" && (!peerExposureAllowlist || !peerExposureAllowlist.has(key))) {
          throw new WebLoomError("capability_unavailable", "Capability is outside the peer exposure allowlist", "dispatch", { capabilityId: capability.id });
        }
        const registration = host?.capabilities.registration(capability);
        if (!registration || (capability.kind !== "rpc" && capability.kind !== "stream") || registration.capability.kind !== capability.kind) {
          throw new Error(`Capability "${capability.id}" is not a remote capability registered by this Host`);
        }
        if (keys.has(key) || exposures.has(key)) throw new Error(`Capability "${capability.id}" is already exposed to this peer`);
        keys.add(key);
        const reference: ServiceReference = Object.freeze({
          ...registration.reference,
          serviceInstanceId: makeId(`exposure:${peerId}:${capability.id}`),
          attributes: cloneFrozenAttributes(exposureOptions.attributes ?? registration.reference.attributes),
          ...(exposureOptions.grantId !== undefined ? { grantId: exposureOptions.grantId } : {}),
          ...(exposureOptions.authorizationRevision !== undefined ? { authorizationRevision: exposureOptions.authorizationRevision } : {}),
        });
        prepared.push({ key, reference, options: exposureOptions });
      }
      const projected = new Map(exposures);
      for (const item of prepared) projected.set(item.key, item.reference);
      if (endpointForDisconnect) validateProjectedSnapshot(endpointForDisconnect, projected);
      else if (projected.size > limits.maxSnapshotServices) throw new WebLoomError("resource_limit_exceeded", "Runtime service exposure limit exceeded", "dispatch");

      let active = true;
      let committed = false;
      const removers: (() => void)[] = [];
      const removeExposure = (key: string): void => {
        if (!active || !committed || !exposures.delete(key)) return;
        exposurePolicies.delete(key);
        // If the peer scope itself is being revoked, the group callback below
        // performs one grouped removal/publication. Avoid exposing an
        // intermediate per-item revision during that synchronous fence.
        if (endpointForDisconnect && peerScope.state === "active") {
          try { publish(endpointForDisconnect); } catch { closeEndpoint(endpointForDisconnect, "Runtime snapshot publication failed"); }
        }
      };
      const removeGroup = (): void => {
        if (!active) return;
        active = false;
        let changed = false;
        for (const item of prepared) {
          changed = exposures.delete(item.key) || changed;
          exposurePolicies.delete(item.key);
        }
        for (const remove of removers.splice(0)) remove();
        if (changed && endpointForDisconnect) {
          try { publish(endpointForDisconnect); } catch { closeEndpoint(endpointForDisconnect, "Runtime snapshot publication failed"); }
        }
      };
      try {
        for (const item of prepared) {
          if (item.options.scope) {
            if (item.options.scope.state !== "active") throw new WebLoomError("service_revoked", "Capability exposure scope is not active", "dispatch", { capabilityId: item.reference.capabilityId });
            removers.push(item.options.scope.onRevoke(() => removeExposure(item.key)));
          }
        }
        removers.push(peerScope.onRevoke(() => removeGroup()));
      } catch (error) {
        for (const remove of removers.splice(0)) remove();
        throw error;
      }

      // The projected snapshot is sent before the local maps are changed. A
      // synchronous postMessage failure therefore cannot leave a locally
      // committed service that the peer never observed. Map insertion itself
      // is then a non-throwing commit step and advances exactly one revision
      // for the complete group.
      try {
        if (prepared.length > 0 && endpointForDisconnect) publish(endpointForDisconnect, projected);
      } catch (error) {
        active = false;
        for (const remove of removers.splice(0)) remove();
        throw error;
      }
      if (peerScope.state !== "active" || prepared.some((item) => item.options.scope !== undefined && item.options.scope.state !== "active")) {
        active = false;
        for (const remove of removers.splice(0)) remove();
        throw new WebLoomError("service_revoked", "Capability exposure scope was revoked before commit", "dispose", { capabilityId: prepared[0]?.reference.capabilityId });
      }
      for (const item of prepared) {
        exposures.set(item.key, item.reference);
        exposurePolicies.set(item.key, item.options);
      }
      committed = true;
      // Scope callbacks are registered above and only run after this task; the
      // explicit handle remains the first-class idempotent revocation path.
      return { revoke: removeGroup };
    };
    let disconnectRequested: string | undefined;
    const configuredExposureKeys = new Set<string>();
    const peer: PeerController = {
      peerId,
      binding,
      get endpointState() { return session.state; },
      get runtimeInstanceId() { return bridge.runtimeInstanceId; },
      runtime: "window-main",
      scope: peerScope,
      view: peerView,
      capability: (capability) => bridge.getClient(capability, peerScope),
      beginClose(reason = "Peer endpoint closing") { session.beginClose(reason); },
      drain(timeoutMs) { return bridge.drain(timeoutMs); },
      expose(capability, exposureOptions = {}) {
        const result = exposeGroup([{ capability, options: exposureOptions }]);
        configuredExposureKeys.add(capabilityKey(capability));
        return result;
      },
      exposeGroup(entries) {
        const result = exposeGroup(entries);
        for (const entry of entries) configuredExposureKeys.add(capabilityKey(entry.capability));
        return result;
      },
      disconnect(reason = "Peer disconnected") {
        if (endpointForDisconnect) closeEndpoint(endpointForDisconnect, reason);
        else { disconnectRequested = reason; peerScope.revoke(reason); }
      },
      inspect: () => Object.freeze({ peerId, scopeId: peerScope.identity.scopeId, state: peerScope.state, exposedServiceCount: exposures.size, pendingCallCount: bridge.pendingCallCount, activeStreamCount: bridge.activeStreamCount }),
    };
    const installTopLevelExposures = (): void => {
      const entries: { readonly capability: RemoteCapability }[] = [];
      for (const capability of options.expose ?? []) {
        const key = capabilityKey(capability);
        if (exposures.has(key)) {
          if (configuredExposureKeys.has(key)) throw new Error(`Capability "${capability.id}" is exposed by configurePeer and top-level expose`);
          continue;
        }
        if (!host?.capabilities.registration(capability)) continue;
        entries.push({ capability });
      }
      // This is an installation path, not a configurePeer-owned exposure. A
      // single projected snapshot keeps the whole top-level set atomic.
      if (entries.length > 0) exposeGroup(entries, "top-level");
    };
    try { options.configurePeer?.(peer); } catch (error) {
      peerScope.revoke("configurePeer failed");
      bridge.dispose("configurePeer failed");
      transport.close?.();
      throw error;
    }
    const provider = createMessagePortServiceProvider({
      transport,
      peerScope,
      peer: peerView,
      binding,
      session,
      budget: inboundBudget,
      limits,
      services: () => [...exposures.values()],
      peerForCall: (_call, reference) => {
        const registration = host?.capabilities.registration({ kind: reference.kind, id: reference.capabilityId, version: reference.contractVersion });
        return createCapabilityPeerView({ peerId, binding, scope: peerScopeView, bridge, allowed: registration?.peerDependencies ?? [], capabilityScope: peerScope });
      },
      prepareRequest: (call) => {
        if (!host) throw new WebLoomError("service_stale", "SharedWorker Host is unavailable", "dispatch");
        const registration = host.capabilities.registration({ kind: call.mode === "stream" ? "stream" : "rpc", id: call.capabilityId, version: call.contractVersion });
        if (!registration || registration.capability.kind !== (call.mode === "stream" ? "stream" : "rpc")) throw new WebLoomError("service_stale", "Runtime service exposure is stale", "dispatch");
        const parser = registration.capability as typeof registration.capability & { request: { parse(value: unknown): unknown }; transfer?: { request?: (value: unknown) => readonly Transferable[] } };
        let value: unknown;
        try { value = parser.request.parse(call.request); } catch { throw new WebLoomError("request_validation_failed", "Capability request failed validation", "receive"); }
        return { value, transfer: parser.transfer?.request?.(value) };
      },
      handleCall: async ({ message: call, request, reference, signal, deadlineAt, peer: callPeer }) => {
        if (!host) throw new Error("SharedWorker Host is unavailable");
        const registration = host.capabilities.registration({ kind: reference.kind, id: reference.capabilityId, version: reference.contractVersion });
        const key = capabilityKey({ kind: reference.kind, id: reference.capabilityId, version: reference.contractVersion });
        const policy = exposurePolicies.get(key);
        if (!registration || !exposures.has(key)) throw new Error("Runtime service exposure is stale");
        const handlerReference = reference;
        const context = { signal, deadlineAt, ...(call.operationId !== undefined ? { operationId: call.operationId } : {}), reference: handlerReference, binding: call.binding, origin: "remote" as const, peer: callPeer };
        if (policy?.authorize && !(await policy.authorize(context, request))) throw new WebLoomError("permission_denied", "Peer capability authorization denied", "dispatch", { capabilityId: reference.capabilityId, serviceInstanceId: reference.serviceInstanceId });
        if (exposures.get(key)?.serviceInstanceId !== handlerReference.serviceInstanceId) throw new WebLoomError("service_stale", "Runtime service exposure was replaced while authorization was pending", "dispatch", { serviceInstanceId: handlerReference.serviceInstanceId });
        if (peerScope.state !== "active" || signal.aborted) throw new WebLoomError("service_revoked", "Peer scope was revoked", "dispose", { serviceInstanceId: reference.serviceInstanceId });
        if (policy?.scope && policy.scope.state !== "active") throw new WebLoomError("service_revoked", "Peer capability authorization scope is revoked", "dispose", { serviceInstanceId: reference.serviceInstanceId });
        const handler = registration.handler as ((value: unknown, context: import("../contracts/capability.js").HandlerCallContext) => unknown | Promise<unknown>) | undefined;
        if (!handler) throw new WebLoomError("service_stale", "Runtime service handler is unavailable", "dispatch");
        return handler(request, context);
      },
      prepareResult: (value, call) => {
        const registration = host?.capabilities.registration({ kind: "rpc", id: call.capabilityId, version: call.contractVersion });
        if (!registration || registration.capability.kind !== "rpc") throw new Error("RPC capability registration disappeared");
        const rpc = registration.capability as typeof registration.capability & { response: { parse(value: unknown): unknown }; transfer?: { response?: (value: unknown) => readonly Transferable[] } };
        const parsed = rpc.response.parse(value);
        const transfer = (rpc.transfer?.response?.(parsed) ?? []);
        return { value: parsed, transfer };
      },
      prepareItem: (value, call) => {
        const registration = host?.capabilities.registration({ kind: "stream", id: call.capabilityId, version: call.contractVersion });
        if (!registration || registration.capability.kind !== "stream") throw new Error("stream capability registration disappeared");
        const stream = registration.capability as typeof registration.capability & { item: { parse(value: unknown): unknown }; transfer?: { item?: (value: unknown) => readonly Transferable[] } };
        const parsed = stream.item.parse(value);
        const transfer = stream.transfer?.item?.(parsed) ?? [];
        return { value: parsed, transfer };
      },
    });
    const endpoint: Endpoint = { port, scope: peerScope, binding, session, transport, bridge, provider, exposures, installTopLevelExposures, closed: false, revision: 0 };
    endpointForDisconnect = endpoint;
    endpoints.add(endpoint);
    emitPeerLifecycle({ event: "active", peerId, binding, state: "active" });
    // A remote RuntimeHandle may close the physical endpoint directly.  The
    // bridge/provider session can acknowledge that close, but the Worker
    // still owns the peer controller and its domain exposure until the
    // endpoint registry is revoked.  Route every terminal session transition
    // through the same local endpoint teardown so configurePeer owners
    // observe the physical peer as closed as well.
    session.onClosed(() => closeEndpoint(endpoint, "Runtime endpoint closed"));
    try {
      if (disconnectRequested !== undefined) closeEndpoint(endpoint, disconnectRequested);
      installTopLevelExposures();
      // Window and Worker may both publish the first snapshot. Incoming snapshots
      // are consumed only by the bridge; no hello/handshake control message exists.
      publish(endpoint);
    } catch (error) {
      closeEndpoint(endpoint, "SharedWorker endpoint initialization failed");
      throw error;
    }
    return endpoint;
  };

  const beginCloseEndpoint = (endpoint: Endpoint, reason: string): void => {
    if (endpoint.closed) return;
    // The peer is removed from admission and all exposures are revoked before
    // any asynchronous drain or physical MessagePort close begins.
    endpoint.closed = true;
    endpoints.delete(endpoint);
    endpoint.scope.revoke(reason);
    endpoint.provider.beginClose(reason);
    endpoint.bridge.beginClose(reason);
    emitPeerLifecycle({ event: "closing", peerId: endpoint.scope.identity.attributes.peerId as string, binding: endpoint.binding, state: "closing" });
  };

  const closeEndpoint = (endpoint: Endpoint, reason: string): Promise<void> => {
    if (endpoint.closePromise) return endpoint.closePromise;
    beginCloseEndpoint(endpoint, reason);
    endpoint.closePromise = (async () => {
      let providerDrain;
      let bridgeDrain;
      try {
        // Both drains are started only after the synchronous admission fence
        // above.  The public app.dispose() promise includes this handshake.
        [providerDrain, bridgeDrain] = await Promise.all([endpoint.provider.drain(), endpoint.bridge.drain()]);
      } catch {
        providerDrain = { state: endpoint.session.state, drained: false, timedOut: true, pendingExecutions: endpoint.provider.executionCount() };
        bridgeDrain = { state: endpoint.session.state, drained: false, timedOut: true, pendingExecutions: endpoint.bridge.pendingCallCount + endpoint.bridge.activeStreamCount };
      }
      try {
        await endpoint.scope.dispose({ reason });
      } catch {
        // The endpoint's transport must still be closed when a domain cleanup
        // callback fails; the close event reports the bounded drain result.
      }
      endpoint.provider.dispose();
      endpoint.bridge.dispose(reason);
      endpoint.transport.close?.();
      endpoint.session.close();
      emitPeerLifecycle({ event: "closed", peerId: endpoint.scope.identity.attributes.peerId as string, binding: endpoint.binding, state: "closed", drain: bridgeDrain.drained && providerDrain.drained ? bridgeDrain : { ...bridgeDrain, drained: false, timedOut: bridgeDrain.timedOut || providerDrain.timedOut, pendingExecutions: Math.max(bridgeDrain.pendingExecutions, providerDrain.pendingExecutions) } });
    })();
    return endpoint.closePromise;
  };
  const sendTerminalSnapshot = (port: MessagePort): void => {
    try {
      port.start();
      const binding = createRuntimeEndpointBinding(runtimeInstanceId);
      port.postMessage({ ...localSnapshot(), type: RUNTIME_SNAPSHOT_TYPE, binding });
      // Give the posted terminal snapshot a turn to cross the port before
      // closing a connection made after the Worker Runtime has stopped.
      setTimeout(() => { try { port.close(); } catch { /* noop */ } }, 0);
    } catch { try { port.close(); } catch { /* noop */ } }
  };
  scope.onconnect = (event) => {
    for (const port of event.ports ?? []) {
      if (!accepting || disposed || endpoints.size >= limits.maxPeers) { sendTerminalSnapshot(port); continue; }
      try { createEndpoint(port); } catch { try { port.close(); } catch { /* noop */ } }
    }
  };

  try {
    const materialized = materializePluginDefinitions(options.plugins, "shared-worker");
    manifests = materialized.map((item) => item.manifest);
    const implementations = createRuntimeUnitImplementationRegistry(materialized.map((item) => ({ pluginId: item.manifest.id, unitId: item.unitId, setup: item.setup, capabilities: item.capabilities })));
    const { id: _id, plugins: _plugins, expose: _expose, configurePeer: _configurePeer, ...hostOptions } = options;
    host = createPluginHost({ ...hostOptions, runtime: "shared-worker", runtimeId: options.id, runtimeInstanceId, runtimeUnitImplementationRegistry: implementations });
    host.subscribe(() => { if (runtimeState === "ready" && !disposed) { revision += 1; publishAll(); } else emit(); });
  } catch (error) {
    runtimeState = "failed";
    const failure = new RuntimeInitializationError({ phase: "validate", error: message(error) });
    const failedReady = Promise.reject(failure);
    void failedReady.catch(() => undefined);
    const failedInspection = (): HostInspection => ({ runtimeId: options.id, runtimeKind: "shared-worker", runtimeInstanceId, version: 0, pluginCount: 0, peerCount: endpoints.size, pendingCallCount: 0, activeStreamCount: 0, plugins: [] });
    return { runtimeKind: "shared-worker", runtimeId: options.id, runtimeInstanceId, ready: () => failedReady, reconcile: async () => failedReady, state: localSnapshot, subscribe(listener) { listeners.add(listener); listener(localSnapshot()); return () => listeners.delete(listener); }, inspect: failedInspection, activePeers: () => Object.freeze([]), subscribePeerLifecycle(listener) { peerLifecycleListeners.add(listener); return () => peerLifecycleListeners.delete(listener); }, notifyPeerHandoff: () => false, dispose: async () => ({ scopeId: `runtime:${runtimeInstanceId}`, state: "stopped", attempted: 0, released: 0, pending: [], errors: [], cleanupIncomplete: false }) };
  }

  const ready = host.registerAll(manifests).then(() => {
    // A peer may have been connected before Host startup finished. Installing
    // the same top-level projection again is idempotent, while a configurePeer
    // collision remains an explicit error.
    for (const endpoint of endpoints) endpoint.installTopLevelExposures();
    if (!disposed) { runtimeState = "ready"; revision += 1; publishAll(); }
  }, (error) => { if (!disposed) { runtimeState = "failed"; publishAll(); } throw new RuntimeInitializationError({ phase: "startup", error: message(error) }); });
  void ready.catch(() => undefined);
  const app: SharedWorkerApp = {
    runtimeKind: "shared-worker", runtimeId: options.id, runtimeInstanceId,
    ready: () => ready,
    reconcile: () => host?.reconcile() ?? Promise.resolve(),
    state: localSnapshot,
    subscribe(listener) { listeners.add(listener); listener(localSnapshot()); return () => listeners.delete(listener); },
    inspect: () => host ? { ...host.inspect(), peerCount: endpoints.size } : { runtimeId: options.id, runtimeKind: "shared-worker", runtimeInstanceId, version: 0, pluginCount: 0, peerCount: endpoints.size, pendingCallCount: 0, activeStreamCount: 0, plugins: [] },
    activePeers: () => Object.freeze([...endpoints].filter((endpoint) => !endpoint.closed && endpoint.session.state === "active").map((endpoint) => Object.freeze({ event: "active" as const, peerId: endpoint.scope.identity.attributes.peerId as string, binding: Object.freeze({ ...endpoint.binding }), state: "active" as const }))),
    subscribePeerLifecycle(listener) { peerLifecycleListeners.add(listener); for (const endpoint of endpoints) if (!endpoint.closed && endpoint.session.state === "active") listener(Object.freeze({ event: "active" as const, peerId: endpoint.scope.identity.attributes.peerId as string, binding: Object.freeze({ ...endpoint.binding }), state: "active" as const })); return () => peerLifecycleListeners.delete(listener); },
    notifyPeerHandoff(peerId, handoffRevision) {
      const endpoint = [...endpoints].find((candidate) => !candidate.closed && candidate.scope.identity.attributes.peerId === peerId);
      if (!endpoint || endpoint.session.state !== "active") return false;
      emitPeerLifecycle({ event: "handoff", peerId, binding: endpoint.binding, state: "active", ...(handoffRevision !== undefined ? { handoffRevision } : {}) });
      return true;
    },
    dispose(reason = "shared worker runtime disposed") {
      if (disposePromise) return disposePromise;
      accepting = false;
      disposed = true;
      runtimeState = "stopping";
      // Capture before publishing the terminal snapshot: a synchronous
      // postMessage failure during publishAll may itself close an endpoint.
      const endpointsToClose = [...endpoints];
      publishAll();
      // Fence every currently connected endpoint synchronously before the
      // first await. This closes admission and revokes peer capabilities while
      // the Host is still alive, then waits for each bounded close handshake.
      for (const endpoint of endpointsToClose) beginCloseEndpoint(endpoint, reason);
      disposePromise = (async () => {
        const result = await (host ? host.dispose(reason) : Promise.resolve({ scopeId: `runtime:${runtimeInstanceId}`, state: "stopped" as const, attempted: 0, released: 0, pending: [], errors: [], cleanupIncomplete: false }));
        runtimeState = "disposed";
        const terminal = localSnapshot();
        options.snapshotObserver?.(terminal);
        // Endpoint admission is already fenced, but its transport stays alive
        // long enough for every Window to observe the terminal disposed
        // snapshot before the bounded close handshake tears it down.
        for (const endpoint of endpointsToClose) {
          try { publish(endpoint, endpoint.exposures, terminal, true); } catch { /* close path still proceeds */ }
        }
        emit(terminal);
        const endpointClosures = endpointsToClose.map((endpoint) => closeEndpoint(endpoint, reason));
        await Promise.all(endpointClosures);
        return result;
      })();
      return disposePromise;
    },
  };
  return app;
}

/** 生产入口：只从真实 SharedWorkerGlobalScope 获取连接事件。 */
export function startSharedWorkerApp(options: StartSharedWorkerAppOptions): SharedWorkerApp {
  return startSharedWorkerAppInternal(options);
}

/** testing/advanced harness 入口；生产包的 startSharedWorkerApp 不接受 scope 注入。 */
export function startSharedWorkerAppForTesting(options: StartSharedWorkerAppForTestingOptions): SharedWorkerApp {
  const { globalScope, ...runtimeOptions } = options;
  return startSharedWorkerAppInternal(runtimeOptions, globalScope);
}
