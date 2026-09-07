// 基于 MessagePort 的远程服务调用传输。
//
// 服务桥本身只负责“哪个引用可以变成代理”；本模块负责把代理调用
// 接到真实 Worker / Window MessagePort。它不做寻址、重放或权限放大：
// - 每个请求都携带桥已经校验过的 service reference；
// - AbortSignal 只发送取消通知，不把一次有外部副作用的调用自动重试；
// - Provider 仍必须在自己的 RPC handler 和最终 I/O 边界再次校验引用、
//   owner、会话世代和权限租约。

import type {
  RemoteServiceMessageCodec,
  RemoteServiceCallContext,
  RemoteServiceReference,
  RemoteServiceTransport,
} from "../contracts/lifecycle.js";
import {
  createRemoteServiceMessageCodec,
  RemoteServiceUnavailableError,
} from "../contracts/lifecycle.js";

/** MessagePort 上的调用请求；request 内容由具体服务契约定义。 */
export interface RemoteServicePortCallMessage {
  /** 固定协议类型，避免与业务 MessageBus 事件混用。 */
  /** codec 绑定的调用消息类型。 */
  type: string;
  /** 由传输层生成的唯一关联键；不接受调用方提供的业务 ID。 */
  callId: string;
  /** 实际端口连接标识。 */
  connectionId: string;
  /** 提供者运行实例；响应必须原样回显。 */
  providerInstanceId: string;
  /** 调用方可复用的业务操作标识；不参与 pending 映射。 */
  operationId?: string;
  /** 外部授权标识；Provider 最终边界必须核验。 */
  grantId?: string;
  /** Provider 必须在最终边界重新核验的服务引用。 */
  reference: RemoteServiceReference;
  /** 具体服务请求体；桥不解释也不重放。 */
  request: unknown;
}

/** MessagePort 上的成功响应。 */
export interface RemoteServicePortResultMessage {
  /** codec 绑定的成功消息类型。 */
  type: string;
  callId: string;
  connectionId: string;
  providerInstanceId: string;
  result: unknown;
}

/** MessagePort 上的失败响应；只传可序列化错误信息。 */
export interface RemoteServicePortErrorMessage {
  /** codec 绑定的失败消息类型。 */
  type: string;
  callId: string;
  connectionId: string;
  providerInstanceId: string;
  error: {
    name?: string;
    message: string;
    code?: string;
  };
}

/** 请求取消通知；Provider 仍需在最终提交前做自己的世代校验。 */
export interface RemoteServicePortCancelMessage {
  /** codec 绑定的取消消息类型。 */
  type: string;
  callId: string;
  connectionId: string;
  providerInstanceId: string;
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
    context: RemoteServiceCallContext
  ) => readonly Transferable[];
  /** dispose 时是否关闭端口；默认不关闭，由端口所有者决定。 */
  closeOnDispose?: boolean;
  /** wire 消息 codec；默认使用 webloom.remote-service.*。 */
  codec?: RemoteServiceMessageCodec;
}

interface PendingCall {
  connectionId: string;
  providerInstanceId: string;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  removeAbort: () => void;
}

// 调用 ID 属于传输协议，不属于业务请求。计数器放在模块级，确保同一
// Worker / Window 内即使销毁并重建 transport，也不会重新使用旧 callId。
// 业务 operationId / requestId 可以重试或复用，但不能参与响应关联。
let nextTransportId = 0;
let nextCallSequence = 0;

function makeTransportId(): number {
  nextTransportId += 1;
  return nextTransportId;
}

function makeCallId(transportId: number): string {
  nextCallSequence += 1;
  return `remote-call:${transportId}:${nextCallSequence}`;
}

function errorFromWire(input: RemoteServicePortErrorMessage["error"]): Error {
  const error = new Error(
    typeof input?.message === "string" ? input.message : "Remote service call failed"
  );
  if (typeof input?.name === "string" && input.name.length > 0) error.name = input.name;
  if (typeof input?.code === "string" && input.code.length > 0) {
    Object.defineProperty(error, "code", {
      configurable: true,
      enumerable: true,
      value: input.code,
      writable: false,
    });
  }
  return error;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new RemoteServiceUnavailableError("Remote service request aborted");
}

