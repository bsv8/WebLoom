import { describe, expect, it } from "vitest";
import { defineCapability } from "../contracts/capability.js";
import { definePlugin } from "../authoring/definePlugin.js";
import { createPluginHost } from "./createPluginHost.js";
import { createRuntimeUnitImplementationRegistry } from "./runtimeUnitImplementationRegistry.js";

const requestParser = { parse(value: unknown): { value: string } {
  if (!value || typeof value !== "object" || typeof (value as { value?: unknown }).value !== "string") throw new Error("value must be a string");
  return value as { value: string };
} };
const responseParser = { parse(value: unknown): { result: string } {
  if (!value || typeof value !== "object" || typeof (value as { result?: unknown }).result !== "string") throw new Error("result must be a string");
  return value as { result: string };
} };

const LocalValue = defineCapability<{ count: number }>({ kind: "local", id: "test.local", version: "1" });
const Echo = defineCapability({ kind: "rpc", id: "test.echo", version: "1", request: requestParser, response: responseParser });

describe("v4 PluginHost", () => {
  it("runs typed local and RPC capabilities through declared plugin setup", async () => {
    const seen: string[] = [];
    const provider = definePlugin({
      id: "provider",
      provides: [LocalValue, Echo] as const,
      setup(ctx) {
        ctx.provide(LocalValue, { count: 7 });
        ctx.handle(Echo, async (request, call) => {
          seen.push(`${call.origin}:${call.reference.capabilityId}`);
          return { result: `${request.value}:${ctx.instanceId.length > 0}` };
        });
      },
    });
    const implementations = createRuntimeUnitImplementationRegistry([{
      pluginId: provider.manifest.id,
      unitId: provider.descriptor.id,
      setup: provider.setup,
      capabilities: provider.capabilities,
    }]);
    const host = createPluginHost({ runtimeUnitImplementationRegistry: implementations });
    await host.registerAll([provider.manifest]);

    expect(host.capability(LocalValue)).toEqual({ count: 7 });
    await expect(host.capability(Echo).call({ value: "ok" })).resolves.toEqual({ result: "ok:true" });
    expect(seen).toEqual(["local:test.echo"]);
    expect(host.serviceReferences()).toHaveLength(1);
    await host.dispose();
  });

  it("拒绝未声明的 capability 注册，并把失败原因留在状态与诊断里", async () => {
    const Other = defineCapability<{ value: number }>({ kind: "local", id: "test.other", version: "1" });
    const bad = definePlugin({
      id: "bad-provider",
      provides: [LocalValue] as const,
      setup(ctx) {
        // @ts-expect-error A plugin may only register a declared local capability.
        ctx.provide(Other, { value: 1 });
      },
    });
    const implementations = createRuntimeUnitImplementationRegistry([{
      pluginId: bad.manifest.id,
      unitId: bad.descriptor.id,
      setup: bad.setup,
      capabilities: bad.capabilities,
    }]);
    const host = createPluginHost({ runtimeUnitImplementationRegistry: implementations });
    await host.registerAll([bad.manifest]);
    // 装配不再整体失败：插件进入 failed 并保留脱敏原因，服务目录不含未注册能力。
    expect(host.state("bad-provider").kind).toBe("failed");
    expect(host.state("bad-provider").lifecycleState).toBe("failed");
    expect(host.explain("bad-provider").reasons.length).toBeGreaterThan(0);
    expect(host.serviceReferences()).toEqual([]);
    await host.dispose();
  });

  it("没有启停策略字段：manifest 只保留身份、依赖与运行单元", () => {
    const plugin = definePlugin({ id: "policy-free", setup() {} });
    expect(Object.keys(plugin.manifest).sort()).toEqual(["id", "name", "units"]);
  });

  it("必需依赖缺失时保持 blocked 并给出可诊断原因", async () => {
    const Missing = defineCapability({ kind: "rpc", id: "test.missing", version: "1", request: requestParser, response: responseParser });
    const required = definePlugin({
      id: "required-consumer",
      dependencies: [{ capability: Missing, sourceRuntime: "window-main" }] as const,
      setup() {},
    });
    const implementations = createRuntimeUnitImplementationRegistry([{
      pluginId: required.manifest.id,
      unitId: required.descriptor.id,
      setup: required.setup,
      capabilities: required.capabilities,
    }]);
    const host = createPluginHost({ runtimeUnitImplementationRegistry: implementations });
    await host.registerAll([required.manifest]);
    expect(host.state("required-consumer")).toMatchObject({ kind: "blocked", lifecycleState: "waiting" });
    expect(host.state("required-consumer").blockedBy).toEqual(["missing:rpc:test.missing@1"]);
    expect(host.explain("required-consumer").reasons).toEqual(["missing:rpc:test.missing@1"]);
    await host.dispose();
  });

  it("释放实例后不自动重建，retry 后得到全新实例", async () => {
    const plugin = definePlugin({
      id: "reversible",
      provides: [LocalValue] as const,
      setup(ctx) {
        ctx.provide(LocalValue, { count: 11 });
      },
    });
    const implementations = createRuntimeUnitImplementationRegistry([{
      pluginId: plugin.manifest.id,
      unitId: plugin.descriptor.id,
      setup: plugin.setup,
      capabilities: plugin.capabilities,
    }]);
    const host = createPluginHost({ runtimeUnitImplementationRegistry: implementations });
    await host.registerAll([plugin.manifest]);
    const firstInstance = host.state("reversible").instanceId;

    // 可信装配层的生命周期事件：释放实例并记录运行条件，不写入任何用户意图。
    await host.revoke("reversible", "domain condition");
    expect(host.state("reversible")).toMatchObject({ kind: "blocked", lifecycleState: "waiting" });
    expect(host.state("reversible").blockedBy).toEqual(["revoked:domain condition"]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    // 运行条件未解除前不自动重建。
    expect(host.state("reversible").kind).toBe("blocked");

    await host.retry("reversible");
    expect(host.state("reversible")).toMatchObject({ kind: "enabled", lifecycleState: "running" });
    expect(host.state("reversible").blockedBy).toBeUndefined();
    expect(host.state("reversible").instanceId).not.toBe(firstInstance);
    expect(host.capability(LocalValue)).toEqual({ count: 11 });
    await host.dispose();
  });
});
