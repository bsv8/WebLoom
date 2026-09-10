# WebLoom v4 三仓施工单

- 状态：全部待实施；勾选框仅在对应证据齐全后勾选。
- 规范：[需求与设计](./requirements.md)，V4-R01–V4-R16。
- 交付版本：`webloom-framework@0.4.0`，唯一 wire `webloom.runtime.v1`。
- 本轮只编写文档；以下程序任务与命令均为后续实施要求，不能作为已执行记录。

## 1. 执行规则与依赖顺序

一次破坏性升级，允许分阶段提交开发进度，不允许发布中间兼容层。不得引入 v2 adapter、deprecated alias、旧签名 overload、双 codec、旧消息 fallback，或用 `any`/无校验 unknown 逃过契约迁移。

保留用户现有工作树；先记录三仓 diff，再在原有修改上增量施工。任务拆分是职责边界，不授权覆盖其他任务/用户修改。实施期间发现基线漂移，以当前源码补充清单，不复原旧快照。

主依赖链：

```text
001 基线
 └─002 契约 →003 插件/Host →004 调用可靠性 →005 双向 peer
                                             ├─006 transfer →007 stream
                                             └─008 Scope →009 诊断 →010 React
002–010 →011 入口/包 →012 Keymaster 契约 →013 Keymaster Host
                                      →014 Coordinator →015 Local/transfer
                                      →016 全部产品消费
011 →017 Demo
004–017 →018 三仓验收/消融 →019 发布闭环
```

其中 012 的业务清单可在 001 后提前整理，但不能在 005–007 公共契约未确定时做旧消息包装实现。每个任务完成后跑针对性验证；最后执行三仓门禁。不可通过降低旧测试覆盖率或放宽安全断言解决失败。

## 2. 实施前已识别的实际迁移点

### WebLoom

| 模块 | 当前路径 | v4 责任 |
| --- | --- | --- |
| 作者入口 | src/authoring/definePlugin.ts | 契约对象、唯一启动策略 |
| 公共契约 | src/contracts/plugin.ts、lifecycle.ts | 去字符串能力/兼容 overload，收口 typed API |
| Runtime | src/runtime/{runtimeTypes,runtimeProtocol,pluginDefinitions,windowRuntime,connectSharedWorker,sharedWorkerHost}.ts | App/Peer、对等快照、无裸端口 |
| RPC | src/transport/{serviceBridge,messagePortServiceTransport,messagePortServiceProvider}.ts | typed dispatch、单次 settle、流/transfer |
| Host/Scope | src/host/createPluginHost.ts、capabilityRegistry.ts、pluginGraph.ts；src/lifecycle/resourceScope.ts | 声明检查、owner/exposure 生命周期、helper |
| React | src/react/PluginHostProvider.tsx、useCapability.ts、usePluginRuntime.ts 及 resource hooks | App Provider、契约订阅、selector |
| 打包/测试 | src/index.ts、react.ts、testing.ts；package.json、tsup.config.ts、scripts/* | 四入口、消费/删除门禁、浏览器 fixture |

### Keymaster

以下为工作树调查定位，不是只改这些文件即可完成迁移的白名单：

| 模块 | 当前路径/调用点 | v4 责任 |
| --- | --- | --- |
| 领域契约 | packages/contracts/src/{sessionCoordinator,webloom,plugin,pluginProducts,keymasterLifecycle}.ts | shared typed 契约、parser、领域元数据映射 |
| Coordinator client | apps/web/src/keymasterSessionCoordinatorClient.ts | 删除 onConnection、sendRequest pending/raw listener、openServiceBridge/sendHello 端口传递 |
| Coordinator Worker | apps/web/src/keymasterSessionCoordinator.worker.ts | 删除 onPortConnect/raw 主分派/手工目录；注册 typed handlers、streams、peer exposure |
| Local storage bridge | 上述 client/worker 的 openLocalStorageBridge、LocalStorageBridgeWire 及 lease/I/O 处理 | 同连接 Worker→指定 Window 的 typed RPC |
| 启动 | apps/web/src/bootstrapPlugins.ts | 页面 bridge 先装配、再连接、再四阶段注册 |
| Host adapter | packages/runtime/src/{keymasterHostAdapter,pluginHostContract}.ts；react/* | v4 advanced 装配，移除 keymasterRemoteServiceMessageCodec |
| 存储权威 | packages/platform-storage/src/coordinator/{storageBindingAuthority,authority}.ts 及相关测试 | 验证新 facade 下 lease/CAS 不变 |
| 业务独立端口 | packages/plugin-window-p2p/src/{windowExecutor,executorTransport}.ts；Worker executor 路径 | typed transfer 入口；清楚界定保留的独立领域数据协议 |
| 业务消费 | packages/plugin-*/src、packages/platform-storage/src/ui、apps/web/src/lifecycleE2E/windowHooks.ts | 契约对象、typed hooks、测试 fixture |
| 发布 | 各 package.json、pnpm-lock.yaml、pnpm-workspace.yaml；scripts/check-webloom-release-boundary.mjs、check-webloom-registry-consumer.mjs | 0.4.0 精确依赖和 integrity |
| 验收 | e2e/plugin-lifecycle-{production,recovery,irreversible-io}.spec.ts、msfile-executor-spike.spec.ts | 真实浏览器与最终 I/O 证据 |

