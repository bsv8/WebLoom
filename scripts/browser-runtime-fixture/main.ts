import {
  connectSharedWorker,
  createWindowApp,
  definePlugin,
} from "../../src/index.ts";
import workerUrl from "./worker.ts?sharedworker&url";
import incompatibleWorkerUrl from "./incompatible-worker.ts?sharedworker&url";
import {
  BusinessPortEvents,
  BusinessPortRpc,
  Events,
  PageRpc,
  TransferRpc,
  WorkerRpc,
  type BusinessPortRequest,
  type BusinessPortResponse,
  type BusinessPortStreamRequest,
  type BusinessPortStreamItem,
  type TransferMode,
} from "./contracts.ts";
import type { StreamSubscription } from "../../src/contracts/capability.ts";

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

    if (scenario === "transfer-matrix") {
      await waitFor(() => runtime!.state().state === "ready");
      const transferMatrix = await runTransferMatrix(runtime);
      publish({
        ok: true,
        scenario,
        workerUrl: selectedWorkerUrl,
        transferMatrix,
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

function waitForPortMessage(port: MessagePort, timeoutMs = 5_000, label = "unknown"): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (callback: () => void): void => {
      port.removeEventListener("message", onMessage);
      if (timer !== undefined) clearTimeout(timer);
      callback();
    };
    const onMessage = (event: MessageEvent): void => finish(() => resolve(event.data));
    port.addEventListener("message", onMessage);
    port.start();
    timer = setTimeout(() => finish(() => reject(new Error(`business MessagePort message timed out: ${label}`))), timeoutMs);
  });
}

function closePort(port: MessagePort | undefined): void {
  try { port?.close(); } catch { /* fixture cleanup */ }
}

function createBusinessRequest(
  marker: string,
  transferMode: TransferMode,
  responseTransferMode: TransferMode,
): { readonly request: BusinessPortRequest; readonly buffer: ArrayBuffer; readonly pagePort: MessagePort } {
  const buffer = new ArrayBuffer(32);
  const firstView = new Uint8Array(buffer, 2, 6);
  const secondView = new Uint8Array(buffer, 12, 6);
  firstView[0] = 17;
  secondView[0] = 29;
  const channel = new MessageChannel();
  return {
    request: { buffer, firstView, secondView, port: channel.port2, marker, transferMode, responseTransferMode },
    buffer,
    pagePort: channel.port1,
  };
}

function createBusinessStreamRequest(
  marker: string,
  transferMode: TransferMode,
  itemTransferMode: TransferMode,
  count: number,
  delayMs = 0,
): { readonly request: BusinessPortStreamRequest; readonly buffer: ArrayBuffer; readonly pagePort: MessagePort } {
  const buffer = new ArrayBuffer(32);
  const firstView = new Uint8Array(buffer, 2, 6);
  const secondView = new Uint8Array(buffer, 12, 6);
  firstView[0] = 37;
  secondView[0] = 43;
  const channel = new MessageChannel();
  return {
    request: { buffer, firstView, secondView, port: channel.port2, count, delayMs, transferMode, itemTransferMode },
    buffer,
    pagePort: channel.port1,
  };
}

function errorCode(error: unknown): string | undefined {
  return (error as { code?: unknown })?.code as string | undefined;
}

