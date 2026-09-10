// 生命周期、权限租约、服务桥与升级门禁契约。
//
// 这里仅放跨执行环境共享的类型和稳定错误码，不暴露具体平台实现。

/** 运行实例的作用域类型；名称由宿主定义，WebLoom 只比较和调度。 */
export type LifecycleScopeKind = string;

/** 作用域状态；stopping 表示已撤权但异步收尾还未结束。 */
export type LifecycleScopeState = "active" | "stopping" | "stopped";

/** 浏览器中由 WebLoom 管理的真实 JavaScript 运行空间。 */
export type RuntimeKind = "window-main" | "shared-worker";

/** 权限动作名称；权限集合和最终 I/O allowlist 由宿主定义。 */
export type PluginPermission = string;

/** 一个运行作用域的身份绑定；敏感句柄必须带上这些字段。 */
export interface LifecycleScopeIdentity<
  TAttributes extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>,
> {
  /** 作用域唯一标识；每次重建都必须不同。 */
  scopeId: string;
  /** 运行实例唯一标识；A -> B -> A 也不能复用旧实例。 */
  instanceId: string;
  /** 作用域类型；只作为宿主提供的稳定标签。 */
  kind: LifecycleScopeKind;
  /** 父作用域标识；跨环境时只传标识，不传 Context。 */
  parentScopeId?: string;
  /** 插件标识。由 Host 绑定，调用方不可从请求参数替换。 */
  pluginId?: string;
  /** 宿主绑定的只读扩展元数据；不得放入私密材料。 */
  attributes: TAttributes;
}

/** 释放回调；reason 是中文 UI 之外的稳定审计原因。 */
export type LifecycleCleanup = (reason: string) => void | Promise<void>;

/** 清理阶段；Registry 等技术注册项通常在 legacy teardown 之后释放。 */
export type LifecycleCleanupPhase = "before-teardown" | "after-teardown";

/** 作用域内一项资源的结构化快照。 */
export interface LifecycleResourceSnapshot {
  /** 资源唯一标识。 */
  resourceId: string;
  /** 当前阶段。 */
  state: "acquiring" | "active" | "released" | "pending";
  /** 最近一次释放错误。 */
  error?: string;
}

/** 释放失败或超时的结构化记录。 */
export interface LifecycleCleanupIssue {
  /** 对应资源或清理回调标识。 */
  resourceId: string;
  /** 错误稳定码。 */
  code: "lifecycle.cleanup_failed" | "lifecycle.cleanup_timeout";
  /** 便于日志和诊断的错误文本。 */
  message: string;
}

/** 作用域停止的结果；清理不完整时仍然返回，而不是伪装成功。 */
export interface LifecycleDisposeResult {
  /** 作用域标识。 */
  scopeId: string;
  /** 停止后的状态。 */
  state: "stopped";
  /** 尝试执行的释放项数量。 */
  attempted: number;
  /** 已完成的释放项数量。 */
  released: number;
  /** 超时或仍在异步收尾的资源标识。 */
  pending: string[];
  /** 所有释放错误；一个错误不阻止其它项执行。 */
  errors: LifecycleCleanupIssue[];
  /** 是否存在未完成收尾。 */
  cleanupIncomplete: boolean;
}

/** 作用域停止选项。 */
export interface LifecycleDisposeOptions {
  /** 每一项释放允许等待的毫秒数；不填则等待到完成。 */
  timeoutMs?: number;
  /** 释放原因。 */
  reason?: string;
  /** 在 before-teardown 资源完成后执行的旧 teardown / 领域收尾。 */
  teardown?: LifecycleCleanup;
  /**
   * 某项清理超过 timeoutMs 后最终成功时回调；回调只用于本地状态投影，
   * 不改变已经完成的撤权边界。resourceId 是稳定资源标识，result 是同一
   * 次 dispose 返回的可变快照（可能尚未生成）。
   */
  onLateSuccess?: (resourceId: string, result?: LifecycleDisposeResult) => void;
  /**
   * 某项清理在超时后最终失败时回调；调用方必须保留 cleanup-pending，
   * 不能把失败的迟到结果当成新实例成功。
   */
  onLateFailure?: (resourceId: string, error: unknown, result?: LifecycleDisposeResult) => void;
}

