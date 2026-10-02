import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { CapabilityDescriptor } from "../contracts/capability.js";
import type { PluginGraph, PluginManifest, PluginReverseDep, PluginState } from "../contracts/plugin.js";
import { hostForWindowApp } from "../runtime/windowRuntime.js";
import type { WindowApp } from "../runtime/runtimeTypes.js";
import { useWebLoomApp } from "./PluginHostProvider.js";

/**
 * 装配层插件运行时视图。
 *
 * 这里只有读取、诊断与生命周期事件，没有用户启停：被装配的插件全部参与系统，是否
 * 运行由依赖图与运行条件决定。需要“释放某实例”时由可信装配层调用 Host 的
 * `revoke()`，React 侧不再提供启停入口。
 */
export interface UsePluginRuntime {
  /** 读取插件状态。 */
  state(id: string): PluginState;
  /** 读取静态图。 */
  graph(): PluginGraph;
  /** 读取反向依赖。 */
  reverseDeps(id: string): readonly PluginReverseDep[];
  /** 删除插件（装配层操作）。 */
  unregister(id: string): Promise<void>;
  /** Host/App 修订。 */
  version(): number;
  /** 插件 id。 */
  manifests(): string[];
  /** 插件 id。 */
  installed(): string[];
  /** 当前是否在运行。 */
  isRunning(id: string): boolean;
  /** 清单。 */
  getManifest(id: string): PluginManifest | undefined;
  /** typed descriptor 当前是否已暴露。 */
  hasCapability(capability: CapabilityDescriptor): boolean;
}

function hostFor(app: WindowApp) {
  return hostForWindowApp(app);
}

/** 插件运行时诊断 hook；只能在 WindowApp（可信装配层）上使用。 */
export function usePluginRuntime(): UsePluginRuntime {
  const app = useWebLoomApp();
  const subscribe = useCallback((listener: () => void) => app.subscribe(listener), [app]);
  const getSnapshot = useCallback(() => app.state(), [app]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return useMemo(() => {
    if (app.runtimeKind !== "window-main") throw new Error("Plugin runtime controls require a WindowApp");
    const host = hostFor(app);
    return {
      state: (id: string) => host.state(id),
      graph: () => host.graph(),
      reverseDeps: (id: string) => host.reverseDeps(id),
      unregister: (id: string) => host.unregister(id),
      version: () => snapshot.revision,
      manifests: () => host.manifests(),
      installed: () => host.installed(),
      isRunning: (id: string) => host.state(id).kind === "enabled",
      getManifest: (id: string) => host.getManifest(id),
      hasCapability: (capability: CapabilityDescriptor) => host.capabilities.has(capability),
    } satisfies UsePluginRuntime;
  }, [app, snapshot.revision]);
}

/** 精确订阅一个插件的状态。 */
export function usePluginState(pluginId: string): PluginState | undefined {
  const app = useWebLoomApp();
  const subscribe = useCallback((listener: () => void) => app.subscribe(listener), [app]);
  const getSnapshot = useCallback(() => app.pluginState?.(pluginId), [app, pluginId]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
/** 读取 App 状态的 selector；无关状态变化保持上一次选择结果。 */
export function useRuntimeSelector<T>(selector: (snapshot: ReturnType<ReturnType<typeof useWebLoomApp>["state"]>) => T, equality: (left: T, right: T) => boolean = Object.is): T {
  const app = useWebLoomApp();
  const last = useMemo(() => ({ has: false, value: undefined as T }), []);
  const subscribe = useCallback((listener: () => void) => app.subscribe(listener), [app]);
  const getSnapshot = useCallback(() => {
    const next = selector(app.state());
    if (last.has && equality(last.value, next)) return last.value;
    last.has = true;
    last.value = next;
    return next;
  }, [app, selector, equality, last]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
