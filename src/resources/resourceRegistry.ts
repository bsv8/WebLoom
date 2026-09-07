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
      registerOwned("", definition);
    },

    unregister(id: string): void {
      definitions.delete(id);
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
  } as ResourceRegistry & {
    _registerOwned: typeof registerOwned;
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
    // Fallback is only for custom registries used by tests/adapters.
    registry.register(definition);
    return;
  }
  internal._registerOwned(ownerId, definition);
}
