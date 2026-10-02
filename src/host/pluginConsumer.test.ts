// 插件实例消费边界的运行时回归（PCB-001/002/003/005）。
//
// 全部使用内存 local 能力与 fake Host，不联网、不执行真实业务 I/O。

import { describe, expect, it, vi } from "vitest";
import { defineCapability, type Capability, type CapabilityClient } from "../contracts/capability.js";
import { definePlugin } from "../authoring/definePlugin.js";
import { RESOURCE_REGISTRY, type ResourceDefinition, type ResourceRegistry } from "../contracts/resource.js";
import type { PluginContext } from "../contracts/plugin.js";
import type { PluginConsumer } from "../contracts/consumer.js";
import { isIssuedPluginConsumer } from "../contracts/consumer.js";
import { createPluginHost, type ContributionAdapterInput, type PluginHost } from "./createPluginHost.js";
import { createRuntimeUnitImplementationRegistry } from "./runtimeUnitImplementationRegistry.js";
import { UNOWNED_RESOURCE_OWNER } from "../resources/instanceResourceRegistry.js";

const Provider = defineCapability<{ value: string }>({ kind: "local", id: "pcb.provider", version: "1" });
const Optional = defineCapability<{ value: string }>({ kind: "local", id: "pcb.optional", version: "1" });
const Undeclared = defineCapability<{ value: string }>({ kind: "local", id: "pcb.undeclared", version: "1" });
const WrongVersion = defineCapability<{ value: string }>({ kind: "local", id: "pcb.provider", version: "2" });

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

