// WebLoom 测试辅助：只提供通用假实现，不携带产品语义。

import type {
  RemoteServiceCallContext,
  RemoteServiceTransport,
} from "../contracts/lifecycle.js";
import {
  createPluginHost,
  type CreatePluginHostOptions,
  type PluginHost,
} from "../host/createPluginHost.js";

export interface FakeTransportCall {
  /** 调用请求体。 */
  request: unknown;
  /** Host 已绑定的调用上下文。 */
  context: RemoteServiceCallContext;
}

export interface CreateFakeTransportOptions {
  /** 假服务返回值；缺省返回 undefined。 */
  handle?: (request: unknown, context: RemoteServiceCallContext) => unknown | Promise<unknown>;
}

/** 创建可观察的假服务传输；每次 call 都记录 request 和 context。 */
export function createFakeRemoteServiceTransport(
  options: CreateFakeTransportOptions = {},
): RemoteServiceTransport & { readonly calls: readonly FakeTransportCall[]; reset(): void } {
  const calls: FakeTransportCall[] = [];
  return {
    calls,
    reset() { calls.length = 0; },
    async call<TRequest, TResult>(request: TRequest, context: RemoteServiceCallContext): Promise<TResult> {
      calls.push({ request, context });
      return await options.handle?.(request, context) as TResult;
    },
  };
}

/** 创建测试 Host；默认关闭任何领域装配，只保留通用核心。 */
export function createFakePluginHost(options: CreatePluginHostOptions = {}): PluginHost {
  return createPluginHost({
    ...options,
    initialPluginConfig: options.initialPluginConfig ?? {},
  });
}
