import {
  connectSharedWorker,
  createWindowApp,
  definePlugin,
} from "../../src/index.ts";
import workerUrl from "./worker.ts?sharedworker&url";
import incompatibleWorkerUrl from "./incompatible-worker.ts?sharedworker&url";
import { Events, PageRpc, TransferRpc, WorkerRpc } from "./contracts.ts";

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

const pagePlugin = definePlugin({
  id: "browser-window-page",
  provides: [PageRpc] as const,
  startup: "required" as const,
  setup(ctx) {
    ctx.handle(PageRpc, (request) => ({ result: `page:${request.value}` }));
  },
});

void (async () => {
  let runtime: Awaited<ReturnType<typeof connectSharedWorker>> | undefined;
  let app: Awaited<ReturnType<typeof createWindowApp>> | undefined;
  try {
    if (scenario !== "terminal-late" && scenario !== "protocol-mismatch") {
      app = await createWindowApp({ plugins: [pagePlugin] });
    }
    runtime = connectSharedWorker({
      id: "browser-fixture-runtime",
      url: selectedWorkerUrl,
      defaultCallTimeoutMs: 5_000,
      ...(app ? { client: { app, expose: [PageRpc] as const } } : {}),
    });
    if (scenario === "terminal-trigger" || scenario === "terminal-observer") {
      // A synchronous handle is not yet a physical connection. Wait for the
      // first Runtime snapshot so the barrier exposes an actual port.
      await waitFor(() => runtime!.runtimeInstanceId !== "");
      updateTerminalReady({ connected: true });
    }
    if (scenario === "protocol-mismatch") {
      try {
        await runtime.capability(WorkerRpc).call({ type: "health" }, { timeoutMs: 1_000 });
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
      await waitFor(() => states.includes("disposed") || states.includes("failed"));
      removeSubscription();
      publish({
        ok: states.includes("disposed") && !states.includes("stopping"),
        scenario,
        workerUrl: selectedWorkerUrl,
        states,
      });
      return;
    }

    const worker = runtime.capability(WorkerRpc);
    const callWorker = async (request: { type?: string; reverse?: boolean }) => worker.call(request, { timeoutMs: 5_000 });
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
        await callWorker({ type: "shutdown" });
      }
      await waitFor(() => states.includes("stopping") && (states.includes("disposed") || states.includes("disconnected")));
      const oldProxy = runtime.capability(WorkerRpc);
      const startedAt = performance.now();
      try {
        await oldProxy.call({ type: "health" }, { timeoutMs: 2_000 });
      } catch (error) {
        oldProxyError = (error as Error & { code?: unknown }).code as string | undefined;
      }
      const elapsedMs = performance.now() - startedAt;
      removeSubscription();
      publish({
        ok: states.includes("stopping") && (states.includes("disposed") || states.includes("disconnected"))
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
      const firstServiceInstanceId = firstRuntime.state().services.find((service) => service.capabilityId === WorkerRpc.id)?.serviceInstanceId;
      const firstProxy = firstRuntime.capability(WorkerRpc);
      const firstResult = await callWorker({ type: "health", reverse: true });
      await firstRuntime.dispose("browser fixture explicit reconnect");
      let oldProxyError: string | undefined;
      try {
        await firstProxy.call({ type: "health" });
      } catch (error) {
        oldProxyError = (error as Error & { code?: unknown }).code as string | undefined;
      }
      runtime = connectSharedWorker({
        id: "browser-fixture-runtime",
        url: workerUrl,
        defaultCallTimeoutMs: 5_000,
        ...(app ? { client: { app, expose: [PageRpc] as const } } : {}),
      });
      const secondProxy = runtime.capability(WorkerRpc);
      const secondResult = await secondProxy.call({ type: "health" });
      const secondServiceInstanceId = runtime.state().services.find((service) => service.capabilityId === WorkerRpc.id)?.serviceInstanceId;
      publish({
        ok: true,
        scenario,
        workerUrl,
        firstRuntimeInstanceId: firstRuntime.runtimeInstanceId,
        secondRuntimeInstanceId: runtime.runtimeInstanceId,
        firstServiceInstanceId,
        secondServiceInstanceId,
        oldProxyError,
        reconnected: firstRuntime !== runtime,
        firstReverseResult: firstResult.reverseResult,
        ...secondResult,
      });
      return;
    }

    await waitFor(() => runtime!.state().state === "ready");
    const workerResult = await callWorker({ type: "health", reverse: true });
    const transferBuffer = new ArrayBuffer(8);
    new Uint8Array(transferBuffer)[0] = 7;
    const transferResult = await runtime.capability(TransferRpc).call({ buffer: transferBuffer });
    const streamValues: number[] = [];
    const stream = runtime.capability(Events).subscribe({ count: 3 }, {
      initialCredit: 1,
      onNext: (value) => { streamValues.push(value); },
      timeoutMs: 5_000,
    });
    await stream.ready;
    await stream.closed;
    const serviceInstanceId = runtime.state().services.find((service) => service.capabilityId === WorkerRpc.id)?.serviceInstanceId;
    publish({
      ok: true,
      scenario,
      workerUrl: selectedWorkerUrl,
      windowRealm: "Window",
      ...workerResult,
      reverseResult: workerResult.reverseResult,
      streamValues,
      transferDetached: transferBuffer.byteLength === 0,
      transferByteLength: transferResult.byteLength,
      runtimeInstanceId: runtime.runtimeInstanceId,
      serviceInstanceId,
      windowRuntimeInstanceId: app?.runtimeInstanceId,
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
