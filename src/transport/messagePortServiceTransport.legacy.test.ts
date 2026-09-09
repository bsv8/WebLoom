import { describe, expect, it, vi } from "vitest";
import type {
  RemoteServicePortCallMessage,
  RemoteServicePortErrorMessage,
  RemoteServicePortResultMessage,
} from "./messagePortServiceTransport.js";
import { createMessagePortServiceTransport } from "./messagePortServiceTransport.js";
import { createServiceBridge } from "./serviceBridge.js";
import { createLifecycleScope } from "../lifecycle/resourceScope.js";

function reference(
  providerInstanceId: string,
  status: "ready" | "unavailable",
  snapshotRevision: number
) {
  return {
    capabilityId: "owner-store.v1",
    providerInstanceId,
    runtime: "shared-worker" as const,
    contractVersion: "owner-store.v1",
    authorityInstanceId: "authority:1",
    scopeId: `provider-scope:${providerInstanceId}`,
    handoverGeneration: 1,
    attributes: { tenant: "alpha", generation: 1 },
    status,
    snapshotRevision,
  };
}

async function waitForCalls(calls: readonly unknown[], count: number): Promise<void> {
  await vi.waitFor(() => expect(calls).toHaveLength(count), { interval: 1 });
}

describe("MessagePort service transport", () => {
  it("connects a Window proxy to a rebuilt Worker provider without reusing the old instance", async () => {
    const channel = new MessageChannel();
    let activeProviderInstanceId = "provider:1";
    let activeProviderScope = createLifecycleScope({
      kind: "plugin-instance",
      instanceId: activeProviderInstanceId,
      metadata: { pluginId: "owner-store" },
    });
    let ownerValue = "from-owner-1";
    let releasedResources = 0;
    activeProviderScope.track(
      { tenant: "alpha" },
      () => { releasedResources += 1; },
      "owner-store-resource"
    );

    channel.port2.addEventListener("message", (event) => {
      const message = event.data as RemoteServicePortCallMessage;
      if (message.type !== "webloom.remote-service.call") return;
      const respond = async () => {
        try {
          activeProviderScope.assertActive();
          if (message.reference.providerInstanceId !== activeProviderInstanceId) {
            throw new Error("provider instance is stale");
          }
          const result: RemoteServicePortResultMessage = {
            type: "webloom.remote-service.result",
            callId: message.callId,
            connectionId: message.connectionId,
            providerInstanceId: message.providerInstanceId,
            result: { key: message.request, value: ownerValue },
          };
          channel.port2.postMessage(result);
        } catch (error) {
          const result: RemoteServicePortErrorMessage = {
            type: "webloom.remote-service.error",
            callId: message.callId,
            connectionId: message.connectionId,
            providerInstanceId: message.providerInstanceId,
            error: { name: "ProviderUnavailable", message: error instanceof Error ? error.message : String(error) },
          };
          channel.port2.postMessage(result);
        }
      };
      void respond();
    });
    channel.port2.start();

    const transport = createMessagePortServiceTransport({ port: channel.port1 });
    const bridge = createServiceBridge({ protocolVersion: "service-bridge.v1", transport });
    const consumerScope = createLifecycleScope({
      kind: "plugin-instance",
      instanceId: "consumer:1",
      metadata: { pluginId: "consumer" },
    });

    try {
      expect(bridge.handshake({
        connectionId: "port:1",
        authorityInstanceId: "authority:1",
        protocolVersion: "service-bridge.v1",
      }).accepted).toBe(true);
      expect(bridge.applySnapshot({
        connectionId: "port:1",
        authorityInstanceId: "authority:1",
        snapshotRevision: 1,
        baseline: true,
        services: [reference("provider:1", "ready", 1)],
      }).accepted).toBe(true);

      const proxy = bridge.requireProxy({
        capabilityId: "owner-store.v1",
        contractVersion: "owner-store.v1",
      }, consumerScope);
      await expect(proxy.call({ key: "balance" }, { requestId: "request:1" })).resolves.toEqual({
        key: { key: "balance" },
        value: "from-owner-1",
      });

      await activeProviderScope.dispose({ reason: "owner session changed" });
      expect(releasedResources).toBe(1);
      expect(bridge.applySnapshot({
        connectionId: "port:1",
        authorityInstanceId: "authority:1",
        snapshotRevision: 2,
        baseline: false,
        services: [reference("provider:1", "unavailable", 2)],
      }).accepted).toBe(true);
      expect(proxy.revoked).toBe(true);
      await expect(proxy.call({ key: "balance" })).rejects.toMatchObject({ code: "service.unavailable" });

      activeProviderInstanceId = "provider:2";
      activeProviderScope = createLifecycleScope({
        kind: "plugin-instance",
        instanceId: activeProviderInstanceId,
        metadata: { pluginId: "owner-store" },
      });
      ownerValue = "from-owner-2";
      activeProviderScope.track(
        { tenant: "alpha" },
        () => { releasedResources += 1; },
        "owner-store-resource"
      );
      expect(bridge.applySnapshot({
        connectionId: "port:1",
        authorityInstanceId: "authority:1",
        snapshotRevision: 3,
        baseline: false,
        services: [reference("provider:2", "ready", 3)],
      }).accepted).toBe(true);
      const rebuiltProxy = bridge.requireProxy({
        capabilityId: "owner-store.v1",
        contractVersion: "owner-store.v1",
      }, consumerScope);
      await expect(rebuiltProxy.call({ key: "balance" }, { requestId: "request:2" })).resolves.toEqual({
        key: { key: "balance" },
        value: "from-owner-2",
      });
      expect(rebuiltProxy.reference.providerInstanceId).toBe("provider:2");
    } finally {
      transport.dispose();
      channel.port2.close();
      channel.port1.close();
      await activeProviderScope.dispose({ reason: "test finished" });
      await consumerScope.dispose({ reason: "test finished" });
    }
  });

  it("uses a transport callId separate from a reusable business operationId", async () => {
    const channel = new MessageChannel();
    const calls: Array<{ callId: string; operationId?: string; connectionId: string; providerInstanceId: string }> = [];
    let firstCall!: RemoteServicePortCallMessage;
    let secondCall!: RemoteServicePortCallMessage;
    channel.port2.addEventListener("message", (event) => {
      const message = event.data as RemoteServicePortCallMessage;
      if (message.type !== "webloom.remote-service.call") return;
      calls.push(message);
      if (!firstCall) firstCall = message;
      else secondCall = message;
    });
    channel.port2.start();
    const transport = createMessagePortServiceTransport({ port: channel.port1 });
    const referenceValue = reference("provider:1", "ready", 1);
    const signal = new AbortController();
    const context = (operationId: string, requestSignal: AbortSignal) => ({
      operationId,
      connectionId: "port:1",
      reference: referenceValue,
      signal: requestSignal,
    });

    try {
      const first = transport.call({ value: "first" }, context("operation:reused", signal.signal));
      await waitForCalls(calls, 1);
      signal.abort("cancel first");
      await expect(first).rejects.toBe("cancel first");

      const second = transport.call({ value: "second" }, context("operation:reused", new AbortController().signal));
      await waitForCalls(calls, 2);
      expect(firstCall.callId).not.toBe(secondCall.callId);
      expect(firstCall.operationId).toBe(secondCall.operationId);

      channel.port2.postMessage({
        type: "webloom.remote-service.result",
        callId: firstCall.callId,
        connectionId: firstCall.connectionId,
        providerInstanceId: firstCall.providerInstanceId,
        result: "late-first",
      } satisfies RemoteServicePortResultMessage);
      channel.port2.postMessage({
        type: "webloom.remote-service.result",
        callId: secondCall.callId,
        connectionId: secondCall.connectionId,
        providerInstanceId: secondCall.providerInstanceId,
        result: "second-result",
      } satisfies RemoteServicePortResultMessage);
      await expect(second).resolves.toBe("second-result");
    } finally {
      transport.dispose();
      channel.port2.close();
      channel.port1.close();
    }
  });

  it("does not reuse a callId when a transport is rebuilt on the same port", async () => {
    const channel = new MessageChannel();
    const calls: RemoteServicePortCallMessage[] = [];
    channel.port2.addEventListener("message", (event) => {
      const message = event.data as RemoteServicePortCallMessage;
      if (message.type === "webloom.remote-service.call") calls.push(message);
    });
    channel.port2.start();
    const referenceValue = reference("provider:1", "ready", 1);
    const context = (signal: AbortSignal) => ({
      operationId: "operation:reused-after-rebuild",
      connectionId: "port:reused",
      reference: referenceValue,
      signal,
    });
    const firstTransport = createMessagePortServiceTransport({ port: channel.port1 });

    try {
      const first = firstTransport.call({ value: "first" }, context(new AbortController().signal));
      await waitForCalls(calls, 1);
      const firstCall = calls[0]!;
      firstTransport.dispose();
      await expect(first).rejects.toMatchObject({ code: "service.unavailable" });

      const secondTransport = createMessagePortServiceTransport({ port: channel.port1 });
      try {
        const second = secondTransport.call({ value: "second" }, context(new AbortController().signal));
        await waitForCalls(calls, 2);
        const secondCall = calls[1]!;
        expect(secondCall.callId).not.toBe(firstCall.callId);
        expect(secondCall.operationId).toBe(firstCall.operationId);

        // 旧 transport 的迟到回包即使复用连接、Provider 和业务 operationId，
        // 也不能完成新 transport 的请求。
        channel.port2.postMessage({
          type: "webloom.remote-service.result",
          callId: firstCall.callId,
          connectionId: firstCall.connectionId,
          providerInstanceId: firstCall.providerInstanceId,
          result: "late-first",
        } satisfies RemoteServicePortResultMessage);
        channel.port2.postMessage({
          type: "webloom.remote-service.result",
          callId: secondCall.callId,
          connectionId: secondCall.connectionId,
          providerInstanceId: secondCall.providerInstanceId,
          result: "second-result",
        } satisfies RemoteServicePortResultMessage);
        await expect(second).resolves.toBe("second-result");
      } finally {
        secondTransport.dispose();
      }
    } finally {
      channel.port2.close();
      channel.port1.close();
    }
  });
});
