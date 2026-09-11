import { describe, expect, it } from "vitest";
import inventory from "../../contract-inventory.json";
import verification from "../../docs/proposals/webloom-v4/verification.md?raw";
import requirements from "../../docs/proposals/webloom-v4/requirements.md?raw";
import {
  defineCapability,
  type PeerScopeView,
  type RemoteCapability,
  type RuntimeSnapshot,
  type ServiceReference,
} from "../index.js";
import type { RuntimeStatusSnapshot } from "./runtimeTypes.js";
import { definePlugin } from "../authoring/definePlugin.js";
import { createCapabilityPeerView } from "./peerView.js";
import { connectSharedWorkerForTesting, type SharedWorkerLike } from "./connectSharedWorker.js";
import { startSharedWorkerAppForTesting, type SharedWorkerScopeLike } from "./sharedWorkerHost.js";
import { assertReceivedPortSet, createReceivePortLedger, createRuntimeBudget, validateDto, validateRawDto, validateTransferList } from "../transport/dto.js";
import { createCapabilityBridge } from "../transport/serviceBridge.js";
import { createFakeRuntimeTransport } from "../testing/fakes.js";
import { createMessagePortRuntimeTransport, type MessagePortLike } from "../transport/messagePortServiceTransport.js";
import { createMessagePortServiceProvider } from "../transport/messagePortServiceProvider.js";
import {
  RUNTIME_CALL_TYPE,
  RUNTIME_CANCEL_TYPE,
  RUNTIME_NEXT_TYPE,
  RUNTIME_PROTOCOL_VERSION,
  RUNTIME_RESULT_TYPE,
  RUNTIME_SNAPSHOT_TYPE,
  type RuntimeCallMessage,
} from "./runtimeProtocol.js";

const Echo = defineCapability<{ value: string }, { result: string }>({
  kind: "rpc",
  id: "acceptance.echo",
  version: "1",
  request: {
    parse(value: unknown): { value: string } {
      if (!value || typeof value !== "object" || typeof (value as { value?: unknown }).value !== "string") throw new Error("invalid request");
      return value as { value: string };
    },
  },
  response: {
    parse(value: unknown): { result: string } {
      if (!value || typeof value !== "object" || typeof (value as { result?: unknown }).result !== "string") throw new Error("invalid response");
      return value as { result: string };
    },
  },
});

const Hidden = defineCapability<{ value: string }, { result: string }>({
  kind: "rpc",
  id: "acceptance.hidden",
  version: "1",
  request: Echo.request,
  response: Echo.response,
});

const Events = defineCapability<{ topic: string }, number>({
  kind: "stream",
  id: "acceptance.events",
  version: "1",
  request: {
    parse(value: unknown): { topic: string } {
      if (!value || typeof value !== "object" || typeof (value as { topic?: unknown }).topic !== "string") throw new Error("invalid request");
      return value as { topic: string };
    },
  },
  item: {
    parse(value: unknown): number {
      if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("invalid item");
      return value;
    },
  },
});

interface TransferRequest {
  readonly buffer: ArrayBuffer;
  readonly port: MessagePort;
}

function isPortLike(value: unknown): value is MessagePort {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<MessagePort>;
  return typeof candidate.postMessage === "function"
    && typeof candidate.start === "function"
    && typeof candidate.close === "function"
    && typeof candidate.addEventListener === "function"
    && typeof candidate.removeEventListener === "function";
}

const TransferEvents = defineCapability<TransferRequest, number>({
  kind: "stream",
  id: "acceptance.transfer-events",
  version: "1",
  request: {
    parse(value: unknown): TransferRequest {
      if (!value || typeof value !== "object") throw new Error("invalid request");
      const candidate = value as Partial<TransferRequest>;
      if (Object.prototype.toString.call(candidate.buffer) !== "[object ArrayBuffer]" || !isPortLike(candidate.port)) throw new Error("invalid request");
      return value as TransferRequest;
    },
  },
  item: { parse(value: unknown): number { if (typeof value !== "number") throw new Error("invalid item"); return value; } },
  transfer: {
    request(value) { return [value.buffer, value.port]; },
  },
});

function serviceReference(capability: RemoteCapability, serviceInstanceId = "service:" + capability.id): ServiceReference {
  return {
    kind: capability.kind,
    capabilityId: capability.id,
    contractVersion: capability.version,
    runtime: "shared-worker",
    runtimeInstanceId: "worker:acceptance",
    serviceInstanceId,
    attributes: {},
  };
}

