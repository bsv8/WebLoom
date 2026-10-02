// React 绑定子入口；核心入口不会加载 React。

export * from "./react/PluginHostProvider.js";
// 插件实例消费边界只公开 Provider、三个 hooks 和 Props 类型；内部 context、
// usePluginConsumer 与 useIsInsidePluginBoundary 属于防误用实现细节，
// 不作为公共 API 扩散到下游。
export { PluginConsumerProvider, type PluginConsumerProviderProps } from "./react/PluginConsumerProvider.js";
export { usePluginCapability, useOptionalPluginCapability, useHasPluginCapability } from "./react/usePluginCapability.js";
export * from "./react/useCapability.js";
export * from "./react/useRegistry.js";
export * from "./react/usePluginRuntime.js";
export * from "./react/useResource.js";
export * from "./react/useResourceSelector.js";
export * from "./react/renderCounter.js";
