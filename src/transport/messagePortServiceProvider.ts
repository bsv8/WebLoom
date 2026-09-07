// 基于 MessagePort 的服务提供端点。
//
// 该模块是 Coordinator/Provider 侧的物理端点：它发送握手和服务目录，
// 接收代理调用，并把取消信号传给实际 handler。它不决定谁有权限使用
// 服务；handler 必须在这里之后继续做引用、授权、owner 和世代校验。

import type {
  RemoteServiceHandshake,
  RemoteServiceMessageCodec,
  RemoteServicePortControlMessage,
  RemoteServiceSnapshot,
} from "../contracts/lifecycle.js";
import { createRemoteServiceMessageCodec } from "../contracts/lifecycle.js";
import type {
  RemoteServicePortCallMessage,
  RemoteServicePortCancelMessage,
  RemoteServicePortErrorMessage,
  RemoteServicePortResultMessage,
} from "./messagePortServiceTransport.js";

export interface MessagePortServiceCallInput {
  /** 传输层生成的调用包；业务 handler 不得把 callId 当业务幂等键。 */
  message: RemoteServicePortCallMessage;
  /** 调用方撤销或端点失效时自动终止的信号。 */
  signal: AbortSignal;
}

export interface CreateMessagePortServiceProviderOptions {
  /** 与页面服务桥配对的专用双工端口。 */
  port: MessagePort;
  /** 本端产生的握手身份。 */
  handshake: RemoteServiceHandshake;
  /** 初始必须是完整基线快照。 */
  snapshot: RemoteServiceSnapshot;
  /** 具体服务分派；这里不自动重放调用。 */
  handleCall(input: MessagePortServiceCallInput): Promise<unknown>;
  /** dispose 时是否关闭本端端口；默认关闭。 */
  closeOnDispose?: boolean;
  /** wire 消息 codec；默认使用 webloom.remote-service.*。 */
  codec?: RemoteServiceMessageCodec;
}

export interface MessagePortServiceProvider {
  /** 发布同一连接上的下一份连续目录快照。 */
  publishSnapshot(snapshot: RemoteServiceSnapshot): void;
  /** 同步通知消费者撤销当前代理；调用仍由 handler 自己做最终校验。 */
  invalidate(reason?: string): void;
  /** 发送断线控制消息并关闭端点。 */
  disconnect(reason?: string): void;
  /** 撤销未决调用、移除监听器并释放端口。 */
  dispose(): void;
}

function isCallMessage(input: unknown, codec: RemoteServiceMessageCodec): input is RemoteServicePortCallMessage {
  if (!input || typeof input !== "object") return false;
  const message = input as Partial<RemoteServicePortCallMessage>;
  return message.type === codec.type("call")
    && typeof message.callId === "string"
    && message.callId.length > 0
    && typeof message.connectionId === "string"
    && typeof message.providerInstanceId === "string"
    && Boolean(message.reference);
}

function isCancelMessage(input: unknown, codec: RemoteServiceMessageCodec): input is RemoteServicePortCancelMessage {
  if (!input || typeof input !== "object") return false;
  const message = input as Partial<RemoteServicePortCancelMessage>;
  return message.type === codec.type("cancel")
    && typeof message.callId === "string"
    && typeof message.connectionId === "string"
    && typeof message.providerInstanceId === "string";
}

function errorMessage(error: unknown): RemoteServicePortErrorMessage["error"] {
  const candidate = error && typeof error === "object" ? error as { name?: unknown; message?: unknown; code?: unknown } : undefined;
  return {
    ...(typeof candidate?.name === "string" ? { name: candidate.name } : {}),
    message: typeof candidate?.message === "string" ? candidate.message : String(error),
    ...(typeof candidate?.code === "string" ? { code: candidate.code } : {}),
  };
}

function post(port: MessagePort, message: unknown): void {
  try {
    port.postMessage(message);
  } catch {
    // 端口断开后调用方会通过连接状态和超时收敛；不能用异常打断 Worker。
  }
}

