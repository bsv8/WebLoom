# 插件服务模型迁移说明（Keymaster / DemoWebLoom）

适用版本：`webloom-framework@0.6.0`（破坏性变更）。本轮只交付 WebLoom 框架契约、
示例、测试与文档；下游改动不在本轮实施范围，这里只列必须迁移的接入点。

本文件取代 [`plugin-consumer-migration.md`](./plugin-consumer-migration.md) 中的启停
部分；实例消费视图、资源视图与保证范围仍然有效。

## 1. 删除的 API（没有别名，没有兼容分支）

| 删除项 | 位置 | 替代 |
| --- | --- | --- |
| `startup` / `defaultEnabled` / `canDisable` | `PluginManifest`、`definePlugin()` 选项、`PluginStartupMode` | 无。装配清单里的插件全部参与系统 |
| `host.enable()` / `host.disable()` | `PluginHost` | `host.revoke(pluginId, reason)` 释放实例 + `host.retry(pluginId)` 恢复 |
| `host.suspend()` | `PluginHost` | `host.revoke(pluginId, reason)` |
| `host.submitIntent()` | `PluginHost` | 无。生命周期由依赖图与运行条件决定 |
| `PluginConfigStore` / `createInMemoryPluginConfigStore` / `initialPluginConfig` | Host options | 无启停专用配置存储 |
| `PluginIntentController` / `PluginIntentCommand` / `PluginIntentSnapshot` / `PluginIntentCoordinator` 及实现模块 | `/advanced`、`/testing` | 无 |
| `PluginState.desiredEnabled` / `desiredRevision`、`PluginReverseDep.enabled` | 公共状态类型 | `PluginState.blockedBy`、`PluginReverseDep.running` |
| `PluginStateKind` 的 `"disabled"` / `"error-disabled"` | 公共状态类型 | `"registered"`（待启动/等待重建）、`"failed"`（失败） |
| `StartupPluginError` | `/advanced` | 插件失败进入 `PluginState.failed` + `host.explain(id)` 原因 |
| `usePluginRuntime().enable/disable/submitIntent/isEnabled` | `/react` | `isRunning()`；释放走装配层 Host |

## 2. 行为变化（不改代码也会遇到的）

1. **`createWindowApp()` / `startSharedWorkerApp()` 不再因为某个插件启动失败而 reject。**
   失败或缺依赖的插件进入 `blocked` / `failed`，服务不可用与实例生命周期分开表达。
   下游必须在装配后显式检查，例如：

   ```ts
   const app = await createWindowApp({ plugins });
   for (const id of app.installed()) {
     const state = app.pluginState(id);
     if (state?.kind === "blocked" || state?.kind === "failed") {
       throw new Error(`${id} unavailable: ${state.blockedBy?.join(", ") ?? state.error ?? "unknown"}`);
     }
   }
   ```

   依赖环、提供者歧义、非法契约仍在装配校验阶段直接拒绝。
2. **快照单位状态枚举变化**：`disabled` / `error-disabled` 移除，新增 `failed`；
   `desiredEnabled` / `desiredRevision` 不再进入快照。两侧使用同一份校验列表，旧构建
   收到的快照会被明确拒绝。
3. **启动顺序由依赖图决定**，不再由清单顺序或 `required` 分类决定。原先靠
   `startup: "required"` 保证先启动的插件，现在依赖它的 typed capability 即可。
4. **释放后不会自动重建**：`revoke()` 会记录 `blockedBy: ["revoked:<reason>"]`，需要
   `retry()` 或运行条件解除（`runtimeUnitAvailability`）才会重建。这与旧 `disable()`
   + `enable()` 的往返语义不同。
5. **销毁严格按反向依赖分层**：消费者清理完成后才释放提供者；Host 整体销毁同样如此。
   依赖下游如果在 `onDispose` 里假定“提供者还在”，以前能工作，现在会看到 scope 已撤销。
6. **已绑定的可选依赖参与启动顺序**：可选依赖的提供者已在装配清单里时，消费者会等它
   就绪，因此 setup 里 `optionalCapability()` 的结果比旧版本更可能是“有值”。
7. **远程/本地句柄绑定服务实例世代**：可选提供者重建后，旧 RPC/stream 句柄以
   `service_stale` / `service_revoked` 失败，不会自动切到新实现。需要长连接的代码要在
   重新解析后重建句柄，而不是复用旧引用。

## 3. 新增能力

| 新增 | 位置 | 用途 |
| --- | --- | --- |
| `createScopedRegistryView(target, scope, options)` | `/advanced` | 框架签发的注册门面：归属由 Scope 身份写入，越权注销/更新、撤销清理、迟到与异步晚到注册由框架处理 |
| `ScopedRegistryRegistration.ownerInstanceIdProperty` | `/advanced` | 注册规则：把框架实例归属写入条目字段 |
| `ScopedRegistryRegistration.updateIdArgument` / `immutableProperties` | `/advanced` | 更新规则：只允许更新本实例条目，归属字段不可改写 |
| `isIssuedScopedRegistryView()` / `scopedRegistryViewOwner()` | `/advanced` | 核对门面是否由框架签发、读取归属 |
| `startupLayers(graph)` | `/advanced` | 按声明依赖计算启动层级（诊断/自检用） |
| `host.revoke()` / `host.retry()` | `/advanced` | 生命周期事件与恢复 |

## 4. 资源视图收口

`instanceResourceRegistry.get()` / `_ids()` 现在只返回**本实例**的定义。旧代码如果靠
查询其它插件的定义或列举全局 id，必须改为：

- 跨插件共享资源：提供方导出一个 typed reader/subscription capability，消费方声明依赖；
- 自己的资源：继续用 `ctx.capability(RESOURCE_REGISTRY)` 登记与查询。

插件上下文仍然不暴露全局 `ResourceStore`；装配层保留完整视图。

## 5. 迁移顺序建议

1. **契约与运行时适配**：删掉 manifest 的启停字段与适配器里的免检分支，改用
   `blockedBy`/`failed`/`explain()` 表达装配问题；把“required 失败即抛错”的断言改成
   显式状态检查。
2. **网页插件与 UI 挂载**：把页面/设置块/指示灯注册改成 `createScopedRegistryView`，
   条目携带贡献方 consumer 与私有 Context；收回全局 Host 注入。
3. **基础服务逐个迁移**：Storage、Vault 分别梳理对内公开、Connect 公开与私有面；资源
   读取改走提供方导出的 reader。
4. **业务插件与 Connect**：逐个补依赖/注册；Connect 网关只发布显式名单并绑定 App 会话。

删除启停专用记录不会删除钱包、文件或业务配置；具体数据迁移与每层验收由下游施工单定义。
迁移期间可以分步施工，但最终不保留旧新双轨。
