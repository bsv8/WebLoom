// WebLoom 测试辅助：不注入产品授权或绕过生产 parser。

import type { RuntimeReceiveMetadata, RuntimeTransport } from "../transport/serviceBridge.js";
import type { RuntimeWireMessage } from "../runtime/runtimeProtocol.js";
import { createPluginHost, type CreatePluginHostOptions, type PluginHost } from "../host/createPluginHost.js";

/** 可观察的 transport 发送记录。 */
export interface FakeTransportMessage {
  /** 已验证的 v4 message。 */
  readonly message: RuntimeWireMessage;
  /** transfer 资源。 */
  readonly transfer: readonly Transferable[];
}

/** 创建内存双向 transport；两侧可通过 emit 注入真实 wire message。 */
export function createFakeRuntimeTransport(): RuntimeTransport & {
  readonly sent: readonly FakeTransportMessage[];
  emit(message: RuntimeWireMessage, ports?: readonly MessagePort[]): void;
  reset(): void;
} {
  const sent: FakeTransportMessage[] = [];
  const listeners = new Set<(message: RuntimeWireMessage, metadata?: RuntimeReceiveMetadata) => void>();
  return {
    sent,
    send(message, transfer = []) { sent.push({ message, transfer: [...transfer] }); },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    emit(message, ports = []) { const metadata: RuntimeReceiveMetadata = { ports: Object.freeze([...ports]) }; for (const listener of [...listeners]) listener(message, metadata); },
    reset() { sent.length = 0; },
  };
}

/** 创建测试 Host；生产 Host 的 parser/lifecycle 路径保持不变。 */
export function createFakePluginHost(options: CreatePluginHostOptions = {}): PluginHost {
  return createPluginHost({ ...options, initialPluginConfig: options.initialPluginConfig ?? {} });
}
