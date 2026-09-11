// WebLoom 通用资源缓存契约。

import { defineCapability } from "./capability.js";

/** 资源键：稳定、可比较且不含秘密的字符串元组。 */
export type ResourceKey = readonly [resourceId: string, ...parts: readonly string[]];

/** 资源当前状态。 */
export type ResourceStatus = "pending" | "ready" | "stale" | "error" | "blocked";

/** 资源快照：状态、数据、错误和单调修订。 */
export interface ResourceSnapshot<T> {
  /** 资源键。 */
  readonly key: ResourceKey;
  /** 当前加载状态。 */
  readonly status: ResourceStatus;
  /** 当前数据；未 ready 时可以为空。 */
  readonly data: T | undefined;
  /** 稳定错误码和可展示错误信息。 */
  readonly error?: { readonly code: string; readonly message: string };
  /** 快照修订，每次有效变化递增。 */
  readonly revision: number;
}

/** 资源读取上下文；只提供通用 capability 和宿主扩展属性。 */
export interface ResourceContext<TAttributes extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>> {
  /** 读取已注入的 capability；不存在时返回 undefined。 */
  getCapability<T>(id: string): T | undefined;
  /** 资源定义所属的插件实例标识；由注册表绑定，插件不能伪造。 */
  readonly ownerId: string;
  /** 宿主绑定的当前作用域属性；资源定义不能写入。 */
  readonly attributes: TAttributes;
}

/** Runtime-only metadata used to bind a definition to an owner. */
export const RESOURCE_OWNER = Symbol("webloom.resource.owner");
export type OwnedResourceDefinition = ResourceDefinition<unknown, readonly string[]> & {
  readonly [RESOURCE_OWNER]?: string;
};

/** 资源定义：描述键、加载、失效订阅与比较方式。 */
export interface ResourceDefinition<T, TArgs extends readonly string[] = readonly string[]> {
  /** 资源唯一标识。 */
  readonly id: string;
  /** 资源所依附的生命周期标签，由宿主解释。 */
  readonly scope: string;
  /** 生成资源键。 */
  key(args: TArgs, context: ResourceContext): ResourceKey;
  /** 加载资源数据；实现必须响应 signal。 */
  load(args: TArgs, context: ResourceContext, signal: AbortSignal): Promise<T>;
  /** 订阅失效事件；只表达失效，不直接改写快照。 */
  subscribe?(args: TArgs, context: ResourceContext, invalidate: () => void): () => void;
  /** 语义相等判断；返回 true 时不发布新数据快照。 */
  equals?(previous: T | undefined, next: T | undefined): boolean;
  /** 同一事件循环内是否合并失效通知。 */
  readonly invalidation: "immediate" | "microtask";
}

/** 资源定义注册表。 */
export interface ResourceRegistry {
  /** 注册资源定义。 */
  register<T, TArgs extends readonly string[]>(definition: ResourceDefinition<T, TArgs>): void;
  /** 注销资源定义。 */
  unregister(id: string): void;
  /** 查询资源定义。 */
  get<T, TArgs extends readonly string[]>(id: string): ResourceDefinition<T, TArgs> | undefined;
  /** 调试和宿主清理使用的定义标识。 */
  _ids(): string[];
}

/** Host 内置的 typed Resource Registry capability。 */
export const RESOURCE_REGISTRY = defineCapability<ResourceRegistry>({
  kind: "local",
  id: "webloom.resource.registry",
  version: "1",
});
