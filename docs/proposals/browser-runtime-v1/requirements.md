# WebLoom 浏览器双运行时迭代需求

## 1. 文档信息

- 项目：WebLoom
- 迭代：浏览器双运行时 v1
- 状态：需求已确认，待实施
- 文档性质：破坏性简化迭代；不代表当前代码已经具备本文能力
- 关联施工单：[浏览器双运行时施工单](./implementation-plan.md)

本文定义 WebLoom 从“运行环境标签 + 宿主手工装配”收敛为“真实 Window / SharedWorker 运行时”的需求，同时落实初始化消融结果。WebLoom 只面向浏览器，不建设服务端 PluginHost。

## 2. 背景与当前问题

当前 `execution`、`lifetime` 和 `meta.kind` 都是字符串。其中：

- `execution` 只参与运行单元筛选和依赖匹配，框架不会据此创建 Window 或 SharedWorker；
- `lifetime` 在未注入宿主 `scopeResolver` 时主要作为 Scope 名称和依赖字段，不会自动产生对应的启动、重建或停止行为；
- `meta.kind` 不影响 WebLoom 的运行逻辑，在下游项目中又常与 `displayGroup` 重复；
- 最小插件需要分别创建 Manifest、setup、Implementation Registry、Host，再手工 `register()`；
- `MessagePort`、握手、服务快照、旧代理失效和重连由使用者重复装配；
- 测试中的同页面 `MessageChannel` 容易被误解为真实 Worker 执行。

这些问题使 API 字段多于实际语义，也使使用者无法仅凭 Manifest 判断代码最终运行在哪个 JavaScript realm。

## 3. 已确认决策

1. WebLoom 是纯浏览器框架。
2. v1 只支持 `window-main` 和 `shared-worker` 两种真实运行时。
3. 不设计、不实现 `server PluginHost`；Node 只作为单元测试执行器。
4. v1 不支持 `service-worker`；以后是否支持另立需求。
5. 框架必须真实创建或接管运行空间，运行时名称不能只是筛选标签。
6. SharedWorker 与一个或多个 Window 的 `MessagePort`、握手、RPC、快照、断线和重连由框架封装。
7. 删除公开 `lifetime` 模型；所有 RuntimeUnit 使用统一 Runtime 生命周期。
8. 删除无运行语义的 `PluginMeta.kind` / `PluginKind`。
9. 每个 RuntimeUnit 实例仍由框架自动创建内部 ResourceScope，用于撤权、取消和清理；取消 `lifetime` 不等于取消 Scope。
10. Keymaster 的 Vault lock/unlock、owner、`sessionEpoch`、桶世代和最终 I/O fence 属于 Keymaster 业务状态，不进入 WebLoom 通用生命周期分类。
11. 插件静态描述与可执行实现继续在框架内部保持分离；跨 Worker 不传输函数。
12. 简单插件不需要理解或手工创建 Implementation Registry。

## 4. 产品目标

- 使用 `createWindowApp()` 在当前 Window 中创建唯一 Window Runtime 和 PluginHost。
- 使用 `connectSharedWorker()` 从 Window 创建并连接真实 SharedWorker。
- 使用 `startSharedWorkerApp()` 在 `SharedWorkerGlobalScope` 中创建唯一 Worker Runtime 和 PluginHost。
- 一个 SharedWorker Runtime 可服务多个 Window，但同一个 RuntimeUnit 在该 Worker 中只存在一个实例。
- 框架统一处理运行时身份、连接状态、服务发现、远程 capability 和旧引用失效。
- 把最小 Window 插件初始化缩减为“定义插件 + 创建应用”两项主要操作。
- 让字段是否存在与框架是否执行其语义保持一致。

## 5. 非目标

- 不支持 Node、Deno、Bun、Cloudflare Worker 或其他服务端运行环境。
- 不把普通 HTTP/WebSocket 后台 API 描述为 WebLoom Runtime。
- 不实现 Service Worker 的 install、activate、fetch 或 background sync 生命周期。
- 不把 SharedWorker 拆成每个 Window 一个插件实例。
- 不让浏览器页面控制服务端进程或部署生命周期。
- 不让框架理解钱包、私钥、owner、存储桶或 Keymaster 插件分类。
- 不通过 `postMessage`、结构化克隆或代码字符串把 setup 函数传入 Worker。
- 不因为本次初始化简化而降低远程服务的契约版本、实例身份或旧引用失效校验。

## 6. 术语与字段

