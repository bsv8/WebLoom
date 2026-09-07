// packages/contracts/src/messageBus.ts
// WebLoom MessageBus 契约：事件、命令、请求统一入口。
//
// 设计缘由：
//   - 旧 EventBus 只能表达"已发生的事件"；系统实际需要命令、请求响应、
//     actor mailbox、限流、取消、超时等多类语义。
//   - 不把 EventBus / CommandBus / ActorBus 并存作为多入口；业务插件
//     只看到一个 MessageBus，由 mode / target 区分消息类型。
//   - envelope 由 type 表达业务含义、mode 表达调用语义、target 表达
//     由哪个 actor mailbox 消费、priority 给调度策略使用、causationId
//     串起同根消息链。
//   - publish / subscribe 必须保持与旧 EventBus 同步调用等价，避免改变
//     vault.unlocked、key.deleted、UI notify 的时序。
//   - 第一阶段只暴露 publish / subscribe / dispatch / request / handle；
//     actor mailbox 的持久化、延迟调度、限流属于具体 actor（如 WOC actor）
//     的内部实现。

/** runtime messageBus capability key；manifest 通过 ctx.get<...> 取出。 */
export const RUNTIME_MESSAGE_BUS = "webloom.messageBus";

/** 消息调用语义。 */
export type MessageMode = "event" | "command" | "request";

/** 消息 envelope。 */
export interface Message<TPayload = unknown> {
  id: string;
  type: string;
  mode: MessageMode;
  payload: TPayload;
  /** 由哪个 actor mailbox 消费。缺省时同步调用 subscriber 或无 mailbox。 */
  target?: string;
  /** 数值越大越优先（actor 内部解读）。 */
  priority?: number;
  /** 超时（ms）；超时后 message 标记为超时失败。 */
  timeoutMs?: number;
  /**
   * MessageBus 内部维护的 abort signal。
   *  - 来自调用方 DispatchOptions.signal 的 upstream 取消会触发。
   *  - 来自 MessageBus 自身的 timeout 触发。
   *  - 来自 actor / MessageBus 内部主动 abort。
   *  handler 应优先用此 signal 取消 fetch 等异步操作；payload.signal 仍
   *  可保留以兼容旧调用方。
   */
  signal?: AbortSignal;
  causationId?: string;
  createdAt: number;
}

/** 消息 handler 签名。 */
export type MessageHandler<TPayload = unknown, TResult = unknown> = (
  message: Message<TPayload>
) => TResult | Promise<TResult>;

/** publish 行为：仅同步广播给订阅者，不等待异步 handler 完成。 */
export interface PublishOptions {
  /** 关联上一条消息（同一业务动作触发的子事件）。 */
  causationId?: string;
  /** 自定义 message id；缺省由 MessageBus 生成。 */
  messageId?: string;
}

/**
 * dispatch 行为：投递给 actor mailbox；返回 messageId。
 *  - target 必填：dispatch 期望被 actor 处理，不退化为 publish 语义。
 *  - 找到 handler 时消息会真正入 mailbox 并被 pump 串行消费。
 *  - 找不到 handler 时消息被记为 failed + lastError，但**不抛**给调用方
 *    （dispatch 不返回结果）。
 */
export interface DispatchOptions extends PublishOptions {
  target: string;
  priority?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** 消息进入终态后调用一次；生命周期 facade 用它释放临时 signal 监听。 */
  onSettled?: () => void;
}

/**
 * request 行为：等待 actor 返回结果；选项语义与 dispatch 完全一致。
 *  - 行为差异：request 返回 Promise<TResult>，handler reject 即 promise reject。
 *  - 找不到 handler / no target 时立即 reject。
 *  - timeoutMs 触发时会先 abort 内部 signal，再 reject 外层 promise；
 *    handler 内部应该监听 message.signal 取消 fetch。
 */
export type RequestOptions = DispatchOptions;

/** handle 注册选项。 */
export interface HandlerOptions {
  target?: string;
  priority?: number;
  /**
   * 同 target 投递并发上限。
   * 缺省 1：同 target actor 严格串行。
   * 同 target 全部 handler 注册时必须使用一致 concurrency，否则
   * MessageBus 抛 `Conflicting concurrency for target "..."`。
   * 注意：这是 MessageBus 投递并发，不是 handler 内部副作用（如网络
   * 请求）的并发；高并发适合"内部 actor 自己做限流"的场景（如 WOC
   * 内部 mailbox）。
   */
  concurrency?: number;
}

/** 快照。 */
export interface MessageBusSnapshot {
  /** 消息总数（含已完成、失败、被取消）。 */
  total: number;
  /** 队列中尚未处理的消息数。 */
  queued: number;
  /** 飞行中消息数。 */
  inFlight: number;
  /** 已成功完成的消息数。 */
  completed: number;
  /** handler 抛错或被 lastError 路径标记失败的消息数。 */
  failed: number;
  /** 被 abort signal 取消的消息数。 */
  canceled: number;
  /** 最近一次错误。 */
  lastError?: string;
  /** 各 target 队列长度。 */
  byTarget: Record<string, number>;
}

/** 订阅事件快捷方式：仅接收 mode=event 的消息。 */
export type EventHandler<TPayload = unknown> = (payload: TPayload) => void;

/**
 * MessageBus 契约。
 * 设计缘由：业务插件调用方只看到这一套入口。
 */
export interface MessageBus {
  /** 事件广播：已发生的事实，不等待业务完成；同步调用 subscriber。 */
  publish<TPayload>(type: string, payload: TPayload, options?: PublishOptions): string;

  /** 事件订阅：仅接收 mode=event 的消息；返回取消订阅函数。 */
  subscribe<TPayload>(type: string, handler: EventHandler<TPayload>): () => void;

  /**
   * 命令投递：把消息入 actor mailbox，返回 messageId。
   *  不等待 handler 完成；handler 抛错 / 超时 / 找不到 handler 仅写
   *  snapshot.lastError，不冒泡。
   */
  dispatch<TPayload>(type: string, payload: TPayload, options: DispatchOptions): string;

  /** 请求响应：等待 actor 返回结果。 */
  request<TPayload, TResult>(
    type: string,
    payload: TPayload,
    options: RequestOptions
  ): Promise<TResult>;

  /** 注册 handler：带 target 时进入对应 actor mailbox。 */
  handle<TPayload, TResult>(
    type: string,
    handler: MessageHandler<TPayload, TResult>,
    options?: HandlerOptions
  ): () => void;

  /** 快照。 */
  snapshot(): MessageBusSnapshot;

  /** 订阅快照变更。 */
  onSnapshot(handler: (snapshot: MessageBusSnapshot) => void): () => void;
}
