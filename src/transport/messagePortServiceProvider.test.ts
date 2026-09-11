import { describe, expect, it } from "vitest";
import { defineCapability } from "../contracts/capability.js";
import { WebLoomError } from "../contracts/lifecycle.js";
import {
  RUNTIME_CALL_TYPE,
  RUNTIME_CANCEL_TYPE,
  RUNTIME_ERROR_MESSAGE_TYPE,
  RUNTIME_PROTOCOL_VERSION,
} from "../runtime/runtimeProtocol.js";
import { createMessagePortServiceProvider, type MessagePortServiceCallInput } from "./messagePortServiceProvider.js";
import type { MessagePortLike } from "./messagePortServiceTransport.js";

const Echo = defineCapability({
  kind: "rpc",
  id: "provider.echo",
  version: "1",
  request: { parse(value: unknown): { value: string } { return value as { value: string }; } },
  response: { parse(value: unknown): { result: string } { return value as { result: string }; } },
});
const Events = defineCapability({
  kind: "stream",
  id: "provider.events",
  version: "1",
  request: { parse(value: unknown): { topic: string } { return value as { topic: string }; } },
  item: { parse(value: unknown): number { return value as number; } },
});
const reference = { kind: "rpc" as const, capabilityId: Echo.id, contractVersion: Echo.version, runtime: "shared-worker" as const, runtimeInstanceId: "worker:one", serviceInstanceId: "echo:one", attributes: {} };
const streamReference = { kind: "stream" as const, capabilityId: Events.id, contractVersion: Events.version, runtime: "shared-worker" as const, runtimeInstanceId: "worker:one", serviceInstanceId: "events:one", attributes: {} };

class FakePort implements MessagePortLike {
  readonly sent: unknown[] = [];
  private listener?: (event: MessageEvent) => void;
  addEventListener(_type: "message" | "messageerror", listener: (event: MessageEvent) => void): void { this.listener = listener; }
  removeEventListener(_type: "message" | "messageerror", listener: (event: MessageEvent) => void): void { if (this.listener === listener) this.listener = undefined; }
  postMessage(message: unknown): void { this.sent.push(message); }
  emit(message: unknown): void { this.listener?.({ data: message } as MessageEvent); }
}

function callMessage(callId = "call:one") {
  return { type: RUNTIME_CALL_TYPE, protocolVersion: RUNTIME_PROTOCOL_VERSION, callId, capabilityId: Echo.id, contractVersion: Echo.version, serviceInstanceId: reference.serviceInstanceId, mode: "unary" as const, timeoutMs: 500, request: { value: "ok" } };
}

function streamCallMessage(callId = "stream:one", initialCredit = 1) {
  return { type: RUNTIME_CALL_TYPE, protocolVersion: RUNTIME_PROTOCOL_VERSION, callId, capabilityId: Events.id, contractVersion: Events.version, serviceInstanceId: streamReference.serviceInstanceId, mode: "stream" as const, timeoutMs: 500, request: { topic: "updates" }, initialCredit };
}