| 字段/术语 | 中文含义 |
|---|---|
| `RuntimeKind` | 真实 JavaScript 运行空间类型；v1 仅有 `window-main`、`shared-worker` |
| `Runtime` | 某个真实 Window 或 SharedWorker 中由框架管理的运行时实例 |
| `runtimeInstanceId` | Runtime 每次启动生成的不可复用身份 |
| `RuntimeUnit` | 一个插件在指定 Runtime 中运行的代码单元 |
| `unitInstanceId` | RuntimeUnit 每次启动生成的不可复用身份 |
| `RuntimeHandle` | Window 侧观察或使用 SharedWorker Runtime 的封装句柄 |
| `ResourceScope` | 框架为 RuntimeUnit 实例自动建立的资源归属、撤权与清理边界 |
| `capability` | 插件提供或依赖的服务契约标识 |
| `contractVersion` | 跨运行时 capability 的精确协议版本 |

建议目标类型：

```ts
export type RuntimeKind = "window-main" | "shared-worker";

export interface RuntimeUnitDescriptor {
  id: string;
  runtime: RuntimeKind;
  dependencies?: readonly RuntimeDependency[];
  provides?: readonly string[];
  providedContracts?: Readonly<Record<string, string>>;
  permissions?: readonly string[];
  config?: Readonly<Record<string, unknown>>;
}
```

`runtime` 回答“代码在哪里运行”。v1 不再提供第二个 `lifetime` 维度，也不拼接 `window-main-plugin` 一类复合字符串。

## 7. 统一 Runtime 生命周期

### 7.1 实例存在条件

RuntimeUnit 实例只在以下条件全部满足时存在：

```text
目标 Runtime 存活
AND 插件启用意图为 true
AND 硬依赖已就绪
AND 当前 Runtime 已装配对应实现
```

任一条件失效，框架必须停止实例。

### 7.2 Window 语义

- 每个页面文档创建一个 `window-main` Runtime；
- 插件启用后，每个匹配的 RuntimeUnit 在该 Window 中最多一个实例；
- 页面永久销毁或 App 显式 `dispose()` 时停止全部本地实例；
- BFCache 暂停与永久销毁必须由浏览器适配层区分，不能把可恢复页面提前永久关闭。

### 7.3 SharedWorker 语义

- `connectSharedWorker()` 必须调用真实 `new SharedWorker(..., { type: "module" })`；
- Worker 入口通过 `startSharedWorkerApp()` 创建一个共享 PluginHost；
- 多个 Window 连接同一 Worker 时，共享同一批 Worker RuntimeUnit 实例；
- Window 连接是 Transport 客户端，不创建另一套插件生命周期；
- 最后一个 Window 断开不等同于 Worker Runtime 已销毁，框架不得伪造 Runtime stop；
- 浏览器终止 Worker 后，下一次启动必须生成新的 `runtimeInstanceId` 和全部 `unitInstanceId`。

### 7.4 插件停用

插件停用时，框架必须按统一顺序：

1. 同步阻止新 capability 获取和新远程调用；
2. 撤销旧服务引用；
3. 触发实例 Scope 的 `AbortSignal`；
4. 执行 setup 返回的 teardown 与 `ctx.onDispose()` 清理；
5. 发布停止或清理失败状态；
6. 再次启用时创建新的 `unitInstanceId`，不得复用旧实例。

插件应响应 `AbortSignal` 并登记资源清理，但框架不能把安全性完全交给插件自律。框架管理的 capability、代理和租约必须在撤权后拒绝旧实例继续使用。

## 8. Scope 的保留边界

公开 `lifetime`、宿主 `defaultLifetime` 和按字符串选择父 Scope 的接口必须删除。框架仍为每个 RuntimeUnit 实例建立内部 ResourceScope：

```text
Runtime
└─ RuntimeUnit instance
   └─ ResourceScope
      ├─ AbortSignal
      ├─ capability ownership
      ├─ task ownership
      ├─ subscription ownership
      └─ cleanup callbacks
```

`scopeId` 可以继续作为内部实例绑定和远程引用防重放字段，但它不再表示用户声明的 `root`、`owner-session` 或其他 lifetime 分类。

应用领域状态变化由应用自己的 Coordinator/服务控制器处理。例如 Keymaster 锁定时推进 `sessionEpoch`、撤销 grant、清空私钥并发布新服务快照；WebLoom 只根据新快照使旧代理失效。

## 9. SharedWorker 封装需求

### FR-001 Window 连接入口

Window 侧提供单一高层入口：

```ts
const coordinator = await connectSharedWorker({
  id: "coordinator",
  // Vite: import coordinatorWorkerUrl from "./coordinator.worker.ts?sharedworker&url";
  url: coordinatorWorkerUrl,
});
```

