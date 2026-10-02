# 插件实例消费边界迁移说明

适用版本：`webloom-framework@0.6.x`（源 API 变化；wire 版本不变，但快照单位状态枚举随
服务模型迭代变化，见 [`plugin-service-migration.md`](./plugin-service-migration.md)）。
本文件只描述 WebLoom 侧已经交付的入口和下游需要自己完成的动作；框架不代改下游代码、
依赖、锁文件或部署。

用户启停相关的删除项与行为变化不在本文件，统一见
[`plugin-service-migration.md`](./plugin-service-migration.md)。

## 1. 本轮变化清单

| 变化 | 影响面 | 下游动作 |
| --- | --- | --- |
| 新增 `PluginConsumer` 与 `ctx.consumer` | 插件 setup | 捕获 consumer，与注册项一起保存 |
| `ContributionAdapterInput` 增加 `consumer` | 可信贡献适配器 | 用它包装要挂载的组件 |
| `/react` 新增 `PluginConsumerProvider` 与三个插件 hook | 插件 UI | 组件从插件 Provider 读能力 |
| `ResourceContext.getCapability(id)` 删除，改为 `capability(C)` / `optionalCapability(C)` | 插件资源定义 | 改用 typed 契约 |
| `CreatePluginHostOptions.resourceCapabilityResolver` 改为接收 typed capability | 宿主装配层 | 按 kind/version 核对返回值 |
| 内置 `RESOURCE_REGISTRY` 不再免检 | 插件 | 在 `dependencies` 里显式声明 |
| 实例资源视图 `get()`/`_ids()` 只返回本实例定义 | 跨插件资源读取 | 改用提供方导出的 typed reader |

## 2. 迁移步骤

### 2.1 声明依赖（含内置资源注册表）

内置能力同样要声明。过去没声明也能用的读取现在会抛错：

```ts
const plugin = definePlugin({
  id: "contacts-page",
  dependencies: [
    { capability: Contacts },
    { capability: RESOURCE_REGISTRY }, // 内置 local 能力也要显式声明
  ] as const,
  setup(ctx) { /* ... */ },
});
```

### 2.2 注册 UI 时捕获 consumer

框架不规定路由/菜单/页面 schema；只需要“注册项和 consumer 出自同一次 setup”：

```tsx
// 下游自己的注册表：结构、排序和跳转都由你决定。
const routes = new Map<string, { consumer: PluginConsumer; render: () => ReactNode }>();

setup(ctx) {
  routes.set("/contacts", { consumer: ctx.consumer, render: () => <ContactsPage /> });
}

onDispose(() => routes.delete("/contacts"));
```

挂载时把同一个 consumer 交给 Provider：

```tsx
function MountedRoute({ entry }: { entry: { consumer: PluginConsumer; render: () => ReactNode } }) {
  return <PluginConsumerProvider consumer={entry.consumer}>{entry.render()}</PluginConsumerProvider>;
}
```

静态 manifest contribution 用 `ContributionAdapterInput.consumer`，它与 `ctx.consumer`
是同一个对象，因此静态与动态注册共用同一套绑定与撤权规则。

### 2.3 组件改为使用插件 hook

```tsx
import { useHasPluginCapability, useOptionalPluginCapability, usePluginCapability } from "webloom-framework/react";

// 改前：按 App/Host 全局查询，组件能读到别的实例声明的能力。
const contacts = useCapability(Contacts);

// 改后：按当前插件实例读取；未声明/错版本在编译期和运行时都被拒绝。
const contacts = usePluginCapability(Contacts);
const maybeSync = useOptionalPluginCapability(ContactsSync);
const hasSync = useHasPluginCapability(ContactsSync);
```

组件不要再调用 `useWebLoomApp`、`useCapability`、`usePluginRuntime`：在插件 Provider
子树内它们会直接抛错。页面级装配代码（拿到 App、启停插件、提交意图）仍用
`WebLoomProvider` 与 App hooks，但要放在插件 Provider 之外。

### 2.4 共享组件在提供方上下文运行

提供方导出共享 Picker 时，提供方自己包装 Provider；消费方只声明该组件能力依赖：

```tsx
// 提供方插件
export function ContactsPicker(props: PickerProps) {
  return (
    <PluginConsumerProvider consumer={ctx.consumer}>
      <Picker {...props} />
    </PluginConsumerProvider>
  );
}

// 消费方插件只声明 Picker 依赖，不需要拿到提供方其它能力。
```

### 2.5 资源定义改用 typed 上下文

```ts
// 改前：字符串旁路，可以读到当前实例未声明的能力。
key: (args, context) => [context.getCapability<Session>("app.session").accountId],

// 改后：按定义所属实例的声明解析。
key: (_args, context) => [context.capability(Session).accountId],
```

宿主自己登记的资源（装配层直接调用 `host.resourceRegistry.register(...)`）继续由
`resourceCapabilityResolver` 提供能力，注意它的签名已变为
`<C extends Capability>(capability: C) => CapabilityClient<C> | undefined`：按
`capability.kind` 与 `capability.version` 核对返回值，只按 id 返回会放行错版本请求。

### 2.6 撤权后的下游动作

- 实例撤销时 consumer 立即失效，Provider 停止渲染旧子树；下游不需要额外的“是否停用”
  判断，但可以在收到 `consumer.subscribe` 通知后刷新自己的菜单高亮/路由可见性。
- 实例重建会产生新的 `instanceId` 和新的 consumer。下游若缓存了 consumer 或由它解析出
  的 client/stream，必须改用新 consumer，不要按 `pluginId` 复用旧引用。重建由
  `host.retry()`（装配层）或运行条件解除触发，没有用户启停入口。
- 保留的远程 client 与 stream 在撤权后调用会失败；需要恢复交互时重新读取能力并重新
  订阅，不重放已发送的副作用调用。

## 3. 保证范围与限制

| 场景 | 框架保证 |
| --- | --- |
| consumer 新读取 | 撤权后立即抛错；同名重启签发新实例 |
| 已取得的 RPC/stream 句柄 | 绑定实例 Scope，撤权后停止工作 |
| 伪造 consumer（复制字段、JSON、`as` 断言） | Provider 拒绝 |
| 插件子树里调用 App/管理 hook | 拒绝，不返回外围 App |
| 资源 owner 撤权 | 取消在途加载、注销定义、不发布迟到结果 |
| local capability 返回的普通对象/函数 | **不撤销** |
| 插件已复制的数据、纯算法结果 | **不撤销** |

带副作用的 local 服务需要提供者自己给出实例有效性检查或窄 facade，最终 I/O 仍由领域
authority 复核。同一 realm 内的内置插件是可信代码，本边界不是 JavaScript 安全沙箱：
手工读取公开 context、导入 `webloom-framework/advanced` 或直接使用注入的 Host，需要
下游自己的源码/import 门禁。

## 4. 下游仍需自己完成的事

本轮只在 WebLoom 仓库实施。交付到框架不等于下游已经收紧，下游还需要：

1. 撤掉自行暴露的全局 Host 注入与适配器里的免检分支，补齐插件 `dependencies` 声明。
2. 把页面/菜单/首页注册与挂载改为绑定 `ctx.consumer`，并处理同名重启后的引用刷新。
3. 迁移资源 loader 的字符串读取，按实例声明补齐依赖。
4. 关闭敏感消息的旁路授权，保留领域侧的最终授权与不可逆 I/O 租约。
5. 运行自己的 import 门禁与最终 I/O 审计，确认没有插件子树拿到 App/管理入口。
