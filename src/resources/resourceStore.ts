// WebLoom Resource Store 实现。
//
// 负责加载去重、取消、修订、失效通知和按实例 owner 清理。资源的 scope
// 和 attributes 完全由宿主定义，Store 不猜测任何领域身份。

import type {
  ResourceContext,
  ResourceDefinition,
  ResourceKey,
  ResourceRegistry,
  ResourceSnapshot,
} from "../contracts/resource.js";
import { RESOURCE_OWNER } from "../contracts/resource.js";
import type { Capability, CapabilityClient } from "../contracts/capability.js";
import { UNOWNED_RESOURCE_OWNER } from "./instanceResourceRegistry.js";

interface ResourceRecord<T = unknown> {
  snapshot: ResourceSnapshot<T>;
  inFlight: Promise<T> | null;
  abortController: AbortController | null;
  subscribers: Set<() => void>;
  invalidationScheduled: boolean;
  loadRevision: number;
  owner: string;
  providerUnsubscribe: (() => void) | null;
}

/** Resource Store 公共 API。 */
export interface ResourceStoreApi {
  /** 确保资源已加载，并返回当前快照。 */
  ensure<T>(definitionId: string, args: readonly string[]): ResourceSnapshot<T>;
  /** 订阅资源变更。 */
  subscribe(definitionId: string, args: readonly string[], callback: () => void): () => void;
  /** 读取资源快照，不触发加载。 */
  read<T>(definitionId: string, args: readonly string[]): ResourceSnapshot<T> | undefined;
  /** 使资源失效并重新加载。 */
  invalidate(definitionId: string, args: readonly string[]): void;
  /** 清理指定 owner 的所有资源记录。 */
  disposeOwner(ownerId: string): void;
  /** 宿主属性或 capability 变化后刷新绑定。 */
  refreshRuntimeBindings(): void;
  /** 订阅宿主 Context 变化。 */
  subscribeContext(callback: () => void): () => void;
}

type Attributes = Readonly<Record<string, unknown>>;

/**
 * 资源上下文的能力解析回调。
 *
 * `ownerId` 是资源定义所属的真实插件实例；实现方必须按该实例的 consumer
 * 解析，并在 owner 已撤销时抛错，而不是退回全局字符串查询。
 */
export type ResourceCapabilityResolver = <C extends Capability>(ownerId: string, capability: C, optional: boolean) => CapabilityClient<C> | undefined;

/**
 * owner 有效性检查回调。
 *
 * key/load/subscribe 三个阶段都先调用它：owner 实例已撤销时直接抛错，
 * 不会被 `optionalCapability` 当成“已声明但暂时缺席”吞掉，也不会退化成
 * 宿主资源解析。
 */
export type ResourceOwnerAssert = (ownerId: string) => void;

function createContext(
  ownerId: string,
  resolveCapability: ResourceCapabilityResolver,
  getAttributes: (ownerId?: string) => Attributes,
): ResourceContext {
  return {
    capability(capability: Capability) {
      return resolveCapability(ownerId, capability, false) as CapabilityClient<never>;
    },
    optionalCapability(capability: Capability) {
      return resolveCapability(ownerId, capability, true) as CapabilityClient<never> | undefined;
    },
    attributes: getAttributes(ownerId),
    ownerId,
  } as ResourceContext & { ownerId: string };
}

function recordKey(definitionId: string, key: ResourceKey): string {
  return `${definitionId}::${key.join("::")}`;
}

/** 读取定义实际登记的 owner；未登记的宿主资源使用保留标识。 */
function ownerOf(definition: ResourceDefinition<unknown, readonly string[]>): string {
  return (definition as ResourceDefinition<unknown, readonly string[]> & { [RESOURCE_OWNER]?: string })[RESOURCE_OWNER] ?? UNOWNED_RESOURCE_OWNER;
}

function defaultEquals(a: unknown, b: unknown): boolean {
  return Object.is(a, b);
}

