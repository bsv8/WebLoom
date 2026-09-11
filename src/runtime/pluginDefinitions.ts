// Runtime 装配：把作者的 typed definition 绑定到一个真实 Runtime。
// 静态 manifest 只含 descriptor；setup 仍然只存在于当前 realm。

import type { PluginDefinition } from "../contracts/plugin.js";
import type {
  PluginManifest,
  PluginSetup,
  RuntimeUnitDescriptor,
  RuntimeUnitDependency,
} from "../contracts/plugin.js";
import type { Capability } from "../contracts/capability.js";
import type { RuntimeKind } from "../contracts/lifecycle.js";

/** 可传给 Runtime 的 v4 插件定义；没有旧 manifest 字段或兼容签名。 */
export type RuntimePluginDefinition = {
  /** 静态 manifest。 */
  readonly manifest: PluginManifest;
  /** 当前 realm 的 setup 实现。 */
  readonly setup: PluginSetup;
  /** 当前 realm 的 typed capability 定义表。 */
  readonly capabilities?: readonly Capability[];
  /** 多 unit 定义中的实现目标。 */
  readonly unitId?: string;
};

export interface MaterializedPluginDefinition {
  /** 当前 Runtime 可见的静态 manifest。 */
  readonly manifest: PluginManifest;
  /** setup 对应的单元。 */
  readonly unitId: string;
  /** 当前 realm 的 setup。 */
  readonly setup: PluginSetup;
  /** 当前 realm 的 capability 定义表。 */
  readonly capabilities: readonly Capability[];
}

function cloneDependencies(
  dependencies: readonly RuntimeUnitDependency[] | undefined,
  runtime: RuntimeKind,
): readonly RuntimeUnitDependency[] | undefined {
  if (!dependencies) return undefined;
  return Object.freeze(dependencies.map((dependency) => {
    const base = {
      capability: Object.freeze({ ...dependency.capability }),
      ...(dependency.optional !== undefined ? { optional: dependency.optional } : {}),
      ...(dependency.reason !== undefined ? { reason: dependency.reason } : {}),
    };
    return Object.freeze(dependency.source === "peer"
      ? { ...base, source: "peer" as const }
      : { ...base, sourceRuntime: dependency.sourceRuntime ?? runtime });
  }));
}

function selectUnit(
  input: RuntimePluginDefinition,
  runtime: RuntimeKind,
): RuntimeUnitDescriptor & { id: string; runtime: RuntimeKind } {
  const candidates = [...(input.manifest.units ?? [])];
  if (candidates.length === 0) return { id: input.manifest.id, runtime };
  const requested = input.unitId;
  if (requested !== undefined) {
    const unit = candidates.find((candidate) => candidate.id === requested);
    if (!unit) throw new Error(`Plugin "${input.manifest.id}" does not declare unit "${requested}"`);
    if (unit.runtime !== undefined && unit.runtime !== runtime) throw new Error(`Plugin "${input.manifest.id}" unit "${requested}" targets ${unit.runtime}, not ${runtime}`);
    return { ...unit, runtime };
  }
  const matches = candidates.filter((unit) => unit.runtime === undefined || unit.runtime === runtime);
  if (matches.length !== 1 || !matches[0]) throw new Error(`Plugin "${input.manifest.id}" has ${matches.length} implementation units for ${runtime}; specify unitId explicitly`);
  return { ...matches[0], runtime };
}

/** 将一个 definition 装配为单 Runtime 的唯一实现单元。 */
export function materializePluginDefinition(input: RuntimePluginDefinition, runtime: RuntimeKind): MaterializedPluginDefinition {
  if (!input || !input.manifest || typeof input.manifest.id !== "string" || input.manifest.id.trim() === "") throw new TypeError("Plugin manifest id must be a non-empty string");
  if (typeof input.setup !== "function") throw new TypeError(`Plugin "${input.manifest.id}" setup must be a function`);
  const unit = selectUnit(input, runtime);
  const materializedUnit: RuntimeUnitDescriptor = Object.freeze({
    ...unit,
    runtime,
    ...(cloneDependencies(unit.dependencies, runtime) ? { dependencies: cloneDependencies(unit.dependencies, runtime) } : {}),
    ...(unit.provides ? { provides: Object.freeze(unit.provides.map((item) => Object.freeze({ ...item }))) } : {}),
    ...(unit.permissions ? { permissions: Object.freeze([...unit.permissions]) } : {}),
  });
  const manifest: PluginManifest = Object.freeze({
    id: input.manifest.id,
    name: input.manifest.name,
    ...(input.manifest.description !== undefined ? { description: input.manifest.description } : {}),
    startup: input.manifest.startup,
    defaultEnabled: input.manifest.defaultEnabled,
    canDisable: input.manifest.canDisable,
    units: Object.freeze([materializedUnit]),
  });
  const capabilities = Object.freeze([...(input.capabilities ?? [])]);
  return { manifest, unitId: unit.id, setup: input.setup, capabilities };
}

export function materializePluginDefinitions(inputs: readonly RuntimePluginDefinition[], runtime: RuntimeKind): MaterializedPluginDefinition[] {
  return inputs.map((input) => materializePluginDefinition(input, runtime));
}
