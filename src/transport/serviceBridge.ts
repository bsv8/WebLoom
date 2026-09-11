// WebLoom v4 typed capability bridge。
//
// 这里是唯一的远端 call/stream pending 实现。它负责本端的 deadline、代理
// 身份 fence、有限 DTO/transfer 校验以及 stream 的消费状态机；MessagePort
// provider 负责另一侧的 handler 执行状态机。

import type {
  CapabilityBridge,
  CapabilityClient,
  RemoteCapability,
  RpcCapabilityBase,
  RpcCallOptions,
  ServiceReference,
  StreamCapabilityBase,
  StreamSubscribeOptions,
  StreamSubscription,
} from "../contracts/capability.js";
import { WebLoomError, type LifecycleScope, type RuntimeKind, type RuntimeSnapshot, type SnapshotApplyResult } from "../contracts/lifecycle.js";
import {
  assertReceivedPortSet,
  cloneFrozenAttributes,
  createReceivePortLedger,
  createRuntimeBudget,
  DEFAULT_RUNTIME_LIMITS,
  normalizeRuntimeLimits,
  validateDto,
  validateRawDto,
  validateTransferList,
  validateTransferListWithStats,
  type ReceivePortLedger,
  type RuntimeBudget,
  type RuntimeLimitsInput,
} from "./dto.js";
import {
  createRuntimeMessageCodec,
  RUNTIME_CALL_TYPE,
  RUNTIME_CANCEL_TYPE,
  RUNTIME_CREDIT_TYPE,
  RUNTIME_ERROR_MESSAGE_TYPE,
  RUNTIME_ERROR_TYPE,
  RUNTIME_NEXT_TYPE,
  RUNTIME_PROTOCOL_VERSION,
  RUNTIME_RESULT_TYPE,
  RUNTIME_SNAPSHOT_TYPE,
  type RuntimeErrorResponseMessage,
  type RuntimeWireMessage,
} from "../runtime/runtimeProtocol.js";

export interface RuntimeReceiveMetadata {
  /** 本次 MessageEvent 实际携带的业务 MessagePort；仅 transport 本地使用。 */
  readonly ports?: readonly MessagePort[];
  /** 由物理 endpoint transport 创建的一次性接收资源账本。 */
  readonly ledger?: ReceivePortLedger;
  /** 物理 endpoint 已完成一次 codec decode。 */
  readonly decoded?: boolean;
}

export interface RuntimeTransport {
  /** 发送已验证 v4 message；transfer 由契约 extractor 提供。 */
  send(message: RuntimeWireMessage, transfer?: readonly Transferable[]): void;
  /** 订阅接收 message 及本次事件的本地 transfer 元数据。 */
  subscribe(listener: (message: RuntimeWireMessage, metadata?: RuntimeReceiveMetadata) => void): () => void;
  /** 关闭本端传输。 */
  close?(): void;
  /** 物理 endpoint 对 decode/接收账本错误的统一通知。 */
  subscribeError?(listener: (error: unknown, metadata?: RuntimeReceiveMetadata) => void): () => void;
}

export interface CreateCapabilityBridgeOptions {
  /** 底层双向 transport。 */
  readonly transport: RuntimeTransport;
  /** 预期的对端 Runtime 类型。 */
  readonly remoteRuntimeKind?: RuntimeKind;
  /** 预期的对端逻辑 Runtime id。 */
  readonly remoteRuntimeId?: string;
  /** 默认调用预算。 */
  readonly defaultCallTimeoutMs?: number;
  /** 可信 Runtime/advanced 装配提供的预算；只能收紧 v4 默认值。 */
  readonly limits?: RuntimeLimitsInput;
  /** 可选的 Runtime 方向共享计数器。 */
  readonly budget?: RuntimeBudget;
}

interface ProxyRecord {
  readonly capability: RemoteCapability;
  readonly scope?: LifecycleScope;
  readonly cacheKey: string;
  bound?: ServiceReference;
  revoked: boolean;
  reason: string;
}

interface QueueItem {
  readonly value: unknown;
  readonly ledger: ReceivePortLedger;
  readonly budgetBytes: number;
}

interface QuotaReservation {
  readonly payloadBytes: number;
  pendingReserved: boolean;
  streamReserved: boolean;
  payloadReserved: boolean;
}

interface WaitingCallRecord {
  readonly proxy: ProxyRecord;
  readonly prepared: { readonly value: unknown; readonly transfer: readonly Transferable[]; readonly budgetBytes: number };
  readonly reservation: QuotaReservation;
  readonly deadline: number;
  readonly mode: "unary" | "stream";
  fail: (error: unknown) => void;
  start: (reference: ServiceReference, remaining: number) => void;
  finished: boolean;
  timer?: ReturnType<typeof setTimeout>;
  removeListener?: () => void;
}

interface CallbackExecutionRecord {
  readonly stream: PendingStream;
  readonly item: QueueItem;
  released: boolean;
}

interface PendingBase {
  readonly callId: string;
  readonly capability: RemoteCapability;
  readonly reference: ServiceReference;
  readonly proxy: ProxyRecord;
  readonly controller: AbortController;
  readonly cleanup?: () => void;
  readonly reservation: QuotaReservation;
  readonly mode: "unary" | "stream";
  timer?: ReturnType<typeof setTimeout>;
  settled: boolean;
  cancelSent: boolean;
}

interface PendingUnary extends PendingBase {
  readonly mode: "unary";
  resolve(value?: unknown): void;
  reject(error: unknown): void;
}

type StreamState = "opening" | "active" | "draining" | "closed" | "failed";

interface PendingStream extends PendingBase {
  readonly mode: "stream";
  readonly onNext: (value: unknown) => void | Promise<void>;
  readonly itemParser: { parse(value: unknown): unknown };
  readonly window: number;
  readonly resolveReady: () => void;
  readonly rejectReady: (error: unknown) => void;
  readonly resolveClosed: () => void;
  readonly rejectClosed: (error: unknown) => void;
  credit: number;
  sequence: number;
  state: StreamState;
  doneReceived: boolean;
  processing: boolean;
  draining: boolean;
  readySettled: boolean;
  closedSettled: boolean;
  queue: QueueItem[];
  executionWaiterRemove?: () => void;
}

type Pending = PendingUnary | PendingStream;

