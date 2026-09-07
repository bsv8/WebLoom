# WebLoom API 说明

## 依赖和运行单元

`PluginManifest` 描述一个产品，`RuntimeUnitDescriptor` 描述该产品在某个 `execution` 环境中的运行单元。`pluginId` 是产品级稳定身份，`unitId` 是单元级稳定身份，`instanceId` 是每次启动新生成的实例身份。运行单元依赖必须同时声明 `capability`、`contractVersion`、`sourceExecution` 和 `scope`，Host 不根据 capability 名猜测远端服务。可执行 setup 必须由宿主的 `runtimeUnitImplementationRegistry` 按 `pluginId + unitId` 提供，静态清单不携带函数。

`meta.defaultEnabled` 是初始启用意图，`PluginState.kind` 是实际运行状态。两者必须分开读取：依赖缺失时可以得到 `blocked`，同时保留 `desiredEnabled: true`。

## Context 和 Scope

`PluginContext` 的基础字段只包含插件身份、实例身份、Scope、取消信号、权限租约、MessageBus、配置和 capability 访问。产品服务通过 `contextExtension` 注入，扩展属性按只读对象处理。

`LifecycleScope.revoke()` 是同步安全边界：它先阻止新资源、撤销权限租约并触发 `AbortSignal`；`dispose()` 再等待清理。清理失败和超时通过 `LifecycleDisposeResult` 暴露，不能被包装成成功。异步创建在撤权后才返回时，资源会立即释放且不会进入旧实例。

## 权限

权限租约把插件申请、可信批准和会话约束求交集。`permissions` 只是 Context 视图，最终远端调用或持久化写入仍需使用 `verifyPermissionLease()` 和 `assertBinding()` 做 fail-closed 检查。`attributes` 参与租约身份比较，但不作为任意数据仓库。

## 服务桥和 wire codec

`createServiceBridge()` 只接受同一连接、权威身份、连续快照和精确契约版本。旧 revision、revision gap、Provider 实例重建和断线都会使旧代理永久失效。传输层每次调用生成独立 `callId`；业务 `operationId` 可以重用，两者不混淆。

`createRemoteServiceMessageCodec()` 默认生成 `webloom.remote-service.*` 消息名。产品迁移旧协议时可以传入旧前缀，编码、解码和版本仍由 codec 集中负责。

## 宿主扩展点

`CreatePluginHostOptions` 提供 `capabilities`、`contextExtension`、`manifestValidator`、`scopeResolver`、`permissionPolicy`、`configStore`、`pluginIntentCoordinator`、`runtimeSnapshots`、`contributionAdapters` 和 `serviceBridgeForPlugin`。WebLoom 不创建产品 Registry、日志、存储或身份状态机。

贡献适配器返回的 `ContributionHandle` 支持 `revoke()` 和 `dispose()`：前者用于同步撤下入口，后者用于等待异步收尾。任何贡献都必须绑定当前 `instanceId` 和 Scope。
