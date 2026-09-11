import { definePlugin, startSharedWorkerApp } from "../../src/index.ts";
import { Events, PageRpc, TransferRpc, WorkerRpc } from "./contracts.ts";

let setupCount = 0;
let keepAlive: ReturnType<typeof setInterval> | undefined;

const app = startSharedWorkerApp({
  id: "browser-fixture-runtime",
  plugins: [definePlugin({
    id: "fixture-worker",
    runtime: "shared-worker",
    provides: [WorkerRpc, TransferRpc, Events] as const,
    dependencies: [{ capability: PageRpc, source: "peer" }] as const,
    startup: "required" as const,
    setup(ctx) {
      setupCount += 1;
      ctx.handle(WorkerRpc, async (request, call) => {
        let reverseResult: string | undefined;
        if (request.reverse) {
          if (!call.peer) throw new Error("reverse fixture call requires a peer");
          reverseResult = (await call.peer.capability(PageRpc).call({ value: "reverse" })).result;
        }
        if (request.type === "shutdown") {
          // Let the shutdown acknowledgement cross the port first; the
          // following terminal snapshots are then observed by every page.
          keepAlive ??= setInterval(() => undefined, 1_000);
          setTimeout(() => { void app.dispose("browser fixture terminal dispose"); }, 0);
        }
        return {
          workerRealm: "onconnect" in globalThis ? "SharedWorkerGlobalScope" : "wrong-realm",
          setupCount,
          workerRuntimeInstanceId: ctx.instanceId,
          ...(reverseResult !== undefined ? { reverseResult } : {}),
          ...(request.type === "shutdown" ? { shutdownStarted: true } : {}),
        };
      });
      ctx.handle(TransferRpc, (request) => ({ buffer: request.buffer, byteLength: request.buffer.byteLength }));
      ctx.handle(Events, async function* (request) {
        for (let value = 1; value <= request.count; value += 1) yield value;
      });
    },
  })],
  expose: [WorkerRpc, TransferRpc, Events],
});
