// packages/runtime/src/capabilityRegistry.ts
// 能力注册表：所有 plugin 服务都通过 capability 提供和消费。
// 关键不变量：
//  - provide 重复必须抛错（防止后注册覆盖先注册）。
//  - require 缺失必须抛错（让插件依赖问题在启动时暴露）。
//  - revoke 后再 has() 必须返回 false（host 在插件 disable 时调用）。
// 设计缘由：把"插件间互相不知道"这件事落到机制上。

export interface CapabilityRegistry {
  provide<T>(key: string, value: T): void;
  /**
   * 硬切换 001：撤销一个 capability。
   * 不存在时 no-op；存在则移除。提供方应保证自己负责的 capability
   * 被撤销时，相关订阅/资源也被清理（这通常由 host 的 plugin teardown
   * 流程负责）。
   */
  revoke(key: string): void;
  get<T>(key: string): T;
  has(key: string): boolean;
  require(key: string): void;
  /** 仅用于调试。 */
  keys(): string[];
}

export function createCapabilityRegistry(): CapabilityRegistry {
  const map = new Map<string, unknown>();

  return {
    provide(key, value) {
      if (map.has(key)) {
        throw new Error(`Capability "${key}" is already provided`);
      }
      map.set(key, value);
    },
    revoke(key) {
      if (!map.has(key)) return;
      map.delete(key);
    },
    get(key) {
      if (!map.has(key)) {
        throw new Error(`Capability "${key}" is not available`);
      }
      return map.get(key) as never;
    },
    has(key) {
      return map.has(key);
    },
    require(key) {
      if (!map.has(key)) {
        throw new Error(`Required capability "${key}" is missing`);
      }
    },
    keys() {
      return [...map.keys()];
    }
  };
}
