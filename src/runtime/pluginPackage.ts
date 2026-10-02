// 运行时槽位与完整插件组织（PSM-R11 / PSM-R12 / PSM-R13）。
//
// 三个概念必须分开：
//   - RuntimeKind：运行环境类型（window-main / shared-worker）；
//   - runtimeSlot：逻辑运行时槽位（哪个 Worker），由可信装配决定；
//   - runtimeInstanceId：某次真实启动的身份。
//
// 同一个 Window Host 可以同时连接多个 Worker：每个槽位一个 bridge，新增槽位不会撤销
// 已有槽位。依赖通过槽位绑定服务来源，不按 kind 扫描第一个服务，也不依赖挂接顺序。
//
// 完整插件（complete plugin）是业务归属单位：同一 pluginId 可以有 Web 单元与 Worker
// 单元，各自独立 scope/instanceId；Worker 单元的私有函数通过所属单元的私有契约暴露，
// 只对同插件同单元的调用方可见，不进入公共 provides 或 Connect 名单。

import { capabilityDescriptor, type Capability, type CapabilityDescriptor } from "../contracts/capability.js";
import type { PluginManifest, RuntimeUnitDescriptor } from "../contracts/plugin.js";
import type { RuntimeKind } from "../contracts/lifecycle.js";
import type { RuntimePluginDefinition } from "./pluginDefinitions.js";
import type { PluginDefinition } from "../contracts/plugin.js";

/**
 * 私有能力契约。
 *
 * 它与公共 capability 的区别不在类型系统，而在**授权来源**：私有入口只登记在所属运行
 * 单元的私有目录里，只有同 pluginId + 同 unitId 的调用实例能解析；公共 consumer、公共
 * 服务目录与 Connect 自动导出名单都看不到它。
 */
export interface PrivateCapabilityDescriptor<C extends Capability = Capability> {
  /** 契约身份（kind/id/version），与公共契约同一套校验。 */
  readonly capability: C;
  /** 所属插件；由装配层从运行实例身份写入，调用方不能自填。 */
  readonly pluginId: string;
  /** 所属运行单元。 */
  readonly unitId: string;
  /**
   * 装配层签发的授权票据（PSM-R13）。
   *
   * 私有入口的授权不能由 pluginId/unitId 这类可推导的字符串充当：任何插件都知道这些
   * 字符串。票据必须由可信装配层生成，并只交给所属单元的 Host 与调用方；接收端在执行
   * handler 之前核对它，因此普通 `RuntimeHandle.capability()` 拿不到票据、调不动私有函数。
   */
  readonly grantId: string;
  /** 中文说明（诊断用）。 */
  readonly description?: string;
}

const privateDescriptors = new WeakMap<object, PrivateCapabilityDescriptor>();

/** 登记一个私有能力契约；登记簿由装配层创建，公开对象不带品牌字段。 */
export function definePrivateCapability<C extends Capability>(input: {
  readonly capability: C;
  readonly pluginId: string;
  readonly unitId: string;
  /** 装配层生成的不透明授权票据。 */
  readonly grantId: string;
  readonly description?: string;
}): PrivateCapabilityDescriptor<C> {
  if (typeof input.grantId !== "string" || input.grantId.trim() === "") {
    throw new TypeError("Private capability requires a non-empty assembly-issued grantId");
  }
  const descriptor: PrivateCapabilityDescriptor<C> = Object.freeze({
    capability: input.capability,
    pluginId: input.pluginId,
    unitId: input.unitId,
    grantId: input.grantId,
    ...(input.description !== undefined ? { description: input.description } : {}),
  });
  privateDescriptors.set(input.capability as unknown as object, descriptor as PrivateCapabilityDescriptor);
  return descriptor;
}

/** 读取私有能力登记；未登记返回 undefined。 */
export function privateCapabilityOf(capability: unknown): PrivateCapabilityDescriptor | undefined {
  return typeof capability === "object" && capability !== null ? privateDescriptors.get(capability) : undefined;
}

/**
 * 私有客户端句柄（所属单元专用）。
 *
 * 句柄绑定消费单元与提供者服务世代：任一侧撤销后立即失效，在途调用被取消，迟到结果
 * 不发布；同名重建必须重新解析才会得到新句柄。
 */