普通使用者不需要接触原始 `MessagePort`、手写 codec/handshake 或维护 snapshot revision。

### FR-002 Worker 启动入口

SharedWorker 文件提供单一启动入口：

```ts
startSharedWorkerApp({
  id: "coordinator",
  plugins: [storageWorker, vaultWorker],
});
```

该调用负责安装 `onconnect`、创建唯一 Host、接收多个端口并发布运行时快照。

### FR-003 RuntimeHandle

`connectSharedWorker()` 返回的句柄至少提供：

| 成员 | 作用 |
|---|---|
| `runtimeId` | 逻辑运行时标识 |
| `runtimeInstanceId` | 当前物理 Worker 启动身份 |
| `state()` | `connecting / ready / disconnected / failed` 状态 |
| `ready()` | 等待握手和首个完整基线快照 |
| `capability()` | 获取绑定当前实例与契约版本的远程代理 |
| `subscribe()` | 观察运行时/单元/服务快照变化 |
| `dispose()` | 关闭当前 Window 的连接并永久撤销本句柄 |

默认 API 不暴露原始端口。确有低层协议扩展需要时，必须通过单独的高级扩展接口，而不是让所有插件处理 Port。

### FR-004 连接与快照

- 每条物理连接有不可复用 `connectionId`；
- 握手必须校验协议版本；
- 首个 snapshot 必须是完整 baseline；
- 增量 revision 必须连续；
- 断线、revision gap、Worker 重启或 Provider 实例变化后，旧代理永久失效；
- 框架不得自动重放可能产生外部副作用的调用；
- 自动重连只能建立新连接和新代理，不能让旧代理静默换绑。

### FR-005 多 Window

- 同一 SharedWorker 可同时登记多个 Window 连接；
- 每个端口的请求、取消、订阅和清理相互隔离；
- 单个 Window 断开不得停止共享 RuntimeUnit；
- Worker RuntimeUnit 的状态以 Worker 自身快照为准，Window 不根据 Manifest 猜测 ready。

## 10. 初始化消融需求

### 10.1 当前样板

当前最小插件需要显式处理：Manifest、RuntimeUnit、`execution`、`lifetime`、setup、provided contract、Implementation Registry、Host 和 `host.register()`。

### 10.2 消融结果

| 当前公开步骤/字段 | v1 处理 | 保留约束 |
|---|---|---|
| `execution` 任意字符串 | 替换为受限 `runtime` | 仅 `window-main/shared-worker` |
| `lifetime` | 删除 | 实例统一随 Runtime + 插件启用状态 |
| `defaultLifetime` | 删除 | 不再存在 lifetime 默认值 |
| `RuntimeUnitDependency.scope` | 删除 | 依赖绑定 Runtime、Provider 实例和契约版本 |
| `PluginMeta.kind` / `PluginKind` | 删除 | 产品 UI 分类由下游应用维护 |
| WebLoom `displayGroup` | 从核心删除 | Keymaster 可保留自己的 UI 字段 |
| 手工 Implementation Registry | 从普通 API 隐藏 | 内部仍按 pluginId + unitId 精确解析 |
| 手工 `host.register()` | 创建 App 时批量注册 | 初始化失败必须可观察 |
| 本地 capability 版本样板 | helper 可推导 | 跨 Runtime 仍必须显式版本化 |
| `defaultEnabled/canDisable/startup` 组合 | helper 提供安全默认值 | required 插件不能出现矛盾组合 |

### 10.3 最小 Window API

目标使用方式：

```ts
const hello = definePlugin({
  id: "hello",
  setup(ctx) {
    ctx.provide("hello.service", service);
  },
});

const app = await createWindowApp({ plugins: [hello] });
```

验收要求：

- 最小示例只需导入 `definePlugin`、`createWindowApp`；
- 不填写 runtime、lifetime、kind、registry 或手工 register；
- `createWindowApp()` Promise 只有在初始必需插件完成启动后才成功；
- 初始化失败返回包含 pluginId/unitId/phase 的结构化错误；
- `app.dispose()` 同步撤权并返回可等待的清理结果。

### 10.4 描述与实现分离

`definePlugin()` 可以在作者 API 上合并声明与本地 setup，但其返回值必须能够明确拆成：

```text
serializable descriptor
local executable implementation
```

多运行时插件必须在 Window bundle 和 SharedWorker bundle 中分别导入对应实现。静态 descriptor 可以共享，setup 函数不能跨 realm 传输。

## 11. 插件元数据精简

