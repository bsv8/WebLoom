import { definePlugin, startSharedWorkerApp } from "../../src/index.ts";
import { BusinessPortEvents, BusinessPortRpc, Events, PageRpc, TransferRpc, WorkerRpc } from "./contracts.ts";

let setupCount = 0;
let keepAlive: ReturnType<typeof setInterval> | undefined;

const app = startSharedWorkerApp({
  id: "browser-fixture-runtime",
  plugins: [definePlugin({
    id: "fixture-worker",
    runtime: "shared-worker",
    provides: [WorkerRpc, TransferRpc, Events, BusinessPortRpc, BusinessPortEvents] as const,
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
      ctx.handle(BusinessPortRpc, (request) => {
        request.port.postMessage({ type: "request-port", marker: request.marker });
        request.port.start();
        const responseChannel = new MessageChannel();
        responseChannel.port1.addEventListener("message", (event) => {
          responseChannel.port1.postMessage({ type: "response-port", value: event.data });
          setTimeout(() => responseChannel.port1.close(), 0);
        });
        responseChannel.port1.start();
        if (request.responseTransferMode === "unreachable") setTimeout(() => responseChannel.port2.close(), 250);
        return {
          buffer: request.buffer,
          firstView: request.firstView,
          secondView: request.secondView,
          port: responseChannel.port2,
          marker: request.marker,
          transferMode: request.transferMode,
          responseTransferMode: request.responseTransferMode,
          byteLength: request.buffer.byteLength,
        };
      });
      ctx.handle(BusinessPortEvents, async (request, call) => {
        request.port.postMessage({ type: "stream-request-port", count: request.count });
        request.port.start();
        if (request.delayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, request.delayMs));
        if (call.signal.aborted) return (async function* () {})();
        return (async function* () {
          for (let index = 1; index <= request.count; index += 1) {
            const itemChannel = new MessageChannel();
            itemChannel.port1.addEventListener("message", (event) => {
              itemChannel.port1.postMessage({ type: "item-port", value: event.data });
            });
            itemChannel.port1.start();
            const buffer = new ArrayBuffer(index + 3);
            new Uint8Array(buffer)[0] = index;
            try {
              yield {
                index,
                buffer,
                firstView: new Uint8Array(buffer, 0, Math.min(2, buffer.byteLength)),
                secondView: new Uint8Array(buffer, Math.min(1, buffer.byteLength - 1), Math.min(2, buffer.byteLength - Math.min(1, buffer.byteLength - 1))),
                port: itemChannel.port2,
                transferMode: request.itemTransferMode,
              };
            } finally {
              itemChannel.port1.close();
              itemChannel.port2.close();
            }
          }
        })();
      });
      ctx.handle(Events, async function* (request) {
        for (let value = 1; value <= request.count; value += 1) yield value;
      });
    },
  })],
  expose: [WorkerRpc, TransferRpc, Events, BusinessPortRpc, BusinessPortEvents],
});
