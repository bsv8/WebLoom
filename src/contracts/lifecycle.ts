// WebLoom v4 生命周期、权限、Runtime 快照和升级门禁契约。

/** 作用域类型由宿主命名，框架只比较和调度。 */
export type LifecycleScopeKind = string;
/** 作用域状态；stopping 已同步撤权，仍可能有异步清理。 */
export type LifecycleScopeState = "active" | "stopping" | "stopped";
/** 浏览器中的真实 JavaScript Runtime。 */
export type RuntimeKind = "window-main" | "shared-worker";
/** 权限动作名称。 */
export type PluginPermission = string;

/** 一个作用域的不可替换身份绑定。 */
export interface LifecycleScopeIdentity<
  TAttributes extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>,
> {
  /** 作用域唯一标识。 */
  readonly scopeId: string;
  /** 作用域所属实例；重建不得复用。 */
  readonly instanceId: string;
  /** 作用域类型。 */
  readonly kind: LifecycleScopeKind;
  /** 父作用域标识。 */
  readonly parentScopeId?: string;
  /** 绑定插件标识。 */
  readonly pluginId?: string;
  /** 宿主绑定的只读结构化属性。 */
  readonly attributes: TAttributes;
}

/** 资源清理函数。 */
export type LifecycleCleanup = (reason: string) => void | Promise<void>;
/** 清理阶段。 */
export type LifecycleCleanupPhase = "before-teardown" | "after-teardown";

/** 作用域资源快照。 */
export interface LifecycleResourceSnapshot {
  /** 资源唯一标识。 */
  readonly resourceId: string;
  /** 当前资源状态。 */
  readonly state: "acquiring" | "active" | "released" | "pending";
  /** 脱敏释放错误。 */
  readonly error?: string;
}

/** 资源清理问题。 */
export interface LifecycleCleanupIssue {
  /** 资源标识。 */
  readonly resourceId: string;
  /** 清理失败或超时。 */
  readonly code: "lifecycle.cleanup_failed" | "lifecycle.cleanup_timeout";
  /** 脱敏错误信息。 */
  readonly message: string;
}

/** 作用域停止结果。 */
export interface LifecycleDisposeResult {
  /** 作用域标识。 */
  readonly scopeId: string;
  /** 终态。 */
  readonly state: "stopped";
  /** 尝试释放的数量。 */
  readonly attempted: number;
  /** 已完成释放的数量。 */
  readonly released: number;
  /** 仍在清理的资源。 */
  readonly pending: readonly string[];
  /** 所有清理错误。 */
  readonly errors: readonly LifecycleCleanupIssue[];
  /** 是否有未完成收尾。 */
  readonly cleanupIncomplete: boolean;
}

/** 作用域停止选项。 */
export interface LifecycleDisposeOptions {
  /** 每项清理最多等待的毫秒数。 */
  readonly timeoutMs?: number;
  /** 清理原因。 */
  readonly reason?: string;
  /** 领域 teardown。 */
  readonly teardown?: LifecycleCleanup;
  /** 超时项迟到成功的本地投影回调。 */
  readonly onLateSuccess?: (resourceId: string, result?: LifecycleDisposeResult) => void;
  /** 超时项迟到失败的本地投影回调。 */
  readonly onLateFailure?: (resourceId: string, error: unknown, result?: LifecycleDisposeResult) => void;
}

/** 已登记资源的幂等释放句柄。 */
export interface LifecycleResourceHandle {
  /** 资源标识。 */
  readonly resourceId: string;
  /** 是否已完成释放。 */
  readonly released: boolean;
  /** 释放资源。 */
  release(reason?: string): Promise<void>;
}

