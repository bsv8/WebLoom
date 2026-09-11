// WebLoom v4 capability registry。
//
// 注册键来自 kind/id/version，而不是对象引用。Provider/handler 的 owner
// 信息留在本 realm，静态目录只使用 capabilityDescriptor。

import {
  capabilityDescriptor,
  capabilityKey,
  type Capability,
  type CapabilityDescriptor,
  type LocalCapability,
  type LocalServiceOf,
  type RemoteCapability,
  type RpcHandler,
  type RpcCapabilityBase,
  type StreamHandler,
  type StreamCapabilityBase,
  type ValueParser,
} from "../contracts/capability.js";
import type { HandlerCallContext } from "../contracts/capability.js";
import { WebLoomError, type LifecycleScope } from "../contracts/lifecycle.js";

/** Host 内部保存的 capability 注册。 */
export interface CapabilityRegistration {
  /** realm 内 capability 对象。 */
  readonly capability: Capability;
  /** 提供该能力的插件实例。 */
  readonly ownerId: string;
  /** local 服务值。 */
  readonly value?: unknown;
  /** RPC/stream 显式 handler。 */
  readonly handler?: unknown;
  /** 提供者作用域。 */
  readonly scope?: LifecycleScope;
  /** 该 handler 允许通过 call.peer 观察的 capability 身份。 */
  readonly peerDependencies?: readonly CapabilityDescriptor[];
  /** 注册身份。 */
  readonly reference: import("../contracts/capability.js").ServiceReference;
}

/** 能力 registry；不提供字符串或未约束泛型入口。 */
export interface CapabilityRegistry {
  /** 注册 local value；重复契约身份会抛错。 */
  provide<C extends LocalCapability<unknown>>(capability: C, value: LocalServiceOf<C>, ownerId?: string, scope?: LifecycleScope): void;
  /** 注册 RPC handler。 */
  handle<C extends RpcCapabilityBase>(capability: C, handler: RpcHandler<C>, ownerId: string, scope: LifecycleScope, reference: CapabilityRegistration["reference"], peerDependencies?: readonly CapabilityDescriptor[]): void;
  /** 注册 stream handler。 */
  stream<C extends StreamCapabilityBase>(capability: C, handler: StreamHandler<C>, ownerId: string, scope: LifecycleScope, reference: CapabilityRegistration["reference"], peerDependencies?: readonly CapabilityDescriptor[]): void;
  /** 撤销指定 owner 的一项能力。 */
  revoke(capability: Capability, ownerId?: string): void;
  /** 获取 local value。 */
  get<C extends LocalCapability<unknown>>(capability: C): LocalServiceOf<C>;
  /** 获取注册记录。 */
  registration(capability: Capability): CapabilityRegistration | undefined;
  /** 当前契约身份是否存在。 */
  has(capability: Capability): boolean;
  /** 要求当前契约身份存在。 */
  require(capability: Capability): CapabilityRegistration;
  /** 当前注册身份 DTO。 */
  descriptors(): readonly CapabilityDescriptor[];
  /** 当前注册记录；仅供 advanced/runtime 适配。 */
  registrations(): readonly CapabilityRegistration[];
  /** 在当前 realm 调用一个已注册的 RPC handler。 */
  invoke(capability: RemoteCapability, request: unknown, call: HandlerCallContext): Promise<unknown>;
  /** 在当前 realm 建立一个已注册的 stream handler。 */
  openStream(capability: StreamCapabilityBase, request: unknown, call: HandlerCallContext): Promise<AsyncIterable<unknown>>;
}

function cloneReference(reference: CapabilityRegistration["reference"]): CapabilityRegistration["reference"] {
  return Object.freeze({
    ...reference,
    attributes: Object.freeze({ ...reference.attributes }),
  });
}

