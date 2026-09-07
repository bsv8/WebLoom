// WebLoom 核心公共入口；不导入 React，也不导入浏览器路由。

export * from "./contracts/plugin.js";
export * from "./contracts/lifecycle.js";
export * from "./contracts/messageBus.js";
export * from "./contracts/resource.js";

export * from "./host/capabilityRegistry.js";
export * from "./host/pluginGraph.js";
export * from "./host/createPluginHost.js";
export * from "./host/runtimeUnitImplementationRegistry.js";

export * from "./messaging/messageBus.js";

export * from "./lifecycle/resourceScope.js";
export * from "./lifecycle/scopedMessageBus.js";
export * from "./lifecycle/permissionLease.js";
export * from "./lifecycle/permissionVerifier.js";
export * from "./lifecycle/pluginIntentController.js";
export * from "./lifecycle/taskScheduler.js";
export * from "./lifecycle/scopedRegistry.js";
export * from "./lifecycle/upgradeGate.js";

export * from "./transport/serviceBridge.js";
export * from "./transport/messagePortServiceTransport.js";
export * from "./transport/messagePortServiceProvider.js";

export * from "./resources/resourceRegistry.js";
export * from "./resources/resourceStore.js";
