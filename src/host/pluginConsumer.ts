// Host 签发的插件实例消费视图实现（PCB-R02/PCB-003）。
//
// 该模块只负责“判定 + 视图”，不复制 capability 注册表：解析规则完全复用
// createPluginHost 内已有的 resolveCapability，因此 setup、consumer、React
// 和资源加载器共享同一份声明核对与实例有效性判断。

import type { Capability, CapabilityClient } from "../contracts/capability.js";
import { markPluginConsumerIssued, type PluginConsumer } from "../contracts/consumer.js";

/** 视图解析能力的内部回调；语义与 Host 的 resolveCapability 相同。 */
export type ConsumerCapabilityResolver = <C extends Capability>(capability: C, optional: boolean) => CapabilityClient<C> | undefined;

/** Host 为单个实例构建 consumer 视图所需的最小输入。 */
export interface CreatePluginConsumerInput {
  /** 插件标识。 */
  readonly pluginId: string;
  /** 运行单元标识。 */
  readonly unitId: string;
  /** 当前实例标识。 */
  readonly instanceId: string;
  /** 与 setup 阶段共享的能力解析规则。 */
  readonly resolveCapability: ConsumerCapabilityResolver;
  /** 所属单元私有能力解析（PSM-R13）。 */
  readonly privateCapability?: <C extends Capability>(capability: C) => CapabilityClient<C>;
  /** 实例是否仍然有效；撤销后 consumer 立即拒绝新解析。 */
  readonly isActive: () => boolean;
  /** 目录/有效性变化订阅；返回退订函数。 */
  readonly subscribeChanges: (listener: () => void) => () => void;
  /** 实例被撤销时抛出的错误工厂。 */
  readonly revokedError: () => Error;
}

/**
 * 创建一个绑定到具体实例的 consumer 视图。
 *
 * 该对象由 Host 在 setup 与 contribution 注册阶段签发，并随实例 Scope 一起
 * 失效；同名插件重新启用会得到新的 consumer，旧 consumer 不会自动重绑。
 */
export function createPluginConsumer(input: CreatePluginConsumerInput): PluginConsumer {
  // 这里不做代理缓存：每次解析都走 Host 的共享 resolver，由它先核对实例有效性，
  // 再核对提供方当前是否仍然可用。曾经的缓存会让停用的提供方继续返回第一代
  // 服务，重启后也拿不到第二代。
  //
  // 引用稳定性由 resolver 保证：同 realm 客户端在 Host 侧按契约身份缓存，
  // bridge 背书的客户端只在代理被撤销后才换对象，因此“可用期间重复读取”仍返回
  // 同一引用，React 的 useSyncExternalStore 不会无限重渲染。
  const resolve = <C extends Capability>(capability: C, optional: boolean): CapabilityClient<C> | undefined => {
    // 顺序很重要：先判定实例有效性，再核对声明。撤权后的旧视图必须立刻
    // 失败，而不是先“意外命中”一个同名的重新启用实例。
    if (!input.isActive()) throw input.revokedError();
    return input.resolveCapability(capability, optional);
  };
  const consumer: PluginConsumer = {
    pluginId: input.pluginId,
    unitId: input.unitId,
    instanceId: input.instanceId,
    get status() {
      return input.isActive() ? "active" : "revoked";
    },
    capability(capability) {
      return resolve(capability, false) as CapabilityClient<never>;
    },
    optionalCapability(capability) {
      return resolve(capability, true) as CapabilityClient<never> | undefined;
    },
    subscribe(listener) {
      if (!input.isActive()) return () => undefined;
      return input.subscribeChanges(listener);
    },
    privateCapability(capability) {
      // 没有私有目录的 realm（例如未装配私有能力）一律拒绝，而不是静默回退到公共解析。
      if (!input.privateCapability) throw new Error(`Private capability "${(capability as Capability).id}" is not available in this Runtime`);
      return input.privateCapability(capability) as CapabilityClient<never>;
    },
  };
  return markPluginConsumerIssued(Object.freeze(consumer));
}