Keymaster 当前 owner/crypto 目录会发布 `status: unavailable`。迁移时改为不暴露该服务，不能在紧凑解析器中无条件把这些旧记录变成 ready。

### DemoWebLoom

`examples/01-hello`、`02-capability`、`03-lifecycle`、`04-messagebus`、`05-resource`、`06-permissions`、`07-remote`、`08-upgrade`、`09-host-extensions` 的 runtime/App/main 与 shared contract 文件均须核查。07 包含 `remote.worker.ts`、`remote.shared.ts`；09 目前从主入口获取底层装配工具。

同步更新 `src/App.tsx`、README.md、package.json、pnpm-lock.yaml、pnpm-workspace.yaml、scripts/real-browser-smoke.mjs。当前两个下游均声明 WebLoom 0.3.0，不能依据更早的 file/link 记忆改写现状。

## 3. 任务清单

### V4-001 · 固定工作基线与可复现回归

- [ ] 记录三仓 HEAD、git status、已有 diff，列出用户改动，不混入本轮基线“修复”。
- [ ] 完整搜索 WebLoom import/re-export、字符串 capability、旧 Runtime hooks、raw 主 RPC、transfer 及订阅调用点，形成带文件/符号的 migration inventory。
- [ ] 运行三仓可用的现有 typecheck/test/build，保存失败原因与日志；已存在失败标记 baseline，不伪称本轮引入。
- [ ] 为 review 四问题建立“修复前确实失败”的生产路径回归，保留确定性时序；不要靠 20ms MessageChannel 竞争证明错误响应匹配。

证据：baseline 三仓清单、旧 API inventory、四条缺陷复现。报告放 `docs/proposals/webloom-v4/verification.md`（实施时新建，不能预填通过）。

### V4-002 · Typed capability 与类型/运行时校验

覆盖 V4-R02、R03；负责 contracts/authoring 及测试。

- [ ] 实现 defineCapability 的 local/rpc/stream 判别联合；id/version 必填，parser、transfer 函数与静态 DTO 分离。
- [ ] 实现契约类型推导、RpcClient/StreamClient、ValueParser；禁止消费端覆盖请求/结果泛型。
- [ ] 定义静态 identity 比较、重复/歧义检查；各 realm 可分别导入相同契约模块，不依赖引用相等。
- [ ] 删除 `.v1` 默认版本推导及 providedContracts helper；更新测试中的显式契约。
- [ ] 在 sender/receiver 的 request、response、item 边界使用 parser。错误统一脱敏。

验收：不同请求字段、错误返回值、将 local 传给 remote、错 parser 类型、旧字符串获取均有 `@ts-expect-error` 或等价类型测试；删除期望错误注释后编译确实失败。运行时畸形载荷不得进入 handler，伪造 descriptor 不能绕过 kind/版本检查。

### V4-003 · 插件声明、Host 与 canonical 注册

覆盖 V4-R03、R07；负责 definePlugin/pluginDefinitions/Host/registry/graph。

- [ ] provides/dependencies 使用契约对象；ctx.provide 只接 local，ctx.handle 接 RPC/stream，ctx.capability/optionalCapability 推导类型。
- [ ] 检查注册与消费声明；Host-owned 领域引导能力通过 advanced 显式 owner 入口注册。
- [ ] 删除 required/meta/providedContracts 及旧顶层 manifest 与 units 的双真值；领域 contribution/extension 的泛型保持可用。
- [ ] runtime 只在装配处补齐一次；多 unit 明确 implementation unit，静态描述不得带 setup/parser/transfer 函数。
- [ ] 删除反射 method/object.handle RPC 分派，仅保留显式 handler。需要 this 的对象通过闭包调用迁移。

