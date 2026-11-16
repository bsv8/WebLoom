# WebLoom v4 API 说明

WebLoom 0.6.0 只支持两个真实 JavaScript realm：`window-main` 和
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

## 依赖驱动的生命周期（无用户启停）

装配清单里的插件全部参与系统：没有 `startup`、`defaultEnabled`、`canDisable`，也没有
`host.enable()` / `host.disable()` / `host.submitIntent()` 与启停意图持久化。

- **启动顺序来自依赖图**：A 依赖 B、B 依赖 C 时，无论清单怎么排列，都按 C → B → A
  启动；互不依赖的分支可以并行。层级由已声明依赖计算，没有 priority 或插件分类。
  **已确定提供者的可选依赖也参与排序**：可选依赖的提供者已经在装配清单里时，消费者会
  等它就绪；没有提供者的可选依赖不产生等待边。
- **提供方就绪后消费者才启动**："已登记"不等于"已可用"。必需依赖缺失时运行单元进入
  `blocked` 并带 `blockedBy`（如 `missing:rpc:x@1`）；可选依赖缺席不等待。
- **计划销毁按反向拓扑**：释放提供者时先同步围栏整条受影响集合，再**分层**按 A → B → C
  清理——必须等消费者清理完成才释放提供者，同一层的无关插件可以并行。Host 整体销毁
  同样按这个顺序，而不是按登记顺序倒序。共享提供者不会因为一个消费者被释放而销毁。
- **失败与恢复分开表达**：初始化失败进入 `failed` 并保留脱敏原因，Runtime 不会因此
  失败；依赖恢复后按正向顺序建立新实例，不重放已发送的业务调用。
- **释放是生命周期事件**：`host.revoke(pluginId, reason)` 由可信装配层调用，记录运行
  条件（`blockedBy: ["revoked:<reason>"]`）且不自动重建；条件解除用
  `host.retry(pluginId)`。领域运行条件（锁定、账户切换）也可以通过
  `runtimeUnitAvailability` 表达，同样不会恢复任何用户启停存储。
- **状态只描述生命周期**：`kind` 为 `registered | starting | stopping | enabled |
  blocked | failed | cleanup-pending | unknown`，`lifecycleState` 为 `waiting |
  starting | running | stopping | failed`；快照与 `PluginState` 都不再包含
  `desiredEnabled` / `desiredRevision`。

```ts
const host = hostForWindowApp(app);            // /advanced
await host.revoke("storage-plugin", "wallet locked");
host.state("storage-plugin");                   // { kind: "blocked", blockedBy: ["revoked:wallet locked"] }
await host.retry("storage-plugin");             // 条件解除后按依赖顺序重建
```

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

## 三个访问面与插件实例消费视图

`ctx` 只在 setup 阶段可用。插件把 UI（页面、菜单、widget）交给应用挂载之后，setup 已经
结束，组件不应该再去持有 `ctx`、`Host` 或 `App`。Host 为每个真实运行实例签发一个受限
消费视图 `ctx.consumer`（类型 `PluginConsumer`），把“注册阶段属于哪个实例”和“消费阶段
按哪个实例读能力”绑定在一起：

| 字段/方法 | 中文含义与约束 |
| --- | --- |
| `pluginId` / `unitId` | 只读的插件与运行单元标识，仅供诊断展示。 |
| `instanceId` | 当前运行实例标识；同名插件重启必然变化。 |
| `status` | `"active"` 或 `"revoked"`；释放后先失效，再通知 UI。 |
| `capability(C)` | 按 typed 契约读取本实例已声明的 provides/dependencies。 |
| `optionalCapability(C)` | 已声明但当前缺席时返回 `undefined`。 |
| `subscribe(listener)` | 订阅目录/有效性变化，返回幂等退订函数。 |

可解析集合 = 该实例静态声明的 `provides + dependencies`；未声明、版本不匹配一律抛错，
`optionalCapability` 也不例外。视图只由 Host 签发：结构复制、`{...consumer}`、JSON 往返
和类型断言都拿不到合法身份（框架用私有登记簿而不是公开品牌字段）。视图不提供
`provide/handle/enable/dispose`、Host、App、根 Scope、消息总线和注册写入口。

