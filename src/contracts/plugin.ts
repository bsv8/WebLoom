// WebLoom 插件公共契约。
//
// 这里故意只描述插件、运行单元和宿主扩展点。具体产品可以通过泛型扩展
// contribution、config、attributes 和 Context Extension，但不能把领域字段
// 反向写进 WebLoom 核心。

import type { MessageBus } from "./messageBus.js";
import type {
  LifecycleScope,
  PluginExecution,
  PluginLifetime,
  PluginPermission,
  PermissionLease,
  RemoteServiceBridge,
  ScopedTaskScheduler,
} from "./lifecycle.js";

/** 宿主注入的只读结构化属性；不得放入私钥、口令或 Seed。 */
export type PluginAttributes = Readonly<Record<string, unknown>>;

/** 插件配置的默认形状；具体配置由产品通过泛型约束。 */
export type PluginConfig = Readonly<Record<string, unknown>>;

/** 插件对宿主贡献的默认形状；具体贡献由产品通过泛型约束。 */
export type PluginContribution = unknown;

/** 插件 Context Extension 的默认形状；领域服务只能从这里注入。 */
export type PluginContextExtension = Readonly<Record<string, unknown>>;

/** 插件运行时上下文，由 Host 创建并传入运行单元实现。 */
export interface PluginContext<
  TConfig extends PluginConfig = PluginConfig,
  TExtension extends PluginContextExtension = PluginContextExtension,
> {
  /** Host 绑定的稳定产品标识；插件不能从调用参数伪造其它标识。 */
  readonly pluginId: string;
  /** 本次装配生成的实例标识；重启不得复用。 */
  readonly instanceId: string;
  /** 稳定运行单元标识；不等于本次启动的 instanceId。 */
  readonly unitId: string;
  /** 当前插件实例的作用域；业务资源应登记到此作用域。 */
  readonly scope: LifecycleScope;
  /** 作用域撤权信号；停止、禁用和宿主关闭时触发。 */
  readonly signal: AbortSignal;
  /** 可信装配层批准后的权限视图；插件自声明不能扩大集合。 */
  readonly permissions: readonly PluginPermission[];
  /** 绑定当前实例和权限身份的租约；最终 I/O 仍需再次校验。 */
  readonly permissionLease: PermissionLease;
  /** 已完成握手和快照校验的远程服务桥。 */
  readonly serviceBridge?: RemoteServiceBridge;
  /** 绑定当前插件实例的后台任务注册面。 */
  readonly taskScheduler?: ScopedTaskScheduler;
  /** 宿主注入的领域扩展；只读且不能替换实例身份。 */
  readonly extension: TExtension;
  /** 注册在停止前运行的清理函数；重复停止必须幂等。 */
  onDispose(cleanup: PluginTeardown): void;
  /** 注册 capability；重复注册会抛错。 */
  provide<T>(key: string, value: T): void;
  /** 读取 capability；缺失会抛错。 */
  get<T>(key: string): T;
  /** 探测 capability 是否存在。 */
  has(key: string): boolean;
  /** 要求 capability 存在，否则抛错。 */
  require(key: string): void;
  /** 事件、命令和请求响应的统一入口。 */
  readonly messageBus: MessageBus;
  /** 宿主注入的只读配置；不与启停意图存储混用。 */
  readonly config?: TConfig;
}

/** 产品级依赖描述；简单插件可使用，跨环境单元应使用严格依赖。 */
export interface PluginDependency {
  /** 依赖的 capability 标识。 */
  capability: string;
  /** 精确契约版本；跨环境依赖不得省略。 */
  contractVersion?: string;
  /** 提供者代码所在执行环境；由宿主定义。 */
  sourceExecution?: PluginExecution;
  /** 提供者允许存在的生命周期；由宿主定义。 */
  scope?: PluginLifetime;
  /** 可选的人类可读诊断说明。 */
  reason?: string;
  /** 缺失时只关闭局部能力，不阻止主体运行。 */
  optional?: boolean;
}

/** 运行单元的严格依赖描述。 */
export interface RuntimeUnitDependency {
  /** 依赖的 capability 标识。 */
  capability: string;
  /** 精确契约版本；第一阶段只接受完全匹配。 */
  contractVersion: string;
  /** 提供者实际运行环境。 */
  sourceExecution: PluginExecution;
  /** 提供者允许存在的生命周期。 */
  scope: PluginLifetime;
  /** 可选的人类可读诊断说明。 */
  reason?: string;
  /** 缺失时只关闭局部能力；未填写表示硬依赖。 */
  optional?: boolean;
}

