# WebLoom SharedWorker call-first 消融施工单

## 1. 文档状态

- 状态：SWCF-001～008、SWCF-010 的代码与本地/真实 Chromium 验收已完成；npm registry 发布待完成，SWCF-009 已正式拆为后续 typed-transfer 版本
- 施工性质：破坏性协议与 API 精简
- 目标发布：`webloom-framework@0.3.0`
- 涉及仓库：WebLoom、DemoWebLoom、keymaster.cc
- 本文是施工要求；当前实现与验收结果以各仓库工作树、验证记录和最终交付报告为准。
  由于 `webloom-framework@0.3.0` 尚未发布到 npm，公开 registry 消费者验收仍未完成；
  Keymaster 的 `onConnection/onPortConnect` 按 SWCF-009 保留为迁移接缝；它们不是本版本
  的完成项，必须在后续 typed capability/transfer API 完成并通过安全回归后删除。

本文覆盖《浏览器双运行时施工单》中与 SharedWorker `hello`、服务桥
`handshake`、`baseline/resync`、握手超时和自动重连有关的旧要求。其余
PluginHost、RuntimeUnit、ResourceScope、真实浏览器 realm 和下游安全要求继续有效。

## 2. 施工目标

把 SharedWorker 从“连接握手成功后才允许取得代理”改成 call-first 模型：

```text
创建 SharedWorker → 立即返回 RuntimeHandle → capability() 返回惰性代理
                                             ↓
                                      proxy.call() 统一返回结果或错误
```

连接建立不再证明后续调用可成功。Runtime 状态和服务目录只用于观察、路由和
实例绑定；协议不兼容、服务未就绪、Provider 已撤销、断线和超时统一从
`proxy.call()` 的 Promise 返回。

## 3. 不可退让的边界

### 3.1 必须删除

- `webloom.runtime.hello`；
- RemoteService `handshake` 控制消息；
- Runtime 连接阶段的 handshake timer 和 `handshakeTimeoutMs`；
- `baseline` 字段、连续 revision 要求和 `webloom.runtime.resync`；
- Runtime Host 与 MessagePort Provider 重复发送的服务目录；
- `connectSharedWorker()` 内建的 `autoReconnect`、`reconnectDelayMs`；
- `RuntimeHandle.ready()`；
- 因握手或 baseline 未完成而由 `capability()` 同步抛错的行为；
- 仅为旧 WebLoom wire/API 存在的兼容分支。

### 3.2 必须保留

- 真实 module `SharedWorker` 和真实 `SharedWorkerGlobalScope`；
- 每次 Worker 启动唯一的 `runtimeInstanceId`；
- 每次服务实例唯一且不可复用的 `serviceInstanceId`；
- 精确 `contractVersion`；
- 旧代理永久失效，禁止静默换绑；
- Provider 端每次调用重新验证实例、契约和授权状态；
- 同步 revoke 后异步 drain/teardown 的顺序；
- `AbortSignal`、调用 deadline、取消消息和 pending call 清理；
- 禁止框架自动重放调用；
- Keymaster 的 owner、session epoch、bucket generation、grant、authority CAS、
  handover generation、durable/final-I/O lease；
- Local 桶继续使用 Window `localStorage` 页面桥，不改成 IndexedDB 或 Worker 存储。

### 3.3 名称相同但不得删除的机制

以下属于领域安全协议，不属于本次删除的“连接可用性握手”：

- `UpgradeGate.handshake()`；
- Keymaster 发布接管、世代检查和 I/O lease；
- Sat/Channel/P2P 领域自己的连接身份；
- 需要显式认证或签发授权会话的业务握手。

不得通过全仓机械删除 `handshake` 或 `connectionId` 完成本施工单。

## 4. 目标公共 API

### 4.1 `connectSharedWorker()`

目标 API 同步建立本地句柄：

```ts
const runtime = connectSharedWorker({
  id: "keymaster-coordinator",
  url: coordinatorWorkerUrl,
  defaultCallTimeoutMs: 30_000,
});

const crypto = runtime.capability("keymaster.crypto", {
  contractVersion: "keymaster.crypto.v1",
});

const result = await crypto.call(request, {
  signal,
  timeoutMs: 10_000,
  operationId,
});
```

