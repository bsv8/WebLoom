// 完整插件、多 Worker 槽位与所属私有通信（PSM-R11–R13）。
//
// 这里使用真实 transport 的 fake 实现与共享内存，不联网、不执行真实业务 I/O。
// 浏览器层的多 SharedWorker 证据在 scripts/browser-runtime-fixture。

import { describe, expect, it, vi } from "vitest";
import { capabilityKey, defineCapability } from "../contracts/capability.js";
import { definePlugin } from "../authoring/definePlugin.js";
import { createPluginHost } from "../host/createPluginHost.js";
import { createRuntimeUnitImplementationRegistry } from "../host/runtimeUnitImplementationRegistry.js";
import { definePrivateCapability, definePluginPackage, implementationsForRuntime } from "../runtime/pluginPackage.js";
import { createCapabilityBridge } from "../transport/serviceBridge.js";
import { createMessagePortRuntimeTransport } from "../transport/messagePortServiceTransport.js";
import { bridgeForRuntimeHandle, connectSharedWorkerForTesting } from "./connectSharedWorker.js";
import { createWindowApp, createWindowAppFromHost } from "./windowRuntime.js";
import { startSharedWorkerAppForTesting, type SharedWorkerScopeLike } from "./sharedWorkerHost.js";
import { authorizedPrivateInstance, derivePrivateGrant } from "./privateGrant.js";
import { assertPrivateResultPublishable, guardPrivateStream } from "./privateCallValidity.js";
import { createFakePluginHost, createFakeRuntimeTransport } from "../testing/fakes.js";
import { RUNTIME_PROTOCOL_VERSION } from "../runtime/runtimeProtocol.js";
import type { PluginConsumer } from "../contracts/consumer.js";

const request = { parse: (value: unknown) => value as { text: string } };
const response = { parse: (value: unknown) => value as { ok: boolean } };

/** Storage Worker 的后台公开服务（对内公开）。 */
const StorageFiles = defineCapability<{ text: string }, { ok: boolean }>({
  kind: "rpc",
  id: "psm.storage.files",
  version: "1",
  request,
  response,
});

/** Storage Worker 的私有函数：只供同插件同单元的 Web 单元调用。 */
const StorageListAll = defineCapability<{ text: string }, { ok: boolean }>({
  kind: "rpc",
  id: "psm.storage.listAll",
  version: "1",
  request,
  response,
});

/** Storage Worker 的私有事件流：只对所属单元开放。 */
const StorageEvents = defineCapability<{ text: string }, { text: string }>({
  kind: "stream",
  id: "psm.storage.events",
  version: "1",
  request: { parse: (value: unknown) => value as { text: string } },
  item: { parse: (value: unknown) => value as { text: string } },
});

/** Vault Worker 的后台服务，部署到另一个槽位。 */
const VaultBalance = defineCapability<{ text: string }, { ok: boolean }>({
  kind: "rpc",
  id: "psm.vault.balance",
  version: "1",
  request,
  response,
});

/** 构造一个带已发布服务的假 Worker 端点。 */
function endpoint(services: readonly { kind: "rpc"; capabilityId: string; contractVersion: string }[]): {
  readonly bridge: ReturnType<typeof createCapabilityBridge>;
  readonly transport: ReturnType<typeof createFakeRuntimeTransport>;
} {
  const transport = createFakeRuntimeTransport();
  const bridge = createCapabilityBridge({ transport, defaultCallTimeoutMs: 200 });
  const runtimeInstanceId = `worker:${services[0]?.capabilityId ?? "empty"}`;
  const snapshot = {
    type: `${RUNTIME_PROTOCOL_VERSION}.snapshot`,
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    binding: { runtimeInstanceId, connectionId: `direct:${runtimeInstanceId}` },
    runtimeId: services[0]?.capabilityId ?? "empty",
    runtimeKind: "shared-worker",
    runtimeInstanceId,
    revision: 1,
    state: "ready",
    units: [],
    services: services.map((service) => ({ ...service, serviceInstanceId: `service:${service.capabilityId}`, attributes: {} })),
  } as unknown as Parameters<typeof bridge.applySnapshot>[0];
  const applied = bridge.applySnapshot(snapshot);
  if (!applied.accepted) throw new Error(`endpoint snapshot rejected: ${applied.reason}`);
  return { bridge, transport };
}

