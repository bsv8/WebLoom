import { describe, expect, it, vi } from "vitest";
import { RemoteServiceUnavailableError, type RemoteServiceTransport } from "../contracts/lifecycle.js";
import { createServiceBridge } from "./serviceBridge.js";

function reference(overrides: Partial<Parameters<typeof makeReference>[0]> = {}) {
  return makeReference(overrides);
}

function makeReference(overrides: Partial<{
  providerInstanceId: string;
  status: "starting" | "ready" | "unavailable" | "failed";
  snapshotRevision: number;
}> = {}) {
  return {
    capabilityId: "asset.service",
    providerInstanceId: overrides.providerInstanceId ?? "provider:1",
    execution: "coordinator-worker" as const,
    contractVersion: "1",
    authorityInstanceId: "authority:1",
    scopeId: "scope:provider",
    handoverGeneration: 1,
    attributes: { tenancy: "shared" },
    status: overrides.status ?? "ready",
    snapshotRevision: overrides.snapshotRevision ?? 1,
  };
}

describe("remote service bridge", () => {
  it("requires a matching handshake and a baseline before exposing ready services", async () => {
    const calls: unknown[] = [];
    const bridge = createServiceBridge({
      protocolVersion: "1",
      transport: {
        async call<TRequest, TResult>(request: TRequest, context: import("../contracts/lifecycle.js").RemoteServiceCallContext): Promise<TResult> {
          calls.push({ request, context });
          return { ok: true } as TResult;
        },
      },
    });

    expect(bridge.handshake({ connectionId: "connection:1", authorityInstanceId: "authority:1", protocolVersion: "0" }).accepted).toBe(false);
    expect(bridge.getProxy({ capabilityId: "asset.service", contractVersion: "1" })).toBeUndefined();
    expect(bridge.handshake({ connectionId: "connection:1", authorityInstanceId: "authority:1", protocolVersion: "1" }).accepted).toBe(true);
    expect(bridge.applySnapshot({
      connectionId: "connection:1",
      authorityInstanceId: "authority:1",
      snapshotRevision: 1,
      baseline: false,
      services: [],
    })).toMatchObject({ accepted: false, reason: "baseline-required" });
    expect(bridge.applySnapshot({
      connectionId: "connection:1",
      authorityInstanceId: "authority:1",
      snapshotRevision: 1,
      baseline: true,
      services: [reference()],
    })).toMatchObject({ accepted: true, state: "ready" });

    const proxy = bridge.requireProxy({ capabilityId: "asset.service", contractVersion: "1" });
    await expect(proxy.call({ type: "get" })).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect((calls[0] as { context: { reference: { providerInstanceId: string } } }).context.reference.providerInstanceId).toBe("provider:1");
  });

  it("rejects gaps and permanently invalidates an old provider proxy", async () => {
    const bridge = createServiceBridge({
      protocolVersion: "1",
      transport: {
        call: vi.fn(async () => "ok") as unknown as RemoteServiceTransport["call"],
      },
    });
    bridge.handshake({ connectionId: "connection:1", authorityInstanceId: "authority:1", protocolVersion: "1" });
    bridge.applySnapshot({ connectionId: "connection:1", authorityInstanceId: "authority:1", snapshotRevision: 1, baseline: true, services: [reference()] });
    const oldProxy = bridge.requireProxy({ capabilityId: "asset.service", contractVersion: "1" });

    expect(bridge.applySnapshot({ connectionId: "connection:1", authorityInstanceId: "authority:1", snapshotRevision: 3, baseline: false, services: [reference({ providerInstanceId: "provider:2", snapshotRevision: 3 })] })).toMatchObject({
      accepted: false,
      reason: "revision-gap",
      expectedRevision: 2,
    });
    expect(bridge.state).toBe("stale");
    expect(oldProxy.revoked).toBe(true);

    bridge.applySnapshot({ connectionId: "connection:1", authorityInstanceId: "authority:1", snapshotRevision: 3, baseline: true, services: [reference({ providerInstanceId: "provider:2", snapshotRevision: 3 })] });
    const newProxy = bridge.requireProxy({ capabilityId: "asset.service", contractVersion: "1" });
    expect(newProxy.reference.providerInstanceId).toBe("provider:2");
    await expect(oldProxy.call({})).rejects.toBeInstanceOf(RemoteServiceUnavailableError);

    const wrongConnection = bridge.applySnapshot({ connectionId: "old-connection", authorityInstanceId: "authority:1", snapshotRevision: 4, baseline: false, services: [] });
    expect(wrongConnection).toMatchObject({ accepted: false, reason: "wrong-connection" });

    bridge.disconnect("port closed");
    expect(bridge.state).toBe("disconnected");
    expect(bridge.services()).toEqual([]);
    expect(bridge.getProxy({ capabilityId: "asset.service", contractVersion: "1" })).toBeUndefined();
  });

  it("invalidates a proxy captured from an older directory revision", () => {
    const bridge = createServiceBridge({
      protocolVersion: "1",
      transport: {
        call: vi.fn(async () => "ok") as unknown as RemoteServiceTransport["call"],
      },
    });
    bridge.handshake({ connectionId: "connection:1", authorityInstanceId: "authority:1", protocolVersion: "1" });
    bridge.applySnapshot({
      connectionId: "connection:1",
      authorityInstanceId: "authority:1",
      snapshotRevision: 1,
      baseline: true,
      services: [reference({ snapshotRevision: 1 })],
    });
    const oldProxy = bridge.requireProxy({ capabilityId: "asset.service", contractVersion: "1" });

    expect(bridge.applySnapshot({
      connectionId: "connection:1",
      authorityInstanceId: "authority:1",
      snapshotRevision: 2,
      baseline: false,
      services: [reference({ snapshotRevision: 2 })],
    })).toMatchObject({ accepted: true, snapshotRevision: 2 });
    expect(oldProxy.revoked).toBe(true);
    const currentProxy = bridge.requireProxy({ capabilityId: "asset.service", contractVersion: "1" });
    expect(currentProxy.reference.snapshotRevision).toBe(2);
  });

  it("rejects an ambiguous service lookup instead of choosing the first provider", () => {
    const bridge = createServiceBridge({
      protocolVersion: "1",
      transport: {
        call: vi.fn(async () => "ok") as unknown as RemoteServiceTransport["call"],
      },
    });
    bridge.handshake({ connectionId: "connection:1", authorityInstanceId: "authority:1", protocolVersion: "1" });
    bridge.applySnapshot({
      connectionId: "connection:1",
      authorityInstanceId: "authority:1",
      snapshotRevision: 1,
      baseline: true,
      services: [reference({ providerInstanceId: "provider:1" }), reference({ providerInstanceId: "provider:2" })],
    });

    expect(() => bridge.getProxy({ capabilityId: "asset.service", contractVersion: "1" }))
      .toThrow(/ambiguous/i);
  });

  it("aborts an in-flight call when its provider proxy is invalidated", async () => {
    let resolveCall!: (value: string) => void;
    let requestSignal!: AbortSignal;
    const bridge = createServiceBridge({
      protocolVersion: "1",
      transport: {
        call: (async (_request: unknown, context: import("../contracts/lifecycle.js").RemoteServiceCallContext) => {
          requestSignal = context.signal;
          return new Promise<string>((resolve) => { resolveCall = resolve; });
        }) as unknown as RemoteServiceTransport["call"],
      },
    });
    bridge.handshake({ connectionId: "connection:1", authorityInstanceId: "authority:1", protocolVersion: "1" });
    bridge.applySnapshot({ connectionId: "connection:1", authorityInstanceId: "authority:1", snapshotRevision: 1, baseline: true, services: [reference()] });
    const proxy = bridge.requireProxy({ capabilityId: "asset.service", contractVersion: "1" });
    const call = proxy.call({ type: "long" });
    await Promise.resolve();
    expect(requestSignal.aborted).toBe(false);

    bridge.invalidate("provider restarted");
    expect(requestSignal.aborted).toBe(true);
    await expect(call).rejects.toBeInstanceOf(RemoteServiceUnavailableError);
    // 让底层替身完成，证明桥拒绝结果而不是把它迁移到新代理。
    resolveCall("late-result");
  });
});
