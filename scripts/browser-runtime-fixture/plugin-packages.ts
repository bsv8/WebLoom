// 完整插件包：一个 pluginId 同时含 Web 单元与 Worker 单元（PSM-R11）。
//
// 单元实现只在这里声明一次；Web realm 与 Worker realm 各自装配属于自己的那一个单元，
// 静态 manifest（插件身份、provides、依赖）由插件包合并为一份。

import { definePlugin } from "../../src/index.ts";
import { definePluginPackage, definePrivateCapability } from "../../src/advanced.ts";
import type { PluginConsumer } from "../../src/contracts/consumer.ts";
import { StorageFiles, StorageListAll, VaultBalance, VaultListAll } from "./plugin-package-contracts.ts";

/** 假 Storage 后台数据。 */
const bucketState = { files: "a.txt,b.txt" };

/** 假 Vault 后台数据。 */
const walletState = { balance: "100" };

/** 页面侧收集到的单元 consumer；用于 fixture 主动发起调用。 */
export const consumerByUnit = new Map<string, PluginConsumer>();

/** 页面侧收集到的被拒私有访问，用于断言外部插件没有私有入口。 */
export const privateDenials: string[] = [];

/** 页面 realm 解析私有入口的结果：成功记 `<unit>:ok`，失败记原因。 */
export const privateResolutionNotes: string[] = [];

/** Storage 完整插件包：Worker 单元提供文件服务，Web 单元消费它。 */
export const storagePackage = definePluginPackage({
  id: "fixture-storage",
  name: "Fixture Storage",
  units: [
    {
      runtime: "shared-worker",
      slot: "storage",
      unit: definePlugin({
        id: "fixture-storage",
        unitId: "worker",
        provides: [StorageFiles] as const,
        privateProvides: [StorageListAll] as const,
        setup(ctx) {
          ctx.handle(StorageFiles, async (request) => {
            if (request.text === "forbid") return { files: "denied" };
            return { files: bucketState.files };
          });
          // 私有后台函数：只有所属单元的私有入口能解析并调用。
          ctx.handlePrivate(StorageListAll, async () => ({ files: `private:${bucketState.files}` }));
        },
      }),
    },
    {
      runtime: "window-main",
      slot: "storage",
      unit: definePlugin({
        id: "fixture-storage",
        unitId: "web",
        dependencies: [{ capability: StorageFiles, sourceRuntime: "shared-worker" as const }] as const,
        setup(ctx) {
          consumerByUnit.set("storage-web", ctx.consumer);
          // 同插件同单元的 Web 单元解析后台私有入口（跨 realm，走绑定槽位）。
          try {
            void ctx.privateCapability(StorageListAll);
            privateResolutionNotes.push("storage-web:ok");
          } catch (error) {
            privateResolutionNotes.push(`storage-web:${error instanceof Error ? error.message : String(error)}`);
          }
        },
      }),
    },
  ],
});

/** Vault 完整插件包：与 Storage 并存，互不影响。 */
export const vaultPackage = definePluginPackage({
  id: "fixture-vault",
  name: "Fixture Vault",
  units: [
    {
      runtime: "shared-worker",
      slot: "vault",
      unit: definePlugin({
        id: "fixture-vault",
        unitId: "worker",
        provides: [VaultBalance] as const,
        privateProvides: [VaultListAll] as const,
        setup(ctx) {
          ctx.handle(VaultBalance, async (request) => {
            if (request.text === "forbid") return { balance: "denied" };
            return { balance: walletState.balance };
          });
          // 私有 handler：只对所属单元的私有入口可见。
          ctx.handlePrivate(VaultListAll, async () => ({ balance: `private:${walletState.balance}` }));
        },
      }),
    },
    {
      runtime: "window-main",
      slot: "vault",
      unit: definePlugin({
        id: "fixture-vault",
        unitId: "web",
        dependencies: [{ capability: VaultBalance, sourceRuntime: "shared-worker" as const }] as const,
        setup(ctx) {
          consumerByUnit.set("vault-web", ctx.consumer);
          try {
            void ctx.privateCapability(VaultListAll);
            privateResolutionNotes.push("vault-web:ok");
          } catch (error) {
            privateResolutionNotes.push(`vault-web:${error instanceof Error ? error.message : String(error)}`);
          }
        },
      }),
    },
  ],
});

/**
 * 私有能力登记：由装配层按真实归属（pluginId + unitId）授权。
 *
 * 私有入口不进 provides、服务目录或 Connect 名单；这里是它唯一的授权来源。
 */
export const privateStorage = definePrivateCapability({
  capability: StorageListAll,
  pluginId: "fixture-storage",
  unitId: "web",
  // 票据由装配层签发；Worker realm 与页面 realm 使用同一张，目录里不携带它。
  grantId: "fixture-private-storage",
  description: "Storage 私有文件枚举",
});

export const privateVault = definePrivateCapability({
  capability: VaultListAll,
  pluginId: "fixture-vault",
  unitId: "web",
  grantId: "fixture-private-vault",
  description: "Vault 私有余额列表",
});

/**
 * 装配层交给 Host 的私有授权表。
 *
 * 调用方单元（Web）拿到票据；提供者单元（Worker）持有同一张票据用于核对入站调用。
 */
export const privateGrants = (): readonly { readonly pluginId: string; readonly unitId: string; readonly capability: unknown; readonly grantId: string }[] => [
  { pluginId: privateStorage.pluginId, unitId: privateStorage.unitId, capability: privateStorage.capability, grantId: privateStorage.grantId },
  { pluginId: privateVault.pluginId, unitId: privateVault.unitId, capability: privateVault.capability, grantId: privateVault.grantId },
];

/**
 * Worker realm 的私有授权（接收端用它核对调用方）。
 *
 * 授权键是**调用单元**（页面的 Web 单元），机密与该单元一一对应；接收端再与对端快照中
 * 仍然存活的实例配对，因此撤销后没有可授权实例。
 */
export const workerPrivateGrants = (): readonly { readonly pluginId: string; readonly unitId: string; readonly capability: unknown; readonly grantId: string }[] => [
  { pluginId: privateStorage.pluginId, unitId: privateStorage.unitId, capability: privateStorage.capability, grantId: privateStorage.grantId },
  { pluginId: privateVault.pluginId, unitId: privateVault.unitId, capability: privateVault.capability, grantId: privateVault.grantId },
];

/** 其他插件：只能走公共依赖，碰不到 Storage/Vault 的私有入口。 */
export const outsiderPlugin = definePlugin({
  id: "fixture-outsider",
  setup(ctx) {
    const denied = (label: string, run: () => unknown): void => {
      try { run(); } catch { privateDenials.push(label); }
    };
    denied("ctx.privateCapability(storage)", () => ctx.privateCapability(StorageListAll));
    denied("consumer.privateCapability(vault)", () => ctx.consumer.privateCapability(VaultListAll));
    denied("ctx.capability(storage private)", () => ctx.capability(StorageListAll));
  },
});