describe("v4 MessagePort provider", () => {
  it("ignores old protocol messages and dispatches only exact exposures", async () => {
    const port = new FakePort();
    const provider = createMessagePortServiceProvider({
      port,
      services: () => [reference],
      handleCall: ({ message }: MessagePortServiceCallInput) => ({ result: (message.request as { value: string }).value }),
    });
    const rejectedProtocol = ["webloom.runtime", "v2"].join(".");
    port.emit({ ...callMessage(), type: `${rejectedProtocol}.call`, protocolVersion: rejectedProtocol });
    expect(port.sent).toEqual([]);
    port.emit({ ...callMessage(), serviceInstanceId: "echo:old" });
    await Promise.resolve();
    expect(port.sent.at(-1)).toMatchObject({ type: `${RUNTIME_PROTOCOL_VERSION}.error`, error: { code: "service_stale" } });
    provider.dispose();
  });

  it("aborts an uncooperative handler on cancel and removes the framework record", async () => {
    const port = new FakePort();
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const provider = createMessagePortServiceProvider({
      port,
      services: () => [reference],
      handleCall: async ({ signal }) => {
        entered();
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        throw new WebLoomError("request_cancelled", "cancelled", "dispose");
      },
    });
    const call = callMessage();
    port.emit(call);
    await enteredPromise;
    expect(provider.pendingCount()).toBe(1);
    port.emit({ type: RUNTIME_CANCEL_TYPE, protocolVersion: RUNTIME_PROTOCOL_VERSION, callId: call.callId, serviceInstanceId: call.serviceInstanceId });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(provider.pendingCount()).toBe(0);
    provider.dispose();
  });

  it("keeps a never-settling execution bounded after cancellation", async () => {
    const port = new FakePort();
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const provider = createMessagePortServiceProvider({
      port,
      limits: { maxExecutionSlotsPerPeer: 1, maxExecutionSlotsPerRuntime: 1 },
      services: () => [reference],
      handleCall: async () => {
        entered();
        await new Promise<void>(() => undefined);
      },
    });
    const first = callMessage("call:never");
    port.emit(first);
    await enteredPromise;
    expect(provider.pendingCount()).toBe(1);
    port.emit({ type: RUNTIME_CANCEL_TYPE, protocolVersion: RUNTIME_PROTOCOL_VERSION, callId: first.callId, serviceInstanceId: first.serviceInstanceId });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(provider.pendingCount()).toBe(0);
    expect(provider.executionCount()).toBe(1);
    expect(provider.nonCooperativeExecutionCount()).toBe(1);
    expect(provider.retainedPayloadBytes()).toBeGreaterThan(0);

    port.emit(callMessage("call:blocked"));
    await Promise.resolve();
    expect(port.sent.at(-1)).toMatchObject({ type: RUNTIME_ERROR_MESSAGE_TYPE, error: { code: "resource_limit_exceeded" } });
    expect(provider.executionCount()).toBe(1);
    provider.dispose();
  });

  it("retains an execution slot while an iterator waits for more credit", async () => {
    const port = new FakePort();
    let returned = 0;
    const iterator: AsyncIterator<number> = {
      async next() { return { value: 1, done: false }; },
      async return() { returned += 1; return { value: undefined, done: true }; },
    };
    const provider = createMessagePortServiceProvider({
      port,
      limits: { maxExecutionSlotsPerPeer: 1, maxExecutionSlotsPerRuntime: 1 },
      services: () => [streamReference],
      handleCall: () => ({ [Symbol.asyncIterator]: () => iterator }),
    });
    port.emit(streamCallMessage());
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(port.sent).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: `${RUNTIME_PROTOCOL_VERSION}.result`, streamReady: true }),
      expect.objectContaining({ type: `${RUNTIME_PROTOCOL_VERSION}.next`, sequence: 1 }),
    ]));
    expect(provider.executionCount()).toBe(1);

    port.emit(streamCallMessage("stream:two"));
    await Promise.resolve();
    expect(port.sent.at(-1)).toMatchObject({ type: RUNTIME_ERROR_MESSAGE_TYPE, error: { code: "resource_limit_exceeded" } });
    expect(provider.executionCount()).toBe(1);

    port.emit({ type: RUNTIME_CANCEL_TYPE, protocolVersion: RUNTIME_PROTOCOL_VERSION, callId: "stream:one", serviceInstanceId: streamReference.serviceInstanceId });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(returned).toBe(1);
    expect(provider.executionCount()).toBe(0);
    provider.dispose();
  });

  it("enforces the receiving runtime's stream credit limit", async () => {
    const port = new FakePort();
    let entered = 0;
    const provider = createMessagePortServiceProvider({
      port,
      limits: { maxStreamCredit: 1 },
      services: () => [streamReference],
      handleCall: () => { entered += 1; return { [Symbol.asyncIterator]: async function* () { yield 1; } }; },
    });
    port.emit(streamCallMessage("stream:over-credit", 2));
    await Promise.resolve();
    expect(entered).toBe(0);
    expect(port.sent.at(-1)).toMatchObject({ type: RUNTIME_ERROR_MESSAGE_TYPE, error: { code: "stream_overflow" } });
    expect(provider.executionCount()).toBe(0);
    provider.dispose();
  });
});
