// PluginConsumer 的类型负面测试（PCB-006）。
//
// 该文件只做静态断言：每一处 @ts-expect-error 去掉后都必须编译失败。
// 它不产生运行时副作用，也不会被任何入口导出。

import { defineCapability } from "./capability.js";
import { definePlugin } from "../authoring/definePlugin.js";
import type { PluginConsumer } from "./consumer.js";

const Theme = defineCapability<{ name: string }>({ kind: "local", id: "typecheck.consumer.theme", version: "1" });
const Secret = defineCapability<{ token(): string }>({ kind: "local", id: "typecheck.consumer.secret", version: "1" });
const ThemedPlugin = defineCapability<{ apply(theme: { name: string }): void }>({ kind: "local", id: "typecheck.consumer.themed", version: "1" });

// 只声明 Theme 的插件：它的 consumer 只能解析 Theme。
const definition = definePlugin({
  id: "typecheck-consumer",
  dependencies: [{ capability: Theme }] as const,
  setup(ctx) {
    const consumer: PluginConsumer<readonly [], readonly [{ readonly capability: typeof Theme }]> = ctx.consumer;
    consumer.capability(Theme);
    consumer.optionalCapability(Theme);

    // 未声明的能力在编译期就无法传入；运行时另有“未声明即拒绝”的断言。
    // @ts-expect-error 未声明的 capability 不能传给 consumer。
    consumer.capability(Secret);
    // @ts-expect-error optional 也不能绕过声明检查。
    consumer.optionalCapability(Secret);
    // @ts-expect-error capability 参数必须是契约对象，不能是字符串 id。
    consumer.capability("typecheck.consumer.theme");

    // 消费视图不是管理入口：没有 provide/handle/enable/disable。
    // @ts-expect-error consumer 不提供 provide。
    consumer.provide;
    // @ts-expect-error consumer 不提供 handle。
    consumer.handle;
    // @ts-expect-error consumer 不提供 enable。
    consumer.enable;
    // @ts-expect-error consumer 不提供 disable。
    consumer.disable;
    // @ts-expect-error consumer 不提供 dispose。
    consumer.dispose;
    // @ts-expect-error consumer 不暴露完整 Host。
    consumer.host;
    // @ts-expect-error consumer 不暴露 App。
    consumer.app;
    // @ts-expect-error consumer 不暴露根 scope。
    consumer.rootScope;
  },
});

// 提供方可以读回自己声明的 provides，但同样不能读未声明的依赖。
const provider = definePlugin({
  id: "typecheck-provider",
  provides: [ThemedPlugin] as const,
  setup(ctx) {
    ctx.consumer.capability(ThemedPlugin).apply({ name: "dark" });
    // @ts-expect-error 提供方不能读未声明的依赖。
    ctx.consumer.capability(Secret);
  },
});

void definition;
void provider;