function id(prefix: string): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return `${prefix}:${crypto.randomUUID()}`;
  } catch { /* fallback */ }
  return `${prefix}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
}

function timeoutMs(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isFinite(result) || result < 1 || result > 300_000) throw new TypeError("timeoutMs must be a finite number from 1 to 300000");
  return result;
}

function mergeSignals(...signals: readonly (AbortSignal | undefined)[]): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const active = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  const listeners = active.map((signal) => {
    const listener = (): void => { try { controller.abort(signal.reason); } catch { controller.abort(); } };
    if (signal.aborted) listener(); else signal.addEventListener("abort", listener, { once: true });
    return { signal, listener };
  });
  return { signal: controller.signal, dispose() { for (const item of listeners) item.signal.removeEventListener("abort", item.listener); } };
}

function frameworkError(
  code: ConstructorParameters<typeof WebLoomError>[0],
  phase: ConstructorParameters<typeof WebLoomError>[2],
  context?: ConstructorParameters<typeof WebLoomError>[3],
): WebLoomError {
  const text: Record<string, string> = {
    protocol_mismatch: "Remote Runtime protocol is not supported",
    capability_unavailable: "Capability is unavailable",
    request_validation_failed: "Capability request failed validation",
    response_validation_failed: "Capability response failed validation",
    request_clone_failed: "Capability request could not be delivered",
    response_clone_failed: "Capability response could not be delivered",
    transfer_invalid: "Capability transfer declaration is invalid",
    handler_failed: "Remote capability operation failed",
    call_timeout: "Capability call timed out; remote side effect is unknown",
    request_cancelled: "Capability call was cancelled",
    service_revoked: "Capability exposure was revoked",
    service_stale: "Capability exposure is stale",
    transport_unavailable: "Runtime transport is unavailable",
    stream_overflow: "Stream credit or sequence is invalid",
    resource_limit_exceeded: "Runtime resource limit exceeded",
    invalid_snapshot: "Invalid Runtime snapshot",
    invalid_message: "Invalid WebLoom runtime message",
  };
  return new WebLoomError(code, text[String(code)] ?? "WebLoom operation failed", phase, context);
}

function errorFromWire(message: RuntimeErrorResponseMessage): WebLoomError {
  return frameworkError(message.error.code, message.error.phase, { serviceInstanceId: message.serviceInstanceId });
}

function validCredit(value: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= maximum;
}

function serviceMatches(reference: ServiceReference, capability: RemoteCapability): boolean {
  return reference.kind === capability.kind && reference.capabilityId === capability.id && reference.contractVersion === capability.version;
}

function serviceKey(service: Pick<ServiceReference, "kind" | "capabilityId" | "contractVersion">): string {
  return `${service.kind}\u0000${service.capabilityId}\u0000${service.contractVersion}`;
}

function contextFor(capability: RemoteCapability, reference?: ServiceReference): ConstructorParameters<typeof WebLoomError>[3] {
  return { capabilityId: capability.id, ...(reference ? { serviceInstanceId: reference.serviceInstanceId } : {}) };
}

/** 创建按 peer 绑定、可撤销且支持 typed stream 的 bridge。 */
export function createCapabilityBridge(options: CreateCapabilityBridgeOptions): CapabilityBridge & {
  readonly pendingCallCount: number;
  readonly activeStreamCount: number;
  readonly retainedPayloadBytes: number;
} {
  const codec = createRuntimeMessageCodec();
  const limits = normalizeRuntimeLimits(options.limits);
  const budget = options.budget ?? createRuntimeBudget(limits);
  const listeners = new Set<() => void>();
  const pending = new Map<string, Pending>();
  const streams = new Map<string, PendingStream>();
  const waitingCalls = new Set<WaitingCallRecord>();
  const callbackExecutions = new Set<CallbackExecutionRecord>();
  const proxies = new Map<string, ProxyRecord>();
  const clients = new Map<string, CapabilityClient<RemoteCapability>>();
  let pendingCount = 0;
  let peerRetainedPayloadBytes = 0;
  let currentState: CapabilityBridge["state"] = "empty";
  let terminalFailure: WebLoomError | undefined;
  let remoteRuntimeId: string | undefined;
  let remoteRuntimeKind: RuntimeKind | undefined;
  let remoteRuntimeInstanceId: string | undefined;
  let revision = -1;
  let appliedSnapshotFingerprint: string | undefined;
  let currentServices: readonly ServiceReference[] = [];
  let disposed = false;
  let reservedStreamCount = 0;
  const defaultTimeout = timeoutMs(options.defaultCallTimeoutMs, 30_000);

  const emit = (): void => {
    for (const listener of [...listeners]) { try { listener(); } catch { /* observer isolation */ } }
  };

  const reserve = (payloadBytes: number, stream: boolean): QuotaReservation | WebLoomError => {
    if (pendingCount >= limits.maxPendingCallsPerPeer || budget.pendingCalls >= limits.maxPendingCallsPerRuntime) return frameworkError("resource_limit_exceeded", "dispatch");
    if (stream && (reservedStreamCount >= limits.maxActiveStreamsPerPeer || budget.activeStreams >= limits.maxActiveStreamsPerRuntime)) return frameworkError("resource_limit_exceeded", "dispatch");
    if (payloadBytes > limits.maxMessageBudgetBytes
      || peerRetainedPayloadBytes > limits.maxRetainedPayloadBytesPerPeer - payloadBytes
      || budget.retainedPayloadBytes > limits.maxRetainedPayloadBytesPerRuntime - payloadBytes) return frameworkError("resource_limit_exceeded", "dispatch");
    budget.pendingCalls += 1;
    if (stream) budget.activeStreams += 1;
    peerRetainedPayloadBytes += payloadBytes;
    budget.retainedPayloadBytes += payloadBytes;
    pendingCount += 1;
    if (stream) reservedStreamCount += 1;
    return { payloadBytes, pendingReserved: true, streamReserved: stream, payloadReserved: true };
  };

  const releasePendingReservation = (reservation: QuotaReservation): void => {
    if (!reservation.pendingReserved) return;
    reservation.pendingReserved = false;
    pendingCount = Math.max(0, pendingCount - 1);
    budget.pendingCalls = Math.max(0, budget.pendingCalls - 1);
  };

  const releaseStreamReservation = (reservation: QuotaReservation): void => {
    if (!reservation.streamReserved) return;
    reservation.streamReserved = false;
    reservedStreamCount = Math.max(0, reservedStreamCount - 1);
    budget.activeStreams = Math.max(0, budget.activeStreams - 1);
  };

  const releasePayloadReservation = (reservation: QuotaReservation): void => {
    if (!reservation.payloadReserved) return;
    reservation.payloadReserved = false;
    peerRetainedPayloadBytes = Math.max(0, peerRetainedPayloadBytes - reservation.payloadBytes);
    budget.retainedPayloadBytes = Math.max(0, budget.retainedPayloadBytes - reservation.payloadBytes);
  };

  const releaseReservation = (reservation: QuotaReservation): void => {
    releasePendingReservation(reservation);
    releaseStreamReservation(reservation);
    releasePayloadReservation(reservation);
  };

  const releaseCallbackExecution = (record: CallbackExecutionRecord): void => {
    if (record.released) return;
    record.released = true;
    callbackExecutions.delete(record);
    peerRetainedPayloadBytes = Math.max(0, peerRetainedPayloadBytes - record.item.budgetBytes);
    budget.retainedPayloadBytes = Math.max(0, budget.retainedPayloadBytes - record.item.budgetBytes);
    budget.releaseExecutionSlot();
    emit();
  };

  const releaseQueueItem = (item: QueueItem): void => {
    item.ledger.closeUndelivered();
    peerRetainedPayloadBytes = Math.max(0, peerRetainedPayloadBytes - item.budgetBytes);
    budget.retainedPayloadBytes = Math.max(0, budget.retainedPayloadBytes - item.budgetBytes);
  };

  const settleUnary = (entry: PendingUnary, error?: unknown, value?: unknown): void => {
    if (entry.settled) return;
    entry.settled = true;
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    pending.delete(entry.callId);
    releaseReservation(entry.reservation);
    entry.cleanup?.();
    if (error !== undefined) entry.reject(error); else entry.resolve(value);
    emit();
  };

  const sendCancel = (entry: PendingBase): void => {
    if (entry.cancelSent) return;
    entry.cancelSent = true;
    try {
      options.transport.send({ type: RUNTIME_CANCEL_TYPE, protocolVersion: RUNTIME_PROTOCOL_VERSION, callId: entry.callId, serviceInstanceId: entry.reference.serviceInstanceId });
    } catch { /* connection is already unavailable */ }
    try { entry.controller.abort(); } catch { /* noop */ }
  };

  const settleReadyReject = (stream: PendingStream, error: unknown): void => {
    if (stream.readySettled) return;
    stream.readySettled = true;
    stream.rejectReady(error);
  };

  const settleClosedReject = (stream: PendingStream, error: unknown): void => {
    if (stream.closedSettled) return;
    stream.closedSettled = true;
    stream.rejectClosed(error);
  };

  const settleClosedResolve = (stream: PendingStream): void => {
    if (stream.closedSettled) return;
    stream.closedSettled = true;
    stream.resolveClosed();
  };

  const forgetStream = (stream: PendingStream): void => {
    if (!stream.closedSettled || stream.processing || stream.queue.length > 0) return;
    streams.delete(stream.callId);
  };

  const finishDraining = (stream: PendingStream): void => {
    if (!stream.doneReceived || stream.processing || stream.queue.length > 0 || stream.closedSettled) return;
    stream.state = "closed";
    settleClosedResolve(stream);
    forgetStream(stream);
    emit();
  };

  const terminateStream = (stream: PendingStream, error: WebLoomError, notifyRemote: boolean): void => {
    if (stream.state === "closed" || stream.state === "failed") return;
    stream.state = "failed";
    if (stream.timer !== undefined) clearTimeout(stream.timer);
    pending.delete(stream.callId);
    stream.executionWaiterRemove?.();
    stream.executionWaiterRemove = undefined;
    releaseReservation(stream.reservation);
    // Even when the remote cancel cannot be sent (for example after a
    // transport error), the local handler-facing signal must be fenced.
    try { stream.controller.abort(error); } catch { /* already aborted */ }
    for (const item of stream.queue.splice(0)) releaseQueueItem(item);
    if (!stream.readySettled) settleReadyReject(stream, error);
    settleClosedReject(stream, error);
    stream.cleanup?.();
    if (notifyRemote) sendCancel(stream);
    forgetStream(stream);
    emit();
  };

  const errorWithTerminalCause = (cause: WebLoomError, capability: RemoteCapability, reference?: ServiceReference): WebLoomError => (
    new WebLoomError(cause.code, cause.message, cause.phase, { ...cause.context, ...contextFor(capability, reference) }, cause.details)
  );

  const revokeProxy = (proxy: ProxyRecord, reason: string, terminalCause?: WebLoomError): void => {
    if (proxy.revoked) return;
    proxy.revoked = true;
    proxy.reason = reason;
    if (proxies.get(proxy.cacheKey) === proxy) clients.delete(proxy.cacheKey);
    const affected = new Set<Pending>();
    for (const entry of pending.values()) if (entry.proxy === proxy) affected.add(entry);
    for (const entry of streams.values()) if (entry.proxy === proxy) affected.add(entry);
    for (const entry of affected) {
      if (entry.proxy !== proxy) continue;
      const error = terminalCause
        ? errorWithTerminalCause(terminalCause, entry.capability, entry.reference)
        : frameworkError("service_revoked", "dispose", contextFor(entry.capability, entry.reference));
      if (entry.mode === "stream") terminateStream(entry as PendingStream, error, true);
      else {
        settleUnary(entry as PendingUnary, error);
        sendCancel(entry);
      }
    }
    for (const record of [...waitingCalls]) {
      if (record.proxy === proxy) record.fail(terminalCause
        ? errorWithTerminalCause(terminalCause, record.proxy.capability, record.proxy.bound)
        : frameworkError("service_revoked", "dispose", contextFor(record.proxy.capability, record.proxy.bound)));
    }
  };

  const findService = (capability: RemoteCapability): ServiceReference | undefined => currentServices.find((service) => serviceMatches(service, capability));

  const terminalError = (proxy: ProxyRecord, capability: RemoteCapability): WebLoomError | undefined => {
    if (terminalFailure && !disposed) return frameworkError(terminalFailure.code, terminalFailure.phase, contextFor(capability, proxy.bound));
    if (disposed || proxy.revoked) return frameworkError("service_revoked", "dispatch", contextFor(capability, proxy.bound));
    if (currentState === "stale" || currentState === "disposed") return frameworkError("service_revoked", "dispatch", contextFor(capability, proxy.bound));
    if (proxy.bound && !currentServices.some((service) => serviceKey(service) === serviceKey(proxy.bound as ServiceReference) && service.serviceInstanceId === proxy.bound?.serviceInstanceId)) {
      return frameworkError("service_stale", "dispatch", contextFor(capability, proxy.bound));
    }
    // Before the first ready snapshot a lazy proxy must remain waitable. Once
    // the peer has published a ready projection, however, an unbound
    // capability absent from that projection is not a timeout oracle: callers
    // must observe the same redacted unavailable result as a peer allowlist
    // denial. A proxy bound to a previously visible exposure still gets the
    // more specific stale result above.
    if (currentState === "ready" && !proxy.bound && !findService(capability)) {
      return frameworkError("capability_unavailable", "wait", contextFor(capability));
    }
    return undefined;
  };

  const prepareRequest = (capability: RemoteCapability, request: unknown): { value: unknown; transfer: readonly Transferable[]; budgetBytes: number } => {
    validateRawDto(request, limits, "validate");
    const parser = capability as RemoteCapability & { request: { parse(value: unknown): unknown } };
    let parsed: unknown;
    try { parsed = parser.request.parse(request); } catch { throw frameworkError("request_validation_failed", "validate", contextFor(capability)); }
    let validation: ReturnType<typeof validateTransferListWithStats>;
    try {
      const descriptor = (capability as RemoteCapability & { transfer?: { request?: (value: unknown) => readonly Transferable[] } }).transfer;
      validation = validateTransferListWithStats(parsed, descriptor?.request?.(parsed), { limits, phase: "validate" });
    } catch (error) {
      if (error instanceof WebLoomError) throw error;
      throw frameworkError("transfer_invalid", "validate", contextFor(capability));
    }
    return { value: parsed, transfer: validation.transfer, budgetBytes: validation.stats.budgetBytes };
  };

  const prepareIncoming = (capability: RemoteCapability, value: unknown, direction: "response" | "item", ledger: ReceivePortLedger): { value: unknown; transfer: readonly Transferable[]; stats: ReturnType<typeof validateDto> } => {
    try { validateRawDto(value, limits, "receive"); } catch (error) { ledger.closeUndelivered(); throw error; }
    const parser = capability as RemoteCapability & { response?: { parse(value: unknown): unknown }; item?: { parse(value: unknown): unknown }; transfer?: { response?: (value: unknown) => readonly Transferable[]; item?: (value: unknown) => readonly Transferable[] } };
    let parsed: unknown;
    try {
      const selected = direction === "response" ? parser.response : parser.item;
      if (!selected) throw new Error("parser unavailable");
      parsed = selected.parse(value);
    } catch { ledger.closeUndelivered(); throw frameworkError("response_validation_failed", "receive", contextFor(capability)); }
    let validation: ReturnType<typeof validateTransferListWithStats>;
    try { validation = validateTransferListWithStats(parsed, parser.transfer?.[direction]?.(parsed), { limits, phase: "receive" }); }
    catch (error) { ledger.closeUndelivered(); throw error instanceof WebLoomError ? error : frameworkError("transfer_invalid", "receive", contextFor(capability)); }
    try { assertReceivedPortSet(ledger, validation.transfer, { limits, phase: "receive" }); }
    catch (error) { ledger.closeUndelivered(); throw error; }
    return { value: parsed, transfer: validation.transfer, stats: validation.stats };
  };

  const sendWire = (message: RuntimeWireMessage, transfer: readonly Transferable[] = []): void => {
    const encoded = codec.encode(message);
    options.transport.send(encoded, transfer);
  };

  const startUnary = (proxy: ProxyRecord, prepared: { value: unknown; transfer: readonly Transferable[]; budgetBytes: number }, reference: ServiceReference, callOptions: RpcCallOptions, timeout: number, existingReservation?: QuotaReservation): Promise<unknown> => {
    const reservation = existingReservation ?? reserve(prepared.budgetBytes, false);
    if (reservation instanceof WebLoomError) return Promise.reject(reservation);
    const controller = new AbortController();
    const merged = mergeSignals(controller.signal, proxy.scope?.signal, callOptions.signal);
    const callId = id("call");
    return new Promise<unknown>((resolve, reject) => {
      const entry: PendingUnary = { callId, capability: proxy.capability, reference, proxy, controller, cleanup: merged.dispose, reservation, timer: undefined, settled: false, cancelSent: false, mode: "unary", resolve, reject };
      pending.set(callId, entry);
      const onAbort = (): void => {
        if (entry.settled) return;
        settleUnary(entry, frameworkError("request_cancelled", "dispose", contextFor(entry.capability, reference)));
        sendCancel(entry);
      };
      merged.signal.addEventListener("abort", onAbort, { once: true });
      entry.timer = setTimeout(() => {
        if (entry.settled) return;
        settleUnary(entry, frameworkError("call_timeout", "receive", contextFor(entry.capability, reference)));
        sendCancel(entry);
      }, timeout);
      if (merged.signal.aborted) { onAbort(); return; }
      try {
        sendWire({ type: RUNTIME_CALL_TYPE, protocolVersion: RUNTIME_PROTOCOL_VERSION, callId, capabilityId: entry.capability.id, contractVersion: entry.capability.version, serviceInstanceId: reference.serviceInstanceId, mode: "unary", timeoutMs: timeout, request: prepared.value, ...(callOptions.operationId !== undefined ? { operationId: callOptions.operationId } : {}) }, prepared.transfer);
      } catch {
        settleUnary(entry, frameworkError("request_clone_failed", "dispatch", contextFor(entry.capability, reference)));
      }
    });
  };

  const waitForService = (proxy: ProxyRecord, prepared: { value: unknown; transfer: readonly Transferable[]; budgetBytes: number }, callOptions: RpcCallOptions): Promise<unknown> => {
    const timeout = timeoutMs(callOptions.timeoutMs, defaultTimeout);
    const deadline = Date.now() + timeout;
    const reserved = reserve(prepared.budgetBytes, false);
    if (reserved instanceof WebLoomError) return Promise.reject(reserved);
    return new Promise<unknown>((resolve, reject) => {
      const record: WaitingCallRecord = {
        proxy,
        prepared,
        reservation: reserved,
        deadline,
        mode: "unary",
        finished: false,
        fail: () => undefined,
        start: () => undefined,
      };
      const cleanup = (): void => { if (record.timer !== undefined) clearTimeout(record.timer); record.removeListener?.(); callOptions.signal?.removeEventListener("abort", onAbort); waitingCalls.delete(record); };
      record.fail = (error: unknown): void => {
        if (record.finished) return;
        record.finished = true;
        cleanup();
        releaseReservation(record.reservation);
        reject(error);
      };
      record.start = (reference: ServiceReference, remaining: number): void => {
        if (record.finished) return;
        record.finished = true;
        cleanup();
        if (!proxy.bound) proxy.bound = reference;
        void startUnary(proxy, prepared, reference, callOptions, remaining, record.reservation).then(resolve, reject);
      };
      const check = (): void => {
        if (record.finished) return;
        const unavailable = terminalError(proxy, proxy.capability);
        if (unavailable) { record.fail(unavailable); return; }
        const reference = proxy.bound ?? findService(proxy.capability);
        if (!reference) return;
        const remaining = deadline - Date.now();
        if (remaining <= 0) { record.fail(frameworkError("call_timeout", "wait", contextFor(proxy.capability))); return; }
        record.start(reference, remaining);
      };
      const onAbort = (): void => record.fail(frameworkError("request_cancelled", "dispose", contextFor(proxy.capability)));
      record.timer = setTimeout(() => record.fail(frameworkError("call_timeout", "wait", contextFor(proxy.capability))), timeout);
      if (callOptions.signal) {
        if (callOptions.signal.aborted) { onAbort(); return; }
        callOptions.signal.addEventListener("abort", onAbort, { once: true });
      }
      listeners.add(check);
      record.removeListener = () => listeners.delete(check);
      waitingCalls.add(record);
      check();
    });
  };

  const call = (proxy: ProxyRecord, request: unknown, callOptions: RpcCallOptions): Promise<unknown> => {
    const unavailable = terminalError(proxy, proxy.capability);
    if (unavailable) return Promise.reject(unavailable);
    const timeout = timeoutMs(callOptions.timeoutMs, defaultTimeout);
    let prepared: { value: unknown; transfer: readonly Transferable[]; budgetBytes: number };
    try { prepared = prepareRequest(proxy.capability, request); }
    catch (error) { return Promise.reject(error instanceof WebLoomError ? error : frameworkError("request_validation_failed", "validate", contextFor(proxy.capability))); }
    const reference = proxy.bound ?? findService(proxy.capability);
    if (!reference) return waitForService(proxy, prepared, callOptions);
    if (!proxy.bound) proxy.bound = reference;
    return startUnary(proxy, prepared, reference, callOptions, timeout);
  };

  const createRejectedSubscription = (error: WebLoomError): StreamSubscription<unknown> => {
    let readyReject!: (reason: unknown) => void;
    let closedReject!: (reason: unknown) => void;
    const ready = new Promise<void>((_, reject) => { readyReject = reject; });
    const closed = new Promise<void>((_, reject) => { closedReject = reject; });
    void ready.catch(() => undefined);
    void closed.catch(() => undefined);
    readyReject(error);
    closedReject(error);
    return { ready, closed, cancel() { /* terminal */ } };
  };

  const startStream = (proxy: ProxyRecord, prepared: { value: unknown; transfer: readonly Transferable[]; budgetBytes: number }, reference: ServiceReference, optionsForSubscribe: StreamSubscribeOptions<unknown>, timeout: number, existingReservation?: QuotaReservation): StreamSubscription<unknown> => {
    const maximumCredit = Math.min(256, limits.maxStreamCredit);
    const window = optionsForSubscribe.initialCredit ?? 16;
    if (!validCredit(window, maximumCredit)) {
      if (existingReservation) releaseReservation(existingReservation);
      return createRejectedSubscription(frameworkError("stream_overflow", "validate", contextFor(proxy.capability, reference)));
    }
    const reservation = existingReservation ?? reserve(prepared.budgetBytes, true);
    if (reservation instanceof WebLoomError) return createRejectedSubscription(reservation);
    let resolveReady!: () => void;
    let rejectReady!: (error: unknown) => void;
    let resolveClosed!: () => void;
    let rejectClosed!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const closed = new Promise<void>((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject; });
    void ready.catch(() => undefined);
    void closed.catch(() => undefined);
    const controller = new AbortController();
    const merged = mergeSignals(controller.signal, proxy.scope?.signal, optionsForSubscribe.signal);
    const callId = id("stream");
    const entry: PendingStream = {
      callId, capability: proxy.capability, reference, proxy, controller, cleanup: merged.dispose, reservation, timer: undefined, settled: false, cancelSent: false,
      mode: "stream", onNext: optionsForSubscribe.onNext, itemParser: (proxy.capability as StreamCapabilityBase & { item: { parse(value: unknown): unknown } }).item,
      window, credit: window, sequence: 1, state: "opening", doneReceived: false, processing: false, draining: false, readySettled: false, closedSettled: false, queue: [],
      resolveReady, rejectReady, resolveClosed, rejectClosed,
    };
    streams.set(callId, entry);
    pending.set(callId, entry);
    const cancel = (): void => {
      if (entry.state === "closed" || entry.state === "failed") return;
      terminateStream(entry, frameworkError("request_cancelled", "dispose", contextFor(entry.capability, reference)), true);
    };
    merged.signal.addEventListener("abort", cancel, { once: true });
    entry.timer = setTimeout(() => {
      if (entry.state !== "opening") return;
      terminateStream(entry, frameworkError("call_timeout", "wait", contextFor(entry.capability, reference)), true);
    }, timeout);
    if (merged.signal.aborted) { cancel(); return { ready, closed, cancel }; }
    try {
      sendWire({ type: RUNTIME_CALL_TYPE, protocolVersion: RUNTIME_PROTOCOL_VERSION, callId, capabilityId: entry.capability.id, contractVersion: entry.capability.version, serviceInstanceId: reference.serviceInstanceId, mode: "stream", timeoutMs: timeout, request: prepared.value, initialCredit: window, ...(optionsForSubscribe.operationId !== undefined ? { operationId: optionsForSubscribe.operationId } : {}) }, prepared.transfer);
    } catch {
      terminateStream(entry, frameworkError("request_clone_failed", "dispatch", contextFor(entry.capability, reference)), false);
    }
    return { ready, closed, cancel };
  };

  const waitForStream = (proxy: ProxyRecord, prepared: { value: unknown; transfer: readonly Transferable[]; budgetBytes: number }, optionsForSubscribe: StreamSubscribeOptions<unknown>): StreamSubscription<unknown> => {
    const timeout = timeoutMs(optionsForSubscribe.timeoutMs, defaultTimeout);
    const deadline = Date.now() + timeout;
    const reserved = reserve(prepared.budgetBytes, true);
    if (reserved instanceof WebLoomError) return createRejectedSubscription(reserved);
    let resolveReady!: () => void;
    let rejectReady!: (error: unknown) => void;
    let resolveClosed!: () => void;
    let rejectClosed!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const closed = new Promise<void>((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject; });
    void ready.catch(() => undefined);
    void closed.catch(() => undefined);
    let active: StreamSubscription<unknown> | undefined;
    const record: WaitingCallRecord = {
      proxy,
      prepared,
      reservation: reserved,
      deadline,
      mode: "stream",
      finished: false,
      fail: () => undefined,
      start: () => undefined,
    };
    const cleanup = (): void => { if (record.timer !== undefined) clearTimeout(record.timer); record.removeListener?.(); optionsForSubscribe.signal?.removeEventListener("abort", onAbort); waitingCalls.delete(record); };
    record.fail = (error: unknown): void => { if (record.finished) return; record.finished = true; cleanup(); releaseReservation(record.reservation); rejectReady(error); rejectClosed(error); };
    record.start = (reference: ServiceReference, remaining: number): void => {
      if (record.finished) return;
      record.finished = true;
      cleanup();
      if (!proxy.bound) proxy.bound = reference;
      active = startStream(proxy, prepared, reference, optionsForSubscribe, remaining, record.reservation);
      active.ready.then(resolveReady, rejectReady);
      active.closed.then(resolveClosed, rejectClosed);
    };
    const onAbort = (): void => record.fail(frameworkError("request_cancelled", "dispose", contextFor(proxy.capability)));
    const check = (): void => {
      if (record.finished) return;
      const unavailable = terminalError(proxy, proxy.capability);
      if (unavailable) { record.fail(unavailable); return; }
      const reference = proxy.bound ?? findService(proxy.capability);
      if (!reference) return;
      const remaining = deadline - Date.now();
      if (remaining <= 0) { record.fail(frameworkError("call_timeout", "wait", contextFor(proxy.capability))); return; }
      record.start(reference, remaining);
    };
    record.timer = setTimeout(() => record.fail(frameworkError("call_timeout", "wait", contextFor(proxy.capability))), timeout);
    if (optionsForSubscribe.signal) {
      if (optionsForSubscribe.signal.aborted) { onAbort(); return { ready, closed, cancel() { /* terminal */ } }; }
      optionsForSubscribe.signal.addEventListener("abort", onAbort, { once: true });
    }
    listeners.add(check);
    record.removeListener = () => listeners.delete(check);
    waitingCalls.add(record);
    check();
    return { ready, closed, cancel(reason = "stream cancelled") { void reason; if (active) active.cancel(reason); else record.fail(frameworkError("request_cancelled", "dispose", contextFor(proxy.capability))); } };
  };

  const subscribe = (proxy: ProxyRecord, request: unknown, optionsForSubscribe: StreamSubscribeOptions<unknown>): StreamSubscription<unknown> => {
    const unavailable = terminalError(proxy, proxy.capability);
    if (unavailable) return createRejectedSubscription(unavailable);
    if (typeof optionsForSubscribe.onNext !== "function") return createRejectedSubscription(frameworkError("request_validation_failed", "validate", contextFor(proxy.capability)));
    let prepared: { value: unknown; transfer: readonly Transferable[]; budgetBytes: number };
    try { prepared = prepareRequest(proxy.capability, request); }
    catch (error) { return createRejectedSubscription(error instanceof WebLoomError ? error : frameworkError("request_validation_failed", "validate", contextFor(proxy.capability))); }
    const reference = proxy.bound ?? findService(proxy.capability);
    if (!reference) return waitForStream(proxy, prepared, optionsForSubscribe);
    if (!proxy.bound) proxy.bound = reference;
    return startStream(proxy, prepared, reference, optionsForSubscribe, timeoutMs(optionsForSubscribe.timeoutMs, defaultTimeout));
  };

  let drainStream: (stream: PendingStream) => void;
  const waitForExecutionSlot = (stream: PendingStream): void => {
    if (stream.executionWaiterRemove || stream.state === "failed" || stream.state === "closed" || stream.queue.length === 0) return;
    stream.executionWaiterRemove = budget.registerExecutionWaiter(() => {
      stream.executionWaiterRemove = undefined;
      drainStream(stream);
    });
  };
  drainStream = (stream: PendingStream): void => {
    if (stream.draining) return;
    stream.draining = true;
    void (async () => {
      try {
        while (stream.queue.length > 0) {
          if (stream.state === "failed" || stream.state === "closed") break;
          const item = stream.queue.shift();
          if (!item) break;
          if (callbackExecutions.size >= limits.maxExecutionSlotsPerPeer || budget.executionSlots >= limits.maxExecutionSlotsPerRuntime) {
            stream.queue.unshift(item);
            waitForExecutionSlot(stream);
            break;
          }
          stream.executionWaiterRemove?.();
          stream.executionWaiterRemove = undefined;
          const execution: CallbackExecutionRecord = { stream, item, released: false };
          callbackExecutions.add(execution);
          budget.executionSlots += 1;
          stream.processing = true;
          try {
            // MessagePort resources become handler-owned immediately before
            // invoking user code. The byte reservation remains attached to the
            // execution record until that callback settles.
            item.ledger.handoff();
            await stream.onNext(item.value);
            if (stream.state === "active" && !stream.doneReceived) {
              stream.credit += 1;
              try { sendWire({ type: RUNTIME_CREDIT_TYPE, protocolVersion: RUNTIME_PROTOCOL_VERSION, callId: stream.callId, serviceInstanceId: stream.reference.serviceInstanceId, count: 1 }); }
              catch { terminateStream(stream, frameworkError("transport_unavailable", "dispatch", contextFor(stream.capability, stream.reference)), true); break; }
            }
          } catch {
            terminateStream(stream, frameworkError("handler_failed", "execute", contextFor(stream.capability, stream.reference)), true);
            break;
          } finally {
            stream.processing = false;
            releaseCallbackExecution(execution);
          }
        }
      } finally {
        stream.processing = false;
        stream.draining = false;
        if (stream.queue.length === 0 || stream.state === "failed" || stream.state === "closed") {
          stream.executionWaiterRemove?.();
          stream.executionWaiterRemove = undefined;
        } else {
          // The loop can stop with an item retained because the shared budget
          // is full. Keep that FIFO waiter registered after this drain task
          // yields; otherwise no later slot release would revisit this stream.
          waitForExecutionSlot(stream);
        }
        finishDraining(stream);
        forgetStream(stream);
      }
    })().catch(() => {
      terminateStream(stream, frameworkError("handler_failed", "execute", contextFor(stream.capability, stream.reference)), true);
    });
  };

  const invalidate = (reason = "remote service directory replaced", terminalCause?: WebLoomError): void => {
    // A terminal protocol/transport failure is the cause observed by every
    // affected request. Settle it before revoking proxies, otherwise the proxy
    // fence would replace the useful protocol error with service_revoked.
    if (terminalCause) {
      for (const record of [...waitingCalls]) record.fail(errorWithTerminalCause(terminalCause, record.proxy.capability, record.proxy.bound));
      for (const entry of [...pending.values()]) {
        const error = errorWithTerminalCause(terminalCause, entry.capability, entry.reference);
        if (entry.mode === "stream") terminateStream(entry, error, true);
        else settleUnary(entry, error);
      }
    }
    for (const proxy of proxies.values()) revokeProxy(proxy, reason, terminalCause);
    if (!terminalCause) for (const record of [...waitingCalls]) record.fail(frameworkError("service_stale", "dispose", contextFor(record.proxy.capability, record.proxy.bound)));
    clients.clear();
    if (!terminalCause) for (const entry of [...pending.values()]) {
      if (entry.mode === "stream") terminateStream(entry, frameworkError("service_stale", "dispose", contextFor(entry.capability, entry.reference)), true);
      else settleUnary(entry, frameworkError("service_stale", "dispose", contextFor(entry.capability, entry.reference)));
    }
    currentServices = [];
    currentState = disposed ? "disposed" : "stale";
    emit();
  };

  const failClose = (reason: string, code: "protocol_mismatch" | "invalid_snapshot" | "invalid_message" | "transfer_invalid" = "invalid_message"): void => {
    if (disposed) return;
    terminalFailure = frameworkError(code, "receive");
    invalidate(reason, terminalFailure);
    try { options.transport.close?.(); } catch { /* best effort */ }
  };

  const onMessage = (message: RuntimeWireMessage, metadata?: RuntimeReceiveMetadata): void => {
    const ledger = metadata?.ledger ?? createReceivePortLedger(metadata?.ports, { limits, phase: "receive" });
    if (!ledger.valid) {
      failClose("Invalid received transfer metadata", "transfer_invalid");
      return;
    }
    try {
      if (!metadata?.decoded) {
        message = codec.decode(message);
      }
    } catch (error) {
        ledger.closeUndelivered();
        if (error instanceof WebLoomError && error.code === "protocol_mismatch") {
          failClose("Remote Runtime protocol mismatch", "protocol_mismatch");
        } else if (error instanceof WebLoomError && error.code === "invalid_snapshot") {
          failClose("Invalid WebLoom runtime message", "invalid_snapshot");
        } else failClose("Invalid WebLoom runtime message", "invalid_message");
        return;
    }
    try {
      // A Runtime connection has one physical bidirectional port. Incoming
      // call/cancel/credit messages belong to the peer-side Provider listener;
      // this bridge must leave its event.ports ledger untouched so that the
      // Provider can validate and hand off business resources.
      if (message.type === RUNTIME_CALL_TYPE || message.type === RUNTIME_CANCEL_TYPE || message.type === RUNTIME_CREDIT_TYPE) return;
      if (message.type === RUNTIME_SNAPSHOT_TYPE) {
        if (ledger.ports.length > 0) throw frameworkError("transfer_invalid", "receive");
        const result = applySnapshot(message);
        if (!result.accepted && result.reason === "protocol-mismatch") failClose("Remote Runtime protocol mismatch", "protocol_mismatch");
        else if (!result.accepted && result.reason === "invalid-snapshot") failClose("Invalid Runtime snapshot", "invalid_snapshot");
        return;
      }
      if (message.type === RUNTIME_ERROR_TYPE) { ledger.closeUndelivered(); invalidate(message.message); return; }
      if (message.type === RUNTIME_RESULT_TYPE) {
        const entry = pending.get(message.callId);
        if (!entry || entry.reference.serviceInstanceId !== message.serviceInstanceId) { ledger.closeUndelivered(); return; }
        if (entry.mode === "unary") {
          if (!("result" in message)) { ledger.closeUndelivered(); settleUnary(entry, frameworkError("invalid_message", "receive", contextFor(entry.capability, entry.reference))); return; }
          try {
            const incoming = prepareIncoming(entry.capability, message.result, "response", ledger);
            ledger.handoff();
            settleUnary(entry, undefined, incoming.value);
          } catch (error) { settleUnary(entry, error instanceof WebLoomError ? error : frameworkError("response_validation_failed", "receive", contextFor(entry.capability, entry.reference))); }
          return;
        }
        const stream = entry as PendingStream;
        if ("streamReady" in message && message.streamReady) {
          if (stream.state !== "opening") { ledger.closeUndelivered(); terminateStream(stream, frameworkError("invalid_message", "receive", contextFor(stream.capability, stream.reference)), true); return; }
          if (ledger.ports.length > 0) { ledger.closeUndelivered(); terminateStream(stream, frameworkError("transfer_invalid", "receive", contextFor(stream.capability, stream.reference)), true); return; }
          stream.state = "active";
          stream.readySettled = true;
          if (stream.timer !== undefined) clearTimeout(stream.timer);
          releasePendingReservation(stream.reservation);
          stream.resolveReady();
          emit();
          return;
        }
        if ("done" in message && message.done) {
          if (stream.state !== "active" || stream.doneReceived) { ledger.closeUndelivered(); terminateStream(stream, frameworkError("invalid_message", "receive", contextFor(stream.capability, stream.reference)), true); return; }
          if (ledger.ports.length > 0) { ledger.closeUndelivered(); terminateStream(stream, frameworkError("transfer_invalid", "receive", contextFor(stream.capability, stream.reference)), true); return; }
          stream.doneReceived = true;
          stream.state = "draining";
          pending.delete(stream.callId);
          releaseStreamReservation(stream.reservation);
          releasePayloadReservation(stream.reservation);
          stream.cleanup?.();
          finishDraining(stream);
          drainStream(stream);
          emit();
          return;
        }
        ledger.closeUndelivered();
        terminateStream(stream, frameworkError("invalid_message", "receive", contextFor(stream.capability, stream.reference)), true);
        return;
      }
      if (message.type === RUNTIME_ERROR_MESSAGE_TYPE) {
        const entry = pending.get(message.callId);
        if (!entry || entry.reference.serviceInstanceId !== message.serviceInstanceId) { ledger.closeUndelivered(); return; }
        ledger.closeUndelivered();
        const error = errorFromWire(message);
        if (entry.mode === "stream") terminateStream(entry as PendingStream, error, false);
        else settleUnary(entry, error);
        return;
      }
      if (message.type === RUNTIME_NEXT_TYPE) {
        const entry = pending.get(message.callId);
        if (!entry || entry.mode !== "stream" || entry.reference.serviceInstanceId !== message.serviceInstanceId) { ledger.closeUndelivered(); return; }
        const stream = entry as PendingStream;
        if (stream.state !== "active" || stream.doneReceived) { ledger.closeUndelivered(); terminateStream(stream, frameworkError("invalid_message", "receive", contextFor(stream.capability, stream.reference)), true); return; }
        if (stream.credit < 1) { ledger.closeUndelivered(); terminateStream(stream, frameworkError("stream_overflow", "receive", contextFor(stream.capability, stream.reference)), true); return; }
        if (message.sequence !== stream.sequence) { ledger.closeUndelivered(); terminateStream(stream, frameworkError("stream_overflow", "receive", contextFor(stream.capability, stream.reference)), true); return; }
        let incoming: ReturnType<typeof prepareIncoming>;
        try { incoming = prepareIncoming(stream.capability, message.item, "item", ledger); }
        catch (error) { terminateStream(stream, error instanceof WebLoomError ? error : frameworkError("response_validation_failed", "receive", contextFor(stream.capability, stream.reference)), true); return; }
        const { value, stats } = incoming;
        if (peerRetainedPayloadBytes > limits.maxRetainedPayloadBytesPerPeer - stats.budgetBytes
          || budget.retainedPayloadBytes > limits.maxRetainedPayloadBytesPerRuntime - stats.budgetBytes
          || stream.queue.length >= stream.window) { ledger.closeUndelivered(); terminateStream(stream, frameworkError("resource_limit_exceeded", "receive", contextFor(stream.capability, stream.reference)), true); return; }
        stream.credit -= 1;
        stream.sequence += 1;
        stream.queue.push({ value, ledger, budgetBytes: stats.budgetBytes });
        peerRetainedPayloadBytes += stats.budgetBytes;
        budget.retainedPayloadBytes += stats.budgetBytes;
        drainStream(stream);
        return;
      }
      ledger.closeUndelivered();
    } catch (error) {
      ledger.closeUndelivered();
      if (error instanceof WebLoomError && error.code === "protocol_mismatch") failClose("Remote Runtime protocol mismatch", "protocol_mismatch");
      else if (error instanceof WebLoomError && error.code === "invalid_snapshot") failClose("Invalid WebLoom runtime message", "invalid_snapshot");
      else if (error instanceof WebLoomError && error.code === "transfer_invalid") failClose("Invalid WebLoom runtime message", "transfer_invalid");
      else failClose("Invalid WebLoom runtime message", "invalid_message");
    }
  };

  const removeTransport = options.transport.subscribe((message, metadata) => onMessage(message, metadata));
  const removeTransportError = options.transport.subscribeError?.((error, metadata) => {
    metadata?.ledger?.closeUndelivered();
    if (error instanceof WebLoomError && error.code === "protocol_mismatch") failClose("Remote Runtime protocol mismatch", "protocol_mismatch");
    else if (error instanceof WebLoomError && error.code === "transfer_invalid") failClose("Invalid received transfer metadata", "transfer_invalid");
    else failClose("Invalid WebLoom runtime message", "invalid_message");
  });

  function applySnapshot(snapshot: RuntimeSnapshot): SnapshotApplyResult {
    if (disposed) return { accepted: false, reason: "disposed" };
    if (!snapshot || typeof snapshot !== "object") return { accepted: false, reason: "invalid-snapshot" };
    if (snapshot.protocolVersion !== RUNTIME_PROTOCOL_VERSION) return { accepted: false, reason: "protocol-mismatch" };
    try {
      if (snapshot.units.length > limits.maxSnapshotUnits || snapshot.services.length > limits.maxSnapshotServices) return { accepted: false, reason: "invalid-snapshot" };
      codec.encode({ ...snapshot, type: RUNTIME_SNAPSHOT_TYPE });
      validateDto(snapshot, { limits: { maxDepth: limits.maxDtoDepth, maxNodes: limits.maxDtoNodes, maxEdges: limits.maxDtoEdges, maxBudgetBytes: limits.maxMessageBudgetBytes }, phase: "receive" });
    } catch { return { accepted: false, reason: "invalid-snapshot" }; }
    if (options.remoteRuntimeId !== undefined && snapshot.runtimeId !== options.remoteRuntimeId) return { accepted: false, reason: "invalid-snapshot" };
    if (options.remoteRuntimeKind !== undefined && snapshot.runtimeKind !== options.remoteRuntimeKind) return { accepted: false, reason: "invalid-snapshot" };
    if (remoteRuntimeId !== undefined && snapshot.runtimeId !== remoteRuntimeId) return { accepted: false, reason: "invalid-snapshot" };
    if (remoteRuntimeKind !== undefined && snapshot.runtimeKind !== remoteRuntimeKind) return { accepted: false, reason: "invalid-snapshot" };
    let fingerprint: string;
    try { fingerprint = JSON.stringify(snapshot); } catch { return { accepted: false, reason: "invalid-snapshot" }; }
    if (remoteRuntimeInstanceId !== undefined && remoteRuntimeInstanceId === snapshot.runtimeInstanceId && snapshot.revision <= revision) {
      // A transport may have more than one internal observer. Replaying the
      // exact same revision is harmless and lets an observer report the state;
      // a different payload at that revision remains rejected.
      if (snapshot.revision === revision && fingerprint === appliedSnapshotFingerprint) return { accepted: true, state: currentState === "disposed" ? "stale" : currentState, revision };
      return { accepted: false, reason: "stale-revision", receivedRevision: snapshot.revision };
    }
    const services: ServiceReference[] = [];
    const keys = new Set<string>();
    try {
      for (const service of snapshot.state === "ready" ? snapshot.services : []) {
        const key = serviceKey(service);
        if (keys.has(key)) return { accepted: false, reason: "invalid-snapshot" };
        keys.add(key);
        services.push(Object.freeze({ kind: service.kind, capabilityId: service.capabilityId, contractVersion: service.contractVersion, runtime: snapshot.runtimeKind, runtimeInstanceId: snapshot.runtimeInstanceId, serviceInstanceId: service.serviceInstanceId, attributes: cloneFrozenAttributes(service.attributes), ...(service.grantId !== undefined ? { grantId: service.grantId } : {}), ...(service.authorizationRevision !== undefined ? { authorizationRevision: service.authorizationRevision } : {}) }));
      }
    } catch { return { accepted: false, reason: "invalid-snapshot" }; }
    const newRuntime = remoteRuntimeInstanceId !== undefined && remoteRuntimeInstanceId !== snapshot.runtimeInstanceId;
    // Adding a service while a proxy is waiting is not an exposure replacement.
    // Only an existing contract whose serviceInstanceId changes is a fence event;
    // otherwise the first ready snapshot would revoke a proxy created just before
    // the asynchronous directory arrived.
    const replaced = !newRuntime && remoteRuntimeInstanceId === snapshot.runtimeInstanceId
      && currentServices.some((current) => {
        const next = services.find((service) => serviceKey(service) === serviceKey(current));
        return next !== undefined && next.serviceInstanceId !== current.serviceInstanceId;
      });
    if (newRuntime || replaced) invalidate(newRuntime ? "Remote Runtime instance changed" : "Remote Runtime service exposure replaced");
    if (!newRuntime && !replaced) {
      for (const proxy of proxies.values()) {
        if (proxy.bound && !services.some((service) => serviceKey(service) === serviceKey(proxy.bound as ServiceReference) && service.serviceInstanceId === proxy.bound?.serviceInstanceId)) {
          revokeProxy(proxy, "Remote Runtime service exposure was removed");
        }
      }
    }
    remoteRuntimeId = snapshot.runtimeId;
    remoteRuntimeKind = snapshot.runtimeKind;
    remoteRuntimeInstanceId = snapshot.runtimeInstanceId;
    revision = snapshot.revision;
    appliedSnapshotFingerprint = fingerprint;
    currentServices = Object.freeze(services);
    currentState = snapshot.state === "ready" ? "ready" : snapshot.state === "starting" ? "empty" : snapshot.state === "disposed" ? "disposed" : "stale";
    if (currentState !== "ready" && snapshot.state !== "starting") for (const proxy of proxies.values()) revokeProxy(proxy, `Remote Runtime is ${snapshot.state}`);
    emit();
    return { accepted: true, state: currentState === "disposed" ? "stale" : currentState, revision };
  }

  const bridge: CapabilityBridge & { readonly pendingCallCount: number; readonly activeStreamCount: number; readonly retainedPayloadBytes: number } = {
    get state() { return currentState; },
    get runtimeInstanceId() { return remoteRuntimeInstanceId; },
    get runtimeKind() { return remoteRuntimeKind; },
    getClient<C extends RemoteCapability>(capability: C, scope?: LifecycleScope): CapabilityClient<C> {
      const key = `${capability.kind}\u0000${capability.id}\u0000${capability.version}\u0000${scope?.identity.scopeId ?? "root"}`;
      let proxy = proxies.get(key);
      if (!proxy || proxy.revoked) {
        proxy = { capability, scope, cacheKey: key, revoked: false, reason: "Capability proxy is revoked" };
        proxies.set(key, proxy);
        scope?.onRevoke((reason) => revokeProxy(proxy as ProxyRecord, reason));
      }
      const cached = clients.get(key);
      if (cached && !proxy.revoked) return cached as CapabilityClient<C>;
      const client = capability.kind === "rpc"
        ? { call: (request: unknown, optionsForCall?: RpcCallOptions) => call(proxy as ProxyRecord, request, optionsForCall ?? {}) }
        : { subscribe: (request: unknown, optionsForSubscribe: StreamSubscribeOptions<unknown>) => subscribe(proxy as ProxyRecord, request, optionsForSubscribe) };
      clients.set(key, client as unknown as CapabilityClient<RemoteCapability>);
      return client as unknown as CapabilityClient<C>;
    },
    applySnapshot,
    invalidate,
    disconnect(reason = "Runtime disconnected") { invalidate(reason); currentState = "stale"; },
    dispose(reason = "Runtime bridge disposed") { if (disposed) return; disposed = true; invalidate(reason); removeTransport(); removeTransportError?.(); options.transport.close?.(); currentState = "disposed"; emit(); },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    services() { return currentServices; },
    get pendingCallCount() { return pendingCount; },
    get activeStreamCount() { return [...streams.values()].filter((entry) => entry.state === "opening" || entry.state === "active").length; },
    get retainedPayloadBytes() { return budget.retainedPayloadBytes; },
  };
  return bridge;
}

/** 内部 typed transfer 校验 helper；不接受 call 级临时 transfer 数组。 */
export function validateTransferables(value: unknown, transfer: readonly Transferable[] | undefined, limits?: RuntimeLimitsInput): readonly Transferable[] {
  return validateTransferList(value, transfer, { limits: limits ?? DEFAULT_RUNTIME_LIMITS, phase: "validate" });
}
