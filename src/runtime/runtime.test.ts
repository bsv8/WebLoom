import { describe, expect, it } from "vitest";
import { defineCapability, type RemoteCapability } from "../contracts/capability.js";
import { definePlugin } from "../authoring/definePlugin.js";
import { createWindowApp } from "./windowRuntime.js";
import { connectSharedWorkerForTesting } from "./connectSharedWorker.js";
import { startSharedWorkerAppForTesting, type SharedWorkerScopeLike, type StartSharedWorkerAppForTestingOptions } from "./sharedWorkerHost.js";
import {
  createRuntimeMessageCodec,
  RUNTIME_CANCEL_TYPE,
  RUNTIME_CLOSE_ACK_TYPE,
  RUNTIME_CLOSE_TYPE,
  RUNTIME_CREDIT_TYPE,
  RUNTIME_ERROR_MESSAGE_TYPE,
  RUNTIME_ERROR_TYPE,
  RUNTIME_NEXT_TYPE,
  RUNTIME_PROTOCOL_VERSION,
  RUNTIME_RESULT_TYPE,
  RUNTIME_SNAPSHOT_TYPE,
} from "./runtimeProtocol.js";

const Echo = defineCapability({
  kind: "rpc",
  id: "runtime.echo",
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
const LocalIo = defineCapability({
  kind: "rpc",
  id: "runtime.local-io",
  version: "1",
  request: { parse(value: unknown): { value: string } { return value as { value: string }; } },
  response: { parse(value: unknown): { result: string } { return value as { result: string }; } },
});
const Other = defineCapability({
  kind: "rpc",
  id: "runtime.other",
  version: "1",
  request: { parse(value: unknown): { value: string } { return value as { value: string }; } },
  response: { parse(value: unknown): { result: string } { return value as { result: string }; } },
});

const workerBinding = { runtimeInstanceId: "worker:one", connectionId: "direct:worker:one" } as const;

interface TestWorker {
  readonly workerApp: ReturnType<typeof startSharedWorkerAppForTesting>;
  readonly factory: (url: string | URL, options: { type: "module" }) => { readonly port: MessagePort };
}

function createWorker(
  workerPlugin: ReturnType<typeof definePlugin>,
  exposed: readonly RemoteCapability[] = [Echo],
  overrides: Pick<StartSharedWorkerAppForTestingOptions, "configurePeer" | "peerExposureAllowlist"> = {},
): TestWorker {
  const scope: SharedWorkerScopeLike = { onconnect: null };
  const workerApp = startSharedWorkerAppForTesting({ id: "runtime-worker", plugins: [workerPlugin], expose: exposed, ...overrides, globalScope: scope });
  return {
    workerApp,
    factory() {
      const channel = new MessageChannel();
      queueMicrotask(() => scope.onconnect?.({ ports: [channel.port2] }));
      return { port: channel.port1 };
    },
  };
}

describe("v4 Runtime", () => {
  it("uses the sole webloom.runtime.v1 codec and rejects old or contradictory messages", () => {
    const codec = createRuntimeMessageCodec();
    expect(codec.decode({
      type: RUNTIME_RESULT_TYPE,
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      binding: workerBinding,
      callId: "call:one",
      serviceInstanceId: "service:one",
      result: { ok: true },
    })).toMatchObject({ type: RUNTIME_RESULT_TYPE });
    const rejectedProtocol = ["webloom.runtime", "v2"].join(".");
    expect(() => codec.decode({ type: `${rejectedProtocol}.result`, protocolVersion: rejectedProtocol })).toThrow(/protocol/i);
    expect(() => codec.decode({
      type: RUNTIME_RESULT_TYPE,
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      binding: workerBinding,
      callId: "call:one",
      serviceInstanceId: "service:one",
      result: {},
      done: true,
    })).toThrow();
  });

  it("requires the exact framework binding on every wire message and rejects contradictory close results", () => {
    const codec = createRuntimeMessageCodec();
    const base = { protocolVersion: RUNTIME_PROTOCOL_VERSION, binding: workerBinding, callId: "call:one", serviceInstanceId: "service:one" };
    const messages: readonly Record<string, unknown>[] = [
      { type: RUNTIME_SNAPSHOT_TYPE, protocolVersion: RUNTIME_PROTOCOL_VERSION, binding: workerBinding, runtimeId: "worker", runtimeKind: "shared-worker", runtimeInstanceId: "worker:one", revision: 1, state: "starting", units: [], services: [] },
      { type: RUNTIME_ERROR_TYPE, ...base, code: "invalid_message", message: "invalid", phase: "receive" },
      { type: "webloom.runtime.v1.call", ...base, capabilityId: Echo.id, contractVersion: Echo.version, mode: "unary", timeoutMs: 100, request: {} },
      { type: RUNTIME_RESULT_TYPE, ...base, result: {} },
      { type: RUNTIME_ERROR_MESSAGE_TYPE, ...base, error: { code: "handler_failed", message: "failed", phase: "execute" } },
      { type: RUNTIME_CANCEL_TYPE, ...base },
      { type: RUNTIME_NEXT_TYPE, ...base, sequence: 1, item: {} },
      { type: RUNTIME_CREDIT_TYPE, ...base, count: 1 },
      { type: RUNTIME_CLOSE_TYPE, ...base },
      { type: RUNTIME_CLOSE_ACK_TYPE, protocolVersion: RUNTIME_PROTOCOL_VERSION, binding: workerBinding, acknowledgedBinding: workerBinding, drained: true, timedOut: false, pendingExecutions: 0 },
    ];
    for (const [index, message] of messages.entries()) {
      const withoutBinding = { ...message };
      delete withoutBinding.binding;
      expect(() => codec.decode(withoutBinding)).toThrow();
      const wrongBinding = { ...message, binding: { runtimeInstanceId: "runtime:other", connectionId: "connection:other" } };
      expect(() => codec.decode(wrongBinding), `wire message index ${index}`).not.toThrow();
      expect(() => codec.decode({ ...wrongBinding, binding: undefined })).toThrow();
    }
    expect(() => codec.decode({ type: RUNTIME_CLOSE_TYPE, protocolVersion: RUNTIME_PROTOCOL_VERSION, binding: workerBinding, reason: "secret-close-reason", timeoutMs: 10 })).toThrow();
    expect(() => codec.decode({ type: RUNTIME_CLOSE_ACK_TYPE, protocolVersion: RUNTIME_PROTOCOL_VERSION, binding: workerBinding, acknowledgedBinding: workerBinding, drained: true, timedOut: true, pendingExecutions: 0 })).toThrow();
    expect(() => codec.decode({ type: RUNTIME_CLOSE_ACK_TYPE, protocolVersion: RUNTIME_PROTOCOL_VERSION, binding: workerBinding, acknowledgedBinding: workerBinding, drained: true, timedOut: false, pendingExecutions: 1 })).toThrow();
    expect(() => codec.decode({ type: RUNTIME_CLOSE_ACK_TYPE, protocolVersion: RUNTIME_PROTOCOL_VERSION, binding: workerBinding, acknowledgedBinding: workerBinding, drained: false, timedOut: true, pendingExecutions: 0 })).toThrow();
  });

  it("shares one Worker plugin unit across two Window connections", async () => {
    let setupCount = 0;
    const workerPlugin = definePlugin({
      id: "echo-provider",
      provides: [Echo] as const,
      startup: "required" as const,
      setup(ctx) {
        setupCount += 1;
        ctx.handle(Echo, (request) => ({ result: `${request.value}:${ctx.instanceId}` }));
      },
    });
    const worker = createWorker(workerPlugin);
    const first = connectSharedWorkerForTesting({ id: "runtime-worker", url: "/worker.js" }, worker.factory);
    const second = connectSharedWorkerForTesting({ id: "runtime-worker", url: "/worker.js" }, worker.factory);
    await worker.workerApp.ready();
    await Promise.all([
      expect(first.capability(Echo).call({ value: "a" })).resolves.toMatchObject({ result: expect.stringContaining(":") }),
      expect(second.capability(Echo).call({ value: "b" })).resolves.toMatchObject({ result: expect.stringContaining(":") }),
    ]);
    expect(setupCount).toBe(1);
    expect(first.runtimeInstanceId).toBe(second.runtimeInstanceId);
    expect(first.state().state).toBe("ready");
    const firstService = first.state().services[0]?.serviceInstanceId;
    const secondService = second.state().services[0]?.serviceInstanceId;
    expect(firstService).toBeTruthy();
    expect(secondService).toBeTruthy();
    expect(firstService).not.toBe(secondService);
    await first.dispose();
    await second.dispose();
    await worker.workerApp.dispose();
  });

  it("fences active peers, preserves the endpoint binding, and awaits the close handshake", async () => {
    let releaseCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    const lifecycle: import("./sharedWorkerHost.js").PeerLifecycleEvent[] = [];
    let handlerCalls = 0;
    const workerPlugin = definePlugin({
      id: "lifecycle-provider",
      provides: [Echo] as const,
      startup: "required" as const,
      setup(ctx) { ctx.handle(Echo, (request) => { handlerCalls += 1; return { result: request.value }; }); },
    });
    const worker = createWorker(workerPlugin, [Echo], {
      configurePeer(peer) {
        peer.scope.onDispose(() => cleanup, "test-close-cleanup");
      },
    });
    const removeLifecycle = worker.workerApp.subscribePeerLifecycle((event) => lifecycle.push(event));
    const runtime = connectSharedWorkerForTesting({ id: "runtime-worker", url: "/worker.js" }, worker.factory);
    await worker.workerApp.ready();
    await expect(runtime.capability(Echo).call({ value: "ready" })).resolves.toEqual({ result: "ready" });
    const active = worker.workerApp.activePeers();
    expect(active).toHaveLength(1);
    expect(active[0]?.state).toBe("active");
    expect(active[0]?.binding.runtimeInstanceId).toBe(worker.workerApp.runtimeInstanceId);
    expect(active[0]?.binding.connectionId).not.toBe(runtime.binding.connectionId);
    const peerId = active[0]!.peerId;
    expect(worker.workerApp.notifyPeerHandoff(peerId, 7)).toBe(true);
    expect(lifecycle.map((event) => event.event)).toContain("handoff");

    let settled = false;
    const disposePromise = worker.workerApp.dispose("test worker shutdown");
    void disposePromise.then(() => { settled = true; });
    // The synchronous fence removes the peer immediately, while the app
    // promise remains pending until the remote close acknowledgement and the
    // endpoint's cleanup callback have both completed.
    expect(worker.workerApp.activePeers()).toEqual([]);
    expect(lifecycle.at(-1)?.event).toBe("closing");
    expect(handlerCalls).toBe(1);
    // A capability client retained before disposal cannot start another
    // handler invocation once the Worker-side synchronous fence is active.
    await expect(runtime.capability(Echo).call({ value: "late" }, { timeoutMs: 100 })).rejects.toMatchObject({
      code: expect.stringMatching(/service_revoked|request_clone_failed|transport_unavailable/),
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseCleanup();
    await disposePromise;
    expect(settled).toBe(true);
    expect(lifecycle.at(-1)).toMatchObject({ event: "closed", peerId, binding: active[0]!.binding, state: "closed" });
    expect(lifecycle.at(-1)?.drain).toMatchObject({ drained: true, timedOut: false, pendingExecutions: 0 });
    expect(runtime.endpointState).toBe("closed");
    removeLifecycle();
    await runtime.dispose("test window shutdown");
  });

  it("allows the Window RuntimeHandle to close independently and idempotently", async () => {
    const lifecycle: import("./sharedWorkerHost.js").PeerLifecycleEvent[] = [];
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
    const workerPlugin = definePlugin({
      id: "window-close-provider",
      provides: [Echo] as const,
      startup: "required" as const,
      setup(ctx) { ctx.handle(Echo, (request) => ({ result: `worker:${request.value}` })); },
    });
    const worker = createWorker(workerPlugin);
    const removeLifecycle = worker.workerApp.subscribePeerLifecycle((event) => {
      lifecycle.push(event);
      if (event.event === "closed") resolveClosed();
    });
    const runtime = connectSharedWorkerForTesting({ id: "runtime-worker", url: "/worker.js" }, worker.factory);
    await worker.workerApp.ready();
    await expect(runtime.capability(Echo).call({ value: "before-window-close" })).resolves.toEqual({ result: "worker:before-window-close" });
    const first = runtime.dispose("window initiated close");
    const second = runtime.dispose("duplicate window close");
    expect(second).toBe(first);
    await first;
    await closed;
    expect(runtime.endpointState).toBe("closed");
    expect(worker.workerApp.activePeers()).toEqual([]);
    expect(lifecycle.map((event) => event.event)).toEqual(["active", "closing", "closed"]);
    expect(lifecycle.at(-1)?.drain).toMatchObject({ drained: true, timedOut: false, pendingExecutions: 0 });
    removeLifecycle();
    await worker.workerApp.dispose();
  });

  it("supports a typed Window-to-Worker reverse call on the same private port", async () => {
    const page = await createWindowApp({
      plugins: [definePlugin({
        id: "page-io",
        provides: [LocalIo] as const,
        startup: "required" as const,
        setup(ctx) { ctx.handle(LocalIo, (request) => ({ result: `page:${request.value}` })); },
      })],
    });
    const workerPlugin = definePlugin({
      id: "session-provider",
      provides: [Echo] as const,
      dependencies: [{ capability: LocalIo, source: "peer" }] as const,
      startup: "required" as const,
      setup(ctx) {
        ctx.handle(Echo, async (request, call) => {
          const peer = call.peer;
          if (!peer) throw new Error("peer is required");
          const io = peer.capability(LocalIo);
          const result = await io.call({ value: request.value });
          return { result: result.result };
        });
      },
    });
    const worker = createWorker(workerPlugin);
    const runtime = connectSharedWorkerForTesting({ id: "runtime-worker", url: "/worker.js", client: { app: page, expose: [LocalIo] } }, worker.factory);
    await worker.workerApp.ready();
    await expect(runtime.capability(Echo).call({ value: "round-trip" })).resolves.toEqual({ result: "page:round-trip" });
    await runtime.dispose();
    await worker.workerApp.dispose();
    await page.dispose();
  });

  it("keeps top-level exposure working when the dynamic allowlist is disjoint", async () => {
    let dynamicError: unknown;
    const workerPlugin = definePlugin({
      id: "top-level-provider",
      provides: [Echo, Other] as const,
      startup: "required" as const,
      setup(ctx) {
        ctx.handle(Echo, (request) => ({ result: `top:${request.value}` }));
        ctx.handle(Other, (request) => ({ result: `other:${request.value}` }));
      },
    });
    const worker = createWorker(workerPlugin, [Echo], {
      peerExposureAllowlist: [Other],
      configurePeer(peer) {
        try { peer.expose(Echo); } catch (error) { dynamicError = error; }
      },
    });
    const runtime = connectSharedWorkerForTesting({ id: "runtime-worker", url: "/worker.js" }, worker.factory);
    await worker.workerApp.ready();
    expect(dynamicError).toMatchObject({ code: "capability_unavailable" });
    await expect(runtime.capability(Echo).call({ value: "ok" })).resolves.toEqual({ result: "top:ok" });
    await runtime.dispose();
    await worker.workerApp.dispose();
  });

  it("rejects a dynamic exposure outside an explicit allowlist", async () => {
    let dynamicError: unknown;
    const workerPlugin = definePlugin({
      id: "dynamic-provider",
      provides: [Echo] as const,
      startup: "required" as const,
      setup(ctx) { ctx.handle(Echo, (request) => ({ result: request.value })); },
    });
    const worker = createWorker(workerPlugin, [], {
      peerExposureAllowlist: [Other],
      configurePeer(peer) {
        try { peer.expose(Echo); } catch (error) { dynamicError = error; }
      },
    });
    const runtime = connectSharedWorkerForTesting({ id: "runtime-worker", url: "/worker.js" }, worker.factory);
    await worker.workerApp.ready();
    expect(dynamicError).toMatchObject({ code: "capability_unavailable" });
    expect(runtime.state().services).toEqual([]);
    await runtime.dispose();
    await worker.workerApp.dispose();
  });

  it("rejects every dynamic exposure when no allowlist is configured", async () => {
    let dynamicError: unknown;
    const workerPlugin = definePlugin({
      id: "closed-dynamic-provider",
      provides: [Echo] as const,
      startup: "required" as const,
      setup(ctx) { ctx.handle(Echo, (request) => ({ result: request.value })); },
    });
    const worker = createWorker(workerPlugin, [], {
      configurePeer(peer) {
        try { peer.expose(Echo); } catch (error) { dynamicError = error; }
      },
    });
    const runtime = connectSharedWorkerForTesting({ id: "runtime-worker", url: "/worker.js" }, worker.factory);
    await worker.workerApp.ready();
    expect(dynamicError).toMatchObject({ code: "capability_unavailable" });
    expect(runtime.state().services).toEqual([]);
    await runtime.dispose();
    await worker.workerApp.dispose();
  });
});
