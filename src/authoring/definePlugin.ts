// WebLoom v4 普通插件作者入口。

import {
  capabilityDescriptor,
  type Capability,
  type CapabilityDependency,
} from "../contracts/capability.js";
import type {
  PluginConfig,
  PluginContextExtension,
  PluginDefinition,
  PluginManifestInput,
  PluginSetup,
  PluginContribution,
  RuntimeUnitDescriptor,
} from "../contracts/plugin.js";
import type { PluginPermission, RuntimeKind } from "../contracts/lifecycle.js";

/** 普通插件定义选项；插件声明只使用 typed capability 与单一启动策略。 */
export interface DefinePluginOptions<
  TProvides extends readonly Capability[] = readonly Capability[],
  TDependencies extends readonly CapabilityDependency[] = readonly CapabilityDependency[],
  TContribution = PluginContribution,
  TConfig extends PluginConfig = PluginConfig,
  TExtension extends PluginContextExtension = PluginContextExtension,
> {
  /** 全局稳定插件标识。 */
  readonly id: string;
  /** 展示名称。 */
  readonly name?: string;
  /** 诊断描述。 */
  readonly description?: string;
  /** 本插件声明提供的能力。 */
  readonly provides?: TProvides;
  /** 本插件声明消费的能力。 */
  readonly dependencies?: TDependencies;
  /** 默认执行 Runtime。 */
  readonly runtime?: RuntimeKind;
  /** 多 unit 装配时的稳定 unit id。 */
  readonly unitId?: string;
  /** 申请权限。 */
  readonly permissions?: readonly PluginPermission[];
  /** 只读插件配置。 */
  readonly config?: TConfig;
  /** 领域贡献。 */
  readonly contribution?: TContribution;
  /** 唯一启动策略；默认为 optional。 */
  readonly startup?: "required" | "optional";
  /** 默认启用意图；required 时必须为 true。 */
  readonly defaultEnabled?: boolean;
  /** optional 插件默认为可停用；required 必须为 false。 */
  readonly canDisable?: boolean;
  /** 当前 realm 的插件实现。 */
  readonly setup: PluginSetup<TProvides, TDependencies, TConfig, TExtension>;
}

function nonEmpty(value: string, label: string): string {
  if (value.trim() === "") throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function normalizeDependencies(
  dependencies: readonly CapabilityDependency[],
  runtime: RuntimeKind,
): RuntimeUnitDescriptor["dependencies"] {
  return dependencies.map((dependency) => ({
    capability: capabilityDescriptor(dependency.capability),
    ...(dependency.source === "peer"
      ? { source: "peer" as const }
      : { sourceRuntime: dependency.sourceRuntime ?? runtime }),
    ...(dependency.reason !== undefined ? { reason: dependency.reason } : {}),
    ...(dependency.optional !== undefined ? { optional: dependency.optional } : {}),
  }));
}

/**
 * 声明一个插件。它不会创建 Host，也不会运行 setup；Runtime 装配边界
 * createWindowApp()/startSharedWorkerApp() 才会执行实现。
 */
export function definePlugin<
  TProvides extends readonly Capability[] = readonly Capability[],
  TDependencies extends readonly CapabilityDependency[] = readonly CapabilityDependency[],
  TContribution = PluginContribution,
  TConfig extends PluginConfig = PluginConfig,
  TExtension extends PluginContextExtension = PluginContextExtension,
>(options: DefinePluginOptions<TProvides, TDependencies, TContribution, TConfig, TExtension>): PluginDefinition<TProvides, TDependencies, TContribution, TConfig, TExtension> {
  if (!options || typeof options.id !== "string") throw new TypeError("Plugin id must be a non-empty string");
  nonEmpty(options.id, "Plugin id");
  if (typeof options.setup !== "function") throw new TypeError(`Plugin "${options.id}" setup must be a function`);
  const unitId = nonEmpty(options.unitId ?? options.id, `Plugin "${options.id}" unitId`);
  const startup = options.startup ?? "optional";
  const defaultEnabled = options.defaultEnabled ?? true;
  const canDisable = options.canDisable ?? startup !== "required";
  if (startup === "required" && (!defaultEnabled || canDisable)) {
    throw new TypeError(`Plugin "${options.id}" required startup policy is inconsistent`);
  }
  const provides = [...(options.provides ?? [])];
  const dependencies = [...(options.dependencies ?? [])];
  const runtime = options.runtime;
  const descriptor: RuntimeUnitDescriptor<TContribution, TConfig> = {
    id: unitId,
    ...(runtime !== undefined ? { runtime } : {}),
    ...(provides.length > 0 ? { provides: provides.map((capability) => capabilityDescriptor(capability)) } : {}),
    ...(dependencies.length > 0 ? { dependencies: normalizeDependencies(dependencies, runtime ?? "window-main") } : {}),
    ...(options.permissions !== undefined ? { permissions: [...options.permissions] } : {}),
    ...(options.config !== undefined ? { config: options.config } : {}),
    ...(options.contribution !== undefined ? { contribution: options.contribution } : {}),
  };
  const manifest: PluginManifestInput<TContribution, TConfig> = {
    id: options.id,
    name: options.name ?? options.id,
    ...(options.description !== undefined ? { description: options.description } : {}),
    startup,
    defaultEnabled,
    canDisable,
    units: [descriptor],
  };
  return Object.freeze({
    manifest: Object.freeze(manifest),
    descriptor: Object.freeze(descriptor),
    setup: options.setup,
    capabilities: Object.freeze([...provides, ...dependencies.map((dependency) => dependency.capability)]),
  });
}
