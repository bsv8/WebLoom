// 跨 Runtime 与 Connect 分界的框架回归（PSM-R06 / PSM-R08）。
//
// 这里只验证框架接入合同：内部 capability 可跨 Worker 调用不等于对外发布；
// 外部发布名单必须由产品显式给出并绑定可信会话身份，框架不按 local/rpc 分类推断。

import { describe, expect, it } from "vitest";
import { defineCapability, type Capability } from "../contracts/capability.js";
import { definePlugin } from "../authoring/definePlugin.js";
import { createPluginHost } from "../host/createPluginHost.js";
import { createRuntimeUnitImplementationRegistry } from "../host/runtimeUnitImplementationRegistry.js";
import type { PluginConsumer } from "../contracts/consumer.js";

/** 取出结构化错误码；断言用错误码而不是文案。 */
async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try { await promise; return undefined; }
  catch (error) { return (error as { code?: string }).code; }
}


const request = { parse: (value: unknown) => value as { text: string } };
const response = { parse: (value: unknown) => value as { ok: boolean } };

/** 内部 RPC 服务：存在于插件之间，也可能经 peer 被 Worker 调用。 */
const InternalLedger = defineCapability<{ text: string }, { ok: boolean }>({
  kind: "rpc",
  id: "psm.internalLedger",
  version: "1",
  request,
  response,
});

/** 对外发布的服务：必须出现在产品的显式名单里才会被网关暴露。 */
const ExternalWallet = defineCapability<{ text: string }, { ok: boolean }>({
  kind: "rpc",
  id: "psm.externalWallet",
  version: "1",
  request,
  response,
});

/** 私有实现：没有 capability descriptor，任何名单都拿不到它。 */
const privateImpl = { balance: 42, pay: (amount: number) => ({ paid: amount }) };

/**
 * 模拟 Connect 网关的服务目录。
 *
 * 这段逻辑属于产品：它按显式名单和调用者会话决定哪些方法可用。框架只提供 capability
 * 身份与 peer 暴露策略，不提供“把 provides 自动导出给外部 App”的能力。
 */
function createGateway(published: readonly Capability[], callerSession: string) {
  const allowed = new Set(published.map((capability) => `${capability.kind}:${capability.id}@${capability.version}`));
  return {
    /** 外部 App 只能调用名单内的契约身份。 */
    resolve(capability: Capability): Capability | undefined {
      return allowed.has(`${capability.kind}:${capability.id}@${capability.version}`) ? capability : undefined;
    },
    /** 可信会话身份由网关自己绑定，调用参数不能改变它。 */
    session: () => callerSession,
  };
}

