import { describe, expect, it } from "vitest";
import { definePlugin } from "../authoring/definePlugin.js";
import type { PluginManifestInput } from "../contracts/plugin.js";
import { connectSharedWorker } from "./connectSharedWorker.js";
import { startSharedWorkerApp, type SharedWorkerScopeLike } from "./sharedWorkerHost.js";
import { RUNTIME_ERROR_TYPE, RUNTIME_HELLO_TYPE, RUNTIME_PROTOCOL_VERSION } from "./runtimeProtocol.js";
import { createWindowApp } from "./windowRuntime.js";

function createWorkerHarness() {
  const scope: SharedWorkerScopeLike = { onconnect: null };
  const serverPorts: MessagePort[] = [];
  const factory = () => {
    const channel = new MessageChannel();
    serverPorts.push(channel.port2);
    queueMicrotask(() => scope.onconnect?.({ ports: [channel.port2] }));
    return { port: channel.port1 };
  };
  return {
    scope,
    factory,
    disconnect(index = 0) {
      serverPorts[index]?.postMessage({
        type: "webloom.runtime.disconnect",
        reason: "simulated transport disconnect",
      });
    },
  };
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
    const firstInstance = app.state().units[0]?.instanceId;
    await app.dispose();
    expect(() => app.capability("hello.service")).toThrow(/disposed/i);
    expect(firstInstance).toBeTruthy();
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

  it("runs one SharedWorker unit for multiple Window connections and invalidates old proxies", async () => {
    const harness = createWorkerHarness();
    let setupCount = 0;
    const plugin = definePlugin({
      id: "shared-hello",
      runtime: "shared-worker",
      provides: ["hello.service"],
      setup(ctx) {
        setupCount += 1;
        ctx.provide("hello.service", {
          handle(request: { value: string }) {
            return { value: `${request.value}:${ctx.instanceId}` };
          },
        });
      },
    });
    const worker = startSharedWorkerApp({
      id: "coordinator",
      plugins: [plugin],
      globalScope: harness.scope,
    });

    const first = await connectSharedWorker({
      id: "coordinator",
      url: "./coordinator.worker.ts",
      workerFactory: harness.factory,
    });
    const second = await connectSharedWorker({
      id: "coordinator",
      url: "./coordinator.worker.ts",
      workerFactory: harness.factory,
    });
    expect(setupCount).toBe(1);
    expect(first.runtimeInstanceId).toBe(worker.runtimeInstanceId);
    expect(second.runtimeInstanceId).toBe(first.runtimeInstanceId);
    expect(first.connectionId).not.toBe(second.connectionId);

    const oldProxy = first.capability<{ value: string }>("hello.service");
    await expect(oldProxy.call({ value: "one" })).resolves.toMatchObject({ value: expect.stringContaining("one:") });
    await first.dispose();
    await expect(oldProxy.call({ value: "stale" })).rejects.toMatchObject({ code: "service.unavailable" });
    const secondProxy = second.capability<{ value: string }>("hello.service");
    await expect(secondProxy.call({ value: "two" })).resolves.toMatchObject({ value: expect.stringContaining("two:") });

    await second.dispose();
    await worker.dispose();
  });

  it("projects a ready SharedWorker capability into a Window Host and reconciles disconnect/reconnect", async () => {
    const harness = createWorkerHarness();
    const worker = startSharedWorkerApp({
      id: "projected-worker",
      plugins: [definePlugin({
        id: "remote-provider",
        runtime: "shared-worker",
        provides: ["remote.service"],
        setup(ctx) {
          ctx.provide("remote.service", {
            handle(request: { value: string }) {
              return { value: `${request.value}:${ctx.instanceId}` };
            },
          });
        },
      })],
      globalScope: harness.scope,
    });
    const runtime = await connectSharedWorker({
      id: "projected-worker",
      url: "./projected.worker.ts",
      reconnectDelayMs: 25,
      workerFactory: harness.factory,
    });
    const windowApp = await createWindowApp({
      remoteRuntime: runtime,
      plugins: [definePlugin({
        id: "remote-consumer",
        dependencies: [{
          capability: "remote.service",
          contractVersion: "remote.service.v1",
          sourceRuntime: "shared-worker",
        }],
        provides: ["window.service"],
        setup(ctx) {
          const proxy = ctx.serviceBridge?.requireProxy({
            capabilityId: "remote.service",
            contractVersion: "remote.service.v1",
            runtime: "shared-worker",
          }, ctx.scope);
          ctx.provide("window.service", proxy);
        },
      })],
    });
    const oldProxy = windowApp.capability<{ call: (request: { value: string }) => Promise<unknown> }>("window.service");
    await expect(oldProxy.call({ value: "before" })).resolves.toMatchObject({ value: expect.stringContaining("before:") });

    harness.disconnect();
    await waitFor(() => runtime.state().state === "disconnected");
    await waitFor(() => windowApp.state().units.some((unit) => unit.state === "blocked"));
    await expect(oldProxy.call({ value: "stale" })).rejects.toMatchObject({ code: "service.unavailable" });

    await runtime.ready();
    await waitFor(() => windowApp.state().units.some((unit) => unit.state === "enabled"));
    await windowApp.dispose();
    await runtime.dispose();
    await worker.dispose();
  });

  it("rejects contradictory required metadata instead of allowing meta to downgrade startup", () => {
    expect(() => definePlugin({
      id: "required-policy",
      required: true,
      meta: { defaultEnabled: false, canDisable: true, startup: "optional" },
      setup() {},
    })).toThrow(/required metadata is inconsistent/);
  });

  it("uses an explicit unitId as the only Host projection for a multi-unit manifest", async () => {
    let setupCount = 0;
    const app = await createWindowApp({
      plugins: [{
        unitId: "multi.window",
        manifest: {
          id: "multi-selected",
          name: "Multi selected",
          meta: { defaultEnabled: true, canDisable: true },
          units: [
            { id: "multi.worker", runtime: "shared-worker", provides: ["worker.only"] },
            { id: "multi.window", runtime: "window-main", provides: ["window.only"] },
          ],
        },
        setup(ctx) {
          setupCount += 1;
          ctx.provide("window.only", { ok: true });
        },
      }],
    });
    expect(setupCount).toBe(1);
    expect(app.state().units).toEqual([
      expect.objectContaining({ unitId: "multi.window", runtime: "window-main", state: "enabled" }),
    ]);
    await app.dispose();
  });

  it("rejects a required Window plugin with structured runtime initialization details", async () => {
    const plugin = definePlugin({
      id: "required-failure",
      required: true,
      setup() {
        throw new Error("required setup failed");
      },
    });

    await expect(createWindowApp({ plugins: [plugin] })).rejects.toMatchObject({
      code: "runtime.initialization_failed",
      details: {
        pluginId: "required-failure",
        unitId: "required-failure",
        phase: "startup",
      },
    });
  });

  it("keeps an optional startup failure observable without blocking an independent required plugin", async () => {
    const optional = definePlugin({
      id: "optional-failure",
      setup() {
        throw new Error("optional setup failed");
      },
    });
    const required = definePlugin({
      id: "required-success",
      required: true,
      provides: ["required.service"],
      setup(ctx) {
        ctx.provide("required.service", { ok: true });
      },
    });

    const app = await createWindowApp({ plugins: [optional, required] });
    expect(app.capability<{ ok: boolean }>("required.service")).toEqual({ ok: true });
    expect(app.state().units).toEqual(expect.arrayContaining([
      expect.objectContaining({ pluginId: "optional-failure", state: "error-disabled" }),
      expect.objectContaining({ pluginId: "required-success", state: "enabled" }),
    ]));
    await app.dispose();
  });

  it("fails a SharedWorker handshake closed on a protocol mismatch", async () => {
    const harness = createWorkerHarness();
    const worker = startSharedWorkerApp({
      id: "protocol-worker",
      plugins: [],
      globalScope: harness.scope,
    });
    await worker.ready();

    const channel = new MessageChannel();
    const error = new Promise<Record<string, unknown>>((resolve) => {
      channel.port1.addEventListener("message", (event) => {
        if (event.data?.type === RUNTIME_ERROR_TYPE) resolve(event.data);
      });
    });
    channel.port1.start();
    harness.scope.onconnect?.({ ports: [channel.port2] });
    channel.port1.postMessage({
      type: RUNTIME_HELLO_TYPE,
      protocolVersion: `${RUNTIME_PROTOCOL_VERSION}.incompatible`,
      connectionId: "protocol-worker:connection:bad",
      runtimeId: "protocol-worker",
    });

    await expect(error).resolves.toMatchObject({
      type: RUNTIME_ERROR_TYPE,
      code: "runtime.protocol_mismatch",
    });
    channel.port1.close();
    await worker.dispose();
  });

  it("reconnects with a new connection and never rebinds an old proxy", async () => {
    const harness = createWorkerHarness();
    let setupCount = 0;
    const plugin = definePlugin({
      id: "reconnect-service",
      runtime: "shared-worker",
      provides: ["reconnect.service"],
      setup(ctx) {
        setupCount += 1;
        ctx.provide("reconnect.service", {
          handle() {
            return { instanceId: ctx.instanceId };
          },
        });
      },
    });
    const worker = startSharedWorkerApp({
      id: "reconnect-worker",
      plugins: [plugin],
      globalScope: harness.scope,
    });
    const runtime = await connectSharedWorker({
      id: "reconnect-worker",
      url: "./reconnect.worker.ts",
      reconnectDelayMs: 0,
      workerFactory: harness.factory,
    });
    const oldConnectionId = runtime.connectionId;
    const oldProxy = runtime.capability("reconnect.service");
    harness.disconnect();

    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 1_000;
      const check = () => {
        if (runtime.state().state === "ready" && runtime.connectionId !== oldConnectionId) {
          resolve();
          return;
        }
        if (Date.now() >= deadline) {
          reject(new Error(`runtime did not reconnect: ${runtime.state().state}`));
          return;
        }
        setTimeout(check, 5);
      };
      check();
    });

    expect(runtime.connectionId).not.toBe(oldConnectionId);
    expect(setupCount).toBe(1);
    await expect(oldProxy.call({})).rejects.toMatchObject({ code: "service.unavailable" });
    await expect(runtime.capability<{ instanceId: string }>("reconnect.service").call({}))
      .resolves.toEqual(expect.objectContaining({ instanceId: expect.any(String) }));
    await runtime.dispose();
    await worker.dispose();
  });

  it("settles a connection on handshake timeout instead of leaving ready pending", async () => {
    const channel = new MessageChannel();
    await expect(connectSharedWorker({
      id: "timeout-worker",
      url: "./missing.worker.ts",
      handshakeTimeoutMs: 10,
      workerFactory: () => ({ port: channel.port1 }),
    })).rejects.toMatchObject({
      code: "runtime.initialization_failed",
      details: { phase: "handshake" },
    });
    channel.port1.close();
    channel.port2.close();
  });

  it("closes the physical port when the first migration callback fails", async () => {
    let closeCount = 0;
    await expect(connectSharedWorker({
      id: "first-callback-failure",
      url: "./migration.worker.ts",
      autoReconnect: false,
      workerFactory: () => {
        const channel = new MessageChannel();
        const port = channel.port1;
        const close = port.close.bind(port);
        port.close = () => {
          closeCount += 1;
          close();
        };
        return { port };
      },
      onConnection() {
        throw new Error("migration callback failed");
      },
    })).rejects.toThrow("migration callback failed");
    expect(closeCount).toBe(1);
  });

  it("rejects a failed reconnect generation, closes its port, and reaches the next generation", async () => {
    const harness = createWorkerHarness();
    const worker = startSharedWorkerApp({
      id: "reconnect-callback-failure",
      plugins: [],
      globalScope: harness.scope,
    });
    let closeCount = 0;
    let callbackCount = 0;
    const factory = () => {
      const worker = harness.factory();
      const port = worker.port;
      const close = port.close.bind(port);
      port.close = () => {
        closeCount += 1;
        close();
      };
      return worker;
    };
    const runtime = await connectSharedWorker({
      id: "reconnect-callback-failure",
      url: "./migration.worker.ts",
      reconnectDelayMs: 20,
      workerFactory: factory,
      onConnection() {
        callbackCount += 1;
        if (callbackCount === 2) throw new Error("reconnect migration callback failed");
      },
    });

    harness.disconnect();
    await waitFor(() => runtime.state().state === "disconnected");
    const failedGeneration = runtime.ready();
    await waitFor(() => callbackCount >= 2);
    await expect(failedGeneration).rejects.toMatchObject({ code: "runtime.unavailable" });
    await runtime.ready();
    expect(callbackCount).toBeGreaterThanOrEqual(3);
    expect(runtime.state().state).toBe("ready");
    expect(closeCount).toBe(2);

    await runtime.dispose();
    expect(closeCount).toBe(3);
    await worker.dispose();
  });

  it("closes every port and reports a structured error when Worker port migration fails", async () => {
    const scope: SharedWorkerScopeLike = { onconnect: null };
    let closeCount = 0;
    const app = startSharedWorkerApp({
      id: "port-migration-failure",
      plugins: [],
      globalScope: scope,
      onPortConnect() {
        throw new Error("Worker migration callback failed");
      },
    });
    const channels = [new MessageChannel(), new MessageChannel()];
    const errors = channels.map((channel) => new Promise<Record<string, unknown>>((resolve) => {
      channel.port1.addEventListener("message", (event) => {
        if (event.data?.type === RUNTIME_ERROR_TYPE) resolve(event.data);
      });
      channel.port1.start();
      const port = channel.port2;
      const close = port.close.bind(port);
      port.close = () => {
        closeCount += 1;
        close();
      };
    }));

    scope.onconnect?.({ ports: channels.map((channel) => channel.port2) });
    await expect(Promise.all(errors)).resolves.toEqual([
      expect.objectContaining({
        code: "runtime.initialization_failed",
        phase: "handshake",
        message: "Worker migration callback failed",
      }),
      expect.objectContaining({
        code: "runtime.initialization_failed",
        phase: "handshake",
        message: "Worker migration callback failed",
      }),
    ]);
    expect(closeCount).toBe(2);
    await app.dispose();
  });

  it("fences SharedWorker error events and exposes a new readiness generation", async () => {
    const harness = createWorkerHarness();
    let emitError: (() => void) | undefined;
    const factory = () => {
      const worker = harness.factory();
      const listeners = new Set<(event: Event) => void>();
      emitError = () => {
        const event = new Event("error");
        for (const listener of [...listeners]) listener(event);
      };
      return {
        ...worker,
        addEventListener(_type: "error", listener: (event: Event) => void) { listeners.add(listener); },
        removeEventListener(_type: "error", listener: (event: Event) => void) { listeners.delete(listener); },
      };
    };
    const worker = startSharedWorkerApp({
      id: "error-worker",
      plugins: [],
      globalScope: harness.scope,
    });
    const runtime = await connectSharedWorker({
      id: "error-worker",
      url: "./error.worker.ts",
      reconnectDelayMs: 0,
      workerFactory: factory,
    });
    emitError?.();
    await waitFor(() => runtime.state().state === "disconnected");
    await runtime.ready();
    expect(runtime.state().state).toBe("ready");
    await runtime.dispose();
    await worker.dispose();
  });

  it("rejects ready after a non-reconnecting disconnect", async () => {
    const harness = createWorkerHarness();
    const worker = startSharedWorkerApp({
      id: "no-reconnect-worker",
      plugins: [],
      globalScope: harness.scope,
    });
    const runtime = await connectSharedWorker({
      id: "no-reconnect-worker",
      url: "./no-reconnect.worker.ts",
      autoReconnect: false,
      workerFactory: harness.factory,
    });

    harness.disconnect();
    await waitFor(() => runtime.state().state === "disconnected");
    await expect(runtime.ready()).rejects.toMatchObject({ code: "runtime.unavailable" });

    await runtime.dispose();
    await worker.dispose();
  });

  it("rejects ready permanently after dispose", async () => {
    const harness = createWorkerHarness();
    const worker = startSharedWorkerApp({
      id: "disposed-worker",
      plugins: [],
      globalScope: harness.scope,
    });
    const runtime = await connectSharedWorker({
      id: "disposed-worker",
      url: "./disposed.worker.ts",
      workerFactory: harness.factory,
    });

    await runtime.dispose();
    await expect(runtime.ready()).rejects.toMatchObject({ code: "runtime.unavailable" });
    await expect(runtime.ready()).rejects.toMatchObject({ code: "runtime.unavailable" });
    await worker.dispose();
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition did not become true");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}