async function exerciseBusinessRpc(
  runtime: Awaited<ReturnType<typeof connectSharedWorker>>,
  marker: string,
  transferMode: TransferMode,
  responseTransferMode: TransferMode,
): Promise<Record<string, unknown>> {
  const fixture = createBusinessRequest(marker, transferMode, responseTransferMode);
  const requestMessage = waitForPortMessage(fixture.pagePort, 5_000, `${marker}:request-port`);
  let response: BusinessPortResponse | undefined;
  let failureCode: string | undefined;
  try {
    response = await runtime.capability(BusinessPortRpc).call(fixture.request);
  } catch (error) {
    failureCode = errorCode(error);
  }
  if (!response && transferMode !== "unreachable") {
    void requestMessage.catch(() => undefined);
    closePort(fixture.pagePort);
    return {
      marker,
      transferMode,
      responseTransferMode,
      ok: responseTransferMode === "unreachable"
        && failureCode === "transfer_invalid"
        && fixture.buffer.byteLength === 0,
      errorCode: failureCode,
      requestBufferByteLength: fixture.buffer.byteLength,
    };
  }
  if (transferMode === "unreachable") {
    const retainedMessage = waitForPortMessage(fixture.pagePort, 5_000, `${marker}:retained-port`);
    fixture.request.port.postMessage({ type: "retained-request-port", marker });
    const retained = await retainedMessage;
    closePort(fixture.pagePort);
    return {
      marker,
      transferMode,
      responseTransferMode,
      ok: response === undefined && failureCode === "transfer_invalid" && fixture.buffer.byteLength === 32,
      errorCode: failureCode,
      requestBufferByteLength: fixture.buffer.byteLength,
      requestPortRetained: (retained as { type?: unknown })?.type === "retained-request-port",
    };
  }
  const requestPortMessage = await requestMessage;
  if (!response) throw new Error(`business RPC ${marker} did not return a response (${failureCode ?? "unknown"})`);
  const responsePortMessage = waitForPortMessage(response.port, 5_000, `${marker}:response-port`);
  response.port.postMessage({ type: "response-port-input", marker });
  const echoed = await responsePortMessage;
  closePort(fixture.pagePort);
  closePort(response.port);
  return {
    marker,
    transferMode,
    responseTransferMode,
    ok: failureCode === undefined
      && fixture.buffer.byteLength === 0
      && response.byteLength === 32
      && response.firstView.buffer === response.buffer
      && response.secondView.buffer === response.buffer
      && response.firstView[0] === 17
      && response.secondView[0] === 29
      && (requestPortMessage as { type?: unknown })?.type === "request-port"
      && (echoed as { type?: unknown })?.type === "response-port",
    requestBufferDetached: fixture.buffer.byteLength === 0,
    responseByteLength: response.byteLength,
    responseViewsShareBuffer: response.firstView.buffer === response.buffer && response.secondView.buffer === response.buffer,
    requestPortDelivered: (requestPortMessage as { type?: unknown })?.type === "request-port",
    responsePortRoundTrip: (echoed as { type?: unknown })?.type === "response-port",
    errorCode: failureCode,
  };
}

async function exerciseBusinessStream(
  runtime: Awaited<ReturnType<typeof connectSharedWorker>>,
  marker: string,
  transferMode: TransferMode,
  itemTransferMode: TransferMode,
  count: number,
  delayMs = 0,
  cancelAfterFirst = false,
  cancelBeforeReady = false,
): Promise<Record<string, unknown>> {
  const fixture = createBusinessStreamRequest(marker, transferMode, itemTransferMode, count, delayMs);
  const requestMessage = waitForPortMessage(fixture.pagePort, 5_000, `${marker}:request-port`);
  const values: number[] = [];
  const itemBuffers: number[] = [];
  const itemViewsShareBuffer: boolean[] = [];
  const itemPortRoundTrips: boolean[] = [];
  let subscription: StreamSubscription<BusinessPortStreamItem> | undefined;
  subscription = runtime.capability(BusinessPortEvents).subscribe(fixture.request, {
    initialCredit: 1,
    timeoutMs: 5_000,
    onNext: async (item) => {
      values.push(item.index);
      itemBuffers.push(item.buffer.byteLength);
      itemViewsShareBuffer.push(item.firstView.buffer === item.buffer && item.secondView.buffer === item.buffer);
      const echoed = waitForPortMessage(item.port, 5_000, `${marker}:item-${item.index}`);
      item.port.postMessage({ type: "item-port-input", index: item.index });
      const result = await echoed;
      itemPortRoundTrips.push((result as { type?: unknown })?.type === "item-port");
      closePort(item.port);
      if (cancelAfterFirst && values.length === 1) subscription?.cancel("browser fixture post-ready cancellation");
    },
  });
  if (cancelBeforeReady) subscription.cancel("browser fixture pre-ready cancellation");
  let readyCode: string | undefined;
  try { await subscription.ready; } catch (error) { readyCode = errorCode(error); }
  let closedCode: string | undefined;
  try { await subscription.closed; } catch (error) { closedCode = errorCode(error); }
  if (readyCode !== undefined && !marker.includes("cancel-before-ready")) {
    void requestMessage.catch(() => undefined);
    closePort(fixture.pagePort);
    return {
      marker,
      transferMode,
      itemTransferMode,
      count,
      delayMs,
      cancelAfterFirst,
      cancelBeforeReady,
      ok: false,
      readyErrorCode: readyCode,
      closedErrorCode: closedCode,
      requestBufferDetached: fixture.buffer.byteLength === 0,
      values,
    };
  }
  let requestPortMessage: unknown;
  let requestPortError: string | undefined;
  try { requestPortMessage = await requestMessage; }
  catch (error) { requestPortError = error instanceof Error ? error.message : String(error); }
  closePort(fixture.pagePort);
  return {
    marker,
    transferMode,
    itemTransferMode,
    count,
    delayMs,
    cancelAfterFirst,
    cancelBeforeReady,
    ok: itemTransferMode === "unreachable"
      ? readyCode === undefined
        && closedCode === "transfer_invalid"
        && fixture.buffer.byteLength === 0
        && values.length === 0
      : (cancelBeforeReady || cancelAfterFirst)
        ? (cancelBeforeReady ? readyCode === "request_cancelled" : readyCode === undefined)
          && closedCode === "request_cancelled"
          && fixture.buffer.byteLength === 0
          && (cancelBeforeReady ? values.length === 0 : values.length === 1)
          && itemViewsShareBuffer.every(Boolean)
          && itemPortRoundTrips.every(Boolean)
        : readyCode === undefined
          && closedCode === undefined
          && fixture.buffer.byteLength === 0
          && values.length === count
          && (requestPortMessage as { type?: unknown })?.type === "stream-request-port"
          && itemBuffers.every((length) => length >= 4)
          && itemViewsShareBuffer.every(Boolean)
          && itemPortRoundTrips.every(Boolean),
    requestBufferDetached: fixture.buffer.byteLength === 0,
    requestPortDelivered: (requestPortMessage as { type?: unknown })?.type === "stream-request-port",
    values,
    itemBuffers,
    itemViewsShareBuffer,
    itemPortRoundTrips,
    readyErrorCode: readyCode,
    closedErrorCode: closedCode,
    requestPortError,
  };
}

