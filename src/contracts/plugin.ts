// WebLoom v4 插件公共契约。
//
// 静态 manifest 只包含可复制的描述；实现函数、parser、transfer extractor
// 和 handler 由当前 realm 的装配层保存。普通插件作者不需要接触 Host。

import type {
  Capability,
  CapabilityClient,
  CapabilityDependency,
  PeerCapabilityDependency,
  CapabilityDescriptor,
  LocalCapability,
  LocalServiceOf,
  RemoteCapability,
  RpcCapability,
  RpcHandler,
  StreamCapability,
  StreamHandler,
} from "./capability.js";
import type {
  LifecycleScope,
  PermissionLease,
  PluginPermission,
  RuntimeKind,
  ScopedTaskScheduler,
} from "./lifecycle.js";
import type { MessageBus } from "./messageBus.js";

/** 宿主注入的只读结构化属性；不得放入私钥、口令或 Seed。 */
export type PluginAttributes = Readonly<Record<string, unknown>>;

/** 插件配置的默认形状。 */
export type PluginConfig = Readonly<Record<string, unknown>>;

/** 插件对宿主的领域贡献；具体产品通过泛型定义。 */
export type PluginContribution = unknown;

/** 插件 Context Extension 的默认形状。 */
export type PluginContextExtension = Readonly<Record<string, unknown>>;

/** 插件运行单元的清理函数。 */
export type PluginTeardown = () => void | Promise<void>;

type DeclaredCapability<TProvides extends readonly Capability[]> = TProvides[number];
type DeclaredDependencyCapability<TDependencies extends readonly CapabilityDependency[]> =
  TDependencies[number] extends CapabilityDependency<infer C> ? C : never;
type DeclaredPeerDependencyCapability<TDependencies extends readonly CapabilityDependency[]> =
  TDependencies[number] extends infer D
    ? D extends PeerCapabilityDependency<infer C> ? C : never
    : never;
type DeclaredRuntimeDependencyCapability<TDependencies extends readonly CapabilityDependency[]> =
  Exclude<DeclaredDependencyCapability<TDependencies>, DeclaredPeerDependencyCapability<TDependencies>>;
type AvailableCapability<
  TProvides extends readonly Capability[],
  TDependencies extends readonly CapabilityDependency[],
> = DeclaredCapability<TProvides> | DeclaredRuntimeDependencyCapability<TDependencies>;
type DeclaredLocal<TProvides extends readonly Capability[]> = Extract<DeclaredCapability<TProvides>, { kind: "local" }>;
type DeclaredRemote<TProvides extends readonly Capability[]> = Extract<DeclaredCapability<TProvides>, { kind: "rpc" | "stream" }>;

/** 插件 Context；能力参数和返回值从 capability 对象端到端推导。 */
export interface PluginContext<
  TProvides extends readonly Capability[] = readonly Capability[],
  TDependencies extends readonly CapabilityDependency[] = readonly CapabilityDependency[],
  TConfig extends PluginConfig = PluginConfig,
  TExtension extends PluginContextExtension = PluginContextExtension,
> {
  /** Host 绑定的稳定插件标识。 */
  readonly pluginId: string;
  /** 本次插件启动生成的实例标识。 */
  readonly instanceId: string;
  /** 稳定运行单元标识。 */
  readonly unitId: string;
  /** 当前插件实例作用域。 */
  readonly scope: LifecycleScope;
  /** 撤权和停止信号。 */
  readonly signal: AbortSignal;
  /** 可信装配批准后的权限视图。 */
  readonly permissions: readonly PluginPermission[];
  /** 绑定实例与权限身份的租约。 */
  readonly permissionLease: PermissionLease;
  /** 当前插件实例的后台任务调度器。 */
  readonly taskScheduler?: ScopedTaskScheduler;
  /** 宿主注入的只读领域扩展。 */
  readonly extension: TExtension;
  /** 插件配置。 */
  readonly config?: TConfig;
  /** 注册在同步撤权之后异步执行的清理。 */
  onDispose(cleanup: PluginTeardown): void;
  /** 只允许注册本插件声明的 local provides。 */
  provide<C extends DeclaredLocal<TProvides>>(capability: C, value: LocalServiceOf<C>): void;
  /** 只允许注册本插件声明的 RPC/stream provides。 */
  handle<C extends DeclaredRemote<TProvides>>(
    capability: C,
    handler: C extends RpcCapability<infer TRequest, infer TResponse>
      ? RpcHandler<RpcCapability<TRequest, TResponse>>
      : C extends StreamCapability<infer TRequest, infer TItem>
        ? StreamHandler<StreamCapability<TRequest, TItem>>
        : never,
  ): void;
  /** 获取当前声明范围内的 typed 能力；远程能力获取是惰性的。 */
  capability<C extends AvailableCapability<TProvides, TDependencies>>(capability: C): CapabilityClient<Extract<C, Capability>>;
  /** 当前目录没有该能力时返回 undefined。 */
  optionalCapability<C extends AvailableCapability<TProvides, TDependencies>>(capability: C): CapabilityClient<Extract<C, Capability>> | undefined;
  /** scoped MessageBus；业务事件不承担 Runtime 控制 wire。 */
  readonly messageBus: MessageBus;
}