验收：required 矛盾配置在任何 setup 前失败；未声明提供/消费被拒绝；单/多 runtime 单元选择正确；对象实例方法通过新 handler 返回正确结果；不存在 string overload 或泛型断言逃逸。

### V4-004 · 统一调用终止与修复可靠性缺陷

覆盖 V4-R08；负责 serviceBridge/transport/provider。

- [ ] 建立唯一 settle/revoke 路径，cancel、timeout、替换、dispose 同步删除 pending 并移除监听/timer。
- [ ] handler 永不 settle 时仍回收框架 Map；业务闭包可能继续存活的边界在文档说明。
- [ ] 保留记录对象身份与授权/实例 fence，迟到 finally 不能删除其他调用，迟到结果不能恢复旧代理。
- [ ] failed/stopping/disposed 统一撤销，矛盾快照整份拒绝。
- [ ] Bridge 目录等待与执行共享总 deadline；独立 transport 保持有限超时。删除重复实现而非删除语义。
- [ ] result clone/validation 失败返回结构化错误，不能 best-effort 吞掉正常响应错误。
- [ ] 清理空 message listener、无作用 decode、startupError 存储及重复 proxy alias。

验收：四条 review 回归全部转绿；100 次“不配合 handler + cancel”之后本端 pending/timer/listener 计数归零；错 serviceInstanceId/旧 callId 响应不能 settle；无自动重发。内存断言针对框架拥有的记录，不宣称 JS 可以终止任意 Promise。

### V4-005 · 双向 peer、暴露与紧凑快照

覆盖 V4-R04、R13；负责 Runtime、Host exposure 与 wire schema。

- [ ] 实现 connectSharedWorker 的 client.app/expose，startSharedWorkerApp 的 expose/configurePeer。
- [ ] 实现 PeerHandle、peer.scope、capability/expose/inspect 与 exposure revoke；Runtime 主 port 始终私有。
- [ ] Window/Worker 同一端口均可发起调用，方向独立关联；反向能力只绑定当前 peer。
- [ ] exposure 同时绑定 plugin/peer/领域 scope；授权异步返回后再检查，授权变化 revoke+新 serviceInstanceId。
- [ ] 实现 per-peer revision 的紧凑完整快照：仅 ready services，省略重复 runtime/runtimeInstanceId/status；Window→Worker 快照同规则。
- [ ] 两侧 pin 对端 runtimeKind/逻辑身份，不能用来自不匹配 runtime 的快照污染目录。Runtime 换代按需求撤销，不把身份字段当认证凭据。
- [ ] 公共基础快照单次构建，私有授权投影逐 peer 构建。同步更新/撤销 Provider 在发布前完成。
- [ ] 实现 advanced createWindowAppFromHost/registerPlugins/attachRemote；一个 Host/一个 WindowApp，不复制 Keymaster 既有 Host。
- [ ] 生产 options 删除 onConnection/onPortConnect、workerFactory/globalScope 测试注入；testing 独立暴露注入入口。

验收：两个 Window 共用一个 Worker 单元，服务 exposure 可各自不同；A 页面调用不能借参数选择 B 的 peer；A detach 后 B 正常；反向首个 I/O 不依赖远端插件阶段；异步 authorize 中撤销后 handler 不执行；旧授权代理永久失效；不发送双份目录或 v2 控制消息。

### V4-006 · 双向 transfer 与结果错误

覆盖 V4-R05；负责契约 adapters/transport/provider/真实 fixture。

- [ ] 按 request/response/item descriptor 提取去重 transferable，验证可达性与允许类型。
- [ ] sender parser → transfer extractor → post，receiver parser → handler/consumer 的顺序固定。
- [ ] 删除 call 级 transfer 数组、Runtime 裸端口 escape hatch；业务自有 port 必须有明确契约及关闭责任。
- [ ] 实现迟到 transferable 资源清理，特别是不再交付的 MessagePort；不自动重传 detached 数据。
- [ ] 发送正常响应失败时发可克隆结构化错误；故障细节脱敏。

验收：真实 Chromium 验证 request/result buffer detach、多个视图同属一个 buffer、重复 transfer 去重、不可达 port 拒绝、发送前取消不 detach、发送后取消不恢复、Worker 退出/服务替换后迟到资源不交付。不能只用 structuredClone 单元测试替代 browser postMessage。

### V4-007 · Typed stream、背压和终止

覆盖 V4-R06；依赖 005/006。

