// 假 Storage 后台 Worker（独立 SharedWorker 槽位，PSM-R11–R13）。
//
// 与假 Vault Worker 是两个不同的 SharedWorker 入口。Storage 的公开服务与私有函数
// 分开：私有函数不在 provides 里，只通过所属单元的私有入口解析。

import { startSharedWorkerApp } from "../../src/index.ts";
import { implementationsForRuntime } from "../../src/advanced.ts";
import { StorageFiles, StorageListAll } from "./plugin-package-contracts.ts";
import { storagePackage, workerPrivateGrants } from "./plugin-packages.ts";

startSharedWorkerApp({
  id: "fixture-storage-runtime",
  // Worker realm 只装配插件包的 Worker 单元：provides 与私有入口都来自同一个 pluginId。
  plugins: implementationsForRuntime(storagePackage, "shared-worker"),
  // 接收端持有票据：只有带票据的私有入口调用才会执行 handler。
  privateCapabilities: workerPrivateGrants().filter((grant) => grant.pluginId === "fixture-storage"),
  // 私有入口也要在目录里可见，跨 realm 才连得上；授权只发生在所属单元。
  expose: [StorageFiles, StorageListAll],
});
