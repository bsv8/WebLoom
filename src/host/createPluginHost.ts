// WebLoom 通用 Plugin Host。
//
// Host 只负责产品、运行单元、实例、依赖、Scope 和权限租约。路由、存储、
// 日志、国际化以及其它产品能力通过 options 注入，不在这里创建领域 Registry。

import type {
  PluginState,
  PluginStateKind,
  PluginManifest,
  PluginContext,
  PluginDependency,
  PluginGraph,
  PluginReverseDep,
  PluginSetup,
  PluginTeardown,
  RuntimeUnitDescriptor,
  RuntimeUnitImplementationRegistry,
  HostListener,
  StartupCapabilityErrorDetails,
  StartupPluginErrorDetails,
} from "../contracts/plugin.js";
import type {
  LifecycleDisposeResult,
  LifecycleScope,
  LifecycleScopeIdentity,
  LifecycleCleanup,
  PermissionLease,
  PermissionLeaseBinding,
  PluginIntentCoordinator,
  PluginIntentSubmissionResult,
  PluginPermission,
  RemoteServiceReference,
  RuntimeKind,
  ScopedTaskScheduler,
} from "../contracts/lifecycle.js";
import {
  LifecycleScopeRevokedError,
  SCOPED_TASK_SCHEDULER_CAPABILITY,
} from "../contracts/lifecycle.js";
import type { MessageBus } from "../contracts/messageBus.js";
import { RUNTIME_MESSAGE_BUS } from "../contracts/messageBus.js";
import type { ResourceRegistry } from "../contracts/resource.js";
import { RESOURCE_REGISTRY_CAPABILITY } from "../contracts/resource.js";

import { createCapabilityRegistry, type CapabilityRegistry } from "./capabilityRegistry.js";
import {
  buildPluginGraph,
  dependenciesOfManifest,
  providesOfManifest,
  reverseDependentsOf,
  validatePluginGraph,
} from "./pluginGraph.js";
import { createRuntimeUnitImplementationRegistry } from "./runtimeUnitImplementationRegistry.js";
import { createMessageBus } from "../messaging/messageBus.js";
import { createLifecycleScope } from "../lifecycle/resourceScope.js";
import { createScopedMessageBus } from "../lifecycle/scopedMessageBus.js";
import { createPermissionLease } from "../lifecycle/permissionLease.js";
import { createScopedTaskScheduler } from "../lifecycle/taskScheduler.js";
import { createResourceRegistry, registerOwnedResource } from "../resources/resourceRegistry.js";
import { createResourceStore, type ResourceStoreApi } from "../resources/resourceStore.js";

/** 插件启停意图的通用持久化端口。 */
export interface PluginConfigStore {
  /** 读取产品级绝对启停意图。 */
  read(): Readonly<Record<string, boolean>>;
  /** 写入一个产品的绝对启停意图。 */
  setEnabled(pluginId: string, enabled: boolean): void;
  /** 订阅外部控制面带来的变化。 */
  subscribe(listener: (snapshot: Readonly<Record<string, boolean>>) => void): () => void;
}

