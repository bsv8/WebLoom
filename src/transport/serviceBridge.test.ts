import { describe, expect, it, vi } from "vitest";
import type { RemoteServiceCallContext, RemoteServiceTransport } from "../contracts/lifecycle.js";
import { createServiceBridge } from "./serviceBridge.js";

function reference(overrides: Partial<{
  serviceInstanceId: string;
  runtimeInstanceId: string;
  status: "starting" | "ready" | "unavailable" | "failed";
}> = {}) {
  return {
    capabilityId: "asset.service",
    contractVersion: "asset.service.v1",
    runtime: "shared-worker" as const,
    runtimeInstanceId: overrides.runtimeInstanceId ?? "runtime:1",
    serviceInstanceId: overrides.serviceInstanceId ?? "service:1",
    status: overrides.status ?? "ready",
    attributes: { tenancy: "shared" },
  };
}

function snapshot(
  revision: number,
  services: readonly ReturnType<typeof reference>[] = [reference()],
  overrides: Partial<{ runtimeInstanceId: string; state: "starting" | "ready" | "stopping" | "failed" | "disposed" }> = {},
) {
  return {
    protocolVersion: "webloom.remote-service.v2",
    runtimeInstanceId: overrides.runtimeInstanceId ?? "runtime:1",
    revision,
    state: overrides.state ?? "ready",
    services,
  };
}

