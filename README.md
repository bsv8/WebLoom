# WebLoom

WebLoom 是一个与产品领域无关的前端插件生命周期框架。它管理插件产品、运行单元、实例、依赖图、生命周期 Scope、权限租约、消息总线、服务桥和资源缓存；路由、存储、日志、国际化等产品能力通过宿主适配器注入。

## 安装

```bash
pnpm add webloom-framework
```

WebLoom 是 ESM 单包，提供三个入口：

- `webloom-framework`：纯 TypeScript/Worker 可用的核心，不加载 React；
- `webloom-framework/react`：Provider、capability、Host、Registry 和 Resource Hooks；
- `webloom-framework/testing`：无产品语义的假 Host、假传输和测试辅助。

React 是可选 peer dependency。只使用 `webloom-framework` 时不需要安装 React。

## 最小 Host

```ts
import { createPluginHost, type PluginSetup } from "webloom-framework";

const helloSetup: PluginSetup = (ctx) => {
  ctx.provide("hello.service", { value: "world" });
  ctx.onDispose(() => {
    // 这里释放本插件登记的资源。
  });
};

const host = createPluginHost({
  runtimeUnitImplementationRegistry: {
    get(pluginId, unitId) {
      return pluginId === "hello" && unitId === "hello.window" ? helloSetup : undefined;
    },
  },
  contextExtension: ({ scope }) => ({
    // 宿主只读扩展；不能替换 pluginId、unitId 或 instanceId。
    scopeKind: scope.identity.kind,
  }),
});

await host.register({
  id: "hello",
  name: "Hello",
  meta: { defaultEnabled: true, canDisable: true },
  units: [{
    id: "hello.window",
    execution: "window",
    lifetime: "root",
    provides: ["hello.service"],
  }],
});
```

生产插件必须把 `execution`、`lifetime`、`dependencies`、`provides` 和 `permissions` 写在 `units` 中，并通过 `runtimeUnitImplementationRegistry` 按 `pluginId + unitId` 解析 setup。静态 Manifest 不携带可执行函数。

## 公共字段中文语义

| 字段 | 中文含义 |
| --- | --- |
| `pluginId` | 插件产品的稳定标识；用于用户启停和依赖图身份。 |
| `unitId` | 产品在一种执行环境中的稳定运行单元标识。 |
| `instanceId` | 某运行单元一次启动生成的唯一实例标识；重启不得复用。 |
| `execution` | 运行代码所在环境标签，由宿主定义。 |
| `lifetime` | 实例依附的生命周期标签，由宿主定义。 |
| `scopeId` | 本次生命周期 Scope 的唯一标识。 |
| `capability` | 插件提供或依赖的服务契约标识。 |
| `contractVersion` | capability 的精确契约版本。 |
| `permission` | 字符串形式的权限动作；具体集合由宿主批准。 |
| `attributes` | 宿主绑定的只读扩展元数据，不包含私密材料。 |
| `desiredEnabled` | 用户或控制面希望产品启用的持久意图。 |
| `state` | 当前运行实例的实际状态，不等于启用意图。 |
| `blockedBy` | 实例无法启动时缺失的依赖或 Scope 原因。 |

## 开发与验收

```bash
pnpm install
pnpm lint:boundaries
pnpm typecheck
pnpm test
pnpm build
pnpm run pack:consumer
```

`pack:consumer` 会在不访问本仓库源码的临时项目中安装 tarball，分别执行
core-only、React 和 Worker 消费者的 `tsc --noEmit` 与运行时 smoke，并检查
发布文件白名单、体积、`.d.ts` 和 `.js.map` 的本地路径及产品字段。版本、发布身份
与许可证确认属于发布责任人的操作，本仓库不自动执行发布。

详细 API 约束见 [`docs/api.md`](docs/api.md)。