/** 静态依赖描述；wire 不携带 capability 对象引用。 */
export type RuntimeUnitDependency = {
  /** 依赖 capability 的静态身份。 */
  readonly capability: CapabilityDescriptor;
  /** 可选依赖只影响局部功能。 */
  readonly optional?: boolean;
  /** 面向诊断的依赖说明。 */
  readonly reason?: string;
} & (
  /** 按调用 peer 解析的依赖；不参加全局 Host 启动图。 */
  | { readonly source: "peer"; readonly sourceRuntime?: never }
  /** 精确来源 Runtime。 */
  | { readonly source?: never; readonly sourceRuntime: RuntimeKind }
);

/** 作者输入的依赖；装配层补齐 sourceRuntime。 */
export type RuntimeUnitDependencyInput = CapabilityDependency & {
  /** 当前 realm 的 capability 对象。 */
  readonly capability: Capability;
};

/** 一个静态运行单元描述；不含 setup/parser/transfer 函数。 */
export interface RuntimeUnitDescriptor<
  TContribution = PluginContribution,
  TConfig extends PluginConfig = PluginConfig,
> {
  /** 稳定运行单元标识。 */
  readonly id: string;
  /** 真实执行 Runtime。 */
  readonly runtime?: RuntimeKind;
  /** 该单元的精确依赖。 */
  readonly dependencies?: readonly RuntimeUnitDependency[];
  /** 该单元提供的 capability 静态身份。 */
  readonly provides?: readonly CapabilityDescriptor[];
  /** 领域贡献。 */
  readonly contribution?: TContribution;
  /** 该单元申请的权限。 */
  readonly permissions?: readonly PluginPermission[];
  /** 单元只读配置。 */
  readonly config?: TConfig;
}

/** 作者输入的运行单元描述；capability 对象仅留在当前 realm 装配层。 */
export type RuntimeUnitDescriptorInput<
  TContribution = PluginContribution,
  TConfig extends PluginConfig = PluginConfig,
> = Omit<RuntimeUnitDescriptor<TContribution, TConfig>, "dependencies" | "provides" | "runtime"> & {
  /** 运行时注入的目标 Runtime。 */
  readonly runtime?: RuntimeKind;
  /** 当前 realm 的 typed 依赖对象。 */
  readonly dependencies?: readonly RuntimeUnitDependencyInput[];
  /** 当前 realm 的 typed 提供对象。 */
  readonly provides?: readonly Capability[];
};

export type PluginStartupMode = "required" | "optional";

/** 插件静态 manifest；startup/defaultEnabled/canDisable 是唯一启停策略。 */
export interface PluginManifest<
  TContribution = PluginContribution,
  TConfig extends PluginConfig = PluginConfig,
> {
  /** 全局稳定插件标识。 */
  readonly id: string;
  /** 展示名称。 */
  readonly name: string;
  /** 可选诊断描述。 */
  readonly description?: string;
  /** 初始启停策略。 */
  readonly startup: PluginStartupMode;
  /** 默认启用意图。 */
  readonly defaultEnabled: boolean;
  /** 是否允许控制面停用。 */
  readonly canDisable: boolean;
  /** 多 Runtime 静态单元。 */
  readonly units?: readonly RuntimeUnitDescriptor<TContribution, TConfig>[];
}

/** 作者输入的静态 manifest。 */
export type PluginManifestInput<
  TContribution = PluginContribution,
  TConfig extends PluginConfig = PluginConfig,
> = PluginManifest<TContribution, TConfig>;

/** 插件运行状态。 */
export type PluginStateKind =
  | "registered"
  | "starting"
  | "stopping"
  | "enabled"
  | "disabled"
  | "blocked"
  | "error-disabled"
  | "cleanup-pending"
  | "unknown";

/** 对外稳定的插件生命周期语义。 */
export type PluginLifecycleState = "disabled" | "waiting" | "starting" | "running" | "stopping" | "failed";

/** Host 查询到的插件状态。 */
export interface PluginState {
  /** 插件标识。 */
  readonly id: string;
  /** 当前内部状态。 */
  readonly kind: PluginStateKind;
  /** 稳定生命周期映射。 */
  readonly lifecycleState: PluginLifecycleState;
  /** 脱敏错误文本。 */
  readonly error?: string;
  /** 当前启用意图。 */
  readonly desiredEnabled: boolean;
  /** 当前意图修订。 */
  readonly desiredRevision?: number;
  /** 当前启动实例。 */
  readonly instanceId?: string;
  /** 当前运行单元。 */
  readonly unitId?: string;
  /** 阻塞原因。 */
  readonly blockedBy?: readonly string[];
  /** 最近一次清理结果。 */
  readonly cleanup?: import("./lifecycle.js").LifecycleDisposeResult;
  /** 单元状态。 */
  readonly units: readonly PluginUnitState[];
}

