import { describe, expect, it } from "vitest";

import {
  createRemoteServiceMessageCodec,
  type RemoteServiceReference,
} from "../contracts/lifecycle.js";
import {
  createMessagePortServiceProvider,
} from "./messagePortServiceProvider.js";
import {
  createMessagePortServiceTransport,
} from "./messagePortServiceTransport.js";

function reference(providerInstanceId = "provider-1"): RemoteServiceReference {
  return {
    capabilityId: "demo.service",
    providerInstanceId,
    execution: "worker",
    contractVersion: "1.0.0",
    authorityInstanceId: "authority-1",
    scopeId: "scope-1",
    handoverGeneration: 1,
    attributes: { tenant: "demo" },
    status: "ready",
    snapshotRevision: 1,
  };
}

describe("MessagePort service transport/provider", () => {
  it("使用默认 WebLoom codec 完成调用，并区分 operationId 与 callId", async () => {
    const channel = new MessageChannel();
    const receivedCallIds: string[] = [];
    const provider = createMessagePortServiceProvider({
      port: channel.port1,
      handshake: {
        connectionId: "connection-1",
        authorityInstanceId: "authority-1",
        protocolVersion: "1",
      },
      snapshot: {
        connectionId: "connection-1",
        authorityInstanceId: "authority-1",
        snapshotRevision: 1,
        baseline: true,
        services: [reference()],
      },
      handleCall: async ({ message }) => {
        receivedCallIds.push(message.callId);
        return { echoed: message.request };
      },
    });
    const transport = createMessagePortServiceTransport({
      port: channel.port2,
    });
    const serviceReference = reference();
    const context = () => ({
      operationId: "same-business-operation",
      connectionId: "connection-1",
      reference: serviceReference,
      signal: new AbortController().signal,
    });

    await expect(transport.call({ value: 1 }, context())).resolves.toEqual({
      echoed: { value: 1 },
    });
    await expect(transport.call({ value: 2 }, context())).resolves.toEqual({
      echoed: { value: 2 },
    });

    expect(receivedCallIds).toHaveLength(2);
    expect(new Set(receivedCallIds).size).toBe(2);
    provider.dispose();
    transport.dispose();
  });

  it("通过显式 codec 保持产品旧 wire 前缀，同时保留同一套传输实现", async () => {
    const channel = new MessageChannel();
    const codec = createRemoteServiceMessageCodec({
      prefix: "legacy.remote-service",
      protocolVersion: "1",
    });
    const provider = createMessagePortServiceProvider({
      port: channel.port1,
      codec,
      handshake: {
        connectionId: "connection-legacy",
        authorityInstanceId: "authority-legacy",
        protocolVersion: codec.protocolVersion,
      },
      snapshot: {
        connectionId: "connection-legacy",
        authorityInstanceId: "authority-legacy",
        snapshotRevision: 1,
        baseline: true,
        services: [
          {
            ...reference("provider-legacy"),
            authorityInstanceId: "authority-legacy",
            providerInstanceId: "provider-legacy",
          },
        ],
      },
      handleCall: async ({ message }) => message.request,
    });
    const transport = createMessagePortServiceTransport({
      port: channel.port2,
      codec,
    });

    await expect(transport.call(
      { legacy: true },
      {
        connectionId: "connection-legacy",
        reference: {
          ...reference("provider-legacy"),
          authorityInstanceId: "authority-legacy",
          providerInstanceId: "provider-legacy",
        },
        signal: new AbortController().signal,
      },
    )).resolves.toEqual({ legacy: true });

    expect(codec.type("call")).toBe("legacy.remote-service.call");
    provider.dispose();
    transport.dispose();
  });

  it("取消调用时向 Provider 发送 cancel，且不把迟到结果交给调用方", async () => {
    const channel = new MessageChannel();
    let providerAborted = false;
    const provider = createMessagePortServiceProvider({
      port: channel.port1,
      handshake: {
        connectionId: "connection-cancel",
        authorityInstanceId: "authority-cancel",
        protocolVersion: "1",
      },
      snapshot: {
        connectionId: "connection-cancel",
        authorityInstanceId: "authority-cancel",
        snapshotRevision: 1,
        baseline: true,
        services: [reference("provider-cancel")],
      },
      handleCall: async ({ signal }) => {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => {
            providerAborted = true;
            resolve();
          }, { once: true });
        });
        throw new Error("cancelled");
      },
    });
    const transport = createMessagePortServiceTransport({ port: channel.port2 });
    const controller = new AbortController();
    const pending = transport.call(
      { value: "cancel-me" },
      {
        connectionId: "connection-cancel",
        reference: reference("provider-cancel"),
        signal: controller.signal,
      },
    );
    controller.abort(new Error("caller cancelled"));

    await expect(pending).rejects.toThrow("caller cancelled");
    await new Promise<void>((resolve) => {
      const check = () => providerAborted ? resolve() : setTimeout(check, 0);
      check();
    });
    expect(providerAborted).toBe(true);
    provider.dispose();
    transport.dispose();
  });
});
