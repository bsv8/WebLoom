import {
  connectSharedWorker,
  createWindowApp,
  definePlugin,
} from "../../src/index.ts";
import workerUrl from "./worker.ts?sharedworker&url";
import incompatibleWorkerUrl from "./incompatible-worker.ts?sharedworker&url";

declare global {
  interface Window {
    __WEBLOOM_RESULT__?: Record<string, unknown>;
    __WEBLOOM_TERMINAL_READY__?: {
      connected: boolean;
      runtimeReady: boolean;
      subscriptionInstalled: boolean;
    };
    __WEBLOOM_SHUTDOWN__?: () => void;
  }
}

const output = document.querySelector<HTMLPreElement>("#result");
const scenario = new URLSearchParams(globalThis.location.search).get("scenario") ?? "happy";
const selectedWorkerUrl = scenario === "protocol-mismatch" ? incompatibleWorkerUrl : workerUrl;

function publish(result: Record<string, unknown>): void {
  window.__WEBLOOM_RESULT__ = result;
  if (output) output.textContent = JSON.stringify(result, null, 2);
}

function updateTerminalReady(
  patch: Partial<NonNullable<Window["__WEBLOOM_TERMINAL_READY__"]>>,
): void {
  window.__WEBLOOM_TERMINAL_READY__ = {
    connected: window.__WEBLOOM_TERMINAL_READY__?.connected ?? false,
    runtimeReady: window.__WEBLOOM_TERMINAL_READY__?.runtimeReady ?? false,
    subscriptionInstalled: window.__WEBLOOM_TERMINAL_READY__?.subscriptionInstalled ?? false,
    ...patch,
  };
}

