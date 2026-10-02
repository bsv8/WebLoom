// 插件实例消费视图的 React 边界（PCB-R03/PCB-R04）。
//
// 与 WebLoomProvider（App / 可信装配层）不同，这里下发的是某一个真实插件
// 实例的受限消费视图。组件只能在 Provider 子树内按该实例身份读取能力；
// 缺少 Provider 时直接报错，不回退到外围 App Provider。

import { createContext, type ReactNode, useCallback, useContext, useSyncExternalStore } from "react";
import { isIssuedPluginConsumer, type PluginConsumer } from "../contracts/consumer.js";

export const PluginConsumerContext = createContext<PluginConsumer | undefined>(undefined);

export interface PluginConsumerProviderProps {
  /**
   * 框架签发的插件实例消费视图。
   * 只接受 setup/contribution adapter 捕获的真实 consumer；不接收 pluginId
   * 字符串、完整 Host 或 App。
   */
  readonly consumer: PluginConsumer;
  /** React 子树。 */
  readonly children: ReactNode;
}

/**
 * 为一个插件实例的子树提供受限消费入口。
 *
 * 只接受 Host 签发的 consumer：结构相同、字段复制或类型断言得到的普通
 * 对象一律拒绝，避免绕过实例边界。实例被撤销后 Provider 停止渲染旧子树，
 * 已经在里面的组件不再能读到能力；同名重启由新的 consumer 重新挂载。
 */
export function PluginConsumerProvider({ consumer, children }: PluginConsumerProviderProps) {
  if (!isIssuedPluginConsumer(consumer)) {
    throw new Error("PluginConsumerProvider requires a framework-issued PluginConsumer");
  }
  // 快照只在“active / revoked”之间变化，因此引用稳定；撤权通知由 consumer
  // 转发的 Host 版本事件驱动，不轮询，也不在 render 中启停任何插件。
  // subscribe/getSnapshot 的引用必须稳定：每次 render 新建函数会让
  // useSyncExternalStore 在每轮渲染都退订再订阅。
  const subscribe = useCallback((listener: () => void) => consumer.subscribe(listener), [consumer]);
  const getSnapshot = useCallback(() => consumer.status, [consumer]);
  const status = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  if (status === "revoked") return null;
  return <PluginConsumerContext.Provider value={consumer}>{children}</PluginConsumerContext.Provider>;
}

/** 读取当前插件实例的 consumer；缺少 Provider 时报错，不回退到 App。 */
export function usePluginConsumer(): PluginConsumer {
  const consumer = useContext(PluginConsumerContext);
  if (!consumer) throw new Error("PluginConsumerProvider is missing");
  return consumer;
}

/** 判断当前是否位于插件 Provider 子树内；用于拒绝误用 App hook。 */
export function useIsInsidePluginBoundary(): boolean {
  return useContext(PluginConsumerContext) !== undefined;
}
