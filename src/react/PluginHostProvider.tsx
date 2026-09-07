// packages/runtime/src/react/PluginHostProvider.tsx
// 把 PluginHost 注入 React 树。
// 设计缘由：组件层只通过 hooks 访问能力，不要直接 import 内部模块。
// 硬切换 001：host 进入运行期可卸载，host.version 变化要触发订阅者重渲染。

import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import type { PluginHost } from "../host/createPluginHost.js";

export const PluginHostContext = createContext<PluginHost | undefined>(undefined);

export interface PluginHostProviderProps {
  host: PluginHost;
  children: ReactNode;
}

export function PluginHostProvider({ host, children }: PluginHostProviderProps) {
  // 订阅 host 变化：每次 enable / disable / unregister 后 bump version，
  // 我们把 version 透到 state 触发子树重渲染（hooks 自身也用 useHostVersion）。
  const [version, setVersion] = useState<number>(host.version());
  useEffect(() => {
    return host.subscribe((snap) => {
      setVersion(snap.version);
    });
  }, [host]);
  // version 仅作为"key 变化"挂在这里，不再通过 context 暴露（避免误用）。
  void version;
  return <PluginHostContext.Provider value={host}>{children}</PluginHostContext.Provider>;
}

export function usePluginHost(): PluginHost {
  const host = useContext(PluginHostContext);
  if (!host) throw new Error("PluginHostContext is missing");
  return host;
}

/**
 * 订阅 host.version：host 每次 enable / disable / unregister 后 version 递增，
 * 订阅组件会重新渲染。这是"硬切换 001"让 React 层感知 host 变化的关键 hook。
 */
export function useHostVersion(): number {
  const host = usePluginHost();
  const [v, setV] = useState<number>(host.version());
  useEffect(() => host.subscribe((s) => setV(s.version)), [host]);
  return v;
}
