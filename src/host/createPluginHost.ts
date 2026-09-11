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
  type RpcHandler,
  type StreamCapability,
  type StreamCapabilityBase,
  type StreamHandler,
  type StreamSubscribeOptions,
  type StreamSubscription,
  type ServiceReference,
} from "../contracts/capability.js";
import type {
  LifecycleDisposeResult,
  LifecycleScope,
  LifecycleScopeIdentity,
  PermissionLease,
  PermissionLeaseBinding,
  PluginIntentCoordinator,
  PluginIntentSubmissionResult,
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
import { createCapabilityRegistry, invokeCapabilityHandler, type CapabilityRegistry } from "./capabilityRegistry.js";
import { buildPluginGraph, dependenciesOfManifest, providesOfManifest, reverseDependentsOf, selectRuntimeUnit, validatePluginGraph } from "./pluginGraph.js";
import { createLifecycleScope } from "../lifecycle/resourceScope.js";
import { createPermissionLease } from "../lifecycle/permissionLease.js";
import { createScopedMessageBus } from "../lifecycle/scopedMessageBus.js";
import { createScopedTaskScheduler } from "../lifecycle/taskScheduler.js";
import { createMessageBus } from "../messaging/messageBus.js";
import { createResourceRegistry } from "../resources/resourceRegistry.js";
import { createResourceStore, type ResourceStoreApi } from "../resources/resourceStore.js";
import { cloneFrozenAttributes } from "../transport/dto.js";

export interface PluginConfigStore {
  /** 读取产品级绝对启停意图。 */
  read(): Readonly<Record<string, boolean>>;
  /** 写入一个产品的绝对启停意图。 */
  setEnabled(pluginId: string, enabled: boolean): void;
  /** 订阅外部控制面变化。 */
  subscribe(listener: (snapshot: Readonly<Record<string, boolean>>) => void): () => void;
}

export function createInMemoryPluginConfigStore(initial: Readonly<Record<string, boolean>> = {}, readOnly = false): PluginConfigStore {
  const values = new Map(Object.entries(initial).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"));
  const listeners = new Set<(snapshot: Readonly<Record<string, boolean>>) => void>();
  const snapshot = (): Readonly<Record<string, boolean>> => Object.freeze(Object.fromEntries(values));
  return {
    read: snapshot,
    setEnabled(pluginId, enabled) {
      if (readOnly || values.get(pluginId) === enabled) return;
      values.set(pluginId, enabled);
      const next = snapshot();
      for (const listener of [...listeners]) listener(next);
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}

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
  /** 资源读取时的领域 capability resolver。 */
  readonly resourceCapabilityResolver?: <T>(id: string) => T | undefined;
  /** 领域 Context Extension。 */
  readonly contextExtension?: (input: ContextExtensionInput) => Readonly<Record<string, unknown>>;
  /** 清单额外校验。 */
  readonly manifestValidator?: (manifest: PluginManifest) => void;
  /** 权限策略。 */
  readonly permissionPolicy?: (input: PermissionPolicyInput) => PermissionPolicyResult;
  /** 启停配置。 */
  readonly configStore?: PluginConfigStore;
  /** 内存启停配置。 */
  readonly initialPluginConfig?: Readonly<Record<string, boolean>>;
  /** 外部启停控制面。 */
  readonly pluginIntentCoordinator?: PluginIntentCoordinator;
  /** 当前 Runtime 的 typed remote bridge。 */
  readonly capabilityBridge?: CapabilityBridge;
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
  contributions: ContributionRuntime[];
  cleanup?: LifecycleDisposeResult;
  stopRequested?: string;
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

function lifecycleStateFor(state: PluginStateKind, desired: boolean): PluginLifecycleState {
  switch (state) {
    case "starting": return "starting";
    case "stopping": return "stopping";
    case "enabled": return "running";
    case "blocked": return "waiting";
    case "error-disabled":
    case "cleanup-pending": return "failed";
    case "disabled": return "disabled";
    case "registered":
    case "unknown": return desired ? "waiting" : "disabled";
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
  let capabilityBridge = options.capabilityBridge;
  let versionCounter = 0;
  let disposed = false;
  let disposePromise: Promise<LifecycleDisposeResult> | undefined;
  const listeners = new Set<HostListener>();
  const known = new Map<string, PluginManifest>();
  const records = new Map<string, PluginRecord>();
  const enabled = new Set<string>();
  const stateCache = new Map<string, { signature: string; state: PluginState }>();
  const publicClients = new Map<string, CapabilityClient<Capability>>();
  const configStore = options.configStore ?? createInMemoryPluginConfigStore(options.initialPluginConfig);
  const internalConfigWrites = new Set<string>();
  const starting = new Map<string, Promise<void>>();
  const stopping = new Map<string, Promise<void>>();
  let start: (pluginId: string) => Promise<void>;
  let intentSnapshot = options.pluginIntentCoordinator?.snapshot();

  const bump = (): void => {
    versionCounter += 1;
    for (const listener of [...listeners]) {
      try { listener({ version: versionCounter }); } catch { /* observers isolated */ }
    }
  };
  const rootScope = createLifecycleScope({ kind: "root", metadata: { attributes: Object.freeze({ ...(options.rootAttributes ?? {}), runtimeId, runtimeInstanceId }) }, onChange: bump });
  const messageBus = options.messageBus ?? createMessageBus();
  const resourceRegistry = options.resourceRegistry ?? createResourceRegistry();
  const capabilities = createCapabilityRegistry();
  capabilities.provide(RESOURCE_REGISTRY, resourceRegistry, "host", rootScope);
  const taskScheduler = createScopedTaskScheduler(rootScope);
  const resourceStore = createResourceStore(resourceRegistry, options.resourceCapabilityResolver ?? (() => undefined), (ownerId) => {
    const instance = ownerId ? records.get(ownerId)?.scope : undefined;
    return instance?.identity.attributes ?? rootScope.identity.attributes;
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
  const desired = (manifest: PluginManifest): boolean => {
    if (manifest.startup === "required" || manifest.canDisable === false) return true;
    if (intentSnapshot && Object.prototype.hasOwnProperty.call(intentSnapshot.desiredEnabled, manifest.id)) return intentSnapshot.desiredEnabled[manifest.id] === true;
    return configStore.read()[manifest.id] ?? manifest.defaultEnabled;
  };
  const desiredRevision = (pluginId: string): number | undefined => intentSnapshot?.desiredRevision[pluginId];
  const writeConfigIntent = (pluginId: string, value: boolean): void => {
    internalConfigWrites.add(pluginId);
    try { configStore.setEnabled(pluginId, value); }
    finally { internalConfigWrites.delete(pluginId); }
  };
  const initializeConfigIntent = (manifest: PluginManifest): void => {
    // The config store is the local product intent source when no Coordinator
    // is installed.  Materialize defaults once so a subsequent disable has a
    // durable false value and diagnostics can distinguish absent from false.
    // A Coordinator remains authoritative for the intent itself.
    if (options.pluginIntentCoordinator) return;
    const current = configStore.read();
    if (required(manifest)) {
      if (current[manifest.id] !== true) writeConfigIntent(manifest.id, true);
    } else if (!Object.prototype.hasOwnProperty.call(current, manifest.id)) {
      writeConfigIntent(manifest.id, manifest.defaultEnabled);
    }
  };
  const definitionList = (pluginId: string, unitId: string): readonly Capability[] => {
    const fromRegistry = options.runtimeUnitImplementationRegistry?.getCapabilities?.(pluginId, unitId);
    if (fromRegistry) return fromRegistry;
    return options.capabilityDefinitions?.get(implementationKey(pluginId, unitId)) ?? [];
  };
  const capabilityFor = (record: PluginRecord, descriptor: CapabilityDescriptor): Capability | undefined => definitionList(record.manifest.id, record.unitId ?? descriptor.id).find((capability) => capabilityKey(capability) === capabilityKey(descriptor));

  const graph = (): PluginGraph => buildPluginGraph([...known.values()], { runtime: configuredRuntime, enabledPluginIds: enabled, externalRuntimeDependencies: options.externalRuntimeDependencies, builtinCapabilities: new Set(capabilities.descriptors()) });

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
      if (capabilities.has(dependency.capability as Capability)) return false;
      if ((current.providers[capabilityKey(dependency.capability)]?.length ?? 0) > 0) {
        const provider = current.providers[capabilityKey(dependency.capability)]?.[0];
        return provider === undefined || !enabled.has(provider);
      }
      if (dependency.sourceRuntime !== localRuntime && options.externalRuntimeDependencies) return false;
      return true;
    }).map((dependency) => dependency.capability);
  };

  const required = (manifest: PluginManifest): boolean => manifest.startup === "required" || manifest.canDisable === false;

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

  const getRemoteClient = <C extends RemoteCapability>(capability: C, scope: LifecycleScope, forceRemote = false): CapabilityClient<C> => {
    if (!forceRemote && capabilities.has(capability)) {
      if (capability.kind === "rpc") return createLocalRpcClient(capability, scope) as unknown as CapabilityClient<C>;
      return createLocalStreamClient(capability, scope) as unknown as CapabilityClient<C>;
    }
    if (capabilityBridge) return capabilityBridge.getClient(capability, scope) as CapabilityClient<C>;
    if (forceRemote) return createUnavailableRemoteClient(capability, scope);
    if (capability.kind === "rpc") return createLocalRpcClient(capability, scope) as unknown as CapabilityClient<C>;
    return createLocalStreamClient(capability, scope) as unknown as CapabilityClient<C>;
  };

  const createLocalRpcClient = <C extends RpcCapabilityBase>(capability: C, scope: LifecycleScope): CapabilityClient<C> => {
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
          const finish = (error?: unknown, value?: unknown): void => {
            if (settled) return;
            settled = true;
            if (timer !== undefined) clearTimeout(timer);
            merged.dispose();
            if (error !== undefined) reject(error); else resolve(value);
          };
          const entry = capabilities.registration(capability);
          if (!entry || entry.capability.kind !== "rpc") {
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
    const client = {
      subscribe(request: unknown, subscribeOptions: StreamSubscribeOptions<unknown>): StreamSubscription<unknown> {
        scope.assertActive();
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
            const entry = capabilities.registration(capability);
            if (!entry || entry.capability.kind !== "stream") throw new WebLoomError("capability_unavailable", `Capability "${capability.id}" is not available`, "wait", { capabilityId: capability.id });
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
              if (next.done) { cancelled = true; settleClosedResolve(); break; }
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
    if (record.state !== "enabled" && record.state !== "starting" && record.state !== "blocked" && record.state !== "error-disabled") return false;
    record.stopRequested = reason;
    record.state = "stopping";
    record.scope?.revoke(reason);
    for (const contribution of record.contributions) {
      try { contribution.revoke(); } catch { /* synchronous fencing continues */ }
    }
    for (const capability of record.provided) capabilities.revoke(capability, record.instanceId);
    for (const capability of record.provided) publicClients.delete(capabilityKey(capability));
    enabled.delete(record.manifest.id);
    bump();
    return true;
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
      const currentDesired = desired(record.manifest);
      const missing = missingDependencies(record.manifest);
      const unavailable = unavailableReason(record.manifest);
      record.state = currentDesired && (missing.length > 0 || unavailable) ? "blocked" : "disabled";
      record.blockedBy = record.state === "blocked"
        ? [...new Set([...missing.map((item) => `missing:${item.kind}:${item.id}@${item.version}`), ...(unavailable ? [unavailable] : [])])]
        : undefined;
      record.error = undefined;
      bump();
      if (currentDesired && record.state === "disabled" && !disposed) {
        queueMicrotask(() => { void start(record.manifest.id).catch(() => undefined); });
      }
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
    record.provided = [];
    record.teardown = undefined;
    record.instanceId = undefined;
    record.unitId = undefined;
    record.stopRequested = undefined;
    record.contributions = [];

    const currentDesired = desired(record.manifest);
    const missing = missingDependencies(record.manifest);
    const unavailable = unavailableReason(record.manifest);
    const hasTimeout = Boolean(cleanup?.pending.length && cleanup.errors.some((item) => item.code === "lifecycle.cleanup_timeout"));
    const cleanupError = cleanup?.errors.find((item) => item.code !== "lifecycle.cleanup_timeout");
    if (hasTimeout) {
      record.state = "cleanup-pending";
      record.error = cleanupError?.message ?? "Plugin cleanup is still pending";
    } else if (cleanupError || cleanup?.cleanupIncomplete) {
      record.state = "error-disabled";
      record.error = cleanupError?.message ?? "Plugin cleanup did not complete";
    } else if (currentDesired && (missing.length > 0 || unavailable)) {
      record.state = "blocked";
      record.blockedBy = [
        ...new Set([
          ...missing.map((item) => `missing:${item.kind}:${item.id}@${item.version}`),
          ...(unavailable ? [unavailable] : []),
        ]),
      ];
      record.error = undefined;
    } else {
      record.state = "disabled";
      record.blockedBy = undefined;
      record.error = undefined;
    }
    // A provider-driven stop keeps the consumer's intent. An explicit stop
    // has already persisted false before this cleanup completes.
    // `preserveIntent` is intentionally represented by the config/coordinator
    // snapshot.  The value is retained in the signature so all stop callers
    // state whether they are a provider-driven/suspend stop or an explicit
    // disable/host-dispose operation; the latest absolute intent is read below
    // after asynchronous cleanup, so a re-enable during stopping wins.
    void preserveIntent;
    bump();
    if (currentDesired && record.state === "disabled" && !disposed) {
      queueMicrotask(() => { void start(record.manifest.id).catch(() => undefined); });
    }
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

  const registerContribution = async (record: PluginRecord, unit: RuntimeUnitDescriptor & { id: string; runtime: RuntimeKind }, instanceId: string, scope: LifecycleScope): Promise<void> => {
    if (unit.contribution === undefined) return;
    for (const adapter of options.contributionAdapters ?? []) {
      const result = await adapter.register({ pluginId: record.manifest.id, unitId: unit.id, instanceId, scope, contribution: unit.contribution, manifest: record.manifest });
      if (!result) continue;
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
      if (required(record.manifest)) throw new StartupCapabilityError(missing.map((capability) => ({ capability })), "startup");
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
    const resolveCapability = <C extends Capability>(capability: C, optional: boolean): CapabilityClient<C> | undefined => {
      const descriptor = capabilityDescriptor(capability);
      const declared = [...declaredProvides, ...declaredDependencies.map((dependency) => dependency.capability)].some((item) => capabilityKey(item) === capabilityKey(descriptor));
      if (!declared) throw new WebLoomError("capability_unavailable", `Capability "${capability.id}" is not declared by plugin`, "validate", { capabilityId: capability.id });
      if (capability.kind === "local") {
        if (!capabilities.has(capability)) {
          if (optional) return undefined;
          throw new WebLoomError("capability_unavailable", `Capability "${capability.id}" is not available`, "wait", { capabilityId: capability.id });
        }
        return capabilities.get(capability) as CapabilityClient<C>;
      }
      const dependency = declaredDependencies.find((item) => capabilityKey(item.capability) === capabilityKey(descriptor));
      if (dependency?.source === "peer") {
        throw new WebLoomError("capability_unavailable", `Capability "${capability.id}" is only available through call.peer`, "dispatch", { capabilityId: capability.id });
      }
      const remote = dependency?.sourceRuntime !== undefined && dependency.sourceRuntime !== unit.runtime;
      if (optional && remote && (!capabilityBridge || !capabilityBridge.services().some((service) => service.kind === capability.kind && service.capabilityId === capability.id && service.contractVersion === capability.version))) return undefined;
      if (optional && !remote && !capabilities.has(capability)) return undefined;
      return getRemoteClient(capability, scope, remote) as unknown as CapabilityClient<C>;
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
      await registerContribution(record, unit, instanceId, scope);
      if (required(record.manifest)) {
        for (const descriptor of declaredProvides) {
          if (!record.provided.some((capability) => capabilityKey(capability) === capabilityKey(descriptor))) throw new Error(`Plugin "${pluginId}" did not register declared capability "${descriptor.id}@${descriptor.version}"`);
        }
      }
      if (record.stopRequested || scope.state !== "active") {
        // The stop coordinator already fenced this generation.  Calling stop
        // here would await the current start task and deadlock; its pending
        // stop promise will perform the cleanup after this task returns.
        return;
      }
      if (!desired(record.manifest)) {
        // The intent changed without a stop request racing this setup.  Defer
        // the stop until the starting map no longer contains this task.
        queueMicrotask(() => { void stop(record, "startup superseded", false).catch(() => undefined); });
        return;
      }
      record.state = "enabled";
      enabled.add(pluginId);
      bump();
    } catch (error) {
      if (record.stopRequested || scope.state !== "active") {
        // A revoked generation is owned by stop(); setup errors from that
        // generation must never overwrite the newer lifecycle decision.
        return;
      }
      record.state = "error-disabled";
      record.error = errorMessage(error);
      scope.revoke("plugin setup failed");
      for (const capability of record.provided) capabilities.revoke(capability, instanceId);
      record.provided = [];
      record.cleanup = await scope.dispose({ reason: "plugin setup failed", timeoutMs: options.lifecycleCleanupTimeoutMs });
      record.scope = undefined;
      record.instanceId = undefined;
      record.unitId = undefined;
      bump();
      if (required(record.manifest)) throw new StartupPluginError({ pluginId, unitId: unit.id, capabilities: declaredProvides, state: record.state, error: record.error });
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

  let reconcilePromise: Promise<void> | undefined;
  let reconcileRequested = false;
  const runReconcile = async (): Promise<void> => {
      let progress = true;
      while (progress) {
        progress = false;

        // Fence every invalid active generation before awaiting any cleanup.
        // Calling stop() without awaiting first is deliberate: beginStop is
        // synchronous, so a dependency chain observes the complete revoked
        // set instead of restarting from a still-live provider.
        const stops: Promise<void>[] = [];
        for (const record of records.values()) {
          const wants = desired(record.manifest);
          const invalid = record.state === "enabled" || record.state === "starting"
            ? missingDependencies(record.manifest).length > 0 || unavailableReason(record.manifest) !== undefined
            : false;
          if ((!wants && (record.state === "enabled" || record.state === "starting" || record.state === "blocked")) || (wants && invalid)) {
            const before = record.state;
            stops.push(stop(record, wants ? "runtime dependency unavailable" : "desired intent disabled", wants));
            progress = progress || before !== record.state;
          }
        }
        if (stops.length > 0) await Promise.all(stops);

        for (const manifest of known.values()) {
          const record = records.get(manifest.id);
          if (!record || !desired(manifest)) continue;
          // Failed generations require an explicit retry.  A cleanup-pending
          // generation likewise cannot be overlapped with a new instance.
          if (record.state !== "registered" && record.state !== "disabled" && record.state !== "blocked") continue;
          const before = record.state;
          await start(manifest.id);
          progress = progress || before !== record.state;
        }
      }
  };
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

  const submitIntent = async (pluginId: string, desiredEnabled: boolean): Promise<PluginIntentSubmissionResult> => {
    if (!known.has(pluginId)) throw new Error(`Plugin "${pluginId}" is not registered`);
    if (options.pluginIntentCoordinator) {
      const current = options.pluginIntentCoordinator.snapshot();
      return options.pluginIntentCoordinator.submit({
        commandId: makeId(`plugin-intent:${pluginId}`),
        authorityInstanceId: options.pluginIntentCoordinator.authorityInstanceId,
        expectedRevision: current.revision,
        pluginId,
        desiredEnabled,
      });
    }
    internalConfigWrites.add(pluginId);
    try { configStore.setEnabled(pluginId, desiredEnabled); }
    finally { internalConfigWrites.delete(pluginId); }
    return {
      status: "accepted",
      commandId: makeId(`plugin-intent:${pluginId}`),
      snapshot: { revision: 0, desiredEnabled: configStore.read(), desiredRevision: {} },
      persisted: true,
    };
  };

  const enable = async (pluginId: string): Promise<void> => {
    const result = await submitIntent(pluginId, true);
    if (result.status !== "accepted" && result.status !== "duplicate") {
      throw new Error(`Could not enable plugin "${pluginId}": ${result.status}`);
    }
    await reconcile();
    const record = records.get(pluginId);
    if (record?.state === "cleanup-pending") throw new Error(`Plugin "${pluginId}" cleanup is pending`);
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
        if (dependentRecord.state === "enabled" || dependentRecord.state === "starting" || dependentRecord.state === "stopping" || dependentRecord.state === "blocked" || dependentRecord.state === "error-disabled") result.push(dependentRecord);
      }
    };
    visitDependents(pluginId);
    const target = records.get(pluginId);
    if (target && (target.state === "enabled" || target.state === "starting" || target.state === "stopping" || target.state === "blocked" || target.state === "error-disabled")) result.push(target);
    return result;
  };

  const host: PluginHost = {
    capabilities,
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
        const unknownState: PluginState = { id: pluginId, kind: "disabled", lifecycleState: "disabled", desiredEnabled: false, units: [] };
        stateCache.set(pluginId, { signature: "unknown", state: unknownState });
        return unknownState;
      }
      const desiredEnabled = desired(record.manifest);
      const signature = JSON.stringify([record.state, record.error, record.blockedBy, record.instanceId, record.unitId, desiredEnabled, desiredRevision(record.manifest.id), record.cleanup]);
      const cached = stateCache.get(pluginId);
      if (cached?.signature === signature) return cached.state;
      const unitState: PluginUnitState[] = unit ? [{ pluginId, unitId: unit.id, runtime: unit.runtime, kind: record.state, ...(record.instanceId ? { instanceId: record.instanceId } : {}), ...(record.error ? { error: record.error } : {}) }] : [];
      const next: PluginState = { id: pluginId, kind: record.state, lifecycleState: lifecycleStateFor(record.state, desiredEnabled), ...(record.error ? { error: record.error } : {}), desiredEnabled, ...(desiredRevision(record.manifest.id) !== undefined ? { desiredRevision: desiredRevision(record.manifest.id) } : {}), ...(record.instanceId ? { instanceId: record.instanceId } : {}), ...(record.unitId ? { unitId: record.unitId } : {}), ...(record.blockedBy ? { blockedBy: [...record.blockedBy] } : {}), ...(record.cleanup ? { cleanup: record.cleanup } : {}), units: unitState };
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
    register: async (manifest) => { if (disposed) throw new LifecycleScopeRevokedError("Plugin host is disposed"); validateManifest(manifest); if (known.has(manifest.id)) throw new Error(`Plugin "${manifest.id}" is already registered`); known.set(manifest.id, manifest); records.set(manifest.id, { manifest, state: "registered", provided: [], contributions: [] }); initializeConfigIntent(manifest); bump(); await reconcile(); },
    registerAll: async (manifests) => { if (disposed) throw new LifecycleScopeRevokedError("Plugin host is disposed"); validatePluginGraph(manifests, { runtime: configuredRuntime, builtinCapabilities: new Set(capabilities.descriptors()), externalRuntimeDependencies: options.externalRuntimeDependencies, allowMissingDependencies: true }); for (const manifest of manifests) { validateManifest(manifest); if (known.has(manifest.id)) throw new Error(`Plugin "${manifest.id}" is already registered`); } for (const manifest of manifests) { known.set(manifest.id, manifest); records.set(manifest.id, { manifest, state: "registered", provided: [], contributions: [] }); initializeConfigIntent(manifest); } bump(); await reconcile(); },
    enable,
    retry: async (pluginId) => { const record = records.get(pluginId); if (!record) throw new Error(`Plugin "${pluginId}" is not registered`); record.state = "registered"; record.error = undefined; await start(pluginId); },
    submitIntent: async (pluginId, desiredEnabled): Promise<PluginIntentSubmissionResult> => { const result = await submitIntent(pluginId, desiredEnabled); if (result.status === "accepted" || result.status === "duplicate") await reconcile(); return result; },
    disable: async (pluginId) => {
      const record = records.get(pluginId);
      if (!record) throw new Error(`Plugin "${pluginId}" is not registered`);
      if (required(record.manifest)) return { ok: false, reason: `Plugin "${pluginId}" cannot be disabled` } as const;
      if (options.pluginIntentCoordinator) {
        const result = await submitIntent(pluginId, false);
        if (result.status !== "accepted" && result.status !== "duplicate") return { ok: false, reason: `Could not disable plugin "${pluginId}": ${result.status}` } as const;
      } else {
        writeConfigIntent(pluginId, false);
      }
      const plan = collectStopPlan(pluginId);
      // First revoke the whole transitive plan synchronously.  Only after all
      // providers and consumers are fenced do we await their cleanup.
      for (const item of plan) {
        const reason = item.manifest.id === pluginId ? "plugin disabled" : `dependency ${pluginId} disabled`;
        beginStop(item, reason);
      }
      await Promise.all(plan.map((item) => stopAfterBegin(item, item.manifest.id === pluginId ? "plugin disabled" : `dependency ${pluginId} disabled`, item.manifest.id !== pluginId)));
      return { ok: true } as const;
    },
    suspend: async (pluginId, reason = "runtime identity changed") => { const record = records.get(pluginId); if (record) await stop(record, reason, true); },
    unregister: async (pluginId) => { const record = records.get(pluginId); if (!record) return; if (required(record.manifest)) throw new Error(`Plugin "${pluginId}" cannot be unregistered`); await host.disable(pluginId); records.delete(pluginId); known.delete(pluginId); bump(); },
    dispose: (reason = "plugin host disposed") => { if (disposePromise) return disposePromise; disposed = true; disposePromise = (async () => { for (const record of [...records.values()].reverse()) await stop(record, reason, false); return rootScope.dispose({ reason, timeoutMs: options.lifecycleCleanupTimeoutMs }); })(); return disposePromise; },
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
          configuredEnabled: provider ? desired(provider.manifest) : undefined,
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
      if (capabilityBridge && !capabilityBridge.services().some((service) => service.kind === capability.kind && service.capabilityId === capability.id && service.contractVersion === capability.version) && !capabilities.has(capability)) return undefined;
      if (!capabilityBridge && !capabilities.has(capability)) return undefined;
      return host.capability(capability);
    },
    attachRemote(bridge) { capabilityBridge?.invalidate("Remote bridge replaced"); capabilityBridge = bridge; bump(); },
    detachRemote(reason = "Remote bridge detached") { capabilityBridge?.invalidate(reason); capabilityBridge = undefined; bump(); },
    registerImplementation(implementation) {
      const registry = options.runtimeUnitImplementationRegistry as (RuntimeUnitImplementationRegistry & { register?: (implementation: { pluginId: string; unitId: string; setup: PluginSetup; capabilities?: readonly Capability[] }) => void }) | undefined;
      if (!registry?.register) throw new Error("This Host was not created with an advanced implementation registry");
      registry.register(implementation);
    },
    inspect() { return { runtimeId, runtimeKind, runtimeInstanceId, version: versionCounter, pluginCount: known.size, peerCount: 0, pendingCallCount: 0, activeStreamCount: 0, plugins: [...known.keys()].sort().map((id) => host.state(id)) }; },
    explain(target) { const id = typeof target === "string" ? target : target.id; const record = records.get(id); if (!record) return { target: id, reasons: ["unknown"] }; const blocked = record.blockedBy ?? []; return { target: id, state: record.state, reasons: blocked.length > 0 ? blocked : record.error ? [record.error] : [] }; },
  };

  if (options.pluginIntentCoordinator) options.pluginIntentCoordinator.subscribe((snapshot) => { intentSnapshot = snapshot; void reconcile(); bump(); });
  configStore.subscribe((snapshot) => {
    // Required/immutable contracts cannot be disabled by stale or externally
    // edited local config.  Normalize the durable value before reconciling so
    // the next bootstrap sees the same truth.
    if (internalConfigWrites.size === 0 && !options.pluginIntentCoordinator) {
      for (const record of records.values()) {
        if (required(record.manifest) && snapshot[record.manifest.id] !== true) writeConfigIntent(record.manifest.id, true);
      }
    }
    if (internalConfigWrites.size === 0) void reconcile();
  });
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
  /** 启动插件。 */
  enable(pluginId: string): Promise<void>;
  /** 重试失败插件。 */
  retry(pluginId: string): Promise<void>;
  /** 提交启停意图。 */
  submitIntent(pluginId: string, desiredEnabled: boolean): Promise<PluginIntentSubmissionResult>;
  /** 停止插件及反向依赖者。 */
  disable(pluginId: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** 撤销当前实例但保留启用意图。 */
  suspend(pluginId: string, reason?: string): Promise<void>;
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
  /** 绑定一个 SharedWorker remote bridge。 */
  attachRemote(bridge: CapabilityBridge): void;
  /** 撤销当前 remote bridge。 */
  detachRemote(reason?: string): void;
  /** advanced 分阶段注册当前 realm implementation。 */
  registerImplementation(implementation: { readonly pluginId: string; readonly unitId: string; readonly setup: PluginSetup; readonly capabilities?: readonly Capability[] }): void;
  /** 结构化诊断。 */
  inspect(): HostInspection;
  /** 解释插件或 capability。 */
  explain(target: string | CapabilityDescriptor): { readonly target: string; readonly state?: PluginStateKind; readonly reasons: readonly string[] };
}