/** 创建内存配置端口；产品可通过 configStore 注入持久化实现。 */
export function createInMemoryPluginConfigStore(
  initial: Readonly<Record<string, boolean>> = {},
  readOnly = false,
): PluginConfigStore {
  const values = new Map<string, boolean>();
  for (const [id, value] of Object.entries(initial)) {
    if (typeof value === "boolean") values.set(id, value);
  }
  const listeners = new Set<(snapshot: Readonly<Record<string, boolean>>) => void>();
  const snapshot = (): Readonly<Record<string, boolean>> => Object.freeze(Object.fromEntries(values));
  return {
    read: snapshot,
    setEnabled(pluginId, enabled) {
      if (readOnly) return;
      if (values.get(pluginId) === enabled) return;
      values.set(pluginId, enabled);
      const next = snapshot();
      for (const listener of [...listeners]) listener(next);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** 权限策略输入；申请、批准和会话约束必须分开计算。 */
export interface PermissionPolicyInput {
  /** 产品标识。 */
  pluginId: string;
  /** 运行单元标识。 */
  unitId: string;
  /** 当前 Scope 身份。 */
  identity: LifecycleScopeIdentity;
  /** 清单申请的权限。 */
  requested: readonly PluginPermission[];
}

/** 权限策略结果；Host 只发放三者交集。 */
export interface PermissionPolicyResult {
  /** 可信装配批准集合；缺省为申请集合。 */
  approved?: readonly PluginPermission[];
  /** 当前会话的额外限制。 */
  sessionConstraints?: readonly PluginPermission[];
  /** 绑定到租约的策略/授权修订。 */
  binding?: Partial<Pick<PermissionLeaseBinding, "policyRevision" | "grantRevision" | "grantId">>;
}

/** Context Extension 生成输入。 */
export interface ContextExtensionInput {
  /** 产品标识。 */
  pluginId: string;
  /** 运行单元标识。 */
  unitId: string;
  /** 本次实例标识。 */
  instanceId: string;
  /** 实例 Scope。 */
  scope: LifecycleScope;
  /** 静态清单。 */
  manifest: PluginManifest;
}

/** 贡献注册的运行时输入。 */
export interface ContributionAdapterInput {
  /** 产品标识。 */
  pluginId: string;
  /** 运行单元标识。 */
  unitId: string;
  /** 实例标识。 */
  instanceId: string;
  /** 实例 Scope。 */
  scope: LifecycleScope;
  /** 泛型产品贡献。 */
  contribution: unknown;
  /** 完整静态清单。 */
  manifest: PluginManifest;
}

/** 贡献适配器返回的同步撤权/异步清理句柄。 */
export interface ContributionHandle {
  /** 同步撤下 UI、命令或其它入口；不能等待网络。 */
  revoke?(): void;
  /** 异步完成底层清理；失败必须可观察。 */
  dispose?(): void | Promise<void>;
}

/** 宿主贡献适配器；具体产品可以注册多个不同领域的适配器。 */
export interface ContributionAdapter {
  /** 适配器名称，仅用于诊断。 */
  name?: string;
  /** 注册一份泛型贡献。 */
  register(input: ContributionAdapterInput):
    | void
    | ContributionHandle
    | (() => void | Promise<void>)
    | Promise<void | ContributionHandle | (() => void | Promise<void>)>;
}

/** 运行单元可用性检查；返回稳定原因表示当前实例不能装配。 */
export interface RuntimeUnitAvailabilityInput {
  /** 产品标识。 */
  pluginId: string;
  /** 运行单元标识。 */
  unitId: string;
  /** 真实 Runtime。 */
  runtime: RuntimeKind;
}

/** 新运行单元 Scope 的身份属性输入。 */
export interface RuntimeUnitAttributesInput extends RuntimeUnitAvailabilityInput {
  /** 静态产品清单。 */
  manifest: PluginManifest;
}

/** 为运行单元选择父 Scope；未提供时运行单元直接挂在 Host 根 Scope。 */
export type RuntimeUnitParentScopeInput = RuntimeUnitAttributesInput;

/** 通用运行单元快照；用于展示远端单元未知/恢复状态。 */
export interface RuntimeUnitSnapshot {
  /** 产品标识。 */
  pluginId: string;
  /** 单元标识。 */
  unitId: string;
  /** 真实 Runtime。 */
  runtime: RuntimeKind;
  /** 远端实例标识。 */
  instanceId?: string;
  /** 远端当前状态。 */
  state: PluginStateKind;
}

export interface CreatePluginHostOptions {
  /** 当前 Host 所在真实 Runtime。 */
  runtime?: RuntimeKind;
  /** 根 Scope 的宿主只读属性。 */
  rootAttributes?: Readonly<Record<string, unknown>>;
  /** 预注入的内建 capability；不归属于任何插件实例。 */
  capabilities?: Readonly<Record<string, unknown>> | ReadonlyMap<string, unknown>;
  /** 可选的资源定义注册表；适配器可把领域 facade 绑定到同一个 Store。 */
  resourceRegistry?: ResourceRegistry;
  /** 可选的消息总线；适配器可为 legacy capability 保持同一实例。 */
  messageBus?: MessageBus;
  /** builtin capability 的别名，便于适配器明确表达用途。 */
  builtinCapabilities?: Readonly<Record<string, unknown>> | ReadonlyMap<string, unknown>;
  /** 生成领域 Context Extension；结果会浅冻结。 */
  contextExtension?: (input: ContextExtensionInput) => Readonly<Record<string, unknown>>;
  /** 校验产品清单中的宿主扩展字段。 */
  manifestValidator?: (manifest: PluginManifest) => void;
  /** 计算权限批准与会话交集。 */
  permissionPolicy?: (input: PermissionPolicyInput) => PermissionPolicyResult;
  /** 启停意图持久化端口。 */
  configStore?: PluginConfigStore;
  /** 兼容测试的内存启停意图。 */
  initialPluginConfig?: Readonly<Record<string, boolean>>;
  /** 多页面唯一启停控制面。 */
  pluginIntentCoordinator?: PluginIntentCoordinator;
  /** 为实例绑定远程服务桥。 */
  serviceBridgeForPlugin?: (pluginId: string, instanceId: string) => import("../contracts/lifecycle.js").RemoteServiceBridge | undefined;
  /** 当前执行环境的运行单元实现注册表。 */
  runtimeUnitImplementationRegistry?: RuntimeUnitImplementationRegistry;
  /** 当前身份/授权不允许装配时返回稳定的 blockedBy 原因。 */
  runtimeUnitAvailability?: (input: RuntimeUnitAvailabilityInput) => string | undefined;
  /** 为每次新建运行单元 Scope 生成当前绑定的只读属性。 */
  runtimeUnitAttributes?: (input: RuntimeUnitAttributesInput) => Readonly<Record<string, unknown>> | undefined;
  /** 为每次新建运行单元 Scope 选择生命周期父级；返回 undefined 使用 Host 根 Scope。 */
  runtimeUnitParentScope?: (input: RuntimeUnitParentScopeInput) => LifecycleScope | undefined;
  /** 贡献适配器集合。 */
  contributionAdapters?: readonly ContributionAdapter[];
  /** 允许每一项清理等待的时间。 */
  lifecycleCleanupTimeoutMs?: number;
  /** 读取远端单元真实状态。 */
  runtimeSnapshots?: () => readonly RuntimeUnitSnapshot[];
  /** 读取其它真实 Runtime 当前已接受的服务目录。 */
  remoteServiceReferences?: () => readonly RemoteServiceReference[];
  /** 允许来源 Runtime 不同且尚未出现在本地 manifest 集合中的依赖。 */
  externalRuntimeDependencies?: boolean;
}

interface ContributionRuntime {
  active: boolean;
  revoke: () => void;
  dispose: () => void | Promise<void>;
}

interface PluginRecord {
  manifest: PluginManifest;
  state: PluginStateKind;
  error?: string;
  blockedBy?: string[];
  scope?: LifecycleScope;
  instanceId?: string;
  unitId?: string;
  teardown?: PluginTeardown;
  disposeCallbacks: Array<PluginTeardown>;
  capabilities: Set<string>;
  contributions: ContributionRuntime[];
  cleanup?: LifecycleDisposeResult;
  pendingDesiredEnabled?: boolean;
  stopRequested?: string;
  preserveIntentOnStop?: boolean;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(error);
}

function makeInstanceId(pluginId: string, unitId: string): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return `${pluginId}:${unitId}:${crypto.randomUUID()}`;
    }
  } catch {
    // 某些运行环境没有 Web Crypto；该标识只承担实例去重，不承担密钥语义。
  }
  return `${pluginId}:${unitId}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
}

function lifecycleStateFor(state: PluginStateKind, desired: boolean): NonNullable<PluginState["lifecycleState"]> {
  switch (state) {
    case "starting": return "starting";
    case "stopping": return "stopping";
    case "enabled": return "running";
    case "blocked": return "waiting";
    case "error-disabled":
    case "cleanup-pending": return "failed";
    case "unknown": return desired ? "waiting" : "disabled";
    case "disabled": return "disabled";
    case "registered": return desired ? "waiting" : "disabled";
  }
}

function selectedUnit(
  manifest: PluginManifest,
  runtime: RuntimeKind | undefined,
): (RuntimeUnitDescriptor & { id: string; runtime: RuntimeKind }) | undefined {
  const units = manifest.units ?? [];
  if (units.length > 1) {
    const matches = runtime === undefined
      ? []
      : units.filter((unit): unit is RuntimeUnitDescriptor & { id: string; runtime: RuntimeKind } =>
        unit.runtime === runtime
      );
    return matches.length === 1 ? matches[0] : undefined;
  }
  if (units.length === 1) {
    const unit = units[0];
    return unit && (runtime === undefined || unit.runtime === runtime) && unit.runtime !== undefined
      ? unit as RuntimeUnitDescriptor & { id: string; runtime: RuntimeKind }
      : undefined;
  }
  const targetRuntime = runtime ?? "window-main";
  return {
    id: manifest.id,
    runtime: targetRuntime,
    dependencies: manifest.dependencies?.map((dependency) => ({
      capability: dependency.capability,
      contractVersion: dependency.contractVersion ?? `${dependency.capability}.v1`,
      sourceRuntime: dependency.sourceRuntime ?? targetRuntime,
      ...(dependency.reason !== undefined ? { reason: dependency.reason } : {}),
      ...(dependency.optional !== undefined ? { optional: dependency.optional } : {}),
    })),
    provides: manifest.provides,
    permissions: manifest.permissions,
    config: manifest.config,
    contribution: manifest.contribution,
  };
}

function dependenciesFor(
  manifest: PluginManifest,
  runtime?: RuntimeKind,
): PluginDependency[] {
  return dependenciesOfManifest(manifest, runtime);
}

function setupFor(
  manifest: PluginManifest,
  unit: RuntimeUnitDescriptor,
  options: CreatePluginHostOptions,
): PluginSetup | undefined {
  return options.runtimeUnitImplementationRegistry?.get(manifest.id, unit.id);
}

export class StartupCapabilityError extends Error {
  readonly details: StartupCapabilityErrorDetails[];
  constructor(details: StartupCapabilityErrorDetails[], phase = "startup") {
    super(`Startup prerequisite unavailable: ${details.map((item) => item.capability).join(", ")} (${phase})`);
    this.name = "StartupCapabilityError";
    this.details = details;
  }
}

export class StartupPluginError extends Error {
  readonly details: StartupPluginErrorDetails;
  constructor(details: StartupPluginErrorDetails) {
    super(`Startup plugin failed: ${details.pluginId}`);
    this.name = "StartupPluginError";
    this.details = details;
  }
}

/** 创建一个只包含通用生命周期核心的 Plugin Host。 */
export function createPluginHost(options: CreatePluginHostOptions = {}): PluginHost {
  // 未指定 Runtime 时只允许唯一运行单元自动选择；多单元产品必须由
  // 真实 Window/SharedWorker Host 显式指定执行环境。
  const runtimeKind = options.runtime;
  const listeners = new Set<HostListener>();
  let versionCounter = 0;
  let hostDisposed = false;
  let disposePromise: Promise<LifecycleDisposeResult> | undefined;
  let runtimeSnapshots = options.runtimeSnapshots;

  const bumpVersion = (): void => {
    versionCounter += 1;
    for (const listener of [...listeners]) {
      try { listener({ version: versionCounter }); } catch { /* 观察者不能改变 Host 状态。 */ }
    }
  };

  const rootScope = createLifecycleScope({
    kind: "root",
    metadata: { attributes: Object.freeze({ ...(options.rootAttributes ?? {}) }) },
    onChange: bumpVersion,
  });
  const taskScheduler = createScopedTaskScheduler(rootScope);
  const capabilities = createCapabilityRegistry();
  const messageBus = options.messageBus ?? createMessageBus();
  const resourceRegistry = options.resourceRegistry ?? createResourceRegistry();
  let rootAttributes: Readonly<Record<string, unknown>> = Object.freeze({ ...(options.rootAttributes ?? {}) });
  const instanceAttributes = new Map<string, Readonly<Record<string, unknown>>>();
  const resourceStore = createResourceStore(resourceRegistry, <T>(key: string) => (
    capabilities.has(key) ? capabilities.get<T>(key) : undefined
  ), (ownerId) => instanceAttributes.get(ownerId ?? "") ?? rootAttributes);

  const injectCapabilities = (source: CreatePluginHostOptions["capabilities"]): void => {
    if (!source) return;
    const entries = source instanceof Map ? source.entries() : Object.entries(source);
    for (const [key, value] of entries) capabilities.provide(key, value);
  };
  injectCapabilities(options.capabilities);
  injectCapabilities(options.builtinCapabilities);
  if (!capabilities.has(RUNTIME_MESSAGE_BUS)) capabilities.provide<MessageBus>(RUNTIME_MESSAGE_BUS, messageBus);
  if (!capabilities.has(RESOURCE_REGISTRY_CAPABILITY)) capabilities.provide<ResourceRegistry>(RESOURCE_REGISTRY_CAPABILITY, resourceRegistry);
  if (!capabilities.has(SCOPED_TASK_SCHEDULER_CAPABILITY)) capabilities.provide<ScopedTaskScheduler>(SCOPED_TASK_SCHEDULER_CAPABILITY, taskScheduler);

  const configStore = options.configStore ?? createInMemoryPluginConfigStore(options.initialPluginConfig, false);
  const knownManifests = new Map<string, PluginManifest>();
  const records = new Map<string, PluginRecord>();
  const enabledSet = new Set<string>();
  const starting = new Map<string, Promise<void>>();
  const stopping = new Map<string, Promise<void>>();
  const internalConfigWrites = new Set<string>();
  let intentSnapshot = options.pluginIntentCoordinator?.snapshot();
  let removeConfigSubscription = (): void => undefined;
  let removeIntentSubscription = (): void => undefined;
  let reconcilePromise: Promise<void> | undefined;

  const desiredEnabledFor = (pluginId: string, manifest?: PluginManifest): boolean => {
    // required / immutable plugins are always-on contracts. A stale false
    // value must not make their capabilities disappear during bootstrap.
    if (manifest?.meta.startup === "required" || manifest?.meta.canDisable === false) return true;
    if (intentSnapshot && Object.prototype.hasOwnProperty.call(intentSnapshot.desiredEnabled, pluginId)) {
      return intentSnapshot.desiredEnabled[pluginId] === true;
    }
    return configStore.read()[pluginId] ?? manifest?.meta.defaultEnabled ?? false;
  };

  const desiredRevisionFor = (pluginId: string): number | undefined => intentSnapshot?.desiredRevision[pluginId];

  const selected = (manifest: PluginManifest): (RuntimeUnitDescriptor & { id: string; runtime: RuntimeKind }) | undefined =>
    selectedUnit(manifest, runtimeKind);

  const graph = (): PluginGraph => buildPluginGraph([
    ...knownManifests.values(),
  ], { runtime: runtimeKind, enabledPluginIds: enabledSet });

  const validateManifest = (manifest: PluginManifest): void => {
    if (!manifest || typeof manifest.id !== "string" || manifest.id.trim() === "") throw new Error("Plugin id must be a non-empty string");
    if (typeof manifest.name !== "string" || manifest.name.trim() === "") throw new Error(`Plugin "${manifest.id}" name must be a non-empty string`);
    if (!manifest.meta || typeof manifest.meta.defaultEnabled !== "boolean" || typeof manifest.meta.canDisable !== "boolean") {
      throw new Error(`Plugin "${manifest.id}" meta must define defaultEnabled and canDisable`);
    }
    if (manifest.meta.startup === "required" && (manifest.meta.canDisable || !manifest.meta.defaultEnabled)) {
      throw new Error(`Plugin "${manifest.id}" required startup metadata is inconsistent`);
    }
    if (manifest.units !== undefined && !Array.isArray(manifest.units)) throw new Error(`Plugin "${manifest.id}" units must be an array`);
    if ((manifest.units?.length ?? 0) > 1 && runtimeKind === undefined) {
      throw new Error(`Plugin "${manifest.id}" runtime must be explicit for multi-unit manifests`);
    }
    if (manifest.units && manifest.units.length > 0) {
      const ids = new Set<string>();
      for (const unit of manifest.units) {
        if (!unit.id || ids.has(unit.id)) throw new Error(`Plugin "${manifest.id}" has duplicate or empty unit id`);
        ids.add(unit.id);
        if (unit.runtime !== "window-main" && unit.runtime !== "shared-worker") {
          throw new Error(`Plugin "${manifest.id}" unit "${unit.id}" declares an unsupported Runtime`);
        }
      }
    }
    options.manifestValidator?.(manifest);
  };

  const isRequired = (manifest: PluginManifest): boolean => manifest.meta.startup === "required" || manifest.meta.canDisable === false;

  const missingDependencies = (manifest: PluginManifest): string[] => {
    const missing: string[] = [];
    const selectedUnitForDependencies = selected(manifest);
    const localRuntime = selectedUnitForDependencies?.runtime ?? runtimeKind;
    for (const dependency of dependenciesFor(manifest, runtimeKind)) {
      if (dependency.optional) continue;
      const sourceRuntime = dependency.sourceRuntime ?? localRuntime;
      const contractVersion = dependency.contractVersion ?? `${dependency.capability}.v1`;
      if (sourceRuntime !== undefined && sourceRuntime !== localRuntime) {
        const available = options.remoteServiceReferences?.().some((reference) => (
          reference.status === "ready"
          && reference.runtime === sourceRuntime
          && reference.capabilityId === dependency.capability
          && reference.contractVersion === contractVersion
        )) ?? false;
        if (!available) missing.push(dependency.capability);
      } else if (!capabilities.has(dependency.capability)) {
        missing.push(dependency.capability);
      }
    }
    return [...new Set(missing)];
  };

  const runtimeUnavailable = (manifest: PluginManifest): string | undefined => {
    const unit = selected(manifest);
    if (!unit) {
      const units = manifest.units ?? [];
      if (units.length > 0 && runtimeKind !== undefined && !units.some((item) => item.runtime === runtimeKind)) {
        const snapshots = runtimeSnapshots?.() ?? [];
        if (snapshots.some((item) => item.pluginId === manifest.id)) return `runtime:${manifest.id}:unknown`;
      }
      return units.length > 0 ? `runtime:${manifest.id}:unit-unavailable` : undefined;
    }
    const unavailable = options.runtimeUnitAvailability?.({
      pluginId: manifest.id,
      unitId: unit.id,
      runtime: unit.runtime,
    });
    if (unavailable) return unavailable;
    if (!setupFor(manifest, unit, options)) return `runtime:${manifest.id}:${unit.id}:implementation-unavailable`;
    return undefined;
  };

  const revokeContributions = (record: PluginRecord): void => {
    for (const contribution of record.contributions) {
      if (!contribution.active) continue;
      contribution.active = false;
      try { contribution.revoke(); } catch { /* 同步撤权继续处理其它贡献。 */ }
    }
  };

  const releaseContributions = async (record: PluginRecord): Promise<void> => {
    let firstError: unknown;
    for (const contribution of [...record.contributions].reverse()) {
      try { await contribution.dispose(); } catch (error) { firstError ??= error; }
    }
    record.contributions = [];
    if (firstError) throw firstError;
  };

  const registerContribution = async (record: PluginRecord, unit: RuntimeUnitDescriptor, instanceId: string, scope: LifecycleScope): Promise<void> => {
    const contribution = unit.contribution;
    if (contribution === undefined || !options.contributionAdapters) return;
    for (const adapter of options.contributionAdapters) {
      const result = await adapter.register({
        pluginId: record.manifest.id,
        unitId: unit.id,
        instanceId,
        scope,
        contribution,
        manifest: record.manifest,
      });
      if (!result) continue;
      if (typeof result === "function") {
        let active = true;
        let cleanupPromise: Promise<void> | undefined;
        const dispose = async (): Promise<void> => {
          if (cleanupPromise) return cleanupPromise;
          if (!active) return;
          active = false;
          cleanupPromise = Promise.resolve(result());
          await cleanupPromise;
        };
        record.contributions.push({ active: true, revoke: () => { void dispose().catch(() => undefined); }, dispose });
      } else {
        const handle = result as ContributionHandle;
        let cleanupPromise: Promise<void> | undefined;
        record.contributions.push({
          active: true,
          revoke: () => {
            try { handle.revoke?.(); } catch { /* 撤权必须继续。 */ }
            if (!cleanupPromise) cleanupPromise = Promise.resolve(handle.dispose?.());
            cleanupPromise.catch(() => undefined);
          },
          dispose: async () => {
            if (cleanupPromise) return cleanupPromise;
            cleanupPromise = Promise.resolve(handle.dispose?.());
            return cleanupPromise;
          },
        });
      }
    }
  };

  const buildContext = (record: PluginRecord, unit: RuntimeUnitDescriptor, scope: LifecycleScope, instanceId: string): PluginContext => {
    const requested = [...new Set(unit.permissions ?? [])];
    const policy = options.permissionPolicy?.({
      pluginId: record.manifest.id,
      unitId: unit.id,
      // Host 的实例令牌和 Scope 原语的内部 instanceId 是两个生成点；
      // PermissionLease 必须绑定 Context 对外暴露的实例令牌。
      identity: { ...scope.identity, instanceId },
      requested,
    }) ?? { approved: requested };
    const permissionLease: PermissionLease = createPermissionLease({
      identity: { ...scope.identity, instanceId },
      requested,
      approved: policy.approved ?? requested,
      sessionConstraints: policy.sessionConstraints,
      ...(policy.binding ?? {}),
      scope,
    });
    const extension = Object.freeze({
      ...(options.contextExtension?.({
        pluginId: record.manifest.id,
        unitId: unit.id,
        instanceId,
        scope,
        manifest: record.manifest,
      }) ?? {}),
    });
    const config = unit.config === undefined ? undefined : Object.freeze({ ...unit.config });
    const contextTaskScheduler = createScopedTaskScheduler(scope);
    const scopedMessageBus = createScopedMessageBus(messageBus, scope);
    const ownedResourceIds = new Set<string>();
    let resourceDefinitionsRevoked = false;
    const revokeResourceDefinitions = (): void => {
      if (resourceDefinitionsRevoked) return;
      resourceDefinitionsRevoked = true;
      resourceStore.disposeOwner(instanceId);
      for (const resourceId of ownedResourceIds) {
        if (resourceRegistry.get(resourceId)) resourceRegistry.unregister(resourceId);
      }
      ownedResourceIds.clear();
    };
    const scopedResourceRegistry: ResourceRegistry = {
      register<T, TArgs extends readonly string[]>(definition: import("../contracts/resource.js").ResourceDefinition<T, TArgs>): void {
        scope.assertActive();
        registerOwnedResource(resourceRegistry, instanceId, definition);
        ownedResourceIds.add(definition.id);
      },
      unregister(resourceId: string): void {
        scope.assertActive();
        if (!ownedResourceIds.has(resourceId)) {
          throw new Error(`Resource definition "${resourceId}" is not owned by plugin instance "${instanceId}"`);
        }
        resourceRegistry.unregister(resourceId);
        ownedResourceIds.delete(resourceId);
      },
      get<T, TArgs extends readonly string[]>(resourceId: string) {
        return resourceRegistry.get<T, TArgs>(resourceId);
      },
      _ids() {
        return [...ownedResourceIds];
      },
    };
    scope.onRevoke(revokeResourceDefinitions);
    scope.onDispose(revokeResourceDefinitions, `resource-definitions:${record.manifest.id}`, "after-teardown");
    scope.onDispose(() => contextTaskScheduler.dispose(), `task-scheduler:${record.manifest.id}`);
    const context: PluginContext = {
      pluginId: record.manifest.id,
      instanceId,
      unitId: unit.id,
      scope,
      signal: scope.signal,
      permissions: Object.freeze([...permissionLease.binding.requested.filter((permission) => permissionLease.has(permission))]),
      permissionLease,
      serviceBridge: options.serviceBridgeForPlugin?.(record.manifest.id, instanceId),
      taskScheduler: contextTaskScheduler,
      extension,
      config,
      onDispose(cleanup) {
        scope.onDispose(cleanup, `plugin-dispose:${record.manifest.id}`);
        record.disposeCallbacks.push(cleanup);
      },
      provide<T>(key: string, value: T) {
        scope.assertActive();
        capabilities.provide(key, value);
        record.capabilities.add(key);
      },
      get<T>(key: string): T {
        if (key === RUNTIME_MESSAGE_BUS) return scopedMessageBus as T;
        if (key === RESOURCE_REGISTRY_CAPABILITY) return scopedResourceRegistry as T;
        return capabilities.get<T>(key);
      },
      has(key: string): boolean { return capabilities.has(key); },
      require(key: string): void { capabilities.require(key); },
      messageBus: scopedMessageBus,
    };
    return context;
  };

  const beginStop = (record: PluginRecord, reason: string, preserveIntent: boolean, blockedBy?: readonly string[]): void => {
    if (record.state === "stopping" || record.state === "cleanup-pending") return;
    const wasStarting = record.state === "starting";
    record.state = "stopping";
    record.error = undefined;
    record.blockedBy = undefined;
    record.stopRequested = reason;
    record.preserveIntentOnStop = preserveIntent;
    record.scope?.revoke(reason);
    revokeContributions(record);
    for (const capability of record.capabilities) capabilities.revoke(capability);
    record.capabilities.clear();
    enabledSet.delete(record.manifest.id);
    if (wasStarting) record.pendingDesiredEnabled = desiredEnabledFor(record.manifest.id, record.manifest);
    if (blockedBy) record.blockedBy = [...blockedBy];
    resourceStore.disposeOwner(record.instanceId ?? record.manifest.id);
    bumpVersion();
  };

  const finishStop = async (record: PluginRecord, reason: string): Promise<void> => {
    const scope = record.scope;
    const preserveIntent = preserveIntentOf(record);
    let teardownError: unknown;
    const projectLateCleanup = (
      result: LifecycleDisposeResult | undefined,
      error?: unknown,
    ): void => {
      if (result) record.cleanup = result;
      if (error !== undefined) {
        record.error = errorMessage(error);
        bumpVersion();
        return;
      }
      if (!result || result.cleanupIncomplete || record.state !== "cleanup-pending") return;
      const desired = record.pendingDesiredEnabled ?? desiredEnabledFor(record.manifest.id, record.manifest);
      const missing = missingDependencies(record.manifest);
      const unavailable = runtimeUnavailable(record.manifest);
      record.state = desired && (missing.length > 0 || unavailable) ? "blocked" : "disabled";
      record.blockedBy = record.state === "blocked"
        ? [...new Set([...missing, ...(unavailable ? [unavailable] : [])])]
        : undefined;
      record.error = undefined;
      bumpVersion();
      if (desired && record.state === "disabled" && !hostDisposed) {
        queueMicrotask(() => { void enable(record.manifest.id).catch(() => undefined); });
      }
    };
    const cleanup = scope
      ? await scope.dispose({
          reason,
          timeoutMs: options.lifecycleCleanupTimeoutMs,
          teardown: async () => {
            try {
              if (record.teardown) await record.teardown();
              await releaseContributions(record);
            } catch (error) {
              teardownError = error;
              throw error;
            }
          },
          onLateSuccess: (_resourceId, result) => projectLateCleanup(result),
          onLateFailure: (_resourceId, error, result) => projectLateCleanup(result, error),
        })
      : undefined;
    record.cleanup = cleanup;
    record.scope = undefined;
    if (record.instanceId) instanceAttributes.delete(record.instanceId);
    record.instanceId = undefined;
    record.unitId = undefined;
    record.teardown = undefined;
    record.stopRequested = undefined;
    record.disposeCallbacks = [];
    const desired = record.pendingDesiredEnabled ?? desiredEnabledFor(record.manifest.id, record.manifest);
    record.pendingDesiredEnabled = undefined;
    const missing = missingDependencies(record.manifest);
    const unavailable = runtimeUnavailable(record.manifest);
    const incomplete = Boolean(cleanup?.pending.length && cleanup.errors.some((item) => item.code === "lifecycle.cleanup_timeout"));
    const error = teardownError ?? cleanup?.errors.find((item) => item.code !== "lifecycle.cleanup_timeout");
    if (incomplete) {
      record.state = "cleanup-pending";
      record.error = errorMessage(error ?? "Plugin cleanup is still pending");
    } else if (error || cleanup?.cleanupIncomplete) {
      record.state = "error-disabled";
      record.error = errorMessage(error ?? "Plugin cleanup did not complete");
    } else if (desired && (missing.length > 0 || unavailable)) {
      record.state = "blocked";
      record.blockedBy = [...new Set([...missing, ...(unavailable ? [unavailable] : [])])];
    } else {
      record.state = "disabled";
      record.error = undefined;
      record.blockedBy = undefined;
    }
    if (!preserveIntent && !desired) {
      internalConfigWrites.add(record.manifest.id);
      try { configStore.setEnabled(record.manifest.id, false); } finally { internalConfigWrites.delete(record.manifest.id); }
    }
    record.preserveIntentOnStop = undefined;
    bumpVersion();
    if (desired && record.state === "disabled" && !hostDisposed) {
      queueMicrotask(() => { void enable(record.manifest.id).catch(() => undefined); });
    }
  };

  const preserveIntentOf = (record: PluginRecord): boolean => record.preserveIntentOnStop === true;

  const stopPlugin = async (record: PluginRecord, reason: string, preserveIntent: boolean, blockedBy?: readonly string[]): Promise<void> => {
    const existing = stopping.get(record.manifest.id);
    if (existing) return existing;
    beginStop(record, reason, preserveIntent, blockedBy);
    const start = starting.get(record.manifest.id);
    const promise = (start ? start.catch(() => undefined) : Promise.resolve())
      .then(() => finishStop(record, reason))
      .finally(() => stopping.delete(record.manifest.id));
    stopping.set(record.manifest.id, promise);
    return promise;
  };

  const enable = async (pluginId: string): Promise<void> => {
    if (hostDisposed) throw new LifecycleScopeRevokedError("Plugin host is disposed");
    const record = records.get(pluginId);
    if (!record) throw new Error(`Plugin "${pluginId}" is not registered`);
    // enable() expresses a new absolute local intent. Persist it before any
    // in-flight stop/start wait so callers can observe the new intent during
    // the transitional state as well.
    if (!options.pluginIntentCoordinator) {
      internalConfigWrites.add(pluginId);
      try { configStore.setEnabled(pluginId, true); }
      finally { internalConfigWrites.delete(pluginId); }
    }
    record.pendingDesiredEnabled = true;
    const existingStop = stopping.get(pluginId);
    if (existingStop) { await existingStop; }
    if (record.state === "enabled") return;
    const existing = starting.get(pluginId);
    if (existing) return existing;
    // 旧实例的 stopRequested 只用于让迟到的 setup 结果退出；停止完成后
    // 新一代实例必须清掉这个一次性标记，否则会被误判为仍在停止。
    record.stopRequested = undefined;
    if (record.state === "cleanup-pending") {
      throw new Error(`Plugin "${pluginId}" cannot start while cleanup is pending`);
    }
    if (record.state === "error-disabled") {
      record.error = undefined;
      record.cleanup = undefined;
    }
    const task = (async () => {
      const missing = missingDependencies(record.manifest);
      const unavailable = runtimeUnavailable(record.manifest);
      if (missing.length > 0 || unavailable) {
        record.state = "blocked";
        record.blockedBy = [...new Set([...missing, ...(unavailable ? [unavailable] : [])])];
        bumpVersion();
        return;
      }
      const unit = selected(record.manifest);
      if (!unit) {
        record.state = "blocked";
        record.blockedBy = [`runtime:${record.manifest.id}:unit-unavailable`];
        bumpVersion();
        return;
      }
      const instanceId = makeInstanceId(record.manifest.id, unit.id);
      let scope: LifecycleScope;
      try {
        const attributes = Object.freeze({
          ...rootAttributes,
          ...(options.runtimeUnitAttributes?.({
            pluginId: record.manifest.id,
            unitId: unit.id,
            runtime: unit.runtime,
            manifest: record.manifest,
          }) ?? {}),
        });
        const parent = options.runtimeUnitParentScope?.({
          pluginId: record.manifest.id,
          unitId: unit.id,
          runtime: unit.runtime,
          manifest: record.manifest,
        }) ?? rootScope;
        scope = parent.child("runtime-unit", { pluginId: record.manifest.id, attributes });
      } catch (error) {
        record.state = "blocked";
        record.blockedBy = [errorMessage(error)];
        bumpVersion();
        return;
      }
      record.state = "starting";
      record.scope = scope;
      record.instanceId = instanceId;
      record.unitId = unit.id;
      instanceAttributes.set(instanceId, scope.identity.attributes);
      record.error = undefined;
      record.blockedBy = undefined;
      bumpVersion();
      try {
        const setup = setupFor(record.manifest, unit, options);
        if (!setup) throw new Error(`Runtime implementation is unavailable for ${record.manifest.id}/${unit.id}`);
        const context = buildContext(record, unit, scope, instanceId);
        const result = await setup(context);
        record.teardown = typeof result === "function" ? result : undefined;
        await registerContribution(record, unit, instanceId, scope);
        const declared = providesOfManifest(record.manifest, runtimeKind);
        const missingDeclarations = declared.filter((key) => !record.capabilities.has(key));
        if (missingDeclarations.length > 0) {
          throw new Error(`Plugin "${record.manifest.id}" did not provide declared capabilities: ${missingDeclarations.join(", ")}`);
        }
        if (record.stopRequested || scope.state !== "active" || !desiredEnabledFor(record.manifest.id, record.manifest)) {
          return;
        }
        enabledSet.add(record.manifest.id);
        record.state = "enabled";
        record.pendingDesiredEnabled = undefined;
        bumpVersion();
        // Provider capability 变为可用后，按绝对意图恢复此前等待的消费者。
        // 放到微任务避免在当前 setup 调用栈中重入 Host 状态机。
        queueMicrotask(() => { void reconcile().catch(() => undefined); });
      } catch (error) {
        if (record.stopRequested || scope.state !== "active") {
          return;
        }
        record.state = "error-disabled";
        record.error = errorMessage(error);
        record.scope?.revoke("plugin setup failed");
        revokeContributions(record);
        for (const capability of record.capabilities) capabilities.revoke(capability);
        record.capabilities.clear();
        record.cleanup = await scope.dispose({ reason: "plugin setup failed", timeoutMs: options.lifecycleCleanupTimeoutMs });
        record.scope = undefined;
        instanceAttributes.delete(instanceId);
        record.instanceId = undefined;
        record.unitId = undefined;
        bumpVersion();
        throw new StartupPluginError({
          pluginId: record.manifest.id,
          unitId: unit.id,
          capabilities: providesOfManifest(record.manifest, runtimeKind),
          state: record.state,
          error: record.error,
        });
      }
    })();
    starting.set(pluginId, task);
    try { await task; } finally { starting.delete(pluginId); }
  };

  const collectDisablePlan = (pluginId: string): PluginRecord[] => {
    const plan: PluginRecord[] = [];
    const visited = new Set<string>();
    const currentGraph = graph();
    const activePluginIds = new Set([
      ...enabledSet,
      ...[...records.values()]
        .filter((record) => record.state === "starting" || record.state === "stopping")
        .map((record) => record.manifest.id),
    ]);
    const visit = (providerId: string): void => {
      for (const dependent of reverseDependentsOf(currentGraph, providerId, activePluginIds)) {
        if (visited.has(dependent.pluginId)) continue;
        visited.add(dependent.pluginId);
        visit(dependent.pluginId);
        const dependentRecord = records.get(dependent.pluginId);
        if (dependentRecord) plan.push(dependentRecord);
      }
    };
    visit(pluginId);
    const target = records.get(pluginId);
    if (target) plan.push(target);
    return plan;
  };

  const reconcile = async (): Promise<void> => {
    if (hostDisposed) return;
    if (reconcilePromise) return reconcilePromise;
    reconcilePromise = (async () => {
      const manifests = [...knownManifests.values()];
      const ordered = orderManifestsByDependencies(manifests, runtimeKind);
      for (const manifest of ordered) {
        const record = records.get(manifest.id);
        if (!record) continue;
        if (record && (record.state === "enabled" || record.state === "starting")) {
          const missing = missingDependencies(manifest);
          const unavailable = runtimeUnavailable(manifest);
          if (missing.length > 0 || unavailable) {
            await stopPlugin(
              record,
              "runtime dependency unavailable",
              true,
              [...new Set([...missing, ...(unavailable ? [unavailable] : [])])],
            );
          }
        }
        if (desiredEnabledFor(manifest.id, manifest) && record.state !== "enabled" && record.state !== "starting") {
          try {
            await enable(manifest.id);
          } catch (error) {
            // Optional startup failure is represented in the Host state and
            // must not prevent unrelated required units from starting.
            if (!isRequired(manifest)) continue;
            throw error;
          }
        }
      }
      for (const manifest of manifests) {
        const record = records.get(manifest.id);
        if (record && !desiredEnabledFor(manifest.id, manifest) && (record.state === "enabled" || record.state === "starting")) {
          await stopPlugin(record, "desired intent disabled", false);
        }
      }
    })().finally(() => { reconcilePromise = undefined; });
    return reconcilePromise;
  };

  function orderManifestsByDependencies(
    manifests: readonly PluginManifest[],
    runtime?: RuntimeKind,
  ): PluginManifest[] {
    const byId = new Map(manifests.map((manifest) => [manifest.id, manifest]));
    const providers = new Map<string, string>();
    for (const manifest of manifests) {
      for (const capability of providesOfManifest(manifest, runtime)) {
        if (!providers.has(capability)) providers.set(capability, manifest.id);
      }
    }
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const ordered: PluginManifest[] = [];
    const visit = (manifest: PluginManifest): void => {
      if (visited.has(manifest.id)) return;
      if (visiting.has(manifest.id)) return;
      visiting.add(manifest.id);
      for (const dependency of dependenciesFor(manifest, runtime)) {
        if (dependency.optional) continue;
        const provider = providers.get(dependency.capability);
        const providerManifest = provider ? byId.get(provider) : undefined;
        if (providerManifest) visit(providerManifest);
      }
      visiting.delete(manifest.id);
      visited.add(manifest.id);
      ordered.push(manifest);
    };
    for (const manifest of manifests) visit(manifest);
    return ordered;
  }

  const host: PluginHost = {
    capabilities,
    messageBus,
    resourceRegistry,
    resourceStore,
    rootScope,
    taskScheduler,
    installed: () => [...knownManifests.keys()],
    manifests: () => [...knownManifests.keys()],
    state(pluginId) {
      const record = records.get(pluginId);
      if (!record) return { id: pluginId, kind: "disabled", lifecycleState: "disabled" };
      const desired = desiredEnabledFor(pluginId, record.manifest);
      const unit = selected(record.manifest);
      return {
        id: pluginId,
        kind: record.state,
        lifecycleState: lifecycleStateFor(record.state, desired),
        ...(record.error ? { error: record.error } : {}),
        desiredEnabled: desired,
        ...(desiredRevisionFor(pluginId) !== undefined ? { desiredRevision: desiredRevisionFor(pluginId) } : {}),
        ...(record.instanceId ? { instanceId: record.instanceId } : {}),
        ...(record.unitId ? { unitId: record.unitId } : {}),
        ...(record.blockedBy ? { blockedBy: [...record.blockedBy] } : {}),
        ...(record.cleanup ? { cleanup: record.cleanup } : {}),
        units: unit ? [{
          pluginId,
          unitId: unit.id,
          runtime: unit.runtime,
          kind: record.state,
          ...(record.instanceId ? { instanceId: record.instanceId } : {}),
          ...(record.error ? { error: record.error } : {}),
        }] : [],
      };
    },
    scope: (pluginId) => records.get(pluginId)?.scope,
    refreshRuntimeUnitSnapshots() { runtimeSnapshots = options.runtimeSnapshots; bumpVersion(); },
    reconcile,
    graph,
    version: () => versionCounter,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    getManifest: (pluginId) => knownManifests.get(pluginId),
    reverseDeps(pluginId) { return graph().reverse[pluginId] ?? []; },
    validateManifestSet(manifests) {
      for (const manifest of manifests) validateManifest(manifest);
      validatePluginGraph([...manifests], {
        runtime: runtimeKind,
        builtinCapabilities: new Set([
          ...capabilities.keys(),
          ...(options.remoteServiceReferences?.() ?? []).map((reference) => reference.capabilityId),
        ]),
        externalRuntimeDependencies: options.externalRuntimeDependencies,
      });
    },
    provide<T>(key: string, value: T) {
      if (hostDisposed) throw new LifecycleScopeRevokedError("Plugin host is disposed");
      capabilities.provide(key, value);
      bumpVersion();
    },
    register: async (manifest) => {
      if (hostDisposed) throw new LifecycleScopeRevokedError("Plugin host is disposed");
      validateManifest(manifest);
      if (knownManifests.has(manifest.id)) throw new Error(`Plugin "${manifest.id}" is already registered`);
      knownManifests.set(manifest.id, manifest);
      records.set(manifest.id, { manifest, state: "registered", disposeCallbacks: [], capabilities: new Set(), contributions: [] });
      bumpVersion();
      if (desiredEnabledFor(manifest.id, manifest)) await enable(manifest.id);
    },
    registerAll: async (manifests) => {
      if (hostDisposed) throw new LifecycleScopeRevokedError("Plugin host is disposed");
      const current = [...manifests];
      for (const manifest of current) {
        validateManifest(manifest);
        if (knownManifests.has(manifest.id)) throw new Error(`Plugin "${manifest.id}" is already registered`);
      }
      validatePluginGraph(current, {
        runtime: runtimeKind,
        builtinCapabilities: new Set([
          ...capabilities.keys(),
          ...(options.remoteServiceReferences?.() ?? []).map((reference) => reference.capabilityId),
        ]),
        allowMissingDependencies: false,
        externalRuntimeDependencies: options.externalRuntimeDependencies,
      });
      for (const manifest of current) {
        knownManifests.set(manifest.id, manifest);
        records.set(manifest.id, { manifest, state: "registered", disposeCallbacks: [], capabilities: new Set(), contributions: [] });
      }
      bumpVersion();
      await reconcile();
    },
    enable,
    retry: async (pluginId) => {
      const record = records.get(pluginId);
      if (!record) throw new Error(`Plugin "${pluginId}" is not registered`);
      record.error = undefined;
      record.cleanup = undefined;
      record.state = "registered";
      await enable(pluginId);
    },
    submitIntent: async (pluginId, desired): Promise<PluginIntentSubmissionResult> => {
      if (!knownManifests.has(pluginId)) throw new Error(`Plugin "${pluginId}" is not registered`);
      if (options.pluginIntentCoordinator) {
        const current = options.pluginIntentCoordinator.snapshot();
        const command = {
          commandId: `plugin-intent:${pluginId}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`,
          authorityInstanceId: options.pluginIntentCoordinator.authorityInstanceId,
          expectedRevision: current.revision,
          pluginId,
          desiredEnabled: desired,
        };
        return options.pluginIntentCoordinator.submit(command);
      }
      internalConfigWrites.add(pluginId);
      try { configStore.setEnabled(pluginId, desired); } finally { internalConfigWrites.delete(pluginId); }
      if (desired) await enable(pluginId);
      else await host.disable(pluginId);
      const next = Object.freeze({
        revision: 0,
        desiredEnabled: { ...configStore.read() },
        desiredRevision: {},
      });
      return { status: "accepted", commandId: `local:${pluginId}`, snapshot: next, persisted: true };
    },
    disable: async (pluginId) => {
      const record = records.get(pluginId);
      if (!record) throw new Error(`Plugin "${pluginId}" is not registered`);
      if (isRequired(record.manifest)) return { ok: false, reason: `Plugin "${pluginId}" cannot be disabled` } as const;
      if (!options.pluginIntentCoordinator) {
        internalConfigWrites.add(pluginId);
        try { configStore.setEnabled(pluginId, false); } finally { internalConfigWrites.delete(pluginId); }
      }
      const plan = collectDisablePlan(pluginId);
      // 先同步撤掉整个级联计划，再逐项等待异步收尾；这样消费者不会在
      // 提供者能力仍可见的窗口里自动重启。
      for (const item of plan) beginStop(
        item,
        item.manifest.id === pluginId ? "plugin disabled" : `dependency ${pluginId} disabled`,
        item.manifest.id !== pluginId,
        item.manifest.id === pluginId ? undefined : [pluginId],
      );
      for (const item of plan) await stopPlugin(
        item,
        item.manifest.id === pluginId ? "plugin disabled" : `dependency ${pluginId} disabled`,
        item.manifest.id !== pluginId,
        item.manifest.id === pluginId ? undefined : [pluginId],
      );
      return { ok: true } as const;
    },
    suspend: async (pluginId, reason = "runtime identity changed") => {
      const record = records.get(pluginId);
      if (!record) return;
      if (record.state !== "enabled" && record.state !== "starting") return;
      // suspend 不改变用户/权威控制面的 desiredEnabled；它只撤销当前
      // Scope，避免身份切换把永久启用的系统插件写成 disabled。
      beginStop(record, reason, true);
      await stopPlugin(record, reason, true);
    },
    unregister: async (pluginId) => {
      const record = records.get(pluginId);
      if (!record) return;
      if (isRequired(record.manifest)) throw new Error(`Plugin "${pluginId}" cannot be unregistered`);
      await host.disable(pluginId);
      if (record.state === "cleanup-pending") throw new Error(`Plugin "${pluginId}" cleanup is still pending`);
      records.delete(pluginId);
      knownManifests.delete(pluginId);
      bumpVersion();
    },
    dispose: (reason = "plugin host disposed") => {
      if (disposePromise) return disposePromise;
      hostDisposed = true;
      removeConfigSubscription();
      removeIntentSubscription();
      disposePromise = (async () => {
        for (const record of [...records.values()].reverse()) {
          if (record.state === "enabled" || record.state === "starting") {
            await stopPlugin(record, reason, false);
          }
        }
        return rootScope.dispose({ reason, timeoutMs: options.lifecycleCleanupTimeoutMs });
      })();
      return disposePromise;
    },
    assertCapabilities(required, extra = {}) {
      const details: StartupCapabilityErrorDetails[] = [];
      for (const capability of required) {
        if (capabilities.has(capability)) continue;
        const provider = graph().providers?.[capability]?.[0];
        const providerRecord = provider ? records.get(provider) : undefined;
        details.push({
          capability,
          providerPluginId: provider,
          providerState: providerRecord?.state,
          providerError: providerRecord?.error,
          configuredEnabled: providerRecord ? desiredEnabledFor(providerRecord.manifest.id, providerRecord.manifest) : undefined,
        });
      }
      if (details.length > 0) throw new StartupCapabilityError(details, extra.phase ?? "startup");
    },
  };

  // 将插件意图控制面接回 Host，但不把控制面实现复制进通用核心。
  if (options.pluginIntentCoordinator) {
    removeIntentSubscription = options.pluginIntentCoordinator.subscribe((snapshot) => {
      intentSnapshot = snapshot;
      void reconcile().catch(() => undefined);
      bumpVersion();
    });
  }
  removeConfigSubscription = configStore.subscribe((snapshot) => {
    if (internalConfigWrites.size > 0) return;
    for (const [pluginId, manifest] of knownManifests) {
      if (manifest.meta.startup !== "required" && manifest.meta.canDisable !== false) continue;
      if (snapshot[pluginId] === true) continue;
      internalConfigWrites.add(pluginId);
      try { configStore.setEnabled(pluginId, true); }
      finally { internalConfigWrites.delete(pluginId); }
    }
    void reconcile().catch(() => undefined);
    bumpVersion();
  });
  return host;
}

export interface PluginHost {
  /** 通用 capability 注册表。 */
  capabilities: CapabilityRegistry;
  /** 通用消息总线。 */
  messageBus: MessageBus;
  /** 通用资源定义注册表。 */
  resourceRegistry: ResourceRegistry;
  /** 通用资源缓存和订阅 Store。 */
  resourceStore: ResourceStoreApi;
  /** Host 根生命周期 Scope。 */
  readonly rootScope: LifecycleScope;
  /** 根 Scope 的任务调度器。 */
  readonly taskScheduler: ScopedTaskScheduler;
  /** 已知产品标识。 */
  installed(): string[];
  /** 已知产品标识；installed 的兼容别名。 */
  manifests(): string[];
  /** 查询产品运行状态。 */
  state(pluginId: string): PluginState;
  /** 查询当前实例 Scope。 */
  scope(pluginId: string): LifecycleScope | undefined;
  /** 让宿主重新读取远端运行单元快照。 */
  refreshRuntimeUnitSnapshots(): void;
  /** 让领域适配器在 Scope 身份变化后立即完成一次协调。 */
  reconcile(): Promise<void>;
  /** 获取依赖图。 */
  graph(): PluginGraph;
  /** Host 版本。 */
  version(): number;
  /** 订阅 Host 变化。 */
  subscribe(listener: HostListener): () => void;
  /** 获取清单。 */
  getManifest(pluginId: string): PluginManifest | undefined;
  /** 查询反向依赖。 */
  reverseDeps(pluginId: string): PluginReverseDep[];
  /** 校验一组清单。 */
  validateManifestSet(manifests: readonly PluginManifest[]): void;
  /** 注入一个不归属插件实例的内建 capability。 */
  provide<T>(key: string, value: T): void;
  /** 注册并按当前意图尝试启动。 */
  register(manifest: PluginManifest): Promise<void>;
  /** 批量注册并按依赖顺序协调。 */
  registerAll(manifests: readonly PluginManifest[]): Promise<void>;
  /** 启动一个插件。 */
  enable(pluginId: string): Promise<void>;
  /** 清除失败状态并重试。 */
  retry(pluginId: string): Promise<void>;
  /** 提交绝对启停意图。 */
  submitIntent(pluginId: string, desiredEnabled: boolean): Promise<PluginIntentSubmissionResult>;
  /** 停止一个插件及其反向依赖者。 */
  disable(pluginId: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** 暂停当前实例但保留启用意图；供宿主身份世代切换时撤权重建。 */
  suspend(pluginId: string, reason?: string): Promise<void>;
  /** 从 Host 删除一个插件。 */
  unregister(pluginId: string): Promise<void>;
  /** 停止所有实例并释放根 Scope。 */
  dispose(reason?: string): Promise<LifecycleDisposeResult>;
  /** 启动前检查 capability。 */
  assertCapabilities(capabilities: readonly string[], options?: { phase?: string }): void;
}