async function exercisePreSendCancelledStream(
  runtime: Awaited<ReturnType<typeof connectSharedWorker>>,
): Promise<Record<string, unknown>> {
  const fixture = createBusinessStreamRequest("cancel-before-send", "normal", "normal", 1, 0);
  const controller = new AbortController();
  controller.abort("pre-send cancellation stays local");
  const subscription = runtime.capability(BusinessPortEvents).subscribe(fixture.request, {
    signal: controller.signal,
    onNext() {},
  });
  let readyCode: string | undefined;
  let closedCode: string | undefined;
  try { await subscription.ready; } catch (error) { readyCode = errorCode(error); }
  try { await subscription.closed; } catch (error) { closedCode = errorCode(error); }
  const retainedMessage = waitForPortMessage(fixture.pagePort, 5_000, "cancel-before-send:retained-port");
  fixture.request.port.postMessage({ type: "pre-send-port-retained" });
  const retained = await retainedMessage;
  closePort(fixture.pagePort);
  return {
    marker: "cancel-before-send",
    ok: readyCode === "request_cancelled"
      && closedCode === "request_cancelled"
      && fixture.buffer.byteLength === 32
      && (retained as { type?: unknown })?.type === "pre-send-port-retained",
    bufferByteLength: fixture.buffer.byteLength,
    requestPortRetained: (retained as { type?: unknown })?.type === "pre-send-port-retained",
    readyErrorCode: readyCode,
    closedErrorCode: closedCode,
  };
}

async function runTransferMatrix(
  runtime: Awaited<ReturnType<typeof connectSharedWorker>>,
): Promise<Record<string, unknown>> {
  const rpcNormal = await exerciseBusinessRpc(runtime, "rpc-normal", "normal", "normal");
  const rpcDuplicate = await exerciseBusinessRpc(runtime, "rpc-duplicate", "duplicate", "duplicate");
  const rpcUnreachableRequest = await exerciseBusinessRpc(runtime, "rpc-unreachable-request", "unreachable", "normal");
  const rpcUnreachableResponse = await exerciseBusinessRpc(runtime, "rpc-unreachable-response", "normal", "unreachable");
  const streamNormal = await exerciseBusinessStream(runtime, "stream-normal", "normal", "normal", 3);
  const streamDuplicate = await exerciseBusinessStream(runtime, "stream-duplicate", "duplicate", "duplicate", 2);
  const streamUnreachableItem = await exerciseBusinessStream(runtime, "stream-unreachable-item", "normal", "unreachable", 1);
  const streamCancelledBeforeReady = await exerciseBusinessStream(runtime, "stream-cancel-before-ready", "normal", "normal", 1, 250, false, true);
  // The call has already been posted by the time subscribe() returns; this
  // is the post-ready cancel case and the detached request remains detached.
  const streamCancelledAfterSend = await exerciseBusinessStream(runtime, "stream-cancel-after-send", "normal", "normal", 3, 0, true);
  const preSendCancelled = await exercisePreSendCancelledStream(runtime);
  const cases = [rpcNormal, rpcDuplicate, rpcUnreachableRequest, rpcUnreachableResponse, streamNormal, streamDuplicate, streamUnreachableItem, streamCancelledBeforeReady, streamCancelledAfterSend, preSendCancelled];
  return {
    ok: cases.every((item) => item.ok === true)
      && (rpcUnreachableResponse.errorCode === "transfer_invalid" || rpcUnreachableResponse.errorCode === "invalid_message")
      && streamUnreachableItem.closedErrorCode === "transfer_invalid"
      && streamCancelledBeforeReady.closedErrorCode === "request_cancelled"
      && streamCancelledAfterSend.closedErrorCode === "request_cancelled"
      && streamCancelledAfterSend.requestBufferDetached === true,
    cases,
  };
}