### 11.1 删除 `meta.kind`

删除插件分类字段及 `core/platform/business` 通用类型。分类不参与 WebLoom 调度、权限或生命周期，不属于框架真值。

### 11.2 状态字段不在本次删除范围

以下 `kind` 具有判别联合或协议语义，不因删除 `PluginMeta.kind` 自动删除：

- `PluginState.kind`：当前运行状态；
- wire message 的 `kind/type`：消息类别；
- 领域对象自己的 `kind`：由领域契约决定。

若后续把 `PluginState.kind` 重命名为 `state`，必须另开兼容任务，不能与无用分类字段混删。

## 12. 依赖与远程 capability

- 同 Runtime 的依赖可以由 helper 推导默认 `contractVersion`；
- 跨 Runtime 依赖必须显式声明 capability、精确 contractVersion 和来源 Runtime；
- 删除原来的依赖 `scope/lifetime` 匹配；
- 远程引用继续绑定 connection、runtime instance、provider instance、contractVersion、status 和 snapshot revision；
- 产品可以在远程引用 attributes 中加入 `sessionEpoch`、owner generation 等领域身份，但 WebLoom 不解释这些字段；
- 最终 Provider 或 I/O 边界仍需验证当前引用，不能只依赖 Window 侧代理检查。

## 13. 测试运行时边界

- Node/Vitest 测试环境不命名为 `server`，也不进入 `RuntimeKind`；
- 单元测试可使用内存 TestHost；
- 协议测试可使用成对 MessagePort，但必须明确标注为 transport simulation；
- “代码真的运行在 SharedWorkerGlobalScope”只能由真实浏览器测试证明；
- 真实测试必须断言 Window 全局和 Worker 全局不同，不能只检查消息往返成功。

## 14. 兼容与迁移

本迭代允许破坏性修改。迁移顺序必须是：

1. WebLoom 新类型和高层入口完成；
2. WebLoom 自身测试与真实浏览器验收完成；
3. DemoWebLoom 改为最简 API，并把 remote 示例改成真实 SharedWorker；
4. Keymaster Window Host 接入 `createWindowApp()`；
5. Keymaster Coordinator Worker 接入 `startSharedWorkerApp()`；
6. 确认 Worker 内真实 Host 接管后，再删除 Keymaster 手工 WorkerUnitRegistry 和旧装配层；
7. 删除 WebLoom 的 execution/lifetime/kind 兼容入口。

不得先删除 Keymaster 当前真实 SharedWorker、私钥隔离、会话世代或最终 I/O fence，再等待新框架补齐。

## 15. 验收矩阵

| 场景 | 必须结果 |
|---|---|
| 最小 Window 插件 | 两个主要 API 完成定义和启动，无 registry/register/lifetime/kind 样板 |
| 插件 disable → enable | 旧 capability 立即撤销，新实例 ID 与旧实例不同 |
| Window 永久销毁 | 本地实例撤权并执行清理 |
| 两个页面连接 SharedWorker | Worker 单元只有一个实例，两个连接均可调用 |
| 一个页面断开 | 只关闭该连接，另一个页面和 Worker 单元继续工作 |
| Worker 重启 | runtime/unit/provider identity 全部变化，旧代理永久失败 |
| 握手版本不兼容 | fail closed，不发布 ready capability |
| 快照 revision gap | 当前连接进入 stale/disconnected，不静默接受后续增量 |
| 跨 Runtime 调用 | 使用精确契约版本，调用通过真实 MessagePort |
| 插件忽略 AbortSignal | 新调用仍被框架拒绝，旧 capability 不复活 |
| Node transport test | 明确标记为模拟，不宣称真实 SharedWorker 通过 |
| Keymaster 锁定 | 私钥仍在 Coordinator 中清零，旧远程 crypto proxy 失效 |

## 16. 完成定义

满足以下条件才算本迭代完成：

- 公开 API 不再包含 `lifetime`、`defaultLifetime`、`PluginMeta.kind`、`PluginKind`；
- 普通初始化不再要求手工 Implementation Registry 或逐个 `host.register()`；
- `window-main` 与 `shared-worker` 都有真实 RuntimeHost；
- SharedWorker 高层封装覆盖连接、握手、快照、代理、重连和 dispose；
- 单元、类型、包消费者和真实浏览器测试全部通过；
- DemoWebLoom 不再用同页面 MessageChannel 冒充 Worker；
- Keymaster 仍保持私钥不离开 Coordinator Worker 的生产边界；
- 文档分别报告自动化测试、真实浏览器测试和 Keymaster 集成结果，不相互替代。
