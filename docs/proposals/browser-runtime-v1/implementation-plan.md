# WebLoom 浏览器双运行时施工单

## 1. 施工目标

把 WebLoom 从字符串运行标签和手工初始化装配，升级为真实的 `window-main + shared-worker` 浏览器双运行时；删除无执行语义的 `lifetime` 与插件分类 `kind`；用高层 API 封装 SharedWorker、MessagePort 和远程 capability。

需求基线见[浏览器双运行时迭代需求](./requirements.md)。本施工单是未来实施顺序，不表示任何工单已经完成。

## 2. 施工边界

### 2.1 本期包含

- WebLoom 核心契约精简；
- Window RuntimeHost；
- SharedWorker RuntimeHost；
- Window/Worker 高层连接 API；
- 初始化消融 API；
- 远程 capability 复用与收口；
- 测试工具、真实浏览器验收；
- DemoWebLoom 迁移；
- Keymaster 分阶段接入和旧装配删除。

### 2.2 本期不包含

- Server、Node、Deno、Bun 或 Edge PluginHost；
- Service Worker Runtime；
- 普通后台 API 通用封装；
- Keymaster 钱包、密码学、存储格式或业务协议重写；
- 将 setup 函数动态发送到 Worker；
- 用自动重试重放具有外部副作用的请求。

## 3. 实施原则

1. 先固化行为测试，再删除旧字段。
2. 真实 realm 建立必须早于旧 execution 标签删除。
3. Window 和 SharedWorker 各自创建 Host，不能由 Window Host 假装拥有 Worker 单元。
4. 多 Window 只增加连接，不增加 Worker RuntimeUnit 实例。
5. 同步撤权先于异步清理。
6. 旧代理永久失效，不静默重绑。
7. 静态 descriptor 与本地 implementation 在内部继续分离。
8. 初始化 helper 只隐藏机械装配，不隐藏安全错误。
9. Keymaster 迁移保持真实 SharedWorker 和私钥隔离连续可用。
10. Node 测试、MessageChannel 模拟与真实浏览器证据分开报告。

## 4. 里程碑

```text
M1 当前行为基线与消融量化
M2 契约精简和 Window Runtime
M3 SharedWorker Runtime 与连接封装
M4 跨 Runtime capability
M5 初始化简化与兼容清理
M6 DemoWebLoom 真实示例
M7 Keymaster 双 Host 接入
M8 完整验收与发布准备
```

## 5. 工单 WLBR-001：建立当前行为基线

### 目标

在修改 API 前固定当前有效安全行为，并量化初始化样板。

### 修改范围

- `src/host/createPluginHost.test.ts`
- `src/host/pluginGraph.test.ts`
- `src/transport/*.test.ts`
- 新增初始化基线 fixture 或测试夹具
- 不修改生产行为

### 工作

- 固化插件启用、停用、依赖阻塞、同步撤权、异步清理和实例重建行为；
- 固化旧服务引用在 provider instance、connection、revision 改变后失效；
- 记录最小示例所需 import、声明字段、初始化调用和手工映射；
- 明确现有 `lifetime` 在无 `scopeResolver` 时不产生差异化行为；
- 明确 `PluginMeta.kind` 在 WebLoom 核心中无消费点；
- 给同页面 MessageChannel 测试统一加上 transport simulation 命名或说明。

### 验收

- 旧行为测试通过；
- 基线报告能区分“保留的安全行为”和“待删除的装饰字段”；
- 不把 Node 测试写成真实 Worker 证据。

## 6. 工单 WLBR-002：精简公共契约

### 目标

删除无执行语义的字段，建立受限浏览器 Runtime 类型。

### 修改范围

- `src/contracts/lifecycle.ts`
- `src/contracts/plugin.ts`
- `src/host/pluginGraph.ts`
- `src/host/createPluginHost.ts`
- `src/index.ts`
- `docs/api.md`

### 工作

