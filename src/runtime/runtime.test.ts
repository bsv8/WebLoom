import { describe, expect, it } from "vitest";
import { definePlugin } from "../authoring/definePlugin.js";
import type { PluginManifestInput } from "../contracts/plugin.js";
import { connectSharedWorkerForTesting } from "../testing.js";
import { startSharedWorkerApp, type SharedWorkerScopeLike } from "./sharedWorkerHost.js";
import { RUNTIME_PROTOCOL_VERSION, RUNTIME_SNAPSHOT_TYPE } from "./runtimeProtocol.js";
import { createWindowApp } from "./windowRuntime.js";

function createWorkerHarness() {
  const scope: SharedWorkerScopeLike = { onconnect: null };
  const serverPorts: MessagePort[] = [];
  const workerErrors = new Set<() => void>();
  const factory = () => {
    const channel = new MessageChannel();
    serverPorts.push(channel.port2);
    queueMicrotask(() => scope.onconnect?.({ ports: [channel.port2] }));
    return {
      port: channel.port1,
      addEventListener(_type: "error", listener: (event: Event) => void) { workerErrors.add(() => listener(new Event("error"))); },
      removeEventListener(_type: "error", _listener: (event: Event) => void) { /* test worker keeps no-op listeners */ },
    };
  };
  return {
    scope,
    factory,
    fail() { for (const emit of [...workerErrors]) emit(); },
    serverPorts,
  };
}

function createTrackedPort(): { port: MessagePort; messages: unknown[]; isClosed(): boolean } {
  const messages: unknown[] = [];
  let closed = false;
  const port = {
    postMessage(message: unknown) {
      if (closed) throw new Error("port is closed");
      messages.push(message);
    },
    addEventListener() { /* late rejected ports never install listeners */ },
    removeEventListener() { /* noop */ },
    start() { /* noop */ },
    close() { closed = true; },
  } as unknown as MessagePort;
  return { port, messages, isClosed: () => closed };
}