describe("PSM 跨 Runtime 与 Connect 分界", () => {
  it("内部服务不会自动变成外部服务：名单之外的契约被拒绝", async () => {
    const gateway = createGateway([ExternalWallet], "app-session-1");
    expect(gateway.resolve(ExternalWallet)).toBeDefined();
    // 同为 RPC 的内部服务不在名单里，因此外部不可达。
    expect(gateway.resolve(InternalLedger)).toBeUndefined();
    // 私有实现没有任何契约身份，名单机制对它无效。
    expect(gateway.resolve({ kind: "local", id: "psm.privateImpl", version: "1" } as Capability)).toBeUndefined();
    expect(privateImpl.balance).toBe(42);
    // 可信会话由网关自己绑定，不接受调用参数覆盖。
    expect(gateway.session()).toBe("app-session-1");
    expect((gateway as unknown as { session(claimed?: string): string }).session("app-session-2")).toBe("app-session-1");
  });

  it("消费者实例的远程句柄绑定自己的 scope，撤销后不能借根 scope 存活", async () => {
    let consumer!: PluginConsumer;
    const provider = definePlugin({
      id: "ledger-provider",
      provides: [InternalLedger] as const,
      setup(ctx) {
        ctx.handle(InternalLedger, async (request) => ({ ok: request.text.length > 0 }));
      },
    });
    const client = definePlugin({
      id: "ledger-client",
      dependencies: [{ capability: InternalLedger, sourceRuntime: "window-main" as const }] as const,
      setup(ctx) { consumer = ctx.consumer; },
    });
    const host = createPluginHost({
      runtime: "window-main",
      runtimeUnitImplementationRegistry: createRuntimeUnitImplementationRegistry([provider, client].map((definition) => ({
        pluginId: definition.manifest.id,
        unitId: definition.descriptor.id,
        setup: definition.setup,
        capabilities: definition.capabilities,
      }))),
    });
    await host.registerAll([provider.manifest, client.manifest]);
    const ledger = consumer.capability(InternalLedger);
    await expect(ledger.call({ text: "ping" })).resolves.toEqual({ ok: true });

    await host.revoke("ledger-client", "domain condition");
    // 入口先失效；已取得的句柄也不再能发起新的调用。
    expect(() => consumer.capability(InternalLedger)).toThrow(/no longer active/);
    await expect(Promise.resolve().then(() => ledger.call({ text: "ping" }))).rejects.toThrow();
    await host.dispose();
  });

  it("同一 realm 的 local 副作用服务不被框架自动撤销，领域自行复核", async () => {
    // local 能力返回普通对象：框架不承诺撤销它（文档已写明限度）。
    const LocalCache = defineCapability<{ store: { value: string } }>({ kind: "local", id: "psm.localCache", version: "1" });
    const store = { value: "kept" };
    const provider = definePlugin({
      id: "cache-provider",
      provides: [LocalCache] as const,
      setup(ctx) { ctx.provide(LocalCache, { store }); },
    });
    let consumer!: PluginConsumer;
    const client = definePlugin({
      id: "cache-client",
      dependencies: [{ capability: LocalCache }] as const,
      setup(ctx) { consumer = ctx.consumer; },
    });
    const host = createPluginHost({
      runtime: "window-main",
      runtimeUnitImplementationRegistry: createRuntimeUnitImplementationRegistry([provider, client].map((definition) => ({
        pluginId: definition.manifest.id,
        unitId: definition.descriptor.id,
        setup: definition.setup,
        capabilities: definition.capabilities,
      }))),
    });
    await host.registerAll([provider.manifest, client.manifest]);
    const held = consumer.capability(LocalCache);
    await host.revoke("cache-client", "domain condition");
    // 已取得的 local 引用仍在：这是已写明的保证限度，最终 I/O 由领域 authority 复核。
    expect(held.store).toBe(store);
    expect(held.store.value).toBe("kept");
    // 但新的解析入口已经失效。
    expect(() => consumer.capability(LocalCache)).toThrow(/no longer active/);
    await host.dispose();
  });
  it("可选提供者重建后旧 RPC 句柄永久失效，重新解析才得到新句柄", async () => {
    let generation = 0;
    let consumer!: PluginConsumer;
    const provider = definePlugin({
      id: "swap-provider",
      provides: [InternalLedger] as const,
      setup(ctx) {
        generation += 1;
        const current = generation;
        ctx.handle(InternalLedger, async () => ({ ok: current === 1 }));
      },
    });
    const client = definePlugin({
      id: "swap-client",
      dependencies: [{ capability: InternalLedger, sourceRuntime: "window-main" as const, optional: true }] as const,
      setup(ctx) { consumer = ctx.consumer; },
    });
    const host = createPluginHost({
      runtime: "window-main",
      runtimeUnitImplementationRegistry: createRuntimeUnitImplementationRegistry([provider, client].map((definition) => ({
        pluginId: definition.manifest.id,
        unitId: definition.descriptor.id,
        setup: definition.setup,
        capabilities: definition.capabilities,
      }))),
    });
    await host.registerAll([provider.manifest, client.manifest]);
    const held = consumer.capability(InternalLedger);
    // 第一代实现返回 ok: true。
    await expect(held.call({ text: "ping" })).resolves.toEqual({ ok: true });

    // 可选提供者释放并重建：第二代实现的返回语义不同。
    await host.revoke("swap-provider", "domain condition");
    await host.retry("swap-provider");
    expect(generation).toBe(2);

    // 旧句柄不得自动改用第二代实现：绑定在解析当下的服务实例上。
    expect(await codeOf(Promise.resolve().then(() => held.call({ text: "ping" })))).toMatch(/^service_(stale|revoked)$/);
    // 重新解析得到新句柄，才指向第二代实现。
    const fresh = consumer.capability(InternalLedger);
    expect(fresh).not.toBe(held);
    await expect(fresh.call({ text: "ping" })).resolves.toEqual({ ok: false });
    await host.dispose();
  });

  it("可选提供者重建后旧 stream 句柄同样失效", async () => {
    let generation = 0;
    let consumer!: PluginConsumer;
    const Watch = defineCapability<{ on: boolean }, { tick: number }>({
      kind: "stream",
      id: "psm.internalWatch",
      version: "1",
      request: { parse: (value: unknown) => value as { on: boolean } },
      item: { parse: (value: unknown) => value as { tick: number } },
    });
    const provider = definePlugin({
      id: "watch-provider",
      provides: [Watch] as const,
      setup(ctx) {
        generation += 1;
        ctx.handle(Watch, () => ({
          async *[Symbol.asyncIterator]() { yield { tick: generation }; },
        }));
      },
    });
    const client = definePlugin({
      id: "watch-client",
      dependencies: [{ capability: Watch, sourceRuntime: "window-main" as const, optional: true }] as const,
      setup(ctx) { consumer = ctx.consumer; },
    });
    const host = createPluginHost({
      runtime: "window-main",
      runtimeUnitImplementationRegistry: createRuntimeUnitImplementationRegistry([provider, client].map((definition) => ({
        pluginId: definition.manifest.id,
        unitId: definition.descriptor.id,
        setup: definition.setup,
        capabilities: definition.capabilities,
      }))),
    });
    await host.registerAll([provider.manifest, client.manifest]);
    const held = consumer.capability(Watch);
    const subscription = held.subscribe({ on: true }, { onNext: () => undefined });
    await expect(subscription.ready).resolves.toBeUndefined();

    await host.revoke("watch-provider", "domain condition");
    await host.retry("watch-provider");
    expect(generation).toBe(2);

    // 旧订阅句柄不再接受新的订阅：订阅以 rejected subscription/ready 表达失败，
    // 而不是改用第二代实现。
    const stale = held.subscribe({ on: true }, { onNext: () => undefined });
    expect(await codeOf(stale.ready)).toMatch(/^service_(stale|revoked)$/);
    expect(await codeOf(stale.closed)).toMatch(/^service_(stale|revoked)$/);
    const fresh = consumer.capability(Watch);
    const freshSubscription = fresh.subscribe({ on: true }, { onNext: () => undefined });
    await expect(freshSubscription.ready).resolves.toBeUndefined();
    await freshSubscription.cancel();
    subscription.cancel();
    await host.dispose();
  });
  it("提供者撤销时在途 RPC 被取消，迟到结果不再发布", async () => {
    let releaseHandler: (() => void) | undefined;
    let consumer!: PluginConsumer;
    const provider = definePlugin({
      id: "inflight-provider",
      provides: [InternalLedger] as const,
      setup(ctx) {
        ctx.handle(InternalLedger, async () => {
          // handler 尚未返回：提供者此时被释放。
          await new Promise<void>((resolve) => { releaseHandler = resolve; });
          return { ok: true };
        });
      },
    });
    const client = definePlugin({
      id: "inflight-client",
      dependencies: [{ capability: InternalLedger, sourceRuntime: "window-main" as const, optional: true }] as const,
      setup(ctx) { consumer = ctx.consumer; },
    });
    const host = createPluginHost({
      runtime: "window-main",
      runtimeUnitImplementationRegistry: createRuntimeUnitImplementationRegistry([provider, client].map((definition) => ({
        pluginId: definition.manifest.id,
        unitId: definition.descriptor.id,
        setup: definition.setup,
        capabilities: definition.capabilities,
      }))),
    });
    await host.registerAll([provider.manifest, client.manifest]);
    const ledger = consumer.capability(InternalLedger);
    const inFlight = ledger.call({ text: "ping" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // 提供者释放：在途调用必须立即失败，而不是等 handler 返回第一代结果。
    await host.revoke("inflight-provider", "domain condition");
    expect(await codeOf(inFlight)).toMatch(/^service_(stale|revoked)$/);
    // 迟到结果不发布。
    releaseHandler?.();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(inFlight).rejects.toBeDefined();
    await host.dispose();
  });

  it("提供者撤销时在途 stream 结束，迟到 item 不再交付", async () => {
    let releaseItems: (() => void) | undefined;
    const ticks: number[] = [];
    let consumer!: PluginConsumer;
    const Watch = defineCapability<{ on: boolean }, { tick: number }>({
      kind: "stream",
      id: "psm.inflightWatch",
      version: "1",
      request: { parse: (value: unknown) => value as { on: boolean } },
      item: { parse: (value: unknown) => value as { tick: number } },
    });
    const provider = definePlugin({
      id: "inflight-watch-provider",
      provides: [Watch] as const,
      setup(ctx) {
        ctx.handle(Watch, () => ({
          async *[Symbol.asyncIterator]() {
            yield { tick: 1 };
            await new Promise<void>((resolve) => { releaseItems = resolve; });
            yield { tick: 2 };
          },
        }));
      },
    });
    const client = definePlugin({
      id: "inflight-watch-client",
      dependencies: [{ capability: Watch, sourceRuntime: "window-main" as const, optional: true }] as const,
      setup(ctx) { consumer = ctx.consumer; },
    });
    const host = createPluginHost({
      runtime: "window-main",
      runtimeUnitImplementationRegistry: createRuntimeUnitImplementationRegistry([provider, client].map((definition) => ({
        pluginId: definition.manifest.id,
        unitId: definition.descriptor.id,
        setup: definition.setup,
        capabilities: definition.capabilities,
      }))),
    });
    await host.registerAll([provider.manifest, client.manifest]);
    const subscription = consumer.capability(Watch).subscribe({ on: true }, { onNext: (item) => { ticks.push(item.tick); } });
    await expect(subscription.ready).resolves.toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ticks).toEqual([1]);

    await host.revoke("inflight-watch-provider", "domain condition");
    expect(await codeOf(subscription.closed)).toMatch(/^service_(stale|revoked)$/);
    releaseItems?.();
    await new Promise((resolve) => setTimeout(resolve, 5));
    // 迟到 item 不交付。
    expect(ticks).toEqual([1]);
    subscription.cancel();
    await host.dispose();
  });
});
