// 私有调用的授权有效期在两端接收路径上的统一实现（PSM-R13）。
//
// 规则（RPC 与 stream 相同）：
//   1. 进入 handler 之前核对「机密 + 存活实例」，并在授权等待结束后复核同一实例；
//   2. 撤销发生时把取消信号合并进 handler 看到的 `context.signal`；
//   3. RPC：handler 返回后**再复核一次**，已失效就拒绝发布迟到结果；
//   4. stream：授权绑定持续到流结束或取消——每次取下一项前复核，失效即停止并清理
//      iterator，撤销后的后续 item 不会到达消费者；
//   5. 无论走哪条路径，订阅与合并信号都在调用真正结束时清理。

/** 流式输出的最小形状（AsyncIterable 的结构化子集）。 */
type StreamIterable = AsyncIterable<unknown> & {
  next?: (...args: never[]) => Promise<IteratorResult<unknown>>;
  return?: (...args: never[]) => Promise<IteratorResult<unknown>>;
  throw?: (...args: never[]) => Promise<IteratorResult<unknown>>;
};

/**
 * 清理阶段等待真正结束的默认预算（毫秒）。
 *
 * 与其他 bounded drain 同量级：达到预算时**不**把清理当成完成，而是保留未完成状态与执行
 * 占用，并把失败如实抛给消费者。
 */
export const PRIVATE_STREAM_CLOSE_DRAIN_TIMEOUT_MS = 30_000;

/**
 * 清理循环每隔多少项让出一次事件循环。
 *
 * 清理阶段可能持续产出且每次都立即完成；如果一直占用微任务队列，预算定时器、取消与其他
 * 请求都得不到运行，bounded drain 就形同虚设。这个批次**只用于调度**，绝不当作"清理完成"
 * 的判据。
 */
const PRIVATE_STREAM_DRAIN_YIELD_INTERVAL = 32;

/**
 * 包装器暴露的「底层清理真实完成」信号。
 *
 * provider 必须靠这个可信信号判断清理是否真的结束，而不是通过调用 `next()` 推断——超时后
 * `next()` 会立刻返回 `done:true`，用它推断会误判成"清理完成"并提前释放执行名额。
 */
export const PRIVATE_STREAM_CLEANUP_SIGNAL = Symbol("webloom.privateStreamCleanup");

/** 读取包装器提供的底层清理完成信号（非包装器返回 undefined）。 */
export function streamCleanupCompletion(iterable: unknown): Promise<void> | undefined {
  if (!iterable || (typeof iterable !== "object" && typeof iterable !== "function")) return undefined;
  const signal = (iterable as Record<symbol, unknown>)[PRIVATE_STREAM_CLEANUP_SIGNAL];
  return signal instanceof Promise ? signal as Promise<void> : undefined;
}

/** 一次私有调用的授权有效期。 */
export interface PrivateCallValidity {
  /** 撤销原因；未撤销时 undefined。 */
  readonly aborted: boolean;
  /** 撤销原因（供 handler/stream 观察）。 */
  readonly reason: unknown;
  /** 清理订阅与合并信号。 */
  release(): void;
}

/** 是否为异步可迭代（stream handler 的返回值）。 */
export function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return value !== null && typeof value === "object" && typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function";
}

/**
 * RPC 结果发布前的复核：授权已经失效就抛错，让 provider 拒绝而不是发布迟到结果。
 */
export function assertPrivateResultPublishable(validity: PrivateCallValidity, recheck: () => string | undefined, identity: string): void {
  if (validity.aborted) throw validity.reason;
  if (recheck() !== identity) {
    throw new Error("Private capability consumer instance was revoked before the result was published");
  }
}

/**
 * 给 stream 输出加授权拦截：绑定持续到流结束或取消（PSM-R13）。
 *
 * 每次 `next()` 前复核授权；已失效时停止迭代、调用 iterator 的 `return()` 清理，
 * 并让消费者看到流结束而不是后续 item。
 */
