// WebLoom v4 核心公共入口；不加载 React、Host 装配细节或 Runtime wire。

export * from "./contracts/capability.js";
export * from "./contracts/plugin.js";
export * from "./contracts/lifecycle.js";
export * from "./contracts/messageBus.js";
export * from "./contracts/resource.js";

export { defineCapability } from "./contracts/capability.js";
export { definePlugin } from "./authoring/definePlugin.js";
export type { DefinePluginOptions } from "./authoring/definePlugin.js";
export type { RuntimePluginDefinition } from "./runtime/pluginDefinitions.js";

export { createWindowApp } from "./runtime/windowRuntime.js";
export type { CreateWindowAppOptions } from "./runtime/windowRuntime.js";
export { connectSharedWorker } from "./runtime/connectSharedWorker.js";
export type { ConnectSharedWorkerOptions, SharedWorkerLike } from "./runtime/connectSharedWorker.js";
export { startSharedWorkerApp } from "./runtime/sharedWorkerHost.js";
export type { StartSharedWorkerAppOptions, SharedWorkerApp, PeerController, PeerExposureOptions } from "./runtime/sharedWorkerHost.js";
export type { AppLike, WindowApp, RuntimeHandle, RuntimeStatusSnapshot, RuntimeStatusListener } from "./runtime/runtimeTypes.js";
export { RuntimeInitializationError, RuntimeUnavailableError } from "./runtime/runtimeTypes.js";

export { createMessageBus } from "./messaging/messageBus.js";
export { createLifecycleScope, createResourceScope } from "./lifecycle/resourceScope.js";
