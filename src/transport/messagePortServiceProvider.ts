// v4 MessagePort provider：同一物理端口上的反向 call/stream 分派。

import type { CapabilityPeer, HandlerCallContext, ServiceReference } from "../contracts/capability.js";
import { WebLoomError, type LifecycleScope, type RuntimeEndpointBinding, type RuntimeDrainResult } from "../contracts/lifecycle.js";
import {
  assertReceivedPortSet,
  createPreparedPayload,
  createReceivePortLedger,
  createRuntimeBudget,
  consumeRuntimeStreamByteCredit,
  defaultStreamByteCredit,
  mergeRuntimeLimits,
  normalizeRuntimeLimits,
  releaseRuntimeStreamByteCredit,
  reserveRuntimeStreamByteCredit,
  returnRuntimeStreamByteCredit,
  validateRawDto,
  type PreparedPayload,
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
import type { RuntimeReceiveMetadata, RuntimeTransport } from "./serviceBridge.js";
import { createRuntimeEndpointBinding, createRuntimeEndpointSession, sameRuntimeEndpointBinding, type RuntimeEndpointSession } from "../runtime/runtimeSession.js";

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
  /** 发起此调用的物理 endpoint binding。 */
  readonly binding: RuntimeEndpointBinding;
  /** 对端 peer 视图。 */
  readonly peer?: CapabilityPeer;
}

export interface PreparedRequest {
  /** parser 规范化后的 DTO。 */
  readonly value: unknown;
  /** 契约声明的 transfer。 */
  readonly transfer?: readonly Transferable[];
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
  /** 当前物理 endpoint 的框架 binding；省略时由 provider 生成。 */
  readonly binding?: RuntimeEndpointBinding;
  /** 与同一端口 bridge 共用的 endpoint session。 */
  readonly session?: RuntimeEndpointSession;
  /** 关闭握手默认 drain deadline。 */
  readonly drainTimeoutMs?: number;
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
  /** stream 建立前的 admission reservation；创建 StreamEntry 后转交给它。 */
  streamAdmission?: StreamAdmission;
  cancelled: boolean;
  /** 本端已经结束等待/交付，但业务执行仍可能未结束。 */
  frameworkSettled: boolean;
  executionReleased: boolean;
}

interface StreamAdmission {
  /** 是否占用当前 peer 的 active-stream slot。 */
  peerActiveSlot: boolean;
  /** 是否占用 Runtime 全局的 active-stream slot。 */
  runtimeActiveSlot: boolean;
  /** 当前尚未消费的全局 byte credit。 */
  byteCredit: number;
}

interface StreamEntry {
  readonly active: ActiveCall;
  readonly call: RuntimeCallMessage;
  readonly controller: AbortController;
  readonly reference: ServiceReference;
  readonly window: number;
  readonly byteWindow: number;
  /** 已从 ActiveCall 转交的 stream admission reservation。 */
  readonly admission: StreamAdmission;
  iterator?: AsyncIterator<unknown>;
  credit: number;
  sequence: number;
  running: boolean;
  closed: boolean;
  iteratorDone: boolean;
  returnStarted: boolean;
  returnDone: boolean;
  pumpDone: boolean;
  /** 已发出但尚未收到归还 credit 的 item budget 队列。 */
  outstandingByteBudgets: number[];
  outstandingByteHead: number;
  /** 因 byte credit 不足而暂存的一个已规范化 item。 */
  pendingOutput?: PreparedPayload;
  pendingOutputBytes: number;
}

function safeErrorCode(error: unknown, fallback: string): string {
  return error instanceof WebLoomError ? error.code : fallback;
}

