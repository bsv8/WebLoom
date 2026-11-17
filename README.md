# WebLoom

WebLoom 提供浏览器 TypeScript 与 Go 插件 Runtime，双语言发布版本为 0.6.1。浏览器侧管理真实的
`window-main` 和 `shared-worker` JavaScript realm、插件运行单元、实例、依赖图、
ResourceScope、权限租约、typed capability、服务桥和资源缓存；路由、存储、日志、
国际化等产品能力由插件或下游应用注入。

## 安装

```bash
pnpm add webloom-framework
```

WebLoom 是 ESM 单包，提供四个入口：

- `webloom-framework`：浏览器核心，提供 Window/SharedWorker Runtime，不加载 React；
- `webloom-framework/advanced`：Host、graph、peer、transport 和分阶段装配工具；
- `webloom-framework/react`：Provider、typed capability、plugin 和 Resource Hooks；
- `webloom-framework/testing`：无产品语义的假 Host、假传输和测试辅助。

React 是可选 peer dependency。只使用 `webloom-framework` 时不需要安装 React。

## 插件服务模型：三个访问面

| 接口面 | 使用者 | 边界 |
| --- | --- | --- |
| 对内公开 API | 其他插件 | 发布 typed capability，消费方声明依赖 |
| Connect 公开 API | 外部 App，经网关调用 | 产品显式发布名单并绑定 App 会话 |
| 私有 API | 插件自己的实现与自己的 UI | 不登记为公共 capability，只经私有 Context/闭包访问 |

装配清单里的插件**全部参与系统**：没有 `startup`/`defaultEnabled`/`canDisable`，也没有
`enable`/`disable`/`submitIntent`。启动顺序由依赖图决定（A 依赖 B、B 依赖 C ⇒ C → B → A
启动、A → B → C 计划销毁），共享提供者不会因一个消费者被释放而销毁，初始化失败进入可
诊断状态而不是让整个 Runtime 失败。可信装配层用 `host.revoke(pluginId, reason)` 释放实例
（留下 `revoked:<reason>` 运行条件），条件解除后 `host.retry(pluginId)` 重建。

插件把页面、菜单或 widget 交给应用挂载之后，组件按 `ctx.consumer`（Host 为该运行实例
签发的受限视图）读取**对内公开**能力，而不是按 App 或 Host 全局查询；**私有**实现留在
插件自己的 Context 或闭包里：

```tsx
import { PluginConsumerProvider, usePluginCapability } from "webloom-framework/react";

const contactsPage = definePlugin({
  id: "contacts-page",
  dependencies: [{ capability: Contacts }] as const,
  setup(ctx) {
    // 下游自己保存注册项与 consumer 的对应关系，schema 由你定义。
    routes.set("/contacts", { consumer: ctx.consumer });
  },
});

function ContactsPage() {
  const contacts = usePluginCapability(Contacts);
  return <ul>{contacts.list().map((name) => <li key={name}>{name}</li>)}</ul>;
}

<PluginConsumerProvider consumer={entry.consumer}><ContactsPage /></PluginConsumerProvider>;
```

可解析集合等于该实例声明的 `provides + dependencies`；未声明与错版本在编译期和运行时
都被拒绝。视图不提供 `provide/handle/enable/dispose`、Host、App 和根 Scope。实例撤权后
Provider 立即停止渲染旧子树，同名重启签发新实例与新 consumer；保留的远程 client/stream
同样失效。local capability 返回的普通对象属于既有引用，不在本边界内撤销。

网页插件向其他插件提供 typed UI 注册服务（页面/设置块/指示灯的 schema 由产品定义）。
贡献插件用 `/advanced` 的 `createScopedRegistryView(ctx.capability(REG), ctx.scope, ...)`
登记条目：归属由框架按实例身份写入，不需要自填 owner；跨实例注销被拒绝；实例释放时条目
同步撤下。

