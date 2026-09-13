import { describe, expect, it } from "vitest";
import { defineCapability } from "../contracts/capability.js";
import { WebLoomError } from "../contracts/lifecycle.js";
import { createFakeRuntimeTransport } from "../testing/fakes.js";
import {
  RUNTIME_CALL_TYPE,
  RUNTIME_CANCEL_TYPE,
  RUNTIME_CLOSE_ACK_TYPE,
  RUNTIME_CLOSE_TYPE,
  RUNTIME_CREDIT_TYPE,
  RUNTIME_NEXT_TYPE,
  RUNTIME_PROTOCOL_VERSION,
  RUNTIME_RESULT_TYPE,
  RUNTIME_SNAPSHOT_TYPE,
  type RuntimeSnapshotMessage,
} from "../runtime/runtimeProtocol.js";
import { createRuntimeBudget } from "./dto.js";
import { createCapabilityBridge } from "./serviceBridge.js";
import { createMessagePortRuntimeTransport } from "./messagePortServiceTransport.js";
import { createRuntimeEndpointSession } from "../runtime/runtimeSession.js";

const Echo = defineCapability({
  kind: "rpc",
  id: "bridge.echo",
  version: "1",
  request: { parse(value: unknown): { value: string } {
    if (!value || typeof value !== "object" || typeof (value as { value?: unknown }).value !== "string") throw new Error("invalid request");
    return value as { value: string };
  } },
  response: { parse(value: unknown): { result: string } {
    if (!value || typeof value !== "object" || typeof (value as { result?: unknown }).result !== "string") throw new Error("invalid response");
    return value as { result: string };
  } },
});
const Events = defineCapability({
  kind: "stream",
  id: "bridge.events",
  version: "1",
  request: { parse(value: unknown): { topic: string } {
    if (!value || typeof value !== "object" || typeof (value as { topic?: unknown }).topic !== "string") throw new Error("invalid request");
    return value as { topic: string };
  } },
  item: { parse(value: unknown): number {
    if (!Number.isInteger(value)) throw new Error("invalid item");
    return value as number;
  } },
});

const remoteBinding = { runtimeInstanceId: "worker:one", connectionId: "direct:worker:one" } as const;
const wrongBinding = { runtimeInstanceId: "worker:other", connectionId: "direct:worker:other" } as const;

function snapshot(serviceInstanceId = "service:one", revision = 1): RuntimeSnapshotMessage {
  return {
    type: RUNTIME_SNAPSHOT_TYPE,
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    runtimeId: "worker",
    runtimeKind: "shared-worker",
    runtimeInstanceId: "worker:one",
    revision,
    state: "ready",
    units: [],
    services: [{ kind: "rpc", capabilityId: Echo.id, contractVersion: Echo.version, serviceInstanceId, attributes: {} }],
    binding: remoteBinding,
  };
}

function snapshotWithGrant(grantId: string): RuntimeSnapshotMessage {
  const base = snapshot();
  return { ...base, services: [{ ...base.services[0]!, grantId }] };
}

function streamSnapshot(revision = 1): RuntimeSnapshotMessage {
  return {
    type: RUNTIME_SNAPSHOT_TYPE,
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    runtimeId: "worker",
    runtimeKind: "shared-worker",
    runtimeInstanceId: "worker:one",
    revision,
    state: "ready",
    units: [],
    services: [{ kind: "stream", capabilityId: Events.id, contractVersion: Events.version, serviceInstanceId: "events:one", attributes: {} }],
    binding: remoteBinding,
  };
}