- 新增 `RuntimeKind = "window-main" | "shared-worker"`；
- 将运行单元的 `execution` 替换为 `runtime`；
- 删除 `PluginExecution = string`；
- 删除 `PluginLifetime = string`；
- 删除 `RuntimeUnitDescriptor.lifetime`；
- 删除 `PluginMeta.lifetime`、`defaultLifetime`；
- 删除 `RuntimeUnitDependency.scope` 和相关匹配逻辑；
- 删除 `PluginMeta.kind`、`PluginKind`；
- 从 WebLoom 核心删除 `displayGroup`；
- 保留 `PluginState.kind` 等真实判别字段；
- 保留内部 ResourceScope，但不再从 runtime unit 读取 scope kind；
- 未知 runtime 值在解析边界 fail closed。

### 测试

- JS/JSON 导入非法 runtime；
- 单元只能被匹配的 RuntimeHost 选择；
- 依赖不再读取 scope/lifetime；
- 删除字段后生成的 `.d.ts` 不残留旧符号；
- ResourceScope 的撤权、迟到资源和清理聚合回归通过。

### 验收

- `rg` 检查公开源码与声明中无旧 lifetime API；
- `PluginMeta.kind` 和 WebLoom `displayGroup` 完全移除；
- 删除分类字段不影响 PluginState 运行状态。

## 7. 工单 WLBR-003：Window RuntimeHost

### 目标

让 `window-main` 对应当前真实 Window，而不是调用者自报字符串。

### 修改范围

- 建议新增 `src/runtime/windowRuntime.ts`
- `src/host/createPluginHost.ts`
- `src/contracts/plugin.ts`
- `src/index.ts`

### 工作

- 实现 `createWindowApp()`；
- 内部固定 RuntimeKind 为 `window-main`；
- 每次创建生成 `runtimeInstanceId`；
- 批量接收插件定义，内部构建 Implementation Registry；
- 自动注册并启动初始插件；
- 必需插件启动失败时拒绝初始化 Promise；
- 返回 App handle，提供状态、capability 和 `dispose()`；
- 页面销毁适配保持显式，核心不得擅自把所有 `pagehide` 当成永久销毁。

### 验收

- 使用者不能把 Window Runtime 声称为 SharedWorker；
- 最小插件不创建 registry、不调用 `host.register()`；
- dispose 后旧 capability 同步不可取得；
- 再创建 App 得到新的 runtime/unit instance identity。

## 8. 工单 WLBR-004：插件定义与内部实现注册

### 目标

消除普通插件的 Manifest/setup/registry 三段样板，同时保持跨 realm 可序列化边界。

### 修改范围

- 建议新增 `src/authoring/definePlugin.ts`
- `src/host/runtimeUnitImplementationRegistry.ts`
- `src/contracts/plugin.ts`
- `src/index.ts`

### 工作

- 实现面向单 Runtime 简单插件的 `definePlugin()`；
- 定义清晰的 descriptor 与 implementation 内部分离结构；
- 自动生成默认 unitId；
- 默认目标为调用方 Runtime，普通 Window 插件不填 `runtime`；
- 为默认启用、可禁用插件提供一致默认值；
- 为 required 插件提供单一无矛盾声明方式；
- 本地 capability contract 可由 helper 生成；
- 跨 Runtime capability 必须保留显式精确版本；
- 保留低层 API 供框架内部和复杂打包场景使用，但不作为入门主路径。

### 必测场景

- 两个插件重复 id；
- 同一插件重复 unitId；
- descriptor 可序列化且不含 setup；
- Window bundle 不因静态描述导入 Worker-only 实现；
- 缺失本地 implementation 时结构化报错。

### 验收

- 最小示例只导入 `definePlugin`、`createWindowApp`；
- 复杂插件仍能共享 descriptor、分开打包实现；
- 静态 Manifest 不成为可执行函数目录。

## 9. 工单 WLBR-005：SharedWorker RuntimeHost

### 目标

在真实 `SharedWorkerGlobalScope` 内创建唯一 PluginHost，并管理多 Window 连接。

### 修改范围

- 建议新增 `src/runtime/sharedWorkerHost.ts`
- 建议新增 `src/runtime/runtimeProtocol.ts`
- 复用 `src/transport/messagePortServiceProvider.ts`
- `src/index.ts`

### 工作

