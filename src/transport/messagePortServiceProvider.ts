// MessagePort Provider。
//
// Provider 不发送握手、目录或失效控制包。Runtime Host 是完整快照的唯一
// 发布者；Provider 只维护自己端点的权威目录，按 call 中的精确标识重新
// 查找服务，并把取消传给当前 handler。

import type {
  RemoteServiceMessageCodec,
  RemoteServiceReference,
} from "../contracts/lifecycle.js";
import {
  createRemoteServiceMessageCodec,
  RemoteServiceError,
} from "../contracts/lifecycle.js";
import type {
  MessagePortServiceCallInput,
  RemoteServicePortCallMessage,
  RemoteServicePortCancelMessage,
  RemoteServicePortErrorMessage,
  RemoteServicePortResultMessage,
} from "./messagePortServiceTransport.js";

export interface CreateMessagePortServiceProviderOptions {
  /** 与页面服务桥配对的专用双工端口。 */
  port: MessagePort;
  /** Provider 的本地权威目录；不会采信客户端回传的完整 reference。 */
  services?: () => readonly RemoteServiceReference[];
  /** 具体服务分派；这里不自动重放调用。 */
  handleCall(input: MessagePortServiceCallInput): Promise<unknown>;
  /** dispose 时是否关闭本端端口；默认关闭。 */
  closeOnDispose?: boolean;
  /** wire 消息 codec；默认 webloom.remote-service.v2。 */
  codec?: RemoteServiceMessageCodec;
}

export interface MessagePortServiceProvider {
  /** 替换 Provider 本地权威目录；不产生 wire 控制消息。 */
  setServices(services: readonly RemoteServiceReference[]): void;
  /** 同步停止新调用并 abort 当前 handler。 */
  revoke(reason?: string): void;
  /** 移除监听器并释放端口；不发送断开控制包。 */
  dispose(): void;
}

function isCallMessage(input: unknown, codec: RemoteServiceMessageCodec): input is RemoteServicePortCallMessage {
  if (!input || typeof input !== "object") return false;
  const message = input as Partial<RemoteServicePortCallMessage>;
  return message.type === codec.type("call")
    && typeof message.protocolVersion === "string"
    && typeof message.callId === "string"
    && message.callId.length > 0
    && typeof message.capabilityId === "string"
    && typeof message.contractVersion === "string"
    && typeof message.serviceInstanceId === "string";
}

function isCancelMessage(input: unknown, codec: RemoteServiceMessageCodec): input is RemoteServicePortCancelMessage {
  if (!input || typeof input !== "object") return false;
  const message = input as Partial<RemoteServicePortCancelMessage>;
  return message.type === codec.type("cancel")
    && typeof message.protocolVersion === "string"
    && typeof message.callId === "string"
    && typeof message.serviceInstanceId === "string";
}

function errorMessage(error: unknown): RemoteServicePortErrorMessage["error"] {
  const candidate = error && typeof error === "object"
    ? error as { name?: unknown; message?: unknown; code?: unknown; details?: unknown }
    : undefined;
  const code = typeof candidate?.code === "string" && candidate.code.length > 0
    ? candidate.code
    : "handler_failed";
  return {
    ...(typeof candidate?.name === "string" ? { name: candidate.name } : {}),
    message: typeof candidate?.message === "string" ? candidate.message : String(error),
    code,
    ...(candidate?.details && typeof candidate.details === "object" && !Array.isArray(candidate.details)
      ? { details: candidate.details as Readonly<Record<string, unknown>> }
      : {}),
  };
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)]),
  );
}

function bindingKey(reference: Pick<RemoteServiceReference, "capabilityId" | "contractVersion" | "runtime" | "runtimeInstanceId" | "serviceInstanceId">): string {
  return [
    reference.capabilityId,
    reference.contractVersion,
    reference.runtime,
    reference.runtimeInstanceId,
    reference.serviceInstanceId,
  ].join("\u0000");
}

function referenceFingerprint(reference: RemoteServiceReference): string {
  return JSON.stringify({
    ...reference,
    attributes: stableValue(reference.attributes),
  });
}

interface ServiceBinding {
  readonly reference: RemoteServiceReference;
  readonly epoch: number;
}

interface PendingCall {
  readonly message: RemoteServicePortCallMessage;
  readonly controller: AbortController;
  readonly serviceInstanceId: string;
  readonly bindingKey: string;
  readonly bindingEpoch: number;
}

function postBestEffort(port: MessagePort, message: unknown): void {
  try { port.postMessage(message); } catch { /* 端口关闭时由调用方 deadline 收敛 */ }
}