内置 `RESOURCE_REGISTRY` 也要显式声明，并且拿到的注册表绑定当前实例：资源 owner 由 Host
写入，跨实例注销与 owner 伪造被拒绝；`get()`/`_ids()` 只返回本实例的定义，其他插件的私有
loader 不会泄露；资源上下文用 typed `capability(C)` 而不是字符串 `getCapability(id)`。
完整接入步骤与保证范围见
[`docs/plugin-consumer-migration.md`](docs/plugin-consumer-migration.md)；本轮删除的用户启停
API 与行为变化见
[`docs/plugin-service-migration.md`](docs/plugin-service-migration.md)。

## 最小 Window Runtime

```ts
import { defineCapability, createWindowApp, definePlugin } from "webloom-framework";

const Hello = defineCapability<{ value: string }>({
  kind: "local",
  id: "hello.service",
  version: "1",
});

const hello = definePlugin({
  id: "hello",
  provides: [Hello] as const,
  setup(ctx) {
    ctx.provide(Hello, { value: "world" });
  },
});

const app = await createWindowApp({ plugins: [hello] });
const service = app.capability(Hello);
console.log(service.value); // world

await app.dispose();
```

`defineCapability()` 是 capability 的唯一身份入口。local capability 只在同一 realm
提供和消费；RPC/stream capability 必须声明生产 `request`、`response` 或 `item`
parser，调用参数与结果从契约对象自动推导。

`createWindowApp()` 会固定创建一个 `window-main` Runtime、生成新的
`runtimeInstanceId`、装配实现并等待初始插件启动。普通插件不需要手工创建
Implementation Registry 或调用 `host.register()`；静态 manifest 不包含 setup、parser
或 transfer 函数。

## SharedWorker Runtime

Worker 入口只在 Worker realm 中装配插件：

```ts
// coordinator.worker.ts
import { defineCapability, definePlugin, startSharedWorkerApp } from "webloom-framework";

const Health = defineCapability({
  kind: "rpc",
  id: "coordinator.health",
  version: "1",
  request: { parse(value: unknown): { type: string } {
    if (!value || typeof value !== "object" || typeof (value as { type?: unknown }).type !== "string") {
      throw new Error("invalid health request");
    }
    return value as { type: string };
  } },
  response: { parse(value: unknown): { type: string; instanceId: string } {
    if (!value || typeof value !== "object") throw new Error("invalid health response");
    const result = value as { type?: unknown; instanceId?: unknown };
    if (typeof result.type !== "string" || typeof result.instanceId !== "string") throw new Error("invalid health response");
    return value as { type: string; instanceId: string };
  } },
});

const coordinator = definePlugin({
  id: "coordinator",
  provides: [Health] as const,
  setup(ctx) {
    ctx.handle(Health, (request) => ({
      type: request.type,
      instanceId: ctx.instanceId,
    }));
  },
});

startSharedWorkerApp({ id: "coordinator", plugins: [coordinator], expose: [Health] });
```

Window 侧只连接 Worker，不创建第二套 Worker 插件生命周期：

```ts
// Vite: this query emits a real, hashed JavaScript SharedWorker chunk.
import coordinatorWorkerUrl from "./coordinator.worker.ts?sharedworker&url";
import { connectSharedWorker } from "webloom-framework";

const runtime = connectSharedWorker({
  id: "coordinator",
  url: coordinatorWorkerUrl,
});
const service = runtime.capability(Health);
await service.call({ type: "health" });
```

`connectSharedWorker()` 同步返回本地句柄；Worker 通过完整 `RuntimeSnapshot` 发布状态和
服务目录，代理的第一次 `call()` 在有限 deadline 内等待精确匹配。协议不兼容、断线、
超时和服务撤销都从调用 Promise 返回；框架不自动重连或重放调用。旧代理不会静默换绑
到新 Worker；Worker 重启后 `runtimeInstanceId`、服务的 `serviceInstanceId` 和运行单元
实例都会变化。

Vite 项目必须把 Worker 入口交给 Vite 的 Worker importer（例如 `?sharedworker&url`），
再把构建后导出的 URL 传给框架。框架内部的 `new SharedWorker(url, { type: "module" })`
只负责运行时连接，不能替调用方的 Bundler 发现源码 `.ts` 入口。其它 Bundler 应使用
等价的独立 SharedWorker Rollup entry。仓库的 `pnpm run test:browser` 会先执行生产构建，
再从 dist 启动真实浏览器验收。

