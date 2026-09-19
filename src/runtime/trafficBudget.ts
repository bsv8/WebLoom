// WebLoom v4 公共 Runtime 流量预算入口。
// 实际计数器仍由 transport 装配层使用；这里避免主入口直接暴露 transport 模块。

import { createRuntimeBudget, normalizeRuntimeLimits, type RuntimeBudget, type RuntimeLimitsInput } from "../transport/dto.js";

export type { RuntimeBudget } from "../transport/dto.js";

/**
 * 一个 Window 或 SharedWorker 拓扑共享的双向流量预算。
 *
 * outbound/inbound 分开统计方向，但同一方向上的所有 endpoint 共享同一
 * 个计数器；这样多个 RuntimeHandle 不会各自取得一整套 retained bytes。
 */
export interface RuntimeTrafficBudget {
  /** 从当前 Runtime 发出的 call、stream 和 payload 预算。 */
  readonly outbound: RuntimeBudget;
  /** 当前 Runtime 接收并执行的 call、stream 和 payload 预算。 */
  readonly inbound: RuntimeBudget;
}

/** 创建可供多个 RuntimeHandle/endpoint 共享的双向 Runtime 预算。 */
export function createRuntimeTrafficBudget(limits?: RuntimeLimitsInput): RuntimeTrafficBudget {
  const normalized = normalizeRuntimeLimits(limits);
  return Object.freeze({
    outbound: createRuntimeBudget(normalized),
    inbound: createRuntimeBudget(normalized),
  });
}
