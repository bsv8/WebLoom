import { describe, expect, it } from "vitest";
import { defineCapability } from "../contracts/capability.js";
import { WebLoomError, type RuntimeSnapshot } from "../contracts/lifecycle.js";
import { RUNTIME_PROTOCOL_VERSION } from "../runtime/runtimeProtocol.js";
import { createCapabilityBridge } from "./serviceBridge.js";
import { createMessagePortRuntimeTransport } from "./messagePortServiceTransport.js";
import { createMessagePortServiceProvider } from "./messagePortServiceProvider.js";

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

function reference(capability: typeof Echo | typeof Numbers, serviceInstanceId: string): import("../contracts/capability.js").ServiceReference {
  return { kind: capability.kind, capabilityId: capability.id, contractVersion: capability.version, runtime: "shared-worker", runtimeInstanceId: "worker:one", serviceInstanceId, attributes: {} };
}

function snapshot(): RuntimeSnapshot {
  return {
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
    ],
  };
}

describe("v4 MessagePort runtime transport", () => {
  it("runs a typed unary call over one bidirectional MessageChannel", async () => {
    const channel = new MessageChannel();
    const clientTransport = createMessagePortRuntimeTransport(channel.port1);
    const provider = createMessagePortServiceProvider({
      port: channel.port2,
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
});