每次读取都会重新核对提供方当前是否可用：提供者被释放后 `capability()` 立刻失败、
`optionalCapability()` 返回 undefined；恢复后读到新一代服务。可用期间重复读取同一契约
返回同一引用（React 快照依赖这一点），但该稳定性不跳过可用性判定。已经取到的普通
local 对象不在撤销范围内。

`ctx` 以实例有效期约束框架操作：`ctx.capability()`、`ctx.consumer` 与资源解析在实例释放
后都拒绝，但私有 Context、闭包和作者自定义的内部对象不受框架限制。

### 先声明，才能使用

跨插件依赖以具体 typed 契约及其提供者绑定为准。声明"依赖某个插件"不等于可以使用它的
全部服务：即使提供者已经在运行，未声明其对应服务的插件也必须在获取句柄或执行 handler
之前被拒绝；`optionalCapability` 与 `useHasPluginCapability` 只处理"已声明但当前缺席"，
不会把未声明变成 `undefined` / `false`。内置能力同样要显式声明，没有免检分支。

```ts
import { defineCapability, definePlugin } from "webloom-framework";

const Contacts = defineCapability<{ list(): string[] }>({
  kind: "local", id: "contacts.service", version: "1",
});

const page = definePlugin({
  id: "contacts-page",
  dependencies: [{ capability: Contacts }] as const,
  setup(ctx) {
    // 下游可信适配器捕获 consumer，与注册项一起保存。
    registerRoute({ id: "/contacts", render: () => <ContactsPage consumer={ctx.consumer} /> });
  },
});
```

注册项结构、路由/页面 schema、排序和跳转都仍由下游定义；框架只保证 consumer 与真实
实例一致。`ContributionAdapterInput.consumer`（`/advanced`）与 `ctx.consumer` 是同一个
对象，所以静态 manifest contribution 与动态注册共用同一条绑定规则。

### 插件 React 边界

`/react` 的插件入口只接受框架签发的 consumer，缺少 Provider 时报错，不回退到外围
`WebLoomProvider`：

```tsx
import { PluginConsumerProvider, usePluginCapability } from "webloom-framework/react";

function ContactsPage({ consumer }: { consumer: PluginConsumer }) {
  const contacts = usePluginCapability(Contacts);
  return <ul>{contacts.list().map((name) => <li key={name}>{name}</li>)}</ul>;
}

<PluginConsumerProvider consumer={consumer}><ContactsPage /></PluginConsumerProvider>;
```

- `usePluginCapability` / `useOptionalPluginCapability` / `useHasPluginCapability` 只按本
  实例已声明的能力读取；`has` 与 `optional` 不会吞掉未声明、错版本或身份错误。
- 快照与解析出的 client 引用稳定（`useSyncExternalStore`），不轮询，也不在 render 中
  启停或注册插件。
- 实例撤权后 Provider 立即停止渲染旧子树；同名重启得到新的 consumer，旧视图不会自动
  重绑。
- 在插件 Provider 子树内调用 `useWebLoomApp`、App capability hooks 或管理 hook
  （`usePluginRuntime`）直接拒绝，避免把装配层语义静默当成插件语义。
- 提供方导出的共享组件应在提供方自己的 Provider 下运行；嵌套 Provider 只影响组件自己
  的子树，不会把提供方的能力扩散给消费方父组件。

### 网页注册服务与所属 UI

网页插件向其他插件提供 typed UI 注册服务，条目 schema（页面/设置块/指示灯、排序、渲染）
由产品定义；框架负责可信归属、越权注销、撤销清理和迟到注册拒绝。调用方交出自己的
`ctx.scope`，归属由框架写入，**不需要也不允许自填 owner 字符串**：

