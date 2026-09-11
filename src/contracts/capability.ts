// WebLoom v4 capability 契约。
//
// Capability 对象是 realm 内的运行时契约；跨 realm 只发送
// capabilityDescriptor() 产生的静态 DTO。这样 parser、transfer extractor
// 和 handler 永远不会进入 manifest 或 wire。

import type { LifecycleScope, RuntimeKind } from "./lifecycle.js";

/** 验证 unknown 并返回领域类型的生产 parser。 */
export interface ValueParser<T> {
  /** 验证 unknown；失败必须抛出校验错误。 */
  parse(value: unknown): T;
}

/** 从已经通过 parser 的值中提取可转移资源。 */
export type TransferExtractor<T> = (value: T) => readonly Transferable[];

/** RPC 请求与结果的契约级 transfer 声明。 */
export interface RpcTransferDescriptor<TRequest, TResponse> {
  /** 从规范化请求中提取可转移资源。 */
  readonly request?: TransferExtractor<TRequest>;
  /** 从规范化结果中提取可转移资源。 */
  readonly response?: TransferExtractor<TResponse>;
}

/** stream 订阅请求与 item 的契约级 transfer 声明。 */
export interface StreamTransferDescriptor<TRequest, TItem> {
  /** 从规范化订阅请求中提取可转移资源。 */
  readonly request?: TransferExtractor<TRequest>;
  /** 从规范化 item 中提取可转移资源。 */
  readonly item?: TransferExtractor<TItem>;
}

export type CapabilityKind = "local" | "rpc" | "stream";

/** 可序列化的 capability 身份；不包含 parser、transfer 或 handler。 */
export interface CapabilityDescriptor {
  /** capability 行为形态。 */
  readonly kind: CapabilityKind;
  /** 稳定业务标识。 */
  readonly id: string;
  /** 精确业务契约版本。 */
  readonly version: string;
}

declare const localServiceType: unique symbol;
declare const rpcRequestType: unique symbol;
declare const rpcResponseType: unique symbol;
declare const streamRequestType: unique symbol;
declare const streamItemType: unique symbol;

/** local capability；只在同一 realm 提供/消费，不可远程调用。 */
export interface LocalCapability<TService = unknown> extends CapabilityDescriptor {
  readonly kind: "local";
  readonly [localServiceType]?: TService;
}

/** RPC capability 的非泛型形状；用于跨不同请求/结果类型的内部集合。 */
export interface RpcCapabilityBase extends CapabilityDescriptor {
  /** 固定 RPC kind。 */
  readonly kind: "rpc";
}

/** stream capability 的非泛型形状；用于跨不同请求/item 类型的内部集合。 */
export interface StreamCapabilityBase extends CapabilityDescriptor {
  /** 固定 stream kind。 */
  readonly kind: "stream";
}

/** typed unary RPC capability。 */
export interface RpcCapability<TRequest, TResponse> extends RpcCapabilityBase {
  readonly kind: "rpc";
  /** 请求边界 parser。 */
  readonly request: ValueParser<TRequest>;
  /** 结果边界 parser。 */
  readonly response: ValueParser<TResponse>;
  /** 请求/结果资源所有权声明。 */
  readonly transfer?: RpcTransferDescriptor<TRequest, TResponse>;
  readonly [rpcRequestType]?: TRequest;
  readonly [rpcResponseType]?: TResponse;
}

/** typed back-pressure stream capability。 */
export interface StreamCapability<TRequest, TItem> extends StreamCapabilityBase {
  readonly kind: "stream";
  /** 订阅请求边界 parser。 */
  readonly request: ValueParser<TRequest>;
  /** item 边界 parser。 */
  readonly item: ValueParser<TItem>;
  /** item 资源所有权声明。 */
  readonly transfer?: StreamTransferDescriptor<TRequest, TItem>;
  readonly [streamRequestType]?: TRequest;
  readonly [streamItemType]?: TItem;
}

export type RemoteCapability = RpcCapabilityBase | StreamCapabilityBase;
export type Capability = LocalCapability<unknown> | RpcCapabilityBase | StreamCapabilityBase;

export type RequestOf<C extends Capability> = C extends RpcCapability<infer TRequest, infer _TResponse>
  ? TRequest
  : C extends StreamCapability<infer TRequest, infer _TItem>
    ? TRequest
    : never;

export type ResponseOf<C extends Capability> = C extends RpcCapability<infer _TRequest, infer TResponse>
  ? TResponse
  : never;