- [ ] ctx.handle stream 返回 AsyncIterable；客户端 subscribe 返回 ready/closed/cancel。
- [ ] 实现 call/streamReady/next/credit/done/error/cancel 唯一 schema，不能另造产品级事件 transport。
- [ ] 默认 credit 16、最大 256；next sequence 连续；consumer 回调完成再补 credit；producer 无 credit 不拉 iterator。
- [ ] 提供有界 push→AsyncIterable 适配 helper（advanced/testing 可用），overflow 终止，不静默丢失。
- [ ] ready 仅受建立 deadline；活跃流受 scope/signal/cancel；拒绝与消费者未观察 Promise 的清理行为明确。
- [ ] 取消立即移除 framework pending；iterator.return 不配合不能阻止本端回收。

验收：慢消费者不产生无界队列；第 257 个非法 credit 被拒绝；无 credit 不继续生产；错误/重复 sequence 终止；一个回调失败不影响其他 stream；取消后新 item 不调用旧消费者；两页面不共享可转移载荷所有权；服务重建需显式新订阅。

### V4-008 · Scope helper

覆盖 V4-R09；负责 resourceScope 与测试。

- [ ] listen、interval、subscribe helper 使用已有 Scope，返回幂等 release。
- [ ] revoke 时同步解绑；onDispose 只补偿残留并等待合法异步 cleanup。
- [ ] 注册期间同步重入/revoke 安全；已停止 scope 拒绝新资源。
- [ ] interval 仅同步 callback；异步任务导向 scheduler；修正 track 返回值注释。

验收：注册/取消/重复取消/Scope dispose/同步 subscribe 回调触发 revoke/晚到 acquire 全覆盖；事件监听数与 interval 计数归零；不能为新 helper 再新增第二个资源账本。

### V4-009 · 结构化诊断与错误

覆盖 V4-R10；负责 Runtime/Host/Scope 诊断接口。

- [ ] 实现 inspect/explain，稳定原因码、确定性顺序、依赖环截断、unknown 身份处理。
- [ ] 暴露 framework-owned pendingCallCount/activeStreamCount/peerCount，不暴露业务载荷或 grant token。
- [ ] 从已有状态派生，删除“复制所有状态再维护一份”的实现路线。
- [ ] 统一错误 code/phase/context；超时不能被描述为服务端确定未执行。

验收：缺 provider、契约不匹配、scope 撤销、Worker 断开、required 初始化失败均有准确原因链；注入密码/密钥/headers 请求后诊断与错误快照不含该载荷；诊断读取不改变 revision/调用次数。

### V4-010 · React 精确订阅

覆盖 V4-R11；负责 React 入口与测试。

- [ ] WebLoomProvider 接受 App 稳定引用；删除旧 Provider 的额外全局 version state。
- [ ] typed useCapability/useOptionalCapability/usePluginState/useRuntimeSelector，移除 useHost 兼容别名。
- [ ] 使用外部 store 一致性机制（建议 useSyncExternalStore），相关 snapshot 稳定，无关变化不使所有消费者重渲染。
- [ ] RPC/stream hook 不在每次 render 创建代理；旧 exposure 失效后只能返回新代理对象，不能改变旧对象绑定。
- [ ] 保持现有 Resource hook 领域无关性，不把 Keymaster context 注入框架。

验收：render 次数断言证明无关 capability 更新不触发消费组件；render/subscribe 间状态变化可见；切换 App 立即读取新状态；卸载/StrictMode 订阅清理；异步 Worker 尚未 ready 时构造远程 proxy 不抛同步错误。

### V4-011 · 包入口和 API 删除门禁

覆盖 V4-R01、R12；负责 src/index.ts、新 src/advanced.ts、react/testing、打包配置与 API docs。

- [ ] 将 exports 改为主入口、advanced、react、testing 白名单；package version 0.4.0。
- [ ] 主入口无 React import、无底层 codec/provider/registry wildcard；advanced 是 v4 同实现扩展，不是兼容层。
- [ ] 新增 `test:types`，分别编译四入口正例与旧 API 负例；core-only 消费项目无需安装 React。
- [ ] 新增 `lint:v4`（scripts/check-v4-boundary.mjs）：检查已删除 export/旧 wire parser/兼容分支/生产测试注入/原始 Runtime 端口访问。
- [ ] 更新 pack-consumer-smoke、白名单和 sourcemap 路径检查，文档包仍可随包发布。
- [ ] 更新 README/docs/api.md 与历史 proposal 的 superseded 指引；活跃文档只教授 v4。

验收：从 tarball 的 d.ts 读取四入口，旧入口符号无法导入；不以源码路径 alias 消费；禁止使用 `unknown as OldInterface`、字符串重载、legacy host facade 通过门禁。

