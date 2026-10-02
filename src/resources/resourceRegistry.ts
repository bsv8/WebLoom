/**
 * 资源注册表实现
 *
 * 设计缘由：管理资源定义的注册和查询，支持 owner-aware 生命周期。
 * 重复 id 抛错，disable 时可回收。
 */

import type {
  OwnedResourceDefinition,
  ResourceDefinition,
  ResourceRegistry,
} from "../contracts/resource.js";
import { RESOURCE_OWNER as RESOURCE_OWNER_KEY } from "../contracts/resource.js";

/**
 * 宿主登记的资源使用的保留 owner 标识。
 *
 * 统一放在这里，避免“底层注册表写空串、Store 认保留常量”两套标识：任何
 * 一侧判断 owner 是否为空时都得到同一个值。
 */
export const UNOWNED_RESOURCE_OWNER = "__unowned__";

/** 资源注册表实现 */
export function createResourceRegistry(): ResourceRegistry {
  const definitions = new Map<string, OwnedResourceDefinition>();

  function registerOwned<T, TArgs extends readonly string[]>(
    ownerId: string,
    definition: ResourceDefinition<T, TArgs>
  ): void {
    if (definitions.has(definition.id)) {
      throw new Error(
        `Resource definition "${definition.id}" is already registered`
      );
    }
    // Keep ownership outside the public definition object. The object is copied
    // so a plugin cannot mutate the definition after registration to change it.
    const owned = Object.assign({}, definition) as OwnedResourceDefinition;
    Object.defineProperty(owned, RESOURCE_OWNER_KEY, {
      value: ownerId,
      enumerable: false,
      writable: false,
      configurable: false,
    });
    definitions.set(definition.id, owned);
  }

  return {
    _registerOwned: registerOwned,
    register<T, TArgs extends readonly string[]>(
      definition: ResourceDefinition<T, TArgs>
    ): void {
      // Direct registry users have no plugin identity. Host-provided facades use
      // registerOwned below and are the only path used by plugin setup.
      registerOwned(UNOWNED_RESOURCE_OWNER, definition);
    },

    unregister(id: string): void {
      definitions.delete(id);
    },

    /**
     * 只在 owner 仍匹配时注销；用于实例撤销清理，避免旧实例的清理误删
     * 同名插件重新启用后新实例登记的定义。
     */
    _unregisterOwned(ownerId: string, id: string): boolean {
      const current = definitions.get(id)?.[RESOURCE_OWNER_KEY];
      if (current !== ownerId) return false;
      return definitions.delete(id);
    },

    get<T, TArgs extends readonly string[]>(
      id: string
    ): ResourceDefinition<T, TArgs> | undefined {
      return definitions.get(id) as ResourceDefinition<T, TArgs> | undefined;
    },

    /** 获取所有已注册的资源定义 id（用于 ownership 快照） */
    _ids(): string[] {
      return Array.from(definitions.keys());
    },

    /** 读取一个定义实际登记的 owner 实例；未登记返回 undefined。 */
    _ownerOf(id: string): string | undefined {
      return definitions.get(id)?.[RESOURCE_OWNER_KEY];
    },
  } as ResourceRegistry & {
    _registerOwned: typeof registerOwned;
    _unregisterOwned(ownerId: string, id: string): boolean;
    _ownerOf(id: string): string | undefined;
  };
}

/** Internal runtime hook; deliberately absent from ResourceRegistry's public type. */
export function registerOwnedResource(
  registry: ResourceRegistry,
  ownerId: string,
  definition: ResourceDefinition<any, any>
): void {
  const internal = registry as ResourceRegistry & {
    _registerOwned?: (owner: string, definition: ResourceDefinition<any, any>) => void;
  };
  if (!internal._registerOwned) {
    // 插件路径不允许退回到 registry.register()：那会把插件资源登记成 unowned，
    // 之后任何装配层查询都会把它误当成宿主资源。自定义 registry 必须实现
    // _registerOwned 才有实例归属。
    throw new Error("Resource registry does not support owner-bound registration; plugin resources cannot be registered without an instance owner");
  }
  internal._registerOwned(ownerId, definition);
}

/**
 * Internal runtime hook; 按 owner 条件注销。
 *
 * 实例撤销时用它清理自己登记的定义：owner 不匹配时返回 false，调用方必须
 * 视为“未清理”，不能据此认为资源已被删除——同名新实例的同名定义不能被
 * 旧实例的清理误删。
 */
export function unregisterOwnedResource(registry: ResourceRegistry, ownerId: string, id: string): boolean {
  const internal = registry as ResourceRegistry & {
    _unregisterOwned?: (owner: string, id: string) => boolean;
  };
  if (!internal._unregisterOwned) return false;
  return internal._unregisterOwned(ownerId, id);
}