/** 返回稳定的 capability 契约版本。 */
export function runtimeCapabilityContractVersion(capability: string): string {
  return `${capability}.v1`;
}

/** 将依赖清单补齐为严格运行单元依赖。 */
export function defineRuntimeUnitDependencies(
  dependencies: readonly Pick<PluginDependency, "capability" | "reason" | "optional">[],
  defaults: Partial<Pick<RuntimeUnitDependency, "sourceExecution" | "scope">> = {},
): RuntimeUnitDependency[] {
  return dependencies.map((dependency) => ({
    capability: dependency.capability,
    contractVersion: runtimeCapabilityContractVersion(dependency.capability),
    sourceExecution: defaults.sourceExecution ?? "default",
    scope: defaults.scope ?? "root",
    ...(dependency.reason !== undefined ? { reason: dependency.reason } : {}),
    ...(dependency.optional !== undefined ? { optional: dependency.optional } : {}),
  }));
}

/** 为运行单元生成精确的 capability 契约版本表。 */
export function defineRuntimeUnitProvidedContracts(
  capabilities: readonly string[],
): Record<string, string> {
  return Object.fromEntries(
    capabilities.map((capability) => [capability, runtimeCapabilityContractVersion(capability)]),
  );
}

/** 插件在产品清单中的启动要求。 */
export type PluginStartupMode = "required" | "optional";

/** 插件展示元数据；kind、group 和 execution 都由宿主或产品定义。 */
export interface PluginMeta {
  /** 产品自定义分类，不由 WebLoom 解释。 */
  kind?: string;
  /** 首次装配时默认是否启用。 */
  defaultEnabled: boolean;
  /** 是否允许产品控制面禁用。 */
  canDisable: boolean;
  /** 是否属于启动必需插件。 */
  startup?: PluginStartupMode;
  /** 产品自定义展示分组。 */
  displayGroup?: string;
  /** 默认运行生命周期；未填写时使用宿主默认值。 */
  lifetime?: PluginLifetime;
  /** 默认执行环境；不从 UI 或实现类型推断。 */
  execution?: PluginExecution;
}

/** 插件 setup 返回的清理函数。 */
export type PluginTeardown = () => void | Promise<void>;

/** 插件运行单元的无 UI 装配入口。 */
export type PluginSetup<
  TConfig extends PluginConfig = PluginConfig,
  TExtension extends PluginContextExtension = PluginContextExtension,
> = (ctx: PluginContext<TConfig, TExtension>) =>
  void | Promise<void> | PluginTeardown | Promise<PluginTeardown>;

/** 当前执行环境中按 productId + unitId 解析实现。 */
export interface RuntimeUnitImplementationRegistry<
  TConfig extends PluginConfig = PluginConfig,
  TExtension extends PluginContextExtension = PluginContextExtension,
> {
  /** 未装配实现时返回 undefined。 */
  get(pluginId: string, unitId: string): PluginSetup<TConfig, TExtension> | undefined;
}

/** 一个产品可以装配的运行单元。 */
export interface RuntimeUnitDescriptor<
  TContribution = PluginContribution,
  TConfig extends PluginConfig = PluginConfig,
> {
  /** 稳定运行单元标识。 */
  id: string;
  /** 运行代码所在环境。 */
  execution: PluginExecution;
  /** 依附的作用域寿命。 */
  lifetime: PluginLifetime;
  /** 本单元所需的精确 capability 契约。 */
  dependencies?: RuntimeUnitDependency[];
  /** 本单元提供的 capability。 */
  provides?: string[];
  /** 本单元每个 capability 的精确版本。 */
  providedContracts?: Record<string, string>;
  /** 宿主贡献；内容由产品泛型定义。 */
  contribution?: TContribution;
  /** 本单元申请的权限。 */
  permissions?: PluginPermission[];
  /** 单元专属只读配置声明或装配默认值。 */
  config?: TConfig;
}

/** 插件清单；插件作者导出的唯一静态描述。 */
export interface PluginManifest<
  TContribution = PluginContribution,
  TConfig extends PluginConfig = PluginConfig,
  TExtension extends PluginContextExtension = PluginContextExtension,
> {
  /** 全局稳定产品标识。 */
  id: string;
  /** 展示名称。 */
  name: string;
  /** 展示描述。 */
  description?: string;
  /** 简单插件的宿主贡献；复杂产品通过运行单元声明。 */
  contribution?: TContribution;
  /** 简单插件的兼容依赖。 */
  dependencies?: PluginDependency[];
  /** 简单插件声明提供的 capability；多单元插件必须放入 unit.provides。 */
  provides?: string[];
  /** 产品元数据。 */
  meta: PluginMeta;
  /** 简单插件的申请权限。 */
  permissions?: PluginPermission[];
  /** 多环境插件的静态运行单元描述。 */
  units?: readonly RuntimeUnitDescriptor<TContribution, TConfig>[];
  /** 简单插件的只读配置。 */
  config?: TConfig;
}

