import { describe, expect, it } from "vitest";
import { defineCapability } from "../contracts/capability.js";
import { WebLoomError } from "../contracts/lifecycle.js";
import { RUNTIME_PROTOCOL_VERSION, RUNTIME_SNAPSHOT_TYPE, type RuntimeSnapshotMessage } from "../runtime/runtimeProtocol.js";
import { createCapabilityBridge } from "./serviceBridge.js";
import { createMessagePortRuntimeTransport } from "./messagePortServiceTransport.js";
import { createMessagePortServiceProvider } from "./messagePortServiceProvider.js";
import { createRuntimeTrafficBudget } from "../runtime/trafficBudget.js";

const parseRequest = { parse(value: unknown): { value: string } {
  if (!value || typeof value !== "object" || typeof (value as { value?: unknown }).value !== "string") throw new Error("invalid request");
  return value as { value: string };
} };
const parseResponse = { parse(value: unknown): { result: string } {
  if (!value || typeof value !== "object" || typeof (value as { result?: unknown }).result !== "string") throw new Error("invalid response");
  return value as { result: string };
} };
const Echo = defineCapability({ kind: "rpc", id: "port.echo", version: "1", request: parseRequest, response: parseResponse });
const Numbers = defineCapability({
  kind: "stream",
  id: "port.numbers",
  version: "1",
  request: { parse(value: unknown): { count: number } {
    if (!value || typeof value !== "object" || typeof (value as { count?: unknown }).count !== "number") throw new Error("invalid request");
    return value as { count: number };
  } },
  item: { parse(value: unknown): number {
    if (!Number.isInteger(value)) throw new Error("invalid item");
    return value as number;
  } },
});
const LargeEvents = defineCapability({
  kind: "stream",
  id: "port.large-events",
  version: "1",
  request: { parse(value: unknown): { count: number } {
    if (!value || typeof value !== "object" || typeof (value as { count?: unknown }).count !== "number") throw new Error("invalid request");
    return value as { count: number };
  } },
  item: { parse(value: unknown): string {
    if (typeof value !== "string") throw new Error("invalid item");
    return value;
  } },
});

const workerBinding = { runtimeInstanceId: "worker:one", connectionId: "direct:worker:one" } as const;

function reference(capability: typeof Echo | typeof Numbers | typeof LargeEvents, serviceInstanceId: string): import("../contracts/capability.js").ServiceReference {
  return { kind: capability.kind, capabilityId: capability.id, contractVersion: capability.version, runtime: "shared-worker", runtimeInstanceId: "worker:one", serviceInstanceId, attributes: {} };
}

function snapshot(): RuntimeSnapshotMessage {
  return {
    type: RUNTIME_SNAPSHOT_TYPE,
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    runtimeId: "worker",
    runtimeKind: "shared-worker",
    runtimeInstanceId: "worker:one",
    revision: 1,
    state: "ready",
    units: [],
    services: [
      { kind: "rpc", capabilityId: Echo.id, contractVersion: Echo.version, serviceInstanceId: "echo:one", attributes: {} },
      { kind: "stream", capabilityId: Numbers.id, contractVersion: Numbers.version, serviceInstanceId: "numbers:one", attributes: {} },
      { kind: "stream", capabilityId: LargeEvents.id, contractVersion: LargeEvents.version, serviceInstanceId: "large-events:one", attributes: {} },
    ],
    binding: workerBinding,
  };
}

