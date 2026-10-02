// WebLoom v4 Plugin Host。
//
// Host 是声明、实例和 Scope 的唯一权威。capability registry 只按
// (kind,id,version) 绑定，远程目录则由 Runtime bridge 投影；普通插件看不到
// raw MessagePort、服务 codec 或可变的全局 Host 实现。

import {
  capabilityDescriptor,
  capabilityKey,
  type Capability,
  type CapabilityBridge,
  type CapabilityClient,
  type CapabilityDependency,
  type CapabilityDescriptor,
  type HandlerCallContext,
  type LocalCapability,
  type LocalServiceOf,
  type RemoteCapability,
  type RpcCapability,
  type RpcCapabilityBase,
  type RpcCallOptions,
  type RpcClient,
  type RpcHandler,
  type StreamCapability,
  type StreamCapabilityBase,
  type StreamClient,
  type StreamHandler,
  type StreamSubscribeOptions,
  type StreamSubscription,
  type ServiceReference,
} from "../contracts/capability.js";
import { derivePrivateGrant } from "../runtime/privateGrant.js";
import type {
  LifecycleDisposeResult,
  LifecycleScope,
  LifecycleScopeIdentity,
  PermissionLease,
  PermissionLeaseBinding,
  PluginPermission,
  RuntimeKind,
  ScopedTaskScheduler,
} from "../contracts/lifecycle.js";
import { LifecycleScopeRevokedError, WebLoomError } from "../contracts/lifecycle.js";
import type {
  PluginContext,
  PluginGraph,
  PluginLifecycleState,
  PluginManifest,
  PluginReverseDep,
  PluginSetup,
  PluginState,
  PluginStateKind,
  PluginTeardown,
  PluginUnitState,
  HostListener,
  RuntimeUnitDescriptor,
  RuntimeUnitImplementationRegistry,
  StartupCapabilityErrorDetails,
} from "../contracts/plugin.js";
import type { MessageBus } from "../contracts/messageBus.js";
import { RESOURCE_REGISTRY, type ResourceRegistry } from "../contracts/resource.js";
import { createCapabilityRegistry, invokeCapabilityHandler, type CapabilityRegistration, type CapabilityRegistry } from "./capabilityRegistry.js";
import { buildPluginGraph, dependenciesOfManifest, providesOfManifest, reverseDependentsOf, selectRuntimeUnit, startupLayers, teardownLayers, validatePluginGraph } from "./pluginGraph.js";
import { createLifecycleScope } from "../lifecycle/resourceScope.js";
import { createPermissionLease } from "../lifecycle/permissionLease.js";
import { createScopedMessageBus } from "../lifecycle/scopedMessageBus.js";
import { createScopedTaskScheduler } from "../lifecycle/taskScheduler.js";
import { createMessageBus } from "../messaging/messageBus.js";
import { createResourceRegistry } from "../resources/resourceRegistry.js";
import { registerOwnedResource, unregisterOwnedResource } from "../resources/resourceRegistry.js";
import { createResourceStore, type ResourceStoreApi } from "../resources/resourceStore.js";
import { cloneFrozenAttributes } from "../transport/dto.js";
import { createPluginConsumer } from "./pluginConsumer.js";
import type { PluginConsumer } from "../contracts/consumer.js";
import { createInstanceResourceRegistry, UNOWNED_RESOURCE_OWNER } from "../resources/instanceResourceRegistry.js";

export interface PermissionPolicyInput {
  /** 插件标识。 */
  readonly pluginId: string;
  /** 运行单元标识。 */
  readonly unitId: string;
  /** 当前 Scope 身份。 */
  readonly identity: LifecycleScopeIdentity;
  /** 清单申请的权限。 */
  readonly requested: readonly PluginPermission[];
}

export interface PermissionPolicyResult {
  /** 可信批准集合；缺省时为 requested。 */
  readonly approved?: readonly PluginPermission[];
  /** 当前会话额外限制。 */
  readonly sessionConstraints?: readonly PluginPermission[];
  /** 租约绑定的策略/授权修订。 */
  readonly binding?: Partial<Pick<PermissionLeaseBinding, "policyRevision" | "grantRevision" | "grantId">>;
}

export interface ContextExtensionInput {
  /** 插件标识。 */
  readonly pluginId: string;
  /** 单元标识。 */
  readonly unitId: string;
  /** 实例标识。 */
  readonly instanceId: string;
  /** 实例 Scope。 */
  readonly scope: LifecycleScope;
  /** 静态 manifest。 */
  readonly manifest: PluginManifest;
}

export interface ContributionAdapterInput {
  /** 插件标识。 */
  readonly pluginId: string;
  /** 单元标识。 */
  readonly unitId: string;
  /** 实例标识。 */
  readonly instanceId: string;
  /** 实例 Scope。 */
  readonly scope: LifecycleScope;
  /**
   * 本次贡献所属实例的受限消费视图（PCB-R04）。
   *
   * 它与 setup 阶段的 `ctx.consumer` 是同一个对象：下游可信适配器可以捕获
   * 它并与注册项一起保存，或用它包装要挂载的组件，使 UI 始终按本实例读取
   * 能力。框架不规定 AppRoute/页面 schema，也不检查组件属于哪种业务。
   */
  readonly consumer: PluginConsumer;
  /** 产品贡献。 */
  readonly contribution: unknown;
  /** 静态 manifest。 */
  readonly manifest: PluginManifest;
}

export interface ContributionHandle {
  /** 同步撤下入口。 */
  revoke?(): void;
  /** 异步收尾。 */
  dispose?(): void | Promise<void>;
}

export interface ContributionAdapter {
  /** 适配器名称。 */
  readonly name?: string;
  /** 注册一份产品贡献。 */
  register(input: ContributionAdapterInput): void | ContributionHandle | (() => void | Promise<void>) | Promise<void | ContributionHandle | (() => void | Promise<void>)>;
}

export interface RuntimeUnitAvailabilityInput {
  /** 插件标识。 */
  readonly pluginId: string;
  /** 单元标识。 */
  readonly unitId: string;
  /** 真实 Runtime。 */
  readonly runtime: RuntimeKind;
}

export interface RuntimeUnitAttributesInput extends RuntimeUnitAvailabilityInput {
  /** 静态 manifest。 */
  readonly manifest: PluginManifest;
}

export type RuntimeUnitParentScopeInput = RuntimeUnitAttributesInput;

export interface RuntimeUnitSnapshot {
  /** 插件标识。 */
  readonly pluginId: string;
  /** 单元标识。 */
  readonly unitId: string;
  /** Runtime。 */
  readonly runtime: RuntimeKind;
  /** 当前实例。 */
  readonly instanceId?: string;
  /** 状态。 */
  readonly state: PluginStateKind;
}

export interface HostCapabilityRegistration {
  /** Host-owned capability。 */
  readonly capability: LocalCapability<unknown>;
  /** 对应服务值。 */
  readonly value: unknown;
}

export interface CreatePluginHostOptions {
  /** 当前 Host 的真实 Runtime。 */
  readonly runtime?: RuntimeKind;
  /** Runtime 逻辑标识。 */
  readonly runtimeId?: string;
  /** Runtime 启动实例标识。 */
  readonly runtimeInstanceId?: string;
  /** 根 Scope 属性。 */
  readonly rootAttributes?: Readonly<Record<string, unknown>>;
  /** Host-owned local capability；不接受字符串键。 */
  readonly capabilities?: ReadonlyMap<LocalCapability<unknown>, unknown> | readonly HostCapabilityRegistration[];
  /** capabilities 的显式别名。 */
  readonly builtinCapabilities?: ReadonlyMap<LocalCapability<unknown>, unknown> | readonly HostCapabilityRegistration[];
  /** 共享 MessageBus。 */
  readonly messageBus?: MessageBus;
  /** 资源定义注册表。 */
  readonly resourceRegistry?: ResourceRegistry;
  /**
   * 宿主登记的 unowned 资源使用的领域 capability resolver。
   *
   * 该回调只对 ownerId 为空的宿主资源生效；插件实例拥有的资源一律走该
   * 实例 consumer 的 typed 解析，不会降级到这里。回调收到完整 typed
   * capability 对象而不是字符串 id，因此实现方能同时核对 kind 与 version；
   * 只按 id 返回值会放行错版本的请求。
   */
  readonly resourceCapabilityResolver?: <C extends Capability>(capability: C) => CapabilityClient<C> | undefined;
  /** 领域 Context Extension。 */
  readonly contextExtension?: (input: ContextExtensionInput) => Readonly<Record<string, unknown>>;
  /** 清单额外校验。 */
  readonly manifestValidator?: (manifest: PluginManifest) => void;
  /** 权限策略。 */
  readonly permissionPolicy?: (input: PermissionPolicyInput) => PermissionPolicyResult;
  /** 当前 Runtime 的 typed remote bridge（默认槽位）。 */
  readonly capabilityBridge?: CapabilityBridge;
  /**
   * 单元级远端依赖的槽位绑定（PSM-R12）。
   *
   * key 为 `pluginId\u0000unitId` 或 `pluginId\u0000unitId\u0000capabilityKey`（更精确）；
   * 装配层决定哪个单元用哪个 Worker，插件代码不写死。
   */
  readonly runtimeSlotBindings?: Readonly<Record<string, string>>;
  /**
   * 所属单元的私有能力登记（PSM-R13）。
   *
   * key 为 `pluginId\u0000unitId\u0000capabilityKey`。私有入口不进公共 provides、服务目录
   * 或 Connect 名单，只有同 pluginId + 同 unitId 的调用实例能解析。
   */
  readonly privateCapabilities?: readonly { readonly pluginId: string; readonly unitId: string; readonly capability: Capability; readonly grantId: string }[];
  /** 实现注册表。 */
  readonly runtimeUnitImplementationRegistry?: RuntimeUnitImplementationRegistry;
  /** 按 plugin/unit 提供当前 realm capability 定义。 */
  readonly capabilityDefinitions?: ReadonlyMap<string, readonly Capability[]>;
  /** Runtime 可用性检查。 */
  readonly runtimeUnitAvailability?: (input: RuntimeUnitAvailabilityInput) => string | undefined;
  /** 实例 Scope 属性。 */
  readonly runtimeUnitAttributes?: (input: RuntimeUnitAttributesInput) => Readonly<Record<string, unknown>> | undefined;
  /** 实例 Scope 父级。 */
  readonly runtimeUnitParentScope?: (input: RuntimeUnitParentScopeInput) => LifecycleScope | undefined;
  /** 贡献适配器。 */
  readonly contributionAdapters?: readonly ContributionAdapter[];
  /** 清理超时。 */
  readonly lifecycleCleanupTimeoutMs?: number;
  /** 外部 Runtime dependency 是否允许。 */
  readonly externalRuntimeDependencies?: boolean;
}

interface ContributionRuntime {
  active: boolean;
  revoke(): void;
  dispose(): void | Promise<void>;
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
  provided: Capability[];
  /** 私有登记的能力：撤销时必须一并回收，否则旧私有句柄会一直可用（PSM-R13）。 */
  privateProvided: Capability[];
  contributions: ContributionRuntime[];
  cleanup?: LifecycleDisposeResult;
  stopRequested?: string;
  /** 当前实例签发的受限消费视图；实例停止后立即失效。 */
  consumer?: PluginConsumer;
  /**
   * 当前生效的运行条件（已释放实例，等待 retry 或条件解除）。
   *
   * 它取代旧的用户启停意图：值只来自可信装配层的 `revoke()`，并在 blockedBy 中
   * 以 `revoked:<reason>` 暴露。没有条件时插件按依赖图自动重建。
   */
  condition?: string;
}

export class StartupCapabilityError extends Error {
  readonly details: readonly StartupCapabilityErrorDetails[];
  constructor(details: readonly StartupCapabilityErrorDetails[], phase = "startup") {
    const labels = details.map((item) => typeof item.capability === "string" ? item.capability : item.capability.id);
    super(`Startup prerequisite unavailable during ${phase}${labels.length > 0 ? `: ${labels.join(", ")}` : ""}`);
    this.name = "StartupCapabilityError";
    this.details = Object.freeze([...details]);
  }
}