- 实现 `startSharedWorkerApp()`；
- 安装并拥有 Worker 的 `onconnect`；
- 首个连接时创建或取得唯一 Worker Host；
- 后续连接复用同一 Host 和 RuntimeUnit 实例；
- 为每个端口生成 connectionId、请求空间和取消集合；
- Worker 每次启动生成新 runtimeInstanceId；
- 发布完整 Runtime/Unit/capability baseline；
- 单个端口断开只释放该连接资源；
- Host 显式 dispose 时同步撤销全部 capability 并关闭所有端口；
- 不假设 SharedWorker 提供可靠的终止回调。

### 验收

- 浏览器中实际全局对象为 `SharedWorkerGlobalScope`；
- 两个页面连接后 Worker setup 只执行一次；
- 一个页面断开不停止 Worker 插件；
- Worker 重建后所有实例身份变化。

## 10. 工单 WLBR-006：Window 连接封装

### 目标

让使用者通过 RuntimeHandle 使用 Worker，不直接操作 MessagePort。

### 修改范围

- 建议新增 `src/runtime/connectSharedWorker.ts`
- `src/transport/messagePortServiceTransport.ts`
- `src/transport/serviceBridge.ts`
- `src/contracts/lifecycle.ts`
- `src/index.ts`

### 工作

- 实现 `connectSharedWorker()`；
- 内部创建 module SharedWorker；
- 封装 `port.start()`、握手、baseline、增量 snapshot 和 disconnect；
- 提供 `ready/state/capability/subscribe/dispose`；
- 连接失败与协议不兼容返回结构化错误；
- 自动重连只能创建新连接与新代理；
- 页面永久 dispose 后禁止后台重连复活；
- 默认不暴露原始 MessagePort；
- 诊断中公开必要 identity/revision，但不公开授权 Secret。

### 测试

- 握手前调用；
- baseline 缺失；
- revision gap、回退和重复；
- provider rebuild；
- dispose 与 reconnect 竞争；
- 两个 RuntimeHandle 连接同一 Worker；
- 一个 handle 销毁后另一个继续调用。

### 验收

- 普通示例没有 MessageChannel/MessagePort 装配代码；
- 旧代理不会因重连恢复；
- 具有外部副作用的调用不被框架重放。

## 11. 工单 WLBR-007：跨 Runtime 依赖与状态投影

### 目标

让 Window Host 使用 Worker 发布的真实状态，不根据静态 Manifest 猜测。

### 修改范围

- `src/host/pluginGraph.ts`
- `src/host/createPluginHost.ts`
- `src/transport/serviceBridge.ts`
- Runtime snapshot contracts

### 工作

- 跨 Runtime 依赖声明来源 runtime 和精确 contractVersion；
- Window 依赖远程 capability 时等待 Worker baseline；
- Worker 状态投影只用于产品聚合和诊断，不在 Window 创建 Worker unit 假实例；
- 远程引用绑定 connectionId、runtimeInstanceId、providerInstanceId、contractVersion、status、revision；
- `scopeId` 若保留，只代表框架生成的具体实例 Scope，不恢复 lifetime 分类；
- 支持产品自定义 attributes 透传，但核心不解释 owner/session 等领域字段。

### 验收

- Worker 未连接时 Window 依赖保持 blocked；
- Worker ready 后只启动相关 Window 单元；
- 断线后 capability 即时撤销；
- 快照乱序不能让旧 Provider 恢复 ready。

## 12. 工单 WLBR-008：测试工具与真实浏览器验收

### 目标

建立清晰的三层证据，避免模拟测试冒充真实运行空间。

### 修改范围

- `src/testing.ts`
- `src/testing/fakes.ts`
- Vitest 配置
- 新增浏览器 fixture 和自动化脚本

### 工作

- 提供 `createTestApp()` 或等价内存 helper；
- 提供明确命名的 MessagePort transport simulation；
- 建立真实 HTML Window + module SharedWorker fixture；
- fixture 返回 Window/Worker global marker、runtime identity、setup count 和连接数；
- 覆盖多页面、断开、重连、Worker URL 变更和版本不兼容；
- 浏览器不支持 SharedWorker 时明确报告 unsupported，不能回退为主线程并通过。

