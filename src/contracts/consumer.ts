// WebLoom 插件实例消费视图（PCB-R02）。
//
// PluginConsumer 是 Host 为“某一个真实运行实例”签发的受限读取入口：
// 它只暴露该实例已声明的 provides/dependencies，实例停用后立即失效。
// 完整 PluginContext 只在 setup 阶段可用；下游 UI 注册、React 组件和资源
// 加载器应绑定这里的 consumer，而不是全局 Host 或 App。

import type { Capability, CapabilityClient, CapabilityDependency } from "./capability.js";

/** 当前 consumer 实例是否仍然有效。 */
export type PluginConsumerStatus = "active" | "revoked";

/**
 * 插件实例的受限消费视图。
 *
 * 字段语义：
 * - `pluginId` / `unitId` / `instanceId` 只读，仅供诊断展示；
 *   它们不是申请身份的凭据，也不能用来构造另一个实例的视图。
 * - `capability` / `optionalCapability` 的可用集合 = 该实例静态声明的
 *   provides + dependencies，并且每次解析前都要确认实例仍有效。
 * - `subscribe` 用于让 UI 感知能力目录或实例有效性变化；它复用 Host 的
 *   同一份状态，不创建第二份 Host 快照。
 *
 * 该视图刻意不包含 provide/handle、Host、App、消息总线、根 Scope、调度器
 * 以及任何启停/dispose 管理操作。需要这些能力的可信代码应使用 setup 阶段的
 * PluginContext 或装配层的 advanced 接口。
 *
 * 泛型 `TProvides` / `TDependencies` 保留插件作者的声明范围，使未声明的
 * capability 在编译期就无法传入，而不是只能运行时被拒绝。
 */
export interface PluginConsumer<
  TProvides extends readonly Capability[] = readonly Capability[],
  TDependencies extends readonly CapabilityDependency[] = readonly CapabilityDependency[],
> {
  /** 只读插件标识；仅供诊断显示，不能用于申请身份。 */
  readonly pluginId: string;
  /** 只读运行单元标识。 */
  readonly unitId: string;
  /** 当前运行实例标识；实例停用后重新启用必然产生新的 instanceId。 */
  readonly instanceId: string;
  /** 当前 consumer 是否仍然可用于解析能力。 */
  readonly status: PluginConsumerStatus;
  /**
   * 按 typed 契约读取已声明依赖或自身提供的能力。
   * 未声明、版本不匹配或实例已撤销时抛出结构化错误。
   */
  capability<C extends AvailableConsumerCapability<TProvides, TDependencies>>(capability: C): CapabilityClient<C>;
  /**
   * 读取已声明但当前可能缺席的能力。
   * “已声明但不存在”返回 undefined；未声明、版本不匹配和实例已撤销仍然抛错。
   */
  optionalCapability<C extends AvailableConsumerCapability<TProvides, TDependencies>>(capability: C): CapabilityClient<C> | undefined;
  /** 订阅能力目录/实例有效性变化；返回幂等的退订函数。 */
  subscribe(listener: () => void): () => void;
  /**
   * 读取本运行单元所属的**私有能力**（PSM-R13）。
   *
   * 私有入口不在可解析集合里，因此不会因为“未声明”而报错：它的授权来自 Host 记录的
   * 真实实例身份（同 pluginId + 同 unitId）。其他插件、其他单元、网页插件与外部 App 都
   * 没有这条解析路径；调用方也不能自填所属标识。
   *
   * 私有句绑定消费单元与提供者服务世代：任一侧撤销后旧句柄立即失效。
   */
  privateCapability<C extends Capability>(capability: C): CapabilityClient<C>;
}

/** consumer 可解析的 capability = 自身 provides + 声明的 dependencies。 */
export type AvailableConsumerCapability<
  TProvides extends readonly Capability[],
  TDependencies extends readonly CapabilityDependency[],
> = TProvides[number] | ConsumerDependencyCapability<TDependencies>;

/** 依赖条目里携带的 capability 对象类型；装配层补齐 source 后仍然是它。 */
type DeclaredRuntimeDependencyCapability<TDependencies extends readonly CapabilityDependency[]> = TDependencies[number] extends {
  readonly capability: infer C;
}
  ? C extends Capability
    ? C
    : never
  : never;

/**
 * 依赖条目的精确化版本。
 *
 * 插件没有写 `dependencies` 时，`PluginContext` 的默认泛型是宽类型
 * `readonly CapabilityDependency[]`，直接取 `[number]` 会退化成“任意
 * capability”，使未声明的能力也能通过编译。这里检测该宽回退并收缩为空，
 * 保证“未声明即编译失败”，同时不影响显式写出的依赖元组。
 */
type ConsumerDependencyCapability<TDependencies extends readonly CapabilityDependency[]> =
  CapabilityDependency[] extends TDependencies ? never : DeclaredRuntimeDependencyCapability<TDependencies>;

/**
 * 框架内部使用的防伪造登记簿。
 *
 * 只有 Host 调用签发函数时才会把 consumer 写进这个 WeakSet；公开对象上不挂
 * 任何可枚举品牌字段，因此复制字段、JSON 序列化或结构断言都拿不到“合法
 * consumer”身份。这是防误用约束，不是同一 realm 内的安全沙箱。
 */
const issuedConsumers = new WeakSet<object>();

/** 登记一个由框架签发的 consumer 对象。 */
export function markPluginConsumerIssued<T extends object>(consumer: T): T {
  issuedConsumers.add(consumer);
  return consumer;
}

/** 判断对象是否由本框架的 Host 签发；用于拒绝结构相同的伪造视图。 */
export function isIssuedPluginConsumer(value: unknown): boolean {
  return typeof value === "object" && value !== null && issuedConsumers.has(value);
}