### V4-012 · Keymaster 契约逐项映射

覆盖 V4-R14；负责 packages/contracts 及新增专用契约模块。

- [ ] 将 001 inventory 中每个 Coordinator request kind、response、event、reverse I/O、transfer 列成迁移表：旧符号 → 新 contract → parser → handler → caller → 测试。
- [ ] 按领域组织 contracts（session、storage、crypto、events、executor）；无需“一方法一个文件”，但每个请求/结果必须保持类型对应关系。
- [ ] 使用现有生产 parser/领域检查；若领域类型没有 parser，在领域层补齐，不把 owner/CAS 等规则移入 WebLoom。
- [ ] 从业务 metadata 提取 bootstrapStage/scopeKind，迁到 contribution/领域 catalog。保留明确的四阶段排序来源。
- [ ] 标明真实保留的独立 P2P/Connect/媒体协议，不以全局 grep 删除它们的合法 connectionId/requestId/handshake。

验收：全部清单行有 v4 去向，无未分类主消息；禁止一个 `CoordinatorRequest → unknown` 契约包裹旧 raw router 作为最终实现；依赖 parser 的 request/response 类型负例编译失败。

### V4-013 · Keymaster Host/React 装配迁移

覆盖 V4-R07、R11、R12、R14；负责 packages/runtime、bootstrapPlugins。

- [ ] keymasterHostAdapter 使用 advanced v4 Host，更新注册、贡献、scope、权限类型与 hooks；删除 keymasterRemoteServiceMessageCodec 和旧 WebLoom facade 转译。
- [ ] createWindowAppFromHost 接管现有 v4 Host，一份 Root/Window scope；禁止多造 Host 绕过阶段门禁。
- [ ] 第一阶段注册页面 shell/LocalStorageIo handler → 连接 Worker → typed session.open/lease → 按 bootstrapStage 注册后续插件。
- [ ] 确认 page bridge handler 能在 storage 未选定时给出准确初始化/恢复响应，不把“未选桶”误当成 bridge transport 无效。
- [ ] 更新领域 React 包装层，只保留业务上下文包装，不重新实现一套 v2 全局 version 订阅。

验收：四阶段行为与旧产品语义一致；required 失败显式可见；scope 与 Host 实例数符合预期；冷启动页面 bridge 先于 Worker 首次 Local I/O；旧应用状态无法经换连接污染新 App。

### V4-014 · Coordinator 主调用、事件、授权 exposure 硬切换

覆盖 V4-R03–R06、R08、R14；负责 client/worker 及关联测试。

- [ ] 所有主请求改 typed capability，保留产品 facade 名称时内部直接消费 v4；删除 sendRequest pending/raw 主 listener。
- [ ] session.open/close、activity、refresh bootstrap 是 typed RPC，不再创建/传递 servicePort 或 LocalStorageBridge port。
- [ ] 旧 subscribeTopic/broadcast 实现改 typed stream；产品 facade 可转接 typed stream，但不得保留旧 event wire。
- [ ] 建立监听与初始状态读取原子顺序；重订阅从产品新快照恢复，不静默补造遗漏事件。
- [ ] owner/crypto 等敏感 capability 按 peer 授权后 expose，lock/owner/bucket/grant 变化同步 revoke，必要时建立全新 exposure。
- [ ] 移除手写 RuntimeSnapshot/ready-unavailable 服务目录，与 v4 single publisher 合并。
- [ ] 保留产品显式重连策略；新 RuntimeHandle、新 session、新 exposure、新订阅；不重放已发送副作用调用。

验收：两 Tab 不串会话/授权/响应；修改客户端 DTO 中 peer/owner 不改变框架绑定；异步授权期间 lock 阻止后续调用；旧代理/流永久失败；重连恢复只发生在产品明确路径。

### V4-015 · Local storage 反向调用及 transferable

覆盖 V4-R04、R05、R14；负责 client/worker Local bridge、platform-storage、window-p2p 适配。

- [ ] LocalStorageIo handler 留在 Window，使用生产 storage/recovery parser 与现有 Web Locks/CAS/lease 顺序。
- [ ] Worker 通过对应 peer 的 LocalStorageIo 调用，领域 lease 绑定原页面，禁止 fallback 到其他 Tab。
- [ ] 删除 LocalStorageBridgeWireRequest/Response 的传输分派/pending/cancel 实现；保留其领域 DTO 中仍必要的 I/O/CAS 参数并纳入契约。
- [ ] storageData、crypto 返回值、executor buffer/port 转移逐项改 descriptor，不再 call-site 手工拼 transfer 数组。
- [ ] 对独立 executor data port 明确 typed 转移、接收/丢弃关闭、旧 lease 下禁止 I/O；不把 Runtime 端口作为 payload。
- [ ] 初始化结果丢失使用既有 transaction 查询/恢复；不因 API hard switch 删除现有恢复数据格式或重建用户桶。

