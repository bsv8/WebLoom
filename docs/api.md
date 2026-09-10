# WebLoom API 说明

## 浏览器 Runtime

WebLoom 0.3.0 只支持两个真实 JavaScript realm：`window-main` 和
`shared-worker`。`runtime` 是受限的 `RuntimeKind`，不是可自由填写的环境标签；
不支持的 runtime 在装配边界 fail closed。不实现 Server、Service Worker 或
其它服务端 PluginHost。

一次 Runtime 启动会生成不可复用的 `runtimeInstanceId`。每个插件运行单元启动
会生成不可复用的运行单元 `instanceId`。同一 SharedWorker 接收多个 Window 连接
时，Worker 单元仍只有一个实例；端口本身隔离请求和取消空间，物理端口身份不进入
公共 Runtime 或 RemoteService wire。

## 普通插件 API

```ts
import { createWindowApp, definePlugin } from "webloom-framework";

const hello = definePlugin({
  id: "hello",
  provides: ["hello.service"],
  setup(ctx) {
    ctx.provide("hello.service", { value: "world" });
    ctx.onDispose(() => {
      // 释放本插件登记的资源。
    });
  },
});

const app = await createWindowApp({ plugins: [hello] });
const service = app.capability<{ value: string }>("hello.service");
```

`definePlugin()` 将静态 `manifest/descriptor` 与当前 realm 的 `setup` 分开保存。
静态 descriptor 可用于验证和快照，不携带函数。`createWindowApp()` 自动固定
`window-main`、生成实例身份、创建内部 Implementation Registry、批量注册并
等待初始启动；使用者不需要手工 `register()`。

`createWindowApp()` 的 Promise 只有在必需插件成功后才成功。失败会抛出包含
`pluginId`、`unitId` 和 `phase` 的 `RuntimeInitializationError`。非必需插件的
失败保留在 Runtime 快照中，不会被伪装为 running。

## SharedWorker

Worker 入口：

```ts
import { definePlugin, startSharedWorkerApp } from "webloom-framework";

const storage = definePlugin({
  id: "storage",
  provides: ["storage.service"],
  setup(ctx) {
    ctx.provide("storage.service", {
      handle(request: { key: string }) {
        return { key: request.key };
      },
    });
  },
});

startSharedWorkerApp({ id: "coordinator", plugins: [storage] });
```

Window 入口：

```ts
// Vite emits a hashed JavaScript SharedWorker asset from this importer.
import coordinatorWorkerUrl from "./coordinator.worker.ts?sharedworker&url";
import { connectSharedWorker } from "webloom-framework";

const runtime = connectSharedWorker({
  id: "coordinator",
  url: coordinatorWorkerUrl,
});

const storage = runtime.capability("storage.service");
await storage.call({ key: "hello" });
```

连接入口必须创建真实的 `new SharedWorker(url, { type: "module" })`，并同步返回
本地 `RuntimeHandle`。Worker 只发布完整 `RuntimeSnapshot`；`capability()` 总是
返回惰性代理，第一次 `call()` 在同一个有限 deadline 内等待目录和远程执行。断线、
协议不兼容、Worker 重启或 Provider 实例变化都会同步撤销旧代理。显式重建只建立
新句柄和新代理，不会重放可能产生外部副作用的调用，也不会静默替换旧代理的绑定。

这里的 `url` 必须是 Bundler 产出的 JavaScript Worker URL。Vite 使用
`?sharedworker&url` 或等价的独立 Rollup entry；不要把
`new URL("./coordinator.worker.ts", import.meta.url)` 作为普通参数传入框架，
因为框架内部的 `new SharedWorker()` 不会让 Vite 重新发现调用方源码入口。

`RuntimeHandle` 提供：

