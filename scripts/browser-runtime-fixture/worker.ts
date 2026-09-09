import { definePlugin, startSharedWorkerApp } from "../../src/index.ts";

let setupCount = 0;
const connectedPorts = new Set<MessagePort>();

startSharedWorkerApp({
  id: "browser-fixture-runtime",
  plugins: [definePlugin({
    id: "fixture-worker",
    runtime: "shared-worker",
    provides: ["fixture.worker", "fixture.control"],
    setup(ctx) {
      setupCount += 1;
      ctx.provide("fixture.worker", {
        handle() {
          return {
            workerRealm: "onconnect" in globalThis ? "SharedWorkerGlobalScope" : "wrong-realm",
            setupCount,
            workerRuntimeInstanceId: ctx.instanceId,
          };
        },
      });
      ctx.provide("fixture.control", {
        handle(request: { action?: string }) {
          if (request.action !== "disconnect") return { ok: false };
          // Let the RPC response cross the port before simulating a Worker-side
          // transport loss. The browser runner then exercises the real
          // disconnected -> reconnecting -> ready generation.
          setTimeout(() => {
            for (const port of connectedPorts) {
              try {
                port.postMessage({
                  type: "webloom.runtime.disconnect",
                  reason: "browser fixture requested disconnect",
                });
              } catch {
                // The browser may have already closed this connection.
              }
            }
          }, 0);
          return { ok: true };
        },
      });
    },
  })],
});

const workerScope = globalThis as unknown as {
  onconnect: ((event: { ports: MessagePort[] }) => void) | null;
};
const runtimeOnConnect = workerScope.onconnect;
workerScope.onconnect = (event) => {
  for (const port of event.ports ?? []) connectedPorts.add(port);
  runtimeOnConnect?.(event);
};