### 验收

- Node 单测通过；
- transport simulation 通过；
- 真实浏览器确认代码执行在不同 realm；
- 验收报告分别列出三层结果。

## 13. 工单 WLBR-009：DemoWebLoom 迁移

### 目标

用 Demo 证明简化 API 和真实双运行时，而不是展示内部装配样板。

### 修改范围

- `/home/david/Workspaces/DemoWebLoom/examples/*`
- Demo README、课程说明和构建配置

### 工作

- `01-hello` 改为 `definePlugin + createWindowApp`；
- 删除所有 Demo 中的 `lifetime` 和插件 `meta.kind`；
- 普通示例不手工创建 Implementation Registry；
- remote 课程改用真实 module SharedWorker 文件；
- 页面不再同时创建 MessageChannel 两端来冒充 Worker；
- 在 UI 中展示 runtimeInstanceId、unitInstanceId、connectionId 和实际 global 类型；
- 保留低层 transport 课程时必须标明“协议模拟”，与真实 Worker 课程分开。

### 验收

- 所有课程 typecheck/build；
- 首页和各课程路由可访问；
- 真实浏览器交互验证 Worker setup 只执行一次；
- 文档不再把字符串 `execution: "worker"` 描述为物理 Worker 证据。

## 14. 工单 WLBR-010：Keymaster Window 接入

### 目标

让 Keymaster 页面使用新 Window Runtime 和 SharedWorker RuntimeHandle，同时保持现有 Coordinator 安全边界。

### 修改范围

- `/home/david/Workspaces/keymaster.cc/apps/web/src/bootstrapPlugins.ts`
- `keymasterSessionCoordinatorClient.ts`
- `packages/runtime/src/keymasterHostAdapter.ts`
- Keymaster Window plugin catalog/implementations

### 工作

- 用 `createWindowApp()` 替换页面侧手工 Host/registry/register 样板；
- 用 `connectSharedWorker()` 封装 SharedWorker 客户端连接；
- 保留现有 Worker URL 版本隔离、永久 shutdown 和 BFCache 处理；
- 把 Keymaster 领域 facade 建立在 RuntimeHandle/capability 之上；
- 删除页面对远端 WorkerUnit 的静态猜测；
- Keymaster 的 UI `displayGroup` 留在 Keymaster 契约，不回写 WebLoom 核心。

### 验收

- 页面插件实际运行在 Window；
- SharedWorker 不可用时 fail closed；
- 一个页面销毁不影响另一个页面；
- 页面不能取得明文私钥；
- 当前 Local `localStorage` 页面桥行为不被错误替换成其他存储技术。

## 15. 工单 WLBR-011：Keymaster Coordinator Worker 接入

### 目标

在现有真实 SharedWorker 中创建 WebLoom Worker Host，逐步替代手工 WorkerUnitRegistry，不改写钱包领域安全状态机。

### 修改范围

- `/home/david/Workspaces/keymaster.cc/apps/web/src/keymasterSessionCoordinator.worker.ts`
- `apps/web/src/coordinator/workerUnitCatalog.ts`
- `apps/web/src/coordinator/workerUnitRuntime.ts`
- 各 `packages/*/coordinator` 入口

### 工作

- 先把现有 Worker 入口挂接 `startSharedWorkerApp()`；
- 将 Vault、Storage 和一个低风险后台单元提取为真实 Worker RuntimeUnit implementation；
- 证明 Worker Host 真实调用 setup、产生实例、撤销 capability 并清理；
- 再按领域分批迁移 P2PKH、token、contacts、WOC/JungleBus、MSFile、Sat/Channel；
- 保留 Keymaster `sessionEpoch`、keyspace generation、owner fence、authority CAS 和 final-I/O lease；
- Vault lock/unlock 继续由 Coordinator 领域控制器执行，不映射成 WebLoom lifetime；
- Worker Runtime 只负责插件启停、实例归属、依赖与通用资源清理；
- 只有当运行快照完全来自真实 Worker Host 后，才能删除手工 WorkerUnitRegistry。

