// MessagePort 到 v4 RuntimeTransport 的唯一适配。

import type { RuntimeReceiveMetadata, RuntimeTransport } from "./serviceBridge.js";
import type { RuntimeWireMessage } from "../runtime/runtimeProtocol.js";
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

/** 将一个真实 MessagePort 绑定为双向 v4 transport。 */
export function createMessagePortRuntimeTransport(port: MessagePortLike, options: { readonly limits?: RuntimeLimitsInput } = {}): RuntimeTransport {
  const listeners = new Set<(message: RuntimeWireMessage, metadata?: RuntimeReceiveMetadata) => void>();
  const errorListeners = new Set<(error: unknown, metadata?: RuntimeReceiveMetadata) => void>();
  const codec = createRuntimeMessageCodec();
  const limits = normalizeRuntimeLimits(options.limits);
  const onMessage = (event: MessageEvent): void => {
    const ledger = createReceivePortLedger(event.ports ?? [], { limits, phase: "receive" });
    const metadata: RuntimeReceiveMetadata = Object.freeze({
      ports: ledger.ports,
      ledger,
      decoded: true,
    });
    if (!ledger.valid) {
      const error = new WebLoomError("transfer_invalid", "Invalid received transfer metadata", "receive");
      for (const listener of [...errorListeners]) {
        try { listener(error, metadata); } catch { /* observer isolation */ }
      }
      return;
    }
    let message: RuntimeWireMessage;
    try { message = codec.decode(event.data); }
    catch (error) {
      ledger.closeUndelivered();
      for (const listener of [...errorListeners]) {
        try { listener(error, metadata); } catch { /* observer isolation */ }
      }
      return;
    }
    for (const listener of [...listeners]) {
      try { listener(message, metadata); } catch { /* observer isolation */ }
    }
  };
  port.addEventListener("message", onMessage);
  port.start?.();
  let closed = false;
  return {
    send(message, transfer) {
      if (closed) throw new Error("MessagePort transport is closed");
      port.postMessage(message, transfer);
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    subscribeError(listener) { errorListeners.add(listener); return () => errorListeners.delete(listener); },
    close() { if (closed) return; closed = true; port.removeEventListener("message", onMessage); port.close?.(); listeners.clear(); errorListeners.clear(); },
  };
}