/** 运行单元状态。 */
export interface PluginUnitState {
  /** 所属插件。 */
  readonly pluginId: string;
  /** 稳定单元标识。 */
  readonly unitId: string;
  /** 真实 Runtime。 */
  readonly runtime: RuntimeKind;
  /** 当前启动实例。 */
  readonly instanceId?: string;
  /** 当前意图修订。 */
  readonly desiredRevision?: number;
  /** 单元状态。 */
  readonly kind: PluginStateKind;
  /** 脱敏错误文本。 */
  readonly error?: string;
  /** 清理结果。 */
  readonly cleanup?: import("./lifecycle.js").LifecycleDisposeResult;
}

/** 依赖图中的反向依赖者。 */
export interface PluginReverseDep {
  /** 反向依赖插件标识。 */
  readonly pluginId: string;
  /** 依赖者是否启用。 */
  readonly enabled: boolean;
  /** 触发依赖的 capability 身份。 */
  readonly capabilities: readonly CapabilityDescriptor[];
}

/** 插件依赖图快照。 */
export interface PluginGraph {
  /** 已知插件。 */
  readonly plugins: readonly string[];
  /** 插件依赖。 */
  readonly dependencies: Readonly<Record<string, readonly CapabilityDescriptor[]>>;
  /** 可选依赖。 */
  readonly optionalDependencies: Readonly<Record<string, readonly CapabilityDescriptor[]>>;
  /** 插件提供。 */
  readonly provides: Readonly<Record<string, readonly CapabilityDescriptor[]>>;
  /** 反向依赖。 */
  readonly reverse: Readonly<Record<string, readonly PluginReverseDep[]>>;
  /** capability 到提供者。 */
  readonly providers: Readonly<Record<string, readonly string[]>>;
  /** 依赖环。 */
  readonly cycles: readonly (readonly string[])[];
  /** 运行单元图。 */
  readonly units: Readonly<Record<string, PluginUnitGraph>>;
}

/** 运行单元依赖图节点。 */
export interface PluginUnitGraph {
  /** 所属插件。 */
  readonly pluginId: string;
  /** 单元标识。 */
  readonly unitId: string;
  /** 真实 Runtime。 */
  readonly runtime: RuntimeKind;
  /** capability 依赖。 */
  readonly dependencies: readonly CapabilityDescriptor[];
  /** capability 提供。 */
  readonly provides: readonly CapabilityDescriptor[];
}

/** Host 状态订阅。 */
export type HostListener = (snapshot: { readonly version: number }) => void;

/** 缺少能力的结构化启动详情。 */
export interface StartupCapabilityErrorDetails {
  /** capability 身份。 */
  readonly capability: CapabilityDescriptor;
  /** 已知提供者插件。 */
  readonly providerPluginId?: string;
  /** 提供者状态。 */
  readonly providerState?: PluginStateKind;
  /** 提供者错误。 */
  readonly providerError?: string;
  /** 当前启用意图。 */
  readonly configuredEnabled?: boolean;
}

/** 启动插件失败详情。 */
export interface StartupPluginErrorDetails {
  /** 插件标识。 */
  readonly pluginId: string;
  /** 失败单元。 */
  readonly unitId?: string;
  /** 声明提供的 capability。 */
  readonly capabilities: readonly CapabilityDescriptor[];
  /** 当前状态。 */
  readonly state: PluginStateKind;
  /** 脱敏错误。 */
  readonly error?: string;
}

/** 插件定义：静态 manifest 与当前 realm setup 分离。 */
export interface PluginDefinition<
  TProvides extends readonly Capability[] = readonly Capability[],
  TDependencies extends readonly CapabilityDependency[] = readonly CapabilityDependency[],
  TContribution = PluginContribution,
  TConfig extends PluginConfig = PluginConfig,
  TExtension extends PluginContextExtension = PluginContextExtension,
> {
  /** 不含函数的静态描述。 */
  readonly manifest: PluginManifest<TContribution, TConfig>;
  /** 当前实现绑定的单元描述。 */
  readonly descriptor: RuntimeUnitDescriptor<TContribution, TConfig>;
  /** 当前 realm 的 setup。 */
  readonly setup: PluginSetup<TProvides, TDependencies, TConfig, TExtension>;
  /** 当前 realm 使用的完整 capability 对象集合。 */
  readonly capabilities: readonly Capability[];
}

/** 插件运行单元实现。 */
export type PluginSetup<
  TProvides extends readonly Capability[] = readonly Capability[],
  TDependencies extends readonly CapabilityDependency[] = readonly CapabilityDependency[],
  TConfig extends PluginConfig = PluginConfig,
  TExtension extends PluginContextExtension = PluginContextExtension,
> = (ctx: PluginContext<TProvides, TDependencies, TConfig, TExtension>) =>
  void | Promise<void> | PluginTeardown | Promise<PluginTeardown>;

/** 按插件/单元查找当前 realm 的 setup。 */
export interface RuntimeUnitImplementationRegistry {
  /** 未注册实现时返回 undefined。 */
  get(pluginId: string, unitId: string): PluginSetup | undefined;
  /** 当前 realm 的 capability 定义表；静态 manifest 只含 descriptor。 */
  getCapabilities?(pluginId: string, unitId: string): readonly Capability[] | undefined;
}
