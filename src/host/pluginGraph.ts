// WebLoom v4 静态插件/能力依赖图。
//
// 图只处理 descriptor，不保存 parser、transfer extractor 或 setup。真正的
// capability 对象留在当前 realm，由 Host 在启动时用同一份定义表绑定实现。

import {
  capabilityKey,
  isCapabilityDescriptor,
  type CapabilityDescriptor,
} from "../contracts/capability.js";
import type {
  PluginGraph,
  PluginManifest,
  PluginReverseDep,
  PluginUnitGraph,
  RuntimeUnitDependency,
  RuntimeUnitDescriptor,
} from "../contracts/plugin.js";
import type { RuntimeKind } from "../contracts/lifecycle.js";

export interface PluginGraphOptions {
  /** 当前 Host 的 Runtime；未指定时只用于静态检查。 */
  readonly runtime?: RuntimeKind;
  /** 当前已经启用的插件，用于生成反向依赖状态。 */
  readonly enabledPluginIds?: ReadonlySet<string>;
  /** Host-owned 或远端已发布的 descriptor。 */
  readonly builtinCapabilities?: ReadonlySet<CapabilityDescriptor | string>;
  /** 是否允许尚未出现在本图中的跨 Runtime provider。 */
  readonly externalRuntimeDependencies?: boolean;
  /** registerAll 的调用阶段是否允许缺依赖。 */
  readonly allowMissingDependencies?: boolean;
}

function unitCandidates(manifest: PluginManifest, runtime?: RuntimeKind): RuntimeUnitDescriptor[] {
  const units = [...(manifest.units ?? [])];
  if (units.length === 0) {
    return [{ id: manifest.id, ...(runtime !== undefined ? { runtime } : {}) }];
  }
  if (runtime === undefined) return units;
  return units.filter((unit) => unit.runtime === undefined || unit.runtime === runtime);
}

/** 选择一个插件在当前 Runtime 中的实现单元；多匹配必须显式消歧。 */
export function selectRuntimeUnit(
  manifest: PluginManifest,
  runtime: RuntimeKind | undefined,
): (RuntimeUnitDescriptor & { id: string; runtime: RuntimeKind }) | undefined {
  const units = unitCandidates(manifest, runtime);
  if (units.length !== 1) return undefined;
  const unit = units[0];
  if (!unit) return undefined;
  // A host created by the advanced assembly layer may not know its Runtime
  // until it sees the one explicit unit.  The only implicit choice permitted
  // here is the ordinary single-runtime Window default; multi-unit manifests
  // are rejected by the Host before mutation.  This keeps an explicit
  // single Worker unit selectable when `runtime` is omitted.
  const selectedRuntime = unit.runtime ?? runtime ?? "window-main";
  if (selectedRuntime === undefined) return undefined;
  return { ...unit, runtime: selectedRuntime };
}

export function dependenciesOfManifest(
  manifest: PluginManifest,
  runtime?: RuntimeKind,
): readonly RuntimeUnitDependency[] {
  const unit = selectRuntimeUnit(manifest, runtime);
  // A peer dependency is resolved against the call-bound PeerView. It must
  // never turn into a global Host startup edge/provider candidate.
  return (unit?.dependencies ?? []).filter((dependency) => dependency.source !== "peer");
}

export function providesOfManifest(
  manifest: PluginManifest,
  runtime?: RuntimeKind,
): readonly CapabilityDescriptor[] {
  const unit = selectRuntimeUnit(manifest, runtime);
  return unit?.provides ?? [];
}

function descriptorKey(value: CapabilityDescriptor): string {
  return capabilityKey(value);
}

function keysForBuiltin(value: ReadonlySet<CapabilityDescriptor | string> | undefined): Set<string> {
  const result = new Set<string>();
  for (const item of value ?? []) result.add(typeof item === "string" ? item : descriptorKey(item));
  return result;
}

function freezeRecord<T>(record: Record<string, T>): Readonly<Record<string, T>> {
  for (const value of Object.values(record)) if (Array.isArray(value)) Object.freeze(value);
  return Object.freeze(record);
}

function capabilityLabel(capability: CapabilityDescriptor): string {
  return `${capability.kind}:${capability.id}@${capability.version}`;
}

function collectUnits(manifests: readonly PluginManifest[], runtime?: RuntimeKind): Map<string, PluginUnitGraph> {
  const result = new Map<string, PluginUnitGraph>();
  for (const manifest of manifests) {
    for (const unit of unitCandidates(manifest, runtime)) {
      const selectedRuntime = unit.runtime ?? runtime;
      if (!selectedRuntime) continue;
      result.set(`${manifest.id}\u0000${unit.id}`, {
        pluginId: manifest.id,
        unitId: unit.id,
        runtime: selectedRuntime,
        dependencies: Object.freeze([...(unit.dependencies ?? [])].filter((item) => item.source !== "peer").map((item) => item.capability)),
        provides: Object.freeze([...(unit.provides ?? [])]),
      });
    }
  }
  return result;
}