describe("browser runtime APIs", () => {
  it("creates a Window Runtime without a manual registry or host register call", async () => {
    let setupCount = 0;
    const plugin = definePlugin({
      id: "hello",
      provides: ["hello.service"],
      setup(ctx) {
        setupCount += 1;
        ctx.provide("hello.service", { value: "window" });
      },
    });
    const app = await createWindowApp({ plugins: [plugin] });
    expect(app.runtimeKind).toBe("window-main");
    expect(app.state().runtimeInstanceId).not.toBe("");
    expect(app.capability<{ value: string }>("hello.service").value).toBe("window");
    expect(setupCount).toBe(1);
    await app.dispose();
    expect(() => app.capability("hello.service")).toThrow(/disposed/i);
  });

  it("binds a shared static multi-runtime descriptor to the current Window implementation", async () => {
    let setupCount = 0;
    const manifest: PluginManifestInput = {
      id: "shared-descriptor",
      name: "Shared descriptor",
      meta: { defaultEnabled: true, canDisable: true },
      units: [
        { id: "shared-descriptor.worker", runtime: "shared-worker", provides: ["worker.only"] },
        { id: "shared-descriptor.window", runtime: "window-main", provides: ["window.only"] },
      ],
    };
    const app = await createWindowApp({
      plugins: [{
        manifest,
        setup(ctx) {
          setupCount += 1;
          ctx.provide("window.only", { runtime: "window" });
        },
      }],
    });
    expect(setupCount).toBe(1);
    expect(app.capability<{ runtime: string }>("window.only")).toEqual({ runtime: "window" });
    expect(app.state().units).toEqual([
      expect.objectContaining({ unitId: "shared-descriptor.window", runtime: "window-main", state: "enabled" }),
    ]);
    await app.dispose();
  });

  it("synchronously returns handles, shares one Worker Runtime, and keeps ports isolated", async () => {
    const harness = createWorkerHarness();
    let setupCount = 0;
    const plugin = definePlugin({
      id: "shared-hello",
      runtime: "shared-worker",
      provides: ["hello.service"],
      setup(ctx) {
        setupCount += 1;
        ctx.provide("hello.service", {
          handle(request: { value: string }) { return { value: `${request.value}:${ctx.instanceId}` }; },
        });
      },
    });
    const worker = startSharedWorkerApp({ id: "coordinator", plugins: [plugin], globalScope: harness.scope });
    const first = connectSharedWorkerForTesting({ id: "coordinator", url: "./coordinator.worker.ts" }, harness.factory);
    const second = connectSharedWorkerForTesting({ id: "coordinator", url: "./coordinator.worker.ts" }, harness.factory);
    expect(first).not.toBeInstanceOf(Promise);
    const oldProxy = first.capability<{ value: string }>("hello.service");
    const secondProxy = second.capability<{ value: string }>("hello.service");
    await expect(oldProxy.call({ value: "one" })).resolves.toMatchObject({ value: expect.stringContaining("one:") });
    await expect(secondProxy.call({ value: "two" })).resolves.toMatchObject({ value: expect.stringContaining("two:") });
    expect(setupCount).toBe(1);
    expect(first.runtimeInstanceId).toBe(worker.runtimeInstanceId);
    expect(second.runtimeInstanceId).toBe(worker.runtimeInstanceId);
    await first.dispose();
    await expect(oldProxy.call({ value: "stale" })).rejects.toMatchObject({ code: "service_revoked" });
    await second.dispose();
    await worker.dispose();
  });

  it("publishes stopping and disposed snapshots before closing every endpoint", async () => {
    const harness = createWorkerHarness();
    const worker = startSharedWorkerApp({
      id: "terminal-worker",
      plugins: [definePlugin({
        id: "terminal-provider",
        runtime: "shared-worker",
        provides: ["terminal.service"],
        setup(ctx) { ctx.provide("terminal.service", { handle: () => ({ ok: true, instanceId: ctx.instanceId }) }); },
      })],
      globalScope: harness.scope,
    });
    const first = connectSharedWorkerForTesting({ id: "terminal-worker", url: "./terminal.worker.ts" }, harness.factory);
    const second = connectSharedWorkerForTesting({ id: "terminal-worker", url: "./terminal.worker.ts" }, harness.factory);
    const states: string[] = [];
    first.subscribe((snapshot) => states.push(snapshot.state));
    second.subscribe((snapshot) => states.push(snapshot.state));
    const oldProxy = first.capability("terminal.service");
    await expect(oldProxy.call({})).resolves.toMatchObject({ ok: true });
    await waitFor(() => second.state().state === "ready");

    const dispose = worker.dispose("terminal test");
    await waitFor(() => states.filter((state) => state === "stopping").length >= 2);
    const startedAt = Date.now();
    await expect(oldProxy.call({}, { timeoutMs: 1_000 })).rejects.toMatchObject({
      code: expect.stringMatching(/transport_unavailable|service_revoked/),
    });
    expect(Date.now() - startedAt).toBeLessThan(200);
    await dispose;
    await waitFor(() => states.filter((state) => state === "disposed").length >= 2);
    expect(states).toContain("stopping");
    expect(states).toContain("disposed");

    await first.dispose();
    await second.dispose();
  });

  it("rejects a connection during Host drain before the domain hook or Provider", async () => {
    let releaseDrain!: () => void;
    let drainStarted = false;
    let hookCalls = 0;
    let handlerCalls = 0;
    const drain = new Promise<void>((resolve) => { releaseDrain = resolve; });
    const scope: SharedWorkerScopeLike = { onconnect: null };
    const worker = startSharedWorkerApp({
      id: "draining-worker",
      lifecycleCleanupTimeoutMs: 5_000,
      onPortConnect: () => { hookCalls += 1; },
      plugins: [definePlugin({
        id: "draining-provider",
        runtime: "shared-worker",
        provides: ["draining.service"],
        setup(ctx) {
          ctx.provide("draining.service", { handle: () => { handlerCalls += 1; return { ok: true }; } });
          ctx.onDispose(async () => { drainStarted = true; await drain; });
        },
      })],
      globalScope: scope,
    });
    await worker.ready();
    const initial = new MessageChannel();
    scope.onconnect?.({ ports: [initial.port2] });
    expect(hookCalls).toBe(1);

    const disposing = worker.dispose("drain connection gate test");
    await waitFor(() => drainStarted);
    const late = createTrackedPort();
    scope.onconnect?.({ ports: [late.port] });
    await waitFor(() => late.isClosed());
    expect(hookCalls).toBe(1);
    expect(handlerCalls).toBe(0);
    expect(late.messages).toEqual([expect.objectContaining({
      type: RUNTIME_SNAPSHOT_TYPE,
      state: "stopping",
      runtimeId: "draining-worker",
    })]);

    releaseDrain();
    await disposing;
    initial.port1.close();
  });

  it("rejects a connection after disposal with the current disposed snapshot", async () => {
    let hookCalls = 0;
    const scope: SharedWorkerScopeLike = { onconnect: null };
    const worker = startSharedWorkerApp({
      id: "disposed-worker",
      onPortConnect: () => { hookCalls += 1; },
      plugins: [],
      globalScope: scope,
    });
    await worker.ready();
    await worker.dispose("disposed connection gate test");
    const late = createTrackedPort();
    scope.onconnect?.({ ports: [late.port] });
    await waitFor(() => late.isClosed());
    expect(hookCalls).toBe(0);
    expect(late.messages).toEqual([expect.objectContaining({
      type: RUNTIME_SNAPSHOT_TYPE,
      state: "disposed",
      runtimeId: "disposed-worker",
    })]);
  });

  it("projects a lazy SharedWorker capability into a Window Host", async () => {
    const harness = createWorkerHarness();
    const worker = startSharedWorkerApp({
      id: "projected-worker",
      plugins: [definePlugin({
        id: "remote-provider",
        runtime: "shared-worker",
        provides: ["remote.service"],
        setup(ctx) { ctx.provide("remote.service", { handle: (request: { value: string }) => ({ value: `${request.value}:${ctx.instanceId}` }) }); },
      })],
      globalScope: harness.scope,
    });
    const runtime = connectSharedWorkerForTesting({ id: "projected-worker", url: "./projected.worker.ts" }, harness.factory);
    const windowApp = await createWindowApp({
      remoteRuntime: runtime,
      plugins: [definePlugin({
        id: "remote-consumer",
        dependencies: [{ capability: "remote.service", contractVersion: "remote.service.v1", sourceRuntime: "shared-worker" }],
        provides: ["window.service"],
        setup(ctx) {
          const proxy = ctx.serviceBridge?.requireProxy({ capabilityId: "remote.service", contractVersion: "remote.service.v1", runtime: "shared-worker" }, ctx.scope);
          ctx.provide("window.service", proxy);
        },
      })],
    });
    await waitFor(() => windowApp.state().units.some((unit) => unit.state === "enabled"));
    const service = windowApp.capability<{ call: (request: { value: string }) => Promise<unknown> }>("window.service");
    await expect(service.call({ value: "before" })).resolves.toMatchObject({ value: expect.stringContaining("before:") });
    await runtime.dispose();
    await expect(service.call({ value: "stale" })).rejects.toMatchObject({ code: expect.stringMatching(/service_revoked|transport_unavailable/) });
    await windowApp.dispose();
    await worker.dispose();
  });

  it("returns protocol mismatch from call, while an unparseable peer reaches call_timeout", async () => {
    const mismatchScope: SharedWorkerScopeLike = { onconnect: null };
    startSharedWorkerApp({ id: "mismatch", plugins: [], globalScope: mismatchScope });
    // The Runtime host emits a valid v2 snapshot; inject an incompatible but
    // structurally parseable snapshot before the call to exercise the gate.
    const mismatchChannel = new MessageChannel();
    const mismatchRuntime = connectSharedWorkerForTesting({
      id: "mismatch",
      url: "./mismatch.worker.ts",
      defaultCallTimeoutMs: 20,
    }, () => {
      queueMicrotask(() => mismatchScope.onconnect?.({ ports: [mismatchChannel.port2] }));
      return { port: mismatchChannel.port1 };
    });
    mismatchChannel.port2.postMessage({
      type: RUNTIME_SNAPSHOT_TYPE,
      protocolVersion: `${RUNTIME_PROTOCOL_VERSION}.old`,
      runtimeId: "mismatch",
      runtimeKind: "shared-worker",
      runtimeInstanceId: "runtime:old",
      revision: 0,
      state: "ready",
      units: [],
      services: [],
    });
    await expect(mismatchRuntime.capability("missing.service").call({})).rejects.toMatchObject({ code: "protocol_mismatch" });
    await mismatchRuntime.dispose();

    const silent = connectSharedWorkerForTesting({ id: "silent", url: "./silent.worker.ts", defaultCallTimeoutMs: 10 }, () => ({ port: new MessageChannel().port1 }));
    await expect(silent.capability("missing.service").call({})).rejects.toMatchObject({ code: "call_timeout" });
    await silent.dispose();
  });

  it("does not automatically create a second Worker after a disconnect", async () => {
    const harness = createWorkerHarness();
    const worker = startSharedWorkerApp({ id: "disconnect-worker", plugins: [], globalScope: harness.scope });
    let factoryCalls = 0;
    const runtime = connectSharedWorkerForTesting({ id: "disconnect-worker", url: "./disconnect.worker.ts" }, () => { factoryCalls += 1; return harness.factory(); });
    const proxy = runtime.capability("missing.service");
    harness.fail();
    await waitFor(() => runtime.state().state === "disconnected");
    expect(factoryCalls).toBe(1);
    await expect(proxy.call({}, { timeoutMs: 10 })).rejects.toMatchObject({ code: "service_revoked" });
    await runtime.dispose();
    await worker.dispose();
  });

  it("rejects contradictory required metadata instead of allowing meta to downgrade startup", () => {
    expect(() => definePlugin({ id: "required-policy", required: true, meta: { defaultEnabled: false, canDisable: true, startup: "optional" }, setup() {} })).toThrow(/required metadata is inconsistent/);
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition did not become true");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}
