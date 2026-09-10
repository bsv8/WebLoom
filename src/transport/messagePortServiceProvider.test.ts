import { describe, expect, it, vi } from "vitest";
import type { RemoteServicePortResponseMessage } from "./messagePortServiceTransport.js";
import { createMessagePortServiceProvider } from "./messagePortServiceProvider.js";

function reference(serviceInstanceId = "provider:1") {
  return {
    capabilityId: "test.service",
    contractVersion: "test.service.v1",
    runtime: "shared-worker" as const,
    runtimeInstanceId: "runtime:1",
    serviceInstanceId,
    status: "ready" as const,
    attributes: { tenancy: "shared" },
  };
}

function callMessage(overrides: Partial<{
  callId: string;
  serviceInstanceId: string;
  protocolVersion: string;
}> = {}) {
  return {
    type: "webloom.remote-service.call",
    protocolVersion: "webloom.remote-service.v2",
    callId: overrides.callId ?? "call:1",
    capabilityId: "test.service",
    contractVersion: "test.service.v1",
    serviceInstanceId: overrides.serviceInstanceId ?? "provider:1",
    request: { type: "read" },
    ...(overrides.protocolVersion ? { protocolVersion: overrides.protocolVersion } : {}),
  };
}

async function waitForResponse(responses: readonly RemoteServicePortResponseMessage[], callId: string): Promise<RemoteServicePortResponseMessage> {
  await vi.waitFor(() => expect(responses.some((response) => response.callId === callId)).toBe(true));
  return responses.find((response) => response.callId === callId)!;
}

describe("MessagePort service provider", () => {
  it("根据本地权威目录验证 serviceInstanceId，拒绝客户端伪造目录", async () => {
    const channel = new MessageChannel();
    const responses: RemoteServicePortResponseMessage[] = [];
    channel.port2.addEventListener("message", (event) => {
      if (event.data?.type === "webloom.remote-service.result" || event.data?.type === "webloom.remote-service.error") {
        responses.push(event.data as RemoteServicePortResponseMessage);
      }
    });
    channel.port2.start();
    const handler = vi.fn(async ({ message }: { message: { request: unknown } }) => ({ request: message.request }));
    const provider = createMessagePortServiceProvider({
      port: channel.port1,
      services: () => [reference()],
      handleCall: handler as never,
    });
    try {
      channel.port2.postMessage(callMessage());
      await expect(waitForResponse(responses, "call:1")).resolves.toMatchObject({
        type: "webloom.remote-service.result",
        result: { request: { type: "read" } },
      });
      channel.port2.postMessage(callMessage({ callId: "call:stale", serviceInstanceId: "provider:old" }));
      await expect(waitForResponse(responses, "call:stale")).resolves.toMatchObject({
        type: "webloom.remote-service.error",
        error: { code: "service_stale" },
      });
      expect(handler).toHaveBeenCalledTimes(1);
    } finally {
      provider.dispose();
      channel.port2.close();
    }
  });

  it("取消消息只影响同一个 callId + serviceInstanceId", async () => {
    const channel = new MessageChannel();
    let requestSignal!: AbortSignal;
    let resolveHandler!: () => void;
    const provider = createMessagePortServiceProvider({
      port: channel.port1,
      services: () => [reference()],
      handleCall: ({ signal }) => {
        requestSignal = signal;
        return new Promise<void>((resolve) => { resolveHandler = resolve; });
      },
    });
    try {
      channel.port2.start();
      channel.port2.postMessage(callMessage({ callId: "call:cancel" }));
      await vi.waitFor(() => expect(requestSignal).toBeDefined());
      channel.port2.postMessage({
        type: "webloom.remote-service.cancel",
        protocolVersion: "webloom.remote-service.v2",
        callId: "call:cancel",
        serviceInstanceId: "provider:1",
      });
      await vi.waitFor(() => expect(requestSignal.aborted).toBe(true));
      resolveHandler();
    } finally {
      provider.dispose();
      channel.port2.close();
    }
  });
});
