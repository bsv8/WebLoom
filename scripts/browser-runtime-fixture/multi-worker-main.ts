// 多 Worker 槽位与所属私有通信的真实浏览器验收（PSM-R11–R13）。
//
// 一个页面同时连接两个真实 SharedWorker（Storage 与 Vault），验证：
//   1. 挂接顺序不影响服务绑定；
//   2. 新增第二个连接不撤销第一个；
//   3. 断开一个槽位不影响另一个；
//   4. 同插件 Web 单元可以用**私有**跨单元入口调用后台私有函数；
//   5. 其他插件、网页插件式调用者与公共解析路径都拿不到私有入口。
//
// 结果写进 window.__WEBLOOM_MULTI_WORKER_RESULT__，由 real-browser-runtime-smoke.mjs 断言。

import storageWorkerUrl from "./storage.worker.ts?sharedworker&url";
import vaultWorkerUrl from "./vault.worker.ts?sharedworker&url";
import { connectSharedWorker } from "../../src/index.ts";
import { bindUnitSlot, bridgeForRuntimeHandle, implementationsForRuntime } from "../../src/advanced.ts";
import { createPluginHost } from "../../src/host/createPluginHost.ts";
import { createWindowAppFromHost } from "../../src/runtime/windowRuntime.ts";
import { createRuntimeUnitImplementationRegistry } from "../../src/host/runtimeUnitImplementationRegistry.ts";
import { StorageFiles, StorageListAll, VaultBalance, VaultListAll } from "./plugin-package-contracts.ts";
import { consumerByUnit, outsiderPlugin, privateDenials, privateGrants, privateResolutionNotes, storagePackage, vaultPackage } from "./plugin-packages.ts";

declare global {
  interface Window {
    __WEBLOOM_MULTI_WORKER_RESULT__?: Record<string, unknown>;
  }
}

/** 让 Host 完成一轮 reconcile 后的界面刷新。 */
const tick = async (): Promise<void> => { await new Promise<void>((resolve) => setTimeout(resolve, 40)); };

