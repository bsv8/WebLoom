// React 绑定只保存 App，不复制一套 Host 状态。

import { createContext, type ReactNode, useContext } from "react";
import type { AppLike, RuntimeHandle, WindowApp } from "../runtime/runtimeTypes.js";

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
  const app = useContext(WebLoomContext);
  if (!app) throw new Error("WebLoomProvider is missing");
  return app;
}

/** app 状态的稳定外部订阅；hook 实现按 selector 再做引用保持。 */
export function useAppSubscription(): WebLoomApp {
  return useWebLoomApp();
}