/** 创建一个拒绝重复契约和 owner 越权撤销的 registry。 */
export function createCapabilityRegistry(): CapabilityRegistry {
  const entries = new Map<string, CapabilityRegistration>();

  const requireCapability = (capability: Capability): CapabilityRegistration => {
    const entry = entries.get(capabilityKey(capability));
    if (!entry) throw new Error(`Capability "${capability.id}" version "${capability.version}" is not available`);
    return entry;
  };

  return {
    provide(capability, value, ownerId = "host", scope) {
      if (capability.kind !== "local") throw new TypeError(`Capability "${capability.id}" is not local`);
      const key = capabilityKey(capability);
      if (entries.has(key)) throw new Error(`Capability "${capability.id}" version "${capability.version}" is already provided`);
      const reference = cloneReference({
        kind: "rpc",
        capabilityId: capability.id,
        contractVersion: capability.version,
        runtime: "window-main",
        runtimeInstanceId: "local",
        serviceInstanceId: `local:${ownerId}:${capability.id}:${capability.version}`,
        attributes: {},
      });
      entries.set(key, { capability, ownerId, value, scope, reference });
    },
    handle(capability, handler, ownerId, scope, reference, peerDependencies) {
      if (capability.kind !== "rpc") throw new TypeError(`Capability "${capability.id}" is not an RPC capability`);
      const key = capabilityKey(capability);
      if (entries.has(key)) throw new Error(`Capability "${capability.id}" version "${capability.version}" is already handled`);
      entries.set(key, {
        capability,
        ownerId,
        handler,
        scope,
        ...(peerDependencies ? { peerDependencies: Object.freeze([...peerDependencies]) } : {}),
        reference: cloneReference({ ...reference, kind: "rpc" }),
      });
    },
    stream(capability, handler, ownerId, scope, reference, peerDependencies) {
      if (capability.kind !== "stream") throw new TypeError(`Capability "${capability.id}" is not a stream capability`);
      const key = capabilityKey(capability);
      if (entries.has(key)) throw new Error(`Capability "${capability.id}" version "${capability.version}" is already handled`);
      entries.set(key, {
        capability,
        ownerId,
        handler,
        scope,
        ...(peerDependencies ? { peerDependencies: Object.freeze([...peerDependencies]) } : {}),
        reference: cloneReference({ ...reference, kind: "stream" }),
      });
    },
    revoke(capability, ownerId) {
      const key = capabilityKey(capability);
      const entry = entries.get(key);
      if (!entry) return;
      if (ownerId !== undefined && entry.ownerId !== ownerId) return;
      entries.delete(key);
    },
    get(capability) {
      const entry = requireCapability(capability);
      if (capability.kind !== "local" || entry.value === undefined) {
        throw new Error(`Capability "${capability.id}" is not a local value`);
      }
      return entry.value as LocalServiceOf<typeof capability>;
    },
    registration: (capability) => entries.get(capabilityKey(capability)),
    has: (capability) => entries.has(capabilityKey(capability)),
    require: requireCapability,
    descriptors: () => Object.freeze([...entries.values()].map((entry) => capabilityDescriptor(entry.capability))),
    registrations: () => Object.freeze([...entries.values()]),
    async invoke(capability, request, call) {
      const entry = requireCapability(capability);
      if (capability.kind !== "rpc" || typeof entry.handler !== "function") {
        throw new Error(`Capability "${capability.id}" is not an RPC handler`);
      }
      return await invokeCapabilityHandler(entry, request, call);
    },
    async openStream(capability, request, call) {
      const entry = requireCapability(capability);
      if (capability.kind !== "stream" || typeof entry.handler !== "function") {
        throw new Error(`Capability "${capability.id}" is not a stream handler`);
      }
      return await invokeCapabilityHandler(entry, request, call) as AsyncIterable<unknown>;
    },
  };
}

/** 在 registry 记录中执行已判别的 handler；供 transport/provider 使用。 */
export function invokeCapabilityHandler(
  registration: CapabilityRegistration,
  request: unknown,
  context: HandlerCallContext,
): unknown | Promise<unknown> {
  if (registration.capability.kind === "rpc") {
    const capability = registration.capability as typeof registration.capability & {
      readonly request: ValueParser<unknown>;
    };
    const handler = registration.handler as ((request: unknown, context: HandlerCallContext) => unknown | Promise<unknown>) | undefined;
    if (!handler) throw new Error(`Capability "${registration.capability.id}" has no RPC handler`);
    let parsed: unknown;
    try { parsed = capability.request.parse(request); }
    catch (error) { throw new WebLoomError("request_validation_failed", error instanceof Error ? error.message : String(error), "validate", { capabilityId: capability.id }); }
    return handler(parsed, context);
  }
  if (registration.capability.kind === "stream") {
    const capability = registration.capability as typeof registration.capability & {
      readonly request: ValueParser<unknown>;
    };
    const handler = registration.handler as ((request: unknown, context: HandlerCallContext) => unknown | Promise<unknown>) | undefined;
    if (!handler) throw new Error(`Capability "${registration.capability.id}" has no stream handler`);
    let parsed: unknown;
    try { parsed = capability.request.parse(request); }
    catch (error) { throw new WebLoomError("request_validation_failed", error instanceof Error ? error.message : String(error), "validate", { capabilityId: capability.id }); }
    return handler(parsed, context);
  }
  throw new Error(`Capability "${registration.capability.id}" cannot be invoked remotely`);
}
