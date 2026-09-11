import { useCallback } from "react";
import type { AppLike } from "../runtime/runtimeTypes.js";
import { useRuntimeSelector } from "./usePluginRuntime.js";
import { useWebLoomApp } from "./PluginHostProvider.js";

/** 从 App 诊断快照派生无领域 selector。 */
export function useRegistry<T>(selector: (app: AppLike) => T): T {
  const app = useWebLoomApp();
  return useRuntimeSelector(() => selector(app));
}