```ts
// 贡献插件（例如 Storage）：私有实现留在闭包与私有 Context 里
const registration = createScopedRegistryView(ctx.capability(WEB_UI_REGISTRY), ctx.scope, {
  name: "web-ui",
  registrations: [{ method: "register", idArgument: 0, unregisterMethod: "unregister", ownerInstanceIdProperty: "ownerInstanceId" }],
});
registration.view.register({
  id: "/contacts",
  kind: "page",
  order: 10,
  title: "联系人",
  consumer: ctx.consumer,
  render: () => <ContactsView />,   // 组件内部仍在自己的私有 Context 中
});
```

- 只能注销或更新本实例登记过的条目；跨实例操作直接拒绝。更新规则用
  `updateIdArgument` / `immutableProperties` 声明，归属字段不能通过补丁改写（伪造他人
  实例抛错，正确值也会被剥离）。
- 实例释放时条目同步撤下；撤销后的迟到注册被拒绝，不会复活旧实例的条目。
- **异步注册在撤销之后才完成时，框架在完成回调里复核 scope 并立即回收该条目**，不会
  留下以旧实例身份残留的条目。
- 同名条目被新实例接管后，旧实例的清理（同步或异步）都不会误删它。
- 网页插件挂载时使用**贡献方的 consumer**，因此父组件不会获得贡献方的私有实现；网页
  插件也不需要反向依赖业务插件。

`createScopedRegistryView` 从 `/advanced` 导出；`isIssuedScopedRegistryView()` 用于核对
门面是否由框架签发。

### 实例资源的能力解析

插件经 `ctx.capability(RESOURCE_REGISTRY)` 拿到的是绑定当前实例的视图：`register` 的
owner 由 Host 写入真实 `instanceId`，插件不能伪造他人或 unowned owner，`unregister`
跨实例直接拒绝；实例撤销时按 owner 条件注销，旧实例的清理不会误删同名新实例的定义。

资源的 key/load/subscribe 三个阶段都先核对 owner 实例有效性，并使用定义所属实例的
typed resolver：

```ts
ctx.capability(RESOURCE_REGISTRY).register({
  id: "profile",
  scope: "plugin",
  invalidation: "immediate",
  key: (_args, context) => [context.capability(Session).accountId],
  load: async (_args, context, signal) => loadProfile(context.capability(Session).accountId, signal),
});
```

`ResourceContext` 因此只有 `capability(C)` / `optionalCapability(C)`；插件侧的字符串
`getCapability(id)` 已删除，它曾是绕过声明检查的旁路。owner 查不到、已撤销或自定义注册表
不支持 owner 绑定时一律拒绝，绝不降级成宿主资源。宿主自己登记的资源（装配层直接调用
注册表）仍走 `CreatePluginHostOptions.resourceCapabilityResolver`，它收到完整 typed
capability 对象而不是字符串 id，因此能同时核对 kind 与 version。

`optionalCapability` 与 `capability` 遵守同一套判定：已声明但当前缺席返回 undefined，未声明、
错版本与 owner 撤销仍然抛错。因此可选依赖缺席不会把资源推进 `error` 状态。

跨插件读取资源应由提供方导出一个 typed 能力（例如“受限的联系人读取/订阅接口”），消费方
声明依赖；框架不新增逐资源权限表、资源授权 wire 或按资源 id 前缀自动授权。

### 撤权保证与限制

必须区分两种撤销：

- 入口撤销：同一实例被释放后，consumer 与 `ctx` 的新能力解析立即抛错；保留的远程
  client/stream 绑定该实例的 Scope，旧代理、请求与订阅按已有生命周期规则失败，不退回
  根 Scope。
- 远程调用撤销：已经取得的 RPC/stream 句柄同样停止工作，撤销后不再产生新调用。
- **句柄绑定服务实例世代**：同 realm 的 RPC/stream 句柄在解析时绑定当前提供者的
  `serviceInstanceId`。提供者被释放并重建后，旧句柄以 `service_stale`（世代已变）或
  `service_revoked`（已无提供者）失败，**不会自动改用新实例**；重新解析才得到绑定新世代
  的句柄。同一世代内重复解析仍返回同一引用（React 快照依赖这一点）。