export type ItemOf<C extends Capability> = C extends StreamCapability<infer _TRequest, infer TItem>
  ? TItem
  : never;

export type LocalServiceOf<C extends Capability> = C extends LocalCapability<infer TService>
  ? TService
  : never;

/** 单次调用的公开选项；callId 由框架生成，operationId 由产品传入。 */
export interface RpcCallOptions {
  /** 调用方撤销信号。 */
  readonly signal?: AbortSignal;
  /** 从本次 call 开始计算的总截止时间预算。 */
  readonly timeoutMs?: number;
  /** 产品审计/幂等标识；框架不自动去重或重放。 */
  readonly operationId?: string;
}

/** typed unary 客户端。 */
export interface RpcClient<C extends RpcCapabilityBase> {
  /** 使用 capability parser 约束请求和结果。 */
  call(request: RequestOf<C>, options?: RpcCallOptions): Promise<ResponseOf<C>>;
}

/** stream 订阅选项。 */
export interface StreamSubscribeOptions<TItem> extends RpcCallOptions {
  /** 每个 item 交付完成后才归还一个 credit。 */
  readonly onNext: (item: TItem) => void | Promise<void>;
  /** 初始窗口；默认 16，最大 256。 */
  readonly initialCredit?: number;
}

/** 一个 typed stream 的本端生命周期。 */
export interface StreamSubscription<TItem> {
  /** 远端已建立订阅并发送 streamReady 后 resolve。 */
  readonly ready: Promise<void>;
  /** 正常 done 时 resolve，错误/撤销时 reject。 */
  readonly closed: Promise<void>;
  /** 幂等取消；立即阻止本地新 item 回调。 */
  cancel(reason?: string): void;
}

/** typed stream 客户端。 */
export interface StreamClient<C extends StreamCapabilityBase> {
  /** 建立一个有界 credit 的订阅。 */
  subscribe(request: RequestOf<C>, options: StreamSubscribeOptions<ItemOf<C>>): StreamSubscription<ItemOf<C>>;
}

/** 按 capability 形态推导消费端返回值。 */
export type CapabilityClient<C extends Capability> = C extends LocalCapability<infer TService>
  ? TService
  : C extends RpcCapabilityBase
    ? RpcClient<Extract<C, RpcCapabilityBase>>
    : C extends StreamCapabilityBase
      ? StreamClient<Extract<C, StreamCapabilityBase>>
      : never;

/** handler 调用来源。 */
export type HandlerOrigin = "local" | "remote";

/** 普通 handler 可见的 peer 作用域视图；不含任何管理/创建方法。 */
export interface PeerScopeView {
  /** 当前连接作用域状态。 */
  readonly state: "active" | "stopping" | "stopped";
  /** 连接撤销信号。 */
  readonly signal: AbortSignal;
  /** 订阅连接撤销；返回函数只能取消本次监听。 */
  onRevoke(listener: (reason: string) => void): () => void;
}

/** 服务绑定身份；由框架创建，不能从 request 覆盖。 */
export interface ServiceReference {
  /** capability 行为形态。 */
  readonly kind: "rpc" | "stream";
  /** 稳定 capability 标识。 */
  readonly capabilityId: string;
  /** 精确契约版本。 */
  readonly contractVersion: string;
  /** 提供者真实 Runtime。 */
  readonly runtime: "window-main" | "shared-worker";
  /** 提供者 Runtime 一次启动身份。 */
  readonly runtimeInstanceId: string;
  /** 一次 exposure 身份；撤销后永不复用。 */
  readonly serviceInstanceId: string;
  /** 已复制/冻结的无环公开属性。 */
  readonly attributes: Readonly<Record<string, unknown>>;
  /** 可选领域授权标识；不是认证凭据。 */
  readonly grantId?: string;
  /** 授权策略修订。 */
  readonly authorizationRevision?: number;
}

/** 远程调用的绑定对端只读视图。 */
export interface CapabilityPeer {
  /** 对端连接的不可复用身份。 */
  readonly peerId: string;
  /** 已观察到的对端 Runtime 类型；首个快照前为空。 */
  readonly runtime?: RuntimeKind;
  /** 已观察到的对端 Runtime 一次启动身份；首个快照前为空。 */
  readonly runtimeInstanceId?: string;
  /** 对端连接 Scope。 */
  readonly scope: PeerScopeView;
  /** 获取当前 peer 上的 typed 能力。 */
  capability<C extends RemoteCapability>(capability: C): CapabilityClient<C>;
}

