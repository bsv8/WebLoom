// 依赖驱动生命周期的回归（PSM-003 / PSM-R02）。
//
// 这里不使用任何用户启停接口：装配清单中的插件全部参与系统，启动与计划销毁顺序由
// 已声明依赖决定。断言全部基于事件轨迹与实例身份，不只看最终状态。

import { describe, expect, it, vi } from "vitest";
import { defineCapability, type Capability } from "../contracts/capability.js";
import { definePlugin } from "../authoring/definePlugin.js";
import { createPluginHost, type PluginHost } from "./createPluginHost.js";
import type { PluginConsumer } from "../contracts/consumer.js";
import { createRuntimeUnitImplementationRegistry } from "./runtimeUnitImplementationRegistry.js";

const Alpha = defineCapability<{ name: string }>({ kind: "local", id: "psm.alpha", version: "1" });
const Beta = defineCapability<{ name: string }>({ kind: "local", id: "psm.beta", version: "1" });
const Gamma = defineCapability<{ name: string }>({ kind: "local", id: "psm.gamma", version: "1" });
const Shared = defineCapability<{ name: string }>({ kind: "local", id: "psm.shared", version: "1" });

/** 用一组插件定义创建一个已装配实现的 Host。 */
function hostFor(...definitions: ReturnType<typeof definePlugin>[]) {
  const implementations = createRuntimeUnitImplementationRegistry(
    definitions.map((definition) => ({
      pluginId: definition.manifest.id,
      unitId: definition.descriptor.id,
      setup: definition.setup,
      capabilities: definition.capabilities,
    })),
  );
  return createPluginHost({ runtime: "window-main", runtimeUnitImplementationRegistry: implementations });
}

