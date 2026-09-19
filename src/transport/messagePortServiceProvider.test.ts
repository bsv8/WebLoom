import { describe, expect, it } from "vitest";
import { defineCapability } from "../contracts/capability.js";
import { WebLoomError } from "../contracts/lifecycle.js";
import {
  RUNTIME_CALL_TYPE,
  RUNTIME_CANCEL_TYPE,
  RUNTIME_CREDIT_TYPE,
  RUNTIME_ERROR_MESSAGE_TYPE,
  RUNTIME_PROTOCOL_VERSION,
  RUNTIME_RESULT_TYPE,
  RUNTIME_NEXT_TYPE,
} from "../runtime/runtimeProtocol.js";
import { createMessagePortServiceProvider, type MessagePortServiceCallInput } from "./messagePortServiceProvider.js";
import type { MessagePortLike } from "./messagePortServiceTransport.js";
import { createRuntimeEndpointSession } from "../runtime/runtimeSession.js";
import { createRuntimeBudget } from "./dto.js";

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
const grantedReference = { ...reference, serviceInstanceId: "echo:grant", grantId: "grant:exact" };
const streamReference = { kind: "stream" as const, capabilityId: Events.id, contractVersion: Events.version, runtime: "shared-worker" as const, runtimeInstanceId: "worker:one", serviceInstanceId: "events:one", attributes: {} };
const callerBinding = { runtimeInstanceId: "window:one", connectionId: "connection:one" } as const;
const wrongBinding = { runtimeInstanceId: "window:other", connectionId: "connection:other" } as const;

class FakePort implements MessagePortLike {
  readonly sent: unknown[] = [];
  private listener?: (event: MessageEvent) => void;
  addEventListener(_type: "message" | "messageerror", listener: (event: MessageEvent) => void): void { this.listener = listener; }
  removeEventListener(_type: "message" | "messageerror", listener: (event: MessageEvent) => void): void { if (this.listener === listener) this.listener = undefined; }
  postMessage(message: unknown): void { this.sent.push(message); }
  emit(message: unknown): void { this.listener?.({ data: message } as MessageEvent); }
}

function callMessage(callId = "call:one", grantId?: string, serviceInstanceId = reference.serviceInstanceId) {
  return { type: RUNTIME_CALL_TYPE, protocolVersion: RUNTIME_PROTOCOL_VERSION, binding: callerBinding, callId, capabilityId: Echo.id, contractVersion: Echo.version, serviceInstanceId, mode: "unary" as const, timeoutMs: 500, request: { value: "ok" }, ...(grantId !== undefined ? { grantId } : {}) };
}