/** 已登记资源的可控释放句柄。 */
export interface LifecycleResourceHandle {
  /** 资源标识。 */
  readonly resourceId: string;
  /** 资源是否已经完成释放。 */
  readonly released: boolean;
  /** 幂等释放；重复调用不会再次执行资源释放函数。 */
  release(reason?: string): Promise<void>;
}

/**
 * 作用域公开 API。
 *
 * `revoke()` 只做同步安全撤权；`dispose()` 负责异步资源收尾。业务不需要
 * 接触底层框架 Context，也不能在 stopping/stopped 作用域中注册新资源。
 */
export interface LifecycleScope {
  readonly identity: LifecycleScopeIdentity;
  readonly state: LifecycleScopeState;
  readonly signal: AbortSignal;
  /** 订阅同步撤权事件；返回值用于取消该订阅。 */
  onRevoke(listener: (reason: string) => void): () => void;
  /** 登记一个释放回调；返回取消登记函数。 */
  onDispose(cleanup: LifecycleCleanup, resourceId?: string, phase?: LifecycleCleanupPhase): () => void;
  /** 登记已有资源并返回幂等释放句柄。 */
  track<T>(resource: T, release: (resource: T, reason: string) => void | Promise<void>, resourceId?: string): T;
  /** 受控异步创建：停止期间才返回的资源会被立即释放且不会进入旧实例。 */
  acquire<T>(
    resourceId: string,
    create: (signal: AbortSignal) => T | Promise<T>,
    release: (resource: T, reason: string) => void | Promise<void>
  ): Promise<T>;
  /** 创建同一运行实例下的子作用域。 */
  child(kind: LifecycleScopeKind, metadata?: Partial<Omit<LifecycleScopeIdentity, "scopeId" | "instanceId" | "kind" | "parentScopeId">>): LifecycleScope;
  /** 同步撤销权限、发出 signal.abort，并阻止新资源登记。 */
  revoke(reason?: string): void;
  /** 异步释放全部已登记资源，结果可见且幂等。 */
  dispose(options?: LifecycleDisposeOptions): Promise<LifecycleDisposeResult>;
  /** 作用域已撤权时抛出稳定错误。 */
  assertActive(): void;
  /** 只读资源快照。 */
  resources(): readonly LifecycleResourceSnapshot[];
}

/** 生命周期作用域已撤权。 */
export class LifecycleScopeRevokedError extends Error {
  readonly code = "lifecycle.scope_revoked" as const;

  constructor(message = "Lifecycle scope has been revoked") {
    super(message);
    this.name = "LifecycleScopeRevokedError";
  }
}

/** 权限租约已撤销或身份不匹配。 */
export class PermissionLeaseRevokedError extends Error {
  readonly code = "permission.lease_revoked" as const;

  constructor(message = "Permission lease has been revoked") {
    super(message);
    this.name = "PermissionLeaseRevokedError";
  }
}

/** 没有得到可信装配批准的权限。 */
export class PermissionDeniedError extends Error {
  readonly code = "permission.denied" as const;
  readonly permission: PluginPermission;

  constructor(permission: PluginPermission, message = `Permission denied: ${permission}`) {
    super(message);
    this.name = "PermissionDeniedError";
    this.permission = permission;
  }
}

/** 权限租约的不可变身份绑定。 */
export interface PermissionLeaseBinding extends LifecycleScopeIdentity {
  /** 插件申请的权限；申请不等于批准。 */
  requested: readonly PluginPermission[];
  /** 可信装配层批准的权限。 */
  approved: readonly PluginPermission[];
  /** 当前会话额外允许的权限；未提供会话限制时由装配层视为全量允许。 */
  sessionConstraints?: readonly PluginPermission[];
  /** 内置可信策略修订；策略扩大或收窄都会触发重新发租约。 */
  policyRevision?: number;
  /** Connect 用户授权修订；内置插件可以省略。 */
  grantRevision?: number;
  /** Connect/外部授权的不可猜测授权标识；最终服务边界必须核验。 */
  grantId?: string;
}

/** 最终 RPC / I/O 边界可比较的租约身份字段。 */
export type PermissionLeaseBindingExpectation =
  Partial<Pick<LifecycleScopeIdentity, "pluginId" | "instanceId">>
  & { attributes?: Readonly<Record<string, unknown>> }
  & Partial<Pick<PermissionLeaseBinding, "policyRevision" | "grantRevision" | "grantId">>;

