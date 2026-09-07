// packages/runtime/src/react/useRegistry.ts
// 通用 registry 读取 hook：基于 host.version 重新计算 selector 输出。
//
// 硬切换 001：runtime 进入热卸载模型后，host 可能在 React 挂载后变化。
// 我们用 useHostVersion() 触发重新计算；selector 仍然纯同步（host 是稳定
// 引用），不会出现 useSyncExternalStore 那种 snapshot 误判。
//
// 用法：
//   const routes = useRegistry(h => h.routes.list());
//   const route = useRegistry(h => h.routes.byPath('/poker'));
// 不再假定"host 挂载后不变"。

import { useMemo } from "react";
import type { PluginHost } from "../host/createPluginHost.js";
import { usePluginHost, useHostVersion } from "./PluginHostProvider.js";

export function useRegistry<T>(selector: (host: PluginHost) => T): T {
  const host = usePluginHost();
  const version = useHostVersion();
  // version 变化时强制重算 selector；selector host 是稳定引用。
  return useMemo(() => selector(host), [version, host, selector]);
}
