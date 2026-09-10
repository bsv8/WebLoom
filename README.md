# WebLoom

WebLoom 是一个只面向浏览器的插件 Runtime 框架。0.3.0 管理真实的
`window-main` 和 `shared-worker` JavaScript realm、插件运行单元、实例、
依赖图、ResourceScope、权限租约、服务桥和资源缓存；路由、存储、日志、
国际化等产品能力由插件或下游应用注入。

## 安装

```bash
pnpm add webloom-framework
```

WebLoom 是 ESM 单包，提供三个入口：

- `webloom-framework`：浏览器核心，提供 Window/SharedWorker Runtime，不加载 React；
- `webloom-framework/react`：Provider、capability、Host、Registry 和 Resource Hooks；
- `webloom-framework/testing`：无产品语义的假 Host、假传输和测试辅助。

React 是可选 peer dependency。只使用 `webloom-framework` 时不需要安装 React。

## 最小 Window Runtime

```ts
import { createWindowApp, definePlugin } from "webloom-framework";

const hello = definePlugin({
  id: "hello",
  provides: ["hello.service"],
  setup(ctx) {
    ctx.provide("hello.service", { value: "world" });
  },
});

const app = await createWindowApp({ plugins: [hello] });
const service = app.capability<{ value: string }>("hello.service");
console.log(service.value); // world

await app.dispose();
```

`createWindowApp()` 会固定创建一个 `window-main` Runtime、生成新的
`runtimeInstanceId`、装配实现并等待初始插件启动。普通插件不需要手工创建
Implementation Registry 或调用 `host.register()`；`definePlugin()` 返回的静态
manifest 不包含 `setup` 函数。

## SharedWorker Runtime

Worker 入口只在 Worker realm 中装配插件：

```ts
// coordinator.worker.ts
import { definePlugin, startSharedWorkerApp } from "webloom-framework";

const coordinator = definePlugin({
  id: "coordinator",
  provides: ["coordinator.service"],
  setup(ctx) {
    ctx.provide("coordinator.service", {
      handle(request: { type: string }) {
        return { type: request.type, instanceId: ctx.instanceId };
      },
    });
  },
});

startSharedWorkerApp({ id: "coordinator", plugins: [coordinator] });
```

Window 侧只连接 Worker，不创建第二套 Worker 插件生命周期：

```ts
// Vite: this query emits a real, hashed JavaScript SharedWorker chunk.
// Do not pass the source `.ts` URL to connectSharedWorker in a production build.
import coordinatorWorkerUrl from "./coordinator.worker.ts?sharedworker&url";
import { connectSharedWorker } from "webloom-framework";

const runtime = connectSharedWorker({
  id: "coordinator",
  url: coordinatorWorkerUrl,
});
const service = runtime.capability("coordinator.service");
await service.call({ type: "health" });
```

`connectSharedWorker()` 同步返回本地句柄；Worker 通过完整 `RuntimeSnapshot` 发布
状态和服务目录，代理的第一次 `call()` 在有限 deadline 内等待精确匹配。协议不兼容、
断线、超时和服务撤销都从调用 Promise 返回；框架不自动重连或重放调用。旧代理不会
静默换绑到新 Worker；Worker 重启后 `runtimeInstanceId`、服务的
`serviceInstanceId` 和运行单元实例都会变化。

Vite 项目必须把 Worker 入口交给 Vite 的 Worker importer（例如
`?sharedworker&url`），再把构建后导出的 URL 传给框架。框架内部的
`new SharedWorker(url, { type: "module" })` 只负责运行时连接，不能替调用方的
Bundler 发现源码 `.ts` 入口。其它 Bundler 应使用等价的独立 SharedWorker
Rollup entry。仓库的 `pnpm run test:browser` 会先执行生产构建，再从 dist 启动
真实浏览器验收。

Window 插件依赖 Worker capability 时，把已连接的 `RuntimeHandle` 传给
`createWindowApp({ remoteRuntime: runtime, plugins })`，并在 setup 中通过
`ctx.serviceBridge.requireProxy()` 获取精确版本的远程代理。Worker 断线时，Window
Host 会把相关单元置为 `blocked`；新的完整快照到达后按原启用意图重新协调。

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
| `capability` | 插件提供或依赖的服务契约标识。 |
| `contractVersion` | capability 的精确契约版本。 |
| `permission` | 字符串形式的权限动作；具体集合由宿主批准。 |
| `attributes` | 宿主绑定的只读扩展元数据，不包含私密材料。 |
| `desiredEnabled` | 用户或控制面希望产品启用的持久意图。 |
| `state` | 当前 Runtime/运行实例的实际状态，不等于启用意图。 |
| `blockedBy` | 实例无法启动时缺失的依赖或 Scope 原因。 |

## 开发与验收

```bash
pnpm install
pnpm lint:boundaries
pnpm typecheck
pnpm test
pnpm build
pnpm run pack:consumer
# 会安装/校验 Playwright Chromium，再执行生产 dist fixture
pnpm run test:browser
```

`pack:consumer` 会在不访问本仓库源码的临时项目中安装 tarball，分别执行
core-only、React 和 Worker 消费者的 `tsc --noEmit` 与运行时 smoke，并检查
发布文件白名单、体积、`.d.ts` 和 `.js.map` 的本地路径及产品字段。版本、发布身份
与许可证确认属于发布责任人的操作，本仓库不自动执行发布。

详细 API 约束见 [`docs/api.md`](docs/api.md)。