describe("PSM 依赖驱动生命周期", () => {
  it("打乱登记顺序仍按依赖链 C → B → A 启动", async () => {
    const trace: string[] = [];
    const gamma = definePlugin({
      id: "gamma",
      provides: [Gamma] as const,
      setup(ctx) { trace.push(`start:${ctx.pluginId}`); ctx.provide(Gamma, { name: "gamma" }); },
    });
    const beta = definePlugin({
      id: "beta",
      provides: [Beta] as const,
      dependencies: [{ capability: Gamma }] as const,
      setup(ctx) { trace.push(`start:${ctx.pluginId}`); ctx.provide(Beta, { name: "beta" }); },
    });
    const alpha = definePlugin({
      id: "alpha",
      dependencies: [{ capability: Beta }] as const,
      setup(ctx) { trace.push(`start:${ctx.pluginId}`); },
    });
    const host = hostFor(gamma, beta, alpha);
    // 故意以 A → B → C 的逆依赖顺序登记。
    await host.registerAll([alpha.manifest, beta.manifest, gamma.manifest]);
    expect(trace).toEqual(["start:gamma", "start:beta", "start:alpha"]);
    expect(host.state("alpha")).toMatchObject({ kind: "enabled", lifecycleState: "running" });
    await host.dispose();
  });

  it("计划销毁按反向顺序 A → B → C 清理，并共享释放后的实例可重建", async () => {
    const trace: string[] = [];
    const build = (id: string, provides: readonly Capability[] | undefined, dependencies: readonly { readonly capability: Capability }[], onDispose?: () => void) => definePlugin({
      id,
      ...(provides ? { provides: provides as never } : {}),
      ...(dependencies.length > 0 ? { dependencies: dependencies as never } : {}),
      setup(ctx) {
        trace.push(`start:${id}`);
        for (const capability of provides ?? []) ctx.provide(capability as never, { name: id } as never);
        ctx.onDispose(() => { trace.push(`dispose:${id}`); onDispose?.(); });
      },
    });
    const gamma = build("gamma", [Gamma], []);
    const beta = build("beta", [Beta], [{ capability: Gamma }]);
    const alpha = build("alpha", undefined, [{ capability: Beta }]);
    const host = hostFor(gamma, beta, alpha);
    await host.registerAll([gamma.manifest, beta.manifest, alpha.manifest]);
    expect(trace).toEqual(["start:gamma", "start:beta", "start:alpha"]);
    const alphaInstance = host.state("alpha").instanceId;

    // 释放根提供者：必须先撤掉消费者，再清理提供者。
    trace.length = 0;
    await host.revoke("gamma", "domain condition");
    expect(trace).toEqual(["dispose:alpha", "dispose:beta", "dispose:gamma"]);
    expect(host.state("alpha")).toMatchObject({ kind: "blocked", lifecycleState: "waiting" });
    expect(host.state("beta").blockedBy).toEqual(["missing:local:psm.gamma@1"]);
    expect(host.state("gamma").blockedBy).toEqual(["revoked:domain condition"]);

    // 条件解除后按正向顺序重建，且是新实例（清理已在上一阶段完成）。
    trace.length = 0;
    await host.retry("gamma");
    expect(trace).toEqual(["start:gamma", "start:beta", "start:alpha"]);
    expect(host.state("alpha").instanceId).not.toBe(alphaInstance);
    await host.dispose();
  });

  it("共享提供者不因单个消费者被释放而销毁", async () => {
    const stops: string[] = [];
    const shared = definePlugin({
      id: "shared",
      provides: [Shared] as const,
      setup(ctx) {
        ctx.provide(Shared, { name: "shared" });
        ctx.onDispose(() => { stops.push("shared"); });
      },
    });
    const first = definePlugin({ id: "first", dependencies: [{ capability: Shared }] as const, setup(ctx) { ctx.onDispose(() => { stops.push("first"); }); } });
    const second = definePlugin({ id: "second", dependencies: [{ capability: Shared }] as const, setup(ctx) { ctx.onDispose(() => { stops.push("second"); }); } });
    const host = hostFor(shared, first, second);
    await host.registerAll([shared.manifest, first.manifest, second.manifest]);

    await host.revoke("first", "domain condition");
    expect(stops).toEqual(["first"]);
    expect(host.state("shared").kind).toBe("enabled");
    expect(host.state("second").kind).toBe("enabled");
    await host.dispose();
  });

  it("可选依赖缺席不等待，出现后被绑定；失效只降级消费者", async () => {
    const Optional = defineCapability<{ value: string }>({ kind: "local", id: "psm.optional", version: "1" });
    let seen: string | undefined;
    let consumer!: PluginConsumer;
    const consumerPlugin = definePlugin({
      id: "optional-consumer",
      dependencies: [{ capability: Optional, optional: true }] as const,
      setup(ctx) { seen = ctx.optionalCapability(Optional)?.value; consumer = ctx.consumer; },
    });
    const provider = definePlugin({
      id: "optional-provider",
      provides: [Optional] as const,
      setup(ctx) { ctx.provide(Optional, { value: "late" }); },
    });
    const host = hostFor(consumerPlugin, provider);
    // 只登记消费者：可选依赖缺席不阻塞启动。
    await host.registerAll([consumerPlugin.manifest]);
    expect(host.state("optional-consumer").kind).toBe("enabled");
    expect(seen).toBeUndefined();

    // 提供者出现后被绑定：已经运行的实例不会被重建，但新的读取立刻可见。
    host.register(provider.manifest);
    await host.reconcile();
    expect(host.state("optional-provider").kind).toBe("enabled");
    expect(consumer.optionalCapability(Optional)?.value).toBe("late");

    // 提供者失效：消费者降级而不是被连带销毁，旧解析立即反映缺席。
    await host.revoke("optional-provider", "domain condition");
    expect(host.state("optional-consumer").kind).toBe("enabled");
    expect(consumer.optionalCapability(Optional)).toBeUndefined();
    await host.dispose();
  });

  it("提供者初始化失败时消费者等待，恢复后按正向顺序重建且不重放副作用", async () => {
    const attempts = vi.fn();
    let failing = true;
    const provider = definePlugin({
      id: "flaky",
      provides: [Alpha] as const,
      setup(ctx) {
        attempts();
        if (failing) throw new Error("domain not ready");
        ctx.provide(Alpha, { name: "ready" });
      },
    });
    const consumer = definePlugin({ id: "flaky-consumer", dependencies: [{ capability: Alpha }] as const, setup() { attempts(); } });
    const host = hostFor(provider, consumer);
    await host.registerAll([provider.manifest, consumer.manifest]);
    expect(host.state("flaky").kind).toBe("failed");
    expect(host.explain("flaky").reasons.length).toBeGreaterThan(0);
    expect(host.state("flaky-consumer").kind).toBe("blocked");
    expect(attempts).toHaveBeenCalledTimes(1);

    failing = false;
    await host.retry("flaky");
    expect(host.state("flaky").kind).toBe("enabled");
    expect(host.state("flaky-consumer").kind).toBe("enabled");
    // 恢复只重新执行初始化，不重放任何已发送的业务调用。
    expect(attempts).toHaveBeenCalledTimes(3);
    await host.dispose();
  });

  it("依赖环在装配阶段被拒绝，绑定歧义也明确报错", async () => {
    const left = defineCapability<{ name: string }>({ kind: "local", id: "psm.cycle.left", version: "1" });
    const right = defineCapability<{ name: string }>({ kind: "local", id: "psm.cycle.right", version: "1" });
    const first = definePlugin({ id: "cycle-left", provides: [left] as const, dependencies: [{ capability: right }] as const, setup() {} });
    const second = definePlugin({ id: "cycle-right", provides: [right] as const, dependencies: [{ capability: left }] as const, setup() {} });
    const host = hostFor(first, second);
    await expect(host.registerAll([first.manifest, second.manifest])).rejects.toThrow(/cycle/);

    const Clashing = defineCapability<{ name: string }>({ kind: "local", id: "psm.clash", version: "1" });
    const providerA = definePlugin({ id: "clash-a", provides: [Clashing] as const, setup(ctx) { ctx.provide(Clashing, { name: "a" }); } });
    const providerB = definePlugin({ id: "clash-b", provides: [Clashing] as const, setup(ctx) { ctx.provide(Clashing, { name: "b" }); } });
    const consumer = definePlugin({ id: "clash-consumer", dependencies: [{ capability: Clashing }] as const, setup() {} });
    const ambiguous = hostFor(providerA, providerB, consumer);
    await expect(ambiguous.registerAll([providerA.manifest, providerB.manifest, consumer.manifest])).rejects.toThrow(/ambiguous providers/);
    await host.dispose();
    await ambiguous.dispose();
  });

  it("没有启停配置与意图存储，状态只表达生命周期", async () => {
    const plugin = definePlugin({ id: "solo", setup() {} });
    const host: PluginHost = hostFor(plugin);
    await host.registerAll([plugin.manifest]);
    const state = host.state("solo");
    expect(state).not.toHaveProperty("desiredEnabled");
    expect(state).not.toHaveProperty("desiredRevision");
    // 反向依赖的“运行中”是生命周期事实，不是用户启停意图。
    expect(host.reverseDeps("solo")).toEqual([]);
    await host.dispose();
  });
  it("消费者清理完成后才释放提供者：销毁按反向依赖分层，不并发", async () => {
    // 每个插件的清理是异步的：如果并发执行，提供者会在消费者之前“完成”清理。
    const trace: string[] = [];
    const build = (id: string, provides: readonly Capability[] | undefined, dependencies: readonly { readonly capability: Capability }[]) => definePlugin({
      id,
      ...(provides ? { provides: provides as never } : {}),
      ...(dependencies.length > 0 ? { dependencies: dependencies as never } : {}),
      setup(ctx) {
        for (const capability of provides ?? []) ctx.provide(capability as never, { name: id } as never);
        ctx.onDispose(async () => {
          trace.push(`dispose-start:${id}`);
          await new Promise((resolve) => setTimeout(resolve, 5));
          trace.push(`dispose-end:${id}`);
        });
      },
    });
    const gamma = build("gamma", [Gamma], []);
    const beta = build("beta", [Beta], [{ capability: Gamma }]);
    const alpha = build("alpha", undefined, [{ capability: Beta }]);
    const host = hostFor(gamma, beta, alpha);
    await host.registerAll([gamma.manifest, beta.manifest, alpha.manifest]);

    trace.length = 0;
    await host.revoke("gamma", "domain condition");
    // 严格顺序：alpha 开始 → alpha 结束 → beta 开始 → beta 结束 → gamma 开始 → 结束。
    expect(trace).toEqual([
      "dispose-start:alpha", "dispose-end:alpha",
      "dispose-start:beta", "dispose-end:beta",
      "dispose-start:gamma", "dispose-end:gamma",
    ]);
    await host.dispose();
  });

  it("Host 整体销毁同样按反向依赖顺序，而不是登记顺序倒序", async () => {
    const trace: string[] = [];
    const build = (id: string, provides: readonly Capability[] | undefined, dependencies: readonly { readonly capability: Capability }[]) => definePlugin({
      id,
      ...(provides ? { provides: provides as never } : {}),
      ...(dependencies.length > 0 ? { dependencies: dependencies as never } : {}),
      setup(ctx) {
        for (const capability of provides ?? []) ctx.provide(capability as never, { name: id } as never);
        ctx.onDispose(async () => {
          trace.push(`dispose-start:${id}`);
          await new Promise((resolve) => setTimeout(resolve, 5));
          trace.push(`dispose-end:${id}`);
        });
      },
    });
    // 登记顺序故意与依赖顺序相反：gamma 最后登记。
    const alpha = build("alpha", undefined, [{ capability: Beta }]);
    const beta = build("beta", [Beta], [{ capability: Gamma }]);
    const gamma = build("gamma", [Gamma], []);
    const host = hostFor(alpha, beta, gamma);
    await host.registerAll([alpha.manifest, beta.manifest, gamma.manifest]);

    trace.length = 0;
    await host.dispose();
    expect(trace).toEqual([
      "dispose-start:alpha", "dispose-end:alpha",
      "dispose-start:beta", "dispose-end:beta",
      "dispose-start:gamma", "dispose-end:gamma",
    ]);
  });

  it("已绑定的可选依赖参与启动排序，未绑定的可选依赖不等待", async () => {
    const trace: string[] = [];
    const Optional = defineCapability<{ value: string }>({ kind: "local", id: "psm.ordered.optional", version: "1" });
    const provider = definePlugin({
      id: "ordered-provider",
      provides: [Optional] as const,
      setup(ctx) { trace.push("start:provider"); ctx.provide(Optional, { value: "bound" }); },
    });
    let bound: string | undefined;
    const consumer = definePlugin({
      id: "ordered-consumer",
      // 可选依赖：提供者已在装配清单里，因此消费者必须等它就绪。
      dependencies: [{ capability: Optional, optional: true }] as const,
      setup(ctx) { trace.push("start:consumer"); bound = ctx.optionalCapability(Optional)?.value; },
    });
    const host = hostFor(consumer, provider);
    // 消费者先登记：仍然必须等提供者启动后消费者才启动。
    await host.registerAll([consumer.manifest, provider.manifest]);
    expect(trace).toEqual(["start:provider", "start:consumer"]);
    expect(bound).toBe("bound");

    // 没有提供者的可选依赖不产生等待：消费者可以先启动并读到缺席。
    const Missing = defineCapability<{ value: string }>({ kind: "local", id: "psm.ordered.missing", version: "1" });
    trace.length = 0;
    let absent: string | undefined;
    const lonely = definePlugin({
      id: "lonely-consumer",
      dependencies: [{ capability: Missing, optional: true }] as const,
      setup(ctx) { trace.push("start:lonely"); absent = ctx.optionalCapability(Missing)?.value; },
    });
    const host2 = hostFor(lonely);
    await host2.registerAll([lonely.manifest]);
    expect(trace).toEqual(["start:lonely"]);
    expect(absent).toBeUndefined();
    await host2.dispose();
    await host.dispose();
  });
  it("整体销毁时消费者也先于它的可选提供者清理", async () => {
    // 消费者对提供者只有可选依赖：撤销级联不会带走它，但销毁顺序仍必须先清理它。
    const trace: string[] = [];
    const Optional = defineCapability<{ value: string }>({ kind: "local", id: "psm.teardown.optional", version: "1" });
    const provider = definePlugin({
      id: "teardown-provider",
      provides: [Optional] as const,
      setup(ctx) {
        ctx.provide(Optional, { value: "x" });
        ctx.onDispose(async () => { trace.push("dispose-start:provider"); await new Promise((r) => setTimeout(r, 5)); trace.push("dispose-end:provider"); });
      },
    });
    const consumer = definePlugin({
      id: "teardown-consumer",
      dependencies: [{ capability: Optional, optional: true }] as const,
      setup(ctx) {
        ctx.onDispose(async () => { trace.push("dispose-start:consumer"); await new Promise((r) => setTimeout(r, 5)); trace.push("dispose-end:consumer"); });
      },
    });
    const host = hostFor(provider, consumer);
    await host.registerAll([provider.manifest, consumer.manifest]);
    trace.length = 0;
    await host.dispose();
    // 提供者虽然只是“可选依赖提供者”，仍然最后释放。
    expect(trace).toEqual([
      "dispose-start:consumer", "dispose-end:consumer",
      "dispose-start:provider", "dispose-end:provider",
    ]);
  });

  it("可选提供者撤销只让消费者降级，不会被连带撤销", async () => {
    const Optional = defineCapability<{ value: string }>({ kind: "local", id: "psm.downgrade.optional", version: "1" });
    let consumer!: PluginConsumer;
    const provider = definePlugin({
      id: "downgrade-provider",
      provides: [Optional] as const,
      setup(ctx) { ctx.provide(Optional, { value: "present" }); },
    });
    const client = definePlugin({
      id: "downgrade-client",
      dependencies: [{ capability: Optional, optional: true }] as const,
      setup(ctx) { consumer = ctx.consumer; },
    });
    const host = hostFor(provider, client);
    await host.registerAll([provider.manifest, client.manifest]);
    expect(consumer.optionalCapability(Optional)?.value).toBe("present");
    // 释放可选提供者：消费者实例保留，只降级。
    await host.revoke("downgrade-provider", "domain condition");
    expect(host.state("downgrade-client").kind).toBe("enabled");
    expect(consumer.optionalCapability(Optional)).toBeUndefined();
    await host.dispose();
  });
});