export interface PrivateUnitClient<C extends Capability> {
  /** 契约身份，仅供诊断。 */
  readonly descriptor: CapabilityDescriptor;
  /** 当前绑定的提供者 serviceInstanceId。 */
  readonly serviceInstanceId: string | undefined;
  /** typed 调用/订阅入口。 */
  readonly client: unknown;
  /** 绑定消费单元实例。 */
  readonly consumerInstanceId: string;
}

/**
 * 运行时槽位绑定。
 *
 * 槽位是装配层决定的部署事实：同一个 Worker 可以承载多个插件单元，也可以把不同插件
 * 部署到不同 Worker。插件代码不写死 URL/name，只声明“我要哪个槽位”。
 */
export interface RuntimeSlotBinding {
  /** 槽位标识；依赖用它绑定服务来源。 */
  readonly slotId: string;
  /** 槽位的运行环境类型。 */
  readonly kind: RuntimeKind;
  /** 逻辑 Runtime 标识（诊断与快照用）。 */
  readonly runtimeId: string;
  /** 可选的 Worker name（同一 slotId 对应同一个真实 SharedWorker）。 */
  readonly name?: string;
}

/** 规范化槽位标识；空值退化为默认值，便于装配层简写。 */
export function runtimeSlotId(slot: string | RuntimeSlotBinding | undefined, fallback: string): string {
  if (slot === undefined) return fallback;
  return typeof slot === "string" ? slot : slot.slotId;
}

/** 一个完整插件包：同一 pluginId，多 realm 单元，分别提供实现。 */
export interface CompletePluginPackage<
  TUnits extends Readonly<Record<RuntimeKind, unknown>> = Readonly<Record<RuntimeKind, unknown>>,
> {
  /** 静态 manifest；所有 realm 共用同一份身份描述。 */
  readonly manifest: PluginManifest;
  /** 各 realm 的实现，由 `definePluginPackage` 按 runtime 选择。 */
  readonly implementations: TUnits;
  /**
   * 单元 → 部署槽位的默认绑定（unitId → slotId）。
   *
   * 这里存的是槽位标识而不是完整对象：Worker URL/name 属于部署事实，由装配层在连接时
   * 决定，插件包本身不写死。
   */
  readonly slots: Readonly<Record<string, string>>;
}

/** `definePluginPackage` 的单元声明：一个真实的 `definePlugin` 单元定义 + 运行环境。 */
export interface PluginUnitInput {
  /** 该单元的运行环境；Web 单元与 Worker 单元由此区分。 */
  readonly runtime: RuntimeKind;
  /**
   * 该单元的真实定义（`definePlugin(...)` 的结果）。
   *
   * 单元的 provides / dependencies / privateProvides / setup 都只在这里声明一次；
   * 插件包不重复描述能力，也不自己发明 setup 形状。
   */
  readonly unit: PluginDefinition<never[], never[]> & { readonly descriptor: RuntimeUnitDescriptor };
  /** 该单元部署到的槽位（可选；默认按 runtimeKind 推导）。 */
  readonly slot?: string;
}

/**
 * 组织一个完整插件包（PSM-R11）。
 *
 * 它不创建 Host，也不执行 setup：只统一静态身份、单元描述与部署槽位，让 Web 与 Worker
 * 实现分别在对应 realm 导入。不会把任意函数搬到 Worker，也不为每个后台函数新建
 * 业务 pluginId。
 */
