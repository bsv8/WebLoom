// 绑定生命周期作用域的轻量后台任务调度器。
//
// 这是 Worker 内核可复用的调度原语，不是领域持久工作流：
// - 定时器、取消控制器和运行实例都登记到同一个 scope；
// - 同一任务不并发，重复触发只合并一次；
// - 周期采用 setTimeout 链，避免 setInterval 在任务变慢时重叠；
// - 作用域停止时只撤销本地任务，外部上传 / 支付等恢复仍由领域仓库负责。

import type {
  LifecycleScope,
  ScopedTaskDefinition,
  ScopedTaskScheduler,
  ScopedTaskSnapshot,
} from "../contracts/lifecycle.js";

interface TaskRuntime {
  definition: ScopedTaskDefinition;
  state: ScopedTaskSnapshot["state"];
  error?: string;
  lastCompletedAt?: string;
  nextRunAt?: string;
  timer?: ReturnType<typeof setTimeout>;
  controller?: AbortController;
  runPromise?: Promise<void>;
  rerunRequested: boolean;
  active: boolean;
}

export interface CreateScopedTaskSchedulerOptions {
  /** 注册后是否先恢复运行一次；缺省为 false，由业务显式触发。 */
  runOnRegister?: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 创建绑定到一个 lifecycle scope 的任务调度器。 */
export function createScopedTaskScheduler(
  scope: LifecycleScope,
  options: CreateScopedTaskSchedulerOptions = {}
): ScopedTaskScheduler & { dispose(): Promise<void> } {
  const tasks = new Map<string, TaskRuntime>();
  const listeners = new Set<(snapshot: readonly ScopedTaskSnapshot[]) => void>();
  let disposed = false;

  const notify = () => {
    const value = [...tasks.values()].map((task) => ({
      id: task.definition.id,
      pluginId: task.definition.pluginId ?? scope.identity.pluginId ?? "unknown",
      label: task.definition.label,
      state: task.state,
      ...(task.error ? { error: task.error } : {}),
      ...(task.lastCompletedAt ? { lastCompletedAt: task.lastCompletedAt } : {}),
      ...(task.nextRunAt ? { nextRunAt: task.nextRunAt } : {}),
    }));
    for (const listener of [...listeners]) {
      try {
        listener(value);
      } catch {
        // UI 观察者不能影响任务撤销和调度。
      }
    }
  };

  const clearTimer = (task: TaskRuntime) => {
    if (task.timer !== undefined) {
      clearTimeout(task.timer);
      task.timer = undefined;
    }
    task.nextRunAt = undefined;
  };

  const schedule = (task: TaskRuntime) => {
    clearTimer(task);
    const intervalMs = task.definition.intervalMs;
    if (!task.active || disposed || intervalMs === undefined) {
      notify();
      return;
    }
    if (!Number.isFinite(intervalMs) || intervalMs < 0) {
      task.error = "任务 intervalMs 必须是非负有限数";
      task.state = "failed";
      notify();
      return;
    }
    const dueAt = Date.now() + intervalMs;
    task.nextRunAt = new Date(dueAt).toISOString();
    task.timer = setTimeout(() => {
      task.timer = undefined;
      task.nextRunAt = undefined;
      void runTask(task, "interval");
    }, intervalMs);
    notify();
  };

  const runTask = async (task: TaskRuntime, reason: string): Promise<void> => {
    if (!task.active || disposed || scope.state !== "active") return;
    if (task.runPromise) {
      task.rerunRequested = true;
      return task.runPromise;
    }
    task.state = "queued";
    task.error = undefined;
    notify();
    const run = (async () => {
      let requestScope: LifecycleScope | undefined;
      let controller: AbortController | undefined;
      let abortFromScope: (() => void) | undefined;
      try {
        // scope 可能在上面的 active 检查后、这里真正创建 request 子作用域前
        // 被同步撤权。把这条竞态纳入任务失败收口，不能让 timer 产生未处理
        // rejection，也不能在 stopped scope 上继续排下一次运行。
        requestScope = scope.child("request");
        controller = new AbortController();
        task.controller = controller;
        abortFromScope = () => controller?.abort(scope.signal.reason);
        if (scope.signal.aborted) abortFromScope();
        else scope.signal.addEventListener("abort", abortFromScope, { once: true });
        task.state = "running";
        notify();
        await task.definition.run({ signal: controller.signal, reason });
        if (!controller.signal.aborted && !requestScope.signal.aborted) {
          task.state = "idle";
          task.error = undefined;
          task.lastCompletedAt = new Date().toISOString();
        } else {
          task.state = "idle";
        }
      } catch (error) {
        task.state = "failed";
        task.error = controller?.signal.aborted ? undefined : errorMessage(error);
      } finally {
        if (abortFromScope) scope.signal.removeEventListener("abort", abortFromScope);
        task.controller = undefined;
        if (requestScope) {
          await requestScope.dispose({ reason: `task ${task.definition.id} finished` });
        }
        if (task.active && !disposed && scope.state === "active") schedule(task);
        else clearTimer(task);
        notify();
      }
    })();
    task.runPromise = run;
    try {
      await run;
    } finally {
      task.runPromise = undefined;
      notify();
      if (task.rerunRequested && task.active && !disposed && scope.state === "active") {
        task.rerunRequested = false;
        queueMicrotask(() => { void runTask(task, "coalesced"); });
      }
    }
  };

  const releaseTask = async (task: TaskRuntime, reason: string): Promise<void> => {
    if (!task.active) return;
    task.active = false;
    task.rerunRequested = false;
    clearTimer(task);
    task.controller?.abort(reason);
    if (task.runPromise) await task.runPromise;
    tasks.delete(task.definition.id);
    notify();
  };

  const scheduler: ScopedTaskScheduler & { dispose(): Promise<void> } = {
    register(definition) {
      scope.assertActive();
      if (!definition.id || tasks.has(definition.id)) {
        throw new Error(`Scoped task id "${definition.id}" is already registered or empty`);
      }
      const task: TaskRuntime = {
        definition: { ...definition },
        state: "idle",
        rerunRequested: false,
        active: true,
      };
      tasks.set(definition.id, task);
      const removeScopeCleanup = scope.onDispose(
        (reason) => releaseTask(task, reason),
        `task:${definition.id}`
      );
      // register 返回的取消句柄是同步触发、异步等待由下一次 scope dispose
      // 负责；不会让调用方误以为 cleanup 已经完成。
      const unregister = () => {
        if (!task.active) return;
        removeScopeCleanup();
        void releaseTask(task, "task unregistered");
      };
      schedule(task);
      if (options.runOnRegister) void runTask(task, "initial");
      return unregister;
    },
    async runNow(id, reason = "manual") {
      const task = tasks.get(id);
      if (!task) throw new Error(`Scoped task "${id}" is not registered`);
      await runTask(task, reason);
    },
    async cancel(id) {
      const task = tasks.get(id);
      if (!task) return;
      task.rerunRequested = false;
      task.controller?.abort("task canceled");
      if (task.runPromise) await task.runPromise;
    },
    snapshot() {
      return [...tasks.values()].map((task) => ({
        id: task.definition.id,
        pluginId: task.definition.pluginId ?? scope.identity.pluginId ?? "unknown",
        label: task.definition.label,
        state: task.state,
        ...(task.error ? { error: task.error } : {}),
        ...(task.lastCompletedAt ? { lastCompletedAt: task.lastCompletedAt } : {}),
        ...(task.nextRunAt ? { nextRunAt: task.nextRunAt } : {}),
      }));
    },
    subscribe(listener) {
      listeners.add(listener);
      listener(scheduler.snapshot());
      return () => listeners.delete(listener);
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      for (const task of [...tasks.values()]) {
        task.controller?.abort("task scheduler disposed");
        clearTimer(task);
      }
      await Promise.all([...tasks.values()].map((task) => releaseTask(task, "task scheduler disposed")));
      listeners.clear();
    },
  };
  return scheduler;
}