/** 创建一条只服务于当前 MessagePort 的 Provider 端点。 */
export function createMessagePortServiceProvider(
  options: CreateMessagePortServiceProviderOptions,
): MessagePortServiceProvider {
  const pending = new Map<string, PendingCall>();
  const codec = options.codec ?? createRemoteServiceMessageCodec();
  let services = [...(options.services?.() ?? [])];
  let bindings = new Map<string, ServiceBinding>();
  let nextBindingEpoch = 0;
  let revoked = false;
  let disposed = false;

  const buildBindings = (nextServices: readonly RemoteServiceReference[]): Map<string, ServiceBinding> => {
    const nextBindings = new Map<string, ServiceBinding>();
    for (const reference of nextServices) {
      const key = bindingKey(reference);
      const previous = bindings.get(key);
      const epoch = previous && referenceFingerprint(previous.reference) === referenceFingerprint(reference)
        ? previous.epoch
        : ++nextBindingEpoch;
      nextBindings.set(key, { reference, epoch });
    }
    return nextBindings;
  };

  const isCurrent = (callId: string, call: PendingCall): boolean => {
    const current = bindings.get(call.bindingKey);
    return !disposed
      && !revoked
      && pending.get(callId) === call
      && current?.epoch === call.bindingEpoch
      && current.reference.serviceInstanceId === call.serviceInstanceId;
  };

  const revokeReplacedCalls = (nextBindings: ReadonlyMap<string, ServiceBinding>): void => {
    for (const call of pending.values()) {
      const next = nextBindings.get(call.bindingKey);
      if (!next || next.epoch !== call.bindingEpoch) {
        sendError(call.message, new RemoteServiceError("service_revoked", "Remote service binding was replaced"));
        call.controller.abort(new RemoteServiceError("service_revoked", "Remote service binding was replaced"));
      }
    }
  };

  bindings = buildBindings(services);

  const sendError = (message: RemoteServicePortCallMessage, error: unknown): void => {
    const response: RemoteServicePortErrorMessage = {
      type: codec.type("error"),
      protocolVersion: codec.protocolVersion,
      callId: message.callId,
      serviceInstanceId: message.serviceInstanceId,
      error: errorMessage(error),
    };
    postBestEffort(options.port, codec.encode(response as unknown as Record<string, unknown>));
  };

  const onMessage = (event: MessageEvent): void => {
    if (disposed) return;
    const decoded = codec.decode(event.data);
    if (isCancelMessage(decoded, codec)) {
      if (decoded.protocolVersion !== codec.protocolVersion) return;
      const call = pending.get(decoded.callId);
      if (call?.serviceInstanceId === decoded.serviceInstanceId) {
        call.controller.abort(new RemoteServiceError("request_cancelled", "Remote service request cancelled"));
      }
      return;
    }
    if (!isCallMessage(decoded, codec)) return;
    const message = decoded;
    if (message.protocolVersion !== codec.protocolVersion) {
      sendError(message, new RemoteServiceError("protocol_mismatch", "Remote service protocol version mismatch"));
      return;
    }
    if (revoked) {
      sendError(message, new RemoteServiceError("service_revoked", "Remote service Provider has been revoked"));
      return;
    }
    const reference = services.find((candidate) => candidate.status === "ready"
      && candidate.capabilityId === message.capabilityId
      && candidate.contractVersion === message.contractVersion
      && candidate.serviceInstanceId === message.serviceInstanceId);
    if (!reference) {
      sendError(message, new RemoteServiceError("service_stale", "Remote service instance is stale or unavailable"));
      return;
    }
    if (pending.has(message.callId)) {
      sendError(message, new RemoteServiceError("handler_failed", "Remote service callId is duplicated"));
      return;
    }
    const controller = new AbortController();
    const currentBindingKey = bindingKey(reference);
    const currentBinding = bindings.get(currentBindingKey);
    if (!currentBinding || currentBinding.reference !== reference) {
      sendError(message, new RemoteServiceError("service_stale", "Remote service binding changed"));
      return;
    }
    const call: PendingCall = {
      message,
      controller,
      serviceInstanceId: message.serviceInstanceId,
      bindingKey: currentBindingKey,
      bindingEpoch: currentBinding.epoch,
    };
    pending.set(message.callId, call);
    void (async () => {
      try {
        const result = await options.handleCall({ message, reference, signal: controller.signal });
        if (controller.signal.aborted || !isCurrent(message.callId, call)) return;
        const response: RemoteServicePortResultMessage = {
          type: codec.type("result"),
          protocolVersion: codec.protocolVersion,
          callId: message.callId,
          serviceInstanceId: message.serviceInstanceId,
          result,
        };
        postBestEffort(options.port, codec.encode(response as unknown as Record<string, unknown>));
      } catch (error) {
        if (controller.signal.aborted || !isCurrent(message.callId, call)) return;
        sendError(message, error);
      } finally {
        if (pending.get(message.callId) === call) pending.delete(message.callId);
      }
    })();
  };

  options.port.addEventListener("message", onMessage);
  options.port.start();

  const provider: MessagePortServiceProvider = {
    setServices(nextServices): void {
      if (disposed) return;
      const next = [...nextServices];
      const nextBindings = buildBindings(next);
      // Withdraw the old directory first. Abort is synchronous; a handler that
      // ignores AbortSignal is fenced again by isCurrent() before any response.
      revoked = true;
      revokeReplacedCalls(nextBindings);
      services = next;
      bindings = nextBindings;
      revoked = false;
    },
    revoke(reason = "Remote service Provider revoked"): void {
      if (disposed) return;
      revoked = true;
      for (const call of pending.values()) {
        sendError(call.message, new RemoteServiceError("service_revoked", reason));
        call.controller.abort(new RemoteServiceError("service_revoked", reason));
      }
      services = [];
      bindings = new Map();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      revoked = true;
      options.port.removeEventListener("message", onMessage);
      for (const { controller } of pending.values()) {
        controller.abort(new RemoteServiceError("transport_unavailable", "Remote service Provider disposed"));
      }
      pending.clear();
      services = [];
      bindings = new Map();
      if (options.closeOnDispose !== false) {
        try { options.port.close(); } catch { /* noop */ }
      }
    },
  };
  return provider;
}
