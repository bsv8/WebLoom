// packages/runtime/src/react/usePluginRuntime.ts
// 插件运行时操作 hook。
// 设计缘由（硬切换 001）：
//   - UI 层（plugin manager）需要 enable / disable 插件。
//   - 业务组件可能需要查 graph / state。
//   - 把这些操作收拢到 hook，调用方拿到的是一个稳定 API 对象。

import { useMemo } from "react";
import type { PluginGraph, PluginState, PluginReverseDep, PluginManifest } from "../contracts/plugin.js";
import type { PluginIntentSubmissionResult } from "../contracts/lifecycle.js";
import type { PluginHost } from "../host/createPluginHost.js";
import { usePluginHost, useHostVersion } from "./PluginHostProvider.js";

export interface UsePluginRuntime {
  state(id: string): PluginState;
  graph(): PluginGraph;
  reverseDeps(id: string): PluginReverseDep[];
  enable(id: string): Promise<void>;
  disable(id: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** 提交产品级绝对启停意图；accepted 只表示意图已持久化。 */
  submitIntent(id: string, desiredEnabled: boolean): Promise<PluginIntentSubmissionResult>;
  unregister(id: string): Promise<void>;
  version(): number;
  manifests(): string[];
  installed(): string[];
  isEnabled(id: string): boolean;
  /** 拿单条 plugin 的 manifest。id 未知时返回 undefined。 */
  getManifest(id: string): PluginManifest | undefined;
  /**
   * 探测 capability 是否存在。供 UI 判断"依赖的 capability 是否满足"，
   * 依赖列表里写的是 capability key（如 "route.registry"），不是 plugin id。
   */
  hasCapability(key: string): boolean;
}

export function usePluginRuntime(): UsePluginRuntime {
  const host = usePluginHost();
  const version = useHostVersion();
  return useMemo<UsePluginRuntime>(() => {
    const api: UsePluginRuntime = {
      state(id) {
        return host.state(id);
      },
      graph() {
        return host.graph();
      },
      reverseDeps(id) {
        return host.reverseDeps(id);
      },
      enable(id) {
        return host.enable(id);
      },
      disable(id) {
        return host.disable(id);
      },
      submitIntent(id, desiredEnabled) {
        return host.submitIntent(id, desiredEnabled);
      },
      unregister(id) {
        return host.unregister(id);
      },
      version() {
        return host.version();
      },
      manifests() {
        return host.manifests();
      },
      installed() {
        return host.installed();
      },
      isEnabled(id) {
        return host.state(id).kind === "enabled";
      },
      getManifest(id) {
        return host.getManifest(id);
      },
      hasCapability(key) {
        return host.capabilities.has(key);
      }
    };
    return api;
  }, [host, version]);
}

/** 旧调用方兼容：单纯拿 host 引用。 */
export function useHost(): PluginHost {
  return usePluginHost();
}