function streamCallMessage(callId = "stream:one", initialCredit = 1, initialByteCredit = 128) {
  return { type: RUNTIME_CALL_TYPE, protocolVersion: RUNTIME_PROTOCOL_VERSION, binding: callerBinding, callId, capabilityId: Events.id, contractVersion: Events.version, serviceInstanceId: streamReference.serviceInstanceId, mode: "stream" as const, timeoutMs: 500, request: { topic: "updates" }, initialCredit, initialByteCredit };
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

  it("requires the exact exposure grant before invoking a handler", async () => {
    const port = new FakePort();
    let executions = 0;
    const provider = createMessagePortServiceProvider({
      port,
      services: () => [grantedReference],
      handleCall: ({ request }) => {
        executions += 1;
        return { result: (request as { value: string }).value };
      },
    });
    port.emit(callMessage("call:grant-missing", undefined, grantedReference.serviceInstanceId));
    await Promise.resolve();
    expect(executions).toBe(0);
    expect(port.sent.at(-1)).toMatchObject({ type: RUNTIME_ERROR_MESSAGE_TYPE, error: { code: "permission_denied" } });
    port.emit(callMessage("call:grant-wrong", "grant:wrong", grantedReference.serviceInstanceId));
    await Promise.resolve();
    expect(executions).toBe(0);
    expect(port.sent.at(-1)).toMatchObject({ type: RUNTIME_ERROR_MESSAGE_TYPE, error: { code: "permission_denied" } });
    port.emit(callMessage("call:grant-exact", "grant:exact", grantedReference.serviceInstanceId));
    await Promise.resolve();
    expect(executions).toBe(1);
    expect(port.sent.at(-1)).toMatchObject({ type: `${RUNTIME_PROTOCOL_VERSION}.result`, result: { result: "ok" } });
    provider.dispose();
  });

  it("terminally closes on a cancel from a different binding without running that cancel against a live call", async () => {
    const port = new FakePort();
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    let aborted = false;
    const session = createRuntimeEndpointSession({ runtimeInstanceId: "worker:one", connectionId: "wrong-cancel" });
    const provider = createMessagePortServiceProvider({
      port,
      binding: session.binding,
      session,
      services: () => [reference],
      handleCall: async ({ signal }) => {
        entered();
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }));
        return { result: "late" };
      },
    });
    const call = callMessage("call:wrong-cancel");
    port.emit(call);
    await enteredPromise;
    port.emit({ type: RUNTIME_CANCEL_TYPE, protocolVersion: RUNTIME_PROTOCOL_VERSION, binding: wrongBinding, callId: call.callId, serviceInstanceId: call.serviceInstanceId });
    expect(provider.endpointState).toBe("closed");
    await Promise.resolve();
    expect(aborted).toBe(true);
    expect(provider.pendingCount()).toBe(0);
    expect(port.sent.some((message) => (message as { type?: unknown }).type === RUNTIME_RESULT_TYPE)).toBe(false);
    provider.dispose();
  });

  it("terminally closes on credit from a different binding without advancing a live stream", async () => {
    const port = new FakePort();
    let nextCalls = 0;
    let returned = 0;
    const iterator: AsyncIterator<number> = {
      async next() { nextCalls += 1; return { value: 1, done: false }; },
      async return() { returned += 1; return { value: undefined, done: true }; },
    };
    const session = createRuntimeEndpointSession({ runtimeInstanceId: "worker:one", connectionId: "wrong-credit" });
    const provider = createMessagePortServiceProvider({
      port,
      binding: session.binding,
      session,
      services: () => [streamReference],
      handleCall: () => ({ [Symbol.asyncIterator]: () => iterator }),
    });
    const call = streamCallMessage("stream:wrong-credit", 1);
    port.emit(call);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(port.sent).toEqual(expect.arrayContaining([expect.objectContaining({ type: RUNTIME_NEXT_TYPE, sequence: 1 })]));
    const before = nextCalls;
    port.emit({ type: RUNTIME_CREDIT_TYPE, protocolVersion: RUNTIME_PROTOCOL_VERSION, binding: wrongBinding, callId: call.callId, serviceInstanceId: call.serviceInstanceId, count: 1 });
    expect(provider.endpointState).toBe("closed");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(nextCalls).toBe(before);
    expect(returned).toBe(1);
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
    port.emit({ type: RUNTIME_CANCEL_TYPE, protocolVersion: RUNTIME_PROTOCOL_VERSION, binding: callerBinding, callId: call.callId, serviceInstanceId: call.serviceInstanceId });
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
    port.emit({ type: RUNTIME_CANCEL_TYPE, protocolVersion: RUNTIME_PROTOCOL_VERSION, binding: callerBinding, callId: first.callId, serviceInstanceId: first.serviceInstanceId });
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

  it("waits for a cooperative handler to finish after the synchronous close fence", async () => {
    const port = new FakePort();
    const session = createRuntimeEndpointSession({ runtimeInstanceId: "worker:one", connectionId: "provider:cooperative" });
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const provider = createMessagePortServiceProvider({
      port,
      binding: session.binding,
      session,
      services: () => [reference],
      handleCall: async ({ signal }) => {
        entered();
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        return { result: "cancelled-after-close" };
      },
    });
    const call = callMessage("call:cooperative-close");
    port.emit(call);
    await enteredPromise;
    provider.beginClose("test cooperative close");
    expect(provider.endpointState).toBe("closing");
    expect(provider.pendingCount()).toBe(0);
    const result = await provider.drain(100);
    expect(result).toMatchObject({ state: "closing", drained: true, timedOut: false, pendingExecutions: 0 });
    expect(provider.executionCount()).toBe(0);
    provider.dispose();
  });

  it("reports a non-cooperative execution slot when bounded drain times out", async () => {
    const port = new FakePort();
    const session = createRuntimeEndpointSession({ runtimeInstanceId: "worker:one", connectionId: "provider:non-cooperative" });
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const provider = createMessagePortServiceProvider({
      port,
      binding: session.binding,
      session,
      services: () => [reference],
      handleCall: async () => {
        entered();
        await new Promise<void>(() => undefined);
      },
    });
    port.emit(callMessage("call:non-cooperative-close"));
    await enteredPromise;
    provider.beginClose("test non-cooperative close");
    const result = await provider.drain(10);
    expect(result).toMatchObject({ state: "closing", drained: false, timedOut: true, pendingExecutions: 1 });
    expect(provider.pendingCount()).toBe(0);
    expect(provider.executionCount()).toBe(1);
    provider.dispose();
  });

  it("drops a late unary result after close instead of publishing it", async () => {
    const port = new FakePort();
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const resultGate = new Promise<void>((resolve) => { release = resolve; });
    const session = createRuntimeEndpointSession({ runtimeInstanceId: "worker:one", connectionId: "late-unary" });
    const provider = createMessagePortServiceProvider({
      port,
      binding: session.binding,
      session,
      services: () => [reference],
      handleCall: async () => {
        entered();
        await resultGate;
        return { result: "late" };
      },
    });
    port.emit(callMessage("call:late-unary"));
    await enteredPromise;
    provider.beginClose("test late unary");
    expect(provider.pendingCount()).toBe(0);
    release();
    await expect(provider.drain(100)).resolves.toMatchObject({ drained: true, timedOut: false, pendingExecutions: 0 });
    await Promise.resolve();
    expect(port.sent.some((message) => (message as { type?: unknown }).type === RUNTIME_RESULT_TYPE)).toBe(false);
    provider.dispose();
  });

  it("drops a late stream iterable after close instead of publishing ready or items", async () => {
    const port = new FakePort();
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const resultGate = new Promise<void>((resolve) => { release = resolve; });
    const session = createRuntimeEndpointSession({ runtimeInstanceId: "worker:one", connectionId: "late-stream" });
    const provider = createMessagePortServiceProvider({
      port,
      binding: session.binding,
      session,
      services: () => [streamReference],
      handleCall: async () => {
        entered();
        await resultGate;
        return { [Symbol.asyncIterator]: async function* () { yield 1; } };
      },
    });
    port.emit(streamCallMessage("stream:late"));
    await enteredPromise;
    provider.beginClose("test late stream");
    release();
    await expect(provider.drain(100)).resolves.toMatchObject({ drained: true, timedOut: false, pendingExecutions: 0 });
    await Promise.resolve();
    expect(port.sent.some((message) => {
      const type = (message as { type?: unknown }).type;
      return type === RUNTIME_RESULT_TYPE || type === RUNTIME_NEXT_TYPE;
    })).toBe(false);
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

    port.emit({ type: RUNTIME_CANCEL_TYPE, protocolVersion: RUNTIME_PROTOCOL_VERSION, binding: callerBinding, callId: "stream:one", serviceInstanceId: streamReference.serviceInstanceId });
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

  it("uses a safe default byte window when only retained runtime capacity is tightened", async () => {
    const port = new FakePort();
    const budget = createRuntimeBudget({ maxRetainedPayloadBytesPerRuntime: 1_024 });
    const provider = createMessagePortServiceProvider({
      port,
      budget,
      services: () => [streamReference],
      handleCall: () => (async function* () { yield 1; })(),
    });
    const call = streamCallMessage("stream:small-runtime-budget");
    port.emit(call);
    for (let attempt = 0; attempt < 20 && !port.sent.some((message) => (message as { type?: unknown }).type === RUNTIME_RESULT_TYPE); attempt += 1) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(port.sent).toEqual(expect.arrayContaining([expect.objectContaining({ type: RUNTIME_RESULT_TYPE, streamReady: true })]));
    expect(port.sent).not.toEqual(expect.arrayContaining([expect.objectContaining({ type: RUNTIME_ERROR_MESSAGE_TYPE, error: { code: "resource_limit_exceeded" } })]));
    expect(budget.reservedStreamByteCredit).toBeGreaterThan(0);
    expect(budget.reservedStreamByteCredit).toBeLessThanOrEqual(1_024);
    port.emit({ type: RUNTIME_CANCEL_TYPE, protocolVersion: RUNTIME_PROTOCOL_VERSION, binding: callerBinding, callId: call.callId, serviceInstanceId: call.serviceInstanceId });
    for (let attempt = 0; attempt < 20 && provider.executionCount() !== 0; attempt += 1) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(budget.reservedStreamByteCredit).toBe(0);
    provider.dispose();
  });

  it("rechecks a parser's in-place normalized graph instead of reusing raw stats", async () => {
    const port = new FakePort();
    let entered = 0;
    const provider = createMessagePortServiceProvider({
      port,
      limits: { maxDtoDepth: 3 },
      services: () => [reference],
      prepareRequest: (call) => {
        let nested: unknown = "deep";
        for (let depth = 0; depth < 5; depth += 1) nested = { next: nested };
        (call.request as Record<string, unknown>).extra = nested;
        return { value: call.request };
      },
      handleCall: () => { entered += 1; return { result: "unexpected" }; },
    });
    port.emit(callMessage("call:in-place"));
    await Promise.resolve();
    expect(entered).toBe(0);
    expect(port.sent.at(-1)).toMatchObject({ type: RUNTIME_ERROR_MESSAGE_TYPE, error: { code: "resource_limit_exceeded" } });
    expect(provider.executionCount()).toBe(0);
    provider.dispose();
  });

  it("releases pending output bytes and stream window after cancellation", async () => {
    const port = new FakePort();
    const provider = createMessagePortServiceProvider({
      port,
      services: () => [streamReference],
      handleCall: () => (async function* () {
        yield "a".repeat(20);
        yield "b".repeat(20);
      })(),
      prepareItem: (value) => ({ value }),
    });
    port.emit(streamCallMessage("stream:pending-output", 2, 60));
    for (let attempt = 0; attempt < 20 && !port.sent.some((message) => (message as { type?: unknown }).type === RUNTIME_NEXT_TYPE); attempt += 1) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(port.sent.some((message) => (message as { type?: unknown }).type === RUNTIME_NEXT_TYPE)).toBe(true);
    expect(provider.retainedPayloadBytes()).toBeGreaterThan(0);
    port.emit({ type: RUNTIME_CANCEL_TYPE, protocolVersion: RUNTIME_PROTOCOL_VERSION, binding: callerBinding, callId: "stream:pending-output", serviceInstanceId: streamReference.serviceInstanceId });
    for (let attempt = 0; attempt < 20 && provider.executionCount() !== 0; attempt += 1) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(provider.executionCount()).toBe(0);
    expect(provider.retainedPayloadBytes()).toBe(0);
    provider.dispose();
  });

  it("releases stream admission when the handler fails before streamReady", async () => {
    const port = new FakePort();
    const budget = createRuntimeBudget({ maxActiveStreamsPerRuntime: 1 });
    const provider = createMessagePortServiceProvider({
      port,
      budget,
      services: () => [streamReference],
      handleCall: () => { throw new Error("stream setup failed"); },
    });
    port.emit(streamCallMessage("stream:handler-error", 1, 128));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(port.sent.at(-1)).toMatchObject({ type: RUNTIME_ERROR_MESSAGE_TYPE, error: { code: "handler_failed" } });
    expect(budget.activeStreams).toBe(0);
    expect(budget.reservedStreamByteCredit).toBe(0);
    expect(provider.executionCount()).toBe(0);
    provider.dispose();
  });

  it("releases stream admission when the handler returns a non-AsyncIterable", async () => {
    const port = new FakePort();
    const budget = createRuntimeBudget({ maxActiveStreamsPerRuntime: 1 });
    const provider = createMessagePortServiceProvider({
      port,
      budget,
      services: () => [streamReference],
      handleCall: () => ({ not: "a stream" }),
    });
    port.emit(streamCallMessage("stream:not-iterable", 1, 128));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(port.sent.at(-1)).toMatchObject({ type: RUNTIME_ERROR_MESSAGE_TYPE, error: { code: "handler_failed" } });
    expect(budget.activeStreams).toBe(0);
    expect(budget.reservedStreamByteCredit).toBe(0);
    expect(provider.executionCount()).toBe(0);
    provider.dispose();
  });

  it("releases pre-ready stream admission on cancel after a non-cooperative handler finally returns", async () => {
    const port = new FakePort();
    const budget = createRuntimeBudget({ maxActiveStreamsPerRuntime: 1 });
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const provider = createMessagePortServiceProvider({
      port,
      budget,
      services: () => [streamReference],
      handleCall: async () => {
        entered();
        await gate;
        return { [Symbol.asyncIterator]: async function* () { yield 1; } };
      },
    });
    const call = streamCallMessage("stream:cancel-before-ready", 1, 128);
    port.emit(call);
    await enteredPromise;
    expect(budget.activeStreams).toBe(1);
    expect(budget.reservedStreamByteCredit).toBe(128);
    port.emit({ type: RUNTIME_CANCEL_TYPE, protocolVersion: RUNTIME_PROTOCOL_VERSION, binding: callerBinding, callId: call.callId, serviceInstanceId: call.serviceInstanceId });
    expect(provider.pendingCount()).toBe(0);
    expect(budget.activeStreams).toBe(0);
    expect(budget.reservedStreamByteCredit).toBe(0);
    release();
    for (let attempt = 0; attempt < 20 && provider.executionCount() !== 0; attempt += 1) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(provider.executionCount()).toBe(0);
    expect(budget.activeStreams).toBe(0);
    expect(budget.reservedStreamByteCredit).toBe(0);
    provider.dispose();
  });

  it("counts pre-ready streams against the peer active-stream limit", async () => {
    const port = new FakePort();
    const budget = createRuntimeBudget({ maxActiveStreamsPerPeer: 1, maxActiveStreamsPerRuntime: 2 });
    let entered = 0;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const provider = createMessagePortServiceProvider({
      port,
      budget,
      services: () => [streamReference],
      handleCall: async () => {
        entered += 1;
        if (entered === 1) await firstGate;
        return { [Symbol.asyncIterator]: async function* () { yield 1; } };
      },
    });
    const first = streamCallMessage("stream:peer-limit:first");
    port.emit(first);
    for (let attempt = 0; attempt < 20 && entered !== 1; attempt += 1) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(entered).toBe(1);
    expect(provider.pendingCount()).toBe(1);
    expect(provider.executionCount()).toBe(1);

    const second = streamCallMessage("stream:peer-limit:second");
    port.emit(second);
    await Promise.resolve();
    expect(entered).toBe(1);
    expect(port.sent).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: RUNTIME_ERROR_MESSAGE_TYPE, callId: second.callId, error: expect.objectContaining({ code: "resource_limit_exceeded" }) }),
    ]));
    expect(provider.pendingCount()).toBe(1);
    expect(provider.executionCount()).toBe(1);

    releaseFirst();
    for (let attempt = 0; attempt < 20 && !port.sent.some((message) => (message as { callId?: unknown; streamReady?: unknown }).callId === first.callId && (message as { streamReady?: unknown }).streamReady === true); attempt += 1) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(port.sent).toEqual(expect.arrayContaining([expect.objectContaining({ type: RUNTIME_RESULT_TYPE, callId: first.callId, streamReady: true })]));

    port.emit({ type: RUNTIME_CANCEL_TYPE, protocolVersion: RUNTIME_PROTOCOL_VERSION, binding: callerBinding, callId: first.callId, serviceInstanceId: streamReference.serviceInstanceId });
    for (let attempt = 0; attempt < 20 && provider.executionCount() !== 0; attempt += 1) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(provider.executionCount()).toBe(0);

    const third = streamCallMessage("stream:peer-limit:third");
    port.emit(third);
    for (let attempt = 0; attempt < 20 && entered !== 2; attempt += 1) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(entered).toBe(2);
    for (let attempt = 0; attempt < 20 && !port.sent.some((message) => {
      const value = message as { callId?: unknown; streamReady?: unknown };
      return value.callId === third.callId && value.streamReady === true;
    }); attempt += 1) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(port.sent.some((message) => {
      const value = message as { callId?: unknown; streamReady?: unknown };
      return value.callId === third.callId && value.streamReady === true;
    })).toBe(true);

    port.emit({ type: RUNTIME_CANCEL_TYPE, protocolVersion: RUNTIME_PROTOCOL_VERSION, binding: callerBinding, callId: third.callId, serviceInstanceId: streamReference.serviceInstanceId });
    for (let attempt = 0; attempt < 20 && provider.executionCount() !== 0; attempt += 1) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(provider.executionCount()).toBe(0);
    expect(budget.activeStreams).toBe(0);
    provider.dispose();
  });
});
