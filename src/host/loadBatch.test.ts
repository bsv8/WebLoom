// 加载批次结束事件：固定名单、全部收敛才发、每批一次、异步交付。
import { describe, expect, it } from "vitest";
import { defineCapability } from "../contracts/capability.js";
import { definePlugin } from "../authoring/definePlugin.js";
import { createPluginHost } from "./createPluginHost.js";
import { createRuntimeUnitImplementationRegistry } from "./runtimeUnitImplementationRegistry.js";
import type { PluginLoadSettledDetail } from "../contracts/plugin.js";

const Svc = defineCapability<{ name: string }>({ kind: "local", id: "batch.svc", version: "1" });
const Missing = defineCapability<{ name: string }>({ kind: "local", id: "batch.missing", version: "1" });

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

const flush = () => new Promise<void>(resolve => { setTimeout(resolve, 0); });

describe("onPluginLoadSettled", () => {
  it("固定名单全部收敛后发一次：成功、失败和阻塞都算结束", async () => {
    const ok = definePlugin({ id: "ok", provides: [Svc] as const, setup(ctx) { ctx.provide(Svc, { name: "ok" }); } });
    const fail = definePlugin({ id: "fail", setup() { throw new Error("boom"); } });
    const blocked = definePlugin({ id: "blocked", dependencies: [{ capability: Missing }] as const, setup() {} });
    const host = hostFor(ok, fail, blocked);
    await host.registerAll([ok.manifest, fail.manifest, blocked.manifest]);
    expect(host.state("ok").kind).toBe("enabled");
    expect(host.state("fail").kind).toBe("failed");
    expect(host.state("blocked").kind).toBe("blocked");
    const seen: PluginLoadSettledDetail[] = [];
    host.messageBus.subscribe<PluginLoadSettledDetail>("webloom.plugin-load.settled", detail => { seen.push(detail); });
    const batchId = host.startLoadBatch(["ok", "fail", "blocked", "unknown-plugin"]);
    // 异步交付：返回时尚未发出，调用方已拿到批次标识。
    expect(seen).toHaveLength(0);
    await flush();
    expect(seen).toHaveLength(1);
    const detail = seen[0]!;
    expect(detail.batchId).toBe(batchId);
    expect(typeof detail.runtimeInstanceId).toBe("string");
    expect(detail.results).toEqual([
      expect.objectContaining({ pluginId: "ok", outcome: "success" }),
      expect.objectContaining({ pluginId: "fail", outcome: "load-failure" }),
      expect.objectContaining({ pluginId: "blocked", outcome: "blocked" }),
      expect.objectContaining({ pluginId: "unknown-plugin", outcome: "blocked" }),
    ]);
    // 重复 reconcile 不创建新批次、不重发。
    await host.reconcile();
    await flush();
    expect(seen).toHaveLength(1);
    await host.dispose();
  });

  it("等待中的单元完成后才结算", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const slow = definePlugin({
      id: "slow", provides: [Svc] as const,
      setup: async (ctx): Promise<void> => { await gate; ctx.provide(Svc, { name: "slow" }); },
    });
    const host = hostFor(slow);
    const register = host.register(slow.manifest);
    const batchId = host.startLoadBatch(["slow"]);
    const seen: PluginLoadSettledDetail[] = [];
    host.messageBus.subscribe<PluginLoadSettledDetail>("webloom.plugin-load.settled", detail => { seen.push(detail); });
    await flush();
    // 启动中：尚未结算。
    expect(seen).toHaveLength(0);
    release();
    await register;
    await host.reconcile();
    await flush();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ batchId });
    await host.dispose();
  });
});
