import { describe, expect, it } from "vitest";
import { defineCapability, type RemoteCapability } from "../contracts/capability.js";
import { definePlugin } from "../authoring/definePlugin.js";
import { createWindowApp } from "./windowRuntime.js";
import { connectSharedWorkerForTesting } from "./connectSharedWorker.js";
import { startSharedWorkerAppForTesting, type SharedWorkerScopeLike, type StartSharedWorkerAppForTestingOptions } from "./sharedWorkerHost.js";
import {
  createRuntimeMessageCodec,
  RUNTIME_PROTOCOL_VERSION,
  RUNTIME_RESULT_TYPE,
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
      callId: "call:one",
      serviceInstanceId: "service:one",
      result: { ok: true },
    })).toMatchObject({ type: RUNTIME_RESULT_TYPE });
    const rejectedProtocol = ["webloom.runtime", "v2"].join(".");
    expect(() => codec.decode({ type: `${rejectedProtocol}.result`, protocolVersion: rejectedProtocol })).toThrow(/protocol/i);
    expect(() => codec.decode({
      type: RUNTIME_RESULT_TYPE,
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      callId: "call:one",
      serviceInstanceId: "service:one",
      result: {},
      done: true,
    })).toThrow();
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