export class StartupPluginError extends Error {
  readonly details: { readonly pluginId: string; readonly unitId?: string; readonly capabilities: readonly CapabilityDescriptor[]; readonly state: PluginStateKind; readonly error?: string };
  constructor(details: { readonly pluginId: string; readonly unitId?: string; readonly capabilities: readonly CapabilityDescriptor[]; readonly state: PluginStateKind; readonly error?: string }) {
    super(`Startup plugin failed: ${details.pluginId}`);
    this.name = "StartupPluginError";
    this.details = Object.freeze({ ...details });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === "string" ? error : String(error);
}

function makeId(prefix: string): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return `${prefix}:${crypto.randomUUID()}`;
  } catch { /* identity fallback */ }
  return `${prefix}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
}

/**
 * 把内部状态映射为对外生命周期语义。
 *
 * 没有“已禁用”状态：所有被装配的插件都在等待依赖、运行、停止或失败，区分依据是
 * 依赖图与运行条件，不是任何用户意图。
 */
function lifecycleStateFor(state: PluginStateKind): PluginLifecycleState {
  switch (state) {
    case "starting": return "starting";
    case "stopping": return "stopping";
    case "enabled": return "running";
    case "blocked":
    case "registered":
    case "unknown": return "waiting";
    case "failed":
    case "cleanup-pending": return "failed";
  }
}

function implementationKey(pluginId: string, unitId: string): string {
  return `${pluginId}\u0000${unitId}`;
}

function isRemote(capability: Capability): capability is RemoteCapability {
  return capability.kind === "rpc" || capability.kind === "stream";
}

function mergeSignals(...signals: readonly (AbortSignal | undefined)[]): { readonly signal: AbortSignal; dispose(): void } {
  const active = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  const controller = new AbortController();
  const abort = (signal: AbortSignal): void => {
    try { controller.abort(signal.reason); } catch { controller.abort(); }
  };
  const listeners = active.map((signal) => {
    const listener = (): void => abort(signal);
    if (signal.aborted) abort(signal);
    else signal.addEventListener("abort", listener, { once: true });
    return { signal, listener };
  });
  return {
    signal: controller.signal,
    dispose() { for (const item of listeners) item.signal.removeEventListener("abort", item.listener); },
  };
}

function assertTimeout(value: number | undefined): number {
  const result = value ?? 30_000;
  if (!Number.isFinite(result) || result < 1 || result > 300_000) throw new TypeError("timeoutMs must be a finite number from 1 to 300000");
  return result;
}

function rejectedStreamSubscription(error: WebLoomError): StreamSubscription<unknown> {
  let rejectReady!: (reason: unknown) => void;
  let rejectClosed!: (reason: unknown) => void;
  const ready = new Promise<void>((_, reject) => { rejectReady = reject; });
  const closed = new Promise<void>((_, reject) => { rejectClosed = reject; });
  void ready.catch(() => undefined);
  void closed.catch(() => undefined);
  rejectReady(error);
  rejectClosed(error);
  return { ready, closed, cancel() { /* terminal */ } };
}

function parseOrThrow<T>(parser: { parse(value: unknown): T }, value: unknown, code: "request_validation_failed" | "response_validation_failed", capability: CapabilityDescriptor): T {
  try { return parser.parse(value); } catch (error) {
    throw new WebLoomError(code, errorMessage(error), "validate", { capabilityId: capability.id });
  }
}

function safeDisposeResource(result: unknown): LifecycleDisposeResult {
  if (result && typeof result === "object" && "state" in result) return result as LifecycleDisposeResult;
  return { scopeId: "unknown", state: "stopped", attempted: 0, released: 0, pending: [], errors: [], cleanupIncomplete: false };
}

/** 创建 v4 Host。 */
export function createPluginHost(options: CreatePluginHostOptions = {}): PluginHost {
  // Keep the caller's Runtime choice separate from the public default used by
  // the small single-runtime convenience path.  An explicitly described
  // single Worker unit must still be selectable when advanced assembly did
  // not pass `runtime`; silently filtering it as a Window unit is unsafe.
  const configuredRuntime = options.runtime;
  const runtimeKind = configuredRuntime ?? "window-main";
  const runtimeId = options.runtimeId ?? `${runtimeKind}:runtime`;
  const runtimeInstanceId = options.runtimeInstanceId ?? makeId(runtimeId);
  // 槽位 → bridge。同一个 Window 可以并存多个 Worker：新增槽位不撤销已有槽位
  // （PSM-R12）。DEFAULT_RUNTIME_SLOT 保留旧单连接的默认行为。
  const DEFAULT_RUNTIME_SLOT = "default";
  const bridges = new Map<string, { readonly bridge: CapabilityBridge; readonly slotId: string; readonly generation: number; readonly unsubscribe?: () => void }>();
  /** 槽位连接世代：同槽位被替换后，旧连接的卸载不再生效。 */
  const slotGenerations = new Map<string, number>();
  if (options.capabilityBridge) bridges.set(DEFAULT_RUNTIME_SLOT, { bridge: options.capabilityBridge, slotId: DEFAULT_RUNTIME_SLOT, generation: 1 });
  /** 单元依赖的 sourceSlot → 槽位 id（装配层写入）。 */
  const unitSlotBindings = new Map<string, string>(Object.entries(options.runtimeSlotBindings ?? {}));
  /** 本 Runtime 内以私有方式实现的能力契约身份；公共解析路径一律拒绝。 */
  const privateCapabilityKeys = new Set<string>();
  /** 私有 handler：契约身份 → 所属运行单元的注册（不进公共服务目录）。 */
  const privateHandlers = new Map<string, { readonly pluginId: string; readonly unitId: string; readonly handler: (value: unknown, context: HandlerCallContext) => unknown; readonly reference: ServiceReference; readonly scope?: LifecycleScope }>();
  /** 私有能力目录：`pluginId\u0000unitId\u0000capabilityKey` → 契约对象。 */
  /** 装配层私有授权配置（静态）：调用单元 → 机密 + 契约。撤销不会删它。 */
  const privateGrantConfigs = new Map<string, { readonly pluginId: string; readonly unitId: string; readonly capability: Capability; readonly grantId: string }>();
  for (const entry of options.privateCapabilities ?? []) {
    privateGrantConfigs.set(`${entry.pluginId}\u0000${entry.unitId}\u0000${capabilityKey(entry.capability)}`, {
      pluginId: entry.pluginId,
      unitId: entry.unitId,
      capability: entry.capability,
      grantId: entry.grantId,
    });
  }
  /** 当前存活的实例授权记录：实例启动签发、撤销删除、重建重新签发。 */
  const privateGrantRecords = new Map<string, { readonly pluginId: string; readonly unitId: string; readonly capability: Capability; readonly secret: string; readonly instanceId: string; readonly scope: LifecycleScope }>();
  const issuePrivateGrants = (pluginId: string, unitId: string, instanceId: string, scope: LifecycleScope): void => {
    for (const [key, config] of privateGrantConfigs) {
      if (config.pluginId !== pluginId || config.unitId !== unitId) continue;
      // 同一契约在同一实例上重新签发时覆盖旧记录（重建场景）。
      privateGrantRecords.set(key, { ...config, secret: config.grantId, instanceId, scope });
    }
  };
  const revokePrivateGrants = (pluginId: string, unitId: string): void => {
    for (const [key, record] of [...privateGrantRecords]) {
      if (record.pluginId !== pluginId || record.unitId !== unitId) continue;
      privateGrantRecords.delete(key);
    }
  };
  /**
   * 私有授权查询（PSM-R13）。
   *
   * 机密不进入服务目录，普通 RuntimeHandle 既读不到也无法重放；授权记录按
   * `pluginId + unitId` 精确定位调用实例，不按契约取第一条，也不做交叉匹配。
   */
  /**
   * 私有授权候选记录（PSM-R13）。
   *
   * 每条记录把「装配层机密」与「一个具体实例」绑定在一起：`{pluginId, unitId, secret,
   * instanceId}`。机密与实例必须来自**同一条**可信记录：不能把"全部机密"与"全部存活实例"
   * 交叉匹配，否则 A 单元的机密配上 B 单元的实例也会通过。
   */
  const privateGrantCandidates = (
    capability: Capability,
    remoteUnits: readonly { readonly pluginId: string; readonly unitId: string; readonly instanceId?: string; readonly state: string }[],
  ): readonly { readonly pluginId: string; readonly unitId: string; readonly secret: string; readonly instanceId: string }[] => {
    const wanted = capabilityKey(capability);
    const configs = [...privateGrantConfigs.values()].filter((config) => capabilityKey(config.capability) === wanted);
    if (configs.length === 0) return Object.freeze([]);
    const candidates: { pluginId: string; unitId: string; secret: string; instanceId: string }[] = [];
    for (const unit of remoteUnits) {
      // 实例必须仍然活着：撤销后它从对端快照消失，候选随之消失。
      if (unit.instanceId === undefined || (unit.state !== "enabled" && unit.state !== "starting")) continue;
      const config = configs.find((entry) => entry.pluginId === unit.pluginId && entry.unitId === unit.unitId);
      if (config === undefined) continue;
      candidates.push({ pluginId: unit.pluginId, unitId: unit.unitId, secret: config.grantId, instanceId: unit.instanceId });
    }
    return Object.freeze(candidates);
  };

  let versionCounter = 0;
  let disposed = false;
  let disposePromise: Promise<LifecycleDisposeResult> | undefined;
  const listeners = new Set<HostListener>();
  const known = new Map<string, PluginManifest>();
  const records = new Map<string, PluginRecord>();
  // instanceId -> 当前记录。Scope 生成的 instanceId 才是资源 owner 的真实
  // 身份；records 以 pluginId 为键，无法用于按实例解析 owner。
  const instances = new Map<string, PluginRecord>();
  const stateCache = new Map<string, { signature: string; state: PluginState }>();
  const publicClients = new Map<string, CapabilityClient<Capability>>();
  const starting = new Map<string, Promise<void>>();
  const stopping = new Map<string, Promise<void>>();
  let start: (pluginId: string) => Promise<void>;

  const bump = (): void => {
    versionCounter += 1;
    for (const listener of [...listeners]) {
      try { listener({ version: versionCounter }); } catch { /* observers isolated */ }
    }
  };
  /**
   * consumer 变更通知与 Host 版本共用同一份状态；这里只是把 Host 的 bump
   * 事件投影成 consumer 的订阅回调，不复制任何 Host 快照。
   */
  const subscribeChange = (listener: () => void): () => void => {
    const entry: HostListener = () => {
      try { listener(); } catch { /* 观察者不能改变生命周期状态。 */ }
    };
    listeners.add(entry);
    return () => { listeners.delete(entry); };
  };
  const rootScope = createLifecycleScope({ kind: "root", metadata: { attributes: Object.freeze({ ...(options.rootAttributes ?? {}), runtimeId, runtimeInstanceId }) }, onChange: bump });
  const messageBus = options.messageBus ?? createMessageBus();
  const resourceRegistry = options.resourceRegistry ?? createResourceRegistry();
  const revokedErrorFor = (instanceId: string): Error => new LifecycleScopeRevokedError(`Plugin instance "${instanceId}" is no longer active`);
  /** 读取资源定义实际登记的 owner；底层 registry 不支持时返回 undefined。 */
  const ownedResourceOwner = (registry: ResourceRegistry, definitionId: string): string | undefined => {
    const owner = (registry as ResourceRegistry & { _ownerOf?(id: string): string | undefined })._ownerOf;
    return typeof owner === "function" ? owner.call(registry, definitionId) : undefined;
  };
  const capabilities = createCapabilityRegistry();
  const unownedResourceResolver = options.resourceCapabilityResolver ?? (() => undefined);
  /**
   * 内置资源注册表的契约身份键。
   *
   * 必须按 kind/id/version 判断，不能用对象引用相等：插件可以自己再
   * `defineCapability()` 出同一个 kind/id/version 的等价契约，引用比较会让它拿到
   * 共享的裸注册表，从而绕过实例包装（owner 写成 unowned、跨实例注销限制失效）。
   */
  const resourceRegistryKey = capabilityKey(capabilityDescriptor(RESOURCE_REGISTRY));
  /**
   * 资源能力解析必须落到“定义该资源的实例”上（PCB-R05）。
   * 查找 owner 失败、owner 已撤销或 ownerId 为空但没有装配层兜底时一律拒绝，
   * 绝不退回裸全局注册表。
   */
  const resolveResourceCapability = <C extends Capability>(ownerId: string, capability: C, optional: boolean): CapabilityClient<C> | undefined => {
    if (!ownerId || ownerId === UNOWNED_RESOURCE_OWNER) {
      // 宿主登记的资源走装配层显式提供的 resolver；这是一条独立且可信的
      // 路径，与插件实例身份无关，绝不因为插件 owner 查找失败而降级到这里。
      const descriptor = capabilityDescriptor(capability);
      // 传完整 typed capability，装配层因此能同时核对 kind 与 version；
      // 宿主资源与插件实例资源是两条独立路径，不共享判定规则。
      const provided = unownedResourceResolver(capability);
      if (provided !== undefined) return provided as CapabilityClient<C>;
      if (optional) return undefined;
      throw new WebLoomError("capability_unavailable", `Host-owned resource cannot resolve capability "${descriptor.id}" without an assembly resolver`, "validate", { capabilityId: capability.id });
    }
    const owner = instances.get(ownerId);
    const consumer = owner?.consumer;
    if (!owner || !consumer) {
      if (optional) return undefined;
      throw new WebLoomError("capability_unavailable", `Resource owner "${ownerId}" is not available`, "validate", { capabilityId: capability.id });
    }
    // 内置资源注册表是 Host 提供的 local 能力，但插件拿到的必须是绑定当前
    // 实例的视图，而不是共享的裸注册表。这里同样按契约身份判断，等价的重新
    // 定义也必须被包装。
    if (capabilityKey(capabilityDescriptor(capability)) === resourceRegistryKey) return instanceResourceRegistry(ownerId, () => { if (!instances.get(ownerId)?.consumer) throw revokedErrorFor(ownerId); }) as CapabilityClient<C>;
    // optional 必须走 optional 读取：已声明但当前缺席的资源上下文拿到 undefined，
    // 而不是被当成必需依赖抛错、把资源推进 error 状态。
    return (optional ? consumer.optionalCapability(capability) : consumer.capability(capability)) as CapabilityClient<C>;
  };
  // 内置资源注册表能力同样要先过声明核对（capability()），再包装成绑定当前
  // 实例的视图；不因为它是 Host 内置能力就跳过检查。每个实例拿到的是各自
  // 的视图，因此 register 写入的 owner 一定是当前实例的真实 instanceId。
  const resourceRegistryViews = new Map<string, ResourceRegistry>();
  // instanceId -> 该实例通过实例视图登记过的定义 id。实例撤销时按这张表
  // 做 owner 条件注销，不扫描全局注册表，也不误删同名新实例的定义。
  const resourceDefinitionsByInstance = new Map<string, Set<string>>();
  // Host 自己（装配层）持有裸注册表视图；插件只能通过 consumer 拿到实例视图。
  capabilities.provide(RESOURCE_REGISTRY, resourceRegistry, "host", rootScope);
  const instanceResourceRegistry = (instanceId: string, assertActive: () => void): ResourceRegistry => {
    const existing = resourceRegistryViews.get(instanceId);
    if (existing) return existing;
    const registered = resourceDefinitionsByInstance.get(instanceId) ?? new Set<string>();
    resourceDefinitionsByInstance.set(instanceId, registered);
    const view = createInstanceResourceRegistry({
      registry: resourceRegistry,
      instanceId,
      assertActive,
      registerOwned: (ownerId, definition) => {
        registerOwnedResource(resourceRegistry, ownerId, definition);
        registered.add(definition.id);
      },
      isOwnedBy: (definitionId, ownerId) => ownedResourceOwner(resourceRegistry, definitionId) === ownerId,
      ownerOf: (definitionId) => ownedResourceOwner(resourceRegistry, definitionId),
      ownedDefinitionIds: () => [...registered],
    });
    resourceRegistryViews.set(instanceId, view);
    return view;
  };
  const taskScheduler = createScopedTaskScheduler(rootScope);
  const resourceStore = createResourceStore(resourceRegistry, resolveResourceCapability, (ownerId) => {
    const instance = ownerId ? instances.get(ownerId)?.scope : undefined;
    return instance?.identity.attributes ?? rootScope.identity.attributes;
  }, (ownerId) => {
    // 宿主资源没有插件 owner，不受实例撤销影响。
    if (!ownerId || ownerId === UNOWNED_RESOURCE_OWNER) return;
    const owner = instances.get(ownerId);
    // owner 查不到（已撤销、已停止或查找失败）一律拒绝：不能因为失去
    // owner 就把插件资源降级成宿主资源继续解析。
    if (!owner?.consumer || owner.scope?.state !== "active" || owner.instanceId !== ownerId || owner.stopRequested) {
      throw revokedErrorFor(ownerId);
    }
  });

  const addHostCapabilities = (source: CreatePluginHostOptions["capabilities"]): void => {
    if (!source) return;
    let entries: readonly HostCapabilityRegistration[];
    if (Array.isArray(source)) entries = source as readonly HostCapabilityRegistration[];
    else {
      const map = source as ReadonlyMap<LocalCapability<unknown>, unknown>;
      entries = [...map.entries()].map(([capability, value]) => ({ capability, value }));
    }
    for (const item of entries) capabilities.provide(item.capability, item.value, "host", rootScope);
  };
  addHostCapabilities(options.capabilities);
  addHostCapabilities(options.builtinCapabilities);

  const manifestUnit = (manifest: PluginManifest): (RuntimeUnitDescriptor & { id: string; runtime: RuntimeKind }) | undefined => selectRuntimeUnit(manifest, configuredRuntime);
  const definitionList = (pluginId: string, unitId: string): readonly Capability[] => {
    const fromRegistry = options.runtimeUnitImplementationRegistry?.getCapabilities?.(pluginId, unitId);
    if (fromRegistry) return fromRegistry;
    return options.capabilityDefinitions?.get(implementationKey(pluginId, unitId)) ?? [];
  };
  const capabilityFor = (record: PluginRecord, descriptor: CapabilityDescriptor): Capability | undefined => definitionList(record.manifest.id, record.unitId ?? descriptor.id).find((capability) => capabilityKey(capability) === capabilityKey(descriptor));

  const graph = (): PluginGraph => buildPluginGraph([...known.values()], { runtime: configuredRuntime, runningPluginIds: runningPluginIds(), externalRuntimeDependencies: options.externalRuntimeDependencies, builtinCapabilities: new Set(capabilities.descriptors()) });
  /**
   * 当前正在运行的插件集合。
   *
   * 这只是依赖图诊断的“运行中”事实，来源是实例状态而不是任何用户启停意图。
   */
  const runningPluginIds = (): ReadonlySet<string> => {
    const ids = new Set<string>();
    for (const [pluginId, record] of records) if (record.state === "enabled" || record.state === "starting") ids.add(pluginId);
    return ids;
  };

  const unavailableReason = (manifest: PluginManifest): string | undefined => {
    const unit = manifestUnit(manifest);
    if (!unit) return manifest.units && manifest.units.length > 0 ? "runtime_unit_ambiguous" : undefined;
    return options.runtimeUnitAvailability?.({ pluginId: manifest.id, unitId: unit.id, runtime: unit.runtime });
  };

  const validateManifest = (manifest: PluginManifest): void => {
    if (!manifest || typeof manifest.id !== "string" || manifest.id.trim() === "") throw new TypeError("Plugin id must be a non-empty string");
    if ((manifest.units?.length ?? 0) > 1 && configuredRuntime === undefined) {
      throw new Error(`Plugin "${manifest.id}" execution must be explicit for multi-unit manifests`);
    }
    options.manifestValidator?.(manifest);
    validatePluginGraph([manifest], { runtime: configuredRuntime, allowMissingDependencies: true });
  };

  const missingDependencies = (manifest: PluginManifest): readonly CapabilityDescriptor[] => {
    const unit = manifestUnit(manifest);
    if (!unit) return [];
    const localRuntime = unit.runtime;
    const current = graph();
    return (unit.dependencies ?? []).filter((dependency) => dependency.source !== "peer").filter((dependency) => {
      if (dependency.optional) return false;
      const capability = dependency.capability as Capability;
      // 先确定声明来源与槽位，再检查对应提供者（PSM-R12）：就绪判断与实际解析共用同一
      // 条规则，本地同名服务不能顶替"声明来自 Worker/绑定槽位"的依赖。
      const boundSlot = unitSlotBindings.get(`${manifest.id}\u0000${unit.id}\u0000${capabilityKey(capability)}`)
        ?? unitSlotBindings.get(`${manifest.id}\u0000${unit.id}`);
      const declaredRemote = dependency.sourceRuntime !== undefined && dependency.sourceRuntime !== localRuntime;
      const wantsSlot = boundSlot !== undefined;
      // 声明与绑定冲突（声明同 realm 却绑定远端槽位）：启动前就拒绝，不能让消费者先跑起来
      // 再在解析时失败——就绪判断与解析必须给出同一个结论（PSM-R12）。
      if (wantsSlot && !declaredRemote) return true;
      if (declaredRemote || wantsSlot) {
        // 远端来源或显式绑定槽位：只能由该槽位上真实发布的服务满足；私有服务不算。
        const remote = capability.kind === "rpc" || capability.kind === "stream";
        if (remote && endpointFor(capability as RemoteCapability, wantsSlot ? boundSlot : undefined) !== undefined) return false;
        // 同 Host 的提供者只在依赖没有声明远端来源时才算数。
        return true;
      }
      if (capabilities.has(capability)) return false;
      if ((current.providers[capabilityKey(capability)]?.length ?? 0) > 0) {
        const provider = current.providers[capabilityKey(capability)]?.[0];
        // 提供者必须在运行才算依赖满足；这来自实例状态，不来自任何启停配置。
        return provider === undefined || !runningPluginIds().has(provider);
      }
      // externalRuntimeDependencies 只放宽静态装配校验（validatePluginGraph）；
      // 运行时就绪必须由真实端点或同 Host 提供者满足，否则没有连接也会启动。
      return true;
    }).map((dependency) => dependency.capability);
  };

  const createUnavailableRemoteClient = <C extends RemoteCapability>(capability: C, scope: LifecycleScope): CapabilityClient<C> => {
    if (capability.kind === "rpc") return {
      call(request: unknown, _options?: RpcCallOptions) {
        scope.assertActive();
        void request;
        return Promise.reject(new WebLoomError("capability_unavailable", `Capability "${capability.id}" is unavailable in the remote Runtime`, "wait", { capabilityId: capability.id }));
      },
    } as CapabilityClient<C>;
    return {
      subscribe(request: unknown, _options?: StreamSubscribeOptions<unknown>) {
        scope.assertActive();
        void request;
        return rejectedStreamSubscription(new WebLoomError("capability_unavailable", `Capability "${capability.id}" is unavailable in the remote Runtime`, "wait", { capabilityId: capability.id }));
      },
    } as CapabilityClient<C>;
  };

  const getRemoteClient = <C extends RemoteCapability>(capability: C, scope: LifecycleScope, forceRemote = false, slotId?: string): CapabilityClient<C> => {
    if (!forceRemote && capabilities.has(capability)) {
      if (capability.kind === "rpc") return createLocalRpcClient(capability, scope) as unknown as CapabilityClient<C>;
      return createLocalStreamClient(capability, scope) as unknown as CapabilityClient<C>;
    }
    // 槽位绑定优先：先找调用方要求的槽位，再退到其他已连接槽位（唯一命中时）。
    const endpoint = endpointFor(capability, slotId);
    if (endpoint) return endpoint.bridge.getClient(capability, scope) as CapabilityClient<C>;
    if (forceRemote) return createUnavailableRemoteClient(capability, scope);
    if (capability.kind === "rpc") return createLocalRpcClient(capability, scope) as unknown as CapabilityClient<C>;
    return createLocalStreamClient(capability, scope) as unknown as CapabilityClient<C>;
  };
  /** 槽位内是否发布了该服务。 */
  /**
   * 选择服务来源端点。
   *
   * 绑定顺序：调用方要求的槽位 → 其余槽位中唯一发布者。绝不按挂接顺序取第一个，也不在
   * 多个槽位同时发布时静默选择；那种情况要求装配层明确绑定。
   */
  const endpointFor = (capability: RemoteCapability, slotId?: string, options: { readonly allowPrivate?: boolean } = {}): { readonly bridge: CapabilityBridge; readonly slotId: string } | undefined => {
    // 私有服务只在私有入口里可见；公共解析路径必须跳过它。
    const matches = (entry: { readonly bridge: CapabilityBridge; readonly slotId: string }): boolean =>
      entry.bridge.services().some((service) => service.kind === capability.kind && service.capabilityId === capability.id && service.contractVersion === capability.version && (options.allowPrivate === true || service.attributes?.private !== true));
    if (slotId !== undefined) {
      const bound = bridges.get(slotId);
      return bound && matches(bound) ? bound : undefined;
    }
    const candidates = [...bridges.values()].filter(matches);
    return candidates.length === 1 ? candidates[0] : undefined;
  };

  /** 本地服务绑定：服务实例世代 + 在途工作集合。 */
  interface LocalServiceBinding {
    /** 解析当下的服务实例身份；未绑定时为 undefined。 */
    readonly serviceInstanceId?: string;
    /** 在途调用/流的取消回调；提供者撤销时全部以 service_revoked 结束。 */
    readonly inFlight: Set<(error: unknown) => void>;
  }

  /**
   * 绑定本地 handler 的服务实例身份。
   *
   * 客户端句柄必须绑定到“解析当下”的提供者服务实例：可选提供者被释放并重建后，
   * 旧句柄不能自动改用第二代实现，而是永久失败；重新解析才会得到新句柄。
   */
  const bindLocalService = <C extends RpcCapabilityBase | StreamCapabilityBase>(capability: C): LocalServiceBinding => {
    const entry = capabilities.registration(capability);
    const binding: LocalServiceBinding = { serviceInstanceId: entry?.reference.serviceInstanceId, inFlight: new Set() };
    // 在途调用/流绑定提供者有效期：提供者撤销时立即取消并拒绝迟到结果，而不是让它
    // 继续返回第一代的数据。
    entry?.scope?.onRevoke(() => {
      const error = new WebLoomError("service_revoked", `Capability "${capability.id}" was revoked by its provider`, "dispose", {
        capabilityId: capability.id,
        ...(entry?.reference.serviceInstanceId !== undefined ? { serviceInstanceId: entry.reference.serviceInstanceId } : {}),
      });
      for (const abort of [...binding.inFlight]) { try { abort(error); } catch { /* 取消继续 */ } }
      binding.inFlight.clear();
    });
    return binding;
  };
  /** 复核当前注册是否仍是同一个服务实例世代。 */
  const assertLocalService = <C extends RpcCapabilityBase | StreamCapabilityBase>(
    capability: C,
    bound: LocalServiceBinding,
  ): CapabilityRegistration => {
    const entry = capabilities.registration(capability);
    // 提供者被释放：句柄立即失效，不允许静默切到新实例。
    if (!entry || entry.capability.kind !== capability.kind) {
      throw new WebLoomError("service_revoked", `Capability "${capability.id}" is no longer provided`, "dispatch", { capabilityId: capability.id });
    }
    if (bound.serviceInstanceId !== undefined && entry.reference.serviceInstanceId !== bound.serviceInstanceId) {
      throw new WebLoomError("service_stale", `Capability "${capability.id}" was re-provided after this handle was created`, "dispatch", {
        capabilityId: capability.id,
        serviceInstanceId: bound.serviceInstanceId,
      });
    }
    return entry;
  };

  const createLocalRpcClient = <C extends RpcCapabilityBase>(capability: C, scope: LifecycleScope): CapabilityClient<C> => {
    // 句柄绑定解析当下的服务实例；调用时复核，不跟随提供者重建。
    const bound = bindLocalService(capability);
    const client: { call(request: unknown, callOptions?: RpcCallOptions): Promise<unknown> } = {
      call(request, callOptions = {}) {
        scope.assertActive();
        const timeoutMs = assertTimeout(callOptions.timeoutMs);
        const timeoutController = new AbortController();
        const merged = mergeSignals(timeoutController.signal, scope.signal, callOptions.signal);
        const deadlineAt = Date.now() + timeoutMs;
        return new Promise<unknown>((resolve, reject) => {
          let settled = false;
          let timedOut = false;
          let timer: ReturnType<typeof setTimeout> | undefined;
          // 在途登记：提供者撤销时立即以 service_revoked 结束，不等 handler 返回。
          const abortInFlight = (error: unknown): void => finish(error);
          bound.inFlight.add(abortInFlight);
          const finish = (error?: unknown, value?: unknown): void => {
            if (settled) return;
            settled = true;
            bound.inFlight.delete(abortInFlight);
            if (timer !== undefined) clearTimeout(timer);
            merged.dispose();
            if (error !== undefined) reject(error); else resolve(value);
          };
          let entry: CapabilityRegistration;
          try { entry = assertLocalService(capability, bound); }
          catch (error) { finish(error instanceof WebLoomError ? error : new WebLoomError("service_stale", errorMessage(error), "dispatch", { capabilityId: capability.id })); return; }
          if (entry.capability.kind !== "rpc") {
            finish(new WebLoomError("capability_unavailable", `Capability "${capability.id}" is not available`, "wait", { capabilityId: capability.id }));
            return;
          }
          const rpc = capability as C & { readonly response: { parse(value: unknown): unknown } };
          const context: HandlerCallContext = {
            signal: merged.signal,
            deadlineAt,
            ...(callOptions.operationId !== undefined ? { operationId: callOptions.operationId } : {}),
            reference: entry.reference,
            origin: "local",
          };
          timer = setTimeout(() => {
            timedOut = true;
            try { timeoutController.abort(new WebLoomError("call_timeout", "Capability call timed out", "execute")); } catch { timeoutController.abort(); }
            finish(new WebLoomError("call_timeout", "Capability call timed out", "execute", { capabilityId: capability.id, serviceInstanceId: entry.reference.serviceInstanceId }));
          }, timeoutMs);
          const onAbort = (): void => { if (!timedOut) finish(new WebLoomError("request_cancelled", "Capability call was cancelled", "dispose", { capabilityId: capability.id })); };
          merged.signal.addEventListener("abort", onAbort, { once: true });
          if (merged.signal.aborted) { onAbort(); return; }
          let invoke: unknown | Promise<unknown>;
          try { invoke = invokeCapabilityHandler(entry, request, context); }
          catch (error) { finish(error instanceof WebLoomError ? error : new WebLoomError("handler_failed", errorMessage(error), "execute", { capabilityId: capability.id })); return; }
          Promise.resolve(invoke).then((value) => {
            if (settled) return;
            try { finish(undefined, rpc.response.parse(value)); }
            catch (error) { finish(new WebLoomError("response_validation_failed", errorMessage(error), "receive", { capabilityId: capability.id })); }
          }, (error) => finish(error instanceof WebLoomError ? error : new WebLoomError("handler_failed", errorMessage(error), "execute", { capabilityId: capability.id })));
        });
      },
    };
    return client as unknown as CapabilityClient<C>;
  };

  const createLocalStreamClient = <C extends StreamCapabilityBase>(capability: C, scope: LifecycleScope): CapabilityClient<C> => {
    const bound = bindLocalService(capability);
    const client = {
      subscribe(request: unknown, subscribeOptions: StreamSubscribeOptions<unknown>): StreamSubscription<unknown> {
        scope.assertActive();
        // 在途登记：提供者撤销时立即结束这条流，不等生产者返回。
        const abortInFlight = (error: unknown): void => terminate(error instanceof WebLoomError ? error : new WebLoomError("service_revoked", errorMessage(error), "dispose", { capabilityId: capability.id }));
        bound.inFlight.add(abortInFlight);
        const timeoutMs = assertTimeout(subscribeOptions.timeoutMs);
        const timeoutController = new AbortController();
        const merged = mergeSignals(timeoutController.signal, scope.signal, subscribeOptions.signal);
        let cancelled = false;
        let timedOut = false;
        let iterator: AsyncIterator<unknown> | undefined;
        let readyTimer: ReturnType<typeof setTimeout> | undefined;
        let iteratorReturnStarted = false;
        let readySettled = false;
        let closedSettled = false;
        let resolveReady!: () => void;
        let rejectReady!: (error: unknown) => void;
        let resolveClosed!: () => void;
        let rejectClosed!: (error: unknown) => void;
        const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
        const closed = new Promise<void>((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject; });
        void ready.catch(() => undefined);
        void closed.catch(() => undefined);
        const settleReadyResolve = (): void => { if (!readySettled) { readySettled = true; resolveReady(); } };
        const settleReadyReject = (error: unknown): void => { if (!readySettled) { readySettled = true; rejectReady(error); } };
        const settleClosedResolve = (): void => { if (!closedSettled) { closedSettled = true; resolveClosed(); } };
        const settleClosedReject = (error: unknown): void => { if (!closedSettled) { closedSettled = true; rejectClosed(error); } };
        const closeIterator = (late?: AsyncIterator<unknown>): void => {
          const current = iterator ?? late;
          if (!current || iteratorReturnStarted) return;
          const close = current.return;
          if (!close) { iteratorReturnStarted = true; return; }
          iteratorReturnStarted = true;
          try { void Promise.resolve(close.call(current)).catch(() => undefined); } catch { /* iterator cleanup is best effort */ }
        };
        const terminate = (error: WebLoomError): void => {
          if (cancelled) return;
          cancelled = true;
          bound.inFlight.delete(abortInFlight);
          if (readyTimer !== undefined) clearTimeout(readyTimer);
          closeIterator();
          merged.dispose();
          settleReadyReject(error);
          settleClosedReject(error);
        };
        const cancel = (reason = "stream cancelled"): void => {
          const error = timedOut
            ? new WebLoomError("call_timeout", "Stream subscription timed out while opening", "wait", { capabilityId: capability.id })
            : new WebLoomError("request_cancelled", "Stream subscription was cancelled", "dispose", { capabilityId: capability.id });
          terminate(error);
          void reason;
        };
        merged.signal.addEventListener("abort", () => cancel("stream cancelled"), { once: true });
        const start = async (): Promise<void> => {
          try {
            // 订阅句柄同样绑定服务实例世代：提供者重建后旧订阅不会切到新实现。
            const entry = assertLocalService(capability, bound);
            if (entry.capability.kind !== "stream") throw new WebLoomError("capability_unavailable", `Capability "${capability.id}" is not available`, "wait", { capabilityId: capability.id });
            const stream = capability as C & { readonly item: { parse(value: unknown): unknown } };
            const context: HandlerCallContext = { signal: merged.signal, deadlineAt: Date.now() + timeoutMs, reference: entry.reference, origin: "local" };
            readyTimer = setTimeout(() => {
              if (cancelled || readySettled) return;
              timedOut = true;
              try { timeoutController.abort(new WebLoomError("call_timeout", "Stream subscription timed out while opening", "wait")); } catch { timeoutController.abort(); }
              terminate(new WebLoomError("call_timeout", "Stream subscription timed out while opening", "wait", { capabilityId: capability.id }));
            }, timeoutMs);
            const iterable = await capabilities.openStream(capability, request, context);
            if (cancelled) {
              try { closeIterator(iterable[Symbol.asyncIterator]()); } catch { /* invalid late iterator */ }
              return;
            }
            iterator = iterable[Symbol.asyncIterator]();
            if (readyTimer !== undefined) clearTimeout(readyTimer);
            settleReadyResolve();
            while (!cancelled) {
              const next = await iterator.next();
              // 提供者撤销后到达的 item 不再发布。
              if (cancelled) break;
              if (next.done) { cancelled = true; bound.inFlight.delete(abortInFlight); settleClosedResolve(); break; }
              if (cancelled) break;
              try {
                const item = stream.item.parse(next.value);
                await subscribeOptions.onNext(item);
              } catch {
                terminate(new WebLoomError("handler_failed", "Local stream consumer failed", "execute", { capabilityId: capability.id }));
                break;
              }
            }
          } catch (error) {
            if (!cancelled) {
              const wrapped = error instanceof WebLoomError ? error : new WebLoomError("handler_failed", "Local stream operation failed", "execute", { capabilityId: capability.id });
              terminate(wrapped);
            }
        } finally {
            merged.dispose();
          }
        };
        if (merged.signal.aborted) cancel("stream cancelled");
        else void start();
        return { ready, closed, cancel };
      },
    };
    return client as unknown as CapabilityClient<C>;
  };

  /**
   * Synchronously fence an instance.  The whole dependency cascade calls this
   * before any asynchronous cleanup starts; otherwise the first consumer that
   * finishes cleanup can observe a still-live provider and restart itself.
   */
  const beginStop = (record: PluginRecord, reason: string): boolean => {
    if (record.state !== "enabled" && record.state !== "starting" && record.state !== "blocked" && record.state !== "failed") return false;
    record.stopRequested = reason;
    record.state = "stopping";
    record.scope?.revoke(reason);
    for (const contribution of record.contributions) {
      try { contribution.revoke(); } catch { /* synchronous fencing continues */ }
    }
    for (const capability of record.provided) capabilities.revoke(capability, record.instanceId);
    for (const capability of record.privateProvided) capabilities.revoke(capability, record.instanceId);
    for (const capability of record.provided) publicClients.delete(capabilityKey(capability));
    bump();
    return true;
  };

  /**
   * 停止完成后的状态投影。
   *
   * 没有“用户禁用”状态：实例已释放的插件回到 registered（等待依赖图重建）或 blocked
   * （必需依赖/运行条件缺失），两者都由依赖和运行条件解释。
   */
  const projectStoppedState = (record: PluginRecord): void => {
    const missing = missingDependencies(record.manifest);
    const unavailable = unavailableReason(record.manifest);
    const reasons = [
      ...missing.map((item) => `missing:${item.kind}:${item.id}@${item.version}`),
      ...(unavailable ? [unavailable] : []),
      ...(record.condition ? [`revoked:${record.condition}`] : []),
    ];
    // 依赖缺失、运行条件不满足或已被显式释放时都是“等待”；否则回到待启动。
    record.state = reasons.length > 0 ? "blocked" : "registered";
    record.blockedBy = reasons.length > 0 ? [...new Set(reasons)] : undefined;
    record.error = undefined;
    bump();
  };

  const finishStop = async (record: PluginRecord, reason: string, preserveIntent: boolean): Promise<void> => {
    const scope = record.scope;
    const projectLateCleanup = (result?: LifecycleDisposeResult, error?: unknown): void => {
      if (result) record.cleanup = result;
      if (error !== undefined) {
        record.state = "cleanup-pending";
        record.error = errorMessage(error);
        bump();
        return;
      }
      if (!result || result.cleanupIncomplete || record.state !== "cleanup-pending") return;
      projectStoppedState(record);
    };
    // A cleanup-pending record has already relinquished its Scope.  Keep its
    // result intact until a later late-resource callback projects convergence;
    // disposing the Host must not turn that evidence into a false disabled
    // state.
    if (!scope && record.state === "cleanup-pending") return;
    const cleanup = scope
      ? await scope.dispose({
          reason,
          timeoutMs: options.lifecycleCleanupTimeoutMs,
          teardown: record.teardown,
          onLateSuccess: (_resourceId, result) => projectLateCleanup(result),
          onLateFailure: (_resourceId, error, result) => projectLateCleanup(result, error),
        })
      : undefined;
    if (cleanup) record.cleanup = cleanup;
    record.scope = undefined;
    // 旧 consumer 必须永久失效：同名插件重新启用会得到全新的 instanceId 与
    // consumer，beginStop 已让旧视图拒绝新的能力解析，这里只清掉 Host 引用。
    record.consumer = undefined;
    record.provided = [];
    record.teardown = undefined;
    record.instanceId = undefined;
    record.unitId = undefined;
    record.stopRequested = undefined;
    record.contributions = [];

    const hasTimeout = Boolean(cleanup?.pending.length && cleanup.errors.some((item) => item.code === "lifecycle.cleanup_timeout"));
    const cleanupError = cleanup?.errors.find((item) => item.code !== "lifecycle.cleanup_timeout");
    if (hasTimeout) {
      record.state = "cleanup-pending";
      record.error = cleanupError?.message ?? "Plugin cleanup is still pending";
    } else if (cleanupError || cleanup?.cleanupIncomplete) {
      record.state = "failed";
      record.error = cleanupError?.message ?? "Plugin cleanup did not complete";
    } else {
      projectStoppedState(record);
      // 计划销毁只是生命周期事件：被装配的插件在依赖重新可用时按拓扑顺序重建；
      // 被显式释放（运行条件）的插件保持等待，直到 retry 或条件解除。
      if (record.state === "registered" && !disposed) {
        queueMicrotask(() => { void start(record.manifest.id).catch(() => undefined); });
      }
    }
    // 该参数原本表示“保留用户启用意图”。新模型没有启停意图，停止原因已经完整
    // 记录在 scope 清理与诊断里，保留签名只为兼容既有调用点的显式意图声明。
    void preserveIntent;
    bump();
  };

  const stopAfterBegin = (record: PluginRecord, reason: string, preserveIntent: boolean): Promise<void> => {
    const existing = stopping.get(record.manifest.id);
    if (existing) return existing;
    if (record.state !== "stopping") return Promise.resolve();
    const startingTask = starting.get(record.manifest.id);
    const task = (startingTask ? startingTask.catch(() => undefined) : Promise.resolve())
      .then(() => finishStop(record, reason, preserveIntent))
      .finally(() => {
        if (stopping.get(record.manifest.id) === task) stopping.delete(record.manifest.id);
      });
    stopping.set(record.manifest.id, task);
    return task;
  };

  const stop = async (record: PluginRecord, reason: string, preserveIntent: boolean): Promise<void> => {
    const existing = stopping.get(record.manifest.id);
    if (existing) return existing;
    if (!beginStop(record, reason)) return;
    return stopAfterBegin(record, reason, preserveIntent);
  };

  const registerContribution = async (record: PluginRecord, unit: RuntimeUnitDescriptor & { id: string; runtime: RuntimeKind }, instanceId: string, scope: LifecycleScope, consumer: PluginConsumer, isInstanceActive: () => boolean): Promise<void> => {
    if (unit.contribution === undefined) return;
    for (const adapter of options.contributionAdapters ?? []) {
      // 身份一律取自 Host 的真实实例，不采信注册项自填的 owner 字段。
      const result = await adapter.register({ pluginId: record.manifest.id, unitId: unit.id, instanceId, scope, consumer, contribution: unit.contribution, manifest: record.manifest });
      if (!result) continue;
      // 异步注册期间实例可能已被撤销（并发 disable、adapter 内部 await）。
      // 此时不能把注册项挂进 record，否则旧实例会留下可挂载入口；改为立即
      // 回收适配器返回的句柄。回收要走完整收尾：revoke 与 dispose 都执行，
      // 只做其中一个会让适配器已经启动的资源（订阅、定时器、挂载点）泄漏。
      if (!isInstanceActive()) {
        const late: ContributionHandle = typeof result === "function" ? { revoke: result } : result;
        try { late.revoke?.(); } catch { /* 适配器清理互相隔离 */ }
        // scope 已经撤销，LifecycleScope.dispose 不再受理这个句柄的错误与
        // 超时边界；这里与 ContributionRuntime.dispose 的同步路径一致：保留
        // 拒绝给适配器自己的日志，不让它变成未处理的 Promise rejection。
        await Promise.resolve(late.dispose?.()).catch(() => undefined);
        continue;
      }
      const handle: ContributionHandle = typeof result === "function" ? { revoke: result } : result;
      let active = true;
      let disposePromise: Promise<void> | undefined;
      const runtime: ContributionRuntime = {
        get active() { return active; },
        revoke() { if (!active) return; active = false; handle.revoke?.(); },
        dispose() {
          if (disposePromise) return disposePromise;
          disposePromise = Promise.resolve(handle.dispose?.());
          // Scope disposal owns the rejection/timeout boundary; this catch is
          // only for the synchronous revoke path and never hides the result
          // from LifecycleScope.dispose().
          disposePromise.catch(() => undefined);
          return disposePromise;
        },
      };
      record.contributions.push(runtime);
      scope.onRevoke(() => runtime.revoke());
      scope.onDispose(() => runtime.dispose(), `contribution:${adapter.name ?? "anonymous"}`);
    }
  };

  /**
   * 启动一个运行单元。
   *
   * 必需依赖缺失或初始化失败不会让整个 Runtime 失败：插件进入 blocked/failed 并带上
   * 可诊断原因，服务可用性与实例生命周期分开表达。依赖恢复后 reconcile 按正向拓扑
   * 建立新实例；结构性错误（依赖环、提供者歧义、非法契约）仍在装配校验阶段拒绝。
   */
  const startImplementation = async (pluginId: string): Promise<void> => {
    const record = records.get(pluginId);
    if (!record) throw new Error(`Plugin "${pluginId}" is not registered`);
    if (record.state === "enabled") return;
    if (record.state === "starting") return;
    if (disposed) throw new LifecycleScopeRevokedError("Plugin host is disposed");
    const unit = manifestUnit(record.manifest);
    if (!unit) { record.state = "blocked"; record.blockedBy = ["runtime_unit_ambiguous"]; bump(); return; }
    const unavailable = options.runtimeUnitAvailability?.({ pluginId, unitId: unit.id, runtime: unit.runtime });
    const missing = missingDependencies(record.manifest);
    if (unavailable || missing.length > 0) {
      record.state = "blocked";
      record.blockedBy = [...(unavailable ? [unavailable] : []), ...missing.map((item) => `missing:${item.kind}:${item.id}@${item.version}`)];
      bump();
      return;
    }
    const parent = options.runtimeUnitParentScope?.({ pluginId, unitId: unit.id, runtime: unit.runtime, manifest: record.manifest }) ?? rootScope;
    const attributes = cloneFrozenAttributes(options.runtimeUnitAttributes?.({ pluginId, unitId: unit.id, runtime: unit.runtime, manifest: record.manifest }));
    const scope = parent.child("runtime-unit", { pluginId, attributes });
    // The Scope is the lifecycle identity authority.  Reuse its generated
    // instance id everywhere instead of maintaining a second, divergent id
    // for the permission lease and capability registrations.
    const instanceId = scope.identity.instanceId;
    const permissions = [...(unit.permissions ?? [])];
    const policy = options.permissionPolicy?.({ pluginId, unitId: unit.id, identity: scope.identity, requested: permissions });
    const lease = createPermissionLease({ identity: scope.identity, requested: permissions, approved: policy?.approved ?? permissions, sessionConstraints: policy?.sessionConstraints, scope, ...policy?.binding });
    const grantedPermissions = permissions.filter((permission) =>
      (policy?.approved ?? permissions).includes(permission)
      && (policy?.sessionConstraints === undefined || policy.sessionConstraints.includes(permission))
    );
    const definitions = definitionList(pluginId, unit.id);
    record.state = "starting";
    record.scope = scope;
    record.instanceId = instanceId;
    record.unitId = unit.id;
    record.error = undefined;
    record.blockedBy = undefined;
    record.provided = [];
    bump();
    const localCapabilities = definitions.filter((capability) => capability.kind === "local");
    const declaredProvides = unit.provides ?? [];
    const declaredDependencies = unit.dependencies ?? [];
    const isInstanceActive = (): boolean => scope.state === "active" && record.instanceId === instanceId && !record.stopRequested;
    // 该单元的远端依赖绑定到哪个槽位（装配层写入）。
    const slotFor = (capability: Capability): string | undefined => {
      const bound = unitSlotBindings.get(`${pluginId}\u0000${unit.id}\u0000${capabilityKey(capability)}`);
      return bound ?? unitSlotBindings.get(`${pluginId}\u0000${unit.id}`);
    };
    const revokedError = (): Error => new LifecycleScopeRevokedError(`Plugin instance "${pluginId}" is no longer active`);
    // 同 realm 客户端按契约身份缓存：重复解析返回同一引用（React 快照需要），
    // 但缓存不能替代可用性判定——每次解析仍然先核对提供方当前是否可用。
    // handler/服务在调用时才从 registry 取，因此提供方重启后同一 client 会自动
    // 指向新世代，不需要换掉缓存对象。
    const instanceClients = new Map<string, CapabilityClient<Capability>>();
    const resolveCapability = <C extends Capability>(capability: C, optional: boolean): CapabilityClient<C> | undefined => {
      // 有效性检查放在共享 resolver 的第一行，而不是只放在 consumer 外层：
      // ctx.capability/optionalCapability、consumer 与资源 owner 解析因此都受同
      // 一条约束——实例撤销后旧 setup ctx 不能继续取能力。
      if (!isInstanceActive()) throw revokedError();
      const descriptor = capabilityDescriptor(capability);
      const declared = [...declaredProvides, ...declaredDependencies.map((dependency) => dependency.capability)].some((item) => capabilityKey(item) === capabilityKey(descriptor));
      if (!declared) throw new WebLoomError("capability_unavailable", `Capability "${capability.id}" is not declared by plugin`, "validate", { capabilityId: capability.id });
      // 私有入口只能走 privateCapability：公共 provides/依赖路径拿不到它。
      if (privateCapabilityKeys.has(capabilityKey(descriptor))) {
        throw new WebLoomError("capability_unavailable", `Capability "${capability.id}" is a private entry and is only reachable through privateCapability`, "validate", { capabilityId: capability.id });
      }
      if (capability.kind === "local") {
        if (!capabilities.has(capability)) {
          if (optional) return undefined;
          throw new WebLoomError("capability_unavailable", `Capability "${capability.id}" is not available`, "wait", { capabilityId: capability.id });
        }
        // 内置资源注册表必须按当前实例包装；插件不能拿到共享的裸注册表，
        // 否则 owner 会写成空身份，加载上下文也就无从按实例解析。按契约身份
        // 判断，等价的重新定义同样会被包装。
        if (capabilityKey(descriptor) === resourceRegistryKey) return instanceResourceRegistry(instanceId, () => { if (!isInstanceActive()) throw revokedError(); }) as CapabilityClient<C>;
        return capabilities.get(capability) as CapabilityClient<C>;
      }
      const dependency = declaredDependencies.find((item) => capabilityKey(item.capability) === capabilityKey(descriptor));
      if (dependency?.source === "peer") {
        throw new WebLoomError("capability_unavailable", `Capability "${capability.id}" is only available through call.peer`, "dispatch", { capabilityId: capability.id });
      }
      const remote = dependency?.sourceRuntime !== undefined && dependency.sourceRuntime !== unit.runtime;
      const slotId = slotFor(capability);
      // 来源规则与 missingDependencies 完全一致（PSM-R12）：声明远端来源**或**显式绑定
      // 槽位时，只能由那个槽位上的服务满足；本地同名服务不能顶替。声明与绑定冲突
      // （声明同 realm 却绑定了远端槽位）时直接拒绝，而不是各选各的提供者。
      const slotBound = slotId !== undefined;
      if (!remote && slotBound) {
        throw new WebLoomError("capability_unavailable", `Capability "${capability.id}" is bound to Runtime slot "${slotId}" but declared as a same-realm dependency`, "validate", { capabilityId: capability.id });
      }
      const remoteOnly = remote || slotBound;
      const endpoint = remoteOnly && (capability.kind === "rpc" || capability.kind === "stream")
        ? endpointFor(capability as RemoteCapability, slotId)
        : undefined;
      if (optional && remoteOnly && !endpoint) return undefined;
      if (optional && !remoteOnly && !capabilities.has(capability)) return undefined;
      if (remoteOnly) {
        if (!endpoint) throw new WebLoomError("capability_unavailable", `Capability "${capability.id}" is not available on its bound Runtime slot`, "wait", { capabilityId: capability.id });
        return getRemoteClient(capability, scope, true, slotId) as unknown as CapabilityClient<C>;
      }
      // bridge 背书的客户端每次都重新取：bridge 自己按 (契约身份, scope) 缓存，
      // 并在代理被撤销后换新对象，因此每次解析都能看到提供方的当前世代。
      if (bridges.size > 0 && !capabilities.has(capability)) return getRemoteClient(capability, scope, false, slotId) as unknown as CapabilityClient<C>;
      // 同 realm handler：按“契约身份 + 当前服务实例世代”缓存客户端。可用期间重复解析
      // 引用稳定；提供者被释放并重建后世代变化，因此会签发绑定新实例的新句柄，而旧
      // 句柄永久停留在旧世代。
      const clientKey = `${capabilityKey(descriptor)}#${capabilities.registration(capability)?.reference.serviceInstanceId ?? "none"}`;
      const cachedClient = instanceClients.get(clientKey);
      if (cachedClient) return cachedClient as CapabilityClient<C>;
      const client = getRemoteClient(capability, scope, remote) as unknown as CapabilityClient<C>;
      instanceClients.set(clientKey, client);
      return client;
    };
    /**
     * 解析私有能力（PSM-R13）。
     *
     * 授权来自 Host 记录的真实实例身份与装配层签发的票据：只有被显式授予该契约的调用
     * 实例能解析。调用方不能自填所属标识，公共 consumer、服务目录与 Connect 名单都看不到
     * 私有入口。票据缺失时连解析本身都不允许。
     */
    const privateCapability = <C extends Capability>(capability: C): CapabilityClient<C> => {
      if (!isInstanceActive()) throw revokedError();
      const key = `${pluginId}\u0000${unit.id}\u0000${capabilityKey(capability)}`;
      const record = privateGrantRecords.get(key);
      if (!record) {
        throw new WebLoomError("capability_unavailable", `Private capability "${capability.id}" is not granted to unit "${pluginId}/${unit.id}"`, "dispatch", { capabilityId: capability.id });
      }
      // 同 realm：本 Runtime 内已用私有方式登记了它。复用已验证的 RPC/stream 客户端机制
      // ——句柄绑定提供者世代、每次调用复核有效性，提供者撤销时取消在途工作并拒绝迟到
      // 结果（PSM-R10/PSM-R13）。
      const localRegistration = capability.kind === "rpc" || capability.kind === "stream"
        ? capabilities.registration(capability as RemoteCapability)
        : undefined;
      if (localRegistration?.reference.attributes?.private === true) {
        if (localRegistration.scope?.state !== "active") {
          throw new WebLoomError("service_revoked", `Private capability "${capability.id}" was revoked by its unit`, "dispatch", { capabilityId: capability.id });
        }
        if (capability.kind === "rpc") return createLocalRpcClient(capability as RpcCapabilityBase, scope) as unknown as CapabilityClient<C>;
        if (capability.kind === "stream") return createLocalStreamClient(capability as StreamCapabilityBase, scope) as unknown as CapabilityClient<C>;
      }
      // 跨 realm：走所属单元绑定的槽位端点；每次调用都带上装配层签发的票据，
      // 接收端在执行 handler 之前核对（PSM-R13）。
      const slotId = slotFor(capability);
      if (capability.kind === "rpc" || capability.kind === "stream") {
        const endpoint = endpointFor(capability as RemoteCapability, slotId, { allowPrivate: true });
        if (!endpoint) throw new WebLoomError("capability_unavailable", `Private capability "${capability.id}" is not available on the bound Runtime slot`, "wait", { capabilityId: capability.id });
        const client = endpoint.bridge.getClient(capability as RemoteCapability, scope) as unknown as RpcClient<RpcCapabilityBase> & StreamClient<StreamCapabilityBase>;
        // 每次调用都重新核对本实例的授权记录并按当前连接推导票据：
        // 实例撤销后记录被回收，旧句柄立刻不能再发请求；连接被替换后票据随之变化。
        const liveGrant = (): string => {
          if (!isInstanceActive()) throw revokedError();
          const current = privateGrantRecords.get(key);
          if (current === undefined || current.instanceId !== record.instanceId) {
            throw new WebLoomError("service_revoked", `Private capability "${capability.id}" authorization was revoked with its instance`, "dispose", { capabilityId: capability.id });
          }
          return derivePrivateGrant(current.secret, endpoint.bridge.binding.connectionId, current.instanceId);
        };
        // 票据只在这一层附加，不写进服务目录，也不暴露给普通句柄。
        return (capability.kind === "rpc"
          ? { call: (request: unknown, callOptions?: RpcCallOptions) => client.call(request as never, { ...callOptions, grantId: liveGrant() }) }
          : { subscribe: (request: unknown, subscribeOptions: StreamSubscribeOptions<unknown>) => client.subscribe(request as never, { ...subscribeOptions, grantId: liveGrant() }) }
        ) as unknown as CapabilityClient<C>;
      }
      throw new WebLoomError("capability_unavailable", `Private capability "${capability.id}" is not available in this Runtime`, "dispatch", { capabilityId: capability.id });
    };
    // ctx.consumer、contribution adapter 和资源 owner 视图共用这一个对象，
    // 三条入口共享同一套声明核对与实例有效性判断。
    const consumer = createPluginConsumer({
      pluginId,
      unitId: unit.id,
      instanceId,
      resolveCapability,
      privateCapability,
      isActive: isInstanceActive,
      subscribeChanges(listener) {
        if (!isInstanceActive()) return () => undefined;
        return subscribeChange(listener);
      },
      revokedError,
    });
    record.consumer = consumer;
    // instanceId -> record 是资源 owner 解析的唯一索引；Scope 撤销后条目
    // 立即失效，旧 owner 的在途加载与缓存不会迁到同名新实例。
    instances.set(instanceId, record);
    scope.onRevoke(() => { instances.delete(instanceId); resourceRegistryViews.delete(instanceId); resourceStore.disposeOwner(instanceId); });
    // 资源定义本身也属于该实例：撤销时按 owner 条件注销。owner 不匹配时不
    // 删除，避免同名插件重新启用后新实例的同名定义被旧实例的清理误删。
    instanceResourceRegistry(instanceId, () => { if (!isInstanceActive()) throw revokedError(); });
    // 实例启动即签发本实例的私有授权；撤销时全部回收（纯消费单元同样适用）。
    issuePrivateGrants(pluginId, unit.id, instanceId, scope);
    scope.onRevoke(() => {
      for (const [key, entry] of [...privateHandlers]) {
        if (entry.pluginId !== pluginId || entry.unitId !== unit.id) continue;
        privateHandlers.delete(key);
      }
      revokePrivateGrants(pluginId, unit.id);
    });
    scope.onDispose(async () => {
      for (const definitionId of resourceDefinitionsByInstance.get(instanceId) ?? []) {
        unregisterOwnedResource(resourceRegistry, instanceId, definitionId);
      }
      resourceDefinitionsByInstance.delete(instanceId);
    }, "resource-definitions", "after-teardown");
    /**
     * 注册所属单元的私有 handler（PSM-R13）。
     *
     * 私有入口必须声明在单元的 `privateProvides`；它不进单元的公共 provides，因此不会
     * 出现在公共依赖或 Connect 自动导出名单里。为了跨 realm 可达，它仍会进入 Runtime
     * 快照，但带 `private` 标记：公共解析路径一律跳过，只有所属单元的私有入口能用。
     */
    const handlePrivate = <C extends RemoteCapability>(capability: C, handler: unknown): void => {
      if (scope.state !== "active") return;
      const descriptor = capabilityDescriptor(capability);
      const declaredPrivate = (unit.privateProvides ?? []).some((item) => capabilityKey(item) === capabilityKey(descriptor));
      if (!declaredPrivate) throw new Error(`Plugin "${pluginId}" cannot handle undeclared private capability "${descriptor.id}@${descriptor.version}"`);
      const key = `${pluginId}\u0000${unit.id}\u0000${capabilityKey(capability)}`;
      if (privateHandlers.has(key)) throw new Error(`Private capability "${descriptor.id}" is already handled by unit "${pluginId}/${unit.id}"`);
      const reference: ServiceReference = Object.freeze({
        kind: capability.kind,
        capabilityId: capability.id,
        contractVersion: capability.version,
        runtime: unit.runtime,
        runtimeInstanceId,
        serviceInstanceId: makeId(`private:${instanceId}:${capability.id}`),
        attributes: cloneFrozenAttributes({ ...attributes, private: true }),
      });
      const peerDependencies = declaredDependencies.filter((dependency) => dependency.source === "peer").map((dependency) => dependency.capability);
      if (capability.kind === "rpc") capabilities.handle(capability as RpcCapabilityBase, handler as unknown as RpcHandler<RpcCapabilityBase>, instanceId, scope, reference, peerDependencies);
      else capabilities.stream(capability as StreamCapabilityBase, handler as unknown as StreamHandler<StreamCapabilityBase>, instanceId, scope, reference, peerDependencies);
      privateHandlers.set(key, {
        pluginId,
        unitId: unit.id,
        handler: handler as (value: unknown, context: HandlerCallContext) => unknown,
        reference,
        scope,
      });
      record.privateProvided.push(capability);
      // 公共解析路径从此拒绝这个契约身份：只能通过私有入口使用。
      privateCapabilityKeys.add(capabilityKey(capability));
      bump();
    };
    const handle = <C extends RemoteCapability>(capability: C, handler: C extends RpcCapability<infer TRequest, infer TResponse> ? RpcHandler<RpcCapability<TRequest, TResponse>> : C extends StreamCapability<infer TRequest, infer TItem> ? StreamHandler<StreamCapability<TRequest, TItem>> : never): void => {
      if (scope.state !== "active") return;
      const descriptor = capabilityDescriptor(capability);
      if (!declaredProvides.some((item) => capabilityKey(item) === capabilityKey(descriptor))) throw new WebLoomError("capability_unavailable", `Plugin "${pluginId}" cannot handle undeclared capability`, "validate", { capabilityId: capability.id });
      const reference: ServiceReference = Object.freeze({ kind: capability.kind, capabilityId: capability.id, contractVersion: capability.version, runtime: unit.runtime, runtimeInstanceId, serviceInstanceId: makeId(`service:${instanceId}:${capability.id}`), attributes });
      const peerDependencies = declaredDependencies.filter((dependency) => dependency.source === "peer").map((dependency) => dependency.capability);
      if (capability.kind === "rpc") capabilities.handle(capability as RpcCapabilityBase, handler as unknown as RpcHandler<RpcCapabilityBase>, instanceId, scope, reference, peerDependencies);
      else capabilities.stream(capability as StreamCapabilityBase, handler as unknown as StreamHandler<StreamCapabilityBase>, instanceId, scope, reference, peerDependencies);
      record.provided.push(capability);
      bump();
    };
    const provide = <C extends LocalCapability<unknown>>(capability: C, value: LocalServiceOf<C>): void => {
      if (scope.state !== "active") return;
      const descriptor = capabilityDescriptor(capability);
      if (!declaredProvides.some((item) => capabilityKey(item) === capabilityKey(descriptor))) throw new WebLoomError("capability_unavailable", `Plugin "${pluginId}" cannot provide undeclared capability`, "validate", { capabilityId: capability.id });
      capabilities.provide(capability, value, instanceId, scope);
      record.provided.push(capability);
      bump();
    };
    const context: PluginContext = {
      pluginId,
      instanceId,
      unitId: unit.id,
      scope,
      consumer,
      signal: scope.signal,
      permissions: grantedPermissions,
      permissionLease: lease,
      taskScheduler,
      // Context extensions are realm-local host injection points. They may
      // intentionally contain live services (for example a logger or a
      // coordinator facade), so they are not wire attributes and must not be
      // forced through the DTO/structured-clone validator. The extension
      // callback remains the trust boundary; transport-visible attributes
      // continue to use cloneFrozenAttributes above and at exposure time.
      extension: options.contextExtension?.({ pluginId, unitId: unit.id, instanceId, scope, manifest: record.manifest }) ?? {},
      config: unit.config,
      onDispose(cleanup) { scope.onDispose(cleanup); },
      provide,
      handle,
      capability(capability) {
        return resolveCapability(capability, false) as never;
      },
      privateCapability: privateCapability as never,
      handlePrivate: handlePrivate as never,
      optionalCapability(capability) {
        return resolveCapability(capability, true) as never;
      },
      messageBus: createScopedMessageBus(messageBus, scope),
    };
    try {
      const setup = options.runtimeUnitImplementationRegistry?.get(pluginId, unit.id);
      if (!setup) throw new Error(`Runtime implementation is unavailable for ${pluginId}/${unit.id}`);
      const result = await (setup as PluginSetup)(context);
      record.teardown = typeof result === "function" ? result : undefined;
      await registerContribution(record, unit, instanceId, scope, consumer, isInstanceActive);
      // 声明了 provides 就必须真的注册：装配期不一致必须失败，运行期则记为失败状态。
      for (const descriptor of declaredProvides) {
        if (!record.provided.some((capability) => capabilityKey(capability) === capabilityKey(descriptor))) throw new Error(`Plugin "${pluginId}" did not register declared capability "${descriptor.id}@${descriptor.version}"`);
      }
      if (record.stopRequested || scope.state !== "active") {
        // The stop coordinator already fenced this generation.  Calling stop
        // here would await the current start task and deadlock; its pending
        // stop promise will perform the cleanup after this task returns.
        return;
      }
      record.state = "enabled";
      bump();
    } catch (error) {
      if (record.stopRequested || scope.state !== "active") {
        // A revoked generation is owned by stop(); setup errors from that
        // generation must never overwrite the newer lifecycle decision.
        return;
      }
      record.state = "failed";
      record.error = errorMessage(error);
      scope.revoke("plugin setup failed");
      for (const capability of record.provided) capabilities.revoke(capability, instanceId);
      for (const capability of record.privateProvided) capabilities.revoke(capability, instanceId);
      record.provided = [];
      record.privateProvided = [];
      record.cleanup = await scope.dispose({ reason: "plugin setup failed", timeoutMs: options.lifecycleCleanupTimeoutMs });
      record.scope = undefined;
      record.consumer = undefined;
      record.instanceId = undefined;
      record.unitId = undefined;
      bump();

    }
  };

  start = async (pluginId: string): Promise<void> => {
    const existingStop = stopping.get(pluginId);
    if (existingStop) await existingStop;
    const existing = starting.get(pluginId);
    if (existing) return existing;
    const task = startImplementation(pluginId);
    starting.set(pluginId, task);
    try {
      await task;
    } finally {
      if (starting.get(pluginId) === task) starting.delete(pluginId);
    }
  };

  /**
   * 待启动插件的拓扑层级顺序。
   *
   * 层级来自声明依赖（A 依赖 B、B 依赖 C ⇒ C 先启动），同层保持装配清单顺序，因此
   * 无关分支仍可并行；不依赖 priority、插件分类或清单顺序。返回的插件 id 全部来自
   * 当前已登记 manifest，因此不存在“清单外插件”。
   */
  const startupLayersFor = (): readonly (readonly string[])[] => {
    const layers = startupLayers(graph());
    const filtered: string[][] = [];
    for (const layer of layers) {
      const ids = layer.filter((pluginId) => known.has(pluginId));
      if (ids.length > 0) filtered.push(ids);
    }
    return filtered;
  };

  let reconcilePromise: Promise<void> | undefined;
  let reconcileRequested = false;
  const runReconcile = async (): Promise<void> => {
      let progress = true;
      while (progress) {
        progress = false;

        // 先同步围栏所有失效的活跃世代，再等待任何清理：beginStop 是同步的，依赖链
        // 因此看到的是完整的已撤销集合，而不会从仍然存活的提供者重新启动自己。
        const stops: Promise<void>[] = [];
        for (const record of records.values()) {
          const invalid = record.state === "enabled" || record.state === "starting"
            ? missingDependencies(record.manifest).length > 0 || unavailableReason(record.manifest) !== undefined
            : false;
          if (invalid) {
            const before = record.state;
            stops.push(stop(record, "runtime dependency unavailable", true));
            progress = progress || before !== record.state;
          }
        }
        if (stops.length > 0) await Promise.all(stops);

        // 按拓扑层级启动：提供者先完成初始化并发布能力，消费者随后启动。同一层内
        // 的插件互不依赖，逐个 await 只是让顺序可观测，不引入人为串行化保证。
        for (const layer of startupLayersFor()) {
          for (const pluginId of layer) {
            const record = records.get(pluginId);
            if (!record) continue;
            // 失败的世代需要显式 retry；cleanup-pending 世代不能与新实例重叠。
            if (record.state === "registered") {
              // 待启动：装配后的首次收敛，或依赖恢复后的重建。
            } else if (record.state === "blocked" && !record.condition) {
              // 依赖/运行可用性等待中：条件解除后重建。
            } else continue;
            const before = record.state;
            await start(pluginId);
            progress = progress || before !== record.state;
          }
        }
      }
  };
  /**
   * 请求一次依赖收敛。
   *
   * 远端连接挂接/断开/目录变化都通过它触发：等待中的必需依赖必须自己转入运行，
   * 不依赖装配层记得再调用一次 reconcile。
   */
  const requestReconcile = (): Promise<void> => (disposed ? Promise.resolve() : reconcile());
  /** 把 Host 状态收敛到依赖图。 */
  const reconcile = async (): Promise<void> => {
    if (disposed) return;
    if (reconcilePromise) {
      reconcileRequested = true;
      return reconcilePromise;
    }
    const task = (async () => {
      do {
        reconcileRequested = false;
        await runReconcile();
      } while (reconcileRequested && !disposed);
    })().finally(() => { reconcilePromise = undefined; });
    reconcilePromise = task;
    return task;
  };

  const collectStopPlan = (pluginId: string): PluginRecord[] => {
    const current = graph();
    const result: PluginRecord[] = [];
    const visited = new Set<string>();
    const visitDependents = (providerId: string): void => {
      for (const dependent of reverseDependentsOf(current, providerId)) {
        if (visited.has(dependent.pluginId)) continue;
        const dependentRecord = records.get(dependent.pluginId);
        if (!dependentRecord) continue;
        visited.add(dependent.pluginId);
        visitDependents(dependent.pluginId);
        if (dependentRecord.state === "enabled" || dependentRecord.state === "starting" || dependentRecord.state === "stopping" || dependentRecord.state === "blocked" || dependentRecord.state === "failed") result.push(dependentRecord);
      }
    };
    visitDependents(pluginId);
    const target = records.get(pluginId);
    if (target && (target.state === "enabled" || target.state === "starting" || target.state === "stopping" || target.state === "blocked" || target.state === "failed")) result.push(target);
    return result;
  };

  /**
   * 按反向依赖顺序执行一次计划销毁。
   *
   * 先同步围栏整条计划（beginStop），再按销毁层级分层等待：消费者清理完成后才轮到提供者
   * 释放；同一层内的插件互不依赖，可以并行清理。不使用 `Promise.all(plan)`，否则消费者
   * 还没清理完提供者就已经释放。
   */
  const runStopPlan = async (
    plan: readonly PluginRecord[],
    reasonFor: (record: PluginRecord) => string,
    preserveIntent: (record: PluginRecord) => boolean,
  ): Promise<void> => {
    // 同步围栏：依赖链必须先看到完整的已撤销集合。
    for (const record of plan) beginStop(record, reasonFor(record));
    const byId = new Map(plan.map((record) => [record.manifest.id, record]));
    for (const layer of teardownLayers(graph(), plan.map((record) => record.manifest.id))) {
      const targets = layer.map((pluginId) => byId.get(pluginId)).filter((record): record is PluginRecord => record !== undefined);
      await Promise.all(targets.map((record) => stopAfterBegin(record, reasonFor(record), preserveIntent(record))));
    }
  };

  const host: PluginHost = {
    capabilities,
    privateGrantCandidates,
    messageBus,
    resourceRegistry,
    resourceStore,
    rootScope,
    taskScheduler,
    runtimeKind,
    runtimeId,
    runtimeInstanceId,
    installed: () => [...known.keys()],
    manifests: () => [...known.keys()],
    state(pluginId) {
      const record = records.get(pluginId);
      const manifest = record?.manifest;
      const unit = manifest ? manifestUnit(manifest) : undefined;
      if (!record) {
        const cached = stateCache.get(pluginId);
        if (cached?.signature === "unknown") return cached.state;
        const unknownState: PluginState = { id: pluginId, kind: "unknown", lifecycleState: "waiting", units: [] };
        stateCache.set(pluginId, { signature: "unknown", state: unknownState });
        return unknownState;
      }
      const signature = JSON.stringify([record.state, record.error, record.blockedBy, record.instanceId, record.unitId, record.cleanup]);
      const cached = stateCache.get(pluginId);
      if (cached?.signature === signature) return cached.state;
      const unitState: PluginUnitState[] = unit ? [{ pluginId, unitId: unit.id, runtime: unit.runtime, kind: record.state, ...(record.instanceId ? { instanceId: record.instanceId } : {}), ...(record.error ? { error: record.error } : {}) }] : [];
      const next: PluginState = { id: pluginId, kind: record.state, lifecycleState: lifecycleStateFor(record.state), ...(record.error ? { error: record.error } : {}), ...(record.instanceId ? { instanceId: record.instanceId } : {}), ...(record.unitId ? { unitId: record.unitId } : {}), ...(record.blockedBy ? { blockedBy: [...record.blockedBy] } : {}), ...(record.cleanup ? { cleanup: record.cleanup } : {}), units: unitState };
      stateCache.set(pluginId, { signature, state: next });
      return next;
    },
    scope: (pluginId) => records.get(pluginId)?.scope,
    refreshRuntimeUnitSnapshots: bump,
    reconcile,
    graph,
    version: () => versionCounter,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    getManifest: (pluginId) => known.get(pluginId),
    reverseDeps(pluginId) { return [...reverseDependentsOf(graph(), pluginId)]; },
    validateManifestSet(manifests) { for (const manifest of manifests) { options.manifestValidator?.(manifest); } validatePluginGraph(manifests, { runtime: configuredRuntime, builtinCapabilities: new Set(capabilities.descriptors()), externalRuntimeDependencies: options.externalRuntimeDependencies }); },
    provide<C extends LocalCapability<unknown>>(capability: C, value: LocalServiceOf<C>) { if (disposed) throw new LifecycleScopeRevokedError("Plugin host is disposed"); capabilities.provide(capability, value, "host", rootScope); bump(); },
    register: async (manifest) => { if (disposed) throw new LifecycleScopeRevokedError("Plugin host is disposed"); validateManifest(manifest); if (known.has(manifest.id)) throw new Error(`Plugin "${manifest.id}" is already registered`); known.set(manifest.id, manifest); records.set(manifest.id, { manifest, state: "registered", provided: [], privateProvided: [], contributions: [] }); bump(); await reconcile(); },
    registerAll: async (manifests) => { if (disposed) throw new LifecycleScopeRevokedError("Plugin host is disposed"); validatePluginGraph(manifests, { runtime: configuredRuntime, builtinCapabilities: new Set(capabilities.descriptors()), externalRuntimeDependencies: options.externalRuntimeDependencies, allowMissingDependencies: true }); for (const manifest of manifests) { validateManifest(manifest); if (known.has(manifest.id)) throw new Error(`Plugin "${manifest.id}" is already registered`); } for (const manifest of manifests) { known.set(manifest.id, manifest); records.set(manifest.id, { manifest, state: "registered", provided: [], privateProvided: [], contributions: [] }); } bump(); await reconcile(); },
    retry: async (pluginId) => {
      const record = records.get(pluginId);
      if (!record) throw new Error(`Plugin "${pluginId}" is not registered`);
      // 清除运行条件与失败状态后重建；随后收敛依赖图，让等待中的消费者按正向
      // 拓扑顺序恢复，而不是各自重试。
      record.condition = undefined;
      record.state = "registered";
      record.blockedBy = undefined;
      record.error = undefined;
      await start(pluginId);
      await reconcile();
    },
    /**
     * 撤销当前实例与受影响的反向依赖者。
     *
     * 这是生命周期操作（Runtime 换代、领域权威要求释放等），不是用户启停入口：没有
     * 持久化意图，也不会阻止后续按依赖图重建。先同步围栏整条计划，再等待清理。
     */
    revoke: async (pluginId, reason = "instance revoked") => {
      const record = records.get(pluginId);
      if (!record) throw new Error(`Plugin "${pluginId}" is not registered`);
      // 运行条件由可信装配层给出：释放实例后不再自动重建，直到 retry 或条件解除。
      record.condition = reason;
      await runStopPlan(
        collectStopPlan(pluginId),
        (item) => (item.manifest.id === pluginId ? reason : `dependency ${pluginId} revoked`),
        () => true,
      );
    },
    unregister: async (pluginId) => {
      const record = records.get(pluginId);
      if (!record) return;
      await runStopPlan(
        collectStopPlan(pluginId),
        (item) => (item.manifest.id === pluginId ? "plugin unregistered" : `dependency ${pluginId} unregistered`),
        () => false,
      );
      records.delete(pluginId);
      known.delete(pluginId);
      instances.delete(record.instanceId ?? "");
      bump();
    },
    dispose: (reason = "plugin host disposed") => {
      if (disposePromise) return disposePromise;
      disposed = true;
      disposePromise = (async () => {
        // 整体销毁同样遵守反向依赖顺序：消费者先清理，提供者后释放。
        // 不按登记顺序倒序执行，那会让登记靠后的提供者提前释放。
        await runStopPlan([...records.values()], () => reason, () => false);
        return rootScope.dispose({ reason, timeoutMs: options.lifecycleCleanupTimeoutMs });
      })();
      return disposePromise;
    },
    assertCapabilities(requiredCapabilities, extra = {}) {
      const details: StartupCapabilityErrorDetails[] = [];
      const current = graph();
      for (const capability of requiredCapabilities) {
        if (capabilities.has(capability as Capability)) continue;
        const descriptor = capabilityDescriptor(capability as Capability);
        const providerPluginId = current.providers[capabilityKey(descriptor)]?.[0];
        const provider = providerPluginId ? records.get(providerPluginId) : undefined;
        details.push({
          capability: descriptor,
          providerPluginId,
          providerState: provider?.state,
          providerError: provider?.error,
        });
      }
      if (details.length > 0) throw new StartupCapabilityError(details, extra.phase);
    },
  serviceReferences() { return capabilities.registrations().filter((entry) => isRemote(entry.capability)).map((entry) => entry.reference); },
    capability<C extends Capability>(capability: C): CapabilityClient<C> {
      if (capability.kind === "local") return capabilities.get(capability) as CapabilityClient<C>;
      const key = capabilityKey(capability);
      const cached = publicClients.get(key);
      if (cached) return cached as CapabilityClient<C>;
      const client = getRemoteClient(capability, rootScope) as unknown as CapabilityClient<Capability>;
      publicClients.set(key, client);
      return client as CapabilityClient<C>;
    },
    optionalCapability<C extends Capability>(capability: C): CapabilityClient<C> | undefined {
      if (capability.kind === "local") return capabilities.has(capability) ? capabilities.get(capability) as CapabilityClient<C> : undefined;
      // 私有能力不出现在公共服务目录里：装配层接口之外无法解析。
      if ([...privateGrantConfigs.keys()].some((key) => key.endsWith(capabilityKey(capability)))) return undefined;
      const remote = capability.kind === "rpc" || capability.kind === "stream" ? (capability as RemoteCapability) : undefined;
      const published = remote ? endpointFor(remote, undefined) !== undefined : false;
      if (!published && !capabilities.has(capability)) return undefined;
      return host.capability(capability);
    },
    attachRemote(bridge, slot: string | { readonly slotId: string } = DEFAULT_RUNTIME_SLOT) {
      const slotId = typeof slot === "string" ? slot : slot.slotId;
      // 槽位被新连接占用时，旧连接的失效是幂等的；调用方拿到的连接世代用于
      // 后续卸载：只有当前槽位仍是自己那次挂接时，卸载才生效（PSM-R12）。
      bridges.get(slotId)?.unsubscribe?.();
      bridges.get(slotId)?.bridge.invalidate(`Runtime slot "${slotId}" replaced`);
      const generation = (slotGenerations.get(slotId) ?? 0) + 1;
      slotGenerations.set(slotId, generation);
      // 远端目录变化必须自己驱动依赖收敛（PSM-R12）：Worker 发布首个快照后，等待中
      // 的必需依赖单元自动转入运行，而不是等下一次外部 reconcile。
      const unsubscribe = typeof bridge.subscribe === "function"
        ? bridge.subscribe(() => { void requestReconcile(); })
        : undefined;
      bridges.set(slotId, { bridge, slotId, generation, ...(unsubscribe !== undefined ? { unsubscribe } : {}) });
      bump();
      // 替换完成后显式收敛：旧连接的服务消失，等待中的单元必须转入等待。
      void requestReconcile();
      return Object.freeze({ slotId, generation });
    },
    detachRemote(reason = "Remote bridge detached", slot: string | { readonly slotId: string; readonly generation?: number } = DEFAULT_RUNTIME_SLOT) {
      const slotId = typeof slot === "string" ? slot : slot.slotId;
      const entry = bridges.get(slotId);
      if (!entry) return;
      // 旧卸载函数不得断开同槽位后来替换上的新连接。
      if (typeof slot === "object" && slot.generation !== undefined && slot.generation !== entry.generation) return;
      entry.unsubscribe?.();
      bridges.delete(slotId);
      entry.bridge.invalidate(reason);
      bump();
      // 卸载完成后显式收敛：订阅已取消，不能再靠目录变化通知驱动。
      void requestReconcile();
    },
    registerImplementation(implementation) {
      const registry = options.runtimeUnitImplementationRegistry as (RuntimeUnitImplementationRegistry & { register?: (implementation: { pluginId: string; unitId: string; setup: PluginSetup; capabilities?: readonly Capability[] }) => void }) | undefined;
      if (!registry?.register) throw new Error("This Host was not created with an advanced implementation registry");
      registry.register(implementation);
    },
    inspect() { return { runtimeId, runtimeKind, runtimeInstanceId, version: versionCounter, pluginCount: known.size, peerCount: 0, pendingCallCount: 0, activeStreamCount: 0, plugins: [...known.keys()].sort().map((id) => host.state(id)) }; },
    explain(target) { const id = typeof target === "string" ? target : target.id; const record = records.get(id); if (!record) return { target: id, reasons: ["unknown"] }; const blocked = record.blockedBy ?? []; return { target: id, state: record.state, reasons: blocked.length > 0 ? blocked : record.error ? [record.error] : [] }; },
  };

  return host;
}

