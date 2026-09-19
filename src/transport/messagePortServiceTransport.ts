// MessagePort 到 v4 RuntimeTransport 的唯一适配。

import type { RuntimeReceiveMetadata, RuntimeTransport } from "./serviceBridge.js";
import type { RuntimeDecodedPayload, RuntimeWireMessage } from "../runtime/runtimeProtocol.js";
import { createReceivePortLedger, normalizeRuntimeLimits, type RuntimeLimitsInput } from "./dto.js";
import { WebLoomError } from "../contracts/lifecycle.js";
import { createRuntimeMessageCodec } from "../runtime/runtimeProtocol.js";

export interface MessagePortLike {
  addEventListener(type: "message" | "messageerror", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "message" | "messageerror", listener: (event: MessageEvent) => void): void;
  postMessage(message: unknown, transfer?: readonly Transferable[]): void;
  start?(): void;
  close?(): void;
}

type RuntimeMessageType = RuntimeWireMessage["type"];
type RuntimeMessageListener = (message: RuntimeWireMessage, metadata?: RuntimeReceiveMetadata) => void;

/**
 * 一个物理 endpoint 的内部分派器：codec/ledger 只执行一次，再按 wire type
 * 把控制面或二进制数据面送到真正拥有它的 listener。
 */
class RuntimeEndpointDispatcher {
  private readonly all = new Set<RuntimeMessageListener>();
  private readonly byType = new Map<RuntimeMessageType, Set<RuntimeMessageListener>>();

  subscribe(listener: RuntimeMessageListener): () => void {
    this.all.add(listener);
    return () => this.all.delete(listener);
  }

  subscribeByType(types: readonly RuntimeMessageType[], listener: RuntimeMessageListener): () => void {
    const registered: RuntimeMessageType[] = [];
    for (const type of new Set(types)) {
      const listeners = this.byType.get(type) ?? new Set<RuntimeMessageListener>();
      listeners.add(listener);
      this.byType.set(type, listeners);
      registered.push(type);
    }
    return () => {
      for (const type of registered) {
        const listeners = this.byType.get(type);
        if (!listeners) continue;
        listeners.delete(listener);
        if (listeners.size === 0) this.byType.delete(type);
      }
    };
  }

  dispatch(message: RuntimeWireMessage, metadata: RuntimeReceiveMetadata): boolean {
    const listeners = new Set<RuntimeMessageListener>(this.all);
    for (const listener of this.byType.get(message.type) ?? []) listeners.add(listener);
    for (const listener of [...listeners]) {
      try { listener(message, metadata); } catch { /* observer isolation */ }
    }
    return listeners.size > 0;
  }

  clear(): void {
    this.all.clear();
    this.byType.clear();
  }
}

/** 将一个真实 MessagePort 绑定为双向 v4 transport。 */
export function createMessagePortRuntimeTransport(port: MessagePortLike, options: { readonly limits?: RuntimeLimitsInput } = {}): RuntimeTransport {
  const dispatcher = new RuntimeEndpointDispatcher();
  const errorListeners = new Set<(error: unknown, metadata?: RuntimeReceiveMetadata) => void>();
  const limits = normalizeRuntimeLimits(options.limits);
  const codec = createRuntimeMessageCodec({ limits });
  const onMessage = (event: MessageEvent): void => {
    const ledger = createReceivePortLedger(event.ports ?? [], { limits, phase: "receive" });
    const baseMetadata = { ports: ledger.ports, ledger, decoded: true } satisfies RuntimeReceiveMetadata;
    const metadata: RuntimeReceiveMetadata = Object.freeze(baseMetadata);
    if (!ledger.valid) {
      const error = new WebLoomError("transfer_invalid", "Invalid received transfer metadata", "receive");
      for (const listener of [...errorListeners]) {
        try { listener(error, metadata); } catch { /* observer isolation */ }
      }
      return;
    }
    let message: RuntimeWireMessage;
    let payload: RuntimeDecodedPayload | undefined;
    try {
      const decoded = codec.decodeWithStats(event.data);
      message = decoded.message;
      payload = decoded.payload;
    }
    catch (error) {
      ledger.closeUndelivered();
      for (const listener of [...errorListeners]) {
        try { listener(error, metadata); } catch { /* observer isolation */ }
      }
      return;
    }
    const decodedMetadata: RuntimeReceiveMetadata = payload
      ? Object.freeze({ ...baseMetadata, payload })
      : metadata;
    if (!dispatcher.dispatch(message, decodedMetadata)) ledger.closeUndelivered();
  };
  port.addEventListener("message", onMessage);
  port.start?.();
  let closed = false;
  return {
    send(message, transfer) {
      if (closed) throw new Error("MessagePort transport is closed");
      port.postMessage(message, transfer);
    },
    subscribe(listener) { return dispatcher.subscribe(listener); },
    subscribeByType(types, listener) { return dispatcher.subscribeByType(types, listener); },
    subscribeError(listener) { errorListeners.add(listener); return () => errorListeners.delete(listener); },
    close() { if (closed) return; closed = true; port.removeEventListener("message", onMessage); port.close?.(); dispatcher.clear(); errorListeners.clear(); },
  };
}