let step = "start";
/** 诊断累积：失败时也保留已观测到的中间状态。 */
let diagnostics: Record<string, unknown> = {};
async function run(): Promise<Record<string, unknown>> {
  step = "bind-slots";
  step = "bind-slots";
  const bindings = {
    ...bindUnitSlot({ pluginId: "fixture-storage", unitId: "web", slotId: "storage", capabilities: [{ capability: StorageFiles }, { capability: StorageListAll }] }),
    ...bindUnitSlot({ pluginId: "fixture-vault", unitId: "web", slotId: "vault", capabilities: [{ capability: VaultBalance }, { capability: VaultListAll }] }),
  };
  // 私有授权由装配层按真实归属登记：归属来自实例身份，不是插件自填的字符串。
  const grants = privateGrants();
  step = "create-host";
  // 页面 realm 只装配 Web 单元；Worker 单元由各自 Worker realm 装配。
  const host = createPluginHost({
    runtime: "window-main",
    runtimeSlotBindings: bindings,
    privateCapabilities: grants,
    runtimeUnitImplementationRegistry: createRuntimeUnitImplementationRegistry([
      ...implementationsForRuntime(storagePackage, "window-main"),
      ...implementationsForRuntime(vaultPackage, "window-main"),
      // 其他插件是当前 realm 的单元实现，同样要在注册表里。
      { pluginId: outsiderPlugin.manifest.id, unitId: outsiderPlugin.descriptor.id, setup: outsiderPlugin.setup, capabilities: outsiderPlugin.capabilities },
    ]),
  });
  const result: Record<string, unknown> = { ok: true };
  diagnostics = result;
  // 页面 App：让页面把自己的单元实例发布给 Worker realm。私有授权核对"消费实例是否仍然
  // 活着"依赖这份快照，空快照意味着没有可授权实例（而不是降级成只校验连接）。
  const pageApp = await createWindowAppFromHost({ host });
  step = "connect-vault";
  const vaultHandle = connectSharedWorker({ id: "fixture-vault-runtime", url: vaultWorkerUrl, name: "webloom-fixture-vault", client: { app: pageApp, expose: [] } });
  step = "connect-storage";
  const storageHandle = connectSharedWorker({ id: "fixture-storage-runtime", url: storageWorkerUrl, name: "webloom-fixture-storage", client: { app: pageApp, expose: [] } });
  // 槽位连接：直接绑定 bridge；替换/断开都只作用于匹配槽位。
  step = "attach-vault";
  host.attachRemote(bridgeForRuntimeHandle(vaultHandle), "vault");
  const firstStorageConnection = host.attachRemote(bridgeForRuntimeHandle(storageHandle), "storage");
  const firstStorageGeneration = firstStorageConnection.generation;
  // 真实 Worker 启动后才会发布首个快照；必需依赖在此之前保持等待。
  const waitForService = async (capability: { readonly id: string }): Promise<boolean> => {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      await host.reconcile();
      if (host.optionalCapability(capability as never)) return true;
      await new Promise<void>((resolve) => { setTimeout(resolve, 25); });
    }
    return false;
  };
  /** 单元在目录发布后自动转入运行：不调用 reconcile。 */
  const waitForAutoConverged = async (pluginId: string): Promise<boolean> => {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const state = host.state(pluginId);
      if (state.kind === "enabled") return true;
      await new Promise<void>((resolve) => { setTimeout(resolve, 25); });
    }
    return false;
  };
  const waitForUnitReady = async (pluginId: string): Promise<boolean> => {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      await host.reconcile();
      const state = host.state(pluginId);
      if (state.kind === "enabled" && state.lifecycleState === "running") return true;
      if (state.kind === "failed") return false;
      await new Promise<void>((resolve) => { setTimeout(resolve, 25); });
    }
    return false;
  };
  step = "register-all";
  // 一个 pluginId 一份 manifest：Web 单元按 window-main 装配，Worker 单元留给 Worker realm。
  await host.registerAll([storagePackage.manifest, vaultPackage.manifest]);
  // 必需依赖必须由 Host 自己收敛：Worker 稍后才发布目录，这里不再调用 reconcile。
  result.storageAutoConverged = await waitForAutoConverged("fixture-storage");
  result.vaultAutoConverged = await waitForAutoConverged("fixture-vault");
  result.vaultReady = host.optionalCapability(VaultBalance) !== undefined;

  const storageConsumer = consumerByUnit.get("storage-web");
  result.installed = host.installed().join(",");

  // 两个 Worker 的公开服务都可用（先 Vault 后 Storage 的挂接顺序不影响绑定）。
  result.publicStorage = storageConsumer ? await storageConsumer.capability(StorageFiles).call({ text: "list" }).then((value) => value.files) : null;
  const vaultConsumer = consumerByUnit.get("vault-web");
  result.publicVault = vaultConsumer ? await vaultConsumer.capability(VaultBalance).call({ text: "balance" }).then((value) => value.balance) : null;

  // 私有跨单元调用：同插件同单元可以取到并调用后台私有函数。
  try {
    const privateClient = storageConsumer?.privateCapability(StorageListAll) as { call(request: { text: string }): Promise<{ files: string }> } | undefined;
    result.privateStorage = privateClient ? (await privateClient.call({ text: "all" })).files : null;
  } catch (error) {
    result.privateStorageError = error instanceof Error ? error.message : String(error);
  }

  // 未授权调用方：普通 RuntimeHandle 式句柄（目录里看得到私有服务，但没有票据）
  // 拿不到私有函数，handler 不执行。
  try {
    await storageHandle.capability(StorageListAll).call({ text: "all" });
    result.unauthorizedCall = "allowed";
  } catch (error) {
    result.unauthorizedCall = (error as { code?: string }).code ?? "rejected";
  }

  // 其他插件没有私有解析入口：单独注册，观察它确实被拒。
  step = "register-outsider";
  await host.registerAll([outsiderPlugin.manifest]);
  result.outsiderReady = await waitForUnitReady("fixture-outsider");
  result.outsiderInstalled = host.installed().includes("fixture-outsider");
  result.outsiderRejected = privateDenials.length >= 3;
  result.outsiderDenials = privateDenials.join(",");

  // 断开 Storage 槽位：Vault 继续可用，Storage 回到等待。
  host.detachRemote("fixture storage slot closed", "storage");
  await host.reconcile();
  await tick();
  result.storageStateAfterDetach = host.state("fixture-storage").kind;
  result.vaultStillWorks = vaultConsumer ? await vaultConsumer.capability(VaultBalance).call({ text: "balance" }).then((value) => value.balance).catch(() => "failed") : null;

  // 用一条新连接替换 Storage 槽位：旧槽位不能因为延迟卸载而误伤新连接（PSM-R12）。
  step = "reattach-storage";
  const replacementStorageHandle = connectSharedWorker({
    id: "fixture-storage-runtime",
    url: storageWorkerUrl,
    name: "webloom-fixture-storage-2",
    client: { app: pageApp, expose: [] },
  });
  host.attachRemote(bridgeForRuntimeHandle(replacementStorageHandle), "storage");
  await waitForService(StorageFiles);
  // 旧连接的卸载函数此时执行：必须什么都不做。
  host.detachRemote("stale storage cleanup", { slotId: "storage", generation: firstStorageGeneration });
  await tick();
  result.staleCleanupKeptConnection = host.optionalCapability(StorageFiles) !== undefined;
  result.storageReadyAfterReplace = await waitForUnitReady("fixture-storage");
  const revived = consumerByUnit.get("storage-web");
  result.storageStateAfterReattach = host.state("fixture-storage").kind;
  result.publicStorageAfterReattach = revived
    ? await revived.capability(StorageFiles).call({ text: "list" }).then((value) => value.files).catch((error: unknown) => `failed:${error instanceof Error ? error.message : String(error)}`)
    : null;

  // 私有入口在快照里带 private 标记，且所属单元能解析成功。
  result.privateResolutionNotes = privateResolutionNotes.filter((note) => note.endsWith(":ok")).length;
  result.finalStorageKind = host.state("fixture-storage").kind;
  result.packageUnits = storagePackage.manifest.units?.map((unit) => `${unit.id}@${unit.runtime}`).join(",") ?? "";
  result.vaultPackageUnits = vaultPackage.manifest.units?.map((unit) => `${unit.id}@${unit.runtime}`).join(",") ?? "";

  await host.dispose().catch(() => undefined);
  await pageApp.dispose().catch(() => undefined);
  storageHandle.dispose();
  vaultHandle.dispose();
  replacementStorageHandle.dispose();
  return result;
}

void run()
  .then((result) => { window.__WEBLOOM_MULTI_WORKER_RESULT__ = result; })
  .catch((error) => {
    window.__WEBLOOM_MULTI_WORKER_RESULT__ = { ...diagnostics, ok: false, step, error: error instanceof Error ? error.message : String(error), notes: privateResolutionNotes.join(" | "), stack: error instanceof Error ? String(error.stack).slice(0, 900) : "" };
  });