function snapshotFor(capability: RemoteCapability, serviceInstanceId = "service:" + capability.id, revision = 1): RuntimeSnapshot {
  return {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    runtimeId: "worker",
    runtimeKind: "shared-worker",
    runtimeInstanceId: "worker:acceptance",
    revision,
    state: "ready",
    units: [],
    services: [{
      kind: capability.kind,
      capabilityId: capability.id,
      contractVersion: capability.version,
      serviceInstanceId,
      attributes: {},
    }],
  };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitUntil(check: () => boolean, attempts = 50): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    if (check()) return;
    await tick();
  }
  throw new Error("condition did not become true");
}

function createTestWorker(plugins: readonly ReturnType<typeof definePlugin>[], expose: readonly RemoteCapability[] = [], options: {
  readonly configurePeer?: (peer: import("./sharedWorkerHost.js").PeerController) => void;
  readonly peerExposureAllowlist?: readonly RemoteCapability[];
  readonly snapshotObserver?: (snapshot: RuntimeStatusSnapshot) => void;
} = {}): {
  readonly app: ReturnType<typeof startSharedWorkerAppForTesting>;
  readonly factory: (url: string | URL, options: { type: "module"; name?: string; credentials?: RequestCredentials }) => SharedWorkerLike;
  readonly wireMessages: readonly unknown[][];
} {
  const scope: SharedWorkerScopeLike = { onconnect: null };
  const wireMessages: unknown[][] = [];
  const app = startSharedWorkerAppForTesting({
    id: "worker",
    plugins,
    expose,
    ...options,
    globalScope: scope,
  });
  return {
    app,
    factory() {
      const channel = new MessageChannel();
      const messages: unknown[] = [];
      channel.port1.addEventListener("message", (event) => messages.push(event.data));
      channel.port1.start();
      wireMessages.push(messages);
      queueMicrotask(() => scope.onconnect?.({ ports: [channel.port2] }));
      return { port: channel.port1 };
    },
    wireMessages,
  };
}

function trackedPort(): { readonly port: MessagePort; readonly closed: () => boolean } {
  let didClose = false;
  const raw = {
    postMessage(_message: unknown, _transfer?: readonly Transferable[]) {},
    start() {},
    close() { didClose = true; },
    addEventListener(_type: "message" | "messageerror", _listener: (event: MessageEvent) => void) {},
    removeEventListener(_type: "message" | "messageerror", _listener: (event: MessageEvent) => void) {},
  };
  return { port: raw as unknown as MessagePort, closed: () => didClose };
}

class MemoryPort implements MessagePortLike {
  readonly sent: unknown[] = [];
  private listener?: (event: MessageEvent) => void;

  addEventListener(_type: "message" | "messageerror", listener: (event: MessageEvent) => void): void {
    this.listener = listener;
  }

  removeEventListener(_type: "message" | "messageerror", listener: (event: MessageEvent) => void): void {
    if (this.listener === listener) this.listener = undefined;
  }

  postMessage(message: unknown): void {
    this.sent.push(message);
  }

  start(): void {}

  close(): void {}

  emit(message: unknown, ports: readonly MessagePort[] = []): void {
    this.listener?.({ data: message, ports } as MessageEvent);
  }
}

function streamCall(
  capability: RemoteCapability,
  reference: ServiceReference,
  callId: string,
  initialCredit = 1,
): RuntimeCallMessage {
  return {
    type: RUNTIME_CALL_TYPE,
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    callId,
    capabilityId: capability.id,
    contractVersion: capability.version,
    serviceInstanceId: reference.serviceInstanceId,
    mode: "stream",
    timeoutMs: 500,
    request: { topic: "acceptance" },
    initialCredit,
  };
}

function makeAt16Capabilities(count: number): readonly typeof Echo[] {
  return Array.from({ length: count }, (_, index) => defineCapability<{ value: string }, { result: string }>({
    kind: "rpc",
    id: `acceptance.at16.${index}`,
    version: "1",
    request: Echo.request,
    response: Echo.response,
  }));
}

function makeAt16Plugin(capabilities: readonly typeof Echo[]) {
  return definePlugin({
    id: "at16-provider",
    provides: capabilities,
    startup: "required" as const,
    setup(ctx) {
      for (const capability of capabilities) {
        ctx.handle(capability, (request) => ({ result: request.value }));
      }
    },
  });
}