`connectSharedWorker()` 可以因调用参数非法、环境不支持 SharedWorker 或构造器同步
失败而抛错；它不得等待 Worker 回包，也不得因远端协议、启动状态或服务目录拒绝。

目标 `ConnectSharedWorkerOptions`：

```ts
interface ConnectSharedWorkerOptions {
  id: string;
  url: string | URL;
  name?: string;
  credentials?: RequestCredentials;
  defaultCallTimeoutMs?: number;
}
```

删除 `autoReconnect`、`reconnectDelayMs`、`handshakeTimeoutMs` 和迁移钩子。
测试注入若需要 `workerFactory`，把它移入 testing 入口，不扩散到普通 API。

### 4.2 `RuntimeHandle`

```ts
interface RuntimeHandle {
  readonly runtimeKind: "shared-worker";
  readonly runtimeId: string;
  readonly runtimeInstanceId?: string;
  state(): RuntimeStatusSnapshot;
  capability<T = unknown>(
    capabilityId: string,
    options?: { contractVersion?: string },
  ): RemoteServiceProxy & { readonly serviceType?: T };
  subscribe(listener: RuntimeStatusListener): () => void;
  dispose(reason?: string): Promise<void>;
}
```

- 删除 `ready()`；
- 删除公开 `connectionId`；调试需要时可以在内部诊断对象中使用，但不得成为调用授权；
- `state()/subscribe()` 是观测接口，不是调用成功承诺；
- `capability()` 总是返回一个惰性代理，不检查当前 `ready`；
- `dispose()` 同步撤销代理和拒绝 pending calls，再异步完成端口/资源清理。

### 4.3 惰性代理绑定规则

1. 代理创建时可以尚无服务目录。
2. 第一次调用等待一个精确匹配的 `capabilityId + contractVersion`，等待时间计入本次
   调用的 deadline。
3. 第一次获得匹配服务时，代理原子地绑定该 `runtimeInstanceId + serviceInstanceId`。
4. 多个并发首次调用共享同一个绑定结果，不能分别绑定不同实例。
5. 一旦绑定，代理终身不换绑；实例撤销、Worker 重启或显式 dispose 后只会失败。
6. 调用方需要恢复时必须创建新 RuntimeHandle 和新代理。

## 5. 目标 wire 协议

### 5.1 单向完整状态快照

Worker 在端口接入后以及 Runtime 状态变化后发送一类完整快照：

```ts
interface RuntimeSnapshot {
  type: "webloom.runtime.snapshot";
  protocolVersion: "webloom.runtime.v2";
  runtimeId: string;
  runtimeKind: "shared-worker";
  runtimeInstanceId: string;
  revision: number;
  state: "starting" | "ready" | "failed" | "stopping" | "disposed";
  units: readonly RuntimeSnapshotUnit[];
  services: readonly RemoteServiceReference[];
}
```

规则：

- 每一份快照都是完整真值，不存在 baseline/incremental 两种语义；
- 同一 `runtimeInstanceId` 只接受严格大于当前值的 revision，重复或回退直接忽略；
- 新 `runtimeInstanceId` 先同步撤销全部旧代理，再接受其任意非负首 revision；
- 无 revision-gap 和 resync；丢包后下一份完整快照自然收敛；
- 外层结构解析和版本接受必须分开；`protocolVersion` 可解析但不匹配时记录状态，
  实际调用返回 `protocol_mismatch`；
- 完全无法解析对端协议时，由调用 deadline 收敛为 `call_timeout`。

### 5.2 服务引用

把 `providerInstanceId` 统一命名为 `serviceInstanceId`。本次快照 revision 只放在
快照顶层，不复制到每条服务引用。物理端口身份不进入引用。

```ts
interface RemoteServiceReference {
  capabilityId: string;
  contractVersion: string;
  runtime: RuntimeKind;
  runtimeInstanceId: string;
  serviceInstanceId: string;
  status: "starting" | "ready" | "unavailable" | "failed";
  attributes: Readonly<Record<string, unknown>>;
  grantId?: string;
  authorizationRevision?: number;
}
```