/** 创建一个只服务于一条实际 MessagePort 连接的 Provider 端点。 */
export function createMessagePortServiceProvider(
  options: CreateMessagePortServiceProviderOptions
): MessagePortServiceProvider {
  const pending = new Map<string, { controller: AbortController; providerInstanceId: string }>();
  const codec = options.codec ?? createRemoteServiceMessageCodec();
  let activeProviderInstanceIds = new Set(
    options.snapshot.services.map((service) => service.providerInstanceId)
  );
  let disposed = false;

  const sendError = (message: RemoteServicePortCallMessage, error: unknown): void => {
    const response: RemoteServicePortErrorMessage = {
      type: codec.type("error"),
      callId: message.callId,
      connectionId: message.connectionId,
      providerInstanceId: message.providerInstanceId,
      error: errorMessage(error),
    };
    post(options.port, codec.encode(response as unknown as Record<string, unknown>));
  };

  const onMessage = (event: MessageEvent): void => {
    if (disposed) return;
    const decoded = codec.decode(event.data);
    if (isCancelMessage(decoded, codec)) {
      if (decoded.connectionId !== options.handshake.connectionId) return;
      const call = pending.get(decoded.callId);
      if (call?.providerInstanceId === decoded.providerInstanceId) {
        call.controller.abort(new Error("Remote service request cancelled"));
      }
      return;
    }
    if (!isCallMessage(decoded, codec)) return;
    const message = decoded;
    if (message.connectionId !== options.handshake.connectionId) {
      sendError(message, Object.assign(new Error("Remote service connection mismatch"), { code: "service.connection_mismatch" }));
      return;
    }
    // providerInstanceId 由服务引用绑定。不同 Provider 的调用不能共用一条端点。
    if (!activeProviderInstanceIds.has(message.providerInstanceId)) {
      sendError(message, Object.assign(new Error("Remote service provider mismatch"), { code: "service.provider_mismatch" }));
      return;
    }
    if (pending.has(message.callId)) {
      sendError(message, Object.assign(new Error("Remote service callId is duplicated"), { code: "service.duplicate_call" }));
      return;
    }

    const controller = new AbortController();
    pending.set(message.callId, { controller, providerInstanceId: message.providerInstanceId });
    void (async () => {
      try {
        const result = await options.handleCall({ message, signal: controller.signal });
        if (controller.signal.aborted || disposed) return;
        const response: RemoteServicePortResultMessage = {
          type: codec.type("result"),
          callId: message.callId,
          connectionId: message.connectionId,
          providerInstanceId: message.providerInstanceId,
          result,
        };
        post(options.port, codec.encode(response as unknown as Record<string, unknown>));
      } catch (error) {
        if (disposed) return;
        sendError(message, error);
      } finally {
        pending.delete(message.callId);
      }
    })();
  };

  options.port.addEventListener("message", onMessage);
  options.port.start();
  post(options.port, codec.encode({
    type: codec.type("handshake"),
    handshake: options.handshake,
  } satisfies RemoteServicePortControlMessage));
  post(options.port, codec.encode({
    type: codec.type("snapshot"),
    snapshot: options.snapshot,
  } satisfies RemoteServicePortControlMessage));

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    options.port.removeEventListener("message", onMessage);
    for (const { controller } of pending.values()) controller.abort(new Error("Remote service provider disposed"));
    pending.clear();
    if (options.closeOnDispose !== false) options.port.close();
  };

  const provider: MessagePortServiceProvider = {
    publishSnapshot(snapshot) {
      if (disposed) return;
      activeProviderInstanceIds = new Set(
        snapshot.services.map((service) => service.providerInstanceId)
      );
      post(options.port, codec.encode({
        type: codec.type("snapshot"),
        snapshot,
      } satisfies RemoteServicePortControlMessage));
    },
    invalidate(reason = "Remote service invalidated") {
      if (disposed) return;
      // 撤销是同步调用边界：在下一份快照到达前，旧 Provider 实例不能再
      // 接受新请求。否则消费者虽已撤下代理，恶意/迟到的旧报文仍可能
      // 进入 handler；publishSnapshot() 重新建立当前实例后才恢复接收。
      activeProviderInstanceIds = new Set();
      for (const { controller } of pending.values()) controller.abort(new Error(reason));
      post(options.port, codec.encode({
        type: codec.type("invalidate"),
        reason,
      } satisfies RemoteServicePortControlMessage));
    },
    disconnect(reason = "Remote service disconnected") {
      if (disposed) return;
      post(options.port, codec.encode({
        type: codec.type("disconnect"),
        reason,
      } satisfies RemoteServicePortControlMessage));
      dispose();
    },
    dispose,
  };
  return provider;
}