describe("WebLoom v4 acceptance boundaries", () => {
  it("AT-23 gives handlers a real PeerView and commits exposure groups atomically", async () => {
    const scope: PeerScopeView = {
      state: "active",
      signal: new AbortController().signal,
      onRevoke() { return () => undefined; },
    };
    const bridge = createCapabilityBridge({ transport: createFakeRuntimeTransport() });
    const view = createCapabilityPeerView({ peerId: "peer:one", scope, bridge, allowed: [Echo] });
    for (const managementField of ["expose", "exposeGroup", "disconnect", "inspect", "revoke", "dispose", "child", "track", "acquire"]) {
      expect(managementField in view).toBe(false);
    }
    expect(() => view.capability(Hidden)).toThrowError(/unavailable/i);
    bridge.dispose();

    let groupError: unknown;
    const worker = createTestWorker([
      definePlugin({
        id: "atomic-provider",
        provides: [Echo, Hidden] as const,
        startup: "required" as const,
        setup(ctx) {
          ctx.handle(Echo, (request) => ({ result: request.value }));
          ctx.handle(Hidden, (request) => ({ result: request.value }));
        },
      }),
    ], [], { peerExposureAllowlist: [Echo, Hidden], configurePeer(peer) {
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      try {
        peer.exposeGroup([{ capability: Echo }, { capability: Hidden, options: { attributes: cyclic } }]);
      } catch (error) {
        groupError = error;
      }
    } });
    const runtime = connectSharedWorkerForTesting({ id: "worker", url: "/worker.js" }, worker.factory);
    await worker.app.ready();
    expect(groupError).toBeDefined();
    expect(runtime.state().services).toEqual([]);
    await expect(runtime.capability(Echo).call({ value: "not-exposed" }, { timeoutMs: 20 })).rejects.toMatchObject({ code: "capability_unavailable" });
    await runtime.dispose();
    await worker.app.dispose();
  });

  it("AT-24 transfers stream request buffer and business port, and cancellation before ready is bounded", async () => {
    const channel = new MessageChannel();
    const requestChannel = new MessageChannel();
    const clientTransport = createMessagePortRuntimeTransport(channel.port1);
    let received!: TransferRequest;
    let resolveReceived!: (value: TransferRequest) => void;
    const receivedPromise = new Promise<TransferRequest>((resolve) => { resolveReceived = resolve; });
    const provider = createMessagePortServiceProvider({
      port: channel.port2,
      services: () => [serviceReference(TransferEvents)],
      prepareRequest(call) {
        const value = TransferEvents.request.parse(call.request);
        return { value, transfer: TransferEvents.transfer?.request?.(value) };
      },
      handleCall: ({ request }) => {
        received = request as TransferRequest;
        resolveReceived(received);
        return (async function* () { yield 7; })();
      },
    });
    const bridge = createCapabilityBridge({ transport: clientTransport, defaultCallTimeoutMs: 500 });
    bridge.applySnapshot(snapshotFor(TransferEvents));
    const values: number[] = [];
    const buffer = new ArrayBuffer(32);
    const subscription = bridge.getClient(TransferEvents).subscribe({ buffer, port: requestChannel.port1 }, {
      initialCredit: 1,
      onNext(value) { values.push(value); },
    });
    await subscription.ready;
    await receivedPromise;
    expect(buffer.byteLength).toBe(0);
    expect(received.buffer.byteLength).toBe(32);
    const businessMessage = new Promise<unknown>((resolve) => {
      received.port.addEventListener("message", (event) => resolve(event.data), { once: true } as AddEventListenerOptions);
      received.port.start();
    });
    requestChannel.port2.postMessage({ business: true });
    await expect(businessMessage).resolves.toEqual({ business: true });
    await subscription.closed;
    expect(values).toEqual([7]);
    received.port.close();
    requestChannel.port2.close();
    bridge.dispose();
    provider.dispose();

    const cancelChannel = new MessageChannel();
    const cancelRequestChannel = new MessageChannel();
    const cancelBuffer = new ArrayBuffer(8);
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const cancelProvider = createMessagePortServiceProvider({
      port: cancelChannel.port2,
      services: () => [serviceReference(TransferEvents, "service:cancel")],
      prepareRequest(call) {
        const value = TransferEvents.request.parse(call.request);
        return { value, transfer: TransferEvents.transfer?.request?.(value) };
      },
      handleCall: ({ signal }) => new Promise<AsyncIterable<unknown>>((resolve) => {
        started();
        signal.addEventListener("abort", () => resolve((async function* () {})()), { once: true });
      }),
    });
    const cancelBridge = createCapabilityBridge({ transport: createMessagePortRuntimeTransport(cancelChannel.port1), defaultCallTimeoutMs: 500 });
    cancelBridge.applySnapshot(snapshotFor(TransferEvents, "service:cancel"));
    const cancelled = cancelBridge.getClient(TransferEvents).subscribe({ buffer: cancelBuffer, port: cancelRequestChannel.port1 }, {
      initialCredit: 1,
      onNext() {},
    });
    await startedPromise;
    expect(cancelBuffer.byteLength).toBe(0);
    cancelled.cancel("secret cancellation reason");
    await expect(cancelled.ready).rejects.toMatchObject({ code: "request_cancelled" });
    await expect(cancelled.closed).rejects.toMatchObject({ code: "request_cancelled" });
    await waitUntil(() => cancelProvider.executionCount() === 0);
    expect(cancelProvider.pendingCount()).toBe(0);
    cancelBridge.dispose();
    cancelProvider.dispose();
    cancelRequestChannel.port2.close();
  });

  it("AT-25 enforces finite DTO graphs and closes untransferred receive resources", async () => {
    const shared = { value: 1 };
    const dag = { left: shared, right: shared };
    const dagStats = validateDto(dag);
    expect(dagStats.nodes).toBe(2);
    expect(dagStats.edges).toBe(3);

    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => validateDto(cycle)).toThrowError(/cycles/i);

    let getterReads = 0;
    const getterRecord = {};
    Object.defineProperty(getterRecord, "value", {
      enumerable: true,
      get() { getterReads += 1; return 1; },
    });
    expect(() => validateDto(getterRecord)).toThrowError(/data properties/i);
    expect(getterReads).toBe(0);

    const deep = { a: { b: { c: 1 } } };
    expect(() => validateDto(deep, { limits: { maxDepth: 2 } })).toThrowError(/depth/i);
    expect(() => validateDto(new Map())).toThrowError(/prototype|unsupported/i);

    const buffer = new ArrayBuffer(16);
    const views = { bytes: new Uint8Array(buffer, 2, 4), data: new DataView(buffer, 0, 8) };
    expect(validateTransferList(views, [buffer])).toEqual([buffer]);
    const detached = new ArrayBuffer(4);
    structuredClone(detached, { transfer: [detached] });
    expect(() => validateDto(detached)).toThrowError(/detached/i);

    const rawPort = trackedPort();
    expect(() => validateDto({ port: rawPort.port })).toThrowError(/declared/i);
    expect(validateRawDto({ port: rawPort.port }, undefined).messagePorts).toEqual([rawPort.port]);
    const ledger = createReceivePortLedger([rawPort.port]);
    expect(ledger.valid).toBe(true);
    expect(() => assertReceivedPortSet(ledger, [])).toThrowError(/MessagePort/i);
    expect(rawPort.closed()).toBe(true);
    ledger.closeUndelivered();

    const latePort = trackedPort();
    const transport = createFakeRuntimeTransport();
    const bridge = createCapabilityBridge({ transport, defaultCallTimeoutMs: 100 });
    bridge.applySnapshot(snapshotFor(Events));
    const subscription = bridge.getClient(Events).subscribe({ topic: "late" }, { initialCredit: 1, onNext() {} });
    const call = transport.sent.at(-1)?.message;
    if (!call || call.type !== RUNTIME_CALL_TYPE) throw new Error("stream call was not sent");
    transport.emit({ type: RUNTIME_RESULT_TYPE, protocolVersion: RUNTIME_PROTOCOL_VERSION, callId: call.callId, serviceInstanceId: call.serviceInstanceId, streamReady: true });
    await subscription.ready;
    transport.emit({ type: RUNTIME_NEXT_TYPE, protocolVersion: RUNTIME_PROTOCOL_VERSION, callId: call.callId, serviceInstanceId: call.serviceInstanceId, sequence: 1, item: 1 }, [latePort.port]);
    await expect(subscription.closed).rejects.toMatchObject({ code: "transfer_invalid" });
    expect(latePort.closed()).toBe(true);
    bridge.dispose();
  });

  it("AT-26 applies N/N+1 pending and stream reservations independently per peer", async () => {
    const limits = { maxPendingCallsPerPeer: 1, maxPendingCallsPerRuntime: 4 } as const;
    const firstTransport = createFakeRuntimeTransport();
    const secondTransport = createFakeRuntimeTransport();
    const firstBridge = createCapabilityBridge({ transport: firstTransport, limits, defaultCallTimeoutMs: 500 });
    const secondBridge = createCapabilityBridge({ transport: secondTransport, limits, defaultCallTimeoutMs: 500 });
    firstBridge.applySnapshot(snapshotFor(Echo, "service:first"));
    secondBridge.applySnapshot(snapshotFor(Echo, "service:second"));
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = firstBridge.getClient(Echo).call({ value: "first" }, { signal: firstController.signal });
    const rejectedSamePeer = firstBridge.getClient(Echo).call({ value: "same-peer" });
    const second = secondBridge.getClient(Echo).call({ value: "second" }, { signal: secondController.signal });
    await expect(rejectedSamePeer).rejects.toMatchObject({ code: "resource_limit_exceeded" });
    expect(firstBridge.pendingCallCount).toBe(1);
    expect(secondBridge.pendingCallCount).toBe(1);
    firstController.abort();
    secondController.abort();
    await expect(first).rejects.toMatchObject({ code: "request_cancelled" });
    await expect(second).rejects.toMatchObject({ code: "request_cancelled" });
    expect(firstBridge.pendingCallCount).toBe(0);
    expect(secondBridge.pendingCallCount).toBe(0);

    const sharedLimits = { maxPendingCallsPerPeer: 1, maxPendingCallsPerRuntime: 1 } as const;
    const sharedBudget = createRuntimeBudget(sharedLimits);
    const sharedFirstTransport = createFakeRuntimeTransport();
    const sharedSecondTransport = createFakeRuntimeTransport();
    const sharedFirst = createCapabilityBridge({ transport: sharedFirstTransport, limits: sharedLimits, budget: sharedBudget });
    const sharedSecond = createCapabilityBridge({ transport: sharedSecondTransport, limits: sharedLimits, budget: sharedBudget });
    sharedFirst.applySnapshot(snapshotFor(Echo, "service:shared-first"));
    sharedSecond.applySnapshot(snapshotFor(Echo, "service:shared-second"));
    const sharedController = new AbortController();
    const sharedCall = sharedFirst.getClient(Echo).call({ value: "shared" }, { signal: sharedController.signal });
    await expect(sharedSecond.getClient(Echo).call({ value: "blocked" })).rejects.toMatchObject({ code: "resource_limit_exceeded" });
    sharedController.abort();
    await expect(sharedCall).rejects.toMatchObject({ code: "request_cancelled" });
    const afterReleaseController = new AbortController();
    const afterRelease = sharedSecond.getClient(Echo).call({ value: "after-release" }, { signal: afterReleaseController.signal });
    afterReleaseController.abort();
    await expect(afterRelease).rejects.toMatchObject({ code: "request_cancelled" });
    expect(sharedBudget.pendingCalls).toBe(0);

    const streamLimits = { maxActiveStreamsPerPeer: 1, maxActiveStreamsPerRuntime: 1 } as const;
    const streamTransport = createFakeRuntimeTransport();
    const streamBridge = createCapabilityBridge({ transport: streamTransport, limits: streamLimits });
    streamBridge.applySnapshot(snapshotFor(Events));
    const firstStream = streamBridge.getClient(Events).subscribe({ topic: "one" }, { initialCredit: 1, onNext() {} });
    const rejectedStream = streamBridge.getClient(Events).subscribe({ topic: "two" }, { initialCredit: 1, onNext() {} });
    await expect(rejectedStream.ready).rejects.toMatchObject({ code: "resource_limit_exceeded" });
    await expect(rejectedStream.closed).rejects.toMatchObject({ code: "resource_limit_exceeded" });
    expect(streamBridge.activeStreamCount).toBe(1);
    firstStream.cancel();
    await expect(firstStream.closed).rejects.toMatchObject({ code: "request_cancelled" });
    expect(streamBridge.activeStreamCount).toBe(0);
    const thirdStream = streamBridge.getClient(Events).subscribe({ topic: "three" }, { initialCredit: 1, onNext() {} });
    thirdStream.cancel();
    await expect(thirdStream.closed).rejects.toMatchObject({ code: "request_cancelled" });
    streamBridge.dispose();
    firstBridge.dispose();
    secondBridge.dispose();
    sharedFirst.dispose();
    sharedSecond.dispose();
  });

  it("AT-27 drains done streams in order, fences draining cancellation, and keeps never-returning iterators bounded", async () => {
    const transport = createFakeRuntimeTransport();
    const bridge = createCapabilityBridge({ transport, defaultCallTimeoutMs: 500 });
    bridge.applySnapshot(snapshotFor(Events));
    const values: number[] = [];
    let enteredFirst!: () => void;
    const firstEntered = new Promise<void>((resolve) => { enteredFirst = resolve; });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let enteredSecond!: () => void;
    const secondEntered = new Promise<void>((resolve) => { enteredSecond = resolve; });
    let releaseSecond!: () => void;
    const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const subscription = bridge.getClient(Events).subscribe({ topic: "ordered" }, {
      initialCredit: 2,
      onNext: async (value) => {
        values.push(value);
        if (value === 1) { enteredFirst(); await firstGate; }
        if (value === 2) { enteredSecond(); await secondGate; }
      },
    });
    const call = transport.sent.at(-1)?.message;
    if (!call || call.type !== RUNTIME_CALL_TYPE) throw new Error("stream call was not sent");
    transport.emit({ type: RUNTIME_RESULT_TYPE, protocolVersion: RUNTIME_PROTOCOL_VERSION, callId: call.callId, serviceInstanceId: call.serviceInstanceId, streamReady: true });
    await subscription.ready;
    transport.emit({ type: RUNTIME_NEXT_TYPE, protocolVersion: RUNTIME_PROTOCOL_VERSION, callId: call.callId, serviceInstanceId: call.serviceInstanceId, sequence: 1, item: 1 });
    await firstEntered;
    transport.emit({ type: RUNTIME_NEXT_TYPE, protocolVersion: RUNTIME_PROTOCOL_VERSION, callId: call.callId, serviceInstanceId: call.serviceInstanceId, sequence: 2, item: 2 });
    await tick();
    transport.emit({ type: RUNTIME_RESULT_TYPE, protocolVersion: RUNTIME_PROTOCOL_VERSION, callId: call.callId, serviceInstanceId: call.serviceInstanceId, done: true });
    releaseFirst();
    await secondEntered;
    expect(values).toEqual([1, 2]);
    releaseSecond();
    await subscription.closed;
    expect(bridge.activeStreamCount).toBe(0);
    bridge.dispose();

    const cancelTransport = createFakeRuntimeTransport();
    const cancelBridge = createCapabilityBridge({ transport: cancelTransport, defaultCallTimeoutMs: 500 });
    cancelBridge.applySnapshot(snapshotFor(Events, "service:draining-cancel"));
    let releaseCancelCallback!: () => void;
    const cancelGate = new Promise<void>((resolve) => { releaseCancelCallback = resolve; });
    let cancelEntered!: () => void;
    const cancelEnteredPromise = new Promise<void>((resolve) => { cancelEntered = resolve; });
    const drainingCancel = cancelBridge.getClient(Events).subscribe({ topic: "cancel" }, {
      initialCredit: 2,
      onNext: async () => { cancelEntered(); await cancelGate; },
    });
    const cancelCall = cancelTransport.sent.at(-1)?.message;
    if (!cancelCall || cancelCall.type !== RUNTIME_CALL_TYPE) throw new Error("cancel stream call was not sent");
    cancelTransport.emit({ type: RUNTIME_RESULT_TYPE, protocolVersion: RUNTIME_PROTOCOL_VERSION, callId: cancelCall.callId, serviceInstanceId: cancelCall.serviceInstanceId, streamReady: true });
    await drainingCancel.ready;
    cancelTransport.emit({ type: RUNTIME_NEXT_TYPE, protocolVersion: RUNTIME_PROTOCOL_VERSION, callId: cancelCall.callId, serviceInstanceId: cancelCall.serviceInstanceId, sequence: 1, item: 1 });
    await cancelEnteredPromise;
    drainingCancel.cancel("secret-draining-reason");
    await expect(drainingCancel.closed).rejects.toMatchObject({ code: "request_cancelled" });
    expect(JSON.stringify(cancelTransport.sent)).not.toContain("secret-draining-reason");
    releaseCancelCallback();
    cancelBridge.dispose();

    const providerPort = new MemoryPort();
    const providerReference = serviceReference(Events, "service:never-return");
    const neverIterator: AsyncIterator<number> = {
      async next() { return { value: 1, done: false }; },
      return() { return new Promise<IteratorResult<number>>(() => undefined); },
    };
    const provider = createMessagePortServiceProvider({
      port: providerPort,
      limits: { maxExecutionSlotsPerPeer: 1, maxExecutionSlotsPerRuntime: 1 },
      services: () => [providerReference],
      handleCall: () => ({ [Symbol.asyncIterator]: () => neverIterator }),
    });
    const neverCall = streamCall(Events, providerReference, "stream:never");
    providerPort.emit(neverCall);
    await waitUntil(() => providerPort.sent.some((message) => (message as { type?: unknown }).type === RUNTIME_NEXT_TYPE));
    providerPort.emit({ type: RUNTIME_CANCEL_TYPE, protocolVersion: RUNTIME_PROTOCOL_VERSION, callId: neverCall.callId, serviceInstanceId: neverCall.serviceInstanceId });
    await tick();
    expect(provider.pendingCount()).toBe(0);
    expect(provider.executionCount()).toBe(1);
    expect(provider.nonCooperativeExecutionCount()).toBe(1);
    providerPort.emit(streamCall(Events, providerReference, "stream:blocked"));
    await tick();
    expect(providerPort.sent.at(-1)).toMatchObject({ type: RUNTIME_PROTOCOL_VERSION + ".error", error: { code: "resource_limit_exceeded" } });
    provider.dispose();

    const errorPort = new MemoryPort();
    const errorProvider = createMessagePortServiceProvider({
      port: errorPort,
      services: () => [providerReference],
      handleCall: async () => { throw new Error("TOP_SECRET_HANDLER_MESSAGE"); },
    });
    const errorCall = streamCall(Events, providerReference, "stream:error");
    errorPort.emit(errorCall);
    await waitUntil(() => errorPort.sent.some((message) => (message as { type?: unknown }).type === RUNTIME_PROTOCOL_VERSION + ".error"));
    expect(JSON.stringify(errorPort.sent)).not.toContain("TOP_SECRET_HANDLER_MESSAGE");
    errorProvider.dispose();
  });

  it("AT-16 measures one public base snapshot across the service/peer matrix and isolates grants", async () => {
    for (const serviceCount of [1, 10, 100]) {
      for (const peerCount of [1, 2, 10]) {
        const capabilities = makeAt16Capabilities(serviceCount);
        const baseSnapshots: RuntimeStatusSnapshot[] = [];
        let nextGrantId = 0;
        const worker = createTestWorker([makeAt16Plugin(capabilities)], [], {
          peerExposureAllowlist: capabilities,
          configurePeer(peer) {
            const grantId = `at16-grant-${nextGrantId++}`;
            peer.exposeGroup(capabilities.map((capability) => ({ capability, options: { grantId } })));
          },
          snapshotObserver(snapshot) { baseSnapshots.push(snapshot); },
        });
        const runtimes: ReturnType<typeof connectSharedWorkerForTesting>[] = [];
        try {
          for (let index = 0; index < peerCount; index += 1) {
            runtimes.push(connectSharedWorkerForTesting({ id: "worker", url: "/worker.js" }, worker.factory));
          }
          await worker.app.ready();
          await Promise.all(runtimes.map((runtime) => waitUntil(() => runtime.state().state === "ready")));

          expect(baseSnapshots).toHaveLength(1);
          expect(baseSnapshots[0]?.state).toBe("ready");
          expect(baseSnapshots[0]?.services).toHaveLength(serviceCount);
          expect(new Set(baseSnapshots[0]?.services.map((service) => `${service.kind}\u0000${service.capabilityId}\u0000${service.contractVersion}`)).size).toBe(serviceCount);

          const grants = worker.wireMessages.map((messages) => {
            const snapshots = messages.filter((message): message is RuntimeSnapshot & { readonly type: typeof RUNTIME_SNAPSHOT_TYPE } => (
              Boolean(message) && typeof message === "object" && (message as { type?: unknown }).type === RUNTIME_SNAPSHOT_TYPE
            ));
            const snapshot = snapshots.at(-1);
            expect(snapshot?.state).toBe("ready");
            expect(snapshot?.services).toHaveLength(serviceCount);
            expect(new Set(snapshot?.services.map((service) => `${service.kind}\u0000${service.capabilityId}\u0000${service.contractVersion}`)).size).toBe(serviceCount);
            expect(snapshot?.services.every((service) => !Object.hasOwn(service, "runtime") && !Object.hasOwn(service, "runtimeInstanceId"))).toBe(true);
            expect((JSON.stringify(snapshot).match(/"runtimeInstanceId"/g) ?? []).length).toBe(1);
            return [...new Set(snapshot?.services.map((service) => service.grantId))];
          });
          expect(grants).toHaveLength(peerCount);
          expect(grants.every((peerGrants) => peerGrants.length === 1)).toBe(true);
          expect(new Set(grants.map((peerGrants) => peerGrants[0])).size).toBe(peerCount);
          expect(nextGrantId).toBe(peerCount);
        } finally {
          await Promise.all(runtimes.map((runtime) => runtime.dispose()));
          await worker.app.dispose();
        }
      }
    }
  });

  it("AT-28 runs the static contract inventory gate and preserves parser/dependency review metadata", () => {
    expect(inventory.entries.length).toBeGreaterThan(0);
    expect(JSON.stringify(inventory.entries)).not.toMatch(/function|setup|handler/);
    for (const entry of inventory.entries) {
      expect(typeof entry.moduleFingerprint).toBe("string");
      expect(typeof entry.contractTestVersion).toBe("string");
      expect(entry.dependencyFingerprints).toBeDefined();
    }
  });

  it("AT-29 returns redacted unavailable results and projects only visible provider units", async () => {
    const missingTransport = createFakeRuntimeTransport();
    const missingBridge = createCapabilityBridge({ transport: missingTransport, defaultCallTimeoutMs: 20 });
    missingBridge.applySnapshot(snapshotFor(Echo));
    const missing = missingBridge.getClient(Hidden).call({ value: "hidden" });
    await expect(missing).rejects.toMatchObject({ code: "capability_unavailable", message: "Capability is unavailable" });
    missingBridge.dispose();

    const providerPort = new MemoryPort();
    const visible = serviceReference(Echo, "service:visible");
    const provider = createMessagePortServiceProvider({ port: providerPort, services: () => [visible], handleCall: () => ({ result: "ok" }) });
    const hiddenCall: RuntimeCallMessage = {
      type: RUNTIME_CALL_TYPE,
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      callId: "call:hidden",
      capabilityId: Hidden.id,
      contractVersion: Hidden.version,
      serviceInstanceId: "service:hidden",
      mode: "unary",
      timeoutMs: 500,
      request: { value: "hidden" },
    };
    providerPort.emit(hiddenCall);
    await waitUntil(() => providerPort.sent.length > 0);
    expect(providerPort.sent.at(-1)).toMatchObject({ error: { code: "capability_unavailable", message: "Capability is unavailable" } });
    expect(JSON.stringify(providerPort.sent)).not.toContain("provider");
    provider.dispose();

    const worker = createTestWorker([
      definePlugin({
        id: "public-provider",
        provides: [Echo] as const,
        startup: "required" as const,
        setup(ctx) { ctx.handle(Echo, (request) => ({ result: request.value })); },
      }),
      definePlugin({
        id: "private-provider",
        provides: [Hidden] as const,
        startup: "required" as const,
        setup(ctx) { ctx.handle(Hidden, (request) => ({ result: request.value })); },
      }),
    ], [Echo]);
    const runtime = connectSharedWorkerForTesting({ id: "worker", url: "/worker.js" }, worker.factory);
    await worker.app.ready();
    await waitUntil(() => runtime.state().state === "ready");
    expect(runtime.state().services.map((service) => service.capabilityId)).toEqual([Echo.id]);
    expect(runtime.state().units.map((unit) => unit.pluginId)).toEqual(["public-provider"]);
    await runtime.dispose();
    await worker.app.dispose();
  });

  it("AT-30 records the exact Chromium evidence boundary without a fake Runtime fallback", () => {
    expect(verification).toContain("Chrome for Testing");
    expect(verification).toContain("153.0.8010.12");
    expect(verification).toContain("Firefox、真实 Safari");
    expect(verification).toContain("Playwright WebKit 本轮未执行");
    expect(requirements).toContain("不增加 DedicatedWorker、MessageChannel 或 Window 假 Runtime fallback");
  });
});
