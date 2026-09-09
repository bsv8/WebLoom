// 面向普通插件作者的声明入口。
//
// definePlugin() 只返回“静态 descriptor + 本地实现”这两个内部装配所需的
// 部分。manifest 永远不携带 setup，因此可以安全地用于快照、诊断和跨
// realm 传输；实现函数只会在调用 definePlugin() 的那个 realm 被使用。

import type {
  PluginConfig,
  PluginContextExtension,
  PluginDependency,
  PluginManifestInput,
  PluginMeta,
  PluginSetup,
  PluginContribution,
  RuntimeDependency,
  RuntimeUnitDependencyInput,
  RuntimeUnitDescriptorInput,
} from "../contracts/plugin.js";
import {
  defineRuntimeUnitProvidedContracts,
  runtimeCapabilityContractVersion,
} from "../contracts/plugin.js";
import type { PluginPermission, RuntimeKind } from "../contracts/lifecycle.js";

export interface DefinePluginOptions<
  TContribution = PluginContribution,
  TConfig extends PluginConfig = PluginConfig,
  TExtension extends PluginContextExtension = PluginContextExtension,
> {
  /** 全局稳定插件标识。 */
  id: string;
  /** 默认展示名称。 */
  name?: string;
  /** 可选诊断描述。 */
  description?: string;
  /** 普通插件的可执行实现；不会进入静态 descriptor。 */
  setup: PluginSetup<TConfig, TExtension>;
  /** 默认目标 Runtime；普通 Window 插件通常省略，由 App 注入。 */
  runtime?: RuntimeKind;
  /** 默认 unit id；省略时使用插件 id。 */
  unitId?: string;
  /** 插件依赖；helper 会为本地依赖补齐 v1 契约版本。 */
  dependencies?: readonly (RuntimeDependency | PluginDependency)[];
  /** 本单元提供的 capability。 */
  provides?: readonly string[];
  /** 跨 Runtime 时可显式覆盖 capability 契约版本。 */
  providedContracts?: Readonly<Record<string, string>>;
  /** 请求的权限集合。 */
  permissions?: readonly PluginPermission[];
  /** 单元只读配置。 */
  config?: TConfig;
  /** 产品贡献；不会被框架解释。 */
  contribution?: TContribution;
  /** 是否默认启用；默认为 true。 */
  defaultEnabled?: boolean;
  /** 是否允许控制面停用；默认为 true。 */
  canDisable?: boolean;
  /** required 插件在 App 初始启动时必须成功。 */
  required?: boolean;
  /** 显式启动模式；required=true 时不能覆盖为 optional。 */
  startup?: "required" | "optional";
  /** 仅用于兼容低层消费方的静态 meta 扩展；WebLoom 不解释分类字段。 */
  meta?: Partial<PluginMeta>;
}

/** 静态 descriptor 与当前 realm 的实现函数分离。 */
export interface PluginDefinition<
  TContribution = PluginContribution,
  TConfig extends PluginConfig = PluginConfig,
  TExtension extends PluginContextExtension = PluginContextExtension,
> {
  readonly manifest: PluginManifestInput<TContribution, TConfig, TExtension>;
  readonly descriptor: RuntimeUnitDescriptorInput<TContribution, TConfig>;
  readonly setup: PluginSetup<TConfig, TExtension>;
}

function normalizeDependency(dependency: RuntimeDependency | PluginDependency): RuntimeUnitDependencyInput {
  const contractVersion = dependency.contractVersion ?? runtimeCapabilityContractVersion(dependency.capability);
  return {
    capability: dependency.capability,
    contractVersion,
    ...(dependency.sourceRuntime !== undefined ? { sourceRuntime: dependency.sourceRuntime } : {}),
    ...(dependency.reason !== undefined ? { reason: dependency.reason } : {}),
    ...(dependency.optional !== undefined ? { optional: dependency.optional } : {}),
  };
}

/**
 * 声明一个插件。
 *
 * 该函数不创建 Host，也不启动 setup；真正的启动边界由
 * createWindowApp()/startSharedWorkerApp() 拥有。
 */
export function definePlugin<
  TContribution = PluginContribution,
  TConfig extends PluginConfig = PluginConfig,
  TExtension extends PluginContextExtension = PluginContextExtension,
>(options: DefinePluginOptions<TContribution, TConfig, TExtension>): PluginDefinition<TContribution, TConfig, TExtension> {
  if (!options || typeof options.id !== "string" || options.id.trim() === "") {
    throw new Error("Plugin id must be a non-empty string");
  }
  if (typeof options.setup !== "function") throw new Error(`Plugin "${options.id}" setup must be a function`);

  const unitId = options.unitId ?? options.id;
  if (unitId.trim() === "") throw new Error(`Plugin "${options.id}" unitId must be a non-empty string`);
  const provides = [...new Set(options.provides ?? [])];
  const dependencies = (options.dependencies ?? []).map(normalizeDependency);
  const providedContracts = {
    ...defineRuntimeUnitProvidedContracts(provides),
    ...(options.providedContracts ?? {}),
  };
  const descriptor: RuntimeUnitDescriptorInput<TContribution, TConfig> = {
    id: unitId,
    ...(options.runtime !== undefined ? { runtime: options.runtime } : {}),
    ...(dependencies.length > 0 ? { dependencies } : {}),
    ...(provides.length > 0 ? { provides } : {}),
    ...(Object.keys(providedContracts).length > 0 ? { providedContracts } : {}),
    ...(options.contribution !== undefined ? { contribution: options.contribution } : {}),
    ...(options.permissions !== undefined ? { permissions: [...options.permissions] } : {}),
    ...(options.config !== undefined ? { config: options.config } : {}),
  };
  const metaInput = options.meta ?? {};
  const required = options.required === true
    || options.startup === "required"
    || metaInput.startup === "required";
  const meta: PluginMeta = {
    ...metaInput,
    defaultEnabled: options.defaultEnabled ?? metaInput.defaultEnabled ?? true,
    canDisable: options.canDisable ?? metaInput.canDisable ?? !required,
    startup: required ? "required" : (options.startup ?? metaInput.startup ?? "optional"),
  };
  // A required plugin must have one unambiguous policy. Do this at the authoring
  // boundary so createWindowApp() can fail before mutating a Host.
  if (meta.startup === "required" && (meta.canDisable || !meta.defaultEnabled)) {
    throw new Error(`Plugin "${options.id}" required metadata is inconsistent`);
  }
  const manifest: PluginManifestInput<TContribution, TConfig, TExtension> = {
    id: options.id,
    name: options.name ?? options.id,
    ...(options.description !== undefined ? { description: options.description } : {}),
    meta,
    units: [descriptor],
  };
  return Object.freeze({
    manifest: Object.freeze(manifest),
    descriptor: Object.freeze(descriptor),
    setup: options.setup,
  });
}