资源视图同样按实例收口：`instanceResourceRegistry.get()` / `_ids()` 只返回本实例的定义。
其他插件的定义可能闭包捕获了它的私有实现，取到就等于绕过私有边界，因此跨实例读取一律
按"不存在"处理。插件上下文不暴露全局 `ResourceStore`；可信装配层保留完整注册表视图
用于执行与清理。

本轮不做通用深层 Proxy，因此**不承诺**撤销以下情况：local capability 返回的普通对象、
插件已复制的数据、已读取的对象属性或纯算法结果。带副作用的 local 服务必须由提供者或
可信适配器自己检查实例有效性，或只暴露窄 facade；最终 I/O 仍由领域 authority 复核。
同一 realm 内的内置插件仍是可信代码，本边界不是 JavaScript 安全沙箱：手工读取公开
context 或导入 `/advanced` 仍需下游源码门禁。

## 完整插件与多 Worker 槽位

一个业务插件可以同时含 Web 单元与 Worker 单元，共享同一个 `pluginId`：

```ts
import { definePlugin, startSharedWorkerApp } from "webloom-framework";
import { definePluginPackage, implementationsForRuntime, bindUnitSlot, attachRemote } from "webloom-framework/advanced";

const storagePackage = definePluginPackage({
  id: "storage",
  units: [
    { runtime: "shared-worker", slot: "storage", unit: workerUnit },
    { runtime: "window-main", slot: "storage", unit: webUnit },
  ],
});

// Worker realm：只装配 Worker 单元。
startSharedWorkerApp({ id: "storage-runtime", plugins: implementationsForRuntime(storagePackage, "shared-worker"), expose: [StorageFiles] });

// 页面 realm：只装配 Web 单元，并声明每个依赖来自哪个槽位。
const bindings = bindUnitSlot({ pluginId: "storage", unitId: "web", slotId: "storage", capabilities: [{ capability: StorageFiles }] });
const detach = await attachRemote(app, storageHandle, "storage");
```

要点：

- **单元只声明一次**：provides、依赖、私有入口都写在各自的 `definePlugin` 单元里；插件包
  只负责合并静态身份与部署槽位，不搬运函数源码、不序列化闭包。
- **槽位 ≠ Runtime 类型**：`bindUnitSlot` 把某个单元的远端依赖绑到具体槽位；未绑定时只有
  在该 Runtime 上唯一发布该能力时才会解析，不会"扫描第一个服务"。
- **并存与替换**：`attachRemote` 返回连接世代；`detach`（或 `host.detachRemote`）传入旧世代
  时是空操作，因此延迟卸载不会误伤同槽位后来替换上的新连接。
- **私有入口**：单元用 `privateProvides` 声明、`ctx.handlePrivate()` 注册，调用方用
  `ctx.privateCapability()` / `consumer.privateCapability()` 解析。私有服务带 `private` 标记
  进入 Runtime 快照（否则跨 realm 连不上），但公共 `provides`、`ctx.capability()`、
  `host.optionalCapability()` 与 Connect 自动导出名单都拿不到它。
- **私有调用需要实例与连接绑定的票据**：`definePrivateCapability({ grantId })` 的机密由装配层
  签发，写进 Host 选项 `privateCapabilities`（授权键是**调用单元** `pluginId + unitId`），
  **不进服务目录**。Host 内部把它拆成两层：
  - **装配层配置**：静态机密，撤销不会删除；
  - **实例授权记录** `{ secret, instanceId }`：单元实例启动时签发，撤销时回收，重建时按配置
    重新签发新的 `instanceId`。
- 票据 `derivePrivateGrant(机密, connectionId, instanceId)` 带**连接分量 + 实例分量**，附在
  `RpcCallOptions.grantId` 上（RPC 与 stream 一样）：
  - 接收侧按**候选记录** `{pluginId, unitId, secret, instanceId}` 逐一匹配：候选由装配配置
    与对端快照中的**同一单元**配对生成，机密与实例一一对应，不做交叉匹配；因此 A 单元的机密
    配 B 单元的实例不会通过；
  - 两端都在执行 handler 之前完成检查，失败即 `permission_denied`；
  - 调用侧的私有句柄每次调用前复核本实例授权记录：实例撤销后旧句柄发不出请求，重建后
    重新解析即可恢复。