/** 生命周期作用域。 */
export interface LifecycleScope {
  /** 作用域身份。 */
  readonly identity: LifecycleScopeIdentity;
  /** 当前状态。 */
  readonly state: LifecycleScopeState;
  /** 撤权信号。 */
  readonly signal: AbortSignal;
  /** 订阅同步撤权。 */
  onRevoke(listener: (reason: string) => void): () => void;
  /** 登记异步清理。 */
  onDispose(cleanup: LifecycleCleanup, resourceId?: string, phase?: LifecycleCleanupPhase): () => void;
  /** 登记已有资源；返回原资源，释放通过 Scope 统一执行。 */
  track<T>(resource: T, release: (resource: T, reason: string) => void | Promise<void>, resourceId?: string): T;
  /** 异步创建并绑定资源；晚到资源会被撤销后立即清理。 */
  acquire<T>(resourceId: string, create: (signal: AbortSignal) => T | Promise<T>, release: (resource: T, reason: string) => void | Promise<void>): Promise<T>;
  /** 创建子作用域。 */
  child(kind: LifecycleScopeKind, metadata?: Partial<Omit<LifecycleScopeIdentity, "scopeId" | "instanceId" | "kind" | "parentScopeId">>): LifecycleScope;
  /** 同步撤权并阻止新资源。 */
  revoke(reason?: string): void;
  /** 异步清理全部资源。 */
  dispose(options?: LifecycleDisposeOptions): Promise<LifecycleDisposeResult>;
  /** 作用域不活跃时抛错。 */
  assertActive(): void;
  /** 资源快照。 */
  resources(): readonly LifecycleResourceSnapshot[];
  /** 绑定 DOM/EventTarget listener；revoke 时同步解绑。 */
  listen(target: EventTarget, event: string, listener: EventListenerOrEventListenerObject, options?: AddEventListenerOptions | boolean): () => void;
  /** 绑定同步 interval callback；revoke 时同步停止。 */
  interval(callback: () => void, milliseconds: number): () => void;
  /** 绑定一个 subscribe/unsubscribe 资源；revoke 时同步退订。 */
  subscribe(subscribe: (listener: () => void) => () => void, listener: () => void): () => void;
}

/** 作用域已撤权。 */
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

/** 权限未获可信装配批准。 */
export class PermissionDeniedError extends Error {
  readonly code = "permission.denied" as const;
  readonly permission: PluginPermission;
  constructor(permission: PluginPermission, message = `Permission denied: ${permission}`) {
    super(message);
    this.name = "PermissionDeniedError";
    this.permission = permission;
  }
}

/** 权限租约的不可变绑定。 */
export interface PermissionLeaseBinding extends LifecycleScopeIdentity {
  /** 插件申请的权限。 */
  readonly requested: readonly PluginPermission[];
  /** 可信策略批准的权限。 */
  readonly approved: readonly PluginPermission[];
  /** 当前会话限制。 */
  readonly sessionConstraints?: readonly PluginPermission[];
  /** 策略修订。 */
  readonly policyRevision?: number;
  /** 用户授权修订。 */
  readonly grantRevision?: number;
  /** 外部授权标识。 */
  readonly grantId?: string;
}

/** 最终边界比较的租约期望。 */
export type PermissionLeaseBindingExpectation =
  Partial<Pick<LifecycleScopeIdentity, "pluginId" | "instanceId">>
  & { attributes?: Readonly<Record<string, unknown>> }
  & Partial<Pick<PermissionLeaseBinding, "policyRevision" | "grantRevision" | "grantId">>;

/** 权限租约。 */
export interface PermissionLease {
  readonly binding: PermissionLeaseBinding;
  readonly revoked: boolean;
  /** 是否拥有权限。 */
  has(permission: PluginPermission): boolean;
  /** 断言权限。 */
  assert(permission: PluginPermission): void;
  /** 断言身份。 */
  assertBinding(expected: PermissionLeaseBindingExpectation): void;
  /** 撤销租约。 */
  revoke(reason?: string): void;
}

/** 紧凑 Runtime 服务目录项；不重复外层 Runtime 身份和状态。 */
export interface RuntimeServiceSnapshot {
  /** 服务形态。 */
  kind: "rpc" | "stream";
  /** capability 标识。 */
  capabilityId: string;
  /** 精确契约版本。 */
  contractVersion: string;
  /** exposure 身份。 */
  serviceInstanceId: string;
  /** 无环公开属性。 */
  attributes: Readonly<Record<string, unknown>>;
  /** 可选授权标识。 */
  grantId?: string;
  /** 授权修订。 */
  authorizationRevision?: number;
}

