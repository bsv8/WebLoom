// v4 MessagePort provider：同一物理端口上的反向 call/stream 分派。

import type { CapabilityPeer, HandlerCallContext, ServiceReference } from "../contracts/capability.js";
import { WebLoomError, type LifecycleScope } from "../contracts/lifecycle.js";
import {
  assertReceivedPortSet,
  createReceivePortLedger,
  createRuntimeBudget,
  normalizeRuntimeLimits,
  validateDto,
  validateRawDto,
  validateTransferList,
  type ReceivePortLedger,
  type RuntimeBudget,
  type RuntimeLimitsInput,
} from "./dto.js";
import {
  RUNTIME_CALL_TYPE,
  RUNTIME_CANCEL_TYPE,
  RUNTIME_CREDIT_TYPE,
  RUNTIME_ERROR_MESSAGE_TYPE,
  RUNTIME_NEXT_TYPE,
  RUNTIME_PROTOCOL_VERSION,
  RUNTIME_RESULT_TYPE,
  createRuntimeMessageCodec,
  type RuntimeCallMessage,
  type RuntimeWireMessage,
} from "../runtime/runtimeProtocol.js";
import { createMessagePortRuntimeTransport, type MessagePortLike } from "./messagePortServiceTransport.js";
import type { RuntimeTransport } from "./serviceBridge.js";

export interface MessagePortServiceCallInput {
  /** 已验证的 call message；request 已由生产 parser 规范化。 */
  readonly message: RuntimeCallMessage;
  /** parser 规范化后的请求。 */
  readonly request: unknown;
  /** 服务绑定身份。 */
  readonly reference: ServiceReference;
  /** 取消信号。 */
  readonly signal: AbortSignal;
  /** 本端以接收时钟计算的调用截止时间。 */
  readonly deadlineAt: number;
  /** 对端 peer 视图。 */
  readonly peer?: CapabilityPeer;
}

export interface PreparedRequest {
  /** parser 规范化后的 DTO。 */
  readonly value: unknown;
  /** 契约声明的 transfer。 */
  readonly transfer?: readonly Transferable[];
  /** 可选的已计算计费值。 */
  readonly budgetBytes?: number;
}

export interface MessagePortServiceProviderOptions {
  /** 兼容 standalone/testing 的当前 MessagePort；实际 Runtime 使用 shared transport。 */
  readonly port?: MessagePortLike;
  /** 当前物理 endpoint 的唯一 v4 transport。 */
  readonly transport?: RuntimeTransport;
  /** 当前可暴露的服务；返回空集合即拒绝新的调用。 */
  readonly services: () => readonly ServiceReference[];
  /** 调用 Host handler。 */
  readonly handleCall: (input: MessagePortServiceCallInput) => unknown | Promise<unknown | AsyncIterable<unknown>>;
  /** 当前 peer scope。 */
  readonly peerScope?: LifecycleScope;
  /** 默认 peer view；peerForCall 可按 handler 依赖进一步收窄。 */
  readonly peer?: CapabilityPeer;
  /** 当前 handler 所属插件允许观察的 peer view。 */
  readonly peerForCall?: (call: RuntimeCallMessage, reference: ServiceReference) => CapabilityPeer | undefined;
  /** 接收 request 的 parser/transfer 适配。 */
  readonly prepareRequest?: (call: RuntimeCallMessage, ledger: ReceivePortLedger) => PreparedRequest;
  /** 发送前验证/提取 unary response。 */
  readonly prepareResult?: (value: unknown, call: RuntimeCallMessage) => PreparedRequest;
  /** 发送前验证/提取 stream item。 */
  readonly prepareItem?: (value: unknown, call: RuntimeCallMessage) => PreparedRequest;
  /** 可信 Runtime/advanced 装配预算。 */
  readonly limits?: RuntimeLimitsInput;
  /** 可选的 Runtime 方向共享计数器。 */
  readonly budget?: RuntimeBudget;
}

