# WebLoom v4 API 说明

WebLoom 0.4.0 只支持两个真实 JavaScript realm：`window-main` 和
`shared-worker`。`runtime` 是受限的 `RuntimeKind`，不是可自由填写的环境标签；不支持
的 Runtime 在装配边界 fail closed。

一次 Runtime 启动生成不可复用的 `runtimeInstanceId`。每个插件运行单元启动生成不可
复用的 `instanceId`。同一个 SharedWorker 接收多个 Window 连接时，Worker 单元仍只有
一个实例；每条物理端口拥有独立的 peer、调用、订阅和 exposure。

## capability 与普通插件

Capability 对象是契约、类型和运行时校验的唯一入口。跨 realm 只发送不含函数的
`{ kind, id, version }` descriptor；parser、transfer extractor 和 handler 留在各自
realm。

```ts
import { createWindowApp, defineCapability, definePlugin } from "webloom-framework";

const Hello = defineCapability<{ value: string }>({
  kind: "local", id: "hello.service", version: "1",
});

const hello = definePlugin({
  id: "hello",
  provides: [Hello] as const,
  setup(ctx) {
    ctx.provide(Hello, { value: "world" });
    ctx.onDispose(() => {
      // 释放本插件登记的资源。
    });
  },
});

const app = await createWindowApp({ plugins: [hello] });
const service = app.capability(Hello);
```

local capability 不能跨 Runtime；RPC/stream capability 必须提供生产 `ValueParser`：

```ts
const ReadProfile = defineCapability({
  kind: "rpc",
  id: "profile.read",
  version: "1",
  request: profileRequestParser,
  response: profileResponseParser,
});

const Changes = defineCapability({
  kind: "stream",
  id: "profile.changes",
  version: "1",
  request: profileWatchParser,
  item: profileChangeParser,
});

const profile = definePlugin({
  id: "profile",
  provides: [ReadProfile, Changes] as const,
  setup(ctx) {
    ctx.handle(ReadProfile, (request, call) => loadProfile(request.userId, call.signal));
    ctx.handle(Changes, (request, call) => observeProfiles(request, call.signal));
  },
});
```

`ctx.provide(C, value)` 只注册声明的 local；`ctx.handle(C, handler)` 只注册声明的
RPC/stream。`ctx.capability(C)` 和 `ctx.optionalCapability(C)` 的参数、返回值由 C
推导，调用者不再手写请求/结果泛型，也不能临时传入 transfer 数组。

## SharedWorker 与双向 peer

Worker 入口：

```ts
import { definePlugin, startSharedWorkerApp } from "webloom-framework";
import { Health } from "./contracts";

const coordinator = definePlugin({
  id: "coordinator",
  provides: [Health] as const,
  setup(ctx) {
    ctx.handle(Health, (request) => ({ type: request.type, instanceId: ctx.instanceId }));
  },
});

startSharedWorkerApp({ id: "coordinator", plugins: [coordinator], expose: [Health] });
```

Window 侧把 Bundler 生成的 JavaScript Worker URL 传给连接器：

```ts
import workerUrl from "./coordinator.worker.ts?sharedworker&url";
import { connectSharedWorker } from "webloom-framework";
import { Health } from "./contracts";

const runtime = connectSharedWorker({ id: "coordinator", url: workerUrl });
const result = await runtime.capability(Health).call({ type: "health" });
```

`connectSharedWorker()` 同步返回 `RuntimeHandle`。远程 capability 的 proxy 构造不等待
Worker；第一次 call/subscribe 在一个有限 deadline 内等待精确的 Runtime、contract 和
service exposure。断线、协议不兼容、超时和撤销都返回结构化错误；框架不自动重连或重放。

页面反向能力必须先存在于 WindowApp：

```ts
const page = await createWindowApp({ plugins: [pageIoPlugin] });
const runtime = connectSharedWorker({
  id: "coordinator",
  url: workerUrl,
  client: { app: page, expose: [LocalStorageIo] },
});
```

Worker 的 handler 通过 `call.peer.capability(LocalStorageIo)` 得到当前端口对应页面的
typed client。`PeerController` 只在可信 `configurePeer` 回调中出现，不暴露原始 port、Worker 或发送函数；`peer.expose(C, options)`
只允许暴露本 Host 已注册的 RPC/stream，并在 provider scope、peer scope 和领域 scope
任一撤销时同步移除。授权更新必须 revoke 旧 exposure 后新建，旧 proxy 永不换绑。