describe("v4 capability bridge", () => {
  it("waits for exact service identity and validates both wire edges", async () => {
    const transport = createFakeRuntimeTransport();
    const bridge = createCapabilityBridge({ transport, remoteRuntimeKind: "shared-worker", remoteRuntimeId: "worker" });
    expect(bridge.applySnapshot(snapshot())).toMatchObject({ accepted: true, revision: 1 });
    const promise = bridge.getClient(Echo).call({ value: "hello" }, { operationId: "op-1" });
    const sent = transport.sent.at(-1)?.message;
    expect(sent).toMatchObject({ type: RUNTIME_CALL_TYPE, capabilityId: Echo.id, serviceInstanceId: "service:one", operationId: "op-1" });
    if (!sent || sent.type !== RUNTIME_CALL_TYPE) throw new Error("call was not sent");
    transport.emit({ type: RUNTIME_RESULT_TYPE, protocolVersion: RUNTIME_PROTOCOL_VERSION, binding: remoteBinding, callId: sent.callId, serviceInstanceId: sent.serviceInstanceId, result: { result: "world" } });
    await expect(promise).resolves.toEqual({ result: "world" });
    expect(bridge.pendingCallCount).toBe(0);
  });

  it("settles cancellation immediately and never leaves framework pending state", async () => {
    const transport = createFakeRuntimeTransport();
    const bridge = createCapabilityBridge({ transport, defaultCallTimeoutMs: 1_000 });
    bridge.applySnapshot(snapshot());
    const controller = new AbortController();
    const promise = bridge.getClient(Echo).call({ value: "slow" }, { signal: controller.signal });
    expect(bridge.pendingCallCount).toBe(1);
    controller.abort();
    await expect(promise).rejects.toMatchObject({ code: "request_cancelled" });
    expect(bridge.pendingCallCount).toBe(0);
    expect(transport.sent.at(-1)?.message.type).toBe(RUNTIME_CANCEL_TYPE);
  });

  it("turns malformed responses into structured errors and fences stale revisions/exposures", async () => {
    const transport = createFakeRuntimeTransport();
    const bridge = createCapabilityBridge({ transport, defaultCallTimeoutMs: 1_000 });
    bridge.applySnapshot(snapshot());
    const first = bridge.getClient(Echo).call({ value: "bad" });
    const call = transport.sent.at(-1)?.message;
    if (!call || call.type !== RUNTIME_CALL_TYPE) throw new Error("call was not sent");
    transport.emit({ type: RUNTIME_RESULT_TYPE, protocolVersion: RUNTIME_PROTOCOL_VERSION, binding: remoteBinding, callId: call.callId, serviceInstanceId: call.serviceInstanceId, result: { wrong: true } });
    await expect(first).rejects.toMatchObject({ code: "response_validation_failed" });

    const oldClient = bridge.getClient(Echo);
    expect(bridge.applySnapshot(snapshot("service:two", 0))).toMatchObject({ accepted: false, reason: "stale-revision" });
    expect(bridge.services()[0]?.serviceInstanceId).toBe("service:one");
    expect(bridge.applySnapshot(snapshot("service:two", 2))).toMatchObject({ accepted: true, revision: 2 });
    await expect(oldClient.call({ value: "old" })).rejects.toMatchObject({ code: "service_revoked" });
    expect(bridge.services()[0]?.serviceInstanceId).toBe("service:two");
  });

  it("does not settle on a response from another exposure", async () => {
    const transport = createFakeRuntimeTransport();
    const bridge = createCapabilityBridge({ transport, defaultCallTimeoutMs: 20 });
    bridge.applySnapshot(snapshot());
    const promise = bridge.getClient(Echo).call({ value: "fence" });
    const call = transport.sent.at(-1)?.message;
    if (!call || call.type !== RUNTIME_CALL_TYPE) throw new Error("call was not sent");
    transport.emit({ type: RUNTIME_RESULT_TYPE, protocolVersion: RUNTIME_PROTOCOL_VERSION, binding: remoteBinding, callId: call.callId, serviceInstanceId: "service:other", result: { result: "wrong" } });
    await expect(promise).rejects.toMatchObject({ code: "call_timeout" });
    expect(bridge.pendingCallCount).toBe(0);
  });

  it("completes simultaneous close handshakes idempotently on both endpoints", async () => {
    const channel = new MessageChannel();
    const leftSession = createRuntimeEndpointSession({ runtimeInstanceId: "window:close", connectionId: "left" }, { defaultDrainTimeoutMs: 100 });
    const rightSession = createRuntimeEndpointSession({ runtimeInstanceId: "worker:close", connectionId: "right" }, { defaultDrainTimeoutMs: 100 });
    const left = createCapabilityBridge({ transport: createMessagePortRuntimeTransport(channel.port1), binding: leftSession.binding, session: leftSession, drainTimeoutMs: 100 });
    const right = createCapabilityBridge({ transport: createMessagePortRuntimeTransport(channel.port2), binding: rightSession.binding, session: rightSession, drainTimeoutMs: 100 });
    const leftClose = left.drain(100);
    const leftCloseAgain = left.drain(1);
    const rightClose = right.drain(100);
    const rightCloseAgain = right.drain(1);
    expect(leftCloseAgain).toBe(leftClose);
    expect(rightCloseAgain).toBe(rightClose);
    const closeResults = await Promise.all([leftClose, rightClose]);
    expect(closeResults[0]).toMatchObject({ drained: true, timedOut: false, pendingExecutions: 0 });
    expect(closeResults[1]).toMatchObject({ drained: true, timedOut: false, pendingExecutions: 0 });
    expect(left.endpointState).toBe("closed");
    expect(right.endpointState).toBe("closed");
    left.dispose();
    left.dispose();
    right.dispose();
    right.dispose();
  });

  it("terminally rejects a result from a different remote binding without late unary settlement", async () => {
    const transport = createFakeRuntimeTransport();
    const bridge = createCapabilityBridge({ transport, defaultCallTimeoutMs: 100 });
    expect(bridge.applySnapshot(snapshot())).toMatchObject({ accepted: true });
    const pending = bridge.getClient(Echo).call({ value: "binding-fence" });
    const call = transport.sent.at(-1)?.message;
    if (!call || call.type !== RUNTIME_CALL_TYPE) throw new Error("call was not sent");
    transport.emit({ type: RUNTIME_RESULT_TYPE, protocolVersion: RUNTIME_PROTOCOL_VERSION, binding: wrongBinding, callId: call.callId, serviceInstanceId: call.serviceInstanceId, result: { result: "late" } });
    await expect(pending).rejects.toMatchObject({ code: "invalid_message" });
    expect(bridge.endpointState).toBe("closed");
    expect(bridge.pendingCallCount).toBe(0);
    bridge.dispose();
  });

  it("terminally rejects a stream next from a different remote binding without delivering an item", async () => {
    const transport = createFakeRuntimeTransport();
    const bridge = createCapabilityBridge({ transport, defaultCallTimeoutMs: 100 });
    expect(bridge.applySnapshot(streamSnapshot())).toMatchObject({ accepted: true });
    const values: number[] = [];
    const subscription = bridge.getClient(Events).subscribe({ topic: "binding-fence" }, { initialCredit: 1, onNext: (value) => { values.push(value); } });
    const call = transport.sent.at(-1)?.message;
    if (!call || call.type !== RUNTIME_CALL_TYPE) throw new Error("stream call was not sent");
    transport.emit({ type: RUNTIME_RESULT_TYPE, protocolVersion: RUNTIME_PROTOCOL_VERSION, binding: remoteBinding, callId: call.callId, serviceInstanceId: call.serviceInstanceId, streamReady: true });
    await subscription.ready;
    transport.emit({ type: RUNTIME_NEXT_TYPE, protocolVersion: RUNTIME_PROTOCOL_VERSION, binding: wrongBinding, callId: call.callId, serviceInstanceId: call.serviceInstanceId, sequence: 1, item: 7 });
    await expect(subscription.closed).rejects.toMatchObject({ code: "invalid_message" });
    expect(values).toEqual([]);
    expect(bridge.endpointState).toBe("closed");
    expect(bridge.activeStreamCount).toBe(0);
    bridge.dispose();
  });

  it("does not accept a cancel from a different remote binding", async () => {
    const transport = createFakeRuntimeTransport();
    const bridge = createCapabilityBridge({ transport, defaultCallTimeoutMs: 100 });
    bridge.applySnapshot(snapshot());
    const pending = bridge.getClient(Echo).call({ value: "binding-cancel" });
    const call = transport.sent.at(-1)?.message;
    if (!call || call.type !== RUNTIME_CALL_TYPE) throw new Error("call was not sent");
    transport.emit({ type: RUNTIME_CANCEL_TYPE, protocolVersion: RUNTIME_PROTOCOL_VERSION, binding: wrongBinding, callId: call.callId, serviceInstanceId: call.serviceInstanceId });
    await expect(pending).rejects.toMatchObject({ code: "invalid_message" });
    expect(bridge.endpointState).toBe("closed");
    bridge.dispose();
  });

  it("does not accept credit from a different remote binding", async () => {
    const transport = createFakeRuntimeTransport();
    const bridge = createCapabilityBridge({ transport, defaultCallTimeoutMs: 100 });
    bridge.applySnapshot(streamSnapshot());
    const subscription = bridge.getClient(Events).subscribe({ topic: "binding-credit" }, { initialCredit: 1, onNext: () => undefined });
    const call = transport.sent.at(-1)?.message;
    if (!call || call.type !== RUNTIME_CALL_TYPE) throw new Error("stream call was not sent");
    transport.emit({ type: RUNTIME_RESULT_TYPE, protocolVersion: RUNTIME_PROTOCOL_VERSION, binding: remoteBinding, callId: call.callId, serviceInstanceId: call.serviceInstanceId, streamReady: true });
    await subscription.ready;
    transport.emit({ type: RUNTIME_CREDIT_TYPE, protocolVersion: RUNTIME_PROTOCOL_VERSION, binding: wrongBinding, callId: call.callId, serviceInstanceId: call.serviceInstanceId, count: 1 });
    await expect(subscription.closed).rejects.toMatchObject({ code: "invalid_message" });
    expect(bridge.endpointState).toBe("closed");
    bridge.dispose();
  });

  it("rejects a close from a different remote binding without sending an acknowledgement", () => {
    const transport = createFakeRuntimeTransport();
    const bridge = createCapabilityBridge({ transport });
    bridge.applySnapshot(snapshot());
    transport.emit({ type: RUNTIME_CLOSE_TYPE, protocolVersion: RUNTIME_PROTOCOL_VERSION, binding: wrongBinding, timeoutMs: 10 });
    expect(bridge.endpointState).toBe("closed");
    expect(transport.sent.some((entry) => entry.message.type === RUNTIME_CLOSE_ACK_TYPE)).toBe(false);
    bridge.dispose();
  });

  it("rejects a close acknowledgement with a different sender binding", async () => {
    const transport = createFakeRuntimeTransport();
    const bridge = createCapabilityBridge({ transport, defaultCallTimeoutMs: 20 });
    bridge.applySnapshot(snapshot());
    const pendingDrain = bridge.drain(20);
    transport.emit({ type: RUNTIME_CLOSE_ACK_TYPE, protocolVersion: RUNTIME_PROTOCOL_VERSION, binding: wrongBinding, acknowledgedBinding: bridge.binding, drained: true, timedOut: false, pendingExecutions: 0 });
    const result = await pendingDrain;
    expect(result).toMatchObject({ drained: false, timedOut: true });
    expect(bridge.endpointState).toBe("closed");
    bridge.dispose();
  });

  it("rejects a close acknowledgement for a different local binding", async () => {
    const transport = createFakeRuntimeTransport();
    const bridge = createCapabilityBridge({ transport, defaultCallTimeoutMs: 20 });
    bridge.applySnapshot(snapshot());
    const pendingDrain = bridge.drain(20);
    transport.emit({ type: RUNTIME_CLOSE_ACK_TYPE, protocolVersion: RUNTIME_PROTOCOL_VERSION, binding: remoteBinding, acknowledgedBinding: wrongBinding, drained: true, timedOut: false, pendingExecutions: 0 });
    const result = await pendingDrain;
    expect(result).toMatchObject({ drained: false, timedOut: true });
    expect(bridge.endpointState).toBe("closed");
    bridge.dispose();
  });

  it("echoes the exposure grant from a snapshot on every outgoing call", async () => {
    const transport = createFakeRuntimeTransport();
    const bridge = createCapabilityBridge({ transport, defaultCallTimeoutMs: 100 });
    bridge.applySnapshot(snapshotWithGrant("grant:one"));
    const pending = bridge.getClient(Echo).call({ value: "grant" });
    const call = transport.sent.at(-1)?.message;
    if (!call || call.type !== RUNTIME_CALL_TYPE) throw new Error("call was not sent");
    expect(call.grantId).toBe("grant:one");
    transport.emit({ type: RUNTIME_RESULT_TYPE, protocolVersion: RUNTIME_PROTOCOL_VERSION, binding: remoteBinding, callId: call.callId, serviceInstanceId: call.serviceInstanceId, result: { result: "ok" } });
    await expect(pending).resolves.toEqual({ result: "ok" });
    bridge.dispose();
  });

  it("waits for a stream directory, honors ready-only deadlines and returns bounded credit", async () => {
    const transport = createFakeRuntimeTransport();
    const bridge = createCapabilityBridge({ transport, defaultCallTimeoutMs: 500 });
    const values: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const subscription = bridge.getClient(Events).subscribe({ topic: "updates" }, {
      initialCredit: 1,
      onNext: async (value) => { values.push(value); await gate; },
    });
    expect(bridge.activeStreamCount).toBe(0);
    bridge.applySnapshot(streamSnapshot());
    const call = transport.sent.at(-1)?.message;
    if (!call || call.type !== "webloom.runtime.v1.call") throw new Error("stream call was not sent");
    transport.emit({ type: "webloom.runtime.v1.result", protocolVersion: RUNTIME_PROTOCOL_VERSION, binding: remoteBinding, callId: call.callId, serviceInstanceId: call.serviceInstanceId, streamReady: true });
    await subscription.ready;
    transport.emit({ type: "webloom.runtime.v1.next", protocolVersion: RUNTIME_PROTOCOL_VERSION, binding: remoteBinding, callId: call.callId, serviceInstanceId: call.serviceInstanceId, sequence: 1, item: 7 });
    await Promise.resolve();
    expect(values).toEqual([7]);
    expect(transport.sent.filter((entry) => entry.message.type === "webloom.runtime.v1.credit")).toHaveLength(0);
    release();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(transport.sent.filter((entry) => entry.message.type === "webloom.runtime.v1.credit")).toHaveLength(1);
    transport.emit({ type: "webloom.runtime.v1.result", protocolVersion: RUNTIME_PROTOCOL_VERSION, binding: remoteBinding, callId: call.callId, serviceInstanceId: call.serviceInstanceId, done: true });
    await subscription.closed;
    expect(bridge.activeStreamCount).toBe(0);
  });

  it("releases a callback execution slot and wakes a second peer sharing the runtime budget", async () => {
    const limits = { maxExecutionSlotsPerPeer: 1, maxExecutionSlotsPerRuntime: 1 } as const;
    const budget = createRuntimeBudget(limits);
    const firstTransport = createFakeRuntimeTransport();
    const secondTransport = createFakeRuntimeTransport();
    const firstBridge = createCapabilityBridge({ transport: firstTransport, limits, budget, defaultCallTimeoutMs: 1_000 });
    const secondBridge = createCapabilityBridge({ transport: secondTransport, limits, budget, defaultCallTimeoutMs: 1_000 });
    firstBridge.applySnapshot(streamSnapshot());
    secondBridge.applySnapshot(streamSnapshot());
    const firstValues: number[] = [];
    const secondValues: number[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let releaseSecond!: () => void;
    const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const first = firstBridge.getClient(Events).subscribe({ topic: "first" }, { initialCredit: 1, onNext: async (value) => { firstValues.push(value); await firstGate; } });
    const second = secondBridge.getClient(Events).subscribe({ topic: "second" }, { initialCredit: 1, onNext: async (value) => { secondValues.push(value); await secondGate; } });
    const firstStreamCall = firstTransport.sent.at(-1)?.message;
    const secondStreamCall = secondTransport.sent.at(-1)?.message;
    if (!firstStreamCall || firstStreamCall.type !== RUNTIME_CALL_TYPE || !secondStreamCall || secondStreamCall.type !== RUNTIME_CALL_TYPE) throw new Error("stream subscriptions were not sent");
    firstTransport.emit({ type: RUNTIME_RESULT_TYPE, protocolVersion: RUNTIME_PROTOCOL_VERSION, binding: remoteBinding, callId: firstStreamCall.callId, serviceInstanceId: firstStreamCall.serviceInstanceId, streamReady: true });
    secondTransport.emit({ type: RUNTIME_RESULT_TYPE, protocolVersion: RUNTIME_PROTOCOL_VERSION, binding: remoteBinding, callId: secondStreamCall.callId, serviceInstanceId: secondStreamCall.serviceInstanceId, streamReady: true });
    await Promise.all([first.ready, second.ready]);
    firstTransport.emit({ type: "webloom.runtime.v1.next", protocolVersion: RUNTIME_PROTOCOL_VERSION, binding: remoteBinding, callId: firstStreamCall.callId, serviceInstanceId: firstStreamCall.serviceInstanceId, sequence: 1, item: 1 });
    await Promise.resolve();
    expect(firstValues).toEqual([1]);
    expect(budget.executionSlots).toBe(1);
    secondTransport.emit({ type: "webloom.runtime.v1.next", protocolVersion: RUNTIME_PROTOCOL_VERSION, binding: remoteBinding, callId: secondStreamCall.callId, serviceInstanceId: secondStreamCall.serviceInstanceId, sequence: 1, item: 2 });
    await Promise.resolve();
    expect(secondValues).toEqual([]);
    releaseFirst();
    for (let attempt = 0; attempt < 20 && secondValues.length === 0; attempt += 1) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(secondValues).toEqual([2]);
    expect(budget.executionSlots).toBe(1);
    releaseSecond();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(budget.executionSlots).toBe(0);
    firstTransport.emit({ type: RUNTIME_RESULT_TYPE, protocolVersion: RUNTIME_PROTOCOL_VERSION, binding: remoteBinding, callId: firstStreamCall.callId, serviceInstanceId: firstStreamCall.serviceInstanceId, done: true });
    secondTransport.emit({ type: RUNTIME_RESULT_TYPE, protocolVersion: RUNTIME_PROTOCOL_VERSION, binding: remoteBinding, callId: secondStreamCall.callId, serviceInstanceId: secondStreamCall.serviceInstanceId, done: true });
    await Promise.all([first.closed, second.closed]);
    expect(budget.executionSlots).toBe(0);
    expect(firstBridge.pendingCallCount).toBe(0);
    expect(secondBridge.pendingCallCount).toBe(0);
  });
});