interface ActiveCall {
  readonly call: RuntimeCallMessage;
  readonly controller: AbortController;
  readonly reference: ServiceReference;
  readonly requestBytes: number;
  readonly deadlineAt: number;
  deadlineTimer?: ReturnType<typeof setTimeout>;
  removePeerRevoke?: () => void;
  pending: boolean;
  /** reserve() 为 stream 预留的活动槽；在 pending/stream 终态只释放一次。 */
  streamReserved: boolean;
  cancelled: boolean;
  /** 本端已经结束等待/交付，但业务执行仍可能未结束。 */
  frameworkSettled: boolean;
  executionReleased: boolean;
}

interface StreamEntry {
  readonly active: ActiveCall;
  readonly call: RuntimeCallMessage;
  readonly controller: AbortController;
  readonly reference: ServiceReference;
  readonly window: number;
  iterator?: AsyncIterator<unknown>;
  credit: number;
  sequence: number;
  running: boolean;
  closed: boolean;
  iteratorDone: boolean;
  returnStarted: boolean;
  returnDone: boolean;
  pumpDone: boolean;
}

function safeErrorCode(error: unknown, fallback: string): string {
  return error instanceof WebLoomError ? error.code : fallback;
}

function post(transport: RuntimeTransport, codec: ReturnType<typeof createRuntimeMessageCodec>, message: RuntimeWireMessage, transfer: readonly Transferable[] = []): boolean {
  try { transport.send(codec.encode(message), transfer); return true; } catch { return false; }
}

function safeErrorMessage(code: string): string {
  const messages: Record<string, string> = {
    capability_unavailable: "Capability is unavailable",
    permission_denied: "Capability authorization denied",
    service_stale: "Runtime service exposure is stale",
    request_validation_failed: "Capability request failed validation",
    response_validation_failed: "Capability response failed validation",
    request_clone_failed: "Capability request could not be delivered",
    response_clone_failed: "Capability response could not be delivered",
    transfer_invalid: "Capability transfer declaration is invalid",
    handler_failed: "Remote capability operation failed",
    call_timeout: "Capability call timed out",
    request_cancelled: "Capability call was cancelled",
    service_revoked: "Capability exposure was revoked",
    transport_unavailable: "Runtime transport is unavailable",
    stream_overflow: "Stream credit or sequence is invalid",
    resource_limit_exceeded: "Runtime resource limit exceeded",
    invalid_message: "Invalid WebLoom runtime message",
  };
  return messages[code] ?? "Remote capability operation failed";
}