/** Runtime 完整目录快照。 */
export interface RuntimeSnapshot {
  /** 固定协议版本。 */
  protocolVersion: string;
  /** Runtime 逻辑标识。 */
  runtimeId: string;
  /** 真实 Runtime 类型。 */
  runtimeKind: RuntimeKind;
  /** Runtime 一次启动身份。 */
  runtimeInstanceId: string;
  /** 当前 peer 的投影修订。 */
  revision: number;
  /** Runtime 状态。 */
  state: "starting" | "ready" | "stopping" | "failed" | "disposed";
  /** 单元状态。 */
  units: readonly {
    /** 插件标识。 */
    pluginId: string;
    /** 单元标识。 */
    unitId: string;
    /** 真实 Runtime。 */
    runtime: RuntimeKind;
    /** 启动实例。 */
    instanceId?: string;
    /** 单元状态。 */
    state: import("./plugin.js").PluginStateKind;
  }[];
  /** ready 时仅发布当前可调用服务。 */
  services: readonly RuntimeServiceSnapshot[];
}

/**
 * Runtime/transport 的可信资源预算。
 *
 * 这些值只允许由 Runtime 装配层收紧，不能由 wire 或普通插件扩大。
 * 省略的字段使用 WebLoom v4 的默认预算；不存在 Infinity/无限预算。
 */
export interface RuntimeLimits {
  /** 每个 Runtime 可接入的最大 peer 数。 */
  readonly maxPeers: number;
  /** 每个 peer、每个方向可等待的最大 call 数。 */
  readonly maxPendingCallsPerPeer: number;
  /** 每个 Runtime、每个方向可等待的最大 call 数。 */
  readonly maxPendingCallsPerRuntime: number;
  /** 每个 peer、每个方向的最大活动 stream 数。 */
  readonly maxActiveStreamsPerPeer: number;
  /** 每个 Runtime、每个方向的最大活动 stream 数。 */
  readonly maxActiveStreamsPerRuntime: number;
  /** 每个 peer 可保留的未完成执行槽数。 */
  readonly maxExecutionSlotsPerPeer: number;
  /** 每个 Runtime 可保留的未完成执行槽数。 */
  readonly maxExecutionSlotsPerRuntime: number;
  /** 单条消息的确定性 DTO 预算。 */
  readonly maxMessageBudgetBytes: number;
  /** 每个 peer、每个方向的保留载荷预算。 */
  readonly maxRetainedPayloadBytesPerPeer: number;
  /** 每个 Runtime、每个方向的保留载荷预算。 */
  readonly maxRetainedPayloadBytesPerRuntime: number;
  /** 单个 snapshot 的 unit 上限。 */
  readonly maxSnapshotUnits: number;
  /** 单个 snapshot 的 service 上限。 */
  readonly maxSnapshotServices: number;
  /** 单条 DTO 图的最大深度。 */
  readonly maxDtoDepth: number;
  /** 单条 DTO 图的唯一对象节点上限。 */
  readonly maxDtoNodes: number;
  /** 单条 DTO 图的引用边/字段槽位上限。 */
  readonly maxDtoEdges: number;
  /** 单个 transfer extractor 原始返回列表上限。 */
  readonly maxTransferEntries: number;
  /** 去重后的 transfer 总数上限。 */
  readonly maxTransfers: number;
  /** 去重后的 MessagePort 数量上限。 */
  readonly maxMessagePorts: number;
  /** stream credit/push 队列窗口上限。 */
  readonly maxStreamCredit: number;
}

/** 快照应用结果。 */
export type SnapshotApplyResult =
  | { accepted: true; state: "empty" | "ready" | "stale"; revision: number }
  | { accepted: false; reason: "stale-revision" | "protocol-mismatch" | "invalid-snapshot" | "disposed"; receivedRevision?: number };

/** 框架结构化错误码。 */
export type FrameworkErrorCode =
  | "protocol_mismatch"
  | "invalid_snapshot"
  | "capability_unavailable"
  | "contract_mismatch"
  | "request_validation_failed"
  | "response_validation_failed"
  | "request_clone_failed"
  | "response_clone_failed"
  | "transfer_invalid"
  | "handler_failed"
  | "call_timeout"
  | "request_cancelled"
  | "service_revoked"
  | "service_stale"
  | "transport_unavailable"
  | "runtime_initialization_failed"
  | "stream_overflow"
  | "resource_limit_exceeded"
  | "permission_denied"
  | (string & {});