/** 构建不可变图快照；结果顺序始终由 manifest 输入顺序和 descriptor 顺序决定。 */
export function buildPluginGraph(
  manifests: readonly PluginManifest[],
  options: PluginGraphOptions = {},
): PluginGraph {
  const dependencies: Record<string, readonly CapabilityDescriptor[]> = {};
  const optionalDependencies: Record<string, readonly CapabilityDescriptor[]> = {};
  const provides: Record<string, readonly CapabilityDescriptor[]> = {};
  const providers: Record<string, string[]> = {};
  const reverse: Record<string, PluginReverseDep[]> = {};
  const unitMap = collectUnits(manifests, options.runtime);
  const enabled = options.enabledPluginIds ?? new Set<string>();

  for (const manifest of manifests) {
    const deps = [...dependenciesOfManifest(manifest, options.runtime)];
    dependencies[manifest.id] = Object.freeze(deps.filter((item) => !item.optional).map((item) => item.capability));
    optionalDependencies[manifest.id] = Object.freeze(deps.filter((item) => item.optional).map((item) => item.capability));
    const offered = [...providesOfManifest(manifest, options.runtime)];
    provides[manifest.id] = Object.freeze(offered);
    for (const capability of offered) (providers[descriptorKey(capability)] ??= []).push(manifest.id);
  }

  for (const manifest of manifests) {
    const deps = [...(dependenciesOfManifest(manifest, options.runtime) ?? [])];
    for (const dependency of deps) {
      // Optional capabilities do not establish a lifecycle edge.  The
      // consumer remains usable when the provider is intentionally stopped.
      if (dependency.optional) continue;
      for (const providerId of providers[descriptorKey(dependency.capability)] ?? []) {
        (reverse[providerId] ??= []).push({
          pluginId: manifest.id,
          enabled: enabled.has(manifest.id),
          capabilities: Object.freeze([dependency.capability]),
        });
      }
    }
  }

  const cycles: (readonly string[])[] = [];
  const byId = new Map(manifests.map((manifest) => [manifest.id, manifest]));
  const visiting: string[] = [];
  const visited = new Set<string>();
  const visit = (pluginId: string): void => {
    const start = visiting.indexOf(pluginId);
    if (start >= 0) {
      cycles.push(Object.freeze([...visiting.slice(start), pluginId]));
      return;
    }
    if (visited.has(pluginId)) return;
    const manifest = byId.get(pluginId);
    if (!manifest) return;
    visiting.push(pluginId);
    for (const dependency of dependenciesOfManifest(manifest, options.runtime)) {
      if (dependency.optional) continue;
      for (const providerId of providers[descriptorKey(dependency.capability)] ?? []) visit(providerId);
    }
    visiting.pop();
    visited.add(pluginId);
  };
  for (const manifest of manifests) visit(manifest.id);

  const reverseFrozen: Record<string, readonly PluginReverseDep[]> = {};
  for (const [pluginId, values] of Object.entries(reverse)) reverseFrozen[pluginId] = Object.freeze(values);
  const providerFrozen: Record<string, readonly string[]> = {};
  for (const [key, values] of Object.entries(providers)) providerFrozen[key] = Object.freeze(values);
  const units: Record<string, PluginUnitGraph> = {};
  for (const [key, value] of unitMap) units[key] = value;

  return Object.freeze({
    plugins: Object.freeze(manifests.map((manifest) => manifest.id)),
    dependencies: freezeRecord(dependencies),
    optionalDependencies: freezeRecord(optionalDependencies),
    provides: freezeRecord(provides),
    reverse: freezeRecord(reverseFrozen),
    providers: freezeRecord(providerFrozen),
    cycles: Object.freeze(cycles),
    units: Object.freeze(units),
  });
}