/** 插件的 typed capability 依赖；静态清单只保存 capabilityDescriptor。 */
interface CapabilityDependencyMetadata {
  /** 缺失时只关闭局部功能。 */
  readonly optional?: boolean;
  /** 面向诊断的依赖说明。 */
  readonly reason?: string;
}

/** 当前 Runtime（或明确的另一个 Runtime）的依赖。 */
export type RuntimeCapabilityDependency<C extends Capability = Capability> = CapabilityDependencyMetadata & {
  /** 要求的 capability 对象。 */
  readonly capability: C;
  /** 跨 Runtime 的精确来源；省略表示当前 Runtime。 */
  readonly sourceRuntime?: RuntimeKind;
  /** 与 peer 来源互斥。 */
  readonly source?: never;
};

/** 按一次远程调用解析的 peer 依赖；不进入全局启动依赖图。 */
export type PeerCapabilityDependency<C extends RemoteCapability = RemoteCapability> = CapabilityDependencyMetadata & {
  /** 要求的远程 capability 对象。 */
  readonly capability: C;
  /** 能力来自当前调用绑定的 peer。 */
  readonly source: "peer";
  /** peer 依赖不能伪装成固定 Runtime 依赖。 */
  readonly sourceRuntime?: never;
};

/** 插件 typed capability 依赖；source 与 sourceRuntime 不能同时出现。 */
export type CapabilityDependency<C extends Capability = Capability> = C extends LocalCapability<unknown>
  ? RuntimeCapabilityDependency<C>
  : RuntimeCapabilityDependency<C> | PeerCapabilityDependency<Extract<C, RemoteCapability>>;

/** 远程 capability bridge 的最小内部/advanced 契约。 */
export interface CapabilityBridge {
  /** 当前连接状态。 */
  readonly state: "empty" | "ready" | "stale" | "disposed";
  /** 当前连接的远端 Runtime 身份。 */
  readonly runtimeInstanceId?: string;
  /** 当前已观察到的对端 Runtime 类型；快照到达前为空。 */
  readonly runtimeKind?: RuntimeKind;
  /** 取惰性 typed client；没有服务时不在此处同步失败。 */
  getClient<C extends RemoteCapability>(capability: C, scope?: LifecycleScope): CapabilityClient<C>;
  /** 应用一个完整对端目录。 */
  applySnapshot(snapshot: import("./lifecycle.js").RuntimeSnapshot): import("./lifecycle.js").SnapshotApplyResult;
  /** 同步撤销全部旧代理。 */
  invalidate(reason?: string): void;
  /** 连接断开；旧代理永久失效。 */
  disconnect(reason?: string): void;
  /** 永久销毁 bridge。 */
  dispose(reason?: string): void;
  /** 订阅目录/连接状态变化。 */
  subscribe(listener: () => void): () => void;
  /** 当前已发布的完整服务引用。 */
  services(): readonly ServiceReference[];
}

/** handler 收到的框架绑定调用上下文。 */
export interface HandlerCallContext {
  /** 取消信号。 */
  readonly signal: AbortSignal;
  /** 调用总截止时间的 epoch 毫秒值。 */
  readonly deadlineAt: number;
  /** 产品操作 ID。 */
  readonly operationId?: string;
  /** 当前服务 exposure 身份。 */
  readonly reference: ServiceReference;
  /** 调用来源。 */
  readonly origin: HandlerOrigin;
  /** 远程调用的框架绑定对端；local 调用必为 undefined。 */
  readonly peer?: CapabilityPeer;
}

export type RpcHandler<C extends RpcCapabilityBase> = (
  request: RequestOf<C>,
  call: HandlerCallContext,
) => ResponseOf<C> | Promise<ResponseOf<C>>;

export type StreamHandler<C extends StreamCapabilityBase> = (
  request: RequestOf<C>,
  call: HandlerCallContext,
) => AsyncIterable<ItemOf<C>> | Promise<AsyncIterable<ItemOf<C>>>;

export interface DefineLocalCapabilityOptions {
  /** 固定 capability kind。 */
  readonly kind: "local";
  /** 非空业务标识。 */
  readonly id: string;
  /** 非空业务契约版本。 */
  readonly version: string;
}

export interface DefineRpcCapabilityOptions<TRequest, TResponse> {
  /** 固定 capability kind。 */
  readonly kind: "rpc";
  /** 非空业务标识。 */
  readonly id: string;
  /** 非空业务契约版本。 */
  readonly version: string;
  /** 请求 parser。 */
  readonly request: ValueParser<TRequest>;
  /** 结果 parser。 */
  readonly response: ValueParser<TResponse>;
  /** 契约级 transfer。 */
  readonly transfer?: RpcTransferDescriptor<TRequest, TResponse>;
}

