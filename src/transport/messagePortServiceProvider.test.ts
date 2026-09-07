import { describe, expect, it, vi } from "vitest";
import type { RemoteServicePortCallMessage, RemoteServicePortResponseMessage } from "./messagePortServiceTransport.js";
import { createMessagePortServiceProvider } from "./messagePortServiceProvider.js";

function reference() {
  return {
    capabilityId: "test.service",
    providerInstanceId: "provider:1",
    execution: "coordinator-worker" as const,
    contractVersion: "1",
    authorityInstanceId: "authority:1",
    scopeId: "scope:1",
    handoverGeneration: 1,
    attributes: { tenancy: "shared" },
    status: "ready" as const,
    snapshotRevision: 1,
  };
}

function callMessage(overrides: Partial<RemoteServicePortCallMessage> = {}): RemoteServicePortCallMessage {
  return {
    type: "webloom.remote-service.call",
    callId: "call:1",
    connectionId: "connection:1",
    providerInstanceId: "provider:1",
    reference: reference(),
    request: { type: "read" },
    ...overrides,
  };
}

async function waitForResponse(
  responses: readonly RemoteServicePortResponseMessage[],
  callId: string,
): Promise<RemoteServicePortResponseMessage> {
  await vi.waitFor(() => expect(responses.some((response) => response.callId === callId)).toBe(true));
  return responses.find((response) => response.callId === callId)!;
}

describe("MessagePort service provider", () => {
  it("stops accepting an invalidated provider until a new snapshot restores it", async () => {
    const channel = new MessageChannel();
    const responses: RemoteServicePortResponseMessage[] = [];
    const handler = vi.fn(async ({ message }: { message: RemoteServicePortCallMessage }) => ({ request: message.request }));
    channel.port2.addEventListener("message", (event) => {
      if (event.data?.type === "webloom.remote-service.result" || event.data?.type === "webloom.remote-service.error") {
        responses.push(event.data as RemoteServicePortResponseMessage);
      }
    });
    channel.port2.start();
    const provider = createMessagePortServiceProvider({
      port: channel.port1,
      handshake: { connectionId: "connection:1", authorityInstanceId: "authority:1", protocolVersion: "1" },
      snapshot: {
        connectionId: "connection:1",
        authorityInstanceId: "authority:1",
        snapshotRevision: 1,
        baseline: true,
        services: [reference()],
      },
      handleCall: handler,
    });

    try {
      channel.port2.postMessage(callMessage());
      await expect(waitForResponse(responses, "call:1")).resolves.toMatchObject({
        type: "webloom.remote-service.result",
        result: { request: { type: "read" } },
      });
      expect(handler).toHaveBeenCalledTimes(1);

      provider.invalidate("provider restarting");
      channel.port2.postMessage(callMessage({ callId: "call:2" }));
      await expect(waitForResponse(responses, "call:2")).resolves.toMatchObject({
        type: "webloom.remote-service.error",
        error: { code: "service.provider_mismatch" },
      });
      expect(handler).toHaveBeenCalledTimes(1);

      provider.publishSnapshot({
        connectionId: "connection:1",
        authorityInstanceId: "authority:1",
        snapshotRevision: 2,
        baseline: false,
        services: [{ ...reference(), snapshotRevision: 2 }],
      });
      channel.port2.postMessage(callMessage({ callId: "call:3", reference: { ...reference(), snapshotRevision: 2 } }));
      await expect(waitForResponse(responses, "call:3")).resolves.toMatchObject({ type: "webloom.remote-service.result" });
      expect(handler).toHaveBeenCalledTimes(2);
    } finally {
      provider.dispose();
      channel.port2.close();
      channel.port1.close();
    }
  });

  it("aborts the handler for a matching connection and provider call", async () => {
    const channel = new MessageChannel();
    let requestSignal!: AbortSignal;
    let resolveHandler!: () => void;
    const handler = vi.fn(({ signal }: { signal: AbortSignal }) => {
      requestSignal = signal;
      return new Promise<void>((resolve) => { resolveHandler = resolve; });
    });
    channel.port2.start();
    const provider = createMessagePortServiceProvider({
      port: channel.port1,
      handshake: { connectionId: "connection:1", authorityInstanceId: "authority:1", protocolVersion: "1" },
      snapshot: {
        connectionId: "connection:1",
        authorityInstanceId: "authority:1",
        snapshotRevision: 1,
        baseline: true,
        services: [reference()],
      },
      handleCall: handler,
    });

    try {
      channel.port2.postMessage(callMessage({ callId: "call:cancel" }));
      await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
      channel.port2.postMessage({
        type: "webloom.remote-service.cancel",
        callId: "call:cancel",
        connectionId: "connection:1",
        providerInstanceId: "provider:1",
      });
      await vi.waitFor(() => expect(requestSignal.aborted).toBe(true));
      resolveHandler();
      await Promise.resolve();
    } finally {
      provider.dispose();
      channel.port2.close();
      channel.port1.close();
    }
  });
});