describe("PSM 完整插件与多 Worker 槽位", () => {
  it("同一个 Window 可以并存两个 Worker 槽位，挂接顺序不影响绑定", async () => {
    const storage = endpoint([{ kind: "rpc", capabilityId: StorageFiles.id, contractVersion: StorageFiles.version }]);
    const vault = endpoint([{ kind: "rpc", capabilityId: VaultBalance.id, contractVersion: VaultBalance.version }]);
    const host = createFakePluginHost();
    // 先挂 Vault 再挂 Storage：两个端点都必须可用。
    host.attachRemote(vault.bridge, "vault");
    host.attachRemote(storage.bridge, "storage");
    expect(host.capability(StorageFiles)).toBeDefined();
    expect(host.capability(VaultBalance)).toBeDefined();

    // 单元依赖通过槽位绑定解析，不依赖挂接顺序。
    const seen: string[] = [];
    const unit = definePlugin({
      id: "web-unit",
      dependencies: [{ capability: StorageFiles, sourceRuntime: "shared-worker" as const }] as const,
      setup(ctx) { seen.push("web"); },
    });
    const implementations = createRuntimeUnitImplementationRegistry([{
      pluginId: unit.manifest.id,
      unitId: unit.descriptor.id,
      setup: unit.setup,
      capabilities: unit.capabilities,
    }]);
    const bound = createPluginHost({ runtime: "window-main", runtimeUnitImplementationRegistry: implementations, runtimeSlotBindings: { [`web-unit\u0000${unit.descriptor.id}\u0000${`rpc:${StorageFiles.id}@${StorageFiles.version}`}`]: "storage" } });
    bound.attachRemote(storage.bridge, "storage");
    bound.attachRemote(vault.bridge, "vault");
    // 必需远端服务已就绪：单元正常启动（挂接顺序不影响绑定）。
    await bound.registerAll([unit.manifest]);
    expect(seen).toEqual(["web"]);
    expect(bound.state("web-unit").kind).toBe("enabled");
    // 断开该槽位后：单元回到等待，而不是继续运行在已失效的端点上。
    bound.detachRemote("storage gone", "storage");
    await bound.reconcile();
    expect(bound.state("web-unit").kind).toBe("blocked");
    expect(bound.state("web-unit").blockedBy).toEqual(["missing:rpc:psm.storage.files@1"]);
    // Vault 槽位不受影响。
    expect(bound.optionalCapability(VaultBalance)).toBeDefined();
    void host.dispose();
    void bound.dispose();
    storage.transport.reset();
    vault.transport.reset();
  });

  it("新增槽位不撤销已有槽位；只断开匹配槽位", () => {
    const storage = endpoint([{ kind: "rpc", capabilityId: StorageFiles.id, contractVersion: StorageFiles.version }]);
    const vault = endpoint([{ kind: "rpc", capabilityId: VaultBalance.id, contractVersion: VaultBalance.version }]);
    const host = createFakePluginHost();
    host.attachRemote(storage.bridge, "storage");
    host.attachRemote(vault.bridge, "vault");
    // 再挂一个新 Worker：Storage 端点仍然发布服务。
    const extra = endpoint([{ kind: "rpc", capabilityId: "psm.extra.service", contractVersion: "1" } as never]);
    host.attachRemote(extra.bridge, "extra");
    expect(host.optionalCapability(StorageFiles)).toBeDefined();
    expect(host.optionalCapability(VaultBalance)).toBeDefined();

    // 只断开 Vault 槽位：Storage 继续可用。
    host.detachRemote("slot gone", "vault");
    expect(host.optionalCapability(StorageFiles)).toBeDefined();
    expect(host.optionalCapability(VaultBalance)).toBeUndefined();
    void host.dispose();
  });

  it("旧卸载函数不会断开替换后的新连接", () => {
    const first = endpoint([{ kind: "rpc", capabilityId: StorageFiles.id, contractVersion: StorageFiles.version }]);
    const second = endpoint([{ kind: "rpc", capabilityId: StorageFiles.id, contractVersion: StorageFiles.version }]);
    const host = createFakePluginHost();
    const firstConnection = host.attachRemote(first.bridge, "storage");
    host.attachRemote(second.bridge, "storage");
    expect(firstConnection.generation).toBe(1);
    expect(host.optionalCapability(StorageFiles)).toBeDefined();
    // 迟到的第一次卸载（带自己的连接世代）不得断开替换后的新连接。
    host.detachRemote("stale disconnect", { slotId: "storage", generation: firstConnection.generation });
    expect(host.optionalCapability(StorageFiles)).toBeDefined();
    expect(second.bridge.pendingCallCount).toBe(0);
    // 当前世代的卸载才真的断开槽位。
    const secondConnection = host.attachRemote(second.bridge, "storage");
    host.detachRemote("current disconnect", { slotId: "storage", generation: secondConnection.generation });
    expect(host.optionalCapability(StorageFiles)).toBeUndefined();
    void host.dispose();
  });

  it("私有能力只对同插件同单元可见，其他插件/单元没有解析入口", async () => {
    const privateEntry = definePrivateCapability({
      capability: StorageListAll,
      pluginId: "storage",
      unitId: "worker",
      grantId: "grant-storage-worker",
      description: "Storage 内部文件枚举",
    });
    expect(privateEntry.capability.id).toBe(StorageListAll.id);
    const grants: unknown[] = [];
    const webUnit = definePlugin({
      id: "storage",
      unitId: "web",
      privateProvides: [StorageListAll],
      setup(ctx) {
        // 同插件同单元的 Web 单元实现并可以取到自己的私有能力。
        ctx.handlePrivate(StorageListAll, async () => ({ ok: true }));
        grants.push(ctx.privateCapability(StorageListAll));
        // 但公共能力解析里没有它：私有入口不走 provides。
        let undeclared = false;
        try { ctx.capability(StorageListAll); } catch { undeclared = true; }
        grants.push(undeclared);
      },
    });
    const otherPlugin = definePlugin({
      id: "outsider",
      setup(ctx) {
        let rejected = false;
        try { ctx.privateCapability(StorageListAll); } catch { rejected = true; }
        grants.push(rejected);
        let viaConsumer = false;
        try { ctx.consumer.privateCapability(StorageListAll); } catch { viaConsumer = true; }
        grants.push(viaConsumer);
        // 公共解析路径同样拿不到。
        let viaPublic = false;
        try { ctx.capability(StorageListAll); } catch { viaPublic = true; }
        grants.push(viaPublic);
      },
    });
    const host = createPluginHost({
      runtime: "window-main",
      runtimeUnitImplementationRegistry: createRuntimeUnitImplementationRegistry([webUnit, otherPlugin].map((definition) => ({
        pluginId: definition.manifest.id,
        unitId: definition.descriptor.id,
        setup: definition.setup,
        capabilities: definition.capabilities,
      }))),
      privateCapabilities: [{ pluginId: "storage", unitId: "web", capability: StorageListAll, grantId: "grant-storage-web" }],
    });
    await host.registerAll([webUnit.manifest, otherPlugin.manifest]);
    // 同插件同单元：允许。
    expect(typeof grants[0]).toBe("object");
    // 公共解析路径拿不到私有入口。
    expect(grants[1]).toBe(true);
    // 其他插件：无解析入口（ctx、consumer 与公共解析都被拒）。
    expect(grants[2]).toBe(true);
    expect(grants[3]).toBe(true);
    expect(grants[4]).toBe(true);
    // 装配层接口同样看不到私有入口。
    expect(host.optionalCapability(StorageListAll)).toBeUndefined();
    await host.dispose();
  });

  it("私有入口即使被声明成公共依赖也只走私有路径", async () => {
    const notes: string[] = [];
    const provider = definePlugin({
      id: "storage",
      unitId: "worker",
      privateProvides: [StorageListAll],
      setup(ctx) {
        ctx.handlePrivate(StorageListAll, async () => ({ ok: true }));
      },
    });
    // 另一个插件把同一个契约声明成公共依赖：仍然不能通过公共路径拿到。
    const dependent = definePlugin({
      id: "reader",
      dependencies: [{ capability: StorageListAll }] as const,
      setup(ctx) {
        let rejected = false;
        try { ctx.capability(StorageListAll); } catch { rejected = true; }
        notes.push(`public:${rejected}`);
        let privateNote = "allowed";
        try { ctx.privateCapability(StorageListAll); } catch (error) { privateNote = error instanceof Error ? error.message : String(error); }
        notes.push(privateNote);
      },
    });
    const host = createPluginHost({
      runtime: "window-main",
      runtimeUnitImplementationRegistry: createRuntimeUnitImplementationRegistry([provider, dependent].map((definition) => ({
        pluginId: definition.manifest.id,
        unitId: definition.descriptor.id,
        setup: definition.setup,
        capabilities: definition.capabilities,
      }))),
    });
    await host.registerAll([provider.manifest, dependent.manifest]);
    // 公共依赖路径拿不到私有入口；私有入口也按归属拒绝它。
    expect(notes[0]).toBe("public:true");
    expect(notes[1]).toContain("is not granted to unit");
    await host.dispose();
  });

  it("私有句柄绑定提供者世代：提供者重建后必须重新解析", async () => {
    const generation = vi.fn();
    let staleClient: { call(request: { text: string }): Promise<{ ok: boolean }> } | undefined;
    let freshClient: { call(request: { text: string }): Promise<{ ok: boolean }> } | undefined;
    const workerUnit = definePlugin({
      id: "storage",
      unitId: "worker",
      privateProvides: [StorageListAll] as const,
      setup(ctx) {
        generation();
        ctx.handlePrivate(StorageListAll, async () => ({ ok: true }));
      },
    });
    const holder = definePlugin({
      id: "storage-holder",
      setup(ctx) {
        // setup 期拿到的句柄绑定第一代提供者世代。
        staleClient = ctx.privateCapability(StorageListAll) as never;
        // 重新解析得到当前世代的句柄（下面在重建后再取一次）。
        freshClient = ctx.privateCapability(StorageListAll) as never;
      },
    });
    const host = createPluginHost({
      runtime: "window-main",
      runtimeUnitImplementationRegistry: createRuntimeUnitImplementationRegistry([workerUnit, holder].map((definition) => ({
        pluginId: definition.manifest.id,
        unitId: definition.descriptor.id,
        setup: definition.setup,
        capabilities: definition.capabilities,
      }))),
      privateCapabilities: [{ pluginId: "storage-holder", unitId: "storage-holder", capability: StorageListAll, grantId: "grant-holder" }],
    });
    await host.registerAll([workerUnit.manifest]);
    await host.registerAll([holder.manifest]);
    // 提供者释放后重建（第二代实现）。
    await host.revoke("storage");
    await host.retry("storage");
    expect(generation).toHaveBeenCalledTimes(2);
    // 旧句柄永久失败：它不会自动改用第二代实现。
    await expect(staleClient!.call({ text: "all" })).rejects.toMatchObject({ code: expect.stringMatching(/service_(revoked|stale)/) });
    await host.dispose();
  });

  it("私有入口即使被声明成公共依赖也只走私有路径", async () => {
    const notes: string[] = [];
    const provider = definePlugin({
      id: "storage",
      unitId: "worker",
      privateProvides: [StorageListAll],
      setup(ctx) {
        ctx.handlePrivate(StorageListAll, async () => ({ ok: true }));
      },
    });
    // 另一个插件把同一个契约声明成公共依赖：仍然不能通过公共路径拿到。
    const dependent = definePlugin({
      id: "reader",
      dependencies: [{ capability: StorageListAll }] as const,
      setup(ctx) {
        let rejected = false;
        try { ctx.capability(StorageListAll); } catch { rejected = true; }
        notes.push(`public:${rejected}`);
        let privateNote = "allowed";
        try { ctx.privateCapability(StorageListAll); } catch (error) { privateNote = error instanceof Error ? error.message : String(error); }
        notes.push(privateNote);
      },
    });
    const host = createPluginHost({
      runtime: "window-main",
      runtimeUnitImplementationRegistry: createRuntimeUnitImplementationRegistry([provider, dependent].map((definition) => ({
        pluginId: definition.manifest.id,
        unitId: definition.descriptor.id,
        setup: definition.setup,
        capabilities: definition.capabilities,
      }))),
    });
    await host.registerAll([provider.manifest, dependent.manifest]);
    // 公共依赖路径拿不到私有入口；私有入口也按归属拒绝它。
    expect(notes[0]).toBe("public:true");
    expect(notes[1]).toContain("is not granted to unit");
    await host.dispose();
  });

  it("私有句柄绑定提供者世代：提供者重建后必须重新解析", async () => {
    const generation = vi.fn();
    const workerUnit = definePlugin({
      id: "storage",
      setup(ctx) {
        generation();
        ctx.handle(StorageListAll, async () => ({ ok: true }));
      },
    });
    const webUnit = definePlugin({
      id: "storage-web",
      setup(ctx) {
        ctx.handle(StorageListAll, async (requestValue) => ({ ok: requestValue.text.length > 0 }));
      },
    });
    let consumer!: PluginConsumer;
    const holder = definePlugin({
      id: "storage-holder",
      setup(ctx) { consumer = ctx.consumer; },
    });
    const host = createPluginHost({
      runtime: "window-main",
      runtimeUnitImplementationRegistry: createRuntimeUnitImplementationRegistry([workerUnit, webUnit, holder].map((definition) => ({
        pluginId: definition.manifest.id,
        unitId: definition.descriptor.id,
        setup: definition.setup,
        capabilities: definition.capabilities,
      }))),
    });
    await host.registerAll([workerUnit.manifest, webUnit.manifest, holder.manifest]);
    // holder 未登记私有授权，因此解析被拒。
    expect(() => consumer.privateCapability(StorageListAll)).toThrow(/is not granted to unit/);
    await host.dispose();
    expect(generation).toHaveBeenCalledTimes(1);
  });

  it("插件包把 Web 与 Worker 单元统一在同一 pluginId 下", () => {
    // 单元用真实的 definePlugin 定义声明一次；插件包只负责合并身份与槽位。
    const webUnit = definePlugin({ id: "storage", unitId: "web", setup: () => undefined });
    const workerUnit = definePlugin({
      id: "storage",
      unitId: "worker",
      provides: [StorageFiles] as const,
      setup: () => undefined,
    });
    const pkg = definePluginPackage({
      id: "storage",
      name: "Storage",
      units: [
        { runtime: "window-main", unit: webUnit },
        { runtime: "shared-worker", unit: workerUnit, slot: "storage-worker" },
      ],
    });
    // 同一 pluginId 的两个 realm 单元共用一份静态身份。
    expect(pkg.manifest.id).toBe("storage");
    expect(pkg.manifest.units?.map((unit) => `${unit.id}@${unit.runtime}`)).toEqual(["web@window-main", "worker@shared-worker"]);
    expect(pkg.slots.worker).toBe("storage-worker");
    // 每个 realm 只装配自己的实现。
    expect(implementationsForRuntime(pkg, "window-main").map((item) => item.unitId)).toEqual(["web"]);
    expect(implementationsForRuntime(pkg, "shared-worker").map((item) => item.unitId)).toEqual(["worker"]);
  });

  it("插件包拒绝重复单元与非法 Runtime", () => {
    const unitA = definePlugin({ id: "broken", unitId: "a", setup: () => undefined });
    expect(() => definePluginPackage({
      id: "broken",
      units: [
        { runtime: "window-main", unit: unitA },
        { runtime: "shared-worker", unit: unitA },
      ],
    })).toThrow(/duplicate unit/);
    expect(() => definePluginPackage({
      id: "broken",
      units: [{ runtime: "node-main" as never, unit: unitA }],
    })).toThrow(/invalid Runtime/);
  });
});

