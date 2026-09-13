import { describe, expect, it } from "vitest";
import { createRuntimeEndpointSession, type RuntimeDrainParticipant } from "./runtimeSession.js";

const binding = { runtimeInstanceId: "runtime:test", connectionId: "connection:test" } as const;

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("RuntimeEndpointSession", () => {
  it("synchronously fences cooperative work and waits for the real execution slot", async () => {
    const session = createRuntimeEndpointSession(binding, { defaultDrainTimeoutMs: 100 });
    const controller = new AbortController();
    let pending = 1;
    const completion = deferred<void>();
    const participant: RuntimeDrainParticipant = {
      drain: () => completion.promise,
      pending: () => pending,
    };
    session.registerDrainParticipant(participant);
    session.onBeginClose(() => {
      controller.abort();
      pending = 0;
      completion.resolve();
    });

    session.beginClose("local reason stays local");
    expect(session.state).toBe("closing");
    expect(controller.signal.aborted).toBe(true);
    const first = session.drain(50);
    const second = session.drain(50);
    expect(second).toBe(first);
    await expect(first).resolves.toEqual({ state: "closing", drained: true, timedOut: false, pendingExecutions: 0 });
  });

  it("reports non-cooperative timeout and preserves the terminal result after physical close", async () => {
    const session = createRuntimeEndpointSession(binding, { defaultDrainTimeoutMs: 10 });
    let pending = 1;
    const participant: RuntimeDrainParticipant = {
      drain: () => new Promise<void>(() => undefined),
      pending: () => pending,
    };
    session.registerDrainParticipant(participant);
    const result = await session.drain(500);
    expect(result).toEqual({ state: "closing", drained: false, timedOut: true, pendingExecutions: 1 });

    session.close();
    expect(session.state).toBe("closed");
    pending = 0;
    await expect(session.drain(1)).resolves.toEqual(result);
  });

  it("does not treat close-before-drain as proof that an execution finished", async () => {
    const session = createRuntimeEndpointSession(binding, { defaultDrainTimeoutMs: 20 });
    let pending = 1;
    session.registerDrainParticipant({
      drain: () => new Promise<void>(() => undefined),
      pending: () => pending,
    });
    session.close();
    const result = await session.drain(1);
    expect(result.state).toBe("closed");
    expect(result.drained).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.pendingExecutions).toBe(1);
    pending = 0;
    await expect(session.drain(100)).resolves.toEqual(result);
  });

  it("returns a structured failure when a participant rejects", async () => {
    const session = createRuntimeEndpointSession(binding, { defaultDrainTimeoutMs: 100 });
    session.registerDrainParticipant({
      drain: () => Promise.reject(new Error("private failure")),
      pending: () => 0,
    });
    await expect(session.drain(50)).resolves.toEqual({ state: "closing", drained: false, timedOut: false, pendingExecutions: 0 });
  });

  it("keeps beginClose and drain idempotent while clamping an oversized deadline", async () => {
    const session = createRuntimeEndpointSession(binding, { defaultDrainTimeoutMs: 10 });
    const started = Date.now();
    session.beginClose("first");
    session.beginClose("second");
    session.close();
    const result = await session.drain(300_000);
    expect(Date.now() - started).toBeLessThan(50);
    expect(result.state).toBe("closed");
  });
});