export interface HostInspection {
  /** Runtime 逻辑标识。 */
  readonly runtimeId: string;
  /** Runtime 类型。 */
  readonly runtimeKind: RuntimeKind;
  /** Runtime 启动实例。 */
  readonly runtimeInstanceId: string;
  /** Host 变化修订。 */
  readonly version: number;
  /** 已注册插件数。 */
  readonly pluginCount: number;
  /** 当前 peer 数；Host 本身不拥有远端 peer。 */
  readonly peerCount: number;
  /** 当前本地框架 pending 调用数。 */
  readonly pendingCallCount: number;
  /** 当前本地活动流数。 */
  readonly activeStreamCount: number;
  /** 插件状态。 */
  readonly plugins: readonly PluginState[];
}

export interface PluginHost {
  /** v4 capability registry。 */
  readonly capabilities: CapabilityRegistry;
  /**
   * 私有能力的授权票据查询（PSM-R13）。
   *
   * 接收端（Runtime provider）在执行 handler 之前用它核对调用方：票据由装配层签发、
   * 只交给所属单元的 Host，不进服务目录，因此普通 RuntimeHandle 无法伪造。
   */
  /**
   * 私有授权候选记录（机密与实例一一绑定）。
   *
   * 返回该契约在装配层登记的、且在对端快照中仍然活着的调用实例及其机密；接收端只按这些
   * 记录核对，不做"全部机密 × 全部实例"的交叉匹配。
   */
  privateGrantCandidates?(
    capability: Capability,
    remoteUnits: readonly { readonly pluginId: string; readonly unitId: string; readonly instanceId?: string; readonly state: string }[],
  ): readonly { readonly pluginId: string; readonly unitId: string; readonly secret: string; readonly instanceId: string }[];
  /** 绑定到根 Scope 的 MessageBus。 */
  readonly messageBus: MessageBus;
  /** 资源定义注册表。 */
  readonly resourceRegistry: ResourceRegistry;
  /** 资源缓存 Store。 */
  readonly resourceStore: ResourceStoreApi;
  /** Host Runtime。 */
  readonly runtimeKind: RuntimeKind;
  /** Runtime 逻辑标识。 */
  readonly runtimeId: string;
  /** Runtime 启动实例。 */
  readonly runtimeInstanceId: string;
  /** 根 Scope。 */
  readonly rootScope: LifecycleScope;
  /** 根任务调度器。 */
  readonly taskScheduler: ScopedTaskScheduler;
  /** 已注册插件。 */
  installed(): string[];
  /** 已注册插件。 */
  manifests(): string[];
  /** 状态查询。 */
  state(pluginId: string): PluginState;
  /** 插件实例 Scope。 */
  scope(pluginId: string): LifecycleScope | undefined;
  /** 刷新 Host 观察修订。 */
  refreshRuntimeUnitSnapshots(): void;
  /** 协调启停。 */
  reconcile(): Promise<void>;
  /** 依赖图。 */
  graph(): PluginGraph;
  /** Host 观察修订。 */
  version(): number;
  /** Host 变化订阅。 */
  subscribe(listener: HostListener): () => void;
  /** manifest 查询。 */
  getManifest(pluginId: string): PluginManifest | undefined;
  /** 反向依赖查询。 */
  reverseDeps(pluginId: string): readonly PluginReverseDep[];
  /** manifest 集合校验。 */
  validateManifestSet(manifests: readonly PluginManifest[]): void;
  /** 显式 Host-owned local 注册。 */
  provide<C extends LocalCapability<unknown>>(capability: C, value: LocalServiceOf<C>): void;
  /** 注册插件。 */
  register(manifest: PluginManifest): Promise<void>;
  /** 批量注册插件。 */
  registerAll(manifests: readonly PluginManifest[]): Promise<void>;
  /** 重试失败插件：清除失败状态并按依赖图重新启动该运行单元。 */
  retry(pluginId: string): Promise<void>;
  /**
   * 撤销当前实例及受影响的反向依赖者。
   *
   * 生命周期操作而非用户启停：不会持久化任何意图，依赖恢复后按拓扑顺序重建。
   */
  revoke(pluginId: string, reason?: string): Promise<void>;
  /** 删除插件。 */
  unregister(pluginId: string): Promise<void>;
  /** 释放 Host。 */
  dispose(reason?: string): Promise<LifecycleDisposeResult>;
  /** 启动前检查 local capability。 */
  assertCapabilities(required: readonly CapabilityDescriptor[], options?: { phase?: string }): void;
  /** 当前可调用的 remote service 引用。 */
  serviceReferences(): readonly ServiceReference[];
  /** advanced/WindowApp 使用的 typed capability 获取。 */
  capability<C extends Capability>(capability: C): CapabilityClient<C>;
  /** 当前已存在的 typed capability。 */
  optionalCapability<C extends Capability>(capability: C): CapabilityClient<C> | undefined;
  /**
   * 绑定一个 SharedWorker remote bridge 到运行时槽位。
   *
   * 同一个 Window 可以并存多个槽位（多个 Worker）；新增槽位只替换同槽位的旧连接，
   * 不会撤销其他 Worker（PSM-R12）。
   */
  attachRemote(bridge: CapabilityBridge, slot?: string | { readonly slotId: string }): { readonly slotId: string; readonly generation: number };
  /**
   * 撤销匹配的运行时槽位；其他槽位不受影响。
   *
   * 传入 `attachRemote` 返回的连接世代时，只有槽位仍是自己那次挂接才会断开：
   * 同槽位后来替换上的新连接不会被旧卸载函数误伤（PSM-R12）。
   */
  detachRemote(reason?: string, slot?: string | { readonly slotId: string; readonly generation?: number }): void;
  /** advanced 分阶段注册当前 realm implementation。 */
  registerImplementation(implementation: { readonly pluginId: string; readonly unitId: string; readonly setup: PluginSetup; readonly capabilities?: readonly Capability[] }): void;
  /** 结构化诊断。 */
  inspect(): HostInspection;
  /** 解释插件或 capability。 */
  explain(target: string | CapabilityDescriptor): { readonly target: string; readonly state?: PluginStateKind; readonly reasons: readonly string[] };
}