- **调用侧必须向提供 realm 发布单元快照**（例如页面连接时传 `client: { app }`）：接收端据此
  判断消费实例是否仍然活着。空快照表示没有可授权实例，直接拒绝，**不会**降级成只校验连接。
- 同一机密需要在两端（调用 realm 与提供 realm）都登记，授权键是**调用单元**
  `pluginId + unitId`；不同单元可登记不同机密，不依赖登记顺序，也不信任调用者自填身份。
- 依赖来源与实际解析一致：声明远端来源或绑定槽位的依赖只能从该槽位解析，本地同名服务不会顶替；
  声明同 realm 却绑定远端槽位属于声明冲突，直接拒绝。
- **私有句柄与其他句柄同等受管**：私有入口复用已验证的 RPC/stream 生命周期——句柄绑定提供者
  世代、每次调用复核、提供者撤销时取消在途调用/流并拒绝迟到结果，重建后必须重新解析。

## 入口边界

- 主入口：capability、插件、三个 Runtime 构造函数、App/Handle、契约/错误/Scope、`PluginConsumer` 类型；不加载 React 或底层 transport。
- `/advanced`：Host/graph/registry、peer exposure、贡献适配器（含 `consumer`）、strict v4 bridge/provider 和分阶段装配。
- `/react`：WebLoomProvider、`PluginConsumerProvider` 与三个插件 hook、typed capability/plugin/resource hooks。
- `/testing`：生产 parser 驱动的 fake transport、可控 Worker/Scope harness。

下游迁移材料：[`plugin-consumer-migration.md`](./plugin-consumer-migration.md)（实例消费视图
与资源视图）与 [`plugin-service-migration.md`](./plugin-service-migration.md)（服务模型、
无用户启停与行为变化）。


真实浏览器验收必须使用 Bundler 产出的 SharedWorker chunk 和 Chromium；Node
MessageChannel 单测只证明 transport simulation，不替代 Window/SharedWorker realm、多个
页面、transfer ownership 或 Worker 退出验收。

## Go 后台与既有产品传输

源码中的 `go/` 是独立 Go module，导入路径为
`github.com/bsv8/WebLoom/go/webloom`，尚未发布 Go 版本。它不是新增的 JS
RuntimeKind；Window/SharedWorker 的既有行为不变。

Go 使用 `Plugin{Manifest, Setup}` 声明单元，Manifest 中的 PluginID 是业务归属、
UnitID 是运行单元，Provides/Dependencies 使用 `{kind,id,version}` 能力身份。
`Start(ctx, plugins)` 在运行 Setup 前检查重复能力、缺失依赖与环，按依赖顺序启动；
Setup 失败清理已启动实例。当前支持 local、rpc，不支持 stream 或单插件热重启。

Setup 内通过 `Provide` 注册普通进程内服务、`Handle` 注册 RPC；`Service`、`RPC`
取得已声明依赖。内部服务是受信代码协作，不是进程沙箱。`Context()` 用于取消后台
工作，`OnDispose` 注册资源清理；两个注册方法只在 Setup 阶段使用。

`Close(ctx)` 停止新调用、取消在途调用，待执行退出后逆序清理。等待超时返回错误，
后台仍继续排空；再次 Close 可以等待同一次真实清理。取消不撤销已经发生的副作用。
宿主停止 Runtime，插件自身不应在自己的 handler 内等待关闭整个 Runtime。

Window 侧 `defineDaemonBridge({id, transport, bindings})` 返回普通插件定义，
每个 binding 显式映射一个 typed RPC capability 到产品已有方法。transport 实现
`call(method, request, {signal})`，负责网络、认证、重连与编码。桥接插件不自建连接，
停止前台不会关闭后台，也不会自动把所有后台能力暴露到网络。

完整调用示例见 `examples/notes/frontend.ts` 和 `go/examples/notes/main.go`。
Go 示例的逐行 stdin/stdout JSON 仅是可运行演示传输，不是正式产品网络协议。