`scopeId`、`handoverGeneration` 等领域值不再作为通用传输的一级寻址字段；需要公开
观察的放入 `attributes`，需要安全判断的仍由 Keymaster 权威状态和最终 I/O fence
校验。`grantId` 不是授权事实，Provider 不得因客户端回显它就放行。

### 5.3 调用消息

```ts
interface RemoteServiceCallMessage {
  type: "webloom.remote-service.call";
  protocolVersion: "webloom.remote-service.v2";
  callId: string;
  capabilityId: string;
  contractVersion: string;
  serviceInstanceId: string;
  operationId?: string;
  grantId?: string;
  request: unknown;
}
```

`result`、`error`、`cancel` 只需回显 `protocolVersion + callId + serviceInstanceId`。
删除这些消息中的 `connectionId` 和完整 `reference` 回传。Provider 用接收消息的
MessagePort 找到端点，用自己的权威目录重建和校验引用，不能信任客户端提交的
`attributes`、scope、世代或 status。

结构化错误至少稳定覆盖：

- `transport_unavailable`；
- `call_timeout`；
- `runtime_initialization_failed`；
- `protocol_mismatch`；
- `capability_unavailable`；
- `contract_version_mismatch`；
- `service_stale`；
- `service_revoked`；
- `permission_denied`；
- `request_cancelled`；
- `handler_failed`。

错误必须保留 `code` 和可序列化 `message`；不得依赖远端 Error 原型或 stack。

## 6. 工单拆分

### SWCF-001：锁定旧行为和删除清单

修改范围：

- `src/runtime/runtime.test.ts`
- `src/transport/serviceBridge.test.ts`
- `src/transport/messagePortService*.test.ts`
- `docs/proposals/browser-runtime-v1/*`

工作：

- 固化多页面共享一个 Worker/Unit、单端口隔离、撤销、取消、旧代理失效和不重放；
- 为当前 hello、Provider handshake、重复 snapshot、baseline/resync 和自动重连建立
  仅用于证明删除前现状的测试/计数；
- 把旧需求文档相应条目标为被本文覆盖，不能继续存在两份相反真值。

验收：测试明确区分“必须保留的安全行为”和“将删除的连接仪式”。

### SWCF-002：定义 v2 协议和调用错误

修改范围：

- `src/runtime/runtimeProtocol.ts`
- `src/runtime/runtimeTypes.ts`
- `src/contracts/lifecycle.ts`
- `src/index.ts`

工作：

- 升级 Runtime/RemoteService wire 版本；
- 删除 hello/resync/handshake/baseline 类型和导出；
- 引入 `serviceInstanceId` 和精简消息结构；
- 删除 `RemoteServiceHandshake`、`RemoteServicePortControlMessage` 中的握手/目录分支；
- Bridge 状态收敛为 `empty | ready | stale | disposed`，不得保留 handshaking；
- 定义稳定错误基类/错误码和序列化规则；
- 更新中文字段注释和生成声明。

验收：公开 `.d.ts` 不再包含已删除符号，`UpgradeHandshake` 等领域安全类型仍存在。

### SWCF-003：把 ServiceBridge 改为惰性单次绑定

修改范围：

- `src/transport/serviceBridge.ts`
- `src/transport/serviceBridge.test.ts`

工作：

- 用 `applySnapshot(snapshot)` 同时建立 Runtime authority 和完整服务目录；
- 删除 `handshake()`、baseline 和连续 revision 状态机；
- 实现未绑定代理、原子首次绑定和永久实例绑定；
- 快照删除/替换服务时同步 revoke 已绑定旧代理；
- Runtime instance 改变时同步 revoke 全部旧代理；
- 同一 Runtime 的旧/重复 revision 只忽略，不清空当前新目录；
- `disconnect()`/`dispose()` 拒绝所有等待绑定和 pending call；
- 不创建隐式重试或请求重放。

必测：调用早于首快照、并发首次调用、契约不匹配、服务永远不存在、乱序快照、
Provider 更换、Runtime 重启、dispose 与首次绑定竞争。