/** 权限租约；实现必须在最终 RPC/I/O 边界再次校验。 */
export interface PermissionLease {
  readonly binding: PermissionLeaseBinding;
  readonly revoked: boolean;
  /** 当前租约是否同时满足申请、批准和作用域状态。 */
  has(permission: PluginPermission): boolean;
  /** 校验权限；失败抛稳定错误。 */
  assert(permission: PluginPermission): void;
  /** 校验绑定身份；不允许替换 owner、插件或世代。 */
  assertBinding(expected: PermissionLeaseBindingExpectation): void;
  /** 撤销租约；重复调用幂等。 */
  revoke(reason?: string): void;
}

/** 跨 Worker 服务的可序列化引用；引用本身不是授权凭据。 */
export interface RemoteServiceReference {
  /** 服务契约标识。 */
  capabilityId: string;
  /** 要求精确匹配的服务契约版本。 */
  contractVersion: string;
  /** 提供者所在真实 Runtime。 */
  runtime: RuntimeKind;
  /** 提供环境的启动身份；重启后变化。 */
  runtimeInstanceId: string;
  /** 服务实例身份；撤销后永不复用。 */
  serviceInstanceId: string;
  /** 当前服务目录状态。 */
  status: "starting" | "ready" | "unavailable" | "failed";
  /** 宿主绑定的只读服务属性；服务桥不解释其业务含义。 */
  attributes: Readonly<Record<string, unknown>>;
  /** 可选的外部授权标识；引用不是授权本身，Provider 仍需查权威状态。 */
  grantId?: string;
  /** 服务端授权策略修订；策略变化时旧引用必须失效。 */
  authorizationRevision?: number;
}

/** 传给服务桥的完整目录快照；Runtime Host 是它的唯一权威发布者。 */
export interface RemoteServiceSnapshot {
  /** 快照协议版本；解析成功但版本不匹配时不得当成可用目录。 */
  protocolVersion: string;
  /** 权威 Runtime 的逻辑标识；独立服务桥可省略。 */
  runtimeId?: string;
  /** 权威 Runtime 类型；独立服务桥可省略。 */
  runtimeKind?: RuntimeKind;
  /** 每次 Worker 启动唯一的 Runtime 身份。 */
  runtimeInstanceId: string;
  /** 当前完整目录修订；同一 Runtime 只接受严格递增值。 */
  revision: number;
  /** Runtime 当前状态。 */
  state?: "starting" | "ready" | "stopping" | "failed" | "disposed";
  /** 当前完整服务目录。 */
  services: readonly RemoteServiceReference[];
}

/** MessagePort 服务消息类别；codec 只承载调用生命周期。 */
export type RemoteServiceMessageKind = "call" | "result" | "error" | "cancel";

/** 服务桥 wire codec；负责类型名、编解码和协议版本，不让传输层散落字符串判断。 */
export interface RemoteServiceMessageCodec {
  /** codec 对应的协议版本。 */
  readonly protocolVersion: string;
  /** 各消息类别对应的 wire type。 */
  type(kind: RemoteServiceMessageKind): string;
  /** 将结构化消息编码为可结构化克隆的数据。 */
  encode(message: Record<string, unknown>): unknown;
  /** 将 wire 数据解码为对象；无效消息返回 undefined。 */
  decode(input: unknown): Record<string, unknown> | undefined;
}

/** 创建 WebLoom v2 codec；产品可以只替换 wire 前缀，不能恢复控制消息。 */
export function createRemoteServiceMessageCodec(options: {
  prefix?: string;
  protocolVersion?: string;
} = {}): RemoteServiceMessageCodec {
  const prefix = options.prefix ?? "webloom.remote-service";
  const protocolVersion = options.protocolVersion ?? "webloom.remote-service.v2";
  const types = new Map<RemoteServiceMessageKind, string>([
    ["call", `${prefix}.call`],
    ["result", `${prefix}.result`],
    ["error", `${prefix}.error`],
    ["cancel", `${prefix}.cancel`],
  ]);
  return Object.freeze({
    protocolVersion,
    type(kind: RemoteServiceMessageKind): string {
      const value = types.get(kind);
      if (!value) throw new Error(`Unknown remote service message kind: ${kind}`);
      return value;
    },
    encode(message: Record<string, unknown>): unknown {
      return { ...message };
    },
    decode(input: unknown): Record<string, unknown> | undefined {
      if (!input || typeof input !== "object") return undefined;
      const message = input as Record<string, unknown>;
      if (typeof message.type !== "string" || ![...types.values()].includes(message.type)) return undefined;
      return message;
    },
  });
}

