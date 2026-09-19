import { describe, expect, it } from "vitest";
import { createPreparedPayload, validateTransferListWithStats } from "./dto.js";
import { createRuntimeTrafficBudget } from "../runtime/trafficBudget.js";
import {
  createRuntimeMessageCodec,
  RUNTIME_CALL_TYPE,
  RUNTIME_CREDIT_TYPE,
  RUNTIME_PROTOCOL_VERSION,
  type RuntimeCallMessage,
} from "../runtime/runtimeProtocol.js";
import { createMessagePortRuntimeTransport } from "./messagePortServiceTransport.js";

const callerBinding = { runtimeInstanceId: "window:optimization", connectionId: "connection:optimization" } as const;

describe("v4 transport optimization boundaries", () => {
  it("keeps structured-clone semantics for ordinary ArrayBuffer payloads", () => {
    const buffer = new ArrayBuffer(32);
    expect(() => validateTransferListWithStats({ data: buffer }, undefined)).not.toThrow();

    const validation = validateTransferListWithStats({ data: buffer }, [buffer]);
    expect(validation.transfer).toEqual([buffer]);
    expect(validation.stats.budgetBytes).toBeGreaterThanOrEqual(32);
  });

  it("requires a stream call to carry its exact initial byte credit", () => {
    const codec = createRuntimeMessageCodec();
    const message = {
      type: RUNTIME_CALL_TYPE,
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      binding: callerBinding,
      callId: "stream:missing-byte-credit",
      capabilityId: "optimization.stream",
      contractVersion: "1",
      serviceInstanceId: "service:one",
      mode: "stream",
      timeoutMs: 100,
      request: { value: "stream" },
      initialCredit: 1,
    } as unknown;
    expect(() => codec.decodeWithStats(message)).toThrow(/invalid/i);
  });

  it("reuses a framework-created payload preparation result without putting it on wire", () => {
    const payload = { value: "prepared" };
    const validation = validateTransferListWithStats(payload, undefined);
    const prepared = createPreparedPayload(payload, validation.transfer);
    const message: RuntimeCallMessage = {
      type: RUNTIME_CALL_TYPE,
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      binding: callerBinding,
      callId: "call:prepared",
      capabilityId: "optimization.echo",
      contractVersion: "1",
      serviceInstanceId: "service:one",
      mode: "unary",
      timeoutMs: 100,
      request: payload,
    };
    const codec = createRuntimeMessageCodec();
    const encoded = codec.encode(message, prepared);
    if (encoded.type !== RUNTIME_CALL_TYPE) throw new Error("prepared call was not encoded as a call");
    expect(encoded.request).toBe(payload);
    expect(Object.hasOwn(encoded.request as object, "stats")).toBe(false);
    const decoded = codec.decodeWithStats(encoded);
    expect(decoded.payload?.field).toBe("request");
    expect(decoded.payload?.value).toBe(payload);
    expect(decoded.payload?.stats.budgetBytes).toBe(validation.stats.budgetBytes);
  });

  it("carries count and byte credit on the existing control-plane message", () => {
    const codec = createRuntimeMessageCodec();
    const message = {
      type: RUNTIME_CREDIT_TYPE,
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      binding: callerBinding,
      callId: "stream:credit",
      serviceInstanceId: "service:one",
      count: 8,
      bytes: 4 * 1024 * 1024,
    } as const;
    expect(codec.decode(message)).toMatchObject({ count: 8, bytes: 4 * 1024 * 1024 });
  });

  it("applies the endpoint maxDtoDepth during the one transport decode", () => {
    const codec = createRuntimeMessageCodec({ limits: { maxDtoDepth: 2 } });
    const message: RuntimeCallMessage = {
      type: RUNTIME_CALL_TYPE,
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      binding: callerBinding,
      callId: "call:depth",
      capabilityId: "optimization.echo",
      contractVersion: "1",
      serviceInstanceId: "service:one",
      mode: "unary",
      timeoutMs: 100,
      request: { one: { two: { three: "too-deep" } } },
    };
    expect(() => codec.decodeWithStats(message)).toThrow(/invalid/i);
  });

  it("routes one physical MessagePort message only to its registered wire type", async () => {
    const channel = new MessageChannel();
    const transport = createMessagePortRuntimeTransport(channel.port1);
    const calls: string[] = [];
    let resolveRouted!: () => void;
    const routed = new Promise<void>((resolve) => { resolveRouted = resolve; });
    const removeCall = transport.subscribeByType?.([RUNTIME_CALL_TYPE], (message) => { calls.push(message.type); resolveRouted(); });
    const removeCredit = transport.subscribeByType?.([RUNTIME_CREDIT_TYPE], (message) => calls.push(message.type));
    channel.port2.postMessage({
      type: RUNTIME_CALL_TYPE,
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      binding: callerBinding,
      callId: "call:routed",
      capabilityId: "optimization.echo",
      contractVersion: "1",
      serviceInstanceId: "service:one",
      mode: "unary",
      timeoutMs: 100,
      request: { value: "routed" },
    });
    await routed;
    expect(calls).toEqual([RUNTIME_CALL_TYPE]);
    removeCall?.();
    removeCredit?.();
    transport.close?.();
    channel.port2.close();
  });

  it("provides one shareable budget for multiple runtime handles", () => {
    const traffic = createRuntimeTrafficBudget({ maxPendingCallsPerRuntime: 4 });
    expect(traffic.outbound).not.toBe(traffic.inbound);
    traffic.outbound.pendingCalls = 4;
    expect(traffic.outbound.pendingCalls).toBe(4);
    expect(traffic.inbound.pendingCalls).toBe(0);
  });
});