### SWCF-004：精简 MessagePort Transport/Provider

修改范围：

- `src/transport/messagePortServiceTransport.ts`
- `src/transport/messagePortServiceProvider.ts`
- 对应测试和 legacy codec 测试

工作：

- codec 只保留 `call/result/error/cancel`；
- Provider 创建后不主动发送 handshake 或 snapshot；
- Runtime Host 成为 RuntimeSnapshot 的唯一发布者；
- 端口本身作为连接隔离边界，wire 删除 `connectionId`；
- Provider 根据本地端点目录验证 capability、contract、service instance 和 grant；
- Transport 为每次调用安装 deadline 和 AbortSignal；
- timeout/abort/dispose 必须删除 pending 项并尽力发送 cancel；
- Result/Error 必须匹配 callId 和 serviceInstanceId；迟到响应直接丢弃；
- Provider revoke 先同步停止新调用并 abort pending，再发布新完整 RuntimeSnapshot。

deadline 从调用开始计时，包含等待首快照和远端执行的总时间；默认值必须有限且大于零。

### SWCF-005：简化 SharedWorker Host

修改范围：

- `src/runtime/sharedWorkerHost.ts`
- `src/runtime/runtime.test.ts`

工作：

- `onconnect` 收到端口即创建 Endpoint 和 Provider；
- connection identity 只保存在 Endpoint 内部，不由 Window 生成、回显或用于授权；
- 删除 hello 门禁、重复 connectionId 检查、resync handler 和握手 phase；
- 每次连接只发送一份完整 RuntimeSnapshot；
- Runtime/Unit/Service 状态变化只发布下一份完整快照；
- fail/stopping/disposed 尽力发布末态后关闭端口；
- 对每条端口分别维护 callId、cancel 和 pending 集合；
- 一个端口释放不得停止共享 RuntimeUnit。

验收：新连接零客户端控制消息即可收到首快照；ready 时每次端点初始发布只有一份目录。

### SWCF-006：简化 Window RuntimeHandle

修改范围：

- `src/runtime/connectSharedWorker.ts`
- `src/runtime/runtimeTypes.ts`
- `src/runtime/windowRuntime.ts`
- `src/runtime/runtime.test.ts`

工作：

- `connectSharedWorker()` 改为同步返回 handle；
- 先安装监听器、Transport 和本地状态，再 `port.start()`；
- 删除 readiness generation、handshake timer、hello、resync 和 reconnect 状态机；
- `capability()` 改为惰性代理；
- Worker error/messageerror 立即标记 disconnected、撤销代理并拒绝 pending calls；
- 断线后不自行创建新 Worker；
- 显式 dispose 幂等，且不会被任何 timer 复活；
- Window Host 的 remote dependency 继续依据快照投影 blocked/ready，但不得调用
  `RuntimeHandle.ready()`。

测试必须证明 connect 返回不依赖任何 Worker 回包，错误只在构造或 call 边界出现。

### SWCF-007：迁移 DemoWebLoom

修改范围：

- `/home/david/Workspaces/DemoWebLoom/examples/07-remote/*`
- Demo 浏览器 smoke 和说明文档

工作：

- 删除 `await connectSharedWorker()` 的就绪含义；
- 删除 `autoReconnect`、`reconnectDelayMs`、`handshakeTimeoutMs`；
- UI 文案从 handshake/baseline 改成 snapshot/call；
- 不再展示公开 connectionId；改为展示 runtimeInstanceId、serviceInstanceId、revision；
- “重连”按钮显式 dispose 旧 handle，再创建新 handle 和新代理；
- 协议不匹配场景通过 `proxy.call()` 得到错误，不再期待连接 Promise 拒绝。

浏览器验收继续证明：真实 SharedWorker realm、两个页面共享 Runtime/Unit、setup=1、
两个页面调用相互隔离、显式重建产生新代理、不可解析对端最终 call timeout。

### SWCF-008：迁移 Keymaster RemoteService

修改范围：