| 成员 | 语义 |
| --- | --- |
| `runtimeId` | Worker 的逻辑标识 |
| `runtimeInstanceId` | 当前 Worker 物理启动身份 |
| `state()` | `starting / ready / disconnected / failed / stopping / disposed` 快照 |
| `capability()` | 立即获取惰性代理；第一次 `call()` 精确绑定 Runtime/service instance |
| `subscribe()` | 观察 Runtime/Unit/服务快照 |
| `dispose()` | 同步撤销本句柄，异步关闭连接资源 |

### Window 投影 Worker capability

Window Host 不会根据 Worker manifest 创建假运行单元。需要使用 Worker capability
的页面插件应把已经 `ready` 的句柄传给 Window App：

```ts
const app = await createWindowApp({
  remoteRuntime: runtime,
  plugins: [definePlugin({
    id: "window-consumer",
    dependencies: [{
      capability: "coordinator.service",
      contractVersion: "coordinator.service.v1",
      sourceRuntime: "shared-worker",
    }],
    setup(ctx) {
      const coordinator = ctx.serviceBridge?.requireProxy({
        capabilityId: "coordinator.service",
        contractVersion: "coordinator.service.v1",
        runtime: "shared-worker",
      }, ctx.scope);
      if (!coordinator) throw new Error("Remote service bridge is unavailable");
      ctx.provide("window.coordinator", coordinator);
    },
  })],
});
```

`remoteRuntime` 只向 Host 投影当前完整快照中的服务和单元状态；setup 函数不会进入
Worker。这里的 `coordinator` 是惰性代理，业务在调用边界执行
`await coordinator.call({ type: "health" })`。断线时 Host 同步撤销页面插件的 Scope
和远程代理，显式重建后的新代理必须重新取得，不会静默重绑旧引用。

## 生命周期和 Scope

RuntimeUnit 实例存在的条件是：目标 Runtime 存活、插件启用意图为 true、硬依赖
已就绪并且当前 Runtime 已装配实现。每个实例仍由框架创建一个内部
`ResourceScope`，用于 `AbortSignal`、capability ownership、task/subscription
ownership 和 cleanup callbacks；这个 Scope 不再从用户声明的生命周期分类推导。

停用顺序固定为：同步阻止新 capability 和调用、撤销旧引用、触发 Scope
`AbortSignal`、执行 setup teardown 与 `ctx.onDispose()`，最后发布停止/清理状态。
`revoke()` 先形成安全边界，`dispose()` 再等待异步收尾；清理失败和超时通过
`LifecycleDisposeResult` 暴露。

领域状态（例如 owner、session epoch、Vault lock/unlock、桶世代和最终 I/O
fence）不属于 WebLoom Runtime 生命周期。应用自己的 Coordinator/服务控制器
负责推进领域状态，再通过新的服务快照让旧代理失效。

## 依赖和契约

跨 Runtime 依赖必须声明精确的 `contractVersion` 和 `sourceRuntime`。本地
capability 可以使用 `runtimeCapabilityContractVersion()` 或
`defineRuntimeUnitProvidedContracts()` 生成默认 v1 版本；框架不会根据 capability
名称猜测远端服务。`providedContracts`、Provider 实例身份、Runtime 启动身份和
快照 revision 都参与代理绑定。

## 服务桥和 wire codec

低层 `createServiceBridge()` 仍可用于复杂打包和协议扩展。它只接受同一连接、
权威身份、连续快照和精确契约版本；传输层每次调用生成独立 `callId`，业务
`operationId` 可以复用但不参与响应关联。默认消息 codec 生成
`webloom.remote-service.*`；迁移旧协议时可传入显式前缀。

普通插件不需要接触 `MessagePort`、握手或 codec。测试中的 `MessageChannel` 只
证明 transport simulation；真实浏览器验收仍需确认 `Window` 与
`SharedWorkerGlobalScope` 的 realm marker、setup 次数和多页面连接行为。
仓库提供 `scripts/browser-runtime-fixture/` 与 `pnpm run test:browser`；缺少
Playwright/Chromium 时脚本明确报告 unsupported，不回退为 Node 或同页面模拟。