/** 在注册/批量装配前验证 manifest 及其依赖闭包。 */
export function validatePluginGraph(
  manifests: readonly PluginManifest[],
  options: PluginGraphOptions = {},
): void {
  const ids = new Set<string>();
  const providerRuntime = new Map<string, RuntimeKind | undefined>();
  for (const manifest of manifests) {
    if (!manifest || typeof manifest.id !== "string" || manifest.id.trim() === "") throw new TypeError("Plugin id must be a non-empty string");
    if (ids.has(manifest.id)) throw new Error(`Plugin "${manifest.id}" is duplicated`);
    ids.add(manifest.id);
    if (typeof manifest.name !== "string" || manifest.name.trim() === "") throw new TypeError(`Plugin "${manifest.id}" name must be a non-empty string`);
    if (manifest.startup !== "required" && manifest.startup !== "optional") throw new TypeError(`Plugin "${manifest.id}" startup must be required or optional`);
    if (typeof manifest.defaultEnabled !== "boolean" || typeof manifest.canDisable !== "boolean") throw new TypeError(`Plugin "${manifest.id}" startup policy is incomplete`);
    if (manifest.startup === "required" && (!manifest.defaultEnabled || manifest.canDisable)) throw new TypeError(`Plugin "${manifest.id}" required startup policy is inconsistent`);
    const unitIds = new Set<string>();
    for (const unit of manifest.units ?? []) {
      if (!unit || typeof unit.id !== "string" || unit.id.trim() === "" || unitIds.has(unit.id)) throw new TypeError(`Plugin "${manifest.id}" has a duplicate or empty unit id`);
      unitIds.add(unit.id);
      if (unit.runtime !== undefined && unit.runtime !== "window-main" && unit.runtime !== "shared-worker") throw new TypeError(`Plugin "${manifest.id}" unit "${unit.id}" has an invalid Runtime`);
      const seenProvides = new Set<string>();
      for (const capability of unit.provides ?? []) {
        if (!isCapabilityDescriptor(capability)) throw new TypeError(`Plugin "${manifest.id}" has an invalid capability descriptor`);
        const key = descriptorKey(capability);
        if (seenProvides.has(key)) throw new Error(`Plugin "${manifest.id}" provides ${capabilityLabel(capability)} more than once`);
        seenProvides.add(key);
        const previousRuntime = providerRuntime.get(key);
        if (providerRuntime.has(key) && previousRuntime === unit.runtime) throw new Error(`Capability ${capabilityLabel(capability)} has ambiguous providers`);
        if (!providerRuntime.has(key)) providerRuntime.set(key, unit.runtime);
      }
      for (const dependency of unit.dependencies ?? []) {
        if (!dependency || !isCapabilityDescriptor(dependency.capability)) throw new TypeError(`Plugin "${manifest.id}" has an invalid dependency descriptor`);
        if (dependency.source !== undefined && dependency.source !== "peer") throw new TypeError(`Plugin "${manifest.id}" has an invalid dependency source`);
        if (dependency.source === "peer" && dependency.sourceRuntime !== undefined) throw new TypeError(`Plugin "${manifest.id}" peer dependency cannot declare sourceRuntime`);
        if (dependency.source !== "peer" && dependency.sourceRuntime !== "window-main" && dependency.sourceRuntime !== "shared-worker") throw new TypeError(`Plugin "${manifest.id}" has an invalid dependency Runtime`);
        if (dependency.source === "peer" && dependency.capability.kind === "local") {
          // Local capabilities can only be represented by an explicit remote
          // contract on the wire; a peer dependency itself must be remote.
          throw new TypeError(`Plugin "${manifest.id}" cannot depend on local capability "${dependency.capability.id}" through a peer`);
        }
        if (dependency.source !== "peer" && dependency.capability.kind === "local" && dependency.sourceRuntime !== (unit.runtime ?? options.runtime)) {
          throw new TypeError(`Plugin "${manifest.id}" cannot depend on local capability "${dependency.capability.id}" from another Runtime`);
        }
      }
    }
  }
  const graph = buildPluginGraph(manifests, options);
  if (graph.cycles.length > 0) throw new Error(`Plugin dependency cycle: ${graph.cycles[0]?.join(" -> ") ?? "unknown"}`);
  const builtin = keysForBuiltin(options.builtinCapabilities);
  for (const manifest of manifests) {
    for (const dependency of dependenciesOfManifest(manifest, options.runtime)) {
      const key = descriptorKey(dependency.capability);
      const providerCount = graph.providers[key]?.length ?? 0;
      const external = options.externalRuntimeDependencies === true && dependency.sourceRuntime !== options.runtime;
      if (providerCount === 0 && !builtin.has(key) && !external && !dependency.optional && options.allowMissingDependencies !== true) throw new Error(`Plugin "${manifest.id}" requires missing capability ${capabilityLabel(dependency.capability)}`);
      if (providerCount > 1 && !external) throw new Error(`Capability ${capabilityLabel(dependency.capability)} has ambiguous providers`);
    }
  }
}

/** 查询依赖某 provider 的已启用插件。 */
export function reverseDependentsOf(
  graph: PluginGraph,
  pluginId: string,
  enabledPluginIds?: ReadonlySet<string>,
): readonly PluginReverseDep[] {
  return (graph.reverse[pluginId] ?? []).filter((item) => enabledPluginIds === undefined || enabledPluginIds.has(item.pluginId));
}
