// 运行单元实现注册表。
//
// contracts 只描述 get() 契约；这里提供 Window / Worker 装配层可复用的
// Map 实现。实现函数和产品静态描述分开保存，避免 manifest 被当成可执行目录。

import type { Capability } from "../contracts/capability.js";
import type { PluginSetup, RuntimeUnitImplementationRegistry } from "../contracts/plugin.js";

export interface RuntimeUnitImplementation {
  /** 产品标识。 */
  pluginId: string;
  /** 稳定运行单元标识。 */
  unitId: string;
  /** 当前环境的可执行入口。 */
  setup: PluginSetup;
  /** 当前 realm 的 typed capability 定义。 */
  capabilities?: readonly Capability[];
}

function implementationKey(pluginId: string, unitId: string): string {
  return `${pluginId}\u0000${unitId}`;
}

/** 创建一个拒绝重复注册、按产品和单元查找实现的运行时注册表。 */
export function createRuntimeUnitImplementationRegistry(
  implementations: readonly RuntimeUnitImplementation[] = [],
): RuntimeUnitImplementationRegistry & {
  register(implementation: RuntimeUnitImplementation): void;
  unregister(pluginId: string, unitId: string): void;
} {
  const entries = new Map<string, RuntimeUnitImplementation>();
  const register = (implementation: RuntimeUnitImplementation): void => {
    const key = implementationKey(implementation.pluginId, implementation.unitId);
    if (entries.has(key)) throw new Error(`运行单元实现重复注册: ${implementation.pluginId}/${implementation.unitId}`);
    entries.set(key, { ...implementation, capabilities: implementation.capabilities ? Object.freeze([...implementation.capabilities]) : undefined });
  };
  for (const implementation of implementations) register(implementation);

  return {
    get(pluginId, unitId) {
      return entries.get(implementationKey(pluginId, unitId))?.setup;
    },
    getCapabilities(pluginId, unitId) {
      return entries.get(implementationKey(pluginId, unitId))?.capabilities;
    },
    register,
    unregister(pluginId, unitId) {
      entries.delete(implementationKey(pluginId, unitId));
    },
  };
}