页面要向 Worker 暴露反向能力时，先创建本地 `WindowApp`，再通过
`connectSharedWorker({ client: { app, expose } })` 绑定同一条私有端口。页面消费 Worker
capability 时使用 `runtime.capability(C)`；需要分阶段把远程依赖装入已有页面 Host，则从
`webloom-framework/advanced` 使用 `attachRemote()` 和 `registerPlugins()`。Worker 断线
会撤销旧代理；框架不会自动重连或重放调用。

## 公共字段中文语义

| 字段 | 中文含义 |
| --- | --- |
| `pluginId` | 插件产品的稳定标识；用于用户启停和依赖图身份。 |
| `unitId` | 产品在一个 Runtime 中的稳定运行单元标识。 |
| `instanceId` | 某运行单元一次启动生成的唯一实例标识；重启不得复用。 |
| `runtime` | 真实 JavaScript 运行空间；当前版本仅为 `window-main/shared-worker`。 |
| `runtimeInstanceId` | 某个 Window 或 SharedWorker 启动生成的不可复用身份。 |
| `serviceInstanceId` | 某个服务实例的不可复用身份；服务撤销或重建后必须变化。 |
| `revision` | 完整 RuntimeSnapshot 的单调修订号；只用于观察和目录收敛。 |
| `scopeId` | 本次生命周期 Scope 的唯一标识。 |
| `capability` | 插件提供或依赖的 typed 服务契约。 |
| `contractVersion` | capability 的精确业务契约版本。 |
| `permission` | 字符串形式的权限动作；具体集合由宿主批准。 |
| `attributes` | 宿主绑定的只读扩展元数据，不包含私密材料。 |
| `state` | 当前 Runtime/运行实例的实际状态；只由依赖图与运行条件决定。 |
| `blockedBy` | 实例无法启动时缺失的依赖或 Scope 原因。 |
| `instanceId`（consumer） | Host 为该次运行签发的消费视图身份；重建实例必然变化。 |
| `blockedBy` | 运行单元无法运行的原因：缺失依赖、运行条件或被显式释放。 |
| `consumer` | setup 阶段签发的实例受限消费视图：只能读取本实例已声明的能力。 |

## 开发与验收

```bash
pnpm install
pnpm lint:boundaries
pnpm typecheck
pnpm test:types
pnpm test
pnpm build
pnpm run pack:consumer
# 会安装/校验 Playwright Chromium，再执行生产 dist fixture
pnpm run test:browser
```

`pack:consumer` 会在不访问本仓库源码的临时项目中安装 tarball，分别执行 core-only、
advanced、React 和 Worker 消费者的 `tsc --noEmit` 与运行时 smoke，并检查发布文件白名单、
体积、`.d.ts` 和 `.js.map` 的本地路径及产品字段。版本、发布身份与许可证确认属于
发布责任人的操作，本仓库不自动执行发布。

详细 API 约束见 [`docs/api.md`](docs/api.md)；插件 UI 接入见
[`docs/plugin-consumer-migration.md`](docs/plugin-consumer-migration.md)，服务模型与启停迁移见
[`docs/plugin-service-migration.md`](docs/plugin-service-migration.md)。

Go 后台插件入口位于 [`go/`](go/)，使用方法见
[Go 后台与产品传输](docs/api.md#go-后台与既有产品传输)。可运行的前后台记事本
示例分别位于 [`examples/notes/frontend.ts`](examples/notes/frontend.ts) 和
[`go/examples/notes/main.go`](go/examples/notes/main.go)。Go module 当前未发布。

## Go

Go 模块为 `github.com/bsv8/WebLoom/go`，版本 `v0.6.1`（标签 `go/v0.6.1`），与 npm `webloom-framework@0.6.1` 对齐。通过 `go get github.com/bsv8/WebLoom/go@v0.6.1` 安装。支持进程内服务、RPC、依赖排序、调用取消和逆序关闭；按完整 Runtime 启停，尚不支持单插件热重启或 stream。