/** 创建一个严格 bounded 的 MessagePort provider。 */
export function createMessagePortServiceProvider(options: MessagePortServiceProviderOptions): {
  setServices(): void;
  dispose(): void;
  pendingCount(): number;
  executionCount(): number;
  nonCooperativeExecutionCount(): number;
  retainedPayloadBytes(): number;
} {
  const codec = createRuntimeMessageCodec();
  const limits = normalizeRuntimeLimits(options.limits);
  const budget = options.budget ?? createRuntimeBudget(limits);
  const configuredTransport = options.transport ?? (options.port ? createMessagePortRuntimeTransport(options.port, { limits }) : undefined);
  if (!configuredTransport) throw new TypeError("MessagePort service provider requires transport or port");
  const transport: RuntimeTransport = configuredTransport;
  const activeCalls = new Map<string, ActiveCall>();
  const streams = new Map<string, StreamEntry>();
  const executionSlots = new Map<string, ActiveCall>();
  let peerRetainedPayloadBytes = 0;
  let disposed = false;

  const serviceFor = (message: RuntimeCallMessage): ServiceReference | undefined => options.services().find((service) => (
    service.kind === (message.mode === "stream" ? "stream" : "rpc")
      && service.capabilityId === message.capabilityId
      && service.contractVersion === message.contractVersion
      && service.serviceInstanceId === message.serviceInstanceId
  ));

  const serviceErrorCode = (message: RuntimeCallMessage): "capability_unavailable" | "service_stale" => {
    // services() is the peer's visible projection. An absent contract must
    // not reveal whether a hidden provider exists; a wrong exposure identity
    // for a currently visible contract is the only stale case we can safely
    // identify at this boundary.
    const visibleContract = options.services().some((service) => (
      service.kind === (message.mode === "stream" ? "stream" : "rpc")
        && service.capabilityId === message.capabilityId
        && service.contractVersion === message.contractVersion
    ));
    return visibleContract ? "service_stale" : "capability_unavailable";
  };

  const sendError = (call: RuntimeCallMessage, code: string, phase: "validate" | "wait" | "dispatch" | "execute" | "receive" | "dispose"): void => {
    post(transport, codec, {
      type: RUNTIME_ERROR_MESSAGE_TYPE,
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      callId: call.callId,
      serviceInstanceId: call.serviceInstanceId,
      error: { code, message: safeErrorMessage(code), phase },
    });
  };

  const releaseExecution = (active: ActiveCall): void => {
    if (active.executionReleased) return;
    active.executionReleased = true;
    if (executionSlots.get(active.call.callId) === active) executionSlots.delete(active.call.callId);
    budget.releaseExecutionSlot();
    peerRetainedPayloadBytes = Math.max(0, peerRetainedPayloadBytes - active.requestBytes);
    budget.retainedPayloadBytes = Math.max(0, budget.retainedPayloadBytes - active.requestBytes);
    active.removePeerRevoke?.();
    active.removePeerRevoke = undefined;
  };

  const releaseStreamReservation = (active: ActiveCall): void => {
    if (!active.streamReserved) return;
    active.streamReserved = false;
    budget.activeStreams = Math.max(0, budget.activeStreams - 1);
  };

  const releasePending = (active: ActiveCall): void => {
    if (!active.pending) return;
    active.pending = false;
    if (activeCalls.get(active.call.callId) === active) activeCalls.delete(active.call.callId);
    if (active.deadlineTimer !== undefined) { clearTimeout(active.deadlineTimer); active.deadlineTimer = undefined; }
    budget.pendingCalls = Math.max(0, budget.pendingCalls - 1);
  };

  const finishPending = (active: ActiveCall): void => {
    releasePending(active);
  };

  const maybeReleaseStreamExecution = (stream: StreamEntry): void => {
    if (stream.pumpDone && stream.returnDone) releaseExecution(stream.active);
  };

  const returnIterator = (stream: StreamEntry): void => {
    if (stream.returnStarted) return;
    stream.returnStarted = true;
    const candidate = stream.iterator?.return;
    if (!candidate) { stream.returnDone = true; maybeReleaseStreamExecution(stream); return; }
    let result: unknown;
    try { result = candidate.call(stream.iterator); }
    catch { stream.returnDone = true; maybeReleaseStreamExecution(stream); return; }
    void Promise.resolve(result).then(() => {
      stream.returnDone = true;
      maybeReleaseStreamExecution(stream);
    }, () => {
      stream.returnDone = true;
      maybeReleaseStreamExecution(stream);
    });
  };

  const closeStream = (stream: StreamEntry, normalDone = false): void => {
    if (stream.closed) return;
    stream.closed = true;
    stream.active.cancelled = true;
    finishPending(stream.active);
    streams.delete(stream.call.callId);
    releaseStreamReservation(stream.active);
    if (normalDone) {
      stream.iteratorDone = true;
      stream.returnDone = true;
      maybeReleaseStreamExecution(stream);
    } else {
      // If the pump was never started (for example streamReady post failed),
      // there is no finally block that can mark it settled.
      if (!stream.running) stream.pumpDone = true;
      returnIterator(stream);
      maybeReleaseStreamExecution(stream);
    }
  };

  const closeLateIterable = async (value: unknown): Promise<void> => {
    try {
      if (!value || typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] !== "function") return;
      const iterator = (value as AsyncIterable<unknown>)[Symbol.asyncIterator]();
      const close = iterator.return;
      if (close) await Promise.resolve(close.call(iterator));
    } catch {
      // A late iterator is already outside the consumer boundary; its cleanup
      // failure must not create an unhandled rejection or leak wire details.
    }
  };

  const cancelActive = (active: ActiveCall, errorCode = "request_cancelled"): void => {
    if (active.cancelled) return;
    active.frameworkSettled = true;
    active.cancelled = true;
    try { active.controller.abort(); } catch { /* noop */ }
    const stream = streams.get(active.call.callId);
    if (stream) closeStream(stream);
    else finishPending(active);
    void errorCode;
  };

  const reserve = (requestBytes: number, stream: boolean): WebLoomError | undefined => {
    if (activeCalls.size >= limits.maxPendingCallsPerPeer || budget.pendingCalls >= limits.maxPendingCallsPerRuntime) return new WebLoomError("resource_limit_exceeded", safeErrorMessage("resource_limit_exceeded"), "dispatch");
    if (executionSlots.size >= limits.maxExecutionSlotsPerPeer || budget.executionSlots >= limits.maxExecutionSlotsPerRuntime) return new WebLoomError("resource_limit_exceeded", safeErrorMessage("resource_limit_exceeded"), "dispatch");
    if (stream && (streams.size >= limits.maxActiveStreamsPerPeer || budget.activeStreams >= limits.maxActiveStreamsPerRuntime)) return new WebLoomError("resource_limit_exceeded", safeErrorMessage("resource_limit_exceeded"), "dispatch");
    if (requestBytes > limits.maxMessageBudgetBytes
      || peerRetainedPayloadBytes > limits.maxRetainedPayloadBytesPerPeer - requestBytes
      || budget.retainedPayloadBytes > limits.maxRetainedPayloadBytesPerRuntime - requestBytes) return new WebLoomError("resource_limit_exceeded", safeErrorMessage("resource_limit_exceeded"), "dispatch");
    budget.pendingCalls += 1;
    if (stream) budget.activeStreams += 1;
    budget.executionSlots += 1;
    peerRetainedPayloadBytes += requestBytes;
    budget.retainedPayloadBytes += requestBytes;
    return undefined;
  };

  const prepareRequest = (call: RuntimeCallMessage, ledger: ReceivePortLedger): { value: unknown; budgetBytes: number } => {
    try { validateRawDto(call.request, limits, "receive"); } catch (error) { ledger.closeUndelivered(); throw error; }
    let prepared: PreparedRequest;
    try { prepared = options.prepareRequest?.(call, ledger) ?? { value: call.request }; }
    catch (error) { ledger.closeUndelivered(); throw error; }
    let transfer: readonly Transferable[];
    try { transfer = validateTransferList(prepared.value, prepared.transfer, { limits, phase: "receive" }); }
    catch (error) { ledger.closeUndelivered(); throw error; }
    try { assertReceivedPortSet(ledger, transfer, { limits, phase: "receive" }); }
    catch (error) { ledger.closeUndelivered(); throw error; }
    const stats = validateDto(prepared.value, { limits: { maxDepth: limits.maxDtoDepth, maxNodes: limits.maxDtoNodes, maxEdges: limits.maxDtoEdges, maxBudgetBytes: limits.maxMessageBudgetBytes }, transferables: new Set(transfer), phase: "receive" });
    // Quota ownership always uses the production walker result. An adapter's
    // optional precomputed field must not be able to under-report a normalized
    // payload and bypass retained-byte limits.
    return { value: prepared.value, budgetBytes: stats.budgetBytes };
  };

  const prepareOutput = (prepared: PreparedRequest, ledger?: ReceivePortLedger): { value: unknown; transfer: readonly Transferable[] } => {
    try {
      const transfer = validateTransferList(prepared.value, prepared.transfer, { limits, phase: "receive" });
      if (ledger) assertReceivedPortSet(ledger, transfer, { limits, phase: "receive" });
      validateDto(prepared.value, { limits: { maxDepth: limits.maxDtoDepth, maxNodes: limits.maxDtoNodes, maxEdges: limits.maxDtoEdges, maxBudgetBytes: limits.maxMessageBudgetBytes }, transferables: new Set(transfer), phase: "receive" });
      return { value: prepared.value, transfer };
    } catch (error) { ledger?.closeUndelivered(); throw error; }
  };

  const pump = async (entry: StreamEntry): Promise<void> => {
    if (entry.running || entry.closed || !entry.iterator) return;
    entry.running = true;
    try {
      while (!entry.closed && !entry.active.cancelled && entry.credit > 0) {
        let next: IteratorResult<unknown>;
        try { next = await entry.iterator.next(); }
        catch (error) {
          if (!entry.closed && !entry.active.cancelled) sendError(entry.call, safeErrorCode(error, "handler_failed"), "execute");
          closeStream(entry);
          break;
        }
        if (entry.closed || entry.active.cancelled) break;
        if (next.done) {
          entry.iteratorDone = true;
          if (post(transport, codec, { type: RUNTIME_RESULT_TYPE, protocolVersion: RUNTIME_PROTOCOL_VERSION, callId: entry.call.callId, serviceInstanceId: entry.reference.serviceInstanceId, done: true })) closeStream(entry, true);
          else { sendError(entry.call, "transport_unavailable", "receive"); closeStream(entry, true); }
          break;
        }
        try {
          const prepared = options.prepareItem?.(next.value, entry.call) ?? { value: next.value };
          const output = prepareOutput(prepared);
          if (!post(transport, codec, { type: RUNTIME_NEXT_TYPE, protocolVersion: RUNTIME_PROTOCOL_VERSION, callId: entry.call.callId, serviceInstanceId: entry.reference.serviceInstanceId, sequence: entry.sequence, item: output.value }, output.transfer)) {
            sendError(entry.call, "response_clone_failed", "receive");
            closeStream(entry);
            break;
          }
          entry.credit -= 1;
          entry.sequence += 1;
        } catch (error) {
          if (!entry.closed && !entry.active.cancelled) sendError(entry.call, safeErrorCode(error, "response_validation_failed"), "receive");
          closeStream(entry);
          break;
        }
      }
    } finally {
      entry.running = false;
      entry.pumpDone = true;
      maybeReleaseStreamExecution(entry);
    }
  };

  const onMessage = (message: RuntimeWireMessage, metadata?: import("./serviceBridge.js").RuntimeReceiveMetadata): void => {
    const ledger = metadata?.ledger ?? createReceivePortLedger(metadata?.ports, { limits, phase: "receive" });
    if (!ledger.valid) { failClose(); return; }

    if (message.type === RUNTIME_CANCEL_TYPE) {
      ledger.closeUndelivered();
      const active = activeCalls.get(message.callId) ?? streams.get(message.callId)?.active;
      if (!active || active.reference.serviceInstanceId !== message.serviceInstanceId) return;
      cancelActive(active);
      return;
    }

    if (message.type === RUNTIME_CREDIT_TYPE) {
      ledger.closeUndelivered();
      const stream = streams.get(message.callId);
      const valid = stream !== undefined
        && stream.reference.serviceInstanceId === message.serviceInstanceId
        && Number.isSafeInteger(message.count)
        && message.count >= 1
        && message.count <= limits.maxStreamCredit
        && stream.credit + message.count <= stream.window;
      if (!valid) {
        if (stream && !stream.active.cancelled) sendError(stream.call, "stream_overflow", "receive");
        if (stream) closeStream(stream);
        return;
      }
      stream.credit += message.count;
      void pump(stream);
      return;
    }

    // The physical port is bidirectional: result/next/snapshot messages are
    // consumed by the bridge listener on this same port. They are not an
    // invalid provider message and their business ports must remain available
    // to that listener.
    if (message.type !== RUNTIME_CALL_TYPE) return;
    const reference = serviceFor(message);
    if (!reference) { ledger.closeUndelivered(); sendError(message, serviceErrorCode(message), "dispatch"); return; }
    if (activeCalls.has(message.callId) || executionSlots.has(message.callId)) { ledger.closeUndelivered(); sendError(message, "invalid_message", "dispatch"); return; }
    if (message.grantId !== undefined && message.grantId !== reference.grantId) { ledger.closeUndelivered(); sendError(message, "permission_denied", "dispatch"); return; }
    const initialCredit = message.initialCredit;
    if (message.mode === "stream" && (!Number.isSafeInteger(initialCredit) || (initialCredit as number) < 1 || (initialCredit as number) > limits.maxStreamCredit)) {
      ledger.closeUndelivered();
      sendError(message, "stream_overflow", "validate");
      return;
    }
    let request: { value: unknown; budgetBytes: number };
    try { request = prepareRequest(message, ledger); }
    catch (error) { sendError(message, safeErrorCode(error, "request_validation_failed"), error instanceof WebLoomError ? error.phase : "receive"); return; }
    const quotaError = reserve(request.budgetBytes, message.mode === "stream");
    if (quotaError) { ledger.closeUndelivered(); sendError(message, quotaError.code, "dispatch"); return; }
    // Request ports are now part of the handler DTO. The handler owns them only
    // after this point; provider no longer closes them on later cancellation.
    ledger.handoff();
    const controller = new AbortController();
    const active: ActiveCall = { call: { ...message, request: request.value }, controller, reference, requestBytes: request.budgetBytes, deadlineAt: Date.now() + message.timeoutMs, pending: true, streamReserved: message.mode === "stream", cancelled: false, frameworkSettled: false, executionReleased: false };
    activeCalls.set(message.callId, active);
    executionSlots.set(message.callId, active);
    if (options.peerScope) active.removePeerRevoke = options.peerScope.onRevoke(() => cancelActive(active, "service_revoked"));
    active.deadlineTimer = setTimeout(() => cancelActive(active, "call_timeout"), message.timeoutMs);
    const callPeer = options.peerForCall?.(active.call, reference) ?? options.peer;

    void (async () => {
      let stream: StreamEntry | undefined;
      try {
        if (active.cancelled || disposed) { releaseExecution(active); return; }
        const result = await options.handleCall({ message: active.call, request: request.value, reference, signal: controller.signal, deadlineAt: active.deadlineAt, peer: callPeer });
        if (active.cancelled || disposed || executionSlots.get(message.callId) !== active) {
          if (message.mode === "stream") await closeLateIterable(result);
          releaseExecution(active);
          return;
        }
        if (message.mode === "unary") {
          try {
            const output = prepareOutput(options.prepareResult?.(result, active.call) ?? { value: result });
            if (!active.cancelled && !post(transport, codec, { type: RUNTIME_RESULT_TYPE, protocolVersion: RUNTIME_PROTOCOL_VERSION, callId: message.callId, serviceInstanceId: reference.serviceInstanceId, result: output.value }, output.transfer)) sendError(message, "response_clone_failed", "receive");
          } catch (error) { if (!active.cancelled) sendError(message, safeErrorCode(error, "response_validation_failed"), "receive"); }
          finishPending(active);
          releaseExecution(active);
          return;
        }
        if (!result || typeof (result as AsyncIterable<unknown>)[Symbol.asyncIterator] !== "function") throw new WebLoomError("handler_failed", "Stream handler did not return AsyncIterable", "execute");
        const iterator = (result as AsyncIterable<unknown>)[Symbol.asyncIterator]();
        // An acquired iterator remains an execution slot while it is idle on
        // zero credit. It is released only after natural exhaustion or a
        // completed iterator.return().
        stream = { active, call: active.call, controller, reference, window: message.initialCredit ?? 16, iterator, credit: message.initialCredit ?? 16, sequence: 1, running: false, closed: false, iteratorDone: false, returnStarted: false, returnDone: false, pumpDone: false };
        streams.set(message.callId, stream);
        if (!post(transport, codec, { type: RUNTIME_RESULT_TYPE, protocolVersion: RUNTIME_PROTOCOL_VERSION, callId: message.callId, serviceInstanceId: reference.serviceInstanceId, streamReady: true })) {
          sendError(message, "transport_unavailable", "dispatch");
          closeStream(stream);
          return;
        }
        releasePending(active);
        void pump(stream);
      } catch (error) {
        if (!active.cancelled && !disposed) sendError(message, safeErrorCode(error, "handler_failed"), error instanceof WebLoomError ? error.phase : "execute");
        if (stream) closeStream(stream);
        else { finishPending(active); releaseExecution(active); }
      }
    })().catch(() => {
      const lateStream = streams.get(active.call.callId);
      if (lateStream) closeStream(lateStream);
      else { finishPending(active); releaseExecution(active); }
    });
  };

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    for (const active of [...activeCalls.values()]) cancelActive(active, "service_revoked");
    for (const stream of [...streams.values()]) closeStream(stream);
    removeTransport();
  }

  function failClose(): void {
    dispose();
    try { transport.close?.(); } catch { /* best effort */ }
  }

  const removeTransport = transport.subscribe(onMessage);
  return {
    setServices() { /* provider reads the current projection at dispatch time */ },
    dispose,
    pendingCount() { return activeCalls.size; },
    executionCount() { return executionSlots.size; },
    nonCooperativeExecutionCount() { return [...executionSlots.values()].filter((active) => active.frameworkSettled).length; },
    retainedPayloadBytes() { return budget.retainedPayloadBytes; },
  };
}
