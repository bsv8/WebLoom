// packages/runtime/src/messageBus.ts
// MessageBus runtime 实现。
//
// 设计缘由：
//   - publish / subscribe 同步调用：与旧 EventBus 行为等价；不 await async handler。
//   - dispatch / request 走 actor mailbox：把消息投递到 target 对应的内部队列，
//     pump 串行消费，跨请求隔离限流、取消与超时。
//   - handle 注册的 handler 不带 target 时走 publish 路径（用于把 publish 强制
//     路由到具体实现，例如 keyspace 注册的 key.created 处理器）。
//   - publish / handle 不引入任何 React 依赖。
//   - 关键不变量：
//       1. 每个 MailboxEntry 全生命周期只 settle 一次（唯一终态）。
//          所有成功、失败、取消都必须经过 settleEntry；它统一维护
//          entry.settled / entry.state / inFlight / completed / failed /
//          canceled / lastError，避免重复计数。
//       2. pump 是 N 个并发的 worker 循环（默认 N=1），每个 worker 拉取
//          best entry 后 await handler，再 settle。await 是关键的——
//          旧实现的"开火-遗忘"会丢并发上限，让 WOC 的 priority 失效。
//       3. abort / timeout 触发时，无论 entry 是 queued 还是 running，
//          都立即 settle 为 canceled。in-flight 立即让 inFlight 归零；
//          handler 后续 resolve/reject 走 settled=true 守卫 no-op。
//       4. target 并发由 HandlerOptions.concurrency 配置；同 target 全
//          部 handler 注册时必须使用一致值（否则抛英文错误），缺省 1。
//   - 阶段 1 的 dispatch / request 仅在 handler 带 target 时启用；纯业务
//     事件保持同步 publish 行为，避免破坏 key.deleting / key.deleted 时序。
//   - 关键不变量：dispatch / request 的 message envelope 会带上 messageBus
//     内部维护的 signal（= upstream signal + timeout 触发的 ctl），handler
//     通过 message.signal 监听取消；timeout 触发时先 abort 再 settle。

import type {
  DispatchOptions,
  EventHandler,
  HandlerOptions,
  Message,
  MessageBus,
  MessageBusSnapshot,
  MessageHandler,
  MessageMode,
  PublishOptions,
  RequestOptions
} from "../contracts/messageBus.js";

type MailboxState = "queued" | "running" | "completed" | "failed" | "canceled";
type EntrySettleState = "completed" | "failed" | "canceled";

interface MailboxEntry {
  message: Message;
  signal: AbortSignal;
  /** 标记本 entry 是 dispatch 模式（resolve/reject 即 no-op）还是 request 模式（外层 promise）。 */
  mode: "command" | "request";
  state: MailboxState;
  settled: boolean;
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
  /** settle 时调用：清理 upstream abort listener + clearTimeout + 移除 ctl abort listener。 */
  cleanup: () => void;
  /** 进入任一终态后只调用一次；用于释放调用方的临时生命周期监听。 */
  onSettled?: () => void;
}

interface ActorHandler {
  type: string;
  target: string;
  priority: number;
  /** 同 target 投递并发上限；缺省 1。同 target 全部 handler 必须一致。 */
  concurrency: number;
  handler: MessageHandler;
}

interface SubscriptionRecord {
  type: string;
  handler: EventHandler;
}

function makeMessageId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `m_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e9).toString(36)}`;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return String(err);
}

/** 单个 handler 允许注册的最大并发数；超过即拒绝注册。 */
const MAX_HANDLER_CONCURRENCY = 128;

/**
 * 等待 handler 返回 / 抛错，但允许调用方随时通过 AbortSignal 取消等待。
 * 关键不变量：MessageBus 只能停止等待 handler（释放 worker），不能强制
 * 打断 handler 内部副作用；handler 仍必须监听 `message.signal`。worker
 * 释放后同 target 后续消息可被 pump 立即消费。
 *
 * 同时，原 Promise 仍会被 resolve / reject handler 接管，避免迟到
 * rejection 触发 unhandledRejection。
 */
function waitForHandler(
  result: Promise<unknown>,
  signal: AbortSignal
): Promise<unknown> {
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new Error("aborted"));
  }

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      reject(signal.reason ?? new Error("aborted"));
    };

    signal.addEventListener("abort", onAbort, { once: true });

    result.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