export function definePluginPackage(input: {
  /** 全局稳定插件标识；Web 与 Worker 单元共用。 */
  readonly id: string;
  /** 展示名称。 */
  readonly name?: string;
  /** 诊断描述。 */
  readonly description?: string;
  /** 各 realm 的单元声明。 */
  readonly units: readonly PluginUnitInput[];
  /** 默认槽位映射：unitId → slotId。 */
  readonly slots?: Readonly<Record<string, string>>;
  /** 可选的私有能力登记（按 unitId）。 */
  readonly privateCapabilities?: Readonly<Record<string, readonly PrivateCapabilityDescriptor[]>>;
}): CompletePluginPackage<Readonly<Record<string, unknown>>> {
  if (!input || typeof input.id !== "string" || input.id.trim() === "") throw new TypeError("Plugin package id must be a non-empty string");
  const units = [...input.units];
  if (units.length === 0) throw new TypeError(`Plugin package "${input.id}" must declare at least one runtime unit`);
  const seen = new Set<string>();
  for (const unit of units) {
    const unitId = unit?.unit?.descriptor?.id;
    // 单元身份必须与包一致：包是唯一的静态身份来源，装配阶段再纠正已经太晚。
    if (unit?.unit?.manifest?.id !== undefined && unit.unit.manifest.id !== input.id) {
      throw new TypeError(`Plugin package "${input.id}" unit "${unitId ?? ""}" belongs to plugin "${unit.unit.manifest.id}"`);
    }
    if (!unitId || unitId.trim() === "") throw new TypeError(`Plugin package "${input.id}" has an invalid unit id`);
    if (seen.has(unitId)) throw new TypeError(`Plugin package "${input.id}" has a duplicate unit "${unitId}"`);
    seen.add(unitId);
    if (unit.runtime !== "window-main" && unit.runtime !== "shared-worker") throw new TypeError(`Plugin package "${input.id}" unit "${unitId}" has an invalid Runtime`);
    if (typeof unit?.unit?.setup !== "function") throw new TypeError(`Plugin package "${input.id}" unit "${unitId ?? ""}" must provide a setup function`);
  }
  type UnitDependency = NonNullable<RuntimeUnitDescriptor["dependencies"]>[number];
  // 单元描述直接取自真实单元定义的 manifest：插件包不二次改写 provides/dependencies。
  // 单元描述直接取自真实单元定义的 descriptor：插件包不二次改写 provides/dependencies。
  const descriptors: RuntimeUnitDescriptor<unknown, Readonly<Record<string, unknown>>>[] = units.map((unit) => {
    const descriptor = unit.unit.descriptor;
    return Object.freeze({
      ...descriptor,
      id: descriptor.id,
      runtime: unit.runtime,
    } as RuntimeUnitDescriptor<unknown, Readonly<Record<string, unknown>>>);
  });
  const manifest: PluginManifest = Object.freeze({
    id: input.id,
    name: input.name ?? input.id,
    ...(input.description !== undefined ? { description: input.description } : {}),
    units: Object.freeze(descriptors.map((descriptor) => Object.freeze(descriptor))),
  });
  const slots: Readonly<Record<string, string>> = Object.freeze({
    ...(input.slots ?? {}),
    ...Object.fromEntries(units.flatMap((unit, index) => (unit.slot === undefined ? [] : [[descriptors[index]?.id ?? unit.unit.descriptor.id, unit.slot] as const]))),
  });
  const packageValue: CompletePluginPackage<Readonly<Record<string, unknown>>> = {
    manifest,
    implementations: Object.freeze(Object.fromEntries(units.map((unit, index) => [descriptors[index]?.id ?? unit.unit.descriptor.id, unit.unit]))),
    slots,
  };
  return Object.freeze(packageValue);
}

/** 取出某个 realm 下的单元实现；不在该 realm 的单元返回 undefined。 */
export function implementationsForRuntime(
  pkg: CompletePluginPackage,
  runtime: RuntimeKind,
): readonly RuntimePluginDefinition[] {
  return Object.entries(pkg.implementations)
    .filter(([unitId]) => pkg.manifest.units?.some((unit) => unit.id === unitId && (unit.runtime === runtime || unit.runtime === undefined)))
    .map(([unitId, unit]) => {
      const definition = unit as PluginDefinition & { readonly capabilities?: readonly Capability[] };
      return {
        // 使用完整包的 manifest（只含该 realm 需要的单元），而不是单元自己的
        // manifest：否则装配层拿到的插件身份会退回单元定义的名字（PSM-009）。
        manifest: Object.freeze({
          ...pkg.manifest,
          units: Object.freeze((pkg.manifest.units ?? []).filter((unit) => unit.id === unitId)),
        }),
        setup: definition.setup,
        ...(definition.capabilities !== undefined ? { capabilities: definition.capabilities } : {}),
        pluginId: pkg.manifest.id,
        unitId,
      };
    });
}