describe("v4 MessagePort runtime transport", () => {
  it("runs a typed unary call over one bidirectional MessageChannel", async () => {
    const channel = new MessageChannel();
    const clientTransport = createMessagePortRuntimeTransport(channel.port1);
    const provider = createMessagePortServiceProvider({
      port: channel.port2,
      binding: workerBinding,
      services: () => [reference(Echo, "echo:one")],
      handleCall: ({ message }) => ({ result: (message.request as { value: string }).value.toUpperCase() }),
      prepareResult: (value) => ({ value: parseResponse.parse(value) }),
    });
    const bridge = createCapabilityBridge({ transport: clientTransport, remoteRuntimeKind: "shared-worker", remoteRuntimeId: "worker" });
    bridge.applySnapshot(snapshot());
    await expect(bridge.getClient(Echo).call({ value: "hello" })).resolves.toEqual({ result: "HELLO" });
    expect(provider.pendingCount()).toBe(0);
    bridge.dispose();
    provider.dispose();
  });

  it("reports response parser failures instead of waiting for a timeout", async () => {
    const channel = new MessageChannel();
    const clientTransport = createMessagePortRuntimeTransport(channel.port1);
    const provider = createMessagePortServiceProvider({
      port: channel.port2,
      binding: workerBinding,
      services: () => [reference(Echo, "echo:one")],
      handleCall: () => ({ wrong: true }),
      prepareResult: (value) => ({ value: parseResponse.parse(value) }),
    });
    const bridge = createCapabilityBridge({ transport: clientTransport, defaultCallTimeoutMs: 200 });
    bridge.applySnapshot(snapshot());
    await expect(bridge.getClient(Echo).call({ value: "bad" })).rejects.toMatchObject({ code: "response_validation_failed" });
    expect(provider.pendingCount()).toBe(0);
    bridge.dispose();
    provider.dispose();
  });

  it("keeps stream production bounded by credit and returns credit after onNext", async () => {
    const channel = new MessageChannel();
    const clientTransport = createMessagePortRuntimeTransport(channel.port1);
    let produced = 0;
    const firstItem = new Promise<void>((resolve) => {
      const provider = createMessagePortServiceProvider({
        port: channel.port2,
        binding: workerBinding,
        services: () => [reference(Numbers, "numbers:one")],
        handleCall: async ({ message }) => (async function* () {
          for (let value = 1; value <= (message.request as { count: number }).count; value += 1) {
            produced += 1;
            if (value === 1) resolve();
            yield value;
          }
        })(),
      });
      void provider;
    });
    const bridge = createCapabilityBridge({ transport: clientTransport, defaultCallTimeoutMs: 500 });
    bridge.applySnapshot(snapshot());
    const values: number[] = [];
    let releaseFirst!: () => void;
    const firstCallback = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const subscription = bridge.getClient(Numbers).subscribe({ count: 2 }, {
      initialCredit: 1,
      initialByteCredit: 8,
      onNext: async (value) => {
        values.push(value);
        if (value === 1) await firstCallback;
      },
    });
    await subscription.ready;
    await firstItem;
    await Promise.resolve();
    expect(produced).toBe(1);
    releaseFirst();
    await subscription.closed;
    expect(values).toEqual([1, 2]);
    bridge.dispose();
  });

  it("uses the consumer byte window as the provider's exact stream budget", async () => {
    const channel = new MessageChannel();
    const clientTransport = createMessagePortRuntimeTransport(channel.port1);
    const provider = createMessagePortServiceProvider({
      port: channel.port2,
      binding: workerBinding,
      services: () => [reference(LargeEvents, "large-events:one")],
      handleCall: async () => (async function* () {
        yield "x".repeat(300);
        yield "y".repeat(300);
      })(),
    });
    const bridge = createCapabilityBridge({
      transport: clientTransport,
      limits: { maxRetainedPayloadBytesPerRuntime: 2_048 },
      defaultCallTimeoutMs: 1_000,
    });
    bridge.applySnapshot(snapshot());
    const values: string[] = [];
    let firstDelivered!: () => void;
    const firstDeliveredPromise = new Promise<void>((resolve) => { firstDelivered = resolve; });
    let releaseFirst!: () => void;
    const firstCallback = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const subscription = bridge.getClient(LargeEvents).subscribe({ count: 2 }, {
      initialCredit: 2,
      initialByteCredit: 1_024,
      onNext: async (value) => {
        values.push(value);
        if (values.length === 1) {
          firstDelivered();
          await firstCallback;
        }
      },
    });
    await subscription.ready;
    await firstDeliveredPromise;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(values).toHaveLength(1);
    expect(bridge.retainedPayloadBytes).toBeGreaterThan(0);
    releaseFirst();
    await subscription.closed;
    expect(values).toHaveLength(2);
    bridge.dispose();
    provider.dispose();
  });

  it("rejects a stream when the provider cannot reserve the consumer's exact byte window", async () => {
    const channel = new MessageChannel();
    const clientTransport = createMessagePortRuntimeTransport(channel.port1);
    let entered = 0;
    const provider = createMessagePortServiceProvider({
      port: channel.port2,
      binding: workerBinding,
      limits: { maxRetainedPayloadBytesPerRuntime: 256 },
      services: () => [reference(LargeEvents, "large-events:one")],
      handleCall: () => { entered += 1; return (async function* () { yield "never"; })(); },
    });
    const trafficLimit = 16 * 1024;
    const traffic = createRuntimeTrafficBudget({ maxRetainedPayloadBytesPerRuntime: trafficLimit });
    const bridge = createCapabilityBridge({
      transport: clientTransport,
      limits: { maxRetainedPayloadBytesPerRuntime: trafficLimit },
      budget: traffic.outbound,
      defaultCallTimeoutMs: 1_000,
    });
    bridge.applySnapshot(snapshot());
    const subscription = bridge.getClient(LargeEvents).subscribe({ count: 1 }, { initialCredit: 1, initialByteCredit: 4 * 1024, onNext: () => undefined });
    await expect(subscription.ready).rejects.toMatchObject({ code: "resource_limit_exceeded" });
    await expect(subscription.closed).rejects.toMatchObject({ code: "resource_limit_exceeded" });
    expect(entered).toBe(0);
    expect(bridge.pendingCallCount).toBe(0);
    expect(traffic.outbound.reservedStreamByteCredit).toBe(0);
    bridge.dispose();
    provider.dispose();
  });

  it("allows two idle default streams to share peer and runtime byte budgets", async () => {
    const channel = new MessageChannel();
    const traffic = createRuntimeTrafficBudget();
    const clientTransport = createMessagePortRuntimeTransport(channel.port1);
    let entered = 0;
    const provider = createMessagePortServiceProvider({
      port: channel.port2,
      budget: traffic.inbound,
      binding: workerBinding,
      services: () => [reference(LargeEvents, "large-events:one")],
      handleCall: ({ signal }) => {
        entered += 1;
        return (async function* () {
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener("abort", () => resolve(), { once: true });
          });
        })();
      },
    });
    const bridge = createCapabilityBridge({
      transport: clientTransport,
      budget: traffic.outbound,
      defaultCallTimeoutMs: 1_000,
    });
    bridge.applySnapshot(snapshot());
    const first = bridge.getClient(LargeEvents).subscribe({ count: 1 }, { initialCredit: 1, onNext: () => undefined });
    const second = bridge.getClient(LargeEvents).subscribe({ count: 1 }, { initialCredit: 1, onNext: () => undefined });
    await Promise.all([first.ready, second.ready]);
    expect(entered).toBe(2);
    expect(bridge.activeStreamCount).toBe(2);
    expect(provider.executionCount()).toBe(2);
    expect(traffic.outbound.activeStreams).toBe(2);
    expect(traffic.inbound.activeStreams).toBe(2);
    expect(traffic.outbound.reservedStreamByteCredit).toBeGreaterThan(0);
    expect(traffic.inbound.reservedStreamByteCredit).toBeGreaterThan(0);

    first.cancel();
    second.cancel();
    await Promise.all([first.closed.catch(() => undefined), second.closed.catch(() => undefined)]);
    for (let attempt = 0; attempt < 20 && provider.executionCount() !== 0; attempt += 1) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(bridge.activeStreamCount).toBe(0);
    expect(provider.executionCount()).toBe(0);
    expect(provider.retainedPayloadBytes()).toBe(0);
    expect(traffic.outbound.activeStreams).toBe(0);
    expect(traffic.outbound.reservedStreamByteCredit).toBe(0);
    expect(traffic.inbound.activeStreams).toBe(0);
    expect(traffic.inbound.reservedStreamByteCredit).toBe(0);
    bridge.dispose();
    provider.dispose();
  });

  it("auto-shrinks the byte window when a real provider has less capacity", async () => {
    const channel = new MessageChannel();
    const clientTransport = createMessagePortRuntimeTransport(channel.port1);
    const values: string[] = [];
    let firstDelivered!: () => void;
    const firstDeliveredPromise = new Promise<void>((resolve) => { firstDelivered = resolve; });
    let releaseFirst!: () => void;
    const firstCallback = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const provider = createMessagePortServiceProvider({
      port: channel.port2,
      limits: { maxRetainedPayloadBytesPerRuntime: 4 * 1024 },
      binding: workerBinding,
      services: () => [reference(LargeEvents, "large-events:one")],
      handleCall: async () => (async function* () {
        yield "x".repeat(16);
        yield "y".repeat(16);
      })(),
    });
    const bridge = createCapabilityBridge({
      transport: clientTransport,
      limits: { maxRetainedPayloadBytesPerRuntime: 16 * 1024 },
      defaultCallTimeoutMs: 1_000,
    });
    bridge.applySnapshot(snapshot());
    // 未提供 initialByteCredit，bridge 会先按 Consumer 容量申请，Provider
    // 再按自身 4 KiB Runtime 容量返回更小的 accepted 窗口。
    const subscription = bridge.getClient(LargeEvents).subscribe({ count: 2 }, {
      initialCredit: 2,
      onNext: async (value) => {
        values.push(value);
        if (values.length === 1) {
          firstDelivered();
          await firstCallback;
        }
      },
    });
    await subscription.ready;
    await firstDeliveredPromise;
    expect(bridge.retainedPayloadBytes).toBeGreaterThan(0);
    releaseFirst();
    await subscription.closed;
    expect(values).toEqual(["x".repeat(16), "y".repeat(16)]);
    bridge.dispose();
    provider.dispose();
  });
});
