import { useCallback, useSyncExternalStore } from "react";
import type { Capability, CapabilityClient } from "../contracts/capability.js";
import { useWebLoomApp } from "./PluginHostProvider.js";

function subscribeApp(app: { subscribe(listener: () => void): () => void }, listener: () => void): () => void {
  return app.subscribe(listener);
}

/** 获取 typed capability；远程 proxy 的构造本身不等待 Worker。 */
export function useCapability<C extends Capability>(capability: C): CapabilityClient<C> {
  const app = useWebLoomApp();
  const subscribe = useCallback((listener: () => void) => subscribeApp(app, listener), [app]);
  const getSnapshot = useCallback(() => (app as unknown as { capability<C extends Capability>(capability: C): CapabilityClient<C> }).capability(capability), [app, capability]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** 当前目录没有 capability 时返回 undefined。 */
export function useOptionalCapability<C extends Capability>(capability: C): CapabilityClient<C> | undefined {
  const app = useWebLoomApp();
  const subscribe = useCallback((listener: () => void) => subscribeApp(app, listener), [app]);
  const getSnapshot = useCallback(() => (app as unknown as { optionalCapability<C extends Capability>(capability: C): CapabilityClient<C> | undefined }).optionalCapability(capability), [app, capability]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** 对 typed capability 做当前目录查询。 */
export function useHasCapability<C extends Capability>(capability: C): boolean {
  return useOptionalCapability(capability) !== undefined;
}
