// 将已有产品传输绑定到 Window 插件，不新增网络协议或放宽 RuntimeKind。
import type { RpcCapability } from "../contracts/capability.js";
import { definePlugin } from "../authoring/definePlugin.js";

/** 产品拥有实际连接、重连、认证与编解码；框架只管理插件生命周期。 */
export interface DaemonTransport {
  /** 调用明确登记的产品方法，signal 必须传给现有传输。 */
  call(method: string, request: unknown, options: { signal: AbortSignal }): Promise<unknown>;
}

/** 显式映射能力到产品方法，不自动公开后台能力目录。 */
export interface DaemonRpcBinding<C extends RpcCapability<any, any> = RpcCapability<any, any>> {
  /** 前台使用的 typed capability，包含请求和结果 parser。 */
  readonly capability: C;
  /** 既有产品 API 方法。 */
  readonly method: string;
}

/** 后台服务在 Window 的适配单元；产品业务插件消费这里提供的能力。 */
export function defineDaemonBridge(options: {
  /** 适配插件名，应与业务插件分开，避免同 Runtime 重复注册。 */
  readonly id: string;
  /** 由产品提供，框架不持有钱包或通用 API 客户端。 */
  readonly transport: DaemonTransport;
  /** 正式公开方法的静态映射。 */
  readonly bindings: readonly DaemonRpcBinding[];
}) {
  const bindings = [...options.bindings];
  return definePlugin({
    id: options.id,
    provides: bindings.map(binding => binding.capability),
    setup(ctx) {
      for (const { capability, method } of bindings) {
        if (!method) throw new TypeError("Daemon method must not be empty");
        ctx.handle(capability, async (request, call) => {
          const result = await options.transport.call(method, request, { signal: call.signal });
          if (call.signal.aborted) throw call.signal.reason ?? new Error("Daemon call cancelled");
          return result;
        });
      }
    },
  });
}

/** 保留具体 capability 的请求/响应推导，供产品单独声明映射。 */
export function daemonRpcBinding<C extends RpcCapability<any, any>>(capability: C, method: string): DaemonRpcBinding<C> {
  return { capability, method };
}