export function guardPrivateStream(
  source: AsyncIterable<unknown>,
  input: {
    readonly validity: PrivateCallValidity;
    readonly recheck: () => string | undefined;
    readonly identity: string;
    /** 清理阶段等待预算（毫秒）；默认见 `PRIVATE_STREAM_CLOSE_DRAIN_TIMEOUT_MS`。 */
    readonly drainTimeoutMs?: number;
    /** 底层清理迟到完成时的通知（provider 借此回收执行名额）。 */
    readonly onLateCompletion?: () => void;
  },
): AsyncIterable<unknown> {
  // 底层清理的真实完成：provider 订阅它决定执行名额何时回收。
  let cleanupSettled: Promise<void> = Promise.resolve();
  const wrapped: AsyncIterable<unknown> & { [PRIVATE_STREAM_CLEANUP_SIGNAL]?: Promise<void> } = {
    [Symbol.asyncIterator]() {
      const iterator = (source as StreamIterable)[Symbol.asyncIterator]() as StreamIterable;
      // 关闭是幂等的：停止、取消与重复 return() 共用同一个 Promise。
      let userClosePromise: Promise<IteratorResult<unknown>> | undefined;
      const release = (): void => {
        // 自然结束（无底层清理可等）时立即回收；否则由 closeIterator 的真实完成路径回收。
        if (userClosePromise === undefined) input.validity.release();
      };
      /**
       * 关闭：与底层 iterator 的 `return()` 共用一次清理。
       *
       * 清理过程本身可能继续产出（例如生成器在 `finally` 里 yield）：这些值属于清理而不是
       * 数据流，必须在内部消费并丢弃，直到真正结束才向消费者返回 `done:true`。清理完成前
       * 不报告结束，也不释放授权资源（保持"等待 iterator 清理后释放执行名额"的既有语义）。
       */
      /**
       * 关闭：与底层 iterator 的 `return()` 共用一次清理。
       *
       * 两条状态分开跟踪：
       *   - **用户可见**：预算从关闭开始计时，覆盖整个异步清理过程（包括挂起的 `return()`
       *     与挂起的 `next()`）。预算耗尽立刻 reject，不把清理当成完成。
       *   - **底层真实完成**：后台 drain 一直等到 iterator 真正结束；迟到完成时才释放授权
       *     资源并通知 provider 回收执行名额（见 `onLateCompletion`）。
       */
      const closeIterator = (): Promise<IteratorResult<unknown>> => {
        if (userClosePromise !== undefined) return userClosePromise;
        const close = iterator.return;
        const budgetMs = input.drainTimeoutMs ?? PRIVATE_STREAM_CLOSE_DRAIN_TIMEOUT_MS;
        // 底层真实完成：不受用户预算打断，一直等到真正结束。
        const realCompletion: Promise<IteratorResult<unknown>> = (async (): Promise<IteratorResult<unknown>> => {
          if (typeof close !== "function") return { done: true, value: undefined };
          let step: IteratorResult<unknown> | undefined = await close.call(iterator as never);
          let sinceYield = 0;
          while (step !== undefined && !step.done) {
            step = await iterator.next?.();
            sinceYield += 1;
            // 按批次让出事件循环，让预算定时器与其他请求有机会运行。
            if (sinceYield >= PRIVATE_STREAM_DRAIN_YIELD_INTERVAL) {
              sinceYield = 0;
              await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
            }
          }
          return { done: true, value: undefined };
        })();
        // 真实完成（或真实失败）才回收：授权资源与执行名额都挂在这一条上。
        cleanupSettled = realCompletion.then(
          () => { input.validity.release(); input.onLateCompletion?.(); },
          () => { input.validity.release(); input.onLateCompletion?.(); },
        );
        const userClose = new Promise<IteratorResult<unknown>>((resolve, reject) => {
          const timer = setTimeout(() => {
            reject(new Error("Private capability stream cleanup did not finish within the drain budget"));
          }, budgetMs);
          void realCompletion.then(
            (result) => { clearTimeout(timer); resolve(result); },
            (error: unknown) => { clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error))); },
          );
        });
        userClosePromise = userClose;
        return userClose;
      };
      const finished = (): boolean => userClosePromise !== undefined;
      return {
        async next(): Promise<IteratorResult<unknown>> {
          // 关闭超时后不再重复抛错：消费者看到流已结束，底层清理由后台继续并迟到回收。
          if (finished()) return { done: true, value: undefined };
          // 授权在流期间失效（消费实例撤销）：停止并等待底层清理完成。
          if (input.validity.aborted || input.recheck() !== input.identity) return closeIterator();
          const step = await iterator.next?.();
          if (step === undefined) { release(); return { done: true, value: undefined }; }
          if (step.done) { release(); return step; }
          // 产出前再复核一次：防止 handler 在产出过程中被撤销。
          if (input.validity.aborted || input.recheck() !== input.identity) return closeIterator();
          return step;
        },
        async return(): Promise<IteratorResult<unknown>> {
          return closeIterator();
        },
        async throw(error?: unknown): Promise<IteratorResult<unknown>> {
          const raise = iterator.throw;
          if (typeof raise !== "function") { release(); throw error; }
          try { return await (raise as (reason: unknown) => Promise<IteratorResult<unknown>>).call(iterator, error); } finally { release(); }
        },
      };
    },
  };
  Object.defineProperty(wrapped, PRIVATE_STREAM_CLEANUP_SIGNAL, { get: () => cleanupSettled, enumerable: false });
  return wrapped;
}