/** 创建通用 Resource Store。 */
export function createResourceStore(
  registry: ResourceRegistry,
  resolveCapability: ResourceCapabilityResolver,
  getAttributes: (ownerId?: string) => Attributes = () => ({}),
  assertOwnerActive: ResourceOwnerAssert = () => undefined,
): ResourceStoreApi {
  const records = new Map<string, ResourceRecord>();
  const microtaskQueue = new Map<string, { definitionId: string; args: readonly string[] }>();
  const contextSubscribers = new Set<() => void>();
  let microtaskScheduled = false;

  const notify = (record: ResourceRecord): void => {
    for (const subscriber of [...record.subscribers]) {
      try { subscriber(); } catch { /* 观察者不能改变资源状态。 */ }
    }
  };

  const notifyContext = (): void => {
    for (const subscriber of [...contextSubscribers]) {
      try { subscriber(); } catch { /* 观察者不能改变资源状态。 */ }
    }
  };

  const cleanupRecord = (record: ResourceRecord): void => {
    record.abortController?.abort();
    record.providerUnsubscribe?.();
    record.providerUnsubscribe = null;
  };

  const contextFor = (definition: ResourceDefinition<unknown, readonly string[]>): ResourceContext =>
    createContext(ownerOf(definition), resolveCapability, getAttributes);

  /**
   * 取定义实际登记的 owner，并确认该 owner 仍有效。
   *
   * 已撤销的 owner 在这里直接抛错：key/load/subscribe 都不会再跑，缓存与
   * 在途加载也不会因为 ownerId 查不到就降级成宿主 unowned 资源。
   */
  const liveContextFor = (definition: ResourceDefinition<unknown, readonly string[]>): ResourceContext => {
    const context = contextFor(definition);
    assertOwnerActive(context.ownerId);
    return context;
  };

  const getOrCreateRecord = <T>(
    definition: ResourceDefinition<T, readonly string[]>,
    args: readonly string[],
  ): ResourceRecord<T> => {
    const context = liveContextFor(definition as ResourceDefinition<unknown, readonly string[]>);
    const key = definition.key(args, context);
    const keyString = recordKey(definition.id, key);
    const current = records.get(keyString) as ResourceRecord<T> | undefined;
    if (current) {
      if (definition.subscribe && !current.providerUnsubscribe) {
        current.providerUnsubscribe = definition.subscribe(args, context, () => {
          scheduleInvalidation(definition.id, args);
        });
      }
      return current;
    }

    const record: ResourceRecord<T> = {
      snapshot: { key, status: "pending", data: undefined, revision: 0 },
      inFlight: null,
      abortController: null,
      subscribers: new Set(),
      invalidationScheduled: false,
      loadRevision: 0,
      owner: ownerOf(definition as ResourceDefinition<unknown, readonly string[]>),
      providerUnsubscribe: null,
    };
    records.set(keyString, record);
    if (definition.subscribe) {
      record.providerUnsubscribe = definition.subscribe(args, context, () => {
        scheduleInvalidation(definition.id, args);
      });
    }
    return record;
  };

  const loadResource = <T>(
    definition: ResourceDefinition<T, readonly string[]>,
    args: readonly string[],
    record: ResourceRecord<T>,
  ): void => {
    record.abortController?.abort();
    const context = liveContextFor(definition as ResourceDefinition<unknown, readonly string[]>);
    const key = definition.key(args, context);
    if (record.snapshot.key.join("::") !== key.join("::")) return;

    const abortController = new AbortController();
    const loadRevision = ++record.loadRevision;
    record.abortController = abortController;
    try {
      record.inFlight = Promise.resolve(definition.load(args, context, abortController.signal));
    } catch (error) {
      record.inFlight = Promise.reject(error);
    }
    record.snapshot = { ...record.snapshot, status: "pending", revision: record.snapshot.revision + 1 };
    notify(record);

    record.inFlight.then((data) => {
      if (abortController.signal.aborted || record.loadRevision !== loadRevision) return;
      if (record.snapshot.key.join("::") !== key.join("::")) return;
      const equals = definition.equals ?? defaultEquals;
      const changed = !equals(record.snapshot.data, data);
      record.snapshot = {
        key,
        status: "ready",
        data,
        revision: changed ? record.snapshot.revision + 1 : record.snapshot.revision,
      };
      record.inFlight = null;
      record.abortController = null;
      if (changed) notify(record);
    }).catch((error: unknown) => {
      if (abortController.signal.aborted || record.loadRevision !== loadRevision) return;
      const blocked = error instanceof Error && error.message === "blocked";
      const errorValue = error instanceof Error ? error : new Error(String(error));
      record.snapshot = blocked
        ? { ...record.snapshot, status: "blocked", revision: record.snapshot.revision + 1 }
        : {
            ...record.snapshot,
            status: record.snapshot.data === undefined ? "error" : "stale",
            error: {
              code: typeof (errorValue as Error & { code?: unknown }).code === "string"
                ? String((errorValue as Error & { code?: unknown }).code)
                : "resource.load_failed",
              message: errorValue.message,
            },
            revision: record.snapshot.revision + 1,
          };
      record.inFlight = null;
      record.abortController = null;
      notify(record);
    });
  };

  const invalidateNow = (definitionId: string, args: readonly string[]): void => {
    const definition = registry.get<unknown, readonly string[]>(definitionId);
    if (!definition) return;
    const context = liveContextFor(definition);
    const key = definition.key(args, context);
    const record = records.get(recordKey(definitionId, key));
    if (!record) return;
    record.snapshot = { ...record.snapshot, status: "stale", revision: record.snapshot.revision + 1 };
    notify(record);
    loadResource(definition, args, record);
  };

  const flushInvalidations = (): void => {
    const queue = [...microtaskQueue.values()];
    microtaskQueue.clear();
    microtaskScheduled = false;
    for (const item of queue) invalidateNow(item.definitionId, item.args);
  };

  const scheduleInvalidation = (definitionId: string, args: readonly string[]): void => {
    const definition = registry.get<unknown, readonly string[]>(definitionId);
    if (!definition) return;
    if (definition.invalidation === "immediate") {
      invalidateNow(definitionId, args);
      return;
    }
    const key = recordKey(definitionId, definition.key(args, liveContextFor(definition)));
    if (microtaskQueue.has(key)) return;
    microtaskQueue.set(key, { definitionId, args });
    if (!microtaskScheduled) {
      microtaskScheduled = true;
      queueMicrotask(flushInvalidations);
    }
  };

  const refreshRuntimeBindings = (): void => {
    for (const record of records.values()) cleanupRecord(record);
    records.clear();
    notifyContext();
  };

  return {
    ensure<T>(definitionId: string, args: readonly string[]): ResourceSnapshot<T> {
      const definition = registry.get<T, readonly string[]>(definitionId);
      if (!definition) throw new Error(`Resource definition "${definitionId}" not found`);
      const record = getOrCreateRecord(definition, args);
      if (!record.inFlight && record.snapshot.status === "pending") loadResource(definition, args, record);
      return record.snapshot;
    },
    subscribe(definitionId, args, callback) {
      const definition = registry.get<unknown, readonly string[]>(definitionId);
      if (!definition) return () => undefined;
      let record = getOrCreateRecord(definition, args);
      record.subscribers.add(callback);
      const removeContext = definition.scope === "context"
        ? (() => {
            const listener = () => {
              record.subscribers.delete(callback);
              record = getOrCreateRecord(definition, args);
              record.subscribers.add(callback);
              callback();
            };
            contextSubscribers.add(listener);
            return () => contextSubscribers.delete(listener);
          })()
        : undefined;
      return () => {
        removeContext?.();
        record.subscribers.delete(callback);
        if (record.subscribers.size === 0 && record.providerUnsubscribe) {
          record.providerUnsubscribe();
          record.providerUnsubscribe = null;
        }
        if (record.subscribers.size === 0 && record.abortController) {
          const current = record;
          setTimeout(() => {
            if (current.subscribers.size === 0 && current.abortController) {
              current.abortController.abort();
              current.abortController = null;
              current.inFlight = null;
            }
          }, 100);
        }
      };
    },
    read<T>(definitionId: string, args: readonly string[]) {
      const definition = registry.get<T, readonly string[]>(definitionId);
      if (!definition) return undefined;
      const key = definition.key(args, liveContextFor(definition));
      return (records.get(recordKey(definitionId, key)) as ResourceRecord<T> | undefined)?.snapshot;
    },
    invalidate: scheduleInvalidation,
    disposeOwner(ownerId) {
      for (const [key, record] of records) {
        if (record.owner !== ownerId) continue;
        cleanupRecord(record);
        records.delete(key);
      }
    },
    refreshRuntimeBindings,
    subscribeContext(callback) {
      contextSubscribers.add(callback);
      return () => contextSubscribers.delete(callback);
    },
  };
}
