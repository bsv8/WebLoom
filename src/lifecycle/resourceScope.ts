// 轻量生命周期作用域实现。
//
// 该模块刻意不依赖 React、Node、Worker 或 Cordis。它只负责三件事：
//   1. 给运行实例生成不可复用的身份；
//   2. 在同步 revoke 后立即阻止新资源，并通过 AbortSignal 通知资源；
//   3. 尽力执行所有异步清理，返回可观测的失败/超时结果。
//
// 它不是安全沙箱：同源代码仍可能拿到自己的全局对象。权限安全必须在
// Host、RPC 和最终存储/签名边界重复校验。

import type {
  LifecycleCleanup,
  LifecycleCleanupPhase,
  LifecycleCleanupIssue,
  LifecycleDisposeOptions,
  LifecycleDisposeResult,
  LifecycleResourceHandle,
  LifecycleResourceSnapshot,
  LifecycleScope,
  LifecycleScopeIdentity,
  LifecycleScopeKind,
  LifecycleScopeState,
} from "../contracts/lifecycle.js";
import { LifecycleScopeRevokedError } from "../contracts/lifecycle.js";

type ResourceState = LifecycleResourceSnapshot["state"];

interface ResourceEntry {
  resourceId: string;
  state: ResourceState;
  cleanup: LifecycleCleanup;
  phase: LifecycleCleanupPhase;
  /** 清理是否已经开始；防止重复释放同一个底层句柄。 */
  cleanupStarted: boolean;
  /** 清理回调是否已经返回；超时后可能仍为 false。 */
  cleanupFinished: boolean;
  /** 清理 Promise，供重复 release 调用共享。 */
  cleanupPromise?: Promise<void>;
  /** 获取资源失败后从作用域中移除。 */
  removeOnFailure: boolean;
  /** 迟到资源的释放失败；不能被先前的空清理回调覆盖成 released。 */
  lateReleaseFailed?: boolean;
  /** acquire 尚未完成时，dispose 必须等待创建结果再决定是否释放。 */
  acquisitionDone?: Promise<void>;
  /** 子作用域是父作用域的一等资源，清理结果必须向父级聚合。 */
  childScope?: LifecycleScope;
  /** 最近一次子作用域停止结果；迟到清理会原地更新同一对象。 */
  childResult?: LifecycleDisposeResult;
  error?: string;
}

type MutableDisposeResult = {
  -readonly [K in keyof LifecycleDisposeResult]: LifecycleDisposeResult[K];
};

export interface CreateResourceScopeOptions {
  /** 可选固定作用域标识；生产代码通常省略，让实现生成不可复用 ID。 */
  scopeId?: string;
  /** 运行实例标识；省略时与 scopeId 同源生成。 */
  instanceId?: string;
  /** 作用域类型。 */
  kind: LifecycleScopeKind;
  /** 绑定插件和宿主只读属性。 */
  metadata?: Omit<Partial<LifecycleScopeIdentity>, "scopeId" | "instanceId" | "kind">;
  /** 测试或宿主诊断使用的状态变更回调。 */
  onChange?: (scope: LifecycleScope) => void;
  /** 子作用域生成最终清理结果后的内部通知；用于更新父级登记。 */
  onDisposeResult?: (result: LifecycleDisposeResult) => void;
}

