// 假 Vault 后台 Worker（独立 SharedWorker 槽位，PSM-R12）。
//
// 它与假 Storage Worker 是两个不同的 SharedWorker 入口：同一个页面同时连接两者，
// 挂接顺序不影响服务绑定，断开其中一个也不影响另一个。

import { startSharedWorkerApp } from "../../src/index.ts";
import { implementationsForRuntime } from "../../src/advanced.ts";
import { VaultBalance, VaultListAll } from "./plugin-package-contracts.ts";
import { vaultPackage, workerPrivateGrants } from "./plugin-packages.ts";

startSharedWorkerApp({
  id: "fixture-vault-runtime",
  // Worker realm 只装配插件包的 Worker 单元。
  plugins: implementationsForRuntime(vaultPackage, "shared-worker"),
  privateCapabilities: workerPrivateGrants().filter((grant) => grant.pluginId === "fixture-vault"),
  // 私有入口也必须在目录里可见，否则跨 realm 无从建立；授权仍然只发生在所属单元。
  expose: [VaultBalance, VaultListAll],
});