### 迁移顺序

```text
Vault/Storage 管理外壳
→ 无副作用服务单元
→ 后台只读同步
→ 写入/广播任务
→ MSFile、Sat/Channel 与执行租约
→ 删除旧手工目录和激活代码
```

### 安全验收

- Worker 重启必为 locked；
- 私钥只存在 Coordinator Worker 内存；
- lock 同步推进 epoch、撤销 grant、覆盖私钥；
- A → B → A 时旧代理和旧 store 不复活；
- 旧不可中断 I/O 通过既有 fence/lease 隔离；
- 多 Tab 只有一个 Coordinator Worker 业务实例；
- Local 桶仍通过页面 localStorage 桥，传输和权限边界不倒退。

## 16. 工单 WLBR-012：删除兼容层与更新文档

### 目标

新机制成为唯一公开路径，避免两套初始化方式长期并存。

### 修改范围

- WebLoom 全部源码、测试、README、API 文档
- DemoWebLoom
- Keymaster 已迁移调用点
- 发布配置与 consumer smoke

### 工作

- 删除旧 `execution/lifetime/defaultLifetime/scopeResolver` API；
- 删除 `PluginMeta.kind/PluginKind`；
- 删除普通使用者可见的手工 Implementation Registry 主路径；
- 删除已无调用者的 Keymaster WorkerUnitRegistry；
- 更新 README 最小示例和双运行时示例；
- 更新包导出和发布文件白名单；
- 搜索旧符号、旧字段和误导性 Worker 文案；
- 若必须提供短期迁移 helper，必须标注 deprecated 和明确删除版本，不能保留双真值。

### 验收

- 全仓精确搜索无预期外旧符号；
- package tarball 的 `.d.ts` 不泄漏旧 API；
- core-only、React、Window 和 SharedWorker consumer smoke 通过；
- 新用户只阅读 README 即可完成最小 Window 和 SharedWorker 示例。

## 17. 验证顺序

每个工单先执行目标测试，再逐步扩大：

```text
targeted unit tests
→ typecheck
→ boundary checks
→ full unit tests
→ build
→ package consumer smoke
→ real browser SharedWorker fixture
→ Demo browser interactions
→ Keymaster browser/runtime regression
→ git diff --check
```

### WebLoom 基础门禁

- `pnpm lint:boundaries`
- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
- `pnpm run pack:consumer`
- 新增真实浏览器 Runtime 验收命令

### Keymaster 集成门禁

- Keymaster typecheck、boundaries、targeted/full tests、build；
- Coordinator Client/Worker 的真实浏览器回归；
- 多 Tab 单 Worker 验证；
- lock/unlock、切 Key、Worker 重启、旧代理失效；
- Local 桶 cold start 与页面 localStorage 桥；
- 外部生产或真实 Provider 验收继续单独报告，不能由本地 fixture 替代。

## 18. 停止条件与回滚原则

遇到以下情况停止对应迁移批次，不继续删除旧路径：

- 新 SharedWorker Host 不能证明运行在独立 realm；
- 多页面产生重复 Worker RuntimeUnit 实例；
- 断线或重连使旧代理重新可用；
- Keymaster 私钥出现在 Window 或可序列化快照；
- lock 后旧签名/存储调用仍可进入最终 I/O；
- Local 桶因 Worker 无 localStorage 而失去可用页面桥；
- 新 helper 隐藏初始化失败或把 required 插件失败包装为成功。

回滚只能恢复上一批仍通过安全门禁的装配路径。不得回滚 session epoch、owner generation、已经提交的外部副作用或持久删除操作。

## 19. 最终交付物

- 精简后的 WebLoom 浏览器 Runtime API；
- `window-main` 和 `shared-worker` 真实 Host；
- SharedWorker RuntimeHandle 与自动连接协议；
- 初始化消融前后对比；
- 更新后的 API/README；
- DemoWebLoom 真实双运行时课程；
- Keymaster 双 Host 集成及旧手工注册表清理；
- 单元、模拟、真实浏览器和 Keymaster 集成四类独立验收记录；
- 未覆盖的外部环境与风险清单。
