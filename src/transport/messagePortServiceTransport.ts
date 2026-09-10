// 基于 MessagePort 的 WebLoom v2 远程调用传输。
//
// wire 只保留 call/result/error/cancel。MessagePort 本身就是连接隔离边界，
// 因此不传 connectionId，也不把完整 RemoteServiceReference 回显给 Provider。

import type {
  RemoteServiceCallContext,
  RemoteServiceMessageCodec,
  RemoteServiceReference,
  RemoteServiceTransport,
} from "../contracts/lifecycle.js";
import {
  createRemoteServiceMessageCodec,
  RemoteServiceError,
} from "../contracts/lifecycle.js";

export interface RemoteServicePortCallMessage {
  type: string;
  protocolVersion: string;
  callId: string;
  capabilityId: string;
  contractVersion: string;
  serviceInstanceId: string;
  operationId?: string;
  grantId?: string;
  request: unknown;
}

export interface RemoteServicePortResultMessage {
  type: string;
  protocolVersion: string;
  callId: string;
  serviceInstanceId: string;
  result: unknown;
}

export interface RemoteServicePortErrorMessage {
  type: string;
  protocolVersion: string;
  callId: string;
  serviceInstanceId: string;
  error: {
    name?: string;
    message: string;
    code: string;
    details?: Readonly<Record<string, unknown>>;
  };
}

export interface RemoteServicePortCancelMessage {
  type: string;
  protocolVersion: string;
  callId: string;
  serviceInstanceId: string;
}

export type RemoteServicePortResponseMessage =
  | RemoteServicePortResultMessage
  | RemoteServicePortErrorMessage;

export interface CreateMessagePortServiceTransportOptions {
  /** 已由实际 Worker / Window 连接产生的双工端口。 */
  port: MessagePort;
  /** 可选 transferable 提取器；默认只发送结构化克隆数据。 */
  transferForRequest?: (
    request: unknown,
    context: RemoteServiceCallContext,
  ) => readonly Transferable[];
  /** dispose 时是否关闭端口；默认不关闭，由端口所有者决定。 */
  closeOnDispose?: boolean;
  /** wire 消息 codec；默认 webloom.remote-service.v2。 */
  codec?: RemoteServiceMessageCodec;
  /** 直接使用 transport 时的默认总 deadline。 */
  defaultCallTimeoutMs?: number;
}

interface PendingCall {
  protocolVersion: string;
  serviceInstanceId: string;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  removeAbort: () => void;
  disposeDeadline: () => void;
}

let nextTransportId = 0;
let nextCallSequence = 0;

function makeCallId(transportId: number): string {
  nextCallSequence += 1;
  return `remote-call:${transportId}:${nextCallSequence}`;
}

function finiteTimeout(value: number | undefined): number {
  const timeout = value ?? 30_000;
  if (!Number.isFinite(timeout) || timeout <= 0) throw new TypeError("Remote service timeout must be finite and greater than zero");
  return timeout;
}

function errorFromWire(input: RemoteServicePortErrorMessage["error"]): RemoteServiceError {
  return new RemoteServiceError(
    typeof input?.code === "string" && input.code.length > 0 ? input.code : "handler_failed",
    typeof input?.message === "string" ? input.message : "Remote service call failed",
    input?.details,
  );
}

function abortReason(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error && typeof (reason as Error & { code?: unknown }).code === "string") return reason;
  if (reason instanceof Error) return new RemoteServiceError("request_cancelled", reason.message);
  return new RemoteServiceError("request_cancelled", "Remote service request was cancelled");
}

function addMessageListener(port: MessagePort, listener: (event: MessageEvent) => void): () => void {
  port.addEventListener("message", listener);
  return () => port.removeEventListener("message", listener);
}

function postBestEffort(port: MessagePort, message: unknown, transfer: readonly Transferable[] = []): void {
  try { port.postMessage(message, [...transfer]); } catch { /* 断线由 deadline / dispose 收敛 */ }
}

function postRequest(port: MessagePort, message: unknown, transfer: readonly Transferable[] = []): void {
  try {
    port.postMessage(message, [...transfer]);
  } catch (error) {
    const name = error && typeof error === "object" && typeof (error as { name?: unknown }).name === "string"
      ? (error as { name: string }).name
      : "DataCloneError";
    const messageText = error instanceof Error ? error.message : String(error);
    throw new RemoteServiceError(
      "request_clone_failed",
      `Remote service request could not be posted: ${messageText}`,
      { name, message: messageText },
    );
  }
}

function isResponseMessage(
  input: unknown,
  codec: RemoteServiceMessageCodec,
): input is RemoteServicePortResponseMessage {
  if (!input || typeof input !== "object") return false;
  const message = input as Partial<RemoteServicePortResponseMessage>;
  return (message.type === codec.type("result") || message.type === codec.type("error"))
    && typeof message.protocolVersion === "string"
    && typeof message.callId === "string"
    && typeof message.serviceInstanceId === "string";
}

