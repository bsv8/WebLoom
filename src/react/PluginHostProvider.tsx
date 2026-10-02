// React 绑定只保存 App，不复制一套 Host 状态。

import { createContext, type ReactNode, useContext } from "react";
import type { AppLike, RuntimeHandle, WindowApp } from "../runtime/runtimeTypes.js";
import { PluginConsumerContext } from "./PluginConsumerProvider.js";

export type WebLoomApp = WindowApp | RuntimeHandle;
export const WebLoomContext = createContext<WebLoomApp | undefined>(undefined);

export interface WebLoomProviderProps {
  /** 稳定的 WindowApp 或 RuntimeHandle。 */
  readonly app: WebLoomApp;
  /** React 子树。 */
  readonly children: ReactNode;
}

export function WebLoomProvider({ app, children }: WebLoomProviderProps) {
  return <WebLoomContext.Provider value={app}>{children}</WebLoomContext.Provider>;
}

export function useWebLoomApp(): WebLoomApp {
  // App hook 服务可信装配层。插件子树里调用它几乎总是想拿“全局 App”绕过
  // 实例边界，因此直接拒绝，而不是静默把 global API 当成 plugin API。
  const pluginConsumer = useContext(PluginConsumerContext);
  if (pluginConsumer) throw new Error("useWebLoomApp is not available inside PluginConsumerProvider");
  const app = useContext(WebLoomContext);
  if (!app) throw new Error("WebLoomProvider is missing");
  return app;
}

/** app 状态的稳定外部订阅；hook 实现按 selector 再做引用保持。 */
export function useAppSubscription(): WebLoomApp {
  return useWebLoomApp();
}