/** 服务桥查询条件；不匹配时不能返回“差不多兼容”的代理。 */
export interface RemoteServiceLookup {
  /** 要求的服务契约标识。 */
  capabilityId: string;
  /** 要求的精确契约版本。 */
  contractVersion: string;
  /** 可选的预期提供 Runtime。 */
  runtime?: RuntimeKind;
}

/** 服务代理调用上下文；服务端必须在最终边界重新检查引用和租约。 */
export interface RemoteServiceCallContext {
  /** 业务操作标识；可由调用方复用，用于审计和幂等，不作为传输关联键。 */
  operationId?: string;
  /** 创建代理时捕获的不可变引用。 */
  reference: RemoteServiceReference;
  /** 引用绑定的外部授权标识，供最终服务边界再次核验。 */
  grantId?: string;
  /** 同时受消费者作用域和本次请求控制的 signal。 */
  signal: AbortSignal;
  /** 从调用开始计算的总 deadline；等待目录和远程执行共用它。 */
  deadlineAt?: number;
  /** 传输直调用时的总 timeout；桥调用会同时提供 deadlineAt。 */
  timeoutMs?: number;
}

/** 跨环境传输实现；桥不负责自动重放有外部副作用的请求。 */
export interface RemoteServiceTransport {
  call<TRequest, TResult>(
    request: TRequest,
    context: RemoteServiceCallContext
  ): Promise<TResult>;
}

export interface RemoteServiceCallOptions {
  signal?: AbortSignal;
  operationId?: string;
  /** 兼容旧业务命名；只作为 operationId，不作为传输 callId。 */
  requestId?: string;
  /** 覆盖 RuntimeHandle 的默认有限 deadline。 */
  timeoutMs?: number;
}

/** 惰性服务代理；第一次成功调用后永久绑定一份服务引用。 */
export interface RemoteServiceProxy {
  /** 未绑定时为 undefined；绑定后引用永远不换绑。 */
  readonly reference?: RemoteServiceReference;
  readonly revoked: boolean;
  call<TRequest, TResult>(
    request: TRequest,
    options?: RemoteServiceCallOptions,
  ): Promise<TResult>;
  revoke(reason?: string): void;
}

export type RemoteServiceBridgeState = "empty" | "ready" | "stale" | "disposed";

/** 服务桥完整快照结果；旧/重复 revision 直接忽略，不清空当前目录。 */
export type RemoteServiceSnapshotResult =
  | { accepted: true; state: RemoteServiceBridgeState; revision: number }
  | { accepted: false; reason: "stale-revision" | "protocol-mismatch" | "invalid-snapshot" | "disposed"; receivedRevision?: number };

/** WebLoom v2 调用错误的稳定码；业务 handler 可以附加自己的 code。 */
export type RemoteServiceErrorCode =
  | "transport_unavailable"
  | "call_timeout"
  | "runtime_initialization_failed"
  | "protocol_mismatch"
  | "capability_unavailable"
  | "contract_version_mismatch"
  | "service_stale"
  | "service_revoked"
  | "permission_denied"
  | "request_cancelled"
  | "request_clone_failed"
  | "handler_failed"
  | (string & {});

export class RemoteServiceError extends Error {
  readonly code: RemoteServiceErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: RemoteServiceErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "RemoteServiceError";
    this.code = code;
    this.details = details;
  }
}

/** 跨 Worker 服务桥最小本地契约。 */
export interface RemoteServiceBridge {
  /** 当前端口连接状态。 */
  readonly state: RemoteServiceBridgeState;
  /** 当前权威 Runtime 启动身份。 */
  readonly runtimeInstanceId?: string;
  /** 应用一份完整快照；第一次调用可以早于它到达。 */
  applySnapshot(snapshot: RemoteServiceSnapshot): RemoteServiceSnapshotResult;
  /** 记录可解析但版本不兼容的对端；后续调用返回 protocol_mismatch。 */
  markProtocolMismatch(reason?: string): void;
  /** 记录权威 Runtime 初始化失败；后续调用返回 runtime_initialization_failed。 */
  markInitializationFailed(reason?: string): void;
  /** 总 deadline 默认值；必须是有限且大于零的毫秒数。 */
  readonly defaultCallTimeoutMs: number;
  /** 获取一个惰性、单次绑定代理；不得因当前目录为空同步失败。 */
  getProxy(lookup: RemoteServiceLookup, scope?: LifecycleScope): RemoteServiceProxy | undefined;
  /** 获取惰性代理的显式别名；只在桥 disposed 后仍返回会失败的代理。 */
  requireProxy(lookup: RemoteServiceLookup, scope?: LifecycleScope): RemoteServiceProxy;
  /** 同步撤下全部代理；不等待远端。 */
  invalidate(reason?: string): void;
  /** 端口断线；旧代理永久失效，后续恢复必须创建新 RuntimeHandle。 */
  disconnect(reason?: string): void;
  /** 永久销毁桥，并拒绝所有等待绑定和 pending call。 */
  dispose(reason?: string): void;
  /** 订阅桥状态和服务目录变化。 */
  subscribe(listener: () => void): () => void;
  /** 只读当前有效服务引用。 */
  services(): readonly RemoteServiceReference[];
}

