import { definePlugin, startSharedWorkerApp } from "../../src/index.ts";

let setupCount = 0;
let keepAlive: ReturnType<typeof setInterval> | undefined;

const app = startSharedWorkerApp({
  id: "browser-fixture-runtime",
  plugins: [definePlugin({
    id: "fixture-worker",
    runtime: "shared-worker",
    provides: ["fixture.worker"],
    setup(ctx) {
      setupCount += 1;
      ctx.provide("fixture.worker", {
        handle(request: unknown) {
          if (request && typeof request === "object" && (request as { type?: unknown }).type === "shutdown") {
            // Let the shutdown acknowledgement cross the port first; the
            // following terminal snapshots are then observed by every page.
            // Keep this fixture Worker alive briefly so a later page can test
            // the disposed-state admission path against the same Runtime.
            keepAlive ??= setInterval(() => undefined, 1_000);
            setTimeout(() => { void app.dispose("browser fixture terminal dispose"); }, 0);
            return { shutdownStarted: true };
          }
          return {
            workerRealm: "onconnect" in globalThis ? "SharedWorkerGlobalScope" : "wrong-realm",
            setupCount,
            workerRuntimeInstanceId: ctx.instanceId,
          };
        },
      });
    },
  })],
});