- `/home/david/Workspaces/keymaster.cc/apps/web/src/keymasterSessionCoordinatorClient.ts`
- `/home/david/Workspaces/keymaster.cc/apps/web/src/keymasterSessionCoordinator.worker.ts`
- `/home/david/Workspaces/keymaster.cc/packages/contracts/src/keymasterLifecycle.ts`
- Keymaster RemoteService/Coordinator 定向测试

工作：

- 删除 Keymaster 对 `RemoteServiceHandshake` 和 `baseline` 的消费；
- Coordinator Provider 改为无握手创建，服务变化发布完整目录；
- 页面侧 ServiceBridge 从首份完整目录直接建立 authority；
- 删除 RemoteService wire 的 connectionId，端点仍在 Worker 内用不可见 identity 管理；
- `providerInstanceId` 迁移为 `serviceInstanceId`；
- 客户端 reconnect/backoff 仍由 Keymaster 单一领域连接管理器负责，但每次重连必须
  创建全新的 WebLoom handle 和代理；不得迁回 WebLoom 核心；
- owner/session/bucket/grant/authorization/final-I/O 校验在调用前后保持原顺序；
- A → B → A、lock/unlock 和 Worker 重启后旧代理永久失败。

禁止把 Keymaster 领域 `connectionId`（例如 Sat inbound lane）与已删除的 WebLoom
RemoteService connectionId 混为一谈。

### SWCF-009：收口 Keymaster 端口扩展钩子

目标：最终删除 WebLoom 公共 `onConnection` / `onPortConnect`，使 RuntimeHandle 不泄漏
SharedWorker/MessagePort。

工作分两步：

1. 先完成 SWCF-001 至 SWCF-008；这一步允许钩子作为同版本内的临时迁移接缝。
2. 将 Keymaster 主 Coordinator 请求、事件和需要转移 MessagePort 的操作迁入明确的
   typed capability/transfer API；完成真实浏览器压力和安全回归后，删除两个钩子。

transfer API 必须显式列出 request/result transferables，普通 capability 默认仍只允许
结构化克隆；不得暴露裸 Runtime MessagePort。若本阶段无法证明所有 Keymaster 领域
通道已迁移，停止删除钩子，不得用 `any` 或全局消息监听绕过。

### SWCF-010：文档、包与三仓原子切换

修改范围：

- WebLoom README、`docs/api.md`、migration 文档、consumer smoke；
- Demo README/课程；
- Keymaster 依赖、锁文件、release-boundary；
- 三仓残留符号检查。

工作：

- 文档主路径只展示 call-first API；
- 标明 `0.3.0` 是破坏性升级，不提供 v1 wire 双栈；
- 先以 WebLoom tarball 在 Demo/Keymaster 完成消费者验证；
- WebLoom 正式发布后，下游只安装 registry 精确版本并重跑门禁；
- 禁止同时接受 v1/v2 消息，避免协议降级和双真值；
- npm 发布仍由用户手工执行，施工者不索取 OTP、不代替用户发布。

残留搜索至少覆盖：

```text
RUNTIME_HELLO_TYPE
RUNTIME_RESYNC_TYPE
RemoteServiceHandshake
handshakeTimeoutMs
autoReconnect
reconnectDelayMs
baseline
bridge.handshake
codec.type("handshake")
connectionId（只审查 WebLoom transport 含义，不能盲删领域字段）
```

## 7. 测试矩阵

| 场景 | 单元/模拟 | 真实浏览器 | Keymaster 集成 |
|---|---:|---:|---:|
| connect 不等待 Worker 回包 | 必须 | 必须 | 必须 |
| call 等待首份快照且受 deadline 限制 | 必须 | 必须 | 必须 |
| 协议可解析但版本不兼容 | 必须 | 必须 | 必须 |
| 对端静默/完全不可解析 | 必须 | 必须 | 必须 |
| 两页面共享一个 Worker/Unit | 模拟辅助 | 必须 | 必须 |
| 两端口 callId/cancel 隔离 | 必须 | 必须 | 必须 |
| Provider 更换后旧代理失败 | 必须 | 必须 | 必须 |
| Worker 重启后旧代理失败 | 必须 | 必须 | 必须 |
| 显式重连不重放旧调用 | 必须 | 必须 | 必须 |
| dispose 与迟到 result 竞争 | 必须 | 必须 | 定向 |
| lock/unlock、A → B → A | 不适用 | 不适用 | 必须 |
| grant/owner generation/final-I/O fence | 不适用 | 不适用 | 必须 |
| Local localStorage 页面桥 | 不适用 | 不适用 | 必须 |