如果页面需要在已有 Host 上分阶段增加远程依赖，从 `/advanced` 使用：

```ts
import { attachRemote, registerPlugins } from "webloom-framework/advanced";

const detach = await attachRemote(page, runtime);
await registerPlugins(page, [remoteConsumerPlugin]);
// 结束页面生命周期时：detach(); await page.dispose();
```

普通 `createWindowApp()` 不接受 Host 或测试 scope 注入，也不会根据 Worker manifest 创建
第二套 Window 单元。

## wire、快照与错误

唯一 Runtime wire 是 `webloom.runtime.v1`，消息为 snapshot、runtime-error、call、result、
error、cancel、next、credit。快照只有 ready 状态发布当前可调用 services；每条 peer 有
独立严格递增 revision。旧协议被明确拒绝，不尝试降级解析。

框架错误通过 `WebLoomError` 暴露，至少覆盖 `protocol_mismatch`、`invalid_snapshot`、
`capability_unavailable`、`contract_mismatch`、`request_validation_failed`、
`response_validation_failed`、`request_clone_failed`、`response_clone_failed`、
`transfer_invalid`、`handler_failed`、`call_timeout`、`request_cancelled`、
`service_revoked`、`service_stale`、`transport_unavailable`、
`runtime_initialization_failed` 和 `stream_overflow`。错误只带脱敏 message/details，
不回显 request、密钥、口令、凭据或授权 headers；发送请求后的超时不推断远端副作用一定
未发生。

## transfer 与 stream

RPC 契约可声明 `transfer.request(value)`、`transfer.response(value)`，stream 契约可声明
`transfer.item(value)`。顺序固定为 parser → extractor/去重/可达性校验 → `postMessage`；
接收端再次 parser。多个 TypedArray 视图共享同一个 backing buffer 时，转移其中一个会
转移整个 buffer 的所有权。发送后取消不恢复所有权，也不会自动重传；迟到结果不交付给
旧 proxy。

Stream handler 返回 `AsyncIterable`，订阅返回 `ready`、`closed` 和幂等 `cancel()`：

```ts
const sub = runtime.capability(Changes).subscribe(
  { userId: "123" },
  { onNext: renderChange, timeoutMs: 5_000 },
);
await sub.ready;
await sub.closed;
```

默认 credit 为 16，窗口范围为 1–256；没有 credit 时 producer 不拉取 iterator，item
交付完成后才补回 credit。sequence 从 1 连续递增；错序、重复、非法 credit、消费者
回调失败和撤销都会终止当前订阅，不影响其它 peer。长流没有自动心跳或持久重放保证。

## Scope、诊断与 React

`scope.listen()`、`scope.interval()`、`scope.subscribe()` 都返回幂等 release，并在同步
revoke 时解除资源；它们复用同一个 Scope resource ledger。异步创建使用 `scope.acquire()`，
晚到资源仍会在 Scope 已撤销后尽力释放。

App/Handle 提供不可变 `state()`、`inspect()`、`subscribe()`。inspect 只报告 Runtime、
插件/单元、scope、peer 和 framework-owned pending/stream 计数；`explain()` 返回稳定的
缺 provider、契约不匹配、依赖阻塞、scope 撤销和初始化失败原因，不包含业务载荷。

React 在 `/react`：

```tsx
import { WebLoomProvider, useCapability, usePluginState } from "webloom-framework/react";

function Panel() {
  const health = useCapability(Health);
  const plugin = usePluginState("coordinator");
  return <output>{plugin?.lifecycleState ?? health ? "ready" : "waiting"}</output>;
}

<WebLoomProvider app={runtime}><Panel /></WebLoomProvider>;
```

Provider 保存稳定 App 引用，hooks 使用外部 store 一致性机制；capability、plugin 和
selector 按相关状态订阅，不把每次全局版本变化广播给所有消费者。

## 入口边界

- 主入口：capability、插件、三个 Runtime 构造函数、App/Handle、契约/错误/Scope；不加载 React 或底层 transport。
- `/advanced`：Host/graph/registry、peer exposure、strict v4 bridge/provider 和分阶段装配。
- `/react`：WebLoomProvider、typed capability/plugin/resource hooks。
- `/testing`：生产 parser 驱动的 fake transport、可控 Worker/Scope harness。

真实浏览器验收必须使用 Bundler 产出的 SharedWorker chunk 和 Chromium；Node
MessageChannel 单测只证明 transport simulation，不替代 Window/SharedWorker realm、多个
页面、transfer ownership 或 Worker 退出验收。