验收：首桶创建/导入/切换、LocalStorageIo 首次 lease、页面重载、lock/unlock、A→B→A、两个 Tab 页面离开、迟到 I/O、初始化恢复生产 parser、catalog 最后 CAS；真实 request/result/port transfer 的所有权测试。Local 后端必须仍是 localStorage。

### V4-016 · Keymaster 全部消费与门禁更新

覆盖 V4-R14；负责 packages/plugin-*、platform-storage UI、apps/web 消费与发布配置。

- [ ] 全库 capability 字符串调用、手填泛型、manifest、React hooks、test host/fake 更新；不能只改 Coordinator。
- [ ] packages/contracts 的 WebLoom re-export 与所有 packages/runtime wrapper 改成新入口语义，无旧签名代理；保留普通插件的 manifest-bound 只读 facade，增加无法获取内部 owner/storage 控制能力的负向测试。
- [ ] 更新 lifecycleE2E/windowHooks 与生产 e2e 断言，使测试经过 typed path/真实 parser，禁止测试专用旁路授权。
- [ ] 全部 dependency/devDependency/peerDependency、workspace release exception、lockfile、release checker 精确 0.4.0。
- [ ] 在部署恢复 runbook 说明新旧 Worker 冷切换、旧 lease 未释放时阻塞、结果未知的恢复路径。

验收：Keymaster 全库 typecheck/test/build/边界检查；旧 API inventory 零未迁移生产项；最终 I/O audit 仍开启且通过；storage/crypto/会话既有断言没有被削弱。

### V4-017 · Demo 01–09 与教学同步

覆盖 V4-R15；负责 Demo 全部示例、页面说明、浏览器脚本及依赖。

- [ ] 01–02 展示 defineCapability、typed provide/consume 与依赖，不让新用户先学 Host/registry。
- [ ] 03 展示 Scope helper 同步撤销；04–06 使用 v4 能力获取 MessageBus/Resource/权限。
- [ ] 07 展示 typed unary、stream、request/result transfer、Window reverse capability 与明确错误/取消；保留真实 SharedWorker chunk。
- [ ] 08 保留领域 UpgradeGate.handshake；09 明确 advanced 入口与唯一 v4 Host 装配。
- [ ] 所有代码摘录/注释/首页/README 与程序一致，删除 v1/v2/旧 `.v1` 默认推导教学。
- [ ] 更新依赖、lockfile/release exception 与真实 browser smoke，覆盖九章可用交互。

验收：typecheck/build；01–09 页面无异常且关键交互有效；07 两页共享 runtime/unit（不错误要求 exposure ID 相等）、取消/流/transfer/反向调用/重连旧对象失效；从正式 tarball 与 registry 各验一遍。

### V4-018 · 三仓验收、消融复验与硬删除

覆盖 V4-R01、R13、R16。

- [ ] 执行第 4 节 AT-01–20、AT-22 的发布前验收，记录 commit、产物 hash、浏览器版本、运行方式、结果与失败日志。AT-21 明确留给 019 发布后验收，不作为上传前循环依赖。
- [ ] 旧 API/wire 正反例检查；显式拒绝旧协议，不能依赖“旧客户端大概会超时”。无法解析的第三方垃圾消息仍按定义忽略/本次 deadline 收敛。
- [ ] 重跑必要消融，确保 deadline、cancel、实例匹配、原子目录、同步 revoke 的测试能检测移除机制。
- [ ] 全库 static inventory 收尾：只允许历史文档与拒绝旧协议的测试出现旧 token，例外精确到文件/用途，不设任意目录通配。
- [ ] 对 ready-only compact snapshots、公共基础快照构建与 React render 数量保存测量基准；不报告未经测量的速度倍数。
- [ ] 单元/模拟、浏览器、三仓 tarball、registry/生产分别标状态；有一层未完成不得写“全部完成”。

### V4-019 · 同一产物发布与消费闭环

覆盖 V4-R01、R16；依赖 018 的所有本地/浏览器/产品门禁。