每项测试还必须断言负面事实：没有 hello、没有 handshake 控制包、没有重复目录、
没有 resync、没有自动创建第二个 Worker、没有自动重放 call。

## 8. 执行顺序与门禁

```text
SWCF-001 行为基线
→ SWCF-002 v2 类型
→ SWCF-003 Bridge
→ SWCF-004 Transport/Provider
→ SWCF-005 Worker Host
→ SWCF-006 Window Handle
→ SWCF-007 Demo
→ SWCF-008 Keymaster RemoteService
→ SWCF-009 端口扩展收口
→ SWCF-010 文档/打包/发布准备
```

每个阶段先跑 targeted tests 和 typecheck。跨仓切换前至少执行：

### WebLoom

```bash
pnpm typecheck
pnpm test
pnpm lint:boundaries
pnpm build
pnpm run pack:consumer
pnpm run test:browser
git diff --check
```

### DemoWebLoom

```bash
pnpm typecheck
pnpm build
pnpm run test:browser
git diff --check
```

### Keymaster

- typecheck；
- boundaries/final-I/O/release-boundary 门禁；
- Coordinator Client/Worker、Runtime adapter、bootstrap、owner storage、crypto 定向测试；
- 完整 Vitest 分批执行；
- production build 并确认发出真实 SharedWorker chunk；
- 真实浏览器多 Tab、断线、显式重连、lock/unlock、A → B → A、Local 桶回归；
- `git diff --check`。

测试结果必须分成三层报告：代码完成、本地/自动化验收、真实浏览器或公网生产验收。
本地 build、MessageChannel 和 Playwright fixture 不能代替公网发布验收。

## 9. 停止条件

出现任一情况立即停止当前批次，不继续删除旧路径：

- `capability()` 仍因未 ready 同步抛错；
- call 可能无限 pending；
- 代理在 service/runtime instance 改变后自动换绑；
- reconnect 自动重放任何请求；
- 两个页面产生两个 Worker RuntimeUnit 实例；
- 旧/迟到响应可以完成新调用；
- Provider 依赖客户端回传的完整 reference 决定授权；
- Keymaster lock 后旧调用仍能进入 handler 或最终 I/O；
- owner/session/bucket/grant/handover/final-I/O fence 被弱化；
- Local 桶离开页面 localStorage 桥；
- 为通过测试同时保留 v1/v2 两套协议真值；
- 真实浏览器不支持时退回 Node 模拟并报告通过。

## 10. 完成定义

只有同时满足以下条件，施工单才可标记完成：

1. WebLoom v2 call-first 代码、类型、文档和 tarball 一致；
2. 精确搜索无预期外旧 handshake/baseline/resync/reconnect API；
3. WebLoom 全部门禁和真实 Chromium fixture 通过；
4. Demo 使用新 API，真实浏览器课程通过；
5. Keymaster 使用新 API，安全门禁、构建和真实浏览器关键路径通过；
6. 旧代理、超时、取消、断线、Worker 重启和 Provider 重建均有负面断言；
7. `UpgradeGate` 及 Keymaster 最终 I/O 安全边界未被删除或降级；
8. 发布状态如实记录；未发布 npm 或未做公网验证时必须明确标为未完成项。

## 11. 交付物

- WebLoom v2 Runtime/RemoteService wire；
- 无 handshake 的 `connectSharedWorker()` 与惰性 capability proxy；
- 单一完整 RuntimeSnapshot 发布链；
- 有 deadline/AbortSignal 的 MessagePort call；
- 显式重连、永不自动重放的调用模型；
- DemoWebLoom call-first 课程与浏览器证据；
- Keymaster 同版本迁移和安全回归证据；
- v1 → v2 破坏性迁移说明；
- 三仓独立验收记录和剩余公网发布边界。