/** 首次发布采用的升级并存策略。冷切换要求旧环境先退出；两阶段允许
 * 短暂并存，但必须先在写入边界完成同一接管世代的排空。 */
export type UpgradeMode = "cold-switch" | "two-phase";

/** 升级接管门禁状态；draining 仍可等待旧 I/O，但不接受新业务 I/O。 */
export type UpgradeGateState = "active" | "draining" | "closed";

/** 新旧 Worker / 客户端接管握手。 */
export interface UpgradeHandshake {
  /** 发起握手的实际连接标识；会话不能脱离这条连接转移使用。 */
  connectionId: string;
  /** 控制协议版本；不兼容时拒绝业务接入。 */
  protocolVersion: string;
  /** 构建产物标识；不同构建只有显式兼容时才可接入。 */
  buildId: string;
  /** 当前运行环境启动身份。 */
  authorityInstanceId: string;
  /** 写入接管世代；旧世代不能重新取得租约。 */
  handoverGeneration: number;
  /** 对端支持的精确服务契约版本。 */
  supportedContractVersions: readonly string[];
}

/** 升级握手结果。 */
export type UpgradeHandshakeResult =
  | {
      accepted: true;
      mode: UpgradeMode;
      handoverGeneration: number;
      contractVersion: string;
      /** 只有握手返回的绑定会话才可申请 I/O 租约。 */
      connectionId: string;
      sessionId: string;
      session: UpgradeSession;
    }
  | {
      accepted: false;
      reason:
        | "protocol-mismatch"
        | "build-incompatible"
        | "stale-generation"
        | "future-generation"
        | "contract-mismatch"
        | "draining"
        | "closed";
    };

/** 一次已获准的 I/O 接管租约；排空期间已发租约可完成，close 后失效。 */
export interface UpgradeIoLease {
  /** 发放租约的实际连接标识。 */
  readonly connectionId: string;
  /** 发放该租约的握手会话。 */
  readonly sessionId: string;
  /** 发放租约的权威启动身份。 */
  readonly authorityInstanceId: string;
  /** 发放租约时的接管世代。 */
  readonly handoverGeneration: number;
  /** 精确匹配的服务契约版本。 */
  readonly contractVersion: string;
  /** 本次 I/O 类型；写入边界必须额外做领域校验。 */
  readonly operation: "read" | "write";
  /** 租约是否已撤销或主动释放。 */
  readonly revoked: boolean;
  /** 与本次 I/O 合并的取消信号。 */
  readonly signal: AbortSignal;
  /** 在最终提交前检查租约仍属于当前接管门禁。 */
  assertActive(): void;
  /** 释放租约；重复调用幂等。 */
  release(): void;
}

/** 一次通过握手、绑定权威/世代/契约版本的接管会话。 */
export interface UpgradeSession {
  /** 会话绑定的实际连接标识；换连接必须重新握手。 */
  readonly connectionId: string;
  /** 不可猜测的会话标识；跨端传输时作为 opaque token。 */
  readonly sessionId: string;
  /** 发放会话的当前权威启动身份。 */
  readonly authorityInstanceId: string;
  /** 发放会话时的接管世代。 */
  readonly handoverGeneration: number;
  /** 握手协商出的精确服务契约版本。 */
  readonly contractVersion: string;
  /** 会话是否已撤销。 */
  readonly revoked: boolean;
  /** 会话撤销信号。 */
  readonly signal: AbortSignal;
  /** 校验会话仍可申请 I/O。 */
  assertActive(): void;
  /** 只能申请握手协商出的契约版本，不接受调用方换版本。 */
  admit(input: { operation: "read" | "write"; signal?: AbortSignal }): UpgradeIoLease;
  /** 关闭当前握手会话并撤销其尚未完成的 I/O。 */
  close(reason?: string): void;
}