- [ ] 冻结 018 已通过消费验证的唯一 0.4.0 tarball，记录 hash 与 pack 文件清单；若重建导致产物变化，必须重新执行对应消费验收，不能上传未经验证的重建包。
- [ ] 在隔离下游 checkout/消费目录安装这份 tarball，完成三仓联合验证；临时 file/link 不能提交到最终 lockfile。
- [ ] 上传前核查 registry 版本与账号，保存可审阅 release notes、三仓变更范围和验证记录；当前文档任务不执行上传。
- [ ] 未来实施发布时按届时已授权范围执行 npm 发布；若凭证/审批限制阻止，则报告“代码/本地验收完成，发布待完成”，不能改写为 registry 已通过。
- [ ] 发布后从 registry 下载 0.4.0，核对 integrity/产物与测试 tarball 一致；下游精确版本 frozen install 再做消费验证。
- [ ] Keymaster/Demo 最终发布源码不含本地依赖、旧版本、旧签名层；发布 checker 不能为绕过 registry 验证而放宽。
- [ ] Keymaster 部署采用版本隔离的 Worker URL/name 与现有 authority 接管约束；旧 Worker 活跃 lease 时 recovery-required，禁止强抢。外部部署验收另列证据。

故障处理：发布前可恢复整个开发批次，不能部分上线三仓；发布后修正用新的 v4 patch，不补回 v2 fallback。若产品必须回退，回退完整已验证应用产物并遵守 authority/数据兼容检查，不能让新旧框架共用同一控制端口。

## 4. 统一验收矩阵

| 用例 ID | 场景与明确通过条件 | 需求 | 层级 |
| --- | --- | --- | --- |
| AT-01 | 旧 string/getProxy/requireProxy/required/meta/providedContracts/onConnection 不可编译/导入；旧 wire 明确拒绝 | R01/R07/R12 | 类型 + 单元 |
| AT-02 | 请求/响应/item 错类型编译失败；伪造 wire 被生产 parser 拒绝；handler 次数为 0 | R02/R03 | 类型 + 单元 |
| AT-03 | 未声明 provide/消费、重复提供、契约错版拒绝，descriptor 不含函数 | R02/R03/R07 | 单元 |
| AT-04 | lazy call 先于目录；一个总 deadline；独立 transport 无响应也超时；不重放 | R08 | 单元 + 浏览器 |
| AT-05 | handler 永不结束时 cancel/revoke/timeout 后 pending=0；迟到 finally 不伤后续调用 | R08/R10 | 可控异步单元 |
| AT-06 | 错实例/错版本/旧响应不 settle；结果克隆失败得到结构化错误而非 timeout | R05/R08 | 单元 + 浏览器 |
| AT-07 | failed/stopping/disposed 不可调用；矛盾/重复/外来目录原子拒绝；旧 revision 不回退 | R08/R13 | 单元 |
| AT-08 | 两页面共用真实 Worker unit/setup=1；peer exposure 隔离，单页退出不伤另一页 | R04 | 真实浏览器 |
| AT-09 | Worker 反向调用指定 Window；首个 Local I/O 无初始化循环；伪造 peer 无效 | R04/R14 | 单元 + 真实浏览器 |
| AT-10 | authorize await 时 revoke；owner/grant 变更产生新 exposure，旧代理/流永不恢复 | R04/R08/R14 | 单元 + 产品浏览器 |
| AT-11 | buffer/port 请求与响应 transfer、重复/不可达项、取消前后、迟到资源关闭 | R05 | 类型 + 真实浏览器 |
| AT-12 | stream ready/next/done/cancel；有界 credit/queue；慢消费者/异常回调/错序终止隔离 | R06 | 单元 + 浏览器 |
| AT-13 | Scope helper 注册重入、幂等释放、已停止拒绝、晚到 acquire 回收 | R09 | 单元 |
| AT-14 | explain 原因准确且无环；inspect 无私密载荷；诊断不改变状态 | R10 | 单元 + 产品检查 |
| AT-15 | 无关更新 render 不增加；相关更新可见；App 切换、订阅竞争、卸载/StrictMode 正确 | R11 | React 测试 |
| AT-16 | 1/10/100 服务 × 1/2/10 peer：公共快照一次构建、投影无串 grant、wire 无重复字段 | R13 | 计数/样本测量 |
| AT-17 | 四阶段启动、storage-first、Local/S3 桶、lock/unlock、A→B→A、reload/两 Tab 保持原语义 | R14 | Keymaster 真实浏览器 |
| AT-18 | 首次初始化失败/响应丢失/恢复 ledger、catalog 最后 CAS、final-I/O/authority 冷接管不退化 | R14/R16 | 生产 parser + 产品恢复验收 |
| AT-19 | Demo 01–09 交互；07 typed stream/transfer/reverse/旧代理；08 正常 UpgradeGate | R15 | 生产构建浏览器 |
| AT-20 | 四入口 tarball 类型/runtime；core 无 React；三仓同一产物且无本地路径/旧版本 | R01/R12/R16 | 打包消费 |
| AT-21 | registry integrity 与已测包一致，下游 frozen install/发布门禁通过 | R01/R16 | registry 消费 |
| AT-22 | 关闭 cancel/deadline/实例过滤/目录校验/revoke 后对应测试必须失败；恢复后通过 | R08/R16 | 临时副本消融 |

