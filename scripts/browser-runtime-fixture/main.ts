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
  }
}

const output = document.querySelector<HTMLPreElement>("#result");
const scenario = new URLSearchParams(globalThis.location.search).get("scenario") ?? "happy";
const selectedWorkerUrl = scenario === "protocol-mismatch" ? incompatibleWorkerUrl : workerUrl;

function publish(result: Record<string, unknown>): void {
  window.__WEBLOOM_RESULT__ = result;
  if (output) output.textContent = JSON.stringify(result, null, 2);
}

void (async () => {
  let runtime: Awaited<ReturnType<typeof connectSharedWorker>> | undefined;
  let app: Awaited<ReturnType<typeof createWindowApp>> | undefined;
  try {
    runtime = await connectSharedWorker({
      id: "browser-fixture-runtime",
      url: selectedWorkerUrl,
      autoReconnect: scenario === "reconnect",
      handshakeTimeoutMs: 5_000,
    });
    if (scenario === "protocol-mismatch") {
      throw new Error("incompatible fixture unexpectedly connected");
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
        async setup(ctx) {
          const worker = ctx.serviceBridge?.requireProxy({
            capabilityId: "fixture.worker",
            contractVersion: "fixture.worker.v1",
            runtime: "shared-worker",
          }, ctx.scope);
          const result = await worker.call<Record<string, never>, Record<string, unknown>>({});
          ctx.provide("fixture.window", result);
        },
      })],
    });
    const result = app.capability<Record<string, unknown>>("fixture.window");
    const firstConnectionId = runtime.connectionId;
    if (scenario === "reconnect") {
      const controller = runtime.capability<{ call: (request: { action: string }) => Promise<unknown> }>("fixture.control");
      await controller.call({ action: "disconnect" });
      await waitFor(() => runtime?.state().state === "disconnected");
      await runtime.ready();
      await waitFor(() => app?.state().units.some((unit) => unit.state === "enabled"));
      publish({
        ok: true,
        scenario,
        workerUrl,
        firstConnectionId,
        secondConnectionId: runtime.connectionId,
        reconnected: firstConnectionId !== runtime.connectionId,
        windowRealm: "document" in globalThis && "window" in globalThis ? "Window" : "unknown",
        ...app.capability<Record<string, unknown>>("fixture.window"),
        runtimeInstanceId: runtime.runtimeInstanceId,
        connectionId: runtime.connectionId,
        windowRuntimeInstanceId: app.runtimeInstanceId,
      });
      return;
    }
    publish({
      ok: true,
      scenario,
      workerUrl,
      windowRealm: "document" in globalThis && "window" in globalThis ? "Window" : "unknown",
      ...result,
      runtimeInstanceId: runtime.runtimeInstanceId,
      connectionId: runtime.connectionId,
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
