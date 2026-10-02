// 插件服务模型与所属 UI 的浏览器 fixture 契约（PSM-R08 / PSM-R10）。
//
// 这里只有 fixture 自己定义的内存契约：
//   - WebUiRegistry：网页插件提供的 typed UI 注册服务（条目 schema 属于产品，不进框架）；
//   - Theme / Picker：普通对内公开能力；
//   - Absent：已声明但没有提供者的可选能力。
//
// 私有实现刻意不在这里出现：Storage 的私有服务只存在于它的闭包与私有 React
// Context 中，没有任何 capability descriptor，因此其他插件在类型和运行时都无法解析。

import type { ReactNode } from "react";
import { defineCapability } from "../../src/index.ts";
import type { PluginConsumer } from "../../src/index.ts";

/** 主题服务：最普通的已声明依赖。 */
export const Theme = defineCapability<{ name: string }>({
  kind: "local",
  id: "fixture.psm.theme",
  version: "1",
});

/** 提供方导出的共享选择器；消费方只声明它，不获得提供方其它能力。 */
export const Picker = defineCapability<{ open(): string }>({
  kind: "local",
  id: "fixture.psm.picker",
  version: "1",
});

/** 已声明但没有任何提供者的可选能力；用于验证 optional 的“缺席”分支。 */
export const Absent = defineCapability<{ present: boolean }>({
  kind: "local",
  id: "fixture.psm.absent",
  version: "1",
});

/** 网页注册的三类 UI 接口。 */
export type WebUiKind = "page" | "settings" | "header";

/**
 * 一条 UI 注册项。
 *
 * `ownerInstanceId` 由框架按调用方 Scope 身份写入，调用方不填；`consumer` 与
 * `render` 由贡献插件自己提供，网页插件挂载时使用贡献方的 consumer，因此组件内部
 * 仍然运行在贡献方的私有 Context 中。
 */
export interface WebUiEntry {
  /** 条目 id；由贡献插件定义。 */
  readonly id: string;
  /** 条目类型。 */
  readonly kind: WebUiKind;
  /** 排序权重；由网页插件的布局策略解释。 */
  readonly order: number;
  /** 展示标题。 */
  readonly title: string;
  /** 贡献方的实例消费视图。 */
  readonly consumer: PluginConsumer;
  /** 贡献方提供的组件闭包。 */
  readonly render: () => ReactNode;
  /** 框架绑定的真实 owner 实例；条目不自带归属。 */
  readonly ownerInstanceId?: string;
}

/** 网页插件提供的 typed UI 注册服务。 */
export interface WebUiRegistry {
  /** 注册一个 UI 条目；归属由调用实例决定。 */
  register(entry: WebUiEntry): void;
  /** 更新已注册条目的展示字段。 */
  update(id: string, patch: Partial<Pick<WebUiEntry, "order" | "title">>): void;
  /** 注销条目；越权操作被拒绝。 */
  unregister(id: string): void;
  /** 当前条目快照。 */
  list(): readonly WebUiEntry[];
}

/** 网页插件对其他插件公开的唯一服务。 */
export const WEB_UI_REGISTRY = defineCapability<WebUiRegistry>({
  kind: "local",
  id: "fixture.psm.webUiRegistry",
  version: "1",
});

/** 网页插件在 setup 中用到的注册表目标：facade 包裹它完成归属绑定。 */
export interface WebUiRegistryTarget extends WebUiRegistry {
  /** 读取一个条目的 owner 实例；供网页插件做布局与诊断。 */
  ownerOf(id: string): string | undefined;
}

/** 被测插件的动态注册项：结构由下游定义，框架只保证 consumer 与真实实例一致。 */
export interface RegisteredPage {
  /** 注册项 id；与实际实例一起保存。 */
  readonly id: string;
  /** 注册时所属的真实运行实例。 */
  readonly instanceId: string;
  /** 注册时所属的插件标识。 */
  readonly pluginId: string;
  /** 挂载时使用的实例消费视图。 */
  readonly consumer: PluginConsumer;
}