R 编号均指需求文件中的 V4-Rxx。AT-17/18 的外部 S3、公开服务等条件缺失时标记未验收；不得用 mock 通过替代。已有 Keymaster release 门禁保持原力度。

## 5. 验证命令与证据记录

以下是后续实施的执行清单，不是本次文档任务执行记录。对新增脚本先实现再调用；发现当前仓库脚本变更时在 verification 中写实际命令。

### WebLoom

```sh
pnpm typecheck
pnpm test:types         # V4-011 新增
pnpm test
pnpm lint:boundaries
pnpm lint:v4            # V4-011 新增
pnpm build
pnpm pack:consumer
pnpm test:browser
```

扩展 `scripts/real-browser-runtime-smoke.mjs` 与 `scripts/browser-runtime-fixture/`，不要新建只证明同 realm MessageChannel 的替代“真实浏览器”脚本。运行使用构建后的 Worker JS。

### DemoWebLoom

```sh
pnpm typecheck
pnpm build
pnpm test:browser
```

新增 Demo 的 v4 消费边界检查并接入 build/test 流程；九章各至少一个有意义交互断言，不能只测 HTTP 200。

### Keymaster

```sh
pnpm typecheck
pnpm lint:boundaries
pnpm lint:react-boundaries
pnpm test
pnpm test:storage:smoke
pnpm build:production
pnpm test:e2e:lifecycle
pnpm verify:final-io-audit
```

发布/外部环境可用后保持现有产品门禁：

```sh
pnpm lint:webloom-release
pnpm verify:webloom-registry
pnpm verify:lifecycle-release
```

最后一组不能在未发布 v4 或缺少真实环境时伪造成功。部署、外部 AppView、不可逆 I/O 和 recovery 证据按现有脚本要求准备；若涉及真实副作用，以对应产品验收授权与环境为边界，不用假结果解锁发布。

每条 verification 记录包含：任务/AT ID、三仓 commit 与 dirty 状态、实际命令、环境/浏览器版本、产物 hash、退出码、结果摘要、日志/截图路径、未覆盖范围。时间/次数等比较必须注明样本，不把 107 这个旧测试数当成 v4 通过条件。

## 6. 禁止残留与允许保留

最终禁止：

- v2 wire 的生产解析/发送、legacy codec、默认 `.v1` 推导、旧 API alias/overload。
- onConnection/onPortConnect 与访问 Runtime 裸端口的替代名字。
- Keymaster 主 raw request/event、附加 servicePort、LocalStorageBridgeWire 传输/pending；双目录发布者。
- string→typed 的通用兼容 wrapper、双 Host、双重自动重连器、为适配旧界面而伪造新服务实例。
- call/handler 使用 any/unknown 绕过 request/result 关联；测试直接注入“已经授权”状态跳过 parser/lease。
- 发布 lockfile 的本地 link/file/绝对 WebLoom 路径、同时解析 0.3.0 与 0.4.0。

允许保留且必须注明用途：

- 历史文档中的旧符号，以及证明旧协议被拒绝的负向测试。
- 产品 DTO 内有独立意义的 requestId、connectionId、session.open、UpgradeGate.handshake、owner/session/grant/CAS。
- 本地 MessageBus、产品 Connect/P2P/媒体独立协议、明确声明并验收的业务数据 port。它们不能承担已迁移 Coordinator 主通道的兜底。
- Keymaster 的领域 facade 与 advanced 装配：直接实现/调用 v4 契约，不接受旧 WebLoom 调用签名。

## 7. 完成定义

仅当 V4-001–019 和 AT-01–22 所需证据全部满足，才能称“三仓 v4 迭代完成”。如果只完成代码与本地验收，最终报告必须准确写到该层。

最终交付包含：三仓代码/依赖/教程变更、需求与施工单状态更新、verification 证据、旧 API 清除报告、同一 tarball/registry integrity、产品恢复与部署状态。没有额外的“以后再去掉兼容层”或 SWCF-009 尾项。