function isResponseMessage(
  input: unknown,
  codec: RemoteServiceMessageCodec,
): input is RemoteServicePortResponseMessage {
  if (!input || typeof input !== "object") return false;
  const message = input as Partial<RemoteServicePortResponseMessage>;
  return (
    (message.type === codec.type("result") || message.type === codec.type("error"))
    && typeof message.callId === "string"
    && typeof message.connectionId === "string"
    && typeof message.providerInstanceId === "string"
  );
}

/**
 * 创建一个真实 MessagePort 传输。
 *
 * 返回对象的 `dispose()` 只关闭本端请求表和监听器；默认不关闭端口，
 * 以免误伤同一端口上的握手 / 快照订阅。需要独占端口时可显式设置
 * `closeOnDispose: true`。
 */
export function createMessagePortServiceTransport(
  options: CreateMessagePortServiceTransportOptions
): RemoteServiceTransport & { dispose(): void } {
  const pending = new Map<string, PendingCall>();
  let disposed = false;
  const transportId = makeTransportId();
  const codec = options.codec ?? createRemoteServiceMessageCodec();

  const onMessage = (event: MessageEvent) => {
    const decoded = codec.decode(event.data);
    if (!isResponseMessage(decoded, codec)) return;
    const call = pending.get(decoded.callId);
    if (!call) return;
    // 迟到的旧连接/旧 Provider 响应必须被丢弃。callId 单独解决复用
    // operationId 的问题，连接和 provider 身份再解决端口内的世代问题。
    if (
      decoded.connectionId !== call.connectionId
      || decoded.providerInstanceId !== call.providerInstanceId
    ) return;
    pending.delete(decoded.callId);
    call.removeAbort();
    if (decoded.type === codec.type("error")) {
      call.reject(errorFromWire(decoded.error as RemoteServicePortErrorMessage["error"]));
    } else {
      call.resolve(decoded.result);
    }
  };

  options.port.addEventListener("message", onMessage);
  options.port.start();

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    options.port.removeEventListener("message", onMessage);
    for (const [callId, call] of pending) {
      pending.delete(callId);
      call.removeAbort();
      call.reject(new RemoteServiceUnavailableError("Remote service transport disposed"));
    }
    if (options.closeOnDispose) options.port.close();
  };

  const transport: RemoteServiceTransport & { dispose(): void } = {
    call<TRequest, TResult>(request: TRequest, context: RemoteServiceCallContext): Promise<TResult> {
      if (disposed) return Promise.reject(new RemoteServiceUnavailableError("Remote service transport disposed"));
      if (context.signal.aborted) return Promise.reject(abortReason(context.signal));
      const callId = makeCallId(transportId);
      const providerInstanceId = context.reference.providerInstanceId;

      return new Promise<TResult>((resolve, reject) => {
        let settled = false;
        const finish = (callback: () => void) => {
          if (settled) return;
          settled = true;
          callback();
        };
        const onAbort = () => {
          if (!pending.delete(callId)) return;
          finish(() => reject(abortReason(context.signal)));
          try {
            const cancel: RemoteServicePortCancelMessage = {
              type: codec.type("cancel"),
              callId,
              connectionId: context.connectionId,
              providerInstanceId,
            };
            options.port.postMessage(codec.encode(cancel as unknown as Record<string, unknown>));
          } catch {
            // 端口断开时调用已经失败；不能再用异常覆盖原取消结果。
          }
        };
        const pendingCall: PendingCall = {
          connectionId: context.connectionId,
          providerInstanceId,
          resolve: (value) => finish(() => resolve(value as TResult)),
          reject: (error) => finish(() => reject(error)),
          removeAbort: () => context.signal.removeEventListener("abort", onAbort),
        };
        pending.set(callId, pendingCall);
        context.signal.addEventListener("abort", onAbort, { once: true });
        try {
          const message: RemoteServicePortCallMessage = {
            type: codec.type("call"),
            callId,
            connectionId: context.connectionId,
            providerInstanceId,
            ...(context.operationId ? { operationId: context.operationId } : {}),
            ...(context.grantId ?? context.reference.grantId
              ? { grantId: context.grantId ?? context.reference.grantId }
              : {}),
            reference: context.reference,
            request,
          };
          const transfer = options.transferForRequest?.(request, context) ?? [];
          options.port.postMessage(codec.encode(message as unknown as Record<string, unknown>), [...transfer]);
          if (context.signal.aborted) onAbort();
        } catch (error) {
          pending.delete(callId);
          pendingCall.removeAbort();
          pendingCall.reject(error);
        }
      });
    },
    dispose,
  };
  return transport;
}