/** 升级排空结果；超时不会伪装成已排空。 */
export interface UpgradeDrainResult {
  /** 排空时的门禁状态。 */
  state: UpgradeGateState;
  /** 是否确认所有已发 I/O 租约都已释放。 */
  drained: boolean;
  /** 仍未释放的 I/O 数量。 */
  pending: number;
}

/** 接管门禁创建参数。 */
export interface CreateUpgradeGateOptions {
  /** 当前接受的控制协议版本。 */
  protocolVersion: string;
  /** 当前构建产物标识。 */
  buildId: string;
  /** 当前 Worker / 执行环境启动身份。 */
  authorityInstanceId: string;
  /** 当前写入接管世代。 */
  handoverGeneration: number;
  /** 当前允许的精确服务契约版本集合。 */
  supportedContractVersions: readonly string[];
  /** 冷切换或两阶段并存；默认冷切换。 */
  mode?: UpgradeMode;
  /** 显式允许接入的旧构建；不填时只接受同 buildId。 */
  compatibleBuildIds?: ReadonlySet<string>;
  /** 更复杂部署可提供显式构建兼容规则。 */
  isBuildCompatible?: (buildId: string) => boolean;
}

/** 跨 Worker 写入接管门禁。它不负责选主、不负责调度插件。 */
export interface UpgradeGate {
  readonly state: UpgradeGateState;
  readonly mode: UpgradeMode;
  readonly authorityInstanceId: string;
  readonly handoverGeneration: number;
  /** 校验版本、构建、接管世代和精确契约版本。 */
  handshake(input: UpgradeHandshake): UpgradeHandshakeResult;
  /** 当前仍允许发放新业务 I/O 租约。 */
  assertAccepting(): void;
  /** 发放绑定当前握手会话、权威和世代的 I/O 租约。 */
  admit(input: {
    session: UpgradeSession;
    operation: "read" | "write";
    signal?: AbortSignal;
  }): UpgradeIoLease;
  /** 同步关闭新 I/O 入口；不等待已提交 I/O。 */
  beginDrain(reason?: string): void;
  /** 等待已发租约释放；超时后仍保持 draining。 */
  drain(timeoutMs?: number): Promise<UpgradeDrainResult>;
  /** 永久关闭并撤销尚未释放的租约。 */
  close(reason?: string): void;
  /** 当前已发且尚未释放的 I/O 数量。 */
  activeIo(): number;
}

/** 升级门禁拒绝或租约失效。 */
export class UpgradeGateRejectedError extends Error {
  readonly code = "upgrade.gate_rejected" as const;
  readonly reason: string;

  constructor(reason: string, message = `Upgrade gate rejected operation: ${reason}`) {
    super(message);
    this.name = "UpgradeGateRejectedError";
    this.reason = reason;
  }
}

/** 单次插件启停控制命令；目标是绝对意图，不是 toggle。 */
export interface PluginIntentCommand {
  /** 客户端生成的幂等命令标识。 */
  commandId: string;
  /** 命令发送方握手得到的控制面启动身份。 */
  authorityInstanceId: string;
  /** 客户端观察到的全局修订。 */
  expectedRevision: number;
  /** 目标产品标识。 */
  pluginId: string;
  /** 目标启用意图。 */
  desiredEnabled: boolean;
}

/** 控制面持久化的插件意图快照。 */
export interface PluginIntentSnapshot {
  /** 控制面全局修订。 */
  revision: number;
  /** 每个产品当前的绝对启用意图。 */
  desiredEnabled: Readonly<Record<string, boolean>>;
  /** 每个产品自己的意图修订。 */
  desiredRevision: Readonly<Record<string, number>>;
}

/** 启停命令的结构化结果；accepted 只表示意图已持久化。 */
export type PluginIntentCommandResult =
  | { status: "accepted" | "duplicate"; commandId: string; snapshot: PluginIntentSnapshot; persisted: true }
  | { status: "stale-authority"; commandId: string; expectedAuthorityInstanceId: string }
  | { status: "command-conflict"; commandId: string; message: string }
  | { status: "revision-conflict"; commandId: string; snapshot: PluginIntentSnapshot }
  | { status: "persistence-failed"; commandId: string; message: string; snapshot: PluginIntentSnapshot };