export function createMessageBus(): MessageBus {
  // event 订阅表：type -> handlers
  const subscriptions = new Map<string, Set<SubscriptionRecord>>();
  // 强制路由表：type -> handler（用于把 publish 路由到具体实现）
  const routedHandlers = new Map<string, ActorHandler>();
  // actor mailbox：target -> queue
  const mailboxes = new Map<string, MailboxEntry[]>();
  // target -> 已注册的 handler 数量；注销时清 0 才删除 targetConcurrency。
  const targetHandlerCount = new Map<string, number>();
  // target -> 该 target 全部 handler 协商的并发上限。
  const targetConcurrency = new Map<string, number>();
  const snapshotListeners = new Set<(s: MessageBusSnapshot) => void>();
  let total = 0;
  let completed = 0;
  let failed = 0;
  let canceled = 0;
  let inFlight = 0;
  let lastError: string | undefined;
  // 正在 pump 的 target 集合：避免重入。
  const pumping = new Set<string>();

  function emitSnapshot() {
    const snap = snapshot();
    for (const l of snapshotListeners) l(snap);
  }

  function snapshot(): MessageBusSnapshot {
    const byTarget: Record<string, number> = {};
    let queued = 0;
    for (const [target, queue] of mailboxes.entries()) {
      byTarget[target] = queue.length;
      queued += queue.length;
    }
    return {
      total,
      queued,
      inFlight,
      completed,
      failed,
      canceled,
      lastError,
      byTarget
    };
  }

  function makeMessage<TPayload>(
    type: string,
    mode: MessageMode,
    payload: TPayload,
    options: { target?: string; priority?: number; timeoutMs?: number; causationId?: string; messageId?: string }
  ): Message<TPayload> {
    return {
      id: options.messageId ?? makeMessageId(),
      type,
      mode,
      payload,
      target: options.target,
      priority: options.priority,
      timeoutMs: options.timeoutMs,
      causationId: options.causationId,
      createdAt: Date.now()
    };
  }

  function publishInternal<TPayload>(message: Message<TPayload>): string {
    total += 1;
    // 1) 同步路由：先看 routedHandlers（handle 注册但无 target 时被 publish 视为强制目标）。
    // 带 target 的 handler 属于 actor mailbox，只允许 dispatch/request 触发；
    // publish 主动绕过会让绕过 concurrency / abort / timeout 管控。
    const routed = routedHandlers.get(message.type);
    if (routed && !routed.target) {
      try {
        const result = routed.handler(message as Message);
        if (result && typeof (result as Promise<unknown>).then === "function") {
          // 不等待异步 handler；仅记录 lastError。
          (result as Promise<unknown>).catch((err) => {
            failed += 1;
            lastError = errorMessage(err);
            emitSnapshot();
          });
        }
      } catch (err) {
        failed += 1;
        lastError = errorMessage(err);
      }
    }
    // 2) 同步广播给订阅者
    const bucket = subscriptions.get(message.type);
    if (bucket) {
      // 拷贝一份以容忍 handler 中取消订阅。
      for (const sub of [...bucket]) {
        try {
          sub.handler(message.payload);
        } catch (err) {
          failed += 1;
          lastError = errorMessage(err);
        }
      }
    }
    emitSnapshot();
    return message.id;
  }

  /**
   * 唯一终态函数。
   * - 守卫：若已 settled，no-op；这是避免重复计数的关键。
   * - 唯一修改 entry.settled / entry.state / inFlight / completed /
   *   failed / canceled / lastError 的入口。
   * - 副作用顺序：settled → state → cleanup → 计数 → 快照 → resolve/reject。
   */
  function settleEntry(entry: MailboxEntry, state: EntrySettleState, value?: unknown): void {
    if (entry.settled) return;
    entry.settled = true;
    const wasRunning = entry.state === "running";
    entry.state = state;
    entry.cleanup();
    if (state === "completed") {
      completed += 1;
    } else if (state === "failed") {
      failed += 1;
      lastError = errorMessage(value);
    } else {
      canceled += 1;
      lastError = errorMessage(value ?? entry.signal.reason);
    }
    if (wasRunning) inFlight -= 1;
    emitSnapshot();
    try {
      entry.onSettled?.();
    } catch (err) {
      // 终态清理属于观察/生命周期回调，不能改变已经提交的消息结果。
      lastError = errorMessage(err);
    }
    if (entry.mode === "request") {
      if (state === "completed") entry.resolve(value);
      else entry.reject(value);
    }
    // dispatch 模式：resolve / reject 即 no-op，调用方拿不到结果。
  }

  /**
   * dispatch / request 共享的入队核心。
   *  - 找到 handler：消息入 mailbox，pump worker 并发消费。
   *  - 找不到 handler：写 lastError + failed；dispatch 静默（return id），
   *    request 立即 reject。
   *  - signal 已 abort：写 lastError + canceled；dispatch 静默，request 立即 reject。
   *  - 内部 ctl 由 MessageBus 维护，组合 upstream signal + timeout；handler
   *    通过 message.signal 监听。
   *  - abort listener 统一处理：queued 移除 mailbox、running 仍 settle，
   *    两者都走 settleEntry("canceled")。handler 后续 resolve/reject 因
   *    settled=true 全部 no-op。
   */
  function enqueueMessage(message: Message, mode: "command" | "request", signal: AbortSignal | undefined, onSettled?: () => void): string | Promise<unknown> {
    total += 1;
    const target = message.target;
    if (!target) {
      failed += 1;
      lastError = `MessageBus.${mode === "request" ? "request" : "dispatch"} requires a target`;
      emitSnapshot();
      try { onSettled?.(); } catch { /* 生命周期清理不能阻断错误结果 */ }
      return mode === "request" ? Promise.reject(new Error(lastError)) : message.id;
    }
    const handler = routedHandlers.get(message.type);
    if (!handler || handler.target !== target) {
      failed += 1;
      lastError = `No handler registered for type "${message.type}" at target "${target}"`;
      emitSnapshot();
      try { onSettled?.(); } catch { /* 生命周期清理不能阻断错误结果 */ }
      return mode === "request" ? Promise.reject(new Error(lastError)) : message.id;
    }
    if (signal?.aborted) {
      canceled += 1;
      lastError = errorMessage(signal.reason ?? new Error("aborted"));
      emitSnapshot();
      try { onSettled?.(); } catch { /* 生命周期清理不能阻断错误结果 */ }
      return mode === "request" ? Promise.reject(signal.reason ?? new Error("aborted")) : message.id;
    }

    const ctl = new AbortController();
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const onUpstreamAbort = () => {
      ctl.abort(signal?.reason ?? new Error("aborted"));
    };
    if (signal) {
      signal.addEventListener("abort", onUpstreamAbort, { once: true });
    }
    if (typeof message.timeoutMs === "number" && message.timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        ctl.abort(new Error("MessageBus.request timeout"));
      }, message.timeoutMs);
    }
    // 把 messageBus 维护的 ctl.signal 注入 envelope，handler 监听它。
    const stamped: Message = { ...message, signal: ctl.signal };
    const mailbox = mailboxes.get(target) ?? [];
    mailboxes.set(target, mailbox);

    return new Promise<unknown>((resolve, reject) => {
      const entry: MailboxEntry = {
        message: stamped,
        signal: ctl.signal,
        mode,
        state: "queued",
        settled: false,
        resolve: (v) => resolve(v),
        reject: (e) => reject(e),
        onSettled,
        cleanup: () => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          if (signal) signal.removeEventListener("abort", onUpstreamAbort);
          ctl.signal.removeEventListener("abort", onAbort);
        }
      };
      function onAbort() {
        // 关键不变量：queued 移除 mailbox；running 不动 mailbox。
        // 两者都立即 settle 为 canceled。in-flight 由此让 inFlight 归零。
        if (entry.state === "queued") {
          const idx = mailbox.indexOf(entry);
          if (idx >= 0) {
            mailbox.splice(idx, 1);
          }
        }
        settleEntry(entry, "canceled", ctl.signal.reason ?? new Error("aborted"));
      }
      ctl.signal.addEventListener("abort", onAbort, { once: true });
      mailbox.push(entry);
      emitSnapshot();
      schedulePump(target);
    });
  }

  function schedulePump(target: string) {
    if (pumping.has(target)) return;
    const mailbox = mailboxes.get(target);
    if (!mailbox || mailbox.length === 0) return;
    pumping.add(target);
    if (typeof queueMicrotask === "function") {
      queueMicrotask(() => {
        void runPump(target);
      });
    } else {
      Promise.resolve().then(() => {
        void runPump(target);
      });
    }
  }

  /**
   * Pump 顶层：N 个 worker 并行 await handler。N 由 targetConcurrency
   * 决定，缺省 1。所有 worker 退出后再 cleanup；若有新 entry 在退出前
   * 入 mailbox，finally 阶段重新 schedulePump。
   */
  async function runPump(target: string) {
    const concurrency = targetConcurrency.get(target) ?? 1;
    const workers: Promise<void>[] = [];
    for (let i = 0; i < concurrency; i += 1) {
      workers.push(workerLoop(target, i));
    }
    try {
      await Promise.all(workers);
    } finally {
      pumping.delete(target);
      // Race: enqueueMessage 可能在该 worker 退出后、finally 之前压入新 entry。
      const mailbox = mailboxes.get(target);
      if (mailbox && mailbox.length > 0) {
        schedulePump(target);
      }
      emitSnapshot();
    }
  }

  async function workerLoop(target: string, workerId: number) {
    // 每个 worker 持续拉 best entry；mailbox 空则本 worker 退出。
    // 其他 worker 仍在跑；Promise.all 等所有 worker 退出后才回收 pump。
    void workerId;
    while (true) {
      const entry = pickBestEntry(target);
      if (!entry) return;
      await processEntry(target, entry);
    }
  }

  function pickBestEntry(target: string): MailboxEntry | undefined {
    const mailbox = mailboxes.get(target);
    if (!mailbox || mailbox.length === 0) return undefined;
    let bestIdx = -1;
    let bestEntry: MailboxEntry | undefined;
    for (let i = 0; i < mailbox.length; i += 1) {
      const cur = mailbox[i]!;
      // 防御：onAbort 已把 queued 移除；运行中不会被 pickBest 看到。
      if (cur.settled) continue;
      if (!bestEntry) {
        bestEntry = cur;
        bestIdx = i;
        continue;
      }
      const bestPriority = (bestEntry.message.priority ?? 0) as number;
      const curPriority = (cur.message.priority ?? 0) as number;
      if (curPriority > bestPriority ||
          (curPriority === bestPriority && cur.message.createdAt < bestEntry.message.createdAt)) {
        bestEntry = cur;
        bestIdx = i;
      }
    }
    if (bestEntry && bestIdx >= 0) {
      mailbox.splice(bestIdx, 1);
    }
    return bestEntry;
  }

  async function processEntry(target: string, entry: MailboxEntry): Promise<void> {
    // pickBestEntry 已把 entry 移出 mailbox。此处 settled 可能为 true
    // （abort listener 在我们执行 sync 块之前已跑完）。但 JS 单线程
    // 保证了下面的赋值与 abort listener 不会在中间插入。
    if (entry.settled) return;
    entry.state = "running";
    inFlight += 1;
    emitSnapshot();
    const handler = routedHandlers.get(entry.message.type);
    if (!handler) {
      settleEntry(entry, "failed", new Error(`No handler for type "${entry.message.type}"`));
      return;
    }
    try {
      const result = handler.handler(entry.message as Message);
      if (result && typeof (result as Promise<unknown>).then === "function") {
        // waitForHandler：abort 触发时只停止等待并立即 settle 为 canceled；
        // handler 内部副作用由 handler 自己监听 message.signal 取消。
        // 原 Promise 仍由 waitForHandler 接管，避免迟到 rejection 触发
        // unhandledRejection。
        const v = await waitForHandler(
          result as Promise<unknown>,
          entry.signal
        );
        // 关键：await 期间 abort 可能已触发并 settle 为 canceled；本调用 no-op。
        if (entry.signal.aborted) {
          settleEntry(entry, "canceled", entry.signal.reason);
        } else {
          settleEntry(entry, "completed", v);
        }
      } else {
        if (entry.signal.aborted) {
          settleEntry(entry, "canceled", entry.signal.reason);
        } else {
          settleEntry(entry, "completed", result);
        }
      }
    } catch (err) {
      if (entry.signal.aborted) {
        // 关键：abort 优先，错误信息不污染 lastError。
        settleEntry(entry, "canceled", entry.signal.reason ?? err);
      } else {
        settleEntry(entry, "failed", err);
      }
    }
  }

  const bus: MessageBus = {
    publish<TPayload>(type: string, payload: TPayload, options?: PublishOptions): string {
      const message = makeMessage<TPayload>(type, "event", payload, {
        causationId: options?.causationId,
        messageId: options?.messageId
      });
      return publishInternal(message);
    },

    subscribe<TPayload>(type: string, handler: EventHandler<TPayload>): () => void {
      const record: SubscriptionRecord = { type, handler: handler as EventHandler };
      let bucket = subscriptions.get(type);
      if (!bucket) {
        bucket = new Set();
        subscriptions.set(type, bucket);
      }
      bucket.add(record);
      return () => {
        bucket?.delete(record);
      };
    },

    dispatch<TPayload>(type: string, payload: TPayload, options: DispatchOptions): string {
      const message = makeMessage<TPayload>(type, "command", payload, {
        target: options.target,
        priority: options.priority,
        timeoutMs: options.timeoutMs,
        causationId: options.causationId,
        messageId: options.messageId
      });
      const result = enqueueMessage(message, "command", options.signal, options.onSettled);
      // enqueueMessage 在 command 模式下不会 reject；但类型系统要求同步返回 string。
      if (typeof result === "string") return result;
      // 防御：理论上 command 模式只会返回 string。
      return message.id;
    },

    request<TPayload, TResult>(type: string, payload: TPayload, options: RequestOptions): Promise<TResult> {
      const message = makeMessage<TPayload>(type, "request", payload, {
        target: options.target,
        priority: options.priority,
        timeoutMs: options.timeoutMs,
        causationId: options.causationId,
        messageId: options.messageId
      });
      const result = enqueueMessage(message, "request", options.signal, options.onSettled);
      if (typeof result === "string") {
        return Promise.reject(new Error("MessageBus.request returned a string id unexpectedly"));
      }
      return result as Promise<TResult>;
    },

    handle<TPayload, TResult>(type: string, handler: MessageHandler<TPayload, TResult>, options?: HandlerOptions): () => void {
      // 关键不变量：校验必须发生在修改 routedHandlers / targetConcurrency /
      // targetHandlerCount / mailboxes 之前，避免注册失败后留下半初始化状态。
      const concurrency = options?.concurrency ?? 1;
      if (
        !Number.isFinite(concurrency) ||
        !Number.isInteger(concurrency) ||
        concurrency <= 0
      ) {
        throw new Error("Handler concurrency must be a positive integer");
      }
      if (concurrency > MAX_HANDLER_CONCURRENCY) {
        throw new Error(
          `Handler concurrency must not exceed ${MAX_HANDLER_CONCURRENCY}`
        );
      }
      const record: ActorHandler = {
        type,
        target: options?.target ?? "",
        priority: options?.priority ?? 0,
        concurrency,
        handler: handler as MessageHandler
      };
      if (routedHandlers.has(type)) {
        throw new Error(`Handler for "${type}" is already registered`);
      }
      if (record.target) {
        // 同 target 全部 handler 必须使用一致 concurrency。
        const existing = targetConcurrency.get(record.target);
        if (existing !== undefined && existing !== concurrency) {
          throw new Error(`Conflicting concurrency for target "${record.target}"`);
        }
        targetConcurrency.set(record.target, concurrency);
        targetHandlerCount.set(record.target, (targetHandlerCount.get(record.target) ?? 0) + 1);
        if (!mailboxes.has(record.target)) {
          mailboxes.set(record.target, []);
        }
        // 已有 enqueue 的消息可以直接 pump。
        schedulePump(record.target);
      }
      routedHandlers.set(type, record);
      return () => {
        if (routedHandlers.get(type) === record) {
          routedHandlers.delete(type);
          if (record.target) {
            const count = (targetHandlerCount.get(record.target) ?? 1) - 1;
            if (count <= 0) {
              targetHandlerCount.delete(record.target);
              targetConcurrency.delete(record.target);
            } else {
              targetHandlerCount.set(record.target, count);
            }
          }
        }
      };
    },

    snapshot,
    onSnapshot(handler) {
      snapshotListeners.add(handler);
      handler(snapshot());
      return () => snapshotListeners.delete(handler);
    }
  };

  return bus;
}
