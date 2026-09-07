// packages/runtime/src/react/useCapability.ts
// 组件读取 capability 的唯一入口。
// 设计缘由：业务组件不得直接调用 host.capabilities.get()，
// 一律通过 hook 走，确保调用路径可观察。
//
// 硬切换 001：capability 在 plugin disable 时被 revoke。
// 组件如果仍然用 has/capability 缓存结果，旧值会"看起来还能用"。
// 改为基于 host.version 重新求值：disable 后 version 递增 -> 重渲染 ->
// has/capability 走新值。

import { useMemo } from "react";
import { usePluginHost, useHostVersion } from "./PluginHostProvider.js";

export function useCapability<T>(key: string): T {
  const host = usePluginHost();
  const version = useHostVersion();
  return useMemo(() => host.capabilities.get<T>(key), [host, version, key]);
}

/** 读取可选兼容 capability；缺失时返回 undefined，不把页面渲染打崩。 */
export function useOptionalCapability<T>(key: string): T | undefined {
  const host = usePluginHost();
  const version = useHostVersion();
  return useMemo(() => host.capabilities.has(key) ? host.capabilities.get<T>(key) : undefined, [host, version, key]);
}

export function useHasCapability(key: string): boolean {
  const host = usePluginHost();
  const version = useHostVersion();
  return useMemo(() => host.capabilities.has(key), [host, version, key]);
}