/** 框架错误阶段。 */
export type FrameworkErrorPhase = "validate" | "wait" | "dispatch" | "execute" | "receive" | "dispose";
/** 脱敏错误上下文。 */
export interface FrameworkErrorContext {
  /** capability 标识。 */
  capabilityId?: string;
  /** Runtime 启动身份。 */
  runtimeInstanceId?: string;
  /** service exposure 身份。 */
  serviceInstanceId?: string;
}
/** WebLoom v4 统一错误入口。 */
export class WebLoomError extends Error {
  readonly code: FrameworkErrorCode;
  readonly phase: FrameworkErrorPhase;
  readonly context?: Readonly<FrameworkErrorContext>;
  readonly details?: Readonly<Record<string, unknown>>;
  constructor(code: FrameworkErrorCode, message: string, phase: FrameworkErrorPhase = "execute", context?: FrameworkErrorContext, details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = "WebLoomError";
    this.code = code;
    this.phase = phase;
    this.context = context ? Object.freeze({ ...context }) : undefined;
    this.details = details ? Object.freeze({ ...details }) : undefined;
  }
}

/** 升级切换模式。 */
export type UpgradeMode = "cold-switch" | "two-phase";
/** 升级门禁状态。 */
export type UpgradeGateState = "active" | "draining" | "closed";
/** 新旧构建接管握手。 */
export interface UpgradeHandshake {
  /** 真实连接标识。 */
  connectionId: string;
  /** 控制协议版本。 */
  protocolVersion: string;
  /** 构建标识。 */
  buildId: string;
  /** 权威实例。 */
  authorityInstanceId: string;
  /** 接管世代。 */
  handoverGeneration: number;
  /** 支持的精确契约版本。 */
  supportedContractVersions: readonly string[];
}
/** 握手结果。 */
export type UpgradeHandshakeResult =
  | { accepted: true; mode: UpgradeMode; handoverGeneration: number; contractVersion: string; connectionId: string; sessionId: string; session: UpgradeSession }
  | { accepted: false; reason: "protocol-mismatch" | "build-incompatible" | "stale-generation" | "future-generation" | "contract-mismatch" | "draining" | "closed" };
/** I/O 租约。 */
export interface UpgradeIoLease {
  readonly connectionId: string;
  readonly sessionId: string;
  readonly authorityInstanceId: string;
  readonly handoverGeneration: number;
  readonly contractVersion: string;
  readonly operation: "read" | "write";
  readonly revoked: boolean;
  readonly signal: AbortSignal;
  assertActive(): void;
  release(): void;
}
/** 已握手会话。 */
export interface UpgradeSession {
  readonly connectionId: string;
  readonly sessionId: string;
  readonly authorityInstanceId: string;
  readonly handoverGeneration: number;
  readonly contractVersion: string;
  readonly revoked: boolean;
  readonly signal: AbortSignal;
  assertActive(): void;
  admit(input: { operation: "read" | "write"; signal?: AbortSignal }): UpgradeIoLease;
  close(reason?: string): void;
}
/** 排空结果。 */
export interface UpgradeDrainResult {
  readonly state: UpgradeGateState;
  readonly drained: boolean;
  readonly pending: number;
}
/** 升级门禁参数。 */
export interface CreateUpgradeGateOptions {
  readonly protocolVersion: string;
  readonly buildId: string;
  readonly authorityInstanceId: string;
  readonly handoverGeneration: number;
  readonly supportedContractVersions: readonly string[];
  readonly mode?: UpgradeMode;
  readonly compatibleBuildIds?: ReadonlySet<string>;
  readonly isBuildCompatible?: (buildId: string) => boolean;
}
/** 升级门禁。 */
export interface UpgradeGate {
  readonly state: UpgradeGateState;
  readonly mode: UpgradeMode;
  readonly authorityInstanceId: string;
  readonly handoverGeneration: number;
  handshake(input: UpgradeHandshake): UpgradeHandshakeResult;
  assertAccepting(): void;
  admit(input: { session: UpgradeSession; operation: "read" | "write"; signal?: AbortSignal }): UpgradeIoLease;
  beginDrain(reason?: string): void;
  drain(timeoutMs?: number): Promise<UpgradeDrainResult>;
  close(reason?: string): void;
  activeIo(): number;
}
/** 升级门禁拒绝。 */
export class UpgradeGateRejectedError extends Error {
  readonly code = "upgrade.gate_rejected" as const;
  readonly reason: string;
  constructor(reason: string, message = `Upgrade gate rejected operation: ${reason}`) {
    super(message);
    this.name = "UpgradeGateRejectedError";
    this.reason = reason;
  }
}