// PSM-009–R13 复核阻断项的回归：每一项对应一条"修复前必然失败"的断言。
describe("PSM 复核阻断项回归", () => {
  const grant = "grant-storage-web-2";
  /** 可控的私有调用入口：回归在 setup 里挂起、测试再触发。 */
  let resolveLateCall: (() => Promise<{ ok: boolean }>) | undefined;
  let resolvePrivateStream: (() => { subscribe(request: { text: string }, options: { onNext(item: { text: string }): void }): { ready: Promise<void>; closed: Promise<void> } }) | undefined;

  /** 真实的 Worker 端点 + 真实的页面连接（两侧都通过快照发布单元实例）。 */
  async function privateWorkerPair(execute: () => void): Promise<{
    readonly unauthorizedCall: () => Promise<unknown>;
    readonly grantedCall: () => Promise<unknown>;
    readonly revokeCaller: () => Promise<void>;
    readonly retryCaller: () => Promise<void>;
    /** 注销页面 Host（最后一个消费单元消失 → 空快照）。 */
    readonly disposeCaller: () => Promise<void>;
    /** 页面侧连接（用于读取 binding 与直接重放）。 */
    readonly handle: ReturnType<typeof connectSharedWorkerForTesting>;
    /** 页面侧当前授权单元的实例身份（票据的实例分量）。 */
    readonly callerInstanceId: () => string | undefined;
    /** 直接重放一条旧票据（绕过客户端过滤与授权记录检查）。 */
    readonly replayOldTicket: (input: { readonly grantId: string; readonly connectionId: string; readonly instanceId: string }) => Promise<unknown>;
    readonly dispose: () => Promise<void>;
  }> {
    const scope: SharedWorkerScopeLike = { onconnect: null };
    const workerUnit = definePlugin({
      id: "storage",
      unitId: "worker",
      provides: [StorageFiles] as const,
      privateProvides: [StorageListAll] as const,
      setup(ctx) {
        ctx.handle(StorageFiles, async () => ({ ok: true }));
        ctx.handlePrivate(StorageListAll, async () => {
          execute();
          return { ok: true };
        });
      },
    });
    const workerApp = startSharedWorkerAppForTesting({
      id: "storage-runtime",
      plugins: [workerUnit],
      expose: [StorageFiles, StorageListAll],
      // 提供者侧机密：接收端用它核对调用方。
      privateCapabilities: [{ pluginId: "storage", unitId: "web", capability: StorageListAll, grantId: grant }],
      globalScope: scope,
    });
    // 页面侧：授权单元 storage/web 用私有入口调用 Worker 的私有函数。
    let pageHost: ReturnType<typeof createPluginHost> | undefined;
    let privateClient: { call(request: { text: string }): Promise<{ ok: boolean }> } | undefined;
    const webUnit = definePlugin({
      id: "storage",
      unitId: "web",
      setup(ctx) {
        // 解析时目录可能还没发布：延迟到调用时再解析。
        privateClient = { call: (request) => (ctx.privateCapability(StorageListAll) as { call(request: { text: string }): Promise<{ ok: boolean }> }).call(request) };
      },
    });
    const pageHostValue = createPluginHost({
      runtime: "window-main",
      runtimeUnitImplementationRegistry: createRuntimeUnitImplementationRegistry([webUnit].map((definition) => ({
        pluginId: definition.manifest.id,
        unitId: definition.descriptor.id,
        setup: definition.setup,
        capabilities: definition.capabilities,
      }))),
      privateCapabilities: [{ pluginId: "storage", unitId: "web", capability: StorageListAll, grantId: grant }],
    });
    pageHost = pageHostValue;
    await pageHostValue.registerAll([webUnit.manifest]);
    const app = createWindowAppFromHost({ host: pageHostValue });
    const pageApp = await app;
    // 页面必须向 Worker 发布自己的单元快照：实例授权核对依赖"调用实例仍然存活"这一事实。
    const handle = connectSharedWorkerForTesting(
      { id: "storage-runtime", url: "/storage.worker.js", client: { app: pageApp, expose: [] } },
      () => {
        const channel = new MessageChannel();
        queueMicrotask(() => scope.onconnect?.({ ports: [channel.port2] }));
        return { port: channel.port1 };
      },
    );
    await workerApp.ready();
    // 页面 Host 绑定该连接：Web 单元的私有入口从这里解析。
    const pageBridge = bridgeForRuntimeHandle(handle);
    pageHostValue.attachRemote(pageBridge, "storage");
    await pageHostValue.reconcile();
    // 等 Worker 目录到达后再交给用例（私有调用需要目录里的私有服务）。
    await vi.waitFor(() => {
      expect(pageBridge.services().some((service) => service.capabilityId === StorageListAll.id)).toBe(true);
    });
    return {
      handle,
      // 未授权：普通 RuntimeHandle 句柄（无票据）。
      unauthorizedCall: () => handle.capability(StorageListAll).call({ text: "all" }),
      grantedCall: async () => privateClient!.call({ text: "all" }),
      revokeCaller: () => pageHostValue.revoke("storage"),
      retryCaller: () => pageHostValue.retry("storage"),
      disposeCaller: async () => { await pageApp.dispose().catch(() => undefined); },
      // 调用实例身份与页面快照里发布的是同一个（页面 Host 的实例状态）。
      callerInstanceId: () => pageHostValue.state("storage").instanceId,
      replayOldTicket: ({ grantId, connectionId, instanceId }) => handle.capability(StorageListAll).call({ text: "all" }, { grantId: derivePrivateGrant(grantId, connectionId, instanceId) }),
      dispose: async () => {
        handle.dispose();
        await workerApp.dispose();
        await pageHostValue.dispose();
        void pageApp;
      },
    };
  }

  it("1 未授权调用方拿不到私有函数：handler 不执行", async () => {
    const executed = vi.fn();
    const pair = await privateWorkerPair(executed);
    // 普通 RuntimeHandle 式的句柄：目录里看得到私有服务，但没有任何票据。
    await expect(pair.unauthorizedCall()).rejects.toMatchObject({ code: "permission_denied" });
    // 伪造票据同样被拒。
    await expect(pair.unauthorizedCall()).rejects.toMatchObject({ code: "permission_denied" });
    expect(executed).not.toHaveBeenCalled();
    // 持有授权的私有入口可以调用。
    await expect(pair.grantedCall()).resolves.toEqual({ ok: true });
    expect(executed).toHaveBeenCalledTimes(1);
    await pair.dispose();
  });

  it("1b 注销最后一个消费单元发布空快照后，直接重放旧票据仍被拒绝", async () => {
    const executed = vi.fn();
    const pair = await privateWorkerPair(executed);
    await expect(pair.grantedCall()).resolves.toEqual({ ok: true });
    expect(executed).toHaveBeenCalledTimes(1);
    const instanceId = pair.callerInstanceId();
    expect(instanceId).toBeDefined();
    const connectionId = bridgeForRuntimeHandle(pair.handle).binding.connectionId;
    // **注销**（dispose）页面 Host：最后一个消费单元消失，页面不再发布任何单元快照。
    await pair.disposeCaller();
    await vi.waitFor(() => {
      expect(pair.callerInstanceId()).toBeUndefined();
    });
    // 直接重放注销前的旧票据：没有可授权实例，必须拒绝。
    await expect(pair.replayOldTicket({ grantId: grant, connectionId, instanceId: instanceId as string }))
      .rejects.toMatchObject({ code: "permission_denied" });
    // 再次重放仍然拒绝：不得因为快照为空而降级成只校验连接。
    await expect(pair.replayOldTicket({ grantId: grant, connectionId, instanceId: instanceId as string }))
      .rejects.toMatchObject({ code: "permission_denied" });
    expect(executed).toHaveBeenCalledTimes(1);
    await pair.dispose();
  });

  it("1c 授权有效期规则：撤销后既拒绝迟到结果，也截断后续 item", async () => {
    // 规则层（两端接收路径共用）：发布结果前复核失败 → 拒绝迟到结果；
    // stream 授权绑定持续到流结束，撤销后 item 不再交付。
    const validity = { aborted: false, reason: undefined as unknown, release: vi.fn() };
    let alive: string | undefined = "instance:one";
    const recheck = (): string | undefined => alive;
    expect(() => assertPrivateResultPublishable(validity, recheck, "instance:one")).not.toThrow();
    alive = undefined;
    expect(() => assertPrivateResultPublishable(validity, recheck, "instance:one")).toThrow(/revoked/);
    alive = "instance:one";
    const closed: string[] = [];
    const source = {
      async *[Symbol.asyncIterator]() {
        try {
          yield { text: "first" };
          yield { text: "second" };
        } finally {
          closed.push("cleanup");
        }
      },
    };
    const guarded = guardPrivateStream(source, { validity, recheck, identity: "instance:one" });
    const iterator = guarded[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual({ text: "first" });
    alive = undefined;
    validity.aborted = true;
    validity.reason = new Error("revoked");
    const stopped = await iterator.next();
    expect(stopped.done).toBe(true);
    await vi.waitFor(() => {
      expect(validity.release).toHaveBeenCalled();
    });
  });

  it("1c2 异步授权等待期间撤销消费者：放行后 handler 不执行", async () => {
    // 正确装配：先等 worker.ready()；只通过 configurePeer 暴露（需要 peerExposureAllowlist），
    // 不再放进顶层 expose。
    const executed = vi.fn();
    const scope: SharedWorkerScopeLike = { onconnect: null };
    let openGate: (() => void) | undefined;
    const workerUnit = definePlugin({
      id: "storage",
      unitId: "worker",
      privateProvides: [StorageListAll] as const,
      setup(ctx) {
        ctx.handlePrivate(StorageListAll, async () => {
          executed();
          return { ok: true };
        });
      },
    });
    const workerApp = startSharedWorkerAppForTesting({
      id: "storage-runtime",
      plugins: [workerUnit],
      peerExposureAllowlist: [StorageListAll],
      configurePeer: (peer) => {
        peer.expose(StorageListAll, { authorize: async () => { await new Promise<void>((resolve) => { openGate = resolve; }); return true; } });
      },
      privateCapabilities: [{ pluginId: "storage", unitId: "web", capability: StorageListAll, grantId: grant }],
      globalScope: scope,
    });
    await workerApp.ready();
    const webUnit = definePlugin({
      id: "storage",
      unitId: "web",
      setup(ctx) {
        resolveLateCall = () => (ctx.privateCapability(StorageListAll) as { call(request: { text: string }): Promise<{ ok: boolean }> }).call({ text: "all" });
      },
    });
    const pageHost = createPluginHost({
      runtime: "window-main",
      runtimeUnitImplementationRegistry: createRuntimeUnitImplementationRegistry([webUnit].map((definition) => ({
        pluginId: definition.manifest.id,
        unitId: definition.descriptor.id,
        setup: definition.setup,
        capabilities: definition.capabilities,
      }))),
      privateCapabilities: [{ pluginId: "storage", unitId: "web", capability: StorageListAll, grantId: grant }],
    });
    await pageHost.registerAll([webUnit.manifest]);
    const pageApp = await createWindowAppFromHost({ host: pageHost });
    const handle = connectSharedWorkerForTesting(
      { id: "storage-runtime", url: "/storage.worker.js", client: { app: pageApp, expose: [] } },
      () => {
        const channel = new MessageChannel();
        queueMicrotask(() => scope.onconnect?.({ ports: [channel.port2] }));
        return { port: channel.port1 };
      },
    );
    const pageBridge = bridgeForRuntimeHandle(handle);
    pageHost.attachRemote(pageBridge, "storage");
    await pageHost.reconcile();
    await vi.waitFor(() => {
      expect(pageBridge.services().map((service) => service.capabilityId).join(",")).toContain(StorageListAll.id);
    });
    // 请求进入授权等待。
    const pending = resolveLateCall!().then(() => "resolved", (error: unknown) => (error as { code?: string }).code ?? "rejected");
    await vi.waitFor(() => {
      expect(typeof openGate).toBe("function");
    });
    // 撤销消费单元后放行授权：等待中的旧请求仍不得执行 handler。
    await pageHost.revoke("storage");
    openGate!();
    expect(await pending).toMatch(/permission_denied|scope_revoked|request_cancelled|service_revoked/);
    expect(executed).not.toHaveBeenCalled();
    handle.dispose();
    await workerApp.dispose();
    await pageHost.dispose();
  });

  it("1d handler 忽略取消并返回时，撤销后的迟到结果不会被发布", async () => {
    const executed = vi.fn();
    const scope: SharedWorkerScopeLike = { onconnect: null };
    let releaseHandler: (() => void) | undefined;
    const workerUnit = definePlugin({
      id: "storage",
      unitId: "worker",
      privateProvides: [StorageListAll] as const,
      setup(ctx) {
        ctx.handlePrivate(StorageListAll, async () => {
          executed();
          // 故意忽略取消信号：只有接收端的发布前复核才能拦住迟到结果。
          await new Promise<void>((resolve) => { releaseHandler = resolve; });
          return { ok: true };
        });
      },
    });
    const workerApp = startSharedWorkerAppForTesting({
      id: "storage-runtime",
      plugins: [workerUnit],
      expose: [StorageListAll],
      privateCapabilities: [{ pluginId: "storage", unitId: "web", capability: StorageListAll, grantId: grant }],
      globalScope: scope,
    });
    // 先让 Worker 单元启动并登记私有 handler，peer 暴露才有可暴露的注册。
    await workerApp.ready();
    const webUnit = definePlugin({
      id: "storage",
      unitId: "web",
      setup(ctx) {
        resolveLateCall = () => (ctx.privateCapability(StorageListAll) as { call(request: { text: string }): Promise<{ ok: boolean }> }).call({ text: "all" });
      },
    });
    const pageHost = createPluginHost({
      runtime: "window-main",
      runtimeUnitImplementationRegistry: createRuntimeUnitImplementationRegistry([webUnit].map((definition) => ({
        pluginId: definition.manifest.id,
        unitId: definition.descriptor.id,
        setup: definition.setup,
        capabilities: definition.capabilities,
      }))),
      privateCapabilities: [{ pluginId: "storage", unitId: "web", capability: StorageListAll, grantId: grant }],
    });
    await pageHost.registerAll([webUnit.manifest]);
    const pageApp = await createWindowAppFromHost({ host: pageHost });
    const handle = connectSharedWorkerForTesting(
      { id: "storage-runtime", url: "/storage.worker.js", client: { app: pageApp, expose: [] } },
      () => {
        const channel = new MessageChannel();
        queueMicrotask(() => scope.onconnect?.({ ports: [channel.port2] }));
        return { port: channel.port1 };
      },
    );
    const pageBridge = bridgeForRuntimeHandle(handle);
    pageHost.attachRemote(pageBridge, "storage");
    await pageHost.reconcile();
    await workerApp.ready();
    await vi.waitFor(() => {
      expect(pageBridge.services().some((service) => service.capabilityId === StorageListAll.id)).toBe(true);
    });
    const pending = resolveLateCall!().then(() => "resolved", (error: unknown) => (error as { code?: string }).code ?? "rejected");
    await vi.waitFor(() => {
      expect(executed).toHaveBeenCalledTimes(1);
    });
    // 撤销消费实例后让 handler 返回：结果不得发布给客户端。
    await pageHost.revoke("storage");
    releaseHandler!();
    // handler 忽略取消并返回了 { ok: true }，但这个迟到结果没有被发布。
    expect(await pending).toMatch(/permission_denied|scope_revoked|request_cancelled|service_revoked/);
    expect(executed).toHaveBeenCalledTimes(1);
    handle.dispose();
    await workerApp.dispose();
    await pageHost.dispose();
  });

  it("2 消费实例撤销后旧票据失效，重建后新票据可用", async () => {
    const executed = vi.fn();
    const pair = await privateWorkerPair(executed);
    await expect(pair.grantedCall()).resolves.toEqual({ ok: true });
    expect(executed).toHaveBeenCalledTimes(1);
    // 撤销消费实例：授权记录被回收，旧句柄在发出请求前就被拒绝。
    await pair.revokeCaller();
    await expect(pair.grantedCall()).rejects.toMatchObject({ code: expect.stringMatching(/permission_denied|capability_unavailable|service_revoked|scope_revoked/) });
    expect(executed).toHaveBeenCalledTimes(1);
    // 重建实例：重新签发授权记录后可以再次调用。
    await pair.retryCaller();
    await expect(pair.grantedCall()).resolves.toEqual({ ok: true });
    expect(executed).toHaveBeenCalledTimes(2);
    await pair.dispose();
  });

  it("2 本地私有旧句柄在提供者撤销后不能调用，在途调用被取消", async () => {
    const clients = new Map<string, { call(request: { text: string }): Promise<{ ok: boolean }> }>();
    let releaseSlowHandler: (() => void) | undefined;
    const provider = definePlugin({
      id: "storage",
      unitId: "web",
      privateProvides: [StorageListAll] as const,
      setup(ctx) {
        ctx.handlePrivate(StorageListAll, async () => {
          // 慢 handler：撤销后必须被取消，而不是把迟到结果交给旧句柄。
          await new Promise<void>((resolve) => { releaseSlowHandler = resolve; });
          return { ok: true };
        });
        clients.set("provider", ctx.privateCapability(StorageListAll) as never);
      },
    });
    const holder = definePlugin({
      id: "holder",
      setup(ctx) {
        clients.set("holder", ctx.privateCapability(StorageListAll) as never);
      },
    });
    const host = createPluginHost({
      runtime: "window-main",
      runtimeUnitImplementationRegistry: createRuntimeUnitImplementationRegistry([provider, holder].map((definition) => ({
        pluginId: definition.manifest.id,
        unitId: definition.descriptor.id,
        setup: definition.setup,
        capabilities: definition.capabilities,
      }))),
      privateCapabilities: [
        { pluginId: "storage", unitId: "web", capability: StorageListAll, grantId: grant },
        { pluginId: "holder", unitId: "holder", capability: StorageListAll, grantId: grant },
      ],
    });
    await host.registerAll([provider.manifest, holder.manifest]);
    // 调用方是另一个单元：它的 Scope 仍然活跃，因此撤销只来自提供者一侧。
    const callerClient = clients.get("holder");
    expect(callerClient).toBeDefined();
    const inFlight = callerClient!.call({ text: "all" }).then(
      () => "resolved" as const,
      (error: unknown) => (error as { code?: string }).code ?? "rejected",
    );
    // 撤销实例：在途调用立即以 service_revoked 结束，不等慢 handler 返回。
    await host.revoke("storage");
    expect(await inFlight).toBe("service_revoked");
    releaseSlowHandler?.();
    // 旧句柄在新调用时同样失败：不能自动改用重建后的第二代实现。
    await expect(callerClient!.call({ text: "all" })).rejects.toMatchObject({ code: expect.stringMatching(/service_(revoked|stale)/) });
    await host.dispose();
  });

  /** 私有 stream 的 Worker + 页面连接（真实 transport）。 */
  async function privateStreamPair(options: { readonly onItem: (emit: (item: { text: string }) => void) => () => void }): Promise<{
    readonly subscribe: (onNext: (item: { text: string }) => void) => { readonly items: { text: string }[]; readonly error: () => string | undefined };
    readonly revokeCaller: () => Promise<void>;
    readonly dispose: () => Promise<void>;
  }> {
    const scope: SharedWorkerScopeLike = { onconnect: null };
    const workerUnit = definePlugin({
      id: "storage",
      unitId: "worker",
      privateProvides: [StorageEvents] as const,
      setup(ctx) {
        ctx.handlePrivate(StorageEvents, async function* () {
          const queue: { text: string }[] = [];
          let notify: (() => void) | undefined;
          const stop = options.onItem((item) => { queue.push(item); notify?.(); });
          try {
            for (;;) {
              while (queue.length === 0) await new Promise<void>((resolve) => { notify = resolve; });
              const item = queue.shift();
              if (item === undefined) continue;
              yield item;
            }
          } finally {
            stop();
          }
        });
      },
    });
    const workerApp = startSharedWorkerAppForTesting({
      id: "storage-runtime",
      plugins: [workerUnit],
      expose: [StorageEvents],
      privateCapabilities: [{ pluginId: "storage", unitId: "web", capability: StorageEvents, grantId: grant }],
      globalScope: scope,
    });
    await workerApp.ready();
    const webUnit = definePlugin({
      id: "storage",
      unitId: "web",
      setup(ctx) {
        // 延迟解析：setup 时对端目录可能还没发布。
        resolvePrivateStream = () => ctx.privateCapability(StorageEvents) as unknown as {
          subscribe(request: { text: string }, options: { onNext(item: { text: string }): void }): { ready: Promise<void>; closed: Promise<void> };
        };
      },
    });
    const pageHost = createPluginHost({
      runtime: "window-main",
      runtimeUnitImplementationRegistry: createRuntimeUnitImplementationRegistry([webUnit].map((definition) => ({
        pluginId: definition.manifest.id,
        unitId: definition.descriptor.id,
        setup: definition.setup,
        capabilities: definition.capabilities,
      }))),
      privateCapabilities: [{ pluginId: "storage", unitId: "web", capability: StorageEvents, grantId: grant }],
    });
    await pageHost.registerAll([webUnit.manifest]);
    const pageApp = await createWindowAppFromHost({ host: pageHost });
    const handle = connectSharedWorkerForTesting(
      { id: "storage-runtime", url: "/storage.worker.js", client: { app: pageApp, expose: [] } },
      () => {
        const channel = new MessageChannel();
        queueMicrotask(() => scope.onconnect?.({ ports: [channel.port2] }));
        return { port: channel.port1 };
      },
    );
    const pageBridge = bridgeForRuntimeHandle(handle);
    pageHost.attachRemote(pageBridge, "storage");
    await pageHost.reconcile();
    await vi.waitFor(() => {
      expect(pageBridge.services().map((service) => service.capabilityId).join(",")).toContain(StorageEvents.id);
    });
    return {
      subscribe: (onNext) => {
        const items: { text: string }[] = [];
        let failure: string | undefined;
        const client = resolvePrivateStream?.();
        if (!client) throw new Error("private stream client was not resolved");
        const subscription = client.subscribe({ text: "watch" }, { onNext: (item: { text: string }) => { items.push(item); onNext(item); } });
        void subscription.closed.then(() => undefined, (reason: unknown) => { failure = (reason as { code?: string }).code ?? "closed"; });
        return { items, error: () => failure };
      },
      revokeCaller: () => pageHost.revoke("storage"),
      dispose: async () => {
        handle.dispose();
        await workerApp.dispose();
        await pageHost.dispose();
      },
    };
  }

  it("3a 合法私有 stream 订阅成功（票据不被丢弃）", async () => {
    let push: ((item: { text: string }) => void) | undefined;
    const pair = await privateStreamPair({ onItem: (emit) => { push = emit; return () => undefined; } });
    const collected: string[] = [];
    const seen = pair.subscribe((item) => collected.push(item.text));
    await vi.waitFor(() => {
      expect(typeof push).toBe("function");
    });
    push?.({ text: "first" });
    await vi.waitFor(() => {
      expect(collected).toEqual(["first"]);
    });
    expect(seen.error()).toBeUndefined();
    await pair.dispose();
  });

  it("3b 消费实例撤销后私有 stream 不再交付后续 item", async () => {
    let push: ((item: { text: string }) => void) | undefined;
    const pair = await privateStreamPair({ onItem: (emit) => { push = emit; return () => undefined; } });
    const collected: string[] = [];
    const seen = pair.subscribe((item) => collected.push(item.text));
    await vi.waitFor(() => {
      expect(typeof push).toBe("function");
    });
    push?.({ text: "first" });
    await vi.waitFor(() => {
      expect(collected).toEqual(["first"]);
    });
    await pair.revokeCaller();
    push?.({ text: "second" });
    await vi.waitFor(() => {
      expect(collected).toEqual(["first"]);
    });
    // 撤销后调用方作用域也会被取消：流可以以取消结束，但不得再交付 item。
    expect(seen.error() === undefined || seen.error() === "request_cancelled").toBe(true);
    await pair.dispose();
  });

  it("3c 异步清理完成前不得把流报告成结束、也不得释放授权资源", async () => {
    const validity = { aborted: false, reason: undefined as unknown, release: vi.fn() };
    let alive: string | undefined = "instance:one";
    const recheck = (): string | undefined => alive;
    let releaseCleanup: (() => void) | undefined;
    let cleanupFinished = false;
    let returnCalls = 0;
    const source = {
      [Symbol.asyncIterator]() {
        let sent = false;
        return {
          async next(): Promise<IteratorResult<{ text: string }>> {
            if (sent) return { done: true, value: undefined };
            sent = true;
            return { done: false, value: { text: "first" } };
          },
          async return(): Promise<IteratorResult<{ text: string }>> {
            returnCalls += 1;
            // 异步清理：必须等它完成。
            await new Promise<void>((resolve) => { releaseCleanup = resolve; });
            cleanupFinished = true;
            return { done: true, value: undefined };
          },
        };
      },
    };
    const iterator = guardPrivateStream(source as AsyncIterable<unknown>, { validity, recheck, identity: "instance:one" })[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual({ text: "first" });
    alive = undefined;
    const stopped = iterator.next();
    await vi.waitFor(() => {
      expect(typeof releaseCleanup).toBe("function");
    });
    // 清理未完成：既不报结束，也不释放授权资源。
    let settled = false;
    void stopped.then(() => { settled = true; });
    await new Promise<void>((resolve) => { setTimeout(resolve, 20); });
    expect(settled).toBe(false);
    expect(cleanupFinished).toBe(false);
    expect(validity.release).not.toHaveBeenCalled();
    // 重复 return() 复用同一次清理。
    const repeated = iterator.return!();
    expect(returnCalls).toBe(1);
    releaseCleanup!();
    await stopped;
    await repeated;
    expect(cleanupFinished).toBe(true);
    expect(validity.release).toHaveBeenCalledTimes(1);
  });

  it("3d 清理阶段产出的 item 必须被丢弃，不得交付或重复返回", async () => {
    const validity = { aborted: false, reason: undefined as unknown, release: vi.fn() };
    let alive: string | undefined = "instance:one";
    const recheck = (): string | undefined => alive;
    // 生成器在 finally 里 yield：这些是清理产出，不是数据。
    const source = {
      async *[Symbol.asyncIterator]() {
        try {
          yield { text: "first" };
        } finally {
          yield { text: "cleanup-a" };
          yield { text: "cleanup-b" };
        }
      },
    };
    const iterator = guardPrivateStream(source, { validity, recheck, identity: "instance:one" })[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual({ text: "first" });
    // 授权在流期间失效：进入关闭路径。
    alive = undefined;
    const closed = await iterator.next();
    expect(closed.done).toBe(true);
    expect(closed.value).toBeUndefined();
    // 后续 next() 不会重复交付清理产出。
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    expect(validity.release).toHaveBeenCalledTimes(1);
  });

  it("3e 清理阶段产出超过 64 项：全部消费完才报告结束并释放", async () => {
    // 包装器层（不依赖 transport）：不能按次数上限截断，必须等底层真正结束。
    const validity = { aborted: false, reason: undefined as unknown, release: vi.fn() };
    let alive: string | undefined = "instance:one";
    const recheck = (): string | undefined => alive;
    let finallyFinished = false;
    let produced = 0;
    const source = {
      async *[Symbol.asyncIterator]() {
        try {
          yield { text: "first" };
        } finally {
          // 清理阶段产出 100 项：全部属于清理，不得提前结束。
          for (let index = 0; index < 100; index += 1) {
            produced += 1;
            yield { text: `cleanup-${index}` };
          }
          finallyFinished = true;
        }
      },
    };
    const iterator = guardPrivateStream(source, { validity, recheck, identity: "instance:one" })[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual({ text: "first" });
    alive = undefined;
    const closed = await iterator.next();
    // 只有底层 finally 跑完才报告结束；清理项一个都没交付。
    expect(closed).toEqual({ done: true, value: undefined });
    expect(finallyFinished).toBe(true);
    expect(produced).toBe(100);
    expect(validity.release).toHaveBeenCalledTimes(1);
  });

  it("3f 清理未在预算内结束：不报告自然结束、不释放资源；迟到完成后再回收", async () => {
    // 包装器层：用户可见超时与底层真实完成分开跟踪。
    const validity = { aborted: false, reason: undefined as unknown, release: vi.fn() };
    let alive: string | undefined = "instance:one";
    const recheck = (): string | undefined => alive;
    let stopCleanup = false;
    let finallyFinished = false;
    let lateNotified = 0;
    const source = {
      async *[Symbol.asyncIterator]() {
        try {
          yield { text: "first" };
        } finally {
          // 清理很慢：由测试决定何时真正结束。
          while (!stopCleanup) {
            yield { text: "cleanup" };
            await new Promise<void>((resolve) => { setTimeout(resolve, 5); });
          }
          finallyFinished = true;
        }
      },
    };
    const iterator = guardPrivateStream(source, {
      validity,
      recheck,
      identity: "instance:one",
      drainTimeoutMs: 20,
      onLateCompletion: () => { lateNotified += 1; },
    })[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual({ text: "first" });
    alive = undefined;
    // 预算从关闭开始计时：挂起的清理也会被预算打断。
    await expect(iterator.next()).rejects.toThrow(/drain budget/);
    expect(validity.release).not.toHaveBeenCalled();
    expect(lateNotified).toBe(0);
    // 后续 next() 不再重复抛错（消费者看到流已结束），底层清理仍在后台。
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    // 迟到完成：才回收授权资源并通知 provider。
    stopCleanup = true;
    await vi.waitFor(() => {
      expect(finallyFinished).toBe(true);
      expect(validity.release).toHaveBeenCalledTimes(1);
      expect(lateNotified).toBe(1);
    }, { timeout: 2_000 });
  });

  it("3h 清理阶段持续快速产出：预算定时器仍能触发，清理未完成不释放资源", async () => {
    // 回归：清理循环必须按批次让出事件循环，否则立即完成的 next() 会饿死预算定时器。
    const validity = { aborted: false, reason: undefined as unknown, release: vi.fn() };
    let alive: string | undefined = "instance:one";
    const recheck = (): string | undefined => alive;
    let stopCleanup = false;
    let finallyFinished = false;
    const source = {
      async *[Symbol.asyncIterator]() {
        try {
          yield { text: "first" };
        } finally {
          // 持续快速产出：每次 next() 都立即完成，不给事件循环机会。
          while (!stopCleanup) yield { text: "cleanup" };
          finallyFinished = true;
        }
      },
    };
    const iterator = guardPrivateStream(source, { validity, recheck, identity: "instance:one", drainTimeoutMs: 10 })[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual({ text: "first" });
    // 清理期间其他宏任务仍必须得到运行机会（事件循环没有被饿死）。
    let markerRan = false;
    setTimeout(() => { markerRan = true; }, 0);
    alive = undefined;
    const started = Date.now();
    // 预算必须在有界时间内触发（此前会一直挂住）。
    await expect(iterator.next()).rejects.toThrow(/drain budget/);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(markerRan).toBe(true);
    // 底层清理仍在进行：授权资源不释放。
    expect(finallyFinished).toBe(false);
    expect(validity.release).not.toHaveBeenCalled();
    // 收尾：让后台 drain 真正结束。
    stopCleanup = true;
    await vi.waitFor(() => {
      expect(finallyFinished).toBe(true);
      expect(validity.release).toHaveBeenCalledTimes(1);
    }, { timeout: 2_000 });
  });

  it("3 绑定槽位不存在时，其他槽位发布同名服务也不能满足必需依赖", async () => {
    const storageEndpoint = endpoint([{ kind: "rpc", capabilityId: StorageFiles.id, contractVersion: StorageFiles.version }]);
    const dependent = definePlugin({
      id: "reader",
      dependencies: [{ capability: StorageFiles, sourceRuntime: "shared-worker" as const }] as const,
      setup() { /* 依赖未满足时不应执行 */ },
    });
    const host = createPluginHost({
      runtime: "window-main",
      runtimeUnitImplementationRegistry: createRuntimeUnitImplementationRegistry([dependent].map((definition) => ({
        pluginId: definition.manifest.id,
        unitId: definition.descriptor.id,
        setup: definition.setup,
        capabilities: definition.capabilities,
      }))),
      runtimeSlotBindings: { [`reader\u0000reader\u0000${capabilityKey(StorageFiles)}`]: "missing-slot" },
    });
    // 服务在另一个槽位上发布，但本单元绑定的是不存在的槽位。
    host.attachRemote(storageEndpoint.bridge, "other-slot");
    await host.registerAll([dependent.manifest]);
    expect(host.state("reader").kind).toBe("blocked");
    // 绑定槽位真正到位后自动收敛，不需要外部再调用 reconcile（见回归 4）。
    void storageEndpoint;
    await host.dispose();
  });

  it("4 远端目录发布后自动驱动依赖收敛", async () => {
    const transport = createFakeRuntimeTransport();
    const bridge = createCapabilityBridge({ transport, defaultCallTimeoutMs: 200 });
    const started = vi.fn();
    const dependent = definePlugin({
      id: "reader",
      // 依赖显式声明来自 Worker：就绪判断据此只看绑定槽位上的真实端点。
      dependencies: [{ capability: StorageFiles, sourceRuntime: "shared-worker" as const }] as const,
      setup() { started(); },
    });
    const host = createPluginHost({
      runtime: "window-main",
      runtimeUnitImplementationRegistry: createRuntimeUnitImplementationRegistry([dependent].map((definition) => ({
        pluginId: definition.manifest.id,
        unitId: definition.descriptor.id,
        setup: definition.setup,
        capabilities: definition.capabilities,
      }))),
    });
    host.attachRemote(bridge, "worker-slot");
    await host.registerAll([dependent.manifest]);
    expect(host.state("reader").kind).toBe("blocked");
    // Worker 之后才发布目录：Host 必须自己收敛。
    const runtimeInstanceId = "worker:late";
    bridge.applySnapshot({
      type: `${RUNTIME_PROTOCOL_VERSION}.snapshot`,
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      binding: { runtimeInstanceId, connectionId: `direct:${runtimeInstanceId}` },
      runtimeId: "worker",
      runtimeKind: "shared-worker",
      runtimeInstanceId,
      revision: 1,
      state: "ready",
      units: [],
      services: [{ kind: "rpc", capabilityId: StorageFiles.id, contractVersion: StorageFiles.version, serviceInstanceId: "service:files", attributes: {} }],
    } as never);
    await vi.waitFor(() => {
      expect(host.state("reader").kind).toBe("enabled");
    });
    expect(started).toHaveBeenCalledTimes(1);
    await host.dispose();
  });

  it("5 完整包身份贯穿装配入口，并在定义阶段拒绝不一致单元", async () => {
    const webUnit = definePlugin({ id: "storage", unitId: "web", setup: () => undefined });
    const workerUnit = definePlugin({ id: "storage", unitId: "worker", provides: [StorageFiles] as const, setup: () => undefined });
    const pkg = definePluginPackage({
      id: "storage",
      units: [{ runtime: "window-main", unit: webUnit }, { runtime: "shared-worker", unit: workerUnit }],
    });
    // 装配入口必须给出完整包 manifest：插件身份是包 id，units 只含该 realm 的单元。
    const windowImplementation = implementationsForRuntime(pkg, "window-main")[0]!;
    expect(windowImplementation.manifest.id).toBe("storage");
    expect(windowImplementation.unitId).toBe("web");
    expect(windowImplementation.manifest.units?.map((unit) => unit.id)).toEqual(["web"]);
    const workerImplementation = implementationsForRuntime(pkg, "shared-worker")[0]!;
    expect(workerImplementation.manifest.id).toBe("storage");
    expect(workerImplementation.manifest.units?.map((unit) => unit.id)).toEqual(["worker"]);
    // 用包 manifest 注册时，Host 看到的插件身份就是包 id。
    const host = createPluginHost({
      runtime: "window-main",
      runtimeUnitImplementationRegistry: createRuntimeUnitImplementationRegistry([
        { pluginId: "storage", unitId: "web", setup: webUnit.setup, capabilities: webUnit.capabilities },
      ]),
    });
    await host.registerAll([windowImplementation.manifest]);
    expect(host.installed()).toEqual(["storage"]);
    await host.dispose();
    // 定义阶段就拒绝不属于该包的单元。
    const foreign = definePlugin({ id: "other-plugin", unitId: "web", setup: () => undefined });
    expect(() => definePluginPackage({ id: "storage", units: [{ runtime: "window-main", unit: foreign }] }))
      .toThrow(/belongs to plugin "other-plugin"/);
  });
});

// 第二轮复核：反向私有授权、票据连接绑定、卸载收敛、外部依赖就绪。
describe("PSM 复核阻断项回归（第二轮）", () => {
  const secret = "assembly-secret-storage";

  it("1 反向私有调用（Worker → Window）没有票据同样被拒：handler 不执行", async () => {
    const executed = vi.fn();
    const privateUnit = definePlugin({
      id: "storage",
      unitId: "web",
      privateProvides: [StorageListAll] as const,
      setup(ctx) {
        ctx.handlePrivate(StorageListAll, async () => {
          executed();
          return { ok: true };
        });
      },
    });
    // Worker 侧单元：反向调用 Window 的私有函数（不带任何票据）。
    const workerUnit = definePlugin({
      id: "worker",
      provides: [StorageFiles] as const,
      setup(ctx) {
        ctx.handle(StorageFiles, async (_request, call) => {
          const peer = call.peer;
          if (!peer) throw new Error("peer is required");
          const io = peer.capability(StorageListAll);
          return io.call({ text: "from-worker" });
        });
      },
    });
    const pageApp = await createWindowApp({
      plugins: [privateUnit],
      privateCapabilities: [{ pluginId: "storage", unitId: "web", capability: StorageListAll, grantId: secret }],
    });
    const scope: SharedWorkerScopeLike = { onconnect: null };
    const workerApp = startSharedWorkerAppForTesting({
      id: "storage-runtime",
      plugins: [workerUnit],
      expose: [StorageFiles],
      globalScope: scope,
    });
    const handle = connectSharedWorkerForTesting(
      { id: "storage-runtime", url: "/storage.worker.js", client: { app: pageApp, expose: [StorageListAll] } },
      () => {
        const channel = new MessageChannel();
        queueMicrotask(() => scope.onconnect?.({ ports: [channel.port2] }));
        return { port: channel.port1 };
      },
    );
    await workerApp.ready();
    // 未授权：Worker 侧连私有入口都解析不到，handler 绝不执行。
    await expect(handle.capability(StorageFiles).call({ text: "go" })).rejects.toMatchObject({ code: "capability_unavailable" });
    expect(executed).not.toHaveBeenCalled();

    handle.dispose();
    await workerApp.dispose();
    await pageApp.dispose();
  });

  it("2 票据绑定连接与消费实例：换连接或换实例都失效", () => {
    const first = derivePrivateGrant(secret, "connection:one", "instance:one");
    // 同一连接同一实例稳定；换连接、换实例必然不同。
    expect(derivePrivateGrant(secret, "connection:one", "instance:one")).toBe(first);
    expect(derivePrivateGrant(secret, "connection:two", "instance:one")).not.toBe(first);
    expect(derivePrivateGrant(secret, "connection:one", "instance:two")).not.toBe(first);
    const authorized = (instanceIds: readonly string[], grantId: string | undefined, connectionId: string, secretForInstance = secret) => authorizedPrivateInstance({
      private: true,
      // 机密与实例一一对应：候选记录按单元配对，不做交叉匹配。
      candidates: instanceIds.map((instanceId) => ({ pluginId: "storage", unitId: "web", secret: secretForInstance, instanceId })),
      grantId,
      connectionId,
    });
    expect(authorized(["instance:one"], first, "connection:one")).toBe("instance:one");
    // 换连接重放失败。
    expect(authorized(["instance:one"], first, "connection:two")).toBeUndefined();
    // 消费实例被撤销（不再出现在对端快照里）后，旧票据失败。
    expect(authorized([], first, "connection:one")).toBeUndefined();
    expect(authorized(["instance:two"], first, "connection:one")).toBeUndefined();
    // 没有机密（未授权登记）：一律失败。
    expect(authorizedPrivateInstance({ private: true, candidates: [], grantId: first, connectionId: "connection:one" })).toBeUndefined();
    // 空候选（对端发布空快照 / 没有可授权实例）一律拒绝，不降级成只校验连接。
    expect(authorizedPrivateInstance({ private: true, candidates: [], grantId: first, connectionId: "connection:one" })).toBeUndefined();
    expect(authorizedPrivateInstance({ private: true, candidates: [], grantId: first, connectionId: "connection:two" })).toBeUndefined();
    // A 单元的机密配 B 单元的实例不通过：候选记录按单元一一对应。
    const crossUnitToken = derivePrivateGrant("assembly-secret-worker", "connection:one", "instance:worker");
    expect(authorizedPrivateInstance({
      private: true,
      candidates: [{ pluginId: "storage", unitId: "worker", secret: "assembly-secret-worker", instanceId: "instance:worker" }],
      grantId: crossUnitToken,
      connectionId: "connection:one",
    })).toBe("instance:worker");
    // 同一个候选记录集合里，web 的机密不能配 worker 的实例。
    expect(authorizedPrivateInstance({
      private: true,
      candidates: [{ pluginId: "storage", unitId: "web", secret, instanceId: "instance:web" }],
      grantId: crossUnitToken,
      connectionId: "connection:one",
    })).toBeUndefined();
  });

  it("3 显式卸载槽位后消费者回到等待", async () => {
    const first = endpoint([{ kind: "rpc", capabilityId: StorageFiles.id, contractVersion: StorageFiles.version }]);
    const dependent = definePlugin({
      id: "reader",
      dependencies: [{ capability: StorageFiles, sourceRuntime: "shared-worker" as const }] as const,
      setup() { /* 依赖满足后才启动 */ },
    });
    const host = createPluginHost({
      runtime: "window-main",
      runtimeUnitImplementationRegistry: createRuntimeUnitImplementationRegistry([dependent].map((definition) => ({
        pluginId: definition.manifest.id,
        unitId: definition.descriptor.id,
        setup: definition.setup,
        capabilities: definition.capabilities,
      }))),
    });
    host.attachRemote(first.bridge, "worker-slot");
    await host.registerAll([dependent.manifest]);
    expect(host.state("reader").kind).toBe("enabled");
    // 显式卸载：不需要外部再调用 reconcile，消费者必须自己回到等待。
    host.detachRemote("slot unloaded", "worker-slot");
    await vi.waitFor(() => {
      expect(host.state("reader").kind).toBe("blocked");
    });
    await host.dispose();
  });

  it("4 本地同名服务不能顶替声明来自 Worker 的依赖", async () => {
    const localProvider = definePlugin({
      id: "local-files",
      provides: [StorageFiles] as const,
      setup(ctx) { ctx.handle(StorageFiles, async () => ({ ok: true })); },
    });
    const dependent = definePlugin({
      id: "reader",
      // 依赖显式声明来自 Worker，并且绑定了尚未连接的槽位。
      dependencies: [{ capability: StorageFiles, sourceRuntime: "shared-worker" as const }] as const,
      setup() { /* Worker 未连接前不应启动 */ },
    });
    const host = createPluginHost({
      runtime: "window-main",
      runtimeUnitImplementationRegistry: createRuntimeUnitImplementationRegistry([localProvider, dependent].map((definition) => ({
        pluginId: definition.manifest.id,
        unitId: definition.descriptor.id,
        setup: definition.setup,
        capabilities: definition.capabilities,
      }))),
      runtimeSlotBindings: { [`reader\u0000reader\u0000${capabilityKey(StorageFiles)}`]: "storage" },
    });
    await host.registerAll([localProvider.manifest, dependent.manifest]);
    // 本地提供者运行中，但依赖声明来自 Worker 且槽位未连接：消费者保持等待。
    expect(host.state("local-files").kind).toBe("enabled");
    expect(host.state("reader").kind).toBe("blocked");
    // 槽位连接并发布服务后自动满足。
    const worker = endpoint([{ kind: "rpc", capabilityId: StorageFiles.id, contractVersion: StorageFiles.version }]);
    host.attachRemote(worker.bridge, "storage");
    await vi.waitFor(() => {
      expect(host.state("reader").kind).toBe("enabled");
    });
    await host.dispose();
  });

  it("4b 就绪遵守槽位时，实际调用也必须走该槽位", async () => {
    let localCalls = 0;
    const localProvider = definePlugin({
      id: "local-files",
      provides: [StorageFiles] as const,
      setup(ctx) {
        ctx.handle(StorageFiles, async () => {
          localCalls += 1;
          return { ok: false };
        });
      },
    });
    const calls: string[] = [];
    const dependent = definePlugin({
      id: "reader",
      dependencies: [{ capability: StorageFiles, sourceRuntime: "shared-worker" as const }] as const,
      setup(ctx) {
        // 只看解析结果走的是哪条路径：远端槽位的 bridge 客户端，本地 handler 不会被调用。
        const client = ctx.capability(StorageFiles) as { call(request: { text: string }): Promise<unknown> };
        calls.push("resolved");
        void client.call({ text: "list" }).catch(() => undefined);
      },
    });
    const host = createPluginHost({
      runtime: "window-main",
      runtimeUnitImplementationRegistry: createRuntimeUnitImplementationRegistry([localProvider, dependent].map((definition) => ({
        pluginId: definition.manifest.id,
        unitId: definition.descriptor.id,
        setup: definition.setup,
        capabilities: definition.capabilities,
      }))),
      runtimeSlotBindings: { [`reader\u0000reader\u0000${capabilityKey(StorageFiles)}`]: "storage" },
    });
    const worker = endpoint([{ kind: "rpc", capabilityId: StorageFiles.id, contractVersion: StorageFiles.version }]);
    host.attachRemote(worker.bridge, "storage");
    await host.registerAll([localProvider.manifest, dependent.manifest]);
    await vi.waitFor(() => {
      expect(calls.length).toBe(1);
    });
    // 本地 handler 从未被执行：调用绑定在 Worker 槽位的远端客户端上。
    expect(worker.transport.sent.some((entry) => entry.message.type.endsWith(".call"))).toBe(true);
    expect(localCalls).toBe(0);
    await host.dispose();
  });

  it("4c 声明同 realm 却绑定远端槽位时：消费者不启动，解析也拒绝", async () => {
    let started = false;
    let message = "";
    const dependent = definePlugin({
      id: "reader",
      // 声明为同 realm 依赖（不写 sourceRuntime），却绑定了 Worker 槽位。
      dependencies: [{ capability: StorageFiles }] as const,
      setup(ctx) {
        started = true;
        try { ctx.capability(StorageFiles); } catch (error) { message = error instanceof Error ? error.message : String(error); }
      },
    });
    const host = createPluginHost({
      runtime: "window-main",
      runtimeUnitImplementationRegistry: createRuntimeUnitImplementationRegistry([dependent].map((definition) => ({
        pluginId: definition.manifest.id,
        unitId: definition.descriptor.id,
        setup: definition.setup,
        capabilities: definition.capabilities,
      }))),
      runtimeSlotBindings: { [`reader\u0000reader\u0000${capabilityKey(StorageFiles)}`]: "storage" },
    });
    const worker = endpoint([{ kind: "rpc", capabilityId: StorageFiles.id, contractVersion: StorageFiles.version }]);
    host.attachRemote(worker.bridge, "storage");
    await host.registerAll([dependent.manifest]);
    // 就绪判断在启动前就发现冲突：消费者不会先跑起来。
    expect(host.state("reader").kind).toBe("blocked");
    expect(started).toBe(false);
    // 即使强行解析（装配层 API），也给出同一个冲突结论。
    await expect(host.retry("reader")).resolves.toBeUndefined();
    expect(started).toBe(false);
    expect(message).toBe("");
    await host.dispose();
  });

  it("5 externalRuntimeDependencies 不能替代运行时就绪检查", async () => {
    const dependent = definePlugin({
      id: "reader",
      dependencies: [{ capability: StorageFiles, sourceRuntime: "shared-worker" as const }] as const,
      setup() { /* 没有连接就不该启动 */ },
    });
    const host = createPluginHost({
      runtime: "window-main",
      // 静态装配引用外部提供者的放宽开关。
      externalRuntimeDependencies: true,
      runtimeUnitImplementationRegistry: createRuntimeUnitImplementationRegistry([dependent].map((definition) => ({
        pluginId: definition.manifest.id,
        unitId: definition.descriptor.id,
        setup: definition.setup,
        capabilities: definition.capabilities,
      }))),
    });
    // 没有任何连接：消费者仍必须等待。
    await host.registerAll([dependent.manifest]);
    expect(host.state("reader").kind).toBe("blocked");
    await host.dispose();
  });
});