function makeId(prefix: string): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return `${prefix}:${crypto.randomUUID()}`;
    }
  } catch {
    // 某些 Worker/测试环境没有可用的 Web Crypto；下面的随机值只用于身份
    // 去重，不承担密码学安全语义。
  }
  return `${prefix}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : String(error);
}

function isPositiveFiniteNumber(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 0;
}

function cloneScopeAttributes(value: Readonly<Record<string, unknown>> | undefined): Readonly<Record<string, unknown>> {
  let clone: unknown;
  try {
    const structuredCloneFn = (globalThis as unknown as { structuredClone?: (input: unknown) => unknown }).structuredClone;
    clone = structuredCloneFn ? structuredCloneFn(value ?? {}) : { ...(value ?? {}) };
  } catch {
    throw new TypeError("Lifecycle scope attributes must be structured-cloneable");
  }
  if (!clone || typeof clone !== "object" || Array.isArray(clone)) throw new TypeError("Lifecycle scope attributes must be a record");
  const freeze = (current: unknown, seen: Set<object>): void => {
    if (!current || typeof current !== "object" || seen.has(current)) return;
    seen.add(current);
    if (Array.isArray(current)) for (const item of current) freeze(item, seen);
    else for (const item of Object.values(current as Record<string, unknown>)) freeze(item, seen);
    Object.freeze(current);
  };
  freeze(clone, new Set<object>());
  return clone as Readonly<Record<string, unknown>>;
}

/**
 * 创建一个可嵌套的生命周期作用域。
 *
 * `createResourceScope` 是 `createLifecycleScope` 的同义入口，方便不同
 * 模块按“作用域”或“资源”语义调用；两者不代表两套实现。
 */
export function createLifecycleScope(options: CreateResourceScopeOptions): LifecycleScope {
  const metadata = options.metadata;
  const identity: LifecycleScopeIdentity = {
    scopeId: options.scopeId ?? makeId(`scope:${options.kind}`),
    instanceId: options.instanceId ?? makeId("instance"),
    kind: options.kind,
    ...metadata,
    attributes: cloneScopeAttributes(metadata?.attributes),
  };
  const controller = new AbortController();
  const revokeListeners = new Set<(reason: string) => void>();
  const entries = new Map<string, ResourceEntry>();
  const usedIds = new Set<string>();
  let currentState: LifecycleScopeState = "active";
  let revokeReason = "scope revoked";
  let disposalPromise: Promise<LifecycleDisposeResult> | undefined;
  /** 父作用域清理已经返回后，子作用域迟到收敛时刷新父级结果。 */
  let refreshPublishedDisposeResult: (() => void) | undefined;
  const disposeResultNotifier = options.onDisposeResult;

  const notifyChange = (scope: LifecycleScope) => {
    try {
      options.onChange?.(scope);
    } catch {
      // 诊断回调不能改变生命周期结果。
    }
  };

  const publicScope = {} as LifecycleScope;

  function uniqueResourceId(resourceId: string | undefined): string {
    const base = resourceId && resourceId.length > 0 ? resourceId : makeId("resource");
    if (!usedIds.has(base)) {
      usedIds.add(base);
      return base;
    }
    let index = 2;
    while (usedIds.has(`${base}#${index}`)) index += 1;
    const unique = `${base}#${index}`;
    usedIds.add(unique);
    return unique;
  }

  function assertActive(): void {
    if (currentState !== "active") {
      throw new LifecycleScopeRevokedError(
        `Lifecycle scope "${identity.scopeId}" is ${currentState}`
      );
    }
  }

  function addEntry(
    resourceId: string | undefined,
    cleanup: LifecycleCleanup,
    state: ResourceState,
    removeOnFailure = false,
    phase: LifecycleCleanupPhase = "before-teardown"
  ): ResourceEntry {
    assertActive();
    const entry: ResourceEntry = {
      resourceId: uniqueResourceId(resourceId),
      state,
      cleanup,
      phase,
      cleanupStarted: false,
      cleanupFinished: false,
      removeOnFailure,
    };
    entries.set(entry.resourceId, entry);
    notifyChange(publicScope);
    return entry;
  }

  function releaseEntry(entry: ResourceEntry, reason: string): Promise<void> {
    if (entry.cleanupPromise) return entry.cleanupPromise;
    entry.cleanupStarted = true;
    entry.cleanupPromise = Promise.resolve()
      .then(() => entry.cleanup(reason))
      .then(() => {
        entry.cleanupFinished = true;
        if (!entry.lateReleaseFailed) {
          entry.state = "released";
          entry.error = undefined;
        }
        notifyChange(publicScope);
      })
      .catch((error) => {
        entry.cleanupFinished = true;
        // 失败项保留为 pending，便于状态页和后续恢复逻辑发现；不再次
        // 隐式调用不幂等的外部清理函数。
        entry.state = "pending";
        entry.error = errorMessage(error);
        notifyChange(publicScope);
        throw error;
      });
    // 即使调用方只触发同步 revoke，也必须接住迟到 rejection。
    entry.cleanupPromise.catch(() => undefined);
    return entry.cleanupPromise;
  }

  function track<T>(
    resource: T,
    release: (value: T, reason: string) => void | Promise<void>,
    resourceId?: string
  ): T {
    if (currentState !== "active") {
      // 资源已经在 stopping 之后返回：不允许发布到旧作用域，同时尽力
      // 释放它。这里不会把释放错误变成未处理 Promise。
      void Promise.resolve()
        .then(() => release(resource, revokeReason))
        .catch(() => undefined);
      throw new LifecycleScopeRevokedError();
    }
    let released = false;
    addEntry(
      resourceId,
      async (reason) => {
        if (released) return;
        released = true;
        await release(resource, reason);
      },
      "active"
    );
    return resource;
  }

  function acquire<T>(
    resourceId: string,
    create: (signal: AbortSignal) => T | Promise<T>,
    release: (resource: T, reason: string) => void | Promise<void>
  ): Promise<T> {
    assertActive();
    let resource: T | undefined;
    let hasResource = false;
    let released = false;
    let resolveAcquisition!: () => void;
    let rejectAcquisition!: (error: unknown) => void;
    let acquisitionSettled = false;
    const acquisitionDone = new Promise<void>((resolve, reject) => {
      resolveAcquisition = () => {
        if (acquisitionSettled) return;
        acquisitionSettled = true;
        resolve();
      };
      rejectAcquisition = (error) => {
        if (acquisitionSettled) return;
        acquisitionSettled = true;
        reject(error);
      };
    });
    // dispose 可能没有被调用，或者 timeout 后不再等待；仍需接住这个
    // 内部等待 Promise 的迟到失败，不能制造 unhandled rejection。
    acquisitionDone.catch(() => undefined);
    const entry = addEntry(
      resourceId,
      async (reason) => {
        // 不能在创建尚未结束时直接返回：否则 dispose 会把 acquiring
        // 资源伪装成 released，迟到资源随后发生的释放失败也无法进入
        // 本次清理链。timeout 由 runEntry 负责把仍未完成项标成 pending。
        await acquisitionDone;
        if (!hasResource || released) return;
        released = true;
        await release(resource as T, reason);
      },
      "acquiring",
      true,
      "before-teardown"
    );
    entry.acquisitionDone = acquisitionDone;

    return Promise.resolve()
      .then(() => create(controller.signal))
      .then(async (created) => {
        resource = created;
        hasResource = true;
        if (currentState !== "active" || controller.signal.aborted || entry.cleanupStarted) {
          // dispose 可能在 create() 等待期间已经开始；此时由 acquire 自己
          // 接管迟到资源。entry.cleanup 正在等待 acquisitionDone，因此不会
          // 与这里的释放形成互相等待。
          if (!released) {
            released = true;
            try {
              await release(created, revokeReason);
            } catch (error) {
              entry.lateReleaseFailed = true;
              entry.state = "pending";
              entry.error = errorMessage(error);
              notifyChange(publicScope);
              rejectAcquisition(error);
              throw error;
            }
          }
          entry.state = "released";
          resolveAcquisition();
          notifyChange(publicScope);
          throw new LifecycleScopeRevokedError(
            `Resource "${entry.resourceId}" completed after scope revoke`
          );
        }
        entry.state = "active";
        entry.removeOnFailure = false;
        resolveAcquisition();
        notifyChange(publicScope);
        return created;
      })
      .catch((error) => {
        if (!hasResource) {
          // 创建失败不是资源释放失败；让正在等待的 dispose 继续完成，
          // 同时保留原始 create 错误给 acquire 调用方。
          resolveAcquisition();
          entries.delete(entry.resourceId);
          usedIds.delete(entry.resourceId);
        }
        throw error;
      });
  }

  function onDispose(
    cleanup: LifecycleCleanup,
    resourceId?: string,
    phase: LifecycleCleanupPhase = "before-teardown"
  ): () => void {
    if (currentState !== "active") {
      // 异步回调在停止后才拿到释放责任时，不能把 disposer 丢在旧作用域
      // 外面；立即执行一次，并吞掉异常交给调用方之外的可观测层处理。
      void Promise.resolve()
        .then(() => cleanup(revokeReason))
        .catch(() => undefined);
      return () => undefined;
    }
    const entry = addEntry(resourceId, cleanup, "active", false, phase);
    return () => {
      if (entry.cleanupStarted || entry.cleanupFinished) return;
      entries.delete(entry.resourceId);
      usedIds.delete(entry.resourceId);
      notifyChange(publicScope);
    };
  }

  function onRevoke(listener: (reason: string) => void): () => void {
    if (currentState === "active") {
      revokeListeners.add(listener);
      return () => revokeListeners.delete(listener);
    }
    try {
      listener(revokeReason);
    } catch {
      // 观察者错误不影响撤权。
    }
    return () => undefined;
  }

  function revoke(reason = "scope revoked"): void {
    if (currentState !== "active") return;
    revokeReason = reason;
    currentState = "stopping";
    // 先改状态再 abort，任何 abort listener 都只能看到 stopping，不能
    // 在回调里继续注册资源。
    try {
      controller.abort(new LifecycleScopeRevokedError(reason));
    } catch {
      controller.abort();
    }
    for (const listener of [...revokeListeners]) {
      try {
        listener(reason);
      } catch {
        // 其它撤权监听仍必须执行。
      }
    }
    notifyChange(publicScope);
  }

  async function runEntry(
    entry: ResourceEntry,
    reason: string,
    timeoutMs: number | undefined,
    issues: LifecycleCleanupIssue[],
    onLateSuccess?: (entry: ResourceEntry) => void,
    onLateFailure?: (entry: ResourceEntry, error: unknown) => void
  ): Promise<"released" | "pending"> {
    if (entry.cleanupFinished && entry.state === "released") return "released";
    const cleanup = releaseEntry(entry, reason);
    if (!isPositiveFiniteNumber(timeoutMs)) {
      try {
        await cleanup;
        return entry.state === "released" ? "released" : "pending";
      } catch (error) {
        issues.push({
          resourceId: entry.resourceId,
          code: "lifecycle.cleanup_failed",
          message: errorMessage(error),
        });
        return "pending";
      }
    }

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timeoutHandle = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    const result = await Promise.race([
      cleanup.then(() => "released" as const, (error) => ({ error })),
      timeout,
    ]);
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (result === "timeout") {
      entry.state = "pending";
      issues.push({
        resourceId: entry.resourceId,
        code: "lifecycle.cleanup_timeout",
        message: `Cleanup timed out after ${timeoutMs}ms`,
      });
      // dispose() 已经可以按超时返回，但 acquiring 资源的真实创建/释放
      // 仍可能稍后结束。若这一步失败，必须把失败追加到同一份结果对象，
      // 不能让“先返回 cleanupIncomplete=false”的快照掩盖迟到错误。
      void cleanup.then(
        () => {
          try {
            onLateSuccess?.(entry);
          } catch {
            // 迟到状态投影不能改变底层清理结果，也不能制造未处理异常。
          }
        },
        (error) => {
          try {
            onLateFailure?.(entry, error);
          } catch {
            // 同上：失败已经记录在 scope 结果中。
          }
        },
      );
      return "pending";
    }
    if (result === "released") return "released";
    entry.state = "pending";
    issues.push({
      resourceId: entry.resourceId,
      code: "lifecycle.cleanup_failed",
      message: errorMessage(result.error),
    });
    return "pending";
  }

  async function dispose(options: LifecycleDisposeOptions = {}): Promise<LifecycleDisposeResult> {
    if (disposalPromise) return disposalPromise;
    revoke(options.reason ?? "scope disposed");
    const reason = options.reason ?? revokeReason;
    const entriesToRelease = [...entries.values()].reverse();
    disposalPromise = (async () => {
      const errors: LifecycleCleanupIssue[] = [];
      const pending = new Set<string>();
      const lateReleased = new Set<string>();
      let released = 0;
      let attempted = 0;
      let resultSnapshot: MutableDisposeResult | undefined;
      let resultPublished = false;

      const publishDisposeResult = (): void => {
        if (!resultPublished || !resultSnapshot) return;
        try {
          disposeResultNotifier?.(resultSnapshot);
        } catch {
          // 父级状态投影不能改变清理结果。
        }
      };

      /**
       * 把 direct resource 和 child scope 的结果合并到同一个父级快照。
       * child:<scopeId>:<resourceId> 是父级可观测的稳定资源标识；不能只
       * 记录 child scope 自身，否则 Host 会把子资源错误地显示为已释放。
       */
      const rebuildResultSnapshot = (): void => {
        if (!resultSnapshot) return;
        const mergedPending = new Set(pending);
        const mergedErrors = [...errors];
        let mergedAttempted = attempted;
        let mergedReleased = released;
        for (const childEntry of entries.values()) {
          const childScope = childEntry.childScope;
          const childResult = childEntry.childResult;
          if (!childScope || !childResult) continue;
          const prefix = `child:${childScope.identity.scopeId}:`;
          mergedAttempted += childResult.attempted;
          mergedReleased += childResult.released;
          for (const resourceId of childResult.pending) {
            mergedPending.add(`${prefix}${resourceId}`);
          }
          for (const issue of childResult.errors) {
            mergedErrors.push({
              ...issue,
              resourceId: `${prefix}${issue.resourceId}`,
            });
          }
        }
        resultSnapshot.attempted = mergedAttempted;
        resultSnapshot.released = mergedReleased;
        resultSnapshot.pending = [...mergedPending];
        resultSnapshot.errors = mergedErrors;
        resultSnapshot.cleanupIncomplete = mergedPending.size > 0 || mergedErrors.length > 0;
      };

      const projectChildResult = (
        entry: ResourceEntry,
        childResult: LifecycleDisposeResult,
        lateResourceId?: string,
        lateError?: unknown,
      ): void => {
        if (!entry.childScope) return;
        const previous = entry.childResult;
        entry.childResult = childResult;
        entry.state = childResult.cleanupIncomplete ? "pending" : "released";
        entry.error = childResult.cleanupIncomplete
          ? childResult.errors[0]?.message ?? "Child scope cleanup is still pending"
          : undefined;
        rebuildResultSnapshot();
        // 先向更高层父作用域发布最新快照，再调用外部投影；否则 Host
        // 可能在父级仍是旧 pending 时先计算出错误的汇总结果。
        publishDisposeResult();
        if (lateResourceId && resultSnapshot) {
          const resourceId = `child:${entry.childScope.identity.scopeId}:${lateResourceId}`;
          try {
            if (lateError !== undefined) options.onLateFailure?.(resourceId, lateError, resultSnapshot);
            else options.onLateSuccess?.(resourceId, resultSnapshot);
          } catch {
            // 外部状态投影不能改变清理结果。
          }
        } else if (previous?.cleanupIncomplete && !childResult.cleanupIncomplete && resultSnapshot) {
          // 子作用域没有提供具体迟到资源标识时，仍需通知父级已经收敛。
          try {
            options.onLateSuccess?.(`child:${entry.childScope.identity.scopeId}`, resultSnapshot);
          } catch {
            // 同上。
          }
        }
        notifyChange(publicScope);
      };

      // 子作用域可能在父作用域已经返回 cleanup-pending 后才最终收敛；
      // 保留这个刷新入口，避免父级结果快照停留在旧的 pending/error。
      refreshPublishedDisposeResult = () => {
        if (!resultPublished || !resultSnapshot) return;
        rebuildResultSnapshot();
        publishDisposeResult();
      };

      const onLateFailure = (entry: ResourceEntry, error: unknown): void => {
        entry.state = "pending";
        entry.error = errorMessage(error);
        if (!errors.some((issue) => issue.resourceId === entry.resourceId && issue.code === "lifecycle.cleanup_failed")) {
          errors.push({
            resourceId: entry.resourceId,
            code: "lifecycle.cleanup_failed",
            message: errorMessage(error),
          });
        }
        pending.add(entry.resourceId);
        if (resultSnapshot) {
          rebuildResultSnapshot();
        }
        publishDisposeResult();
        try {
          options.onLateFailure?.(entry.resourceId, error, resultSnapshot);
        } catch {
          // 外部状态投影不能改变清理结果。
        }
        notifyChange(publicScope);
      };
      const onLateSuccess = (entry: ResourceEntry): void => {
        // runEntry 只为 timeout 项登记此回调；Set 也防御同一项的重复通知。
        if (lateReleased.has(entry.resourceId)) return;
        lateReleased.add(entry.resourceId);
        pending.delete(entry.resourceId);
        released += 1;
        for (let index = errors.length - 1; index >= 0; index -= 1) {
          const issue = errors[index];
          if (issue?.resourceId === entry.resourceId && issue.code === "lifecycle.cleanup_timeout") {
            errors.splice(index, 1);
          }
        }
        if (resultSnapshot) {
          rebuildResultSnapshot();
        }
        publishDisposeResult();
        try {
          options.onLateSuccess?.(entry.resourceId, resultSnapshot);
        } catch {
          // 外部状态投影不能改变清理结果。
        }
        notifyChange(publicScope);
      };
      const releasePhase = async (phase: LifecycleCleanupPhase) => {
        // 每个阶段按登记逆序释放；每项都有独立超时，所以一个永不返回
        // 的网络退订不会阻塞其它资源释放。
        for (const entry of entriesToRelease.filter((item) => item.phase === phase)) {
          if (entry.childScope) {
            // 子 Scope 自己负责对子资源应用 timeout；父级只维护它的
            // 结构化结果，并通过 child scope 的迟到回调持续重建快照。
            entry.cleanupStarted = true;
            try {
              const childResult = await entry.childScope.dispose({
                reason,
                timeoutMs: options.timeoutMs,
                onLateSuccess: (resourceId, result) => {
                  if (result) projectChildResult(entry, result, resourceId);
                },
                onLateFailure: (resourceId, error, result) => {
                  if (result) projectChildResult(entry, result, resourceId, error);
                },
              });
              entry.cleanupFinished = true;
              projectChildResult(entry, childResult);
            } catch (error) {
              entry.cleanupFinished = true;
              entry.state = "pending";
              entry.error = errorMessage(error);
              pending.add(entry.resourceId);
              errors.push({
                resourceId: entry.resourceId,
                code: "lifecycle.cleanup_failed",
                message: errorMessage(error),
              });
              notifyChange(publicScope);
            }
            continue;
          }
          attempted += 1;
          const result = await runEntry(entry, reason, options.timeoutMs, errors, onLateSuccess, onLateFailure);
          if (result === "released") released += 1;
          else if (!lateReleased.has(entry.resourceId)) pending.add(entry.resourceId);
        }
      };
      await releasePhase("before-teardown");

      // Host 的旧 teardown / 领域收尾位于两个清理阶段之间。这样显式
      // onDispose 仍能先看到旧注册项，而异步 Registry facade 可以在
      // teardown 完成后再注销，不依赖 snapshot 差分。
      if (options.teardown) {
        const teardownEntry: ResourceEntry = {
          resourceId: "scope:teardown",
          state: "active",
          cleanup: options.teardown,
          phase: "before-teardown",
          cleanupStarted: false,
          cleanupFinished: false,
          removeOnFailure: false,
        };
        attempted += 1;
        const result = await runEntry(teardownEntry, reason, options.timeoutMs, errors, onLateSuccess, onLateFailure);
        if (result === "released") released += 1;
        else if (!lateReleased.has(teardownEntry.resourceId)) pending.add(teardownEntry.resourceId);
      }

      await releasePhase("after-teardown");
      currentState = "stopped";
      notifyChange(publicScope);
      resultSnapshot = {
        scopeId: identity.scopeId,
        state: "stopped" as const,
        attempted,
        released,
        pending: [...pending],
        errors,
        cleanupIncomplete: pending.size > 0 || errors.length > 0,
      };
      rebuildResultSnapshot();
      resultPublished = true;
      publishDisposeResult();
      return resultSnapshot;
    })();
    // 所有当前调用者共享同一个完成结果。
    return disposalPromise;
  }

  function resources(): readonly LifecycleResourceSnapshot[] {
    return [...entries.values()].map((entry) => ({
      resourceId: entry.resourceId,
      state: entry.state,
      ...(entry.error ? { error: entry.error } : {}),
    }));
  }

  function child(
    kind: LifecycleScopeKind,
    metadata: Partial<Omit<LifecycleScopeIdentity, "scopeId" | "instanceId" | "kind" | "parentScopeId">> = {}
  ): LifecycleScope {
    assertActive();
    let childEntry: ResourceEntry | undefined;
    const childScope = createLifecycleScope({
      kind,
      metadata: {
        ...metadata,
        parentScopeId: identity.scopeId,
      },
      // 父作用域的 Host 订阅者也必须看到子作用域资源的状态变化。
      onChange: () => notifyChange(publicScope),
      // 只有子作用域已经生成最终结果后，父级才允许更新/删除登记。
      onDisposeResult: (result) => {
        const entry = childEntry;
        if (!entry) return;
        entry.childResult = result;
        entry.state = result.cleanupIncomplete ? "pending" : "released";
        entry.error = result.cleanupIncomplete
          ? result.errors[0]?.message ?? "Child scope cleanup is still pending"
          : undefined;
        refreshPublishedDisposeResult?.();
        // 父级主动 dispose 时保留登记，供父级结果和诊断快照继续展示；
        // 只有独立 dispose 的子作用域在最终成功后才解除父级链接。
        if (!result.cleanupIncomplete && !disposalPromise && !entry.cleanupStarted) {
          entries.delete(entry.resourceId);
          usedIds.delete(entry.resourceId);
        }
        notifyChange(publicScope);
      },
    });
    // revoke 是同步安全边界，父作用域撤权时立即传播；dispose 再等待子
    // 作用域的异步收尾。
    const removeRevoke = onRevoke((reason) => childScope.revoke(reason));
    // 子作用域作为父级的一等资源登记。不能用“父级 disposer 只 await
    // child.dispose()”的旧写法：child.dispose() 在失败/超时时会返回
    // cleanupIncomplete=true，而父级若忽略返回值就会错误标记为 released。
    const entry = addEntry(`child:${childScope.identity.scopeId}`, async () => undefined, "active");
    childEntry = entry;
    entry.childScope = childScope;
    // 子作用域可能早于父作用域结束（例如插件 disable 后再次 enable）。
    // parent-link 只解除 revoke 监听；父级登记必须等子作用域的最终结果
    // 生成后再处理，否则子资源失败/超时时父级会丢失 cleanup-pending。
    childScope.onDispose(() => {
      removeRevoke();
    }, `parent-link:${identity.scopeId}`);
    return childScope;
  }

  function listen(
    target: EventTarget,
    event: string,
    listener: EventListenerOrEventListenerObject,
    options?: AddEventListenerOptions | boolean,
  ): () => void {
    assertActive();
    if (!target || typeof target.addEventListener !== "function" || typeof target.removeEventListener !== "function") {
      throw new TypeError("Lifecycle scope listen target must be an EventTarget");
    }
    let active = true;
    target.addEventListener(event, listener, options);
    let removeRevoke: (() => void) | undefined;
    const release = (): void => {
      if (!active) return;
      active = false;
      target.removeEventListener(event, listener, options);
      removeRevoke?.();
    };
    removeRevoke = onRevoke(release);
    if (!active) release();
    return release;
  }

  function interval(callback: () => void, milliseconds: number): () => void {
    assertActive();
    if (typeof callback !== "function") throw new TypeError("Lifecycle scope interval callback must be a function");
    if (!Number.isFinite(milliseconds) || milliseconds < 0) throw new TypeError("Lifecycle scope interval milliseconds must be a finite non-negative number");
    const handle = setInterval(callback, milliseconds);
    let active = true;
    let removeRevoke: (() => void) | undefined;
    const release = (): void => {
      if (!active) return;
      active = false;
      clearInterval(handle);
      removeRevoke?.();
    };
    removeRevoke = onRevoke(release);
    if (!active) release();
    return release;
  }

  function subscribe(
    subscribeFn: (listener: () => void) => () => void,
    listener: () => void,
  ): () => void {
    assertActive();
    if (typeof subscribeFn !== "function" || typeof listener !== "function") {
      throw new TypeError("Lifecycle scope subscribe requires functions");
    }
    let active = true;
    let unsubscribe: (() => void) | undefined;
    let removeRevoke: (() => void) | undefined;
    const release = (): void => {
      if (!active) return;
      active = false;
      removeRevoke?.();
      unsubscribe?.();
    };
    removeRevoke = onRevoke(release);
    try {
      const candidate = subscribeFn(listener);
      if (typeof candidate !== "function") throw new TypeError("Lifecycle subscribe function must return an unsubscribe function");
      unsubscribe = candidate;
      if (!active) unsubscribe();
    } catch (error) {
      release();
      throw error;
    }
    return release;
  }

  Object.assign(publicScope, {
    identity,
    signal: controller.signal,
    onRevoke,
    onDispose,
    track,
    acquire,
    child,
    revoke,
    dispose,
    assertActive,
    resources,
    listen,
    interval,
    subscribe,
  });
  // Object.assign 会读取 getter 的当前值，不能用它暴露动态 state；必须
  // 保持状态只读且随 revoke/dispose 实时变化。
  Object.defineProperty(publicScope, "state", {
    enumerable: true,
    configurable: false,
    get: () => currentState,
  });
  return publicScope;
}

/** 语义别名：资源管理代码通常以 ResourceScope 称呼同一原语。 */
export const createResourceScope = createLifecycleScope;

export type ResourceScopeOptions = CreateResourceScopeOptions;