/** 插件启停绝对意图命令。 */
export interface PluginIntentCommand {
  readonly commandId: string;
  readonly authorityInstanceId: string;
  readonly expectedRevision: number;
  readonly pluginId: string;
  readonly desiredEnabled: boolean;
}
/** 插件启停意图快照。 */
export interface PluginIntentSnapshot {
  readonly revision: number;
  readonly desiredEnabled: Readonly<Record<string, boolean>>;
  readonly desiredRevision: Readonly<Record<string, number>>;
}
/** 意图持久化结果。 */
export type PluginIntentCommandResult =
  | { status: "accepted" | "duplicate"; commandId: string; snapshot: PluginIntentSnapshot; persisted: true }
  | { status: "stale-authority"; commandId: string; expectedAuthorityInstanceId: string }
  | { status: "command-conflict"; commandId: string; message: string }
  | { status: "revision-conflict"; commandId: string; snapshot: PluginIntentSnapshot }
  | { status: "persistence-failed"; commandId: string; message: string; snapshot: PluginIntentSnapshot };
/** Host 提交意图的完整结果。 */
export type PluginIntentSubmissionResult = PluginIntentCommandResult | { status: "transport-error"; message: string; retryable: boolean };
/** 单一启停控制面。 */
export interface PluginIntentController {
  readonly authorityInstanceId: string;
  snapshot(): PluginIntentSnapshot;
  submit(command: PluginIntentCommand): Promise<PluginIntentCommandResult>;
  subscribe(listener: (snapshot: PluginIntentSnapshot) => void): () => void;
}
/** Host 接入的启停控制面。 */
export interface PluginIntentCoordinator {
  readonly authorityInstanceId: string;
  snapshot(): PluginIntentSnapshot;
  submit(command: PluginIntentCommand): Promise<PluginIntentSubmissionResult>;
  subscribe(listener: (snapshot: PluginIntentSnapshot) => void): () => void;
}

/** scoped 后台任务定义。 */
export interface ScopedTaskDefinition {
  readonly id: string;
  readonly pluginId?: string;
  readonly label: string;
  readonly intervalMs?: number;
  run(context: { signal: AbortSignal; reason: string }): void | Promise<void>;
}
/** 任务快照。 */
export interface ScopedTaskSnapshot {
  readonly id: string;
  readonly pluginId: string;
  readonly label: string;
  readonly state: "idle" | "queued" | "running" | "failed";
  readonly error?: string;
  readonly lastCompletedAt?: string;
  readonly nextRunAt?: string;
}
/** scoped 任务调度器。 */
export interface ScopedTaskScheduler {
  register(definition: ScopedTaskDefinition): () => void;
  runNow(id: string, reason?: string): Promise<void>;
  cancel(id: string): Promise<void>;
  snapshot(): readonly ScopedTaskSnapshot[];
  subscribe(listener: (snapshot: readonly ScopedTaskSnapshot[]) => void): () => void;
}
/** 内建任务调度器 capability 的保留静态标识。 */
export const SCOPED_TASK_SCHEDULER_CAPABILITY = "runtime.task-scheduler";

/** 生命周期稳定错误文案。 */
export const LIFECYCLE_ERROR_TEXT: Readonly<Record<string, string>> = Object.freeze({
  "lifecycle.scope_revoked": "运行实例已停止",
  "permission.denied": "插件没有获得该操作的权限",
  "permission.lease_revoked": "授权租约已撤销",
  "lifecycle.cleanup_failed": "资源清理失败，等待重试",
  "lifecycle.cleanup_timeout": "资源清理超时，仍在后台排空",
  "upgrade.gate_rejected": "版本接管门禁未通过",
});
/** 将生命周期错误码映射为中文提示。 */
export function lifecycleErrorText(code: string): string {
  return LIFECYCLE_ERROR_TEXT[code] ?? "生命周期操作未完成";
}
