// 插件依赖图：依赖 capability，而不是依赖 manifest 顺序或 pluginId 猜测。
//
// 图是纯描述数据；启停状态由 Host/config store 提供。这样同一份图可以在
// SharedWorker、页面和测试中复用，页面不会另起一套业务生命周期。

import type {
  PluginDependency,
  PluginGraph,
  PluginManifest,
  PluginReverseDep,
  PluginUnitGraph,
  RuntimeUnitDependency,
  RuntimeUnitDescriptor,
} from "../contracts/plugin.js";
import type { PluginExecution, PluginLifetime } from "../contracts/lifecycle.js";

export interface BuildPluginGraphOptions {
  /** 当前真正运行的插件；不传时使用 manifest.meta.defaultEnabled。 */
  enabledPluginIds?: ReadonlySet<string>;
  /** 当前 Host 实际执行环境；未选中的 Worker/Window 单元不会进入图。 */
  execution?: PluginExecution;
}

export interface ValidatePluginGraphOptions extends BuildPluginGraphOptions {
  /** 平台内建 capability，不需要由某个 manifest 提供。 */
  builtinCapabilities?: ReadonlySet<string>;
  /** 允许多 Provider 的 capability；调用方必须有专门 Registry 选择语义。 */
  multiProviderCapabilities?: ReadonlySet<string>;
  /** Host 分批注册时允许 provider 尚未注册；真正装配前仍会进入 blocked。 */
  allowMissingDependencies?: boolean;
}

export interface PluginGraphDiagnostic {
  /** 稳定诊断码。 */
  code:
    | "plugin.duplicate_id"
    | "capability.duplicate_provider"
    | "plugin.missing_dependency"
    | "plugin.dependency_cycle"
    | "plugin.dependency_contract_invalid"
    | "plugin.dependency_contract_unavailable"
    | "plugin.runtime_declaration_at_product_level";
  /** 相关插件或 capability。 */
  ids: string[];
  /** 中文诊断原因，供设置页直接显示或再做 i18n 映射。 */
  message: string;
}

/** 依赖图不满足装配条件。 */
export class PluginGraphValidationError extends Error {
  readonly code = "plugin.graph_invalid" as const;
  readonly diagnostics: readonly PluginGraphDiagnostic[];