describe("PCB 插件实例消费视图", () => {
  it("ctx.consumer 与 contribution adapter 拿到同一个实例的视图", async () => {
    let fromSetup: PluginConsumer | undefined;
    let fromAdapter: PluginConsumer | undefined;
    const plugin = definePlugin({
      id: "consumer-plugin",
      provides: [Provider] as const,
      setup(ctx) {
        fromSetup = ctx.consumer;
        ctx.provide(Provider, { value: "ok" });
      },
      contribution: { kind: "route" },
    });
    const host = createPluginHost({
      runtimeUnitImplementationRegistry: createRuntimeUnitImplementationRegistry([{
        pluginId: plugin.manifest.id,
        unitId: plugin.descriptor.id,
        setup: plugin.setup,
        capabilities: plugin.capabilities,
      }]),
      contributionAdapters: [{
        name: "test-adapter",
        register(input: ContributionAdapterInput) {
          fromAdapter = input.consumer;
          return () => undefined;
        },
      }],
    });
    await host.registerAll([plugin.manifest]);
    expect(fromAdapter).toBeDefined();
    expect(fromAdapter).toBe(fromSetup);
    expect(fromSetup?.instanceId).toBeTruthy();
    expect(fromSetup?.pluginId).toBe("consumer-plugin");
    await host.dispose();
  });

  it("consumer 只能读取自己声明的能力，未声明与错版本都拒绝", async () => {
    let consumer!: PluginConsumer;
    const reader = definePlugin({
      id: "reader",
      dependencies: [{ capability: Provider, optional: true }, { capability: Optional, optional: true }] as const,
      setup(ctx) { consumer = ctx.consumer; },
    });
    const providerPlugin = definePlugin({
      id: "provider-plugin",
      provides: [Provider] as const,
      setup(ctx) { ctx.provide(Provider, { value: "from-provider" }); },
    });
    const host = hostFor(providerPlugin, reader);
    await host.registerAll([providerPlugin.manifest, reader.manifest]);

    expect(consumer.capability(Provider)).toEqual({ value: "from-provider" });
    // 已声明但未提供的 optional：返回 undefined，不抛错。
    expect(consumer.optionalCapability(Optional)).toBeUndefined();
    // 未声明：无论 optional 与否都拒绝。
    expect(() => consumer.capability(Undeclared)).toThrow(/not declared by plugin/);
    expect(() => consumer.optionalCapability(Undeclared)).toThrow(/not declared by plugin/);
    // 错版本：同一 id 不同 version 视为未声明。
    expect(() => consumer.capability(WrongVersion)).toThrow(/not declared by plugin/);
    await host.dispose();
  });

  it("撤权后旧 consumer 的新解析立即失败，同名重启不自动重绑", async () => {
    const issued: PluginConsumer[] = [];
    const cycle = definePlugin({
      id: "cycle",
      dependencies: [{ capability: Provider, optional: true }] as const,
      setup(ctx) { issued.push(ctx.consumer); },
    });
    const providerPlugin = definePlugin({
      id: "provider-plugin",
      provides: [Provider] as const,
      setup(ctx) { ctx.provide(Provider, { value: "v1" }); },
    });
    const host = hostFor(providerPlugin, cycle);
    await host.registerAll([providerPlugin.manifest, cycle.manifest]);
    const original = issued[0]!;
    expect(original.status).toBe("active");
    expect(original.capability(Provider)).toEqual({ value: "v1" });

    await host.revoke("cycle");
    // 入口撤销：旧视图的新解析立即失败。
    expect(original.status).toBe("revoked");
    expect(() => original.capability(Provider)).toThrow(/no longer active/);
    expect(() => original.optionalCapability(Provider)).toThrow(/no longer active/);

    // 同一个定义重新启用即可；框架必须签发新的 instanceId 与 consumer。
    await host.retry("cycle");
    expect(issued).toHaveLength(2);
    const restarted = issued[1]!;
    expect(restarted.instanceId).not.toBe(original.instanceId);
    expect(restarted).not.toBe(original);
    // 旧视图永久失效，不会因为同名重启而复活。
    expect(() => original.capability(Provider)).toThrow(/no longer active/);
    expect(restarted.capability(Provider)).toEqual({ value: "v1" });
    await host.dispose();
  });

  it("伪造结构无法冒充 consumer：没有框架签发就没有来源关联", async () => {
    let consumer!: PluginConsumer;
    const plugin = definePlugin({ id: "forge-target", setup(ctx) { consumer = ctx.consumer; } });
    const host = hostFor(plugin);
    await host.registerAll([plugin.manifest]);
    // 通过结构复制字段得到的对象只是普通对象，框架不会把它当作另一个实例。
    const forged = { pluginId: consumer.pluginId, unitId: consumer.unitId, instanceId: consumer.instanceId, status: "active" } as unknown as PluginConsumer;
    expect((forged as { capability?: unknown }).capability).toBeUndefined();
    // 真实 consumer 只暴露受限成员，不含管理入口。
    expect(Object.keys(consumer).sort()).toEqual(["capability", "instanceId", "optionalCapability", "pluginId", "privateCapability", "status", "subscribe", "unitId"]);
    for (const forbidden of ["provide", "handle", "enable", "disable", "dispose", "host", "app", "rootScope", "messageBus", "context"]) {
      expect((consumer as unknown as Record<string, unknown>)[forbidden]).toBeUndefined();
    }
    await host.dispose();
  });

  it("资源上下文按定义 owner 解析 typed 能力，撤权时不发布迟到数据", async () => {
    const seenOwner: (string | undefined)[] = [];
    let releaseLoad: (() => void) | undefined;
    const definition: ResourceDefinition<string, readonly string[]> = {
      id: "pcb.late",
      scope: "plugin",
      invalidation: "immediate",
      key: () => ["pcb.late"],
      async load(_args, context) {
        seenOwner.push(context.ownerId);
        // loader 读取的是“定义资源的实例”所声明的能力，不是页面 consumer。
        const value = context.capability(Provider);
        await new Promise<void>((resolve) => { releaseLoad = resolve; });
        return `loaded:${value.value}`;
      },
    };
    const resourcePlugin = definePlugin({
      id: "resource-plugin",
      dependencies: [{ capability: RESOURCE_REGISTRY }, { capability: Provider, optional: true }] as const,
      setup(ctx) {
        const registry = ctx.capability(RESOURCE_REGISTRY);
        registry.register(definition);
      },
    });
    const providerPlugin = definePlugin({
      id: "provider-plugin",
      provides: [Provider] as const,
      setup(ctx) { ctx.provide(Provider, { value: "owner-value" }); },
    });
    const host = hostFor(providerPlugin, resourcePlugin);
    await host.registerAll([providerPlugin.manifest, resourcePlugin.manifest]);

    // 插件注册的资源定义实际登记到该实例，而不是宿主或空 owner。
    expect(host.resourceRegistry.get("pcb.late")).toBeDefined();
    const snapshot = host.resourceStore.ensure<string>("pcb.late", []);
    expect(snapshot.status).toBe("pending");
    // loader 读到的 owner 是定义资源的那个实例，且能按声明解析 Provider。
    expect(seenOwner).toHaveLength(1);
    expect(seenOwner[0]).toBeTruthy();

    // 撤权后取消在途加载，迟到结果不得发布。
    await host.revoke("resource-plugin");
    releaseLoad?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(host.resourceStore.read<string>("pcb.late", [])).toBeUndefined();
    await host.dispose();
  });

  it("consumer 订阅随实例失效而停止，退订幂等", async () => {
    let consumer!: PluginConsumer;
    const listener = vi.fn();
    const plugin = definePlugin({ id: "subscriber", setup(ctx) { consumer = ctx.consumer; } });
    const host = hostFor(plugin);
    await host.registerAll([plugin.manifest]);
    const unsubscribe = consumer.subscribe(listener);
    host.provide(Undeclared, { value: "x" });
    expect(listener).toHaveBeenCalled();
    unsubscribe();
    unsubscribe();
    const callsAfterUnsubscribe = listener.mock.calls.length;
    await host.revoke("subscriber");
    expect(listener.mock.calls.length).toBe(callsAfterUnsubscribe);
    // 撤销后 subscribe 不再注册监听，并返回幂等的空退订。
    const after = listener.mock.calls.length;
    const late = consumer.subscribe(listener);
    late();
    late();
    expect(listener.mock.calls.length).toBe(after);
    await host.dispose();
  });

  it("资源注册表视图拒绝跨实例注销与 owner 伪造", async () => {
    // 插件侧拿到的实例视图登记在这里，测试结束前统一清空；不写 globalThis，
    // 避免跨测试文件污染。
    const captured = new Map<string, { unregister(id: string): void }>();
    const make = (id: string, definitionId: string) => definePlugin({
      id,
      dependencies: [{ capability: RESOURCE_REGISTRY }] as const,
      setup(ctx) {
        const registry = ctx.capability(RESOURCE_REGISTRY);
        registry.register({ id: definitionId, scope: "plugin", invalidation: "immediate", key: () => [definitionId], load: async () => definitionId });
        captured.set(id, registry);
      },
    });
    const first = make("owner-a", "pcb.a");
    const second = make("owner-b", "pcb.b");
    const host = hostFor(first, second);
    await host.registerAll([first.manifest, second.manifest]);
    // 注销他人定义必须拒绝，且不删除对方资源。
    expect(() => captured.get("owner-b")!.unregister("pcb.a")).toThrow(/is not owned by plugin instance/);
    expect(host.resourceRegistry.get("pcb.a")).toBeDefined();
    // 注销自己的定义正常。
    captured.get("owner-a")!.unregister("pcb.a");
    expect(host.resourceRegistry.get("pcb.a")).toBeUndefined();
    expect(host.resourceRegistry.get("pcb.b")).toBeDefined();

    // 伪造 unowned / 他人 owner 的定义对象无效：owner 由 Host 绑定，插件
    // 传入的 ownerPluginId 字段不会成为真实 owner。
    const forged = host.resourceRegistry as unknown as { _ownerOf?(id: string): string | undefined };
    expect(forged._ownerOf?.("pcb.b")).toBeTruthy();
    expect(forged._ownerOf?.("pcb.b")).not.toBe("owner-b");
    expect(forged._ownerOf?.("pcb.b")).not.toBe(UNOWNED_RESOURCE_OWNER);

    // 宿主装配层的裸注册表不受实例视图限制（trusted assembly path）。
    host.resourceRegistry.register({ id: "pcb.host", scope: "host", invalidation: "immediate", key: () => ["pcb.host"], load: async () => "host" });
    expect(host.resourceRegistry.get("pcb.host")).toBeDefined();
    captured.clear();
    await host.dispose();
  });

  it("伪造 consumer 对象没有来源关联，Provider 与来源检查都拒绝", async () => {
    let real!: PluginConsumer;
    const plugin = definePlugin({ id: "brand-target", setup(ctx) { real = ctx.consumer; } });
    const host = hostFor(plugin);
    await host.registerAll([plugin.manifest]);

    // 结构完全一致、方法都转发到真实 consumer，但对象本身未经签发。
    const forged = Object.freeze({
      pluginId: real.pluginId,
      unitId: real.unitId,
      instanceId: real.instanceId,
      status: "active" as const,
      capability: real.capability.bind(real),
      optionalCapability: real.optionalCapability.bind(real),
      subscribe: real.subscribe.bind(real),
    }) as unknown as PluginConsumer;
    expect(isIssuedPluginConsumer(real)).toBe(true);
    expect(isIssuedPluginConsumer(forged)).toBe(false);
    expect(isIssuedPluginConsumer({ ...real })).toBe(false);
    // JSON 往返也拿不到合法身份。
    expect(isIssuedPluginConsumer(JSON.parse(JSON.stringify(real)))).toBe(false);
    await host.dispose();
  });

  it("异步贡献注册期间实例被撤销：注册项不留可挂载入口", async () => {
    const plugin = definePlugin({
      id: "slow-contribution",
      contribution: { kind: "page" },
      setup() { /* 贡献由 adapter 异步注册，setup 本身不注册。 */ },
    });
    let releaseRegister: (() => void) | undefined;
    const calls: string[] = [];
    const host = createPluginHost({
      runtimeUnitImplementationRegistry: createRuntimeUnitImplementationRegistry([{
        pluginId: plugin.manifest.id,
        unitId: plugin.descriptor.id,
        setup: plugin.setup,
        capabilities: plugin.capabilities,
      }]),
      contributionAdapters: [{
        name: "slow-adapter",
        async register() {
          await new Promise<void>((resolve) => { releaseRegister = resolve; });
          // 迟到句柄带 revoke 与 dispose 两种收尾：实例已经撤销时两者都必须
          // 执行，否则适配器已经启动的订阅/定时器会泄漏。
          return {
            revoke: () => { calls.push("revoke"); },
            dispose: async () => { calls.push("dispose-start"); await Promise.resolve(); calls.push("dispose-end"); },
          };
        },
      }],
    });
    const pending = host.registerAll([plugin.manifest]);
    // 等 adapter 真正进入 await，再走同步撤权路径（不等 starting 任务结束，
    // 否则会与本测试要验证的竞态互相等待）。
    await new Promise((resolve) => setTimeout(resolve, 0));
    host.revoke("slow-contribution", "test stop").catch(() => undefined);
    releaseRegister?.();
    await pending.catch(() => undefined);
    await host.dispose();
    // 完整收尾：先 revoke 再 dispose，且 dispose 的异步过程走完。
    expect(calls).toEqual(["revoke", "dispose-start", "dispose-end"]);
  });

  it("迟到贡献的 dispose 失败不阻断 revoke，也不产生未处理拒绝", async () => {
    const plugin = definePlugin({
      id: "slow-contribution-2",
      contribution: { kind: "page" },
      setup() { /* 同上 */ },
    });
    let releaseRegister: (() => void) | undefined;
    const calls: string[] = [];
    const host = createPluginHost({
      runtimeUnitImplementationRegistry: createRuntimeUnitImplementationRegistry([{
        pluginId: plugin.manifest.id,
        unitId: plugin.descriptor.id,
        setup: plugin.setup,
        capabilities: plugin.capabilities,
      }]),
      contributionAdapters: [{
        name: "failing-adapter",
        async register() {
          await new Promise<void>((resolve) => { releaseRegister = resolve; });
          return {
            revoke: () => { calls.push("revoke"); },
            dispose: () => { calls.push("dispose"); return Promise.reject(new Error("adapter cleanup failed")); },
          };
        },
      }],
    });
    const pending = host.registerAll([plugin.manifest]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    host.revoke("slow-contribution-2", "test stop").catch(() => undefined);
    releaseRegister?.();
    // start 与 Host 生命周期都不因适配器清理失败而失败。
    await expect(pending.catch(() => undefined)).resolves.toBeUndefined();
    await host.dispose();
    expect(calls).toEqual(["revoke", "dispose"]);
  });

  it("迟到贡献是函数句柄时同样被立即回收", async () => {
    const plugin = definePlugin({
      id: "slow-contribution-3",
      contribution: { kind: "page" },
      setup() { /* 同上 */ },
    });
    let releaseRegister: (() => void) | undefined;
    const calls: string[] = [];
    const host = createPluginHost({
      runtimeUnitImplementationRegistry: createRuntimeUnitImplementationRegistry([{
        pluginId: plugin.manifest.id,
        unitId: plugin.descriptor.id,
        setup: plugin.setup,
        capabilities: plugin.capabilities,
      }]),
      contributionAdapters: [{
        name: "function-adapter",
        async register() {
          await new Promise<void>((resolve) => { releaseRegister = resolve; });
          return () => { calls.push("revoked"); };
        },
      }],
    });
    const pending = host.registerAll([plugin.manifest]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    host.revoke("slow-contribution-3", "test stop").catch(() => undefined);
    releaseRegister?.();
    await pending.catch(() => undefined);
    await host.dispose();
    expect(calls).toEqual(["revoked"]);
    expect(host.state("slow-contribution-3").kind).not.toBe("enabled");
  });

  it("资源 owner 撤权后定义注销，同名新实例不被旧清理误删", async () => {
    const build = () => definePlugin({
      id: "res-owner",
      dependencies: [{ capability: RESOURCE_REGISTRY }] as const,
      setup(ctx) {
        ctx.capability(RESOURCE_REGISTRY).register({
          id: "pcb.shared",
          scope: "plugin",
          invalidation: "immediate",
          key: () => ["pcb.shared"],
          load: async () => "value",
        });
      },
    });
    const host = hostFor(build());
    await host.registerAll([build().manifest]);
    expect(host.resourceRegistry.get("pcb.shared")).toBeDefined();

    await host.revoke("res-owner");
    // 实例撤销后它登记的定义不再留在全局注册表。
    expect(host.resourceRegistry.get("pcb.shared")).toBeUndefined();

    // 同名重启：新实例重新登记同名定义。
    await host.retry("res-owner");
    expect(host.resourceRegistry.get("pcb.shared")).toBeDefined();
    // 旧实例的 owner 条件注销不会误删新实例的同名定义。
    const registry = host.resourceRegistry as unknown as { _unregisterOwned?(owner: string, id: string): boolean };
    expect(registry._unregisterOwned?.call(host.resourceRegistry, "stale-instance-id", "pcb.shared")).toBe(false);
    expect(host.resourceRegistry.get("pcb.shared")).toBeDefined();
    await host.dispose();
  });

  it("资源 loader 不能借宿主 resolver 读取未声明能力；宿主资源走独立路径", async () => {
    const seen: string[] = [];
    const plugin = definePlugin({
      id: "escape-loader",
      // 只声明 RESOURCE_REGISTRY，不声明 Provider。
      dependencies: [{ capability: RESOURCE_REGISTRY }] as const,
      // 内置注册表是本 Runtime 的 local 能力，必须显式声明同 Runtime。
      runtime: "window-main" as const,
      setup(ctx) {
        ctx.capability(RESOURCE_REGISTRY).register({
          id: "pcb.escape",
          scope: "plugin",
          invalidation: "immediate",
          key: () => ["pcb.escape"],
          async load(_args, context) {
            // 未声明的能力必须拒绝，不能因为宿主提供了同名服务就通过。
            try {
              context.capability(Provider);
              return "leaked";
            } catch (error) {
              seen.push((error as Error).message);
              return "denied";
            }
          },
        });
      },
    });
    // 装配层确实提供了 Provider；插件实例的 loader 仍不得使用它。
    const host = createPluginHost({
      runtimeUnitImplementationRegistry: createRuntimeUnitImplementationRegistry([{
        pluginId: plugin.manifest.id,
        unitId: plugin.descriptor.id,
        setup: plugin.setup,
        capabilities: plugin.capabilities,
      }]),
      resourceCapabilityResolver: <C extends Capability>(capability: C) =>
        (capability.kind === "local" && capability.version === Provider.version
          ? ({ value: "host-value" } as unknown as CapabilityClient<C>)
          : undefined),
    });
    await host.registerAll([plugin.manifest]);
    // ensure 只启动加载；数据在随后的 microtask 解析完成后才发布。
    expect(host.resourceStore.ensure<string>("pcb.escape", []).status).toBe("pending");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(host.resourceStore.read<string>("pcb.escape", [])?.data).toBe("denied");
    expect(seen[0]).toMatch(/not declared by plugin/);

    // 宿主登记的资源可以正常使用装配层 resolver（可信装配路径）。
    host.resourceRegistry.register({
      id: "pcb.host-resource",
      scope: "host",
      invalidation: "immediate",
      key: () => ["pcb.host-resource"],
      async load(_args, context) { return context.capability(Provider).value; },
    });
    host.resourceStore.ensure<string>("pcb.host-resource", []);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(host.resourceStore.read<string>("pcb.host-resource", [])?.data).toBe("host-value");
    await host.dispose();
  });

  it("owner 撤销后资源读取直接失效，不降级为宿主资源", async () => {
    const plugin = definePlugin({
      id: "revoked-owner",
      dependencies: [{ capability: RESOURCE_REGISTRY }] as const,
      setup(ctx) {
        ctx.capability(RESOURCE_REGISTRY).register({
          id: "pcb.revoked",
          scope: "plugin",
          invalidation: "immediate",
          key: () => ["pcb.revoked"],
          load: async () => "value",
        });
      },
    });
    const host = hostFor(plugin);
    await host.registerAll([plugin.manifest]);
    // 先读一次建立缓存与订阅。
    host.resourceStore.ensure<string>("pcb.revoked", []);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(host.resourceStore.read<string>("pcb.revoked", [])?.data).toBe("value");
    await host.revoke("revoked-owner");
    // 定义已注销，读取返回 undefined 而不是回落到宿主解析路径。
    expect(host.resourceStore.read<string>("pcb.revoked", [])).toBeUndefined();
    await host.dispose();
  });

  it("同一能力的重复读取返回稳定引用；optional 与 required 共用同一代理", async () => {
    let consumer!: PluginConsumer;
    const plugin = definePlugin({
      id: "stable-reference",
      dependencies: [{ capability: Provider }] as const,
      // 本地能力必须显式声明同 Runtime，否则依赖图校验会拒绝。
      runtime: "window-main" as const,
      setup(ctx) { consumer = ctx.consumer; },
    });
    const host = createPluginHost({
      runtimeUnitImplementationRegistry: createRuntimeUnitImplementationRegistry([{
        pluginId: plugin.manifest.id,
        unitId: plugin.descriptor.id,
        setup: plugin.setup,
        capabilities: plugin.capabilities,
      }]),
      capabilities: [{ capability: Provider, value: { value: "v" } }],
    });
    await host.registerAll([plugin.manifest]);
    // 先 optional 再 required：两次必须拿到同一个引用，且 required 不抛错。
    const first = consumer.optionalCapability(Provider);
    const second = consumer.capability(Provider);
    expect(first).toBe(second);
    expect(consumer.capability(Provider)).toBe(second);
    expect(consumer.optionalCapability(Provider)).toBe(second);
    await host.dispose();
  });

  it("optional 已声明但缺席时返回 undefined，不抛出内部错误", async () => {
    let consumer!: PluginConsumer;
    const plugin = definePlugin({
      id: "late-optional",
      // 声明为可选依赖：目录里没有该能力时插件仍能启动。
      dependencies: [{ capability: Optional, optional: true }] as const,
      runtime: "window-main" as const,
      setup(ctx) { consumer = ctx.consumer; },
    });
    const host = createPluginHost({
      runtimeUnitImplementationRegistry: createRuntimeUnitImplementationRegistry([{
        pluginId: plugin.manifest.id,
        unitId: plugin.descriptor.id,
        setup: plugin.setup,
        capabilities: plugin.capabilities,
      }]),
    });
    await host.registerAll([plugin.manifest]);
    // 已声明但目录里没有：不抛错，返回 undefined；重复读取同样安全。
    expect(consumer.optionalCapability(Optional)).toBeUndefined();
    expect(consumer.optionalCapability(Optional)).toBeUndefined();
    // required 读取仍然必须抛错（缺席 ≠ 可选）。
    expect(() => consumer.capability(Optional)).toThrow();
    await host.dispose();
  });

  it("保留的远程 client 在 consumer 撤权后调用失败，不退回根 scope", async () => {
    // 远程能力声明 request/response 契约；客户端是 call/request 形态。
    const Remote = defineCapability<{ ping: string }, { pong: string }>({
      kind: "rpc",
      id: "pcb.remote.ping",
      version: "1",
      request: { parse: (value) => value as { ping: string } },
      response: { parse: (value) => value as { pong: string } },
    });
    const Stream = defineCapability<{ watch: boolean }, { tick: number }>({
      kind: "stream",
      id: "pcb.remote.watch",
      version: "1",
      request: { parse: (value) => value as { watch: boolean } },
      item: { parse: (value) => value as { tick: number } },
    });
    let consumer!: PluginConsumer;
    const clientPlugin = definePlugin({
      id: "remote-consumer",
      dependencies: [
        { capability: Remote, sourceRuntime: "window-main" as const },
        { capability: Stream, sourceRuntime: "window-main" as const },
      ] as const,
      setup(ctx) { consumer = ctx.consumer; },
    });
    const providerPlugin = definePlugin({
      id: "remote-provider",
      provides: [Remote, Stream] as const,
      setup(ctx) {
        ctx.handle(Remote, async () => ({ pong: "ok" }));
        ctx.handle(Stream, () => ({
          async *[Symbol.asyncIterator]() {
            yield { tick: 1 };
          },
        }));
      },
    });
    const host = createPluginHost({
      runtime: "window-main",
      runtimeUnitImplementationRegistry: createRuntimeUnitImplementationRegistry([
        {
          pluginId: clientPlugin.manifest.id,
          unitId: clientPlugin.descriptor.id,
          setup: clientPlugin.setup,
          capabilities: clientPlugin.capabilities,
        },
        {
          pluginId: providerPlugin.manifest.id,
          unitId: providerPlugin.descriptor.id,
          setup: providerPlugin.setup,
          capabilities: providerPlugin.capabilities,
        },
      ]),
    });
    await host.registerAll([providerPlugin.manifest, clientPlugin.manifest]);

    // 先取得并保留远程句柄（含一个 stream 订阅句柄）。
    const remote = consumer.capability(Remote);
    expect(await remote.call({ ping: "x" })).toEqual({ pong: "ok" });
    const stream = consumer.capability(Stream);
    const subscription = stream.subscribe({ watch: true }, { onNext: () => undefined });

    await host.revoke("remote-consumer");
    // 入口撤销：新的解析被拒绝。
    expect(() => consumer.capability(Remote)).toThrow();
    // 远程调用撤销：已取得的句柄本身也必须失败，而不是靠根 scope 继续跑。
    // 注意：RPC client.call 在 scope 撤销时可能同步抛出，因此两种形式都接受。
    await expect(Promise.resolve().then(() => remote.call({ ping: "x" }))).rejects.toThrow();
    // stream 句柄同样在撤权后立即拒绝，不再从提供方继续推送。
    expect(() => stream.subscribe({ watch: true }, { onNext: () => undefined })).toThrow();
    // 已建立的订阅：关闭 promise 必须以失败结束，而不是继续推送。
    await expect(subscription.closed).rejects.toThrow();
    await host.dispose();
  });

  it("资源 key/load/subscribe 每个阶段都校验 owner；撤权后不再执行任何阶段", async () => {
    const calls: string[] = [];
    const plugin = definePlugin({
      id: "stage-owner",
      dependencies: [
        { capability: RESOURCE_REGISTRY },
        { capability: Provider },
      ] as const,
      runtime: "window-main" as const,
      setup(ctx) {
        ctx.capability(RESOURCE_REGISTRY).register({
          id: "pcb.staged",
          scope: "plugin",
          invalidation: "immediate",
          key: (_args, context) => { calls.push("key"); return [context.capability(Provider).value]; },
          subscribe: (_args, context, invalidate) => {
            calls.push("subscribe");
            void context.capability(Provider);
            invalidate();
            return () => { calls.push("unsubscribe"); };
          },
          load: async (_args, context) => { calls.push("load"); return context.capability(Provider).value; },
        });
      },
    });
    const host = createPluginHost({
      runtime: "window-main",
      runtimeUnitImplementationRegistry: createRuntimeUnitImplementationRegistry([{
        pluginId: plugin.manifest.id,
        unitId: plugin.descriptor.id,
        setup: plugin.setup,
        capabilities: plugin.capabilities,
      }]),
      capabilities: [{ capability: Provider, value: { value: "v" } }],
    });
    await host.registerAll([plugin.manifest]);
    const stop = host.resourceStore.subscribe("pcb.staged", [], () => undefined);
    host.resourceStore.ensure<string>("pcb.staged", []);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // 三个阶段都在 owner 有效时执行过。
    expect(calls).toContain("key");
    expect(calls).toContain("subscribe");
    expect(calls).toContain("load");

    await host.revoke("stage-owner");
    // 撤权清理会释放该 owner 的订阅。
    expect(calls).toContain("unsubscribe");
    const afterRevoke = calls.length;
    // 撤权后再触发读取：不允许继续执行 key/load/subscribe 任何阶段，
    // 也不允许把插件资源降级成宿主资源继续解析。
    expect(() => host.resourceStore.ensure<string>("pcb.staged", [])).toThrow();
    expect(host.resourceStore.read<string>("pcb.staged", [])).toBeUndefined();
    expect(calls.length).toBe(afterRevoke);
    stop();
    await host.dispose();
  });

  it("自定义注册表不支持 owner 绑定时拒绝登记，而不是退化成 unowned", async () => {
    // 故意只实现公开 ResourceRegistry 接口（没有 _registerOwned）。
    const definitions = new Map<string, ResourceDefinition<unknown, readonly string[]>>();
    const customRegistry = {
      register: (definition: ResourceDefinition<unknown, readonly string[]>) => { definitions.set(definition.id, definition); },
      unregister: (id: string) => { definitions.delete(id); },
      get: <T, TArgs extends readonly string[]>(id: string) => definitions.get(id) as ResourceDefinition<T, TArgs> | undefined,
      _ids: () => [...definitions.keys()],
    };
    let error: unknown;
    const plugin = definePlugin({
      id: "no-owner-support",
      dependencies: [{ capability: RESOURCE_REGISTRY }] as const,
      runtime: "window-main" as const,
      setup(ctx) {
        try {
          ctx.capability(RESOURCE_REGISTRY).register({
            id: "pcb.no-owner",
            scope: "plugin",
            invalidation: "immediate",
            key: () => ["pcb.no-owner"],
            load: async () => "value",
          });
        } catch (caught) { error = caught; }
      },
    });
    const host = createPluginHost({
      runtime: "window-main",
      resourceRegistry: customRegistry,
      runtimeUnitImplementationRegistry: createRuntimeUnitImplementationRegistry([{
        pluginId: plugin.manifest.id,
        unitId: plugin.descriptor.id,
        setup: plugin.setup,
        capabilities: plugin.capabilities,
      }]),
    });
    await host.registerAll([plugin.manifest]);
    expect((error as Error | undefined)?.message).toMatch(/owner-bound registration/);
    // 关键：绝不能落成宿主 unowned 资源。
    expect(definitions.has("pcb.no-owner")).toBe(false);
    await host.dispose();
  });

  it("宿主 unowned 资源走装配层 resolver 时按 typed 契约匹配 kind/version", async () => {
    const asked: string[] = [];
    const plugin = definePlugin({
      id: "host-owned-resource",
      dependencies: [{ capability: RESOURCE_REGISTRY }, { capability: Provider }] as const,
      runtime: "window-main" as const,
      setup(ctx) {
        ctx.capability(RESOURCE_REGISTRY).register({
          id: "pcb.owned",
          scope: "plugin",
          invalidation: "immediate",
          key: () => ["pcb.owned"],
          load: async () => "from-plugin",
        });
      },
    });
    const host = createPluginHost({
      runtime: "window-main",
      runtimeUnitImplementationRegistry: createRuntimeUnitImplementationRegistry([{
        pluginId: plugin.manifest.id,
        unitId: plugin.descriptor.id,
        setup: plugin.setup,
        capabilities: plugin.capabilities,
      }]),
      capabilities: [{ capability: Provider, value: { value: "host-value" } }],
    });
    await host.registerAll([plugin.manifest]);
    host.resourceStore.ensure<string>("pcb.owned", []);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // 插件资源按自身 owner 解析，不会因为宿主也有同名能力就借用宿主值。
    expect(host.resourceStore.read<string>("pcb.owned", [])?.data).toBe("from-plugin");
    expect(asked).toEqual([]);
    await host.dispose();
  });

  it("跨插件资源读取经提供方导出的 typed 接口封装，消费方只声明该能力", async () => {
    // 提供方把全局 store 封装成一个窄能力：只有 read/subscribe，没有
    // invalidate、注册表或 owner 查询。这是本轮推荐的跨插件资源读取方式：
    // 消费者声明依赖即可，不需要框架新增资源授权协议或按 id 前缀自动授权。
    const ContactDirectory = defineCapability<{
      read(key: readonly string[]): Promise<string | undefined>;
      subscribe(key: readonly string[], onChange: () => void): () => void;
    }>({ kind: "local", id: "pcb.contactDirectory", version: "1" });

    let store: PluginHost["resourceStore"] | undefined;
    let consumer!: PluginConsumer;
    const providerPlugin = definePlugin({
      id: "directory-provider",
      provides: [ContactDirectory] as const,
      dependencies: [{ capability: RESOURCE_REGISTRY }] as const,
      setup(ctx) {
        ctx.capability(RESOURCE_REGISTRY).register({
          id: "pcb.contact",
          scope: "plugin",
          invalidation: "immediate",
          key: (args) => ["pcb.contact", ...args],
          load: async (args) => `contact:${args.join(",")}`,
        });
        ctx.provide(ContactDirectory, {
          async read(key) {
            store!.ensure<string>("pcb.contact", key);
            for (let attempt = 0; attempt < 10; attempt += 1) {
              const snapshot = store!.read<string>("pcb.contact", key);
              if (snapshot?.status === "ready") return snapshot.data;
              await new Promise((resolve) => setTimeout(resolve, 0));
            }
            return undefined;
          },
          subscribe(key, onChange) { return store!.subscribe("pcb.contact", key, onChange); },
        });
      },
    });
    const readerPlugin = definePlugin({
      id: "directory-reader",
      dependencies: [{ capability: ContactDirectory }] as const,
      setup(ctx) { consumer = ctx.consumer; },
    });
    const host = hostFor(providerPlugin, readerPlugin);
    // 可信装配层持有 store；插件只拿到上面那个窄 facade。
    store = host.resourceStore;
    await host.registerAll([providerPlugin.manifest, readerPlugin.manifest]);

    const directory = consumer.capability(ContactDirectory);
    expect(Object.keys(directory).sort()).toEqual(["read", "subscribe"]);
    const changes: number[] = [];
    const stop = directory.subscribe(["a"], () => { changes.push(changes.length); });
    expect(await directory.read(["a"])).toBe("contact:a");
    store!.invalidate("pcb.contact", ["a"]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(changes.length).toBeGreaterThan(0);
    stop();

    // 消费方不能借这条路径拿到底层 store：invalidate/注册表都不在能力面上。
    expect((directory as unknown as Record<string, unknown>).invalidate).toBeUndefined();
    // 未声明其它能力的插件依旧读不到目录。
    expect(() => consumer.capability(Undeclared)).toThrow(/not declared by plugin/);

    // 提供方停用后：消费者的旧视图与保留句柄一起失效。
    await host.revoke("directory-provider");
    expect(() => consumer.capability(ContactDirectory)).toThrow(/no longer active/);
    await host.dispose();
  });

  it("等价重新定义的资源注册表契约同样被包装，拿不到裸注册表", async () => {
    // 插件可以自己 defineCapability 出同一个 kind/id/version 的等价契约。
    // 实例包装必须按契约身份判断；用对象引用比较会让它拿到共享的裸注册表，
    // 于是 owner 变成 unowned、跨实例注销限制与撤销清理全部失效。
    const EquivalentRegistry = defineCapability<ResourceRegistry>({
      kind: "local",
      id: RESOURCE_REGISTRY.id,
      version: RESOURCE_REGISTRY.version,
    });
    let view!: ResourceRegistry;
    const plugin = definePlugin({
      id: "equivalent-registry",
      dependencies: [{ capability: EquivalentRegistry }] as const,
      setup(ctx) {
        view = ctx.capability(EquivalentRegistry);
        view.register({
          id: "pcb.equivalent",
          scope: "plugin",
          invalidation: "immediate",
          key: () => ["pcb.equivalent"],
          load: async () => "value",
        });
      },
    });
    const host = hostFor(plugin);
    await host.registerAll([plugin.manifest]);
    // 不是共享的裸注册表：注册项绑定的是本实例 owner。
    const ownerOf = host.resourceRegistry as unknown as { _ownerOf(id: string): string | undefined };
    expect(ownerOf._ownerOf("pcb.equivalent")).toBeTruthy();
    expect(ownerOf._ownerOf("pcb.equivalent")).not.toBe(UNOWNED_RESOURCE_OWNER);
    // 等价契约视图同样拒绝跨实例注销，且不能冒充别的 owner。
    expect(view._ids()).toContain("pcb.equivalent");
    // 实例撤销后定义被注销，不会像裸注册表那样留在全局表里。
    await host.revoke("equivalent-registry");
    expect(host.resourceRegistry.get("pcb.equivalent")).toBeUndefined();
    await host.dispose();
  });

  it("consumer 每次解析都核对提供方可用性：停用即失败，重启取新一代", async () => {
    let consumer!: PluginConsumer;
    let generation = 0;
    const reader = definePlugin({
      id: "availability-reader",
      dependencies: [{ capability: Provider, optional: true }] as const,
      setup(ctx) { consumer = ctx.consumer; },
    });
    const buildProvider = () => definePlugin({
      id: "availability-provider",
      provides: [Provider] as const,
      setup(ctx) {
        generation += 1;
        ctx.provide(Provider, { value: `v${generation}` });
      },
    });
    const provider = buildProvider();
    const host = hostFor(provider, reader);
    await host.registerAll([provider.manifest, reader.manifest]);
    const first = consumer.capability(Provider);
    expect(first.value).toBe("v1");
    // 期间可用性不变时引用保持稳定（React 快照需要）。
    expect(consumer.capability(Provider)).toBe(first);

    // 停用提供方：缓存不能让 consumer 继续返回第一代服务。
    await host.revoke("availability-provider");
    expect(() => consumer.capability(Provider)).toThrow(/not available/);
    expect(consumer.optionalCapability(Provider)).toBeUndefined();

    // 重启提供方：必须拿到第二代服务，而不是继续用旧引用。
    await host.retry("availability-provider");
    const second = consumer.capability(Provider);
    expect(second.value).toBe("v2");
    expect(second).not.toBe(first);
    expect(consumer.capability(Provider)).toBe(second);
    await host.dispose();
  });

  it("撤权后旧 setup ctx 不能再取能力", async () => {
    let context!: PluginContext;
    const plugin = definePlugin({
      id: "stale-ctx",
      dependencies: [{ capability: Provider }] as const,
      setup(ctx) { context = ctx; },
    });
    const providerPlugin = definePlugin({
      id: "availability-provider-2",
      provides: [Provider] as const,
      setup(ctx) { ctx.provide(Provider, { value: "v1" }); },
    });
    const host = hostFor(providerPlugin, plugin);
    await host.registerAll([providerPlugin.manifest, plugin.manifest]);
    expect(context.capability(Provider).value).toBe("v1");

    await host.revoke("stale-ctx");
    // 实例有效性是共享 resolver 的第一条约束，因此旧 ctx 与 consumer 同样失败。
    expect(() => context.capability(Provider)).toThrow(/no longer active/);
    expect(() => context.optionalCapability(Provider)).toThrow(/no longer active/);
    expect(() => context.consumer.capability(Provider)).toThrow(/no longer active/);
    await host.dispose();
  });

  it("资源上下文按 optional 解析：已声明但缺席返回 undefined，不把资源推进 error", async () => {
    const seen: (string | undefined)[] = [];
    // 提供方先存在实现注册表里，但初始不注册/不启动，用于验证“缺席 → 出现”。
    const providerPlugin = definePlugin({
      id: "optional-provider",
      provides: [Optional] as const,
      setup(ctx) { ctx.provide(Optional, { value: "present" }); },
    });
    const plugin = definePlugin({
      id: "optional-resource",
      dependencies: [{ capability: RESOURCE_REGISTRY }, { capability: Optional, optional: true }] as const,
      setup(ctx) {
        ctx.capability(RESOURCE_REGISTRY).register({
          id: "pcb.optional-resource",
          scope: "plugin",
          invalidation: "immediate",
          key: () => ["pcb.optional-resource"],
          load: async (_args, context) => {
            const optional = context.optionalCapability(Optional);
            seen.push(optional?.value);
            // 未声明能力仍然拒绝：optional 不能变成绕过声明检查的出口。
            let undeclared = false;
            try { context.capability(Undeclared); } catch { undeclared = true; }
            return { optional: optional?.value ?? null, undeclared };
          },
        });
      },
    });
    // 必需读取仍然抛错：optional 不能反过来放宽 required 语义。
    const strictPlugin = definePlugin({
      id: "strict-resource",
      dependencies: [{ capability: RESOURCE_REGISTRY }] as const,
      setup(ctx) {
        ctx.capability(RESOURCE_REGISTRY).register({
          id: "pcb.strict-resource",
          scope: "plugin",
          invalidation: "immediate",
          key: () => ["pcb.strict-resource"],
          // 没有声明 Optional：loader 读取它必须被拒绝。
          load: async (_args, context) => String(context.capability(Optional).value),
        });
      },
    });
    const host = hostFor(plugin, providerPlugin, strictPlugin);
    await host.registerAll([plugin.manifest]);
    host.resourceStore.ensure<{ optional: string | null; undeclared: boolean }>("pcb.optional-resource", []);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const snapshot = host.resourceStore.read<{ optional: string | null; undeclared: boolean }>("pcb.optional-resource", []);
    // 已声明但缺席：optional 返回 undefined，资源本身加载成功而不是 error。
    expect(snapshot?.status).toBe("ready");
    expect(snapshot?.error).toBeUndefined();
    expect(snapshot?.data).toEqual({ optional: null, undeclared: true });
    expect(seen).toEqual([undefined]);

    host.register(strictPlugin.manifest);
    await host.retry("strict-resource");
    host.resourceStore.ensure("pcb.strict-resource", []);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(host.resourceStore.read("pcb.strict-resource", [])?.status).toBe("error");

    // 提供方出现后，同一个资源上下文重新解析到第二代服务。
    host.register(providerPlugin.manifest);
    await host.retry("optional-provider");
    host.resourceStore.invalidate("pcb.optional-resource", []);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(host.resourceStore.read<{ optional: string | null }>("pcb.optional-resource", [])?.data?.optional).toBe("present");
    expect(seen).toEqual([undefined, "present"]);
    await host.dispose();
  });
  it("资源定义查询按实例收口：别的插件取不到私有 loader，也列不出来", async () => {
    // 私有实现正例：loader 闭包捕获了提供方的私有对象。它只能通过本实例的
    // 资源视图执行，不能被另一个只声明了 RESOURCE_REGISTRY 的插件取得。
    const privateState = { secret: "owner-only" };
    const views = new Map<string, ResourceRegistry>();
    const owner = definePlugin({
      id: "definition-owner",
      dependencies: [{ capability: RESOURCE_REGISTRY }] as const,
      setup(ctx) {
        ctx.capability(RESOURCE_REGISTRY).register({
          id: "pcb.private-definition",
          scope: "plugin",
          invalidation: "immediate",
          key: () => ["pcb.private-definition"],
          load: async () => privateState.secret,
        });
        views.set("owner", ctx.capability(RESOURCE_REGISTRY));
      },
    });
    const observer = definePlugin({
      id: "definition-observer",
      dependencies: [{ capability: RESOURCE_REGISTRY }] as const,
      setup(ctx) { views.set("observer", ctx.capability(RESOURCE_REGISTRY)); },
    });
    const host = hostFor(owner, observer);
    await host.registerAll([owner.manifest, observer.manifest]);

    const ownerView = views.get("owner")!;
    const observerView = views.get("observer")!;
    // 本实例照常可读、可列举。
    expect(ownerView.get("pcb.private-definition")).toBeDefined();
    expect(ownerView._ids()).toEqual(["pcb.private-definition"]);
    // 另一个实例既取不到定义，也列不出 id。
    expect(observerView.get("pcb.private-definition")).toBeUndefined();
    expect(observerView._ids()).toEqual([]);
    // 可信 Host 视图不受影响：装配层执行与清理仍然使用完整注册表。
    expect(host.resourceRegistry.get("pcb.private-definition")).toBeDefined();

    // 撤销后查询也拒绝：实例视图先失效，再撤定义。
    await host.revoke("definition-owner", "domain condition");
    expect(() => ownerView.get("pcb.private-definition")).toThrow(/no longer active/);
    expect(() => ownerView._ids()).toThrow(/no longer active/);
    await host.dispose();
  });

  it("插件上下文不暴露全局 ResourceStore，无法绕过注册表边界", async () => {
    let context!: PluginContext;
    const plugin = definePlugin({ id: "store-boundary", setup(ctx) { context = ctx; } });
    const host = hostFor(plugin);
    await host.registerAll([plugin.manifest]);
    // 资源 store 只在装配层；插件既拿不到 store，也拿不到裸注册表。
    for (const forbidden of ["resourceStore", "resourceRegistry", "host", "app"]) {
      expect((context as unknown as Record<string, unknown>)[forbidden]).toBeUndefined();
    }
    // 只有声明了内置注册表能力才能拿到实例视图。
    const Registry = defineCapability<ResourceRegistry>({ kind: "local", id: RESOURCE_REGISTRY.id, version: RESOURCE_REGISTRY.version });
    expect(() => context.capability(Registry)).toThrow(/not declared by plugin/);
    await host.dispose();
  });
});