export interface DefineStreamCapabilityOptions<TRequest, TItem> {
  /** 固定 capability kind。 */
  readonly kind: "stream";
  /** 非空业务标识。 */
  readonly id: string;
  /** 非空业务契约版本。 */
  readonly version: string;
  /** 订阅请求 parser。 */
  readonly request: ValueParser<TRequest>;
  /** item parser。 */
  readonly item: ValueParser<TItem>;
  /** 契约级 transfer。 */
  readonly transfer?: StreamTransferDescriptor<TRequest, TItem>;
}

function assertIdentity(input: { id?: unknown; version?: unknown }): void {
  if (typeof input.id !== "string" || input.id.trim() === "") {
    throw new TypeError("Capability id must be a non-empty string");
  }
  if (typeof input.version !== "string" || input.version.trim() === "") {
    throw new TypeError(`Capability "${input.id}" version must be a non-empty string`);
  }
}

function assertParser(value: unknown, label: string): void {
  if (!value || typeof value !== "object" || typeof (value as { parse?: unknown }).parse !== "function") {
    throw new TypeError(`${label} must expose parse(value)`);
  }
}

/** 定义 local capability；local 不携带 wire parser，也不能跨 Runtime。 */
export function defineCapability<TService>(options: DefineLocalCapabilityOptions): LocalCapability<TService>;
/** 定义 typed unary RPC；request/response parser 是强制边界。 */
export function defineCapability<TRequest, TResponse>(options: DefineRpcCapabilityOptions<TRequest, TResponse>): RpcCapability<TRequest, TResponse>;
/** 定义 typed stream；request/item parser 是强制边界。 */
export function defineCapability<TRequest, TItem>(options: DefineStreamCapabilityOptions<TRequest, TItem>): StreamCapability<TRequest, TItem>;
export function defineCapability(options: DefineLocalCapabilityOptions | DefineRpcCapabilityOptions<unknown, unknown> | DefineStreamCapabilityOptions<unknown, unknown>): Capability {
  assertIdentity(options);
  if (options.kind === "rpc") {
    assertParser(options.request, "RPC request parser");
    assertParser(options.response, "RPC response parser");
  }
  if (options.kind === "stream") {
    assertParser(options.request, "stream request parser");
    assertParser(options.item, "stream item parser");
  }
  return Object.freeze({ ...options });
}

/** 产生不含函数的静态 capability DTO。 */
export function capabilityDescriptor(capability: Capability): CapabilityDescriptor {
  assertCapability(capability);
  return Object.freeze({
    kind: capability.kind,
    id: capability.id,
    version: capability.version,
  });
}

/** 计算契约身份键；只用于 Host/目录内部比较。 */
export function capabilityKey(capability: CapabilityDescriptor): string {
  return `${capability.kind}\u0000${capability.id}\u0000${capability.version}`;
}

/** 运行时校验静态 capability DTO。 */
export function isCapabilityDescriptor(value: unknown): value is CapabilityDescriptor {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CapabilityDescriptor>;
  return (candidate.kind === "local" || candidate.kind === "rpc" || candidate.kind === "stream")
    && typeof candidate.id === "string" && candidate.id.trim() !== ""
    && typeof candidate.version === "string" && candidate.version.trim() !== "";
}

/** 运行时校验 realm 内 capability 对象。 */
export function isCapability(value: unknown): value is Capability {
  if (!isCapabilityDescriptor(value)) return false;
  if (value.kind === "local") return true;
  if (value.kind === "rpc") {
    const candidate = value as Partial<RpcCapability<unknown, unknown>>;
    return !!candidate.request && typeof candidate.request === "object"
      && typeof candidate.request.parse === "function"
      && !!candidate.response && typeof candidate.response === "object"
      && typeof candidate.response.parse === "function";
  }
  const candidate = value as Partial<StreamCapability<unknown, unknown>>;
  return !!candidate.request && typeof candidate.request === "object"
    && typeof candidate.request.parse === "function"
    && !!candidate.item && typeof candidate.item === "object"
    && typeof candidate.item.parse === "function";
}

/** capability 不合法时抛出统一错误。 */
export function assertCapability(value: unknown): asserts value is Capability {
  if (!isCapability(value)) throw new TypeError("Invalid WebLoom capability definition");
}
