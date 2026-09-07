import { describe, expect, it, vi } from "vitest";
import { createLifecycleScope } from "./resourceScope.js";
import { createScopedTaskScheduler } from "./taskScheduler.js";

describe("scoped task scheduler", () => {
  it("coalesces a running task and releases it with its scope", async () => {
    const scope = createLifecycleScope({ kind: "plugin-instance", metadata: { pluginId: "background" } });
    const scheduler = createScopedTaskScheduler(scope);
    let releaseRun!: () => void;
    const run = vi.fn(({ signal }: { signal: AbortSignal }) => new Promise<void>((resolve) => {
      releaseRun = resolve;
      signal.addEventListener("abort", () => resolve(), { once: true });
    }));
    const unregister = scheduler.register({ id: "asset.sync", pluginId: "assets", label: "同步资产", run });

    const first = scheduler.runNow("asset.sync");
    await Promise.resolve();
    expect(scheduler.snapshot()[0]).toMatchObject({ id: "asset.sync", state: "running" });
    const second = scheduler.runNow("asset.sync", "duplicate");
    expect(run).toHaveBeenCalledTimes(1);
    releaseRun();
    await first;
    await second;
    // 第二次触发会在当前运行结束后合并为一次 coalesced 运行；取消它
    // 才能验证该任务的实例确实能被安全收尾。
    await Promise.resolve();
    await scheduler.cancel("asset.sync");
    expect(scheduler.snapshot()[0]?.state).toBe("idle");

    unregister();
    expect(scheduler.snapshot()).toEqual([]);
    await scheduler.dispose();
    await scope.dispose();
  });

  it("swallows the request-scope race after synchronous revoke", async () => {
    const scope = createLifecycleScope({ kind: "plugin-instance", metadata: { pluginId: "race" } });
    const scheduler = createScopedTaskScheduler(scope);
    const originalChild = scope.child.bind(scope);
    const child = vi.spyOn(scope, "child").mockImplementation((kind, metadata) => {
      scope.revoke("test revoke before request scope");
      return originalChild(kind, metadata);
    });

    scheduler.register({
      id: "race.task",
      label: "竞态任务",
      run: vi.fn(),
    });
    await expect(scheduler.runNow("race.task")).resolves.toBeUndefined();
    expect(scope.state).toBe("stopping");
    expect(scheduler.snapshot()[0]).toMatchObject({ state: "failed" });

    child.mockRestore();
    await scheduler.dispose();
    await scope.dispose();
  });
});
