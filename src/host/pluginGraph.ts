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
  /** 当前正在运行的插件，用于反向依赖的“运行中”诊断；不是用户启停意图。 */
  readonly runningPluginIds?: ReadonlySet<string>;
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
  /**
   * 排序用的反向边：包含**已绑定**的可选依赖。
   *
   * `reverse` 只表达必需依赖，因此用于“必须随之失效/撤销”的级联；销毁顺序是另一件事：
   * 即使消费者对某个可选提供者只是降级，它的清理也应该在提供者释放之前完成，否则可能
   * 读到已释放的服务。两者因此分开维护。
   */
  const orderingReverse: Record<string, PluginReverseDep[]> = {};
  const unitMap = collectUnits(manifests, options.runtime);
  const running = options.runningPluginIds ?? new Set<string>();

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
      for (const providerId of providers[descriptorKey(dependency.capability)] ?? []) {
        // 可选依赖不建立生命周期边（消费者只降级，不被连带撤销），但仍然建立顺序边。
        if (!dependency.optional) {
          (reverse[providerId] ??= []).push({
            pluginId: manifest.id,
            running: running.has(manifest.id),
            capabilities: Object.freeze([dependency.capability]),
          });
        }
        (orderingReverse[providerId] ??= []).push({
          pluginId: manifest.id,
          running: running.has(manifest.id),
          optional: dependency.optional === true,
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
  const orderingFrozen: Record<string, readonly PluginReverseDep[]> = {};
  for (const [pluginId, values] of Object.entries(orderingReverse)) orderingFrozen[pluginId] = Object.freeze(values);
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
    orderingReverse: freezeRecord(orderingFrozen),
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

/**
 * 查询依赖某 provider 的插件；传入运行集合时只返回当前在运行的依赖者。
 *
 * 这里没有任何“用户启用”语义：反向依赖是依赖图事实，运行集合只是生命周期快照。
 */
export function reverseDependentsOf(
  graph: PluginGraph,
  pluginId: string,
  runningPluginIds?: ReadonlySet<string>,
): readonly PluginReverseDep[] {
  return (graph.reverse[pluginId] ?? []).filter((item) => runningPluginIds === undefined || runningPluginIds.has(item.pluginId));
}

/**
 * 按声明依赖计算插件的启动层级。
 *
 * 层级 = 1 + 所有“已确定提供者”的依赖提供者的最大层级。必需依赖与**已绑定的可选依赖**
 * 都参与排序：可选依赖的提供者已经出现在装配清单里时，消费者应当等它就绪，而不是先启动
 * 再读到缺席状态。没有提供者的可选依赖不产生边，因此不形成等待。
 *
 * 同一层级内保持装配清单顺序，互不依赖的分支因此可以并行启动。返回结果用于“先提供
 * 者、后消费者”的排序，不依赖 priority 或插件分类。
 */
export function startupLayers(graph: PluginGraph): readonly (readonly string[])[] {
  const layers = new Map<string, number>();
  const byId = new Set(graph.plugins);
  const resolve = (pluginId: string, path: Set<string>): number => {
    const cached = layers.get(pluginId);
    if (cached !== undefined) return cached;
    // 环在 validatePluginGraph 阶段已经被拒绝；这里仍然收敛，避免递归溢出。
    if (path.has(pluginId)) return 0;
    path.add(pluginId);
    let depth = 0;
    const ordered = [
      ...(graph.dependencies[pluginId] ?? []),
      ...(graph.optionalDependencies[pluginId] ?? []),
    ];
    for (const dependency of ordered) {
      for (const providerId of graph.providers[capabilityKey(dependency)] ?? []) {
        if (!byId.has(providerId) || providerId === pluginId) continue;
        depth = Math.max(depth, resolve(providerId, path) + 1);
      }
    }
    path.delete(pluginId);
    layers.set(pluginId, depth);
    return depth;
  };
  for (const pluginId of graph.plugins) resolve(pluginId, new Set());
  const grouped = new Map<number, string[]>();
  for (const pluginId of graph.plugins) {
    const depth = layers.get(pluginId) ?? 0;
    const bucket = grouped.get(depth);
    if (bucket) bucket.push(pluginId);
    else grouped.set(depth, [pluginId]);
  }
  return Object.freeze([...grouped.keys()].sort((a, b) => a - b).map((depth) => Object.freeze(grouped.get(depth) ?? [])));
}

/**
 * 计算销毁层级：消费者先于提供者释放。
 *
 * 层级 = 该插件之下最长消费者链的长度；叶子消费者为 0，提供者依次更深。按层级升序执行
 * 即可满足“消费者清理完成后才释放提供者”，同一层内的插件互不依赖，可以并行清理。
 */
export function teardownLayers(graph: PluginGraph, pluginIds: readonly string[]): readonly (readonly string[])[] {
  const targets = new Set(pluginIds);
  const depth = new Map<string, number>();
  const resolve = (pluginId: string, path: Set<string>): number => {
    const cached = depth.get(pluginId);
    if (cached !== undefined) return cached;
    if (path.has(pluginId)) return 0;
    path.add(pluginId);
    let value = 0;
    // 用排序边（含已绑定可选依赖）：消费者必须先于它的可选提供者完成清理。
    for (const dependent of graph.orderingReverse[pluginId] ?? []) {
      if (!targets.has(dependent.pluginId)) continue;
      value = Math.max(value, resolve(dependent.pluginId, path) + 1);
    }
    path.delete(pluginId);
    depth.set(pluginId, value);
    return value;
  };
  for (const pluginId of targets) resolve(pluginId, new Set());
  const grouped = new Map<number, string[]>();
  for (const pluginId of pluginIds) {
    const level = depth.get(pluginId) ?? 0;
    const bucket = grouped.get(level);
    if (bucket) bucket.push(pluginId);
    else grouped.set(level, [pluginId]);
  }
  return Object.freeze([...grouped.keys()].sort((a, b) => a - b).map((level) => Object.freeze(grouped.get(level) ?? [])));
}
