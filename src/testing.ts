// 无领域含义的测试辅助入口。

export * from "./host/createPluginHost.js";
export * from "./host/runtimeUnitImplementationRegistry.js";
export * from "./lifecycle/resourceScope.js";
export * from "./lifecycle/pluginIntentController.js";
export * from "./messaging/messageBus.js";
export * from "./host/capabilityRegistry.js";
export * from "./transport/serviceBridge.js";
export * from "./transport/messagePortServiceTransport.js";
export { createResourceRegistry } from "./resources/resourceRegistry.js";
export { createResourceStore } from "./resources/resourceStore.js";
export * from "./testing/fakes.js";
export { connectSharedWorkerForTesting } from "./runtime/connectSharedWorker.js";
export type { SharedWorkerFactory } from "./runtime/connectSharedWorker.js";