function post(transport: RuntimeTransport, codec: ReturnType<typeof createRuntimeMessageCodec>, message: RuntimeWireMessage, prepared?: PreparedPayload, transfer: readonly Transferable[] = []): boolean {
  try {
    transport.send(codec.encode(message, prepared), prepared?.transfer ?? transfer);
    return true;
  } catch { return false; }
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
  readonly binding: RuntimeEndpointBinding;
  readonly endpointState: "active" | "closing" | "closed";
  beginClose(reason?: string): void;
  drain(timeoutMs?: number): Promise<RuntimeDrainResult>;
  pendingCount(): number;
  executionCount(): number;
  nonCooperativeExecutionCount(): number;
  retainedPayloadBytes(): number;
} {
  const requestedLimits = normalizeRuntimeLimits(options.limits);
  const budget = options.budget ?? createRuntimeBudget(requestedLimits);
  const limits = mergeRuntimeLimits(requestedLimits, budget);
  const codec = createRuntimeMessageCodec({ limits });
  const configuredTransport = options.transport ?? (options.port ? createMessagePortRuntimeTransport(options.port, { limits }) : undefined);
  if (!configuredTransport) throw new TypeError("MessagePort service provider requires transport or port");
  const transport: RuntimeTransport = configuredTransport;
  const ownsSession = options.session === undefined;
  const session = options.session ?? createRuntimeEndpointSession(options.binding ?? createRuntimeEndpointBinding(`provider:${Date.now().toString(36)}`), { defaultDrainTimeoutMs: options.drainTimeoutMs });
  if (options.binding && !sameRuntimeEndpointBinding(options.binding, session.binding)) throw new TypeError("MessagePort service provider binding disagrees with endpoint session");
  const localBinding = session.binding;
  const activeCalls = new Map<string, ActiveCall>();
  const streams = new Map<string, StreamEntry>();
  const executionSlots = new Map<string, ActiveCall>();
  const executionDrainWaiters = new Set<() => void>();
  let peerRetainedPayloadBytes = 0;
  let peerActiveStreams = 0;
  let peerReservedStreamByteCredit = 0;
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
      binding: localBinding,
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
    if (executionSlots.size === 0) {
      for (const resolve of [...executionDrainWaiters]) resolve();
      executionDrainWaiters.clear();
    }
  };

  const releaseStreamAdmission = (admission: StreamAdmission | undefined): void => {
    if (!admission) return;
    if (admission.peerActiveSlot) {
      admission.peerActiveSlot = false;
      peerActiveStreams = Math.max(0, peerActiveStreams - 1);
    }
    if (admission.runtimeActiveSlot) {
      admission.runtimeActiveSlot = false;
      budget.activeStreams = Math.max(0, budget.activeStreams - 1);
    }
    if (admission.byteCredit > 0) {
      peerReservedStreamByteCredit = Math.max(0, peerReservedStreamByteCredit - admission.byteCredit);
      releaseRuntimeStreamByteCredit(budget, admission.byteCredit);
      admission.byteCredit = 0;
    }
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

  const releasePendingOutput = (stream: StreamEntry): void => {
    if (stream.pendingOutputBytes === 0) return;
    peerRetainedPayloadBytes = Math.max(0, peerRetainedPayloadBytes - stream.pendingOutputBytes);
    budget.retainedPayloadBytes = Math.max(0, budget.retainedPayloadBytes - stream.pendingOutputBytes);
    stream.pendingOutputBytes = 0;
    stream.pendingOutput = undefined;
  };

  const retainPendingOutput = (stream: StreamEntry, output: PreparedPayload): void => {
    const bytes = output.stats.budgetBytes;
    if (bytes > stream.byteWindow) throw new WebLoomError("stream_overflow", safeErrorMessage("stream_overflow"), "dispatch");
    if (peerRetainedPayloadBytes > limits.maxRetainedPayloadBytesPerPeer - peerReservedStreamByteCredit - bytes
      || budget.retainedPayloadBytes > limits.maxRetainedPayloadBytesPerRuntime - bytes - budget.reservedStreamByteCredit) {
      throw new WebLoomError("resource_limit_exceeded", safeErrorMessage("resource_limit_exceeded"), "receive");
    }
    stream.pendingOutput = output;
    stream.pendingOutputBytes = bytes;
    peerRetainedPayloadBytes += bytes;
    budget.retainedPayloadBytes += bytes;
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
    releaseStreamAdmission(stream.admission);
    releasePendingOutput(stream);
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
    else {
      finishPending(active);
      releaseStreamAdmission(active.streamAdmission);
      active.streamAdmission = undefined;
    }
    void errorCode;
  };

  const reserve = (requestBytes: number, stream: boolean, streamByteCredit = 0): WebLoomError | undefined => {
    if (activeCalls.size >= limits.maxPendingCallsPerPeer || budget.pendingCalls >= limits.maxPendingCallsPerRuntime) return new WebLoomError("resource_limit_exceeded", safeErrorMessage("resource_limit_exceeded"), "dispatch");
    if (executionSlots.size >= limits.maxExecutionSlotsPerPeer || budget.executionSlots >= limits.maxExecutionSlotsPerRuntime) return new WebLoomError("resource_limit_exceeded", safeErrorMessage("resource_limit_exceeded"), "dispatch");
    if (stream && (peerActiveStreams >= limits.maxActiveStreamsPerPeer || budget.activeStreams >= limits.maxActiveStreamsPerRuntime)) return new WebLoomError("resource_limit_exceeded", safeErrorMessage("resource_limit_exceeded"), "dispatch");
    if (requestBytes > limits.maxMessageBudgetBytes
      || peerRetainedPayloadBytes > limits.maxRetainedPayloadBytesPerPeer - peerReservedStreamByteCredit - requestBytes - streamByteCredit
      || budget.retainedPayloadBytes > limits.maxRetainedPayloadBytesPerRuntime - requestBytes - budget.reservedStreamByteCredit - streamByteCredit) return new WebLoomError("resource_limit_exceeded", safeErrorMessage("resource_limit_exceeded"), "dispatch");
    if (streamByteCredit > 0 && !reserveRuntimeStreamByteCredit(budget, streamByteCredit, limits.maxRetainedPayloadBytesPerRuntime)) return new WebLoomError("resource_limit_exceeded", safeErrorMessage("resource_limit_exceeded"), "dispatch");
    peerReservedStreamByteCredit += streamByteCredit;
    budget.pendingCalls += 1;
    if (stream) {
      peerActiveStreams += 1;
      budget.activeStreams += 1;
    }
    budget.executionSlots += 1;
    peerRetainedPayloadBytes += requestBytes;
    budget.retainedPayloadBytes += requestBytes;
    return undefined;
  };

  const availableStreamByteCredit = (requestBytes: number): number => Math.min(
    defaultStreamByteCredit(limits),
    limits.maxStreamByteCredit,
    Math.max(0, limits.maxRetainedPayloadBytesPerPeer - peerRetainedPayloadBytes - peerReservedStreamByteCredit - requestBytes),
    Math.max(0, limits.maxRetainedPayloadBytesPerRuntime - budget.retainedPayloadBytes - budget.reservedStreamByteCredit - requestBytes),
  );

  const prepareRequest = (call: RuntimeCallMessage, ledger: ReceivePortLedger, metadata?: RuntimeReceiveMetadata): PreparedPayload => {
    // The production transport already bounded the raw wire graph with this
    // endpoint's limits. Testing/advanced transports may omit that metadata,
    // so retain the bounded fallback; parser output is always walked again.
    const rawPayload = metadata?.payload;
    if (rawPayload) {
      const stats = rawPayload.stats;
      const withinLimits = rawPayload.field === "request"
        && rawPayload.value === call.request
        && stats.depth <= limits.maxDtoDepth
        && stats.nodes <= limits.maxDtoNodes
        && stats.edges <= limits.maxDtoEdges
        && stats.budgetBytes <= limits.maxMessageBudgetBytes;
      if (!withinLimits) {
        ledger.closeUndelivered();
        throw new WebLoomError("invalid_message", "Transport payload metadata does not match the received request", "receive");
      }
    } else {
      try { validateRawDto(call.request, limits, "receive"); } catch (error) { ledger.closeUndelivered(); throw error; }
    }
    let prepared: PreparedRequest;
    try { prepared = options.prepareRequest?.(call, ledger) ?? { value: call.request }; }
    catch (error) { ledger.closeUndelivered(); throw error; }
    let output: PreparedPayload;
    try { output = createPreparedPayload(prepared.value, prepared.transfer, { limits, phase: "receive" }); }
    catch (error) { ledger.closeUndelivered(); throw error; }
    try { assertReceivedPortSet(ledger, output.transfer, { limits, phase: "receive" }); }
    catch (error) { ledger.closeUndelivered(); throw error; }
    return output;
  };

  const prepareOutput = (prepared: PreparedRequest, ledger?: ReceivePortLedger): PreparedPayload => {
    try {
      const output = createPreparedPayload(prepared.value, prepared.transfer, { limits, phase: "receive" });
      if (ledger) assertReceivedPortSet(ledger, output.transfer, { limits, phase: "receive" });
      return output;
    } catch (error) { ledger?.closeUndelivered(); throw error; }
  };

  const pump = async (entry: StreamEntry): Promise<void> => {
    if (entry.running || entry.closed || !entry.iterator) return;
    entry.running = true;
    try {
      while (!entry.closed && !entry.active.cancelled && entry.credit > 0) {
        let output = entry.pendingOutput;
        if (!output) {
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
            if (post(transport, codec, { type: RUNTIME_RESULT_TYPE, protocolVersion: RUNTIME_PROTOCOL_VERSION, binding: localBinding, callId: entry.call.callId, serviceInstanceId: entry.reference.serviceInstanceId, done: true })) closeStream(entry, true);
            else { sendError(entry.call, "transport_unavailable", "receive"); closeStream(entry, true); }
            break;
          }
          try {
            output = prepareOutput(options.prepareItem?.(next.value, entry.call) ?? { value: next.value });
          } catch (error) {
            if (!entry.closed && !entry.active.cancelled) sendError(entry.call, safeErrorCode(error, "response_validation_failed"), "receive");
            closeStream(entry);
            break;
          }
        }

        if (output.stats.budgetBytes > entry.admission.byteCredit) {
          try {
            // 没有任何已发送 item 可以再归还 byte credit 时，当前窗口永远
            // 无法容纳这个 item；不能把它悬挂成无界等待。
            if (entry.outstandingByteBudgets.length === entry.outstandingByteHead) {
              throw new WebLoomError("stream_overflow", safeErrorMessage("stream_overflow"), "dispatch");
            }
            if (!entry.pendingOutput) retainPendingOutput(entry, output);
          } catch (error) {
            if (!entry.closed && !entry.active.cancelled) sendError(entry.call, safeErrorCode(error, "stream_overflow"), error instanceof WebLoomError ? error.phase : "dispatch");
            closeStream(entry);
          }
          break;
        }
        if (peerReservedStreamByteCredit < output.stats.budgetBytes || !consumeRuntimeStreamByteCredit(budget, output.stats.budgetBytes)) {
          sendError(entry.call, "stream_overflow", "dispatch");
          closeStream(entry);
          break;
        }
        entry.credit -= 1;
        peerReservedStreamByteCredit -= output.stats.budgetBytes;
        entry.admission.byteCredit -= output.stats.budgetBytes;
        if (!post(transport, codec, { type: RUNTIME_NEXT_TYPE, protocolVersion: RUNTIME_PROTOCOL_VERSION, binding: localBinding, callId: entry.call.callId, serviceInstanceId: entry.reference.serviceInstanceId, sequence: entry.sequence, item: output.value }, output)) {
          returnRuntimeStreamByteCredit(budget, output.stats.budgetBytes);
          peerReservedStreamByteCredit += output.stats.budgetBytes;
          entry.admission.byteCredit += output.stats.budgetBytes;
          entry.credit += 1;
          sendError(entry.call, "response_clone_failed", "receive");
          closeStream(entry);
          break;
        }
        if (entry.pendingOutput === output) releasePendingOutput(entry);
        entry.outstandingByteBudgets.push(output.stats.budgetBytes);
        entry.sequence += 1;
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

    try {
      // Every RuntimeTransport, including advanced/testing transports, must
      // pass the same strict wire codec.  There is no missing-binding
      // compatibility path here.
      if (!metadata?.decoded) message = codec.decode(message);
    } catch {
      ledger.closeUndelivered();
      failClose();
      return;
    }

    // The transport codec checks the binding shape; the endpoint session checks
    // that this physical port never changes peer identity mid-connection.
    const bindingAccepted = session.acceptRemoteBinding(message.binding);
    // A close-ack can arrive after the shared session has already transitioned
    // to closed. Provider does not consume ACKs, but must discard this late
    // same-binding control message without turning a completed close into a
    // second terminal failure. A different binding is still terminal.
    const closedKnownControl = !bindingAccepted
      && session.state === "closed"
      && sameRuntimeEndpointBinding(session.remoteBinding, message.binding);
    if (!bindingAccepted && !closedKnownControl) {
      ledger.closeUndelivered();
      failClose();
      return;
    }

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
      const outstanding = stream ? stream.outstandingByteBudgets.length - stream.outstandingByteHead : 0;
      let expectedBytes = 0;
      if (stream && Number.isSafeInteger(message.count) && message.count >= 1 && message.count <= outstanding) {
        for (let index = stream.outstandingByteHead; index < stream.outstandingByteHead + message.count; index += 1) expectedBytes += stream.outstandingByteBudgets[index] ?? 0;
      }
      const creditedBytes = message.bytes ?? expectedBytes;
      const valid = stream !== undefined
        && stream.reference.serviceInstanceId === message.serviceInstanceId
        && Number.isSafeInteger(message.count)
        && message.count >= 1
        && message.count <= limits.maxStreamCredit
        && message.count <= outstanding
        && creditedBytes === expectedBytes
        && stream.credit + message.count <= stream.window
        && Number.isSafeInteger(creditedBytes)
        && creditedBytes >= 1
        && stream.admission.byteCredit + creditedBytes <= stream.byteWindow;
      if (!valid) {
        if (stream && !stream.active.cancelled) sendError(stream.call, "stream_overflow", "receive");
        if (stream) closeStream(stream);
        return;
      }
      returnRuntimeStreamByteCredit(budget, creditedBytes);
      peerReservedStreamByteCredit += creditedBytes;
      stream.credit += message.count;
      stream.admission.byteCredit += creditedBytes;
      stream.outstandingByteHead += message.count;
      if (stream.outstandingByteHead >= 64 && stream.outstandingByteHead * 2 >= stream.outstandingByteBudgets.length) {
        stream.outstandingByteBudgets = stream.outstandingByteBudgets.slice(stream.outstandingByteHead);
        stream.outstandingByteHead = 0;
      }
      void pump(stream);
      return;
    }

    // The physical port is bidirectional: result/next/snapshot messages are
    // consumed by the bridge listener on this same port. They are not an
    // invalid provider message and their business ports must remain available
    // to that listener.
    if (message.type !== RUNTIME_CALL_TYPE) return;
    if (session.state !== "active" || disposed) {
      ledger.closeUndelivered();
      sendError(message, "service_revoked", "dispose");
      return;
    }
    const reference = serviceFor(message);
    if (!reference) { ledger.closeUndelivered(); sendError(message, serviceErrorCode(message), "dispatch"); return; }
    if (activeCalls.has(message.callId) || executionSlots.has(message.callId)) { ledger.closeUndelivered(); sendError(message, "invalid_message", "dispatch"); return; }
    // A published domain grant is part of the service exposure identity.  A
    // caller must echo it exactly; omission is not equivalent to possession.
    if (message.grantId !== reference.grantId) { ledger.closeUndelivered(); sendError(message, "permission_denied", "dispatch"); return; }
    const initialCredit = message.mode === "stream" ? message.initialCredit : 0;
    const requestedInitialByteCredit = message.mode === "stream" ? message.initialByteCredit : 0;
    if (message.mode === "stream" && (!Number.isSafeInteger(initialCredit) || initialCredit < 1 || initialCredit > limits.maxStreamCredit
      || !Number.isSafeInteger(requestedInitialByteCredit) || requestedInitialByteCredit < 1 || requestedInitialByteCredit > limits.maxStreamByteCredit)) {
      ledger.closeUndelivered();
      sendError(message, "stream_overflow", "validate");
      return;
    }
    let request: PreparedPayload;
    try { request = prepareRequest(message, ledger, metadata); }
    catch (error) { sendError(message, safeErrorCode(error, "request_validation_failed"), error instanceof WebLoomError ? error.phase : "receive"); return; }
    const initialByteCredit = message.mode === "stream"
      ? message.initialByteCreditAuto === true
        ? Math.min(requestedInitialByteCredit, availableStreamByteCredit(request.stats.budgetBytes))
        : requestedInitialByteCredit
      : 0;
    if (message.mode === "stream" && initialByteCredit < 1) {
      ledger.closeUndelivered();
      sendError(message, "resource_limit_exceeded", "dispatch");
      return;
    }
    const quotaError = reserve(request.stats.budgetBytes, message.mode === "stream", message.mode === "stream" ? initialByteCredit : 0);
    if (quotaError) {
      ledger.closeUndelivered(); sendError(message, quotaError.code, "dispatch"); return;
    }
    // Request ports are now part of the handler DTO. The handler owns them only
    // after this point; provider no longer closes them on later cancellation.
    ledger.handoff();
    const controller = new AbortController();
    const active: ActiveCall = { call: { ...message, request: request.value }, controller, reference, requestBytes: request.stats.budgetBytes, deadlineAt: Date.now() + message.timeoutMs, pending: true, streamAdmission: message.mode === "stream" ? { peerActiveSlot: true, runtimeActiveSlot: true, byteCredit: initialByteCredit } : undefined, cancelled: false, frameworkSettled: false, executionReleased: false };
    activeCalls.set(message.callId, active);
    executionSlots.set(message.callId, active);
    if (options.peerScope) active.removePeerRevoke = options.peerScope.onRevoke(() => cancelActive(active, "service_revoked"));
    active.deadlineTimer = setTimeout(() => cancelActive(active, "call_timeout"), message.timeoutMs);
    const callPeer = options.peerForCall?.(active.call, reference) ?? options.peer;

    void (async () => {
      let stream: StreamEntry | undefined;
      try {
        if (active.cancelled || disposed) {
          releaseStreamAdmission(active.streamAdmission);
          active.streamAdmission = undefined;
          releaseExecution(active);
          return;
        }
        const result = await options.handleCall({ message: active.call, request: request.value, reference, signal: controller.signal, deadlineAt: active.deadlineAt, binding: active.call.binding, peer: callPeer });
        if (active.cancelled || disposed || executionSlots.get(message.callId) !== active) {
          if (message.mode === "stream") await closeLateIterable(result);
          releaseStreamAdmission(active.streamAdmission);
          active.streamAdmission = undefined;
          releaseExecution(active);
          return;
        }
        if (message.mode === "unary") {
          try {
            const output = prepareOutput(options.prepareResult?.(result, active.call) ?? { value: result });
            if (!active.cancelled && !post(transport, codec, { type: RUNTIME_RESULT_TYPE, protocolVersion: RUNTIME_PROTOCOL_VERSION, binding: localBinding, callId: message.callId, serviceInstanceId: reference.serviceInstanceId, result: output.value }, output)) sendError(message, "response_clone_failed", "receive");
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
        const admission = active.streamAdmission;
        if (!admission) throw new WebLoomError("resource_limit_exceeded", safeErrorMessage("resource_limit_exceeded"), "dispatch");
        stream = { active, call: active.call, controller, reference, window: message.initialCredit ?? 16, byteWindow: initialByteCredit, admission, iterator, credit: message.initialCredit ?? 16, sequence: 1, running: false, closed: false, iteratorDone: false, returnStarted: false, returnDone: false, pumpDone: false, outstandingByteBudgets: [], outstandingByteHead: 0, pendingOutputBytes: 0 };
        active.streamAdmission = undefined;
        streams.set(message.callId, stream);
        if (!post(transport, codec, { type: RUNTIME_RESULT_TYPE, protocolVersion: RUNTIME_PROTOCOL_VERSION, binding: localBinding, callId: message.callId, serviceInstanceId: reference.serviceInstanceId, streamReady: true, acceptedInitialByteCredit: initialByteCredit })) {
          sendError(message, "transport_unavailable", "dispatch");
          closeStream(stream);
          return;
        }
        releasePending(active);
        void pump(stream);
      } catch (error) {
        if (!active.cancelled && !disposed) sendError(message, safeErrorCode(error, "handler_failed"), error instanceof WebLoomError ? error.phase : "execute");
        if (stream) closeStream(stream);
        else {
          finishPending(active);
          releaseStreamAdmission(active.streamAdmission);
          active.streamAdmission = undefined;
          releaseExecution(active);
        }
      }
    })().catch(() => {
      const lateStream = streams.get(active.call.callId);
      if (lateStream) closeStream(lateStream);
      else {
        finishPending(active);
        releaseStreamAdmission(active.streamAdmission);
        active.streamAdmission = undefined;
        releaseExecution(active);
      }
    });
  };

  const drainExecutions = (): Promise<void> => {
    if (executionSlots.size === 0) return Promise.resolve();
    return new Promise<void>((resolve) => executionDrainWaiters.add(resolve));
  };
  session.registerDrainParticipant({
    drain: drainExecutions,
    pending: () => executionSlots.size,
  });

  let removeTransport: () => void = () => undefined;
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    for (const active of [...activeCalls.values()]) cancelActive(active, "service_revoked");
    for (const stream of [...streams.values()]) closeStream(stream);
    removeTransport();
    if (ownsSession) session.close();
  }

  function failClose(): void {
    dispose();
    try { transport.close?.(); } catch { /* best effort */ }
    session.close();
  }

  removeTransport = transport.subscribeByType
    ? transport.subscribeByType([RUNTIME_CALL_TYPE, RUNTIME_CANCEL_TYPE, RUNTIME_CREDIT_TYPE], onMessage)
    : transport.subscribe(onMessage);
  // Closing the shared endpoint synchronously fences provider admission and
  // aborts its active handlers before any asynchronous drain/transport I/O.
  let removeSessionBeginClose: () => void = () => undefined;
  removeSessionBeginClose = session.onBeginClose(() => dispose());
  session.onClosed(() => {
    // Keep the participant registered after physical close so a later drain
    // still reports non-cooperative execution slots truthfully.
    removeSessionBeginClose();
  });
  return {
    setServices() { /* provider reads the current projection at dispatch time */ },
    dispose,
    get binding() { return localBinding; },
    get endpointState() { return session.state; },
    beginClose(reason = "Runtime endpoint closing") { session.beginClose(reason); },
    drain(timeoutMs) { return session.drain(timeoutMs); },
    pendingCount() { return activeCalls.size; },
    executionCount() { return executionSlots.size; },
    nonCooperativeExecutionCount() { return [...executionSlots.values()].filter((active) => active.frameworkSettled).length; },
    retainedPayloadBytes() { return budget.retainedPayloadBytes; },
  };
}
