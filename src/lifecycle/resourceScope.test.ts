import { describe, expect, it, vi } from "vitest";
import { LifecycleScopeRevokedError } from "../contracts/lifecycle.js";
import { createLifecycleScope } from "./resourceScope.js";

describe("lifecycle scope", () => {
  it("revokes synchronously and releases resources registered before stop", async () => {
    const release = vi.fn();
    const scope = createLifecycleScope({ kind: "plugin-instance", instanceId: "instance:a" });
    scope.track({ id: "resource" }, release, "resource:a");

    scope.revoke("provider stopped");
    expect(scope.state).toBe("stopping");
    expect(scope.signal.aborted).toBe(true);
    expect(() => scope.track({}, vi.fn(), "late")).toThrow(LifecycleScopeRevokedError);

    const result = await scope.dispose();
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith({ id: "resource" }, "provider stopped");
    expect(result).toMatchObject({ state: "stopped", attempted: 1, released: 1, cleanupIncomplete: false });
    expect(await scope.dispose()).toBe(result);
  });

  it("releases an async resource that completes after revoke instead of publishing it", async () => {
    let resolveResource!: (value: { id: string }) => void;
    const release = vi.fn().mockResolvedValue(undefined);
    const scope = createLifecycleScope({ kind: "request" });
    const acquired = scope.acquire(
      "late-resource",
      () => new Promise<{ id: string }>((resolve) => { resolveResource = resolve; }),
      release
    );

    scope.revoke("owner changed");
    await scope.dispose({ timeoutMs: 10 });
    resolveResource({ id: "late" });

    await expect(acquired).rejects.toBeInstanceOf(LifecycleScopeRevokedError);
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith({ id: "late" }, "owner changed");
  });

  it("runs a disposer registered after revoke and exposes late release failure", async () => {
    const lateDispose = vi.fn();
    const scope = createLifecycleScope({ kind: "request" });
    scope.revoke("request canceled");
    scope.onDispose(lateDispose, "late-disposer");
    await Promise.resolve();
    expect(lateDispose).toHaveBeenCalledWith("request canceled");

    let resolveResource!: (value: string) => void;
    const lateScope = createLifecycleScope({ kind: "request" });
    const acquired = lateScope.acquire(
      "late-failing-resource",
      () => new Promise<string>((resolve) => { resolveResource = resolve; }),
      () => { throw new Error("late release failed"); }
    );
    await Promise.resolve();
    lateScope.revoke("request canceled");
    const cleanup = lateScope.dispose({ timeoutMs: 10 });
    const cleanupResult = await cleanup;
    expect(cleanupResult).toMatchObject({ cleanupIncomplete: true, pending: ["late-failing-resource"] });
    resolveResource("late");
    await expect(acquired).rejects.toThrow("late release failed");
    // 这里故意在 dispose 已经返回后才让 acquire 完成；迟到释放失败必须
    // 回写同一个结构化结果，而不是把之前的 pending 伪装成已清理。
    await Promise.resolve();
    expect(cleanupResult.cleanupIncomplete).toBe(true);
    expect(cleanupResult.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        resourceId: "late-failing-resource",
        code: "lifecycle.cleanup_failed",
        message: "late release failed",
      }),
    ]));
    expect(lateScope.resources()).toEqual([
      expect.objectContaining({
        resourceId: "late-failing-resource",
        state: "pending",
        error: "late release failed",
      }),
    ]);
  });

  it("continues cleanup after an error and reports timeout separately", async () => {
    const events: string[] = [];
    const scope = createLifecycleScope({ kind: "plugin-instance" });
    scope.onDispose(() => { events.push("first"); throw new Error("first failed"); }, "first");
    scope.onDispose(() => { events.push("second"); }, "second");

    const result = await scope.dispose();
    expect(events).toEqual(["second", "first"]);
    expect(result.cleanupIncomplete).toBe(true);
    expect(result.errors).toEqual([
      expect.objectContaining({ resourceId: "first", code: "lifecycle.cleanup_failed" })
    ]);

    const timeoutScope = createLifecycleScope({ kind: "request" });
    timeoutScope.onDispose(() => new Promise<void>(() => undefined), "hung");
    const timeoutResult = await timeoutScope.dispose({ timeoutMs: 1 });
    expect(timeoutResult).toMatchObject({ cleanupIncomplete: true, pending: ["hung"] });
  });

  it("reconciles a timeout after eventual success and becomes reusable", async () => {
    let releaseLate!: () => void;
    const scope = createLifecycleScope({ kind: "plugin-instance" });
    scope.onDispose(() => new Promise<void>((resolve) => { releaseLate = resolve; }), "late-success");

    const result = await scope.dispose({ timeoutMs: 1 });
    expect(result).toMatchObject({ cleanupIncomplete: true, pending: ["late-success"] });

    releaseLate();
    // Promise reaction 完成后，原结果对象应被后台清理回写，而不是永久停留
    // 在 timeout；这也是 Host 恢复 cleanup-pending 的触发条件。
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();
    expect(result).toMatchObject({ cleanupIncomplete: false, pending: [], released: 1 });
    expect(scope.resources()).toEqual([
      expect.objectContaining({ resourceId: "late-success", state: "released" }),
    ]);
  });

  it("propagates parent revoke to a child scope", async () => {
    const parent = createLifecycleScope({ kind: "owner-session" });
    const child = parent.child("request");
    const release = vi.fn();
    child.track("value", release, "child-value");

    parent.revoke("lock");
    expect(child.state).toBe("stopping");
    await parent.dispose();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("removes the parent child link when a child is disposed independently", async () => {
    const parent = createLifecycleScope({ kind: "root" });
    const child = parent.child("plugin-instance");
    child.onDispose(() => undefined, "child-resource");

    await child.dispose({ reason: "plugin disabled" });
    expect(parent.resources()).toEqual([]);

    const result = await parent.dispose();
    expect(result).toMatchObject({ attempted: 0, released: 0, cleanupIncomplete: false });
  });

  it("retains an independently timed-out child in the parent result", async () => {
    let releaseLate!: () => void;
    const parent = createLifecycleScope({ kind: "root" });
    const child = parent.child("plugin-instance");
    child.onDispose(
      () => new Promise<void>((resolve) => { releaseLate = resolve; }),
      "late-independent-child",
    );

    const childResult = await child.dispose({ reason: "plugin disabled", timeoutMs: 1 });
    const childPrefix = `child:${child.identity.scopeId}:`;
    expect(childResult).toMatchObject({
      cleanupIncomplete: true,
      pending: ["late-independent-child"],
    });
    expect(parent.resources()).toEqual([
      expect.objectContaining({
        resourceId: `child:${child.identity.scopeId}`,
        state: "pending",
      }),
    ]);

    const parentResult = await parent.dispose({ reason: "host disposed", timeoutMs: 1 });
    expect(parentResult.cleanupIncomplete).toBe(true);
    expect(parentResult.pending).toContain(`${childPrefix}late-independent-child`);

    releaseLate();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();
    expect(parentResult).toMatchObject({ cleanupIncomplete: false, pending: [] });
  });

  it("retains an independently failed child and prefixes its parent error", async () => {
    const parent = createLifecycleScope({ kind: "root" });
    const child = parent.child("plugin-instance");
    child.onDispose(() => { throw new Error("independent child cleanup failed"); }, "failed-independent-child");

    const childResult = await child.dispose({ reason: "plugin disabled" });
    expect(childResult.cleanupIncomplete).toBe(true);
    expect(parent.resources()).toEqual([
      expect.objectContaining({
        resourceId: `child:${child.identity.scopeId}`,
        state: "pending",
        error: "independent child cleanup failed",
      }),
    ]);

    const parentResult = await parent.dispose({ reason: "host disposed" });
    const childPrefix = `child:${child.identity.scopeId}:`;
    expect(parentResult.cleanupIncomplete).toBe(true);
    expect(parentResult.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        resourceId: `${childPrefix}failed-independent-child`,
        code: "lifecycle.cleanup_failed",
        message: "independent child cleanup failed",
      }),
    ]));
  });

  it("aggregates child timeout and late success into the parent result", async () => {
    let releaseLate!: () => void;
    const parent = createLifecycleScope({ kind: "root" });
    const child = parent.child("plugin-instance");
    child.onDispose(() => new Promise<void>((resolve) => { releaseLate = resolve; }), "late-child-resource");

    const result = await parent.dispose({ timeoutMs: 1, reason: "host disposed" });
    const prefix = `child:${child.identity.scopeId}:`;
    expect(result.cleanupIncomplete).toBe(true);
    expect(result.pending).toContain(`${prefix}late-child-resource`);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        resourceId: `${prefix}late-child-resource`,
        code: "lifecycle.cleanup_timeout",
      }),
    ]));

    releaseLate();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();

    expect(result).toMatchObject({ cleanupIncomplete: false, pending: [] });
    expect(result.released).toBe(result.attempted);
    expect(parent.resources()).toEqual([
      expect.objectContaining({
        resourceId: `child:${child.identity.scopeId}`,
        state: "released",
      }),
    ]);
  });

  it("does not hide a child cleanup failure behind a released parent entry", async () => {
    const parent = createLifecycleScope({ kind: "root" });
    const child = parent.child("plugin-instance");
    child.onDispose(() => { throw new Error("child cleanup failed"); }, "failed-child-resource");

    const result = await parent.dispose({ reason: "host disposed" });
    const prefix = `child:${child.identity.scopeId}:`;
    expect(result.cleanupIncomplete).toBe(true);
    expect(result.pending).toContain(`${prefix}failed-child-resource`);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        resourceId: `${prefix}failed-child-resource`,
        code: "lifecycle.cleanup_failed",
        message: "child cleanup failed",
      }),
    ]));
    expect(parent.resources()).toEqual([
      expect.objectContaining({
        resourceId: `child:${child.identity.scopeId}`,
        state: "pending",
      }),
    ]);
  });
});