/** 意图 RPC 的完整结果；transport-error 不代表意图已保存。 */
export type PluginIntentSubmissionResult = PluginIntentCommandResult | {
  status: "transport-error";
  message: string;
  retryable: boolean;
};

/** 单一控制面上的命令去重、修订比较和持久化边界。 */
export interface PluginIntentController {
  /** 当前控制面启动身份；Worker 重启后必须更换。 */
  readonly authorityInstanceId: string;
  /** 当前意图快照。 */
  snapshot(): PluginIntentSnapshot;
  /** 串行提交一次绝对意图命令。 */
  submit(command: PluginIntentCommand): Promise<PluginIntentCommandResult>;
  /** 订阅持久化成功后的意图变化。 */
  subscribe(listener: (snapshot: PluginIntentSnapshot) => void): () => void;
}

/** Host 使用的意图控制面适配器；生产实现位于 Coordinator client。 */
export interface PluginIntentCoordinator {
  /** 当前 SharedWorker authority；Worker 重启后变化。 */
  readonly authorityInstanceId: string;
  /** 当前权威意图快照。 */
  snapshot(): PluginIntentSnapshot;
  /** 提交绝对启停意图；不直接承诺运行实例已启动。 */
  submit(command: PluginIntentCommand): Promise<PluginIntentSubmissionResult>;
  /** 接收其它页面或 Worker 广播的持久化快照。 */
  subscribe(listener: (snapshot: PluginIntentSnapshot) => void): () => void;
}

/** 带实例取消信号的后台任务定义；不负责持久化外部副作用。 */
export interface ScopedTaskDefinition {
  /** 全局唯一任务标识。 */
  id: string;
  /** 所属插件；默认由作用域身份提供。 */
  pluginId?: string;
  /** 展示名称。 */
  label: string;
  /** 周期；缺省表示只响应显式触发。 */
  intervalMs?: number;
  /** 任务执行体。 */
  run(context: { signal: AbortSignal; reason: string }): void | Promise<void>;
}

/** 作用域任务的运行快照。 */
export interface ScopedTaskSnapshot {
  /** 任务标识。 */
  id: string;
  /** 所属插件。 */
  pluginId: string;
  /** 展示名称。 */
  label: string;
  /** 当前任务状态。 */
  state: "idle" | "queued" | "running" | "failed";
  /** 最近一次错误。 */
  error?: string;
  /** 最近成功时间。 */
  lastCompletedAt?: string;
  /** 下一次周期触发时间。 */
  nextRunAt?: string;
}

/** 绑定作用域的最小任务调度器。 */
export interface ScopedTaskScheduler {
  /** 注册任务并返回幂等取消句柄。 */
  register(definition: ScopedTaskDefinition): () => void;
  /** 显式触发一次；同一任务运行中只合并一次重跑请求。 */
  runNow(id: string, reason?: string): Promise<void>;
  /** 取消当前任务实例并等待其退出。 */
  cancel(id: string): Promise<void>;
  /** 获取当前任务快照。 */
  snapshot(): readonly ScopedTaskSnapshot[];
  /** 订阅快照变化。 */
  subscribe(listener: (snapshot: readonly ScopedTaskSnapshot[]) => void): () => void;
}

/** 作用域后台任务调度器 capability key。 */
export const SCOPED_TASK_SCHEDULER_CAPABILITY = "runtime.task-scheduler";

/** 用户可见的稳定生命周期错误中文说明。 */
export const LIFECYCLE_ERROR_TEXT: Readonly<Record<string, string>> = Object.freeze({
  "lifecycle.scope_revoked": "运行实例已停止",
  "permission.denied": "插件没有获得该操作的权限",
  "permission.lease_revoked": "授权租约已撤销",
  "lifecycle.cleanup_failed": "资源清理失败，等待重试",
  "lifecycle.cleanup_timeout": "资源清理超时，仍在后台排空",
  "upgrade.gate_rejected": "版本接管门禁未通过"
});

/** 将稳定错误码映射到中文 UI 文案；未知错误返回通用提示。 */
export function lifecycleErrorText(code: string): string {
  return LIFECYCLE_ERROR_TEXT[code] ?? "生命周期操作未完成";
}
