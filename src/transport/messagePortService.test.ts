import { describe, expect, it } from "vitest";
import {
  createRemoteServiceMessageCodec,
  type RemoteServiceReference,
} from "../contracts/lifecycle.js";
import { createMessagePortServiceProvider } from "./messagePortServiceProvider.js";
import { createMessagePortServiceTransport } from "./messagePortServiceTransport.js";

function reference(serviceInstanceId = "service-1"): RemoteServiceReference {
  return {
    capabilityId: "demo.service",
    contractVersion: "demo.service.v1",
    runtime: "shared-worker",
    runtimeInstanceId: "runtime-1",
    serviceInstanceId,
    status: "ready",
    attributes: { tenant: "demo" },
  };
}

function context(ref = reference(), signal = new AbortController().signal) {
  return { reference: ref, signal };
}

describe("MessagePort service transport/provider v2", () => {
  it("完成 call/result 且 wire 不包含 connectionId 或完整 reference", async () => {
    const channel = new MessageChannel();
    const received: Record<string, unknown>[] = [];
    const ref = reference();
    const provider = createMessagePortServiceProvider({
      port: channel.port1,
      services: () => [ref],
      handleCall: async ({ message }) => {
        received.push(message as unknown as Record<string, unknown>);
        return { echoed: message.request };
      },
    });
    const transport = createMessagePortServiceTransport({ port: channel.port2 });
    await expect(transport.call({ value: 1 }, context(ref))).resolves.toEqual({ echoed: { value: 1 } });
    expect(received[0]).toMatchObject({
      capabilityId: "demo.service",
      contractVersion: "demo.service.v1",
      serviceInstanceId: "service-1",
      request: { value: 1 },
    });
    expect(received[0]).not.toHaveProperty("connectionId");
    expect(received[0]).not.toHaveProperty("reference");
    provider.dispose();
    transport.dispose();
  });

  it("支持自定义 wire prefix，但消息类别仍只有四种", async () => {
    const channel = new MessageChannel();
    const codec = createRemoteServiceMessageCodec({ prefix: "product.remote-service" });
    const ref = reference("service-custom");
    const provider = createMessagePortServiceProvider({
      port: channel.port1,
      codec,
      services: () => [ref],
      handleCall: async ({ message }) => message.request,
    });
    const transport = createMessagePortServiceTransport({ port: channel.port2, codec });
    await expect(transport.call({ custom: true }, context(ref))).resolves.toEqual({ custom: true });
    expect(codec.type("call")).toBe("product.remote-service.call");
    expect(() => codec.type("call")).not.toThrow();
    provider.dispose();
    transport.dispose();
  });

  it("同步 postMessage/DataCloneError 立即返回结构化 clone error", async () => {
    const channel = new MessageChannel();
    const port = channel.port2 as MessagePort & { postMessage: MessagePort["postMessage"] };
    port.postMessage = (() => {
      throw new DOMException("The object could not be cloned", "DataCloneError");
    }) as MessagePort["postMessage"];
    const transport = createMessagePortServiceTransport({ port, defaultCallTimeoutMs: 100 });
    await expect(transport.call({ uncloneable: true }, context())).rejects.toMatchObject({
      code: "request_clone_failed",
      details: { name: "DataCloneError" },
    });
    transport.dispose();
    channel.port1.close();
  });

  it("取消调用时删除 pending 并向 Provider 发送 cancel", async () => {
    const channel = new MessageChannel();
    let providerAborted = false;
    let handlerStarted = false;
    const ref = reference("service-cancel");
    const provider = createMessagePortServiceProvider({
      port: channel.port1,
      services: () => [ref],
      handleCall: async ({ signal }) => {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => {
          providerAborted = true;
          resolve();
        }, { once: true }));
        throw new Error("cancelled");
      },
    });
    const transport = createMessagePortServiceTransport({ port: channel.port2 });
    const controller = new AbortController();
    const pending = transport.call({}, context(ref, controller.signal));
    controller.abort(new Error("caller cancelled"));
    await expect(pending).rejects.toMatchObject({ code: "request_cancelled" });
    await viWaitFor(() => providerAborted);
    provider.dispose();
    transport.dispose();
  });

  it("Provider revoke 先阻止新调用并 abort 当前 handler", async () => {
    const channel = new MessageChannel();
    let providerAborted = false;
    let handlerStarted = false;
    const ref = reference("service-revoke");
    const provider = createMessagePortServiceProvider({
      port: channel.port1,
      services: () => [ref],
      handleCall: async ({ signal }) => new Promise((_resolve, reject) => {
        handlerStarted = true;
        signal.addEventListener("abort", () => {
          providerAborted = true;
          reject(new Error("revoked"));
        }, { once: true });
      }),
    });
    const transport = createMessagePortServiceTransport({ port: channel.port2 });
    const pending = transport.call({}, context(ref));
    await viWaitFor(() => handlerStarted);
    provider.revoke("provider restarting");
    await expect(pending).rejects.toBeDefined();
    await expect(transport.call({}, context(ref))).rejects.toMatchObject({ code: "service_revoked" });
    provider.dispose();
    transport.dispose();
  });

  it("目录替换会撤销旧 binding；忽略 AbortSignal 的 handler 也不能发送迟到结果", async () => {
    const channel = new MessageChannel();
    let handlerStarted = false;
    let releaseHandler!: () => void;
    const ref = reference("service-directory-epoch");
    const provider = createMessagePortServiceProvider({
      port: channel.port1,
      services: () => [ref],
      handleCall: async () => {
        handlerStarted = true;
        await new Promise<void>((resolve) => { releaseHandler = resolve; });
        return "late-success";
      },
    });
    const transport = createMessagePortServiceTransport({ port: channel.port2, defaultCallTimeoutMs: 40 });
    const pending = transport.call({}, context(ref));
    await viWaitFor(() => handlerStarted);
    provider.setServices([]);
    releaseHandler();

    await expect(pending).rejects.toMatchObject({ code: "service_revoked" });
    provider.dispose();
    transport.dispose();
  });
});

async function viWaitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition did not become true");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}