  constructor(diagnostics: readonly PluginGraphDiagnostic[]) {
    super(diagnostics.map((diagnostic) => diagnostic.message).join("; "));
    this.name = "PluginGraphValidationError";
    this.diagnostics = [...diagnostics];
  }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function isPluginExecution(value: unknown): value is PluginExecution {
  return typeof value === "string" && value.trim().length > 0;
}

function isPluginLifetime(value: unknown): value is PluginLifetime {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * 校验所有显式运行单元的跨环境依赖契约。
 *
 * 多运行单元产品的运行期声明必须全部位于对应 unit；产品级字段只给没有
 * `units` 的简单插件保留兼容性。此函数同时服务 TypeScript 以外导入的
 * manifest，避免运行时只依赖静态类型。
 */
export function validateRuntimeUnitDependencyContracts(
  manifests: readonly PluginManifest[]
): PluginGraphDiagnostic[] {
  const diagnostics: PluginGraphDiagnostic[] = [];
  for (const manifest of manifests) {
    const units = manifest.units;
    if (units === undefined) continue;
    const productLevelFields = [
      ["dependencies", manifest.dependencies],
      ["permissions", manifest.permissions],
      ["contribution", manifest.contribution],
      ["config", manifest.config],
    ] as const;
    for (const [field, value] of productLevelFields) {
      if (value === undefined) continue;
      diagnostics.push({
        code: "plugin.runtime_declaration_at_product_level",
        ids: [manifest.id, field],
        message: `多运行单元插件 "${manifest.id}" 的 ${field} 必须声明在对应 RuntimeUnitDescriptor 中，不能使用产品级 fallback`,
      });
    }
    if ((manifest.provides?.length ?? 0) > 0) {
      diagnostics.push({
        code: "plugin.runtime_declaration_at_product_level",
        ids: [manifest.id, "provides"],
        message: `多运行单元插件 "${manifest.id}" 的 provides 必须声明在对应 RuntimeUnitDescriptor 中，不能使用产品级 capability 摘要`,
      });
    }
    if (!Array.isArray(units)) {
      diagnostics.push({
        code: "plugin.dependency_contract_invalid",
        ids: [manifest.id, "units"],
        message: `插件 "${manifest.id}" 的 units 必须是运行单元数组`,
      });
      continue;
    }
    units.forEach((unitValue, unitIndex) => {
      if (!isRecord(unitValue)) {
        diagnostics.push({
          code: "plugin.dependency_contract_invalid",
          ids: [manifest.id, `unit:${unitIndex}`],
          message: `插件 "${manifest.id}" 的第 ${unitIndex + 1} 个运行单元描述无效`,
        });
        return;
      }
      const unitId = typeof unitValue.id === "string" && unitValue.id.length > 0
        ? unitValue.id
        : `unit:${unitIndex}`;
      const providedContracts = unitValue.providedContracts;
      if (providedContracts !== undefined) {
        if (!isRecord(providedContracts)) {
          diagnostics.push({
            code: "plugin.dependency_contract_invalid",
            ids: [manifest.id, unitId],
            message: `插件 "${manifest.id}" 的运行单元 "${unitId}" 的 providedContracts（提供契约版本）必须是对象`,
          });
        } else {
          for (const [capability, version] of Object.entries(providedContracts)) {
            if (typeof version !== "string" || version.trim() === "") {
              diagnostics.push({
                code: "plugin.dependency_contract_invalid",
                ids: [manifest.id, unitId, capability],
                message: `插件 "${manifest.id}" 的运行单元 "${unitId}" 为能力 "${capability}" 声明的契约版本不能为空`,
              });
            }
          }
        }
      }
      const dependencies = unitValue.dependencies;
      if (dependencies === undefined) return;
      if (!Array.isArray(dependencies)) {
        diagnostics.push({
          code: "plugin.dependency_contract_invalid",
          ids: [manifest.id, unitId],
          message: `插件 "${manifest.id}" 的运行单元 "${unitId}" 的 dependencies 必须是数组`,
        });
        return;
      }
      dependencies.forEach((dependencyValue, dependencyIndex) => {
        const dependency = isRecord(dependencyValue)
          ? dependencyValue as Partial<RuntimeUnitDependency>
          : {};
        const errors: string[] = [];
        if (typeof dependency.capability !== "string" || dependency.capability.trim() === "") {
          errors.push("capability（能力标识）不能为空");
        }
        if (typeof dependency.contractVersion !== "string" || dependency.contractVersion.trim() === "") {
          errors.push("contractVersion（契约版本）不能为空");
        }
        if (!isPluginExecution(dependency.sourceExecution)) {
          errors.push("sourceExecution（提供者运行环境）无效");
        }
        if (!isPluginLifetime(dependency.scope)) {
          errors.push("scope（提供者作用域）无效");
        }
        if (dependency.reason !== undefined && typeof dependency.reason !== "string") {
          errors.push("reason（依赖说明）必须是字符串");
        }
        if (dependency.optional !== undefined && typeof dependency.optional !== "boolean") {
          errors.push("optional（是否可选）必须是布尔值");
        }
        if (errors.length === 0) return;
        const capability = typeof dependency.capability === "string" && dependency.capability.length > 0
          ? dependency.capability
          : `dependency:${dependencyIndex}`;
        diagnostics.push({
          code: "plugin.dependency_contract_invalid",
          ids: [manifest.id, unitId, capability],
          message: `插件 "${manifest.id}" 的运行单元 "${unitId}" 第 ${dependencyIndex + 1} 条依赖契约无效：${errors.join("、")}`,
        });
      });
    });
  }
  return diagnostics;
}

function selectedRuntimeUnits(
  manifest: PluginManifest,
  execution?: PluginExecution
): Array<RuntimeUnitDescriptor & { id: string }> {
  const units = manifest.units ?? [];
  if (units.length === 0) return [];
  if (execution !== undefined) return units.filter((unit) => unit.execution === execution);
  // 兼容旧的单单元 manifest；多环境 manifest 没有执行环境上下文时
  // fail closed，不能把所有单元的 capability 合并成一个假 Provider。
  return units.length === 1 ? [...units] : [];
}

/**
 * 返回当前执行环境的依赖；显式运行单元不会继承产品级依赖。
 * 只有没有 units 的简单插件才读取历史 product-level dependencies。
 */
export function dependenciesOfManifest(
  manifest: PluginManifest,
  execution?: PluginExecution
): PluginDependency[] {
  const byCapability = new Map<string, PluginDependency>();
  const add = (dependency: PluginDependency) => {
    const previous = byCapability.get(dependency.capability);
    if (!previous || (previous.optional === true && dependency.optional !== true)) {
      byCapability.set(dependency.capability, { ...dependency });
    }
  };
  const units = manifest.units ?? [];
  if (units.length > 1 && execution === undefined) return [];
  const selectedUnits = selectedRuntimeUnits(manifest, execution);
  if (units.length > 0 && selectedUnits.length === 0) return [];
  if (units.length === 0) {
    for (const dependency of manifest.dependencies ?? []) add(dependency);
  } else {
    for (const unit of selectedUnits) {
      for (const dependency of unit.dependencies ?? []) add(dependency);
    }
  }
  return [...byCapability.values()];
}

/** 返回当前执行环境提供的 capability；显式单元不会继承产品级摘要。 */
export function providesOfManifest(manifest: PluginManifest, execution?: PluginExecution): string[] {
  const units = manifest.units ?? [];
  if (units.length > 1 && execution === undefined) return [];
  return unique([
    ...(units.length === 0 ? (manifest.provides ?? []) : []),
    ...selectedRuntimeUnits(manifest, execution).flatMap((unit) => unit.provides ?? []),
  ]);
}

function dependencyKey(dependency: PluginDependency | RuntimeUnitDependency): string {
  return [
    dependency.capability,
    dependency.contractVersion ?? "",
    dependency.sourceExecution ?? "",
    dependency.scope ?? "",
  ].join("\u0000");
}

interface RuntimeUnitProvider {
  pluginId: string;
  unitId: string;
  execution: PluginExecution;
  lifetime: PluginLifetime;
  contractVersion?: string;
}

/** 从完整产品描述中找显式运行单元 Provider；允许消费者跨环境依赖。 */
function runtimeUnitProviders(
  manifests: readonly PluginManifest[],
  capability: string
): RuntimeUnitProvider[] {
  const providers: RuntimeUnitProvider[] = [];
  for (const manifest of manifests) {
    for (const unit of manifest.units ?? []) {
      if (!unit.provides?.includes(capability)) continue;
      providers.push({
        pluginId: manifest.id,
        unitId: unit.id,
        execution: unit.execution,
        lifetime: unit.lifetime,
        contractVersion: unit.providedContracts?.[capability],
      });
    }
  }
  return providers;
}

function matchingRuntimeUnitProviders(
  manifests: readonly PluginManifest[],
  dependency: RuntimeUnitDependency
): RuntimeUnitProvider[] {
  return runtimeUnitProviders(manifests, dependency.capability).filter((provider) =>
    provider.execution === dependency.sourceExecution
    && provider.lifetime === dependency.scope
    && provider.contractVersion === dependency.contractVersion
  );
}

function runtimeDependenciesForValidation(
  manifest: PluginManifest,
  execution?: PluginExecution
): RuntimeUnitDependency[] {
  const units = manifest.units ?? [];
  const selected = execution === undefined
    ? units
    : units.filter((unit) => unit.execution === execution);
  return selected.flatMap((unit) => unit.dependencies ?? []);
}

/** 从 manifest 列表构造依赖、提供者和反向依赖。 */
export function buildPluginGraph(
  manifests: PluginManifest[],
  options: BuildPluginGraphOptions = {}
): PluginGraph {
  const provides: Record<string, string[]> = {};
  const dependencies: Record<string, string[]> = {};
  const optionalDependencies: Record<string, string[]> = {};
  const dependencyDetails: Record<string, PluginDependency[]> = {};
  const providers: Record<string, string[]> = {};
  const unitGraph: Record<string, PluginUnitGraph> = {};
  const enabled = options.enabledPluginIds;

  for (const manifest of manifests) {
    const selectedUnits = selectedRuntimeUnits(manifest, options.execution);
    const provided = providesOfManifest(manifest, options.execution);
    const dependencyEntries = dependenciesOfManifest(manifest, options.execution);
    dependencyDetails[manifest.id] = dependencyEntries.map((dependency) => ({ ...dependency }));
    const deps = unique(dependencyEntries.map((dependency) => dependency.capability));
    optionalDependencies[manifest.id] = unique(
      dependencyEntries
        .filter((dependency) => dependency.optional)
        .map((dependency) => dependency.capability)
    );
    provides[manifest.id] = provided;
    dependencies[manifest.id] = deps;
    for (const unit of selectedUnits) {
      const unitKey = `${manifest.id}:${unit.id}`;
      unitGraph[unitKey] = {
        pluginId: manifest.id,
        unitId: unit.id,
        execution: unit.execution,
        dependencies: unique((unit.dependencies ?? []).map((dependency) => dependency.capability)),
        dependencyDetails: (unit.dependencies ?? []).map((dependency) => ({ ...dependency })),
        provides: unique(unit.provides ?? []),
        providedContracts: unit.providedContracts ? { ...unit.providedContracts } : undefined,
      };
    }
    for (const capability of provided) {
      (providers[capability] ??= []).push(manifest.id);
    }
  }

  const providerByCapability = new Map<string, string[]>();
  for (const [capability, pluginIds] of Object.entries(providers)) {
    providerByCapability.set(capability, pluginIds);
  }

  const reverse: Record<string, PluginReverseDep[]> = {};
  for (const manifest of manifests) {
    const dependentEnabled = enabled?.has(manifest.id) ?? manifest.meta.defaultEnabled;
    for (const capability of dependencies[manifest.id] ?? []) {
      // 可选服务只影响局部功能，不应让其 Provider 停掉整个产品。
      if (optionalDependencies[manifest.id]?.includes(capability)) continue;
      for (const providerId of providerByCapability.get(capability) ?? []) {
        if (providerId === manifest.id) continue;
        const entries = (reverse[providerId] ??= []);
        let entry = entries.find((item) => item.pluginId === manifest.id);
        if (!entry) {
          entry = { pluginId: manifest.id, enabled: dependentEnabled, capabilities: [] };
          entries.push(entry);
        }
        if (!entry.capabilities.includes(capability)) entry.capabilities.push(capability);
      }
    }
  }

  const cycles: string[][] = [];
  // capability -> provider 取第一个只用于诊断路径；重复 provider 会由
  // validatePluginGraph 单独报错，不能在这里静默抢占。
  const firstProvider = new Map<string, string>();
  for (const [capability, pluginIds] of providerByCapability) {
    if (pluginIds[0]) firstProvider.set(capability, pluginIds[0]);
  }
  const visited = new Set<string>();
  const path: string[] = [];
  const visit = (pluginId: string) => {
    if (visited.has(pluginId)) return;
    const position = path.indexOf(pluginId);
    if (position >= 0) {
      const cycle = [...path.slice(position), pluginId];
      if (!cycles.some((item) => item.join("\0") === cycle.join("\0"))) cycles.push(cycle);
      return;
    }
    path.push(pluginId);
    const manifest = manifests.find((item) => item.id === pluginId);
    if (!manifest) {
      path.pop();
      visited.add(pluginId);
      return;
    }
    for (const dependency of dependenciesOfManifest(manifest, options.execution)) {
      if (dependency.optional) continue;
      const provider = firstProvider.get(dependency.capability);
      if (provider) visit(provider);
    }
    path.pop();
    visited.add(pluginId);
  };
  for (const manifest of manifests) visit(manifest.id);

  return {
    plugins: manifests.map((manifest) => manifest.id),
    dependencies,
    optionalDependencies,
    provides,
    reverse,
    providers,
    dependencyDetails,
    cycles,
    units: unitGraph,
  };
}

/** 在任何 setup 前校验重复提供、缺失硬依赖和硬依赖环。 */
export function validatePluginGraph(
  manifests: readonly PluginManifest[],
  options: ValidatePluginGraphOptions = {}
): PluginGraph {
  const diagnostics: PluginGraphDiagnostic[] = [];
  diagnostics.push(...validateRuntimeUnitDependencyContracts(manifests));
  const ids = new Set<string>();
  for (const manifest of manifests) {
    if (ids.has(manifest.id)) {
      diagnostics.push({
        code: "plugin.duplicate_id",
        ids: [manifest.id],
        message: `插件标识 "${manifest.id}" 重复，无法确定唯一运行实例`,
      });
    }
    ids.add(manifest.id);
  }

  const graph = buildPluginGraph([...manifests], options);
  const builtins = options.builtinCapabilities ?? new Set<string>();
  const multiProvider = options.multiProviderCapabilities ?? new Set<string>();
  for (const [capability, pluginIds] of Object.entries(graph.providers ?? {})) {
    if (pluginIds.length > 1 && !multiProvider.has(capability)) {
      diagnostics.push({
        code: "capability.duplicate_provider",
        ids: [capability, ...pluginIds],
        message: `能力 "${capability}" 有多个提供者（${pluginIds.join(", ")}），但未声明专用 Provider Registry`,
      });
    }
  }
  // 运行单元依赖不能沿用产品级“同名 capability 即可”的兼容规则。
  // Provider 必须同时声明 execution、lifetime 和 providedContracts 版本；
  // sourceExecution 可以指向当前图之外的 Worker，因此这里故意在完整
  // manifest 集合上查找，而不是只看当前 Window Host 的 providers。
  for (const manifest of manifests) {
    const strictDependencies = runtimeDependenciesForValidation(manifest, options.execution);
    for (const dependency of strictDependencies) {
      if (dependency.optional) continue;
      const matches = matchingRuntimeUnitProviders(manifests, dependency);
      if (matches.length > 0) {
        if (matches.length > 1 && !multiProvider.has(dependency.capability)) {
          diagnostics.push({
            code: "capability.duplicate_provider",
            ids: [dependency.capability, ...matches.map((provider) => `${provider.pluginId}:${provider.unitId}`)],
            message: `能力 "${dependency.capability}" 的运行单元契约有多个匹配 Provider（${matches.map((provider) => `${provider.pluginId}:${provider.unitId}`).join(", ")}），但未声明专用 Provider Registry`,
          });
        }
        continue;
      }
      const candidates = runtimeUnitProviders(manifests, dependency.capability);
      // Host 注入的 builtin capability 没有 manifest Provider，但已经在
      // 当前装配环境内完成契约注册；它不应被误判成缺少远程 Provider。
      if (builtins.has(dependency.capability) && candidates.length === 0) {
        continue;
      }
      if (candidates.length > 0) {
        diagnostics.push({
          code: "plugin.dependency_contract_unavailable",
          ids: [manifest.id, dependency.capability],
          message: `插件 "${manifest.id}" 的运行单元依赖 "${dependency.capability}" 没有匹配的契约版本、来源环境或作用域`,
        });
      } else if (!options.allowMissingDependencies) {
        diagnostics.push({
          code: "plugin.missing_dependency",
          ids: [manifest.id, dependency.capability],
          message: `插件 "${manifest.id}" 缺少硬依赖能力 "${dependency.capability}"`,
        });
      }
    }
  }
  for (const manifest of manifests) {
    const strictDependencyCapabilities = new Set(
      runtimeDependenciesForValidation(manifest, options.execution).map((dependency) => dependency.capability)
    );
    for (const dependency of dependenciesOfManifest(manifest, options.execution)) {
      if (dependency.optional) continue;
      // 上面的严格运行单元校验已经处理了精确契约；这里仅保留没有
      // units 的简单插件 product-level dependencies 兼容逻辑。
      if (strictDependencyCapabilities.has(dependency.capability)) continue;
      const provided = (graph.providers?.[dependency.capability]?.length ?? 0) > 0
        || builtins.has(dependency.capability);
      if (!provided && !options.allowMissingDependencies) {
        diagnostics.push({
          code: "plugin.missing_dependency",
          ids: [manifest.id, dependency.capability],
          message: `插件 "${manifest.id}" 缺少硬依赖能力 "${dependency.capability}"`,
        });
      }
    }
  }
  for (const cycle of graph.cycles ?? []) {
    diagnostics.push({
      code: "plugin.dependency_cycle",
      ids: cycle,
      message: `插件存在硬依赖环：${cycle.join(" -> ")}`,
    });
  }
  if (diagnostics.length > 0) throw new PluginGraphValidationError(diagnostics);
  return graph;
}

/** 查询当前启用的逆依赖者；禁用提供者时应按此集合先停止消费者。 */
export function reverseDependentsOf(
  graph: PluginGraph,
  pluginId: string,
  enabledSet: ReadonlySet<string>
): PluginReverseDep[] {
  return (graph.reverse[pluginId] ?? []).filter((dependent) => enabledSet.has(dependent.pluginId));
}