describe("remote service bridge v2", () => {
  it("returns a lazy proxy and binds calls that start before the first snapshot", async () => {
    const calls: unknown[] = [];
    const bridge = createServiceBridge({
      protocolVersion: "webloom.remote-service.v2",
      defaultCallTimeoutMs: 100,
      transport: {
        async call<TRequest, TResult>(request: TRequest, context: RemoteServiceCallContext): Promise<TResult> {
          calls.push({ request, context });
          return { ok: true } as TResult;
        },
      },
    });
    const proxy = bridge.requireProxy({ capabilityId: "asset.service", contractVersion: "asset.service.v1" });
    expect(proxy.reference).toBeUndefined();
    const pending = proxy.call({ type: "get" });
    await Promise.resolve();
    expect(bridge.state).toBe("empty");
    bridge.applySnapshot(snapshot(0, [reference()], { state: "starting" }));
    bridge.applySnapshot(snapshot(1));
    await expect(pending).resolves.toEqual({ ok: true });
    expect(proxy.reference?.serviceInstanceId).toBe("service:1");
    expect(calls).toHaveLength(1);
  });

  it("shares one atomic first binding across concurrent calls", async () => {
    const transport = { call: vi.fn(async (_request: unknown) => "ok") } as unknown as RemoteServiceTransport;
    const bridge = createServiceBridge({ protocolVersion: "webloom.remote-service.v2", transport, defaultCallTimeoutMs: 100 });
    const proxy = bridge.requireProxy({ capabilityId: "asset.service", contractVersion: "asset.service.v1" });
    const first = proxy.call({ id: 1 });
    const second = proxy.call({ id: 2 });
    bridge.applySnapshot(snapshot(1));
    await expect(Promise.all([first, second])).resolves.toEqual(["ok", "ok"]);
    expect(proxy.reference?.serviceInstanceId).toBe("service:1");
    expect(transport.call).toHaveBeenCalledTimes(2);
  });

  it("ignores old and repeated complete snapshots without clearing the current directory", async () => {
    const bridge = createServiceBridge({
      protocolVersion: "webloom.remote-service.v2",
      transport: { call: vi.fn(async () => "ok") as unknown as RemoteServiceTransport["call"] },
    });
    bridge.applySnapshot(snapshot(2));
    expect(bridge.applySnapshot(snapshot(2))).toMatchObject({ accepted: false, reason: "stale-revision" });
    expect(bridge.applySnapshot(snapshot(1))).toMatchObject({ accepted: false, reason: "stale-revision" });
    expect(bridge.services()[0]?.serviceInstanceId).toBe("service:1");
  });

  it("rejects foreign-runtime and duplicate bindings atomically", async () => {
    const transport = { call: vi.fn(async () => "ok") } as unknown as RemoteServiceTransport;
    const bridge = createServiceBridge({
      protocolVersion: "webloom.remote-service.v2",
      transport,
      defaultCallTimeoutMs: 100,
    });
    bridge.applySnapshot(snapshot(1));
    const proxy = bridge.requireProxy({ capabilityId: "asset.service", contractVersion: "asset.service.v1" });
    await expect(proxy.call({})).resolves.toBe("ok");

    const foreign = snapshot(2, [reference({ runtimeInstanceId: "runtime:foreign", serviceInstanceId: "foreign-service" })]);
    expect(bridge.applySnapshot(foreign)).toMatchObject({ accepted: false, reason: "invalid-snapshot" });
    expect(proxy.revoked).toBe(false);
    expect(bridge.services()[0]?.runtimeInstanceId).toBe("runtime:1");

    const duplicate = snapshot(2, [reference(), reference({ serviceInstanceId: "service-2" })]);
    expect(bridge.applySnapshot(duplicate)).toMatchObject({ accepted: false, reason: "invalid-snapshot" });
    expect(proxy.revoked).toBe(false);
    expect(bridge.services()[0]?.serviceInstanceId).toBe("service:1");
  });

  it("revokes a bound proxy when its service or Runtime instance changes", async () => {
    const bridge = createServiceBridge({
      protocolVersion: "webloom.remote-service.v2",
      transport: { call: vi.fn(async () => "ok") as unknown as RemoteServiceTransport["call"] },
    });
    bridge.applySnapshot(snapshot(1));
    const oldProxy = bridge.requireProxy({ capabilityId: "asset.service", contractVersion: "asset.service.v1" });
    await oldProxy.call({});
    bridge.applySnapshot(snapshot(2, [reference({ serviceInstanceId: "service:2" })]));
    expect(oldProxy.revoked).toBe(true);
    await expect(oldProxy.call({})).rejects.toMatchObject({ code: "service_revoked" });

    const runtimeProxy = bridge.requireProxy({ capabilityId: "asset.service", contractVersion: "asset.service.v1" });
    const pending = runtimeProxy.call({});
    bridge.applySnapshot(snapshot(0, [reference({ runtimeInstanceId: "runtime:2", serviceInstanceId: "service:3" })], { runtimeInstanceId: "runtime:2" }));
    await expect(pending).rejects.toMatchObject({ code: "service_stale" });
    const newProxy = bridge.requireProxy({ capabilityId: "asset.service", contractVersion: "asset.service.v1" });
    await expect(newProxy.call({})).resolves.toBe("ok");
    expect(newProxy.reference?.runtimeInstanceId).toBe("runtime:2");
  });

  it("uses one total deadline for directory wait and remote execution", async () => {
    const bridge = createServiceBridge({
      protocolVersion: "webloom.remote-service.v2",
      defaultCallTimeoutMs: 10,
      transport: { call: vi.fn(async () => new Promise(() => undefined)) as unknown as RemoteServiceTransport["call"] },
    });
    const missing = bridge.requireProxy({ capabilityId: "missing.service", contractVersion: "missing.service.v1" });
    await expect(missing.call({})).rejects.toMatchObject({ code: "call_timeout" });

    bridge.applySnapshot(snapshot(1));
    const remote = bridge.requireProxy({ capabilityId: "asset.service", contractVersion: "asset.service.v1" });
    await expect(remote.call({}, { timeoutMs: 10 })).rejects.toMatchObject({ code: "call_timeout" });
  });

  it("returns protocol mismatch immediately and disposes pending binders", async () => {
    const bridge = createServiceBridge({
      protocolVersion: "webloom.remote-service.v2",
      defaultCallTimeoutMs: 100,
      transport: { call: vi.fn(async () => "never") as unknown as RemoteServiceTransport["call"] },
    });
    const proxy = bridge.requireProxy({ capabilityId: "asset.service", contractVersion: "asset.service.v1" });
    const pending = proxy.call({});
    bridge.markProtocolMismatch();
    await expect(pending).rejects.toMatchObject({ code: "protocol_mismatch" });
    expect(bridge.applySnapshot(snapshot(1))).toMatchObject({ accepted: true });
    bridge.dispose();
    expect(bridge.state).toBe("disposed");
    await expect(bridge.requireProxy({ capabilityId: "new", contractVersion: "new.v1" }).call({})).rejects.toMatchObject({ code: "transport_unavailable" });
  });
});