/** 插件运行状态类别；registered 不代表已经运行。 */
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

/** 对外稳定的产品运行语义。 */
export type PluginLifecycleState = "disabled" | "waiting" | "starting" | "running" | "stopping" | "failed";

/** Host 查询到的插件状态。 */
export interface PluginState {
  /** 产品标识。 */
  id: string;
  /** 兼容状态类别。 */
  kind: PluginStateKind;
  /** 稳定生命周期语义。 */
  lifecycleState?: PluginLifecycleState;
  /** 最近一次错误。 */
  error?: string;
  /** 持久化启用意图。 */
  desiredEnabled?: boolean;
  /** 当前产品意图修订。 */
  desiredRevision?: number;
  /** 当前运行实例标识。 */
  instanceId?: string;
  /** 当前运行单元标识。 */
  unitId?: string;
  /** 当前阻塞或清理原因。 */
  blockedBy?: string[];
  /** 最近一次结构化清理结果。 */
  cleanup?: import("./lifecycle.js").LifecycleDisposeResult;
  /** 当前产品下的运行单元状态。 */
  units?: readonly PluginUnitState[];
}

/** 运行单元状态；唯一身份由 product、unit 和 instance 共同组成。 */
export interface PluginUnitState {
  /** 所属产品标识。 */
  pluginId: string;
  /** 稳定运行单元标识。 */
  unitId: string;
  /** 运行环境。 */
  execution: PluginExecution;
  /** 当前运行实例。 */
  instanceId?: string;
  /** 当前意图修订。 */
  desiredRevision?: number;
  /** 单元状态。 */
  kind: PluginStateKind;
  /** 单元失败原因。 */
  error?: string;
  /** 单元清理结果。 */
  cleanup?: import("./lifecycle.js").LifecycleDisposeResult;
}

/** 依赖图中的反向依赖者。 */
export interface PluginReverseDep {
  /** 反向依赖产品标识。 */
  pluginId: string;
  /** 依赖者当前是否运行。 */
  enabled: boolean;
  /** 触发依赖的 capability。 */
  capabilities: string[];
}

/** 插件依赖图快照。 */
export interface PluginGraph {
  /** 已知产品标识列表。 */
  plugins: string[];
  /** 产品依赖的 capability。 */
  dependencies: Record<string, string[]>;
  /** 产品的可选依赖。 */
  optionalDependencies?: Record<string, string[]>;
  /** 产品声明提供的 capability。 */
  provides: Record<string, string[]>;
  /** capability 到反向依赖者。 */
  reverse: Record<string, PluginReverseDep[]>;
  /** capability 到声明提供者。 */
  providers?: Record<string, string[]>;
  /** 精确依赖描述。 */
  dependencyDetails?: Record<string, PluginDependency[]>;
  /** 发现的硬依赖环。 */
  cycles?: string[][];
  /** 当前图中的运行单元。 */
  units?: Record<string, PluginUnitGraph>;
}

/** 运行单元依赖图节点。 */
export interface PluginUnitGraph {
  /** 所属产品标识。 */
  pluginId: string;
  /** 稳定运行单元标识。 */
  unitId: string;
  /** 运行环境。 */
  execution: PluginExecution;
  /** capability 依赖。 */
  dependencies: string[];
  /** 精确依赖描述。 */
  dependencyDetails?: RuntimeUnitDependency[];
  /** capability 提供。 */
  provides: string[];
  /** capability 精确版本。 */
  providedContracts?: Record<string, string>;
}

/** Host 版本或状态变化监听器。 */
export type HostListener = (snapshot: { version: number }) => void;

/** 启动前能力检查的结构化详情。 */
export interface StartupCapabilityErrorDetails {
  /** 缺失 capability 标识。 */
  capability: string;
  /** 已知提供者产品标识。 */
  providerPluginId?: string;
  /** 提供者状态。 */
  providerState?: PluginStateKind;
  /** 提供者错误。 */
  providerError?: string;
  /** 当前持久化意图。 */
  configuredEnabled?: boolean;
}

/** 启动插件失败的结构化详情。 */
export interface StartupPluginErrorDetails {
  /** 产品标识。 */
  pluginId: string;
  /** 能力列表。 */
  capabilities: string[];
  /** 当前状态。 */
  state: PluginStateKind;
  /** 最近错误。 */
  error?: string;
}