/** 创建一条不携带连接身份、不会自动重放的 MessagePort transport。 */
export function createMessagePortServiceTransport(
  options: CreateMessagePortServiceTransportOptions,
): RemoteServiceTransport & { dispose(): void } {
  const pending = new Map<string, PendingCall>();
  let disposed = false;
  const transportId = ++nextTransportId;
  const codec = options.codec ?? createRemoteServiceMessageCodec();
  const defaultCallTimeoutMs = finiteTimeout(options.defaultCallTimeoutMs);

  const rejectPending = (error: Error, sendCancel: boolean): void => {
    for (const [callId, call] of pending) {
      pending.delete(callId);
      call.removeAbort();
      call.disposeDeadline();
      if (sendCancel) {
        postBestEffort(options.port, codec.encode({
          type: codec.type("cancel"),
          protocolVersion: codec.protocolVersion,
          callId,
          serviceInstanceId: call.serviceInstanceId,
        }));
      }
      call.reject(error);
    }
  };

  const onMessage = (event: MessageEvent): void => {
    const decoded = codec.decode(event.data);
    if (!isResponseMessage(decoded, codec)) return;
    const call = pending.get(decoded.callId);
    if (!call) return;
    if (decoded.serviceInstanceId !== call.serviceInstanceId) return;
    pending.delete(decoded.callId);
    call.removeAbort();
    call.disposeDeadline();
    if (decoded.protocolVersion !== codec.protocolVersion) {
      call.reject(new RemoteServiceError("protocol_mismatch", "Remote service protocol version mismatch"));
      return;
    }
    if (decoded.type === codec.type("error")) {
      call.reject(errorFromWire((decoded as RemoteServicePortErrorMessage).error));
    } else {
      call.resolve(decoded.result);
    }
  };
  const onMessageError = (): void => rejectPending(new RemoteServiceError("transport_unavailable", "Remote service message could not be decoded"), false);
  const removeMessage = addMessageListener(options.port, onMessage);
  options.port.addEventListener("messageerror", onMessageError);
  options.port.start();

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    removeMessage();
    options.port.removeEventListener("messageerror", onMessageError);
    rejectPending(new RemoteServiceError("transport_unavailable", "Remote service transport disposed"), true);
    if (options.closeOnDispose) {
      try { options.port.close(); } catch { /* noop */ }
    }
  };

  const transport: RemoteServiceTransport & { dispose(): void } = {
    call<TRequest, TResult>(request: TRequest, context: RemoteServiceCallContext): Promise<TResult> {
      if (disposed) return Promise.reject(new RemoteServiceError("transport_unavailable", "Remote service transport disposed"));
      if (context.signal.aborted) return Promise.reject(abortReason(context.signal));
      const callId = makeCallId(transportId);
      const serviceInstanceId = context.reference.serviceInstanceId;
      const timeoutMs = finiteTimeout(context.timeoutMs ?? defaultCallTimeoutMs);
      const deadlineAt = context.deadlineAt ?? Date.now() + timeoutMs;
      const timeoutController = new AbortController();
      const remaining = Math.max(0, deadlineAt - Date.now());
      const deadlineTimer = setTimeout(() => {
        try { timeoutController.abort(new RemoteServiceError("call_timeout", "Remote service call timed out")); } catch { timeoutController.abort(); }
      }, remaining);
      const merged = (() => {
        const controller = new AbortController();
        const signals = [context.signal, timeoutController.signal];
        const listeners = signals.map((signal) => {
          const listener = () => {
            try { controller.abort(signal.reason); } catch { controller.abort(); }
          };
          signal.addEventListener("abort", listener, { once: true });
          return { signal, listener };
        });
        return {
          signal: controller.signal,
          dispose: () => listeners.forEach(({ signal, listener }) => signal.removeEventListener("abort", listener)),
        };
      })();

      return new Promise<TResult>((resolve, reject) => {
        let settled = false;
        const finish = (callback: () => void): void => {
          if (settled) return;
          settled = true;
          callback();
        };
        const sendCancel = (): void => postBestEffort(options.port, codec.encode({
          type: codec.type("cancel"),
          protocolVersion: codec.protocolVersion,
          callId,
          serviceInstanceId,
        }));
        const onAbort = (): void => {
          if (!pending.delete(callId)) return;
          sendCancel();
          const reason = merged.signal.reason instanceof RemoteServiceError
            ? merged.signal.reason
            : merged.signal.reason?.code === "call_timeout"
              ? merged.signal.reason
              : abortReason(merged.signal);
          finish(() => reject(reason));
          merged.dispose();
          clearTimeout(deadlineTimer);
        };
        const pendingCall: PendingCall = {
          protocolVersion: codec.protocolVersion,
          serviceInstanceId,
          resolve: (value) => finish(() => resolve(value as TResult)),
          reject: (error) => finish(() => reject(error)),
          removeAbort: () => merged.signal.removeEventListener("abort", onAbort),
          disposeDeadline: () => {
            merged.dispose();
            clearTimeout(deadlineTimer);
          },
        };
        pending.set(callId, pendingCall);
        merged.signal.addEventListener("abort", onAbort, { once: true });
        const message: RemoteServicePortCallMessage = {
          type: codec.type("call"),
          protocolVersion: codec.protocolVersion,
          callId,
          capabilityId: context.reference.capabilityId,
          contractVersion: context.reference.contractVersion,
          serviceInstanceId,
          ...(context.operationId ? { operationId: context.operationId } : {}),
          ...(context.grantId ?? context.reference.grantId
            ? { grantId: context.grantId ?? context.reference.grantId }
            : {}),
          request,
        };
        try {
          const transfer = options.transferForRequest?.(request, context) ?? [];
          postRequest(options.port, codec.encode(message as unknown as Record<string, unknown>), transfer);
          if (merged.signal.aborted) onAbort();
        } catch (error) {
          pending.delete(callId);
          pendingCall.removeAbort();
          pendingCall.disposeDeadline();
          pendingCall.reject(error);
        }
      });
    },
    dispose,
  };
  return transport;
}

/** Provider 侧调用消息的结构化输入。 */
export interface MessagePortServiceCallInput {
  message: RemoteServicePortCallMessage;
  /** Provider 的权威目录命中的服务引用。 */
  reference: RemoteServiceReference;
  signal: AbortSignal;
}