void (async () => {
  let runtime: Awaited<ReturnType<typeof connectSharedWorker>> | undefined;
  let app: Awaited<ReturnType<typeof createWindowApp>> | undefined;
  try {
    runtime = connectSharedWorker({
      id: "browser-fixture-runtime",
      url: selectedWorkerUrl,
      defaultCallTimeoutMs: 5_000,
    });
    if (scenario === "terminal-trigger" || scenario === "terminal-observer") {
      // A synchronous handle is not yet a physical connection. Wait for the
      // first Runtime snapshot so the barrier exposes an actual port.
      await waitFor(() => runtime!.runtimeInstanceId !== undefined);
      updateTerminalReady({ connected: true });
    }
    if (scenario === "protocol-mismatch") {
      const proxy = runtime.capability("fixture.worker", { contractVersion: "fixture.worker.v1" });
      try {
        await proxy.call({}, { timeoutMs: 1_000 });
        throw new Error("incompatible fixture unexpectedly completed a call");
      } catch (error) {
        if (!(error instanceof Error) || !/protocol/i.test(error.message)) throw error;
        publish({
          ok: true,
          scenario,
          workerUrl: selectedWorkerUrl,
          error: error.message,
          errorCode: (error as Error & { code?: unknown }).code,
        });
        return;
      }
    }
    if (scenario === "terminal-late") {
      const states: string[] = [];
      const removeSubscription = runtime.subscribe((snapshot) => states.push(snapshot.state));
      await waitFor(() => states.includes("disposed"));
      removeSubscription();
      publish({
        ok: states.includes("disposed") && !states.includes("stopping"),
        scenario,
        workerUrl: selectedWorkerUrl,
        states,
      });
      return;
    }
    app = await createWindowApp({
      remoteRuntime: runtime,
      plugins: [definePlugin({
        id: "browser-window-consumer",
        dependencies: [{
          capability: "fixture.worker",
          contractVersion: "fixture.worker.v1",
          sourceRuntime: "shared-worker",
        }],
        provides: ["fixture.window"],
        setup(ctx) {
          const worker = ctx.serviceBridge?.requireProxy({
            capabilityId: "fixture.worker",
            contractVersion: "fixture.worker.v1",
            runtime: "shared-worker",
          }, ctx.scope);
          if (!worker) throw new Error("SharedWorker service bridge is unavailable");
          ctx.provide("fixture.window", worker);
        },
      })],
    });
    await waitFor(() => app?.state().units.some((unit) => unit.state === "enabled"));
    const callWindowService = async (): Promise<{ result: Record<string, unknown>; serviceInstanceId?: string }> => {
      const proxy = app!.capability<{
        call: (request: unknown, options?: { timeoutMs?: number }) => Promise<Record<string, unknown>>;
        reference?: { serviceInstanceId: string };
      }>("fixture.window");
      const result = await proxy.call({}, { timeoutMs: 5_000 });
      return { result, serviceInstanceId: proxy.reference?.serviceInstanceId };
    };
    if (scenario === "terminal-trigger" || scenario === "terminal-observer") {
      await waitFor(() => runtime!.state().state === "ready");
      updateTerminalReady({ runtimeReady: true });
      const states: string[] = [];
      const removeSubscription = runtime.subscribe((snapshot) => states.push(snapshot.state));
      updateTerminalReady({ subscriptionInstalled: true });
      let oldProxyError: string | undefined;
      if (scenario === "terminal-trigger") {
        await new Promise<void>((resolve) => {
          window.__WEBLOOM_SHUTDOWN__ = () => {
            window.__WEBLOOM_SHUTDOWN__ = undefined;
            resolve();
          };
        });
        const shutdownProxy = runtime.capability("fixture.worker", { contractVersion: "fixture.worker.v1" });
        await shutdownProxy.call({ type: "shutdown" }, { timeoutMs: 2_000 });
      }
      await waitFor(() => states.includes("stopping") && states.includes("disposed"));
      const oldProxy = runtime.capability("fixture.worker", { contractVersion: "fixture.worker.v1" });
      const startedAt = performance.now();
      try {
        await oldProxy.call({}, { timeoutMs: 2_000 });
      } catch (error) {
        oldProxyError = (error as Error & { code?: unknown }).code as string | undefined;
      }
      const elapsedMs = performance.now() - startedAt;
      removeSubscription();
      publish({
        ok: states.includes("stopping") && states.includes("disposed")
          && oldProxyError !== undefined && elapsedMs < 500,
        scenario,
        workerUrl: selectedWorkerUrl,
        states,
        terminalReady: window.__WEBLOOM_TERMINAL_READY__,
        oldProxyError,
        elapsedMs,
      });
      return;
    }
    if (scenario === "reconnect") {
      const firstRuntime = runtime;
      const firstCall = await callWindowService();
      const firstRuntimeInstanceId = firstRuntime.runtimeInstanceId;
      await firstRuntime.dispose("browser fixture explicit reconnect");
      let oldProxyError: string | undefined;
      try {
        await app!.capability<{ call: (request: unknown) => Promise<unknown> }>("fixture.window").call({});
      } catch (error) {
        oldProxyError = (error as Error & { code?: unknown }).code as string | undefined;
      }
      runtime = connectSharedWorker({
        id: "browser-fixture-runtime",
        url: workerUrl,
        defaultCallTimeoutMs: 5_000,
      });
      const secondProxy = runtime.capability("fixture.worker", { contractVersion: "fixture.worker.v1" });
      const secondResult = await secondProxy.call< Record<string, never>, Record<string, unknown>>({}, { timeoutMs: 5_000 });
      publish({
        ok: true,
        scenario,
        workerUrl,
        firstRuntimeInstanceId,
        secondRuntimeInstanceId: runtime.runtimeInstanceId,
        firstServiceInstanceId: firstCall.serviceInstanceId,
        secondServiceInstanceId: secondProxy.reference?.serviceInstanceId,
        oldProxyError,
        reconnected: firstRuntime !== runtime,
        ...secondResult,
        runtimeInstanceId: runtime.runtimeInstanceId,
      });
      return;
    }
    const { result, serviceInstanceId } = await callWindowService();
    publish({
      ok: true,
      scenario,
      workerUrl,
      windowRealm: "document" in globalThis && "window" in globalThis ? "Window" : "unknown",
      ...result,
      runtimeInstanceId: runtime.runtimeInstanceId,
      serviceInstanceId,
      windowRuntimeInstanceId: app.runtimeInstanceId,
    });
  } catch (error) {
    publish({
      ok: scenario === "protocol-mismatch" && error instanceof Error && /protocol/i.test(error.message),
      scenario,
      workerUrl: selectedWorkerUrl,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    await app?.dispose().catch(() => undefined);
    await runtime?.dispose().catch(() => undefined);
  }
})();

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("browser fixture condition did not become true");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}
