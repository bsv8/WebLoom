import { capabilityKey, type CapabilityDescriptor, type CapabilityPeer, type CapabilityClient, type RemoteCapability, type CapabilityBridge, type PeerScopeView } from "../contracts/capability.js";
import type { LifecycleScope } from "../contracts/lifecycle.js";
import { WebLoomError } from "../contracts/lifecycle.js";

/** 将可信 peer controller 收窄为真正独立的普通 handler 作用域视图。 */
export function createPeerScopeView(scope: LifecycleScope): PeerScopeView {
  return Object.freeze({
    get state() { return scope.state; },
    signal: scope.signal,
    onRevoke(listener: (reason: string) => void) { return scope.onRevoke(listener); },
  });
}

/** 只复制 peer view 的公开字段，避免通过类型断言泄露 controller。 */
export function freezePeerView(peer: CapabilityPeer): CapabilityPeer {
  return Object.freeze(peer);
}

export interface CreatePeerViewOptions {
  /** 当前物理连接的 opaque peer id。 */
  readonly peerId: string;
  /** 独立的只读 scope facade。 */
  readonly scope: PeerScopeView;
  /** 当前连接 bridge；其目录身份由 bridge 管理。 */
  readonly bridge: CapabilityBridge;
  /** handler 所属插件声明的 peer capability allowlist；undefined 仅供可信装配使用。 */
  readonly allowed?: readonly CapabilityDescriptor[];
  /** 代理绑定的完整 peer scope。 */
  readonly capabilityScope?: LifecycleScope;
}

/** 创建真正独立的 PeerView；不把 PeerController 通过类型断言传给普通 handler。 */
export function createCapabilityPeerView(options: CreatePeerViewOptions): CapabilityPeer {
  const allowed = options.allowed === undefined
    ? undefined
    : new Set(options.allowed.map((descriptor) => capabilityKey(descriptor)));
  return Object.freeze({
    peerId: options.peerId,
    get runtime() { return options.bridge.runtimeKind; },
    get runtimeInstanceId() { return options.bridge.runtimeInstanceId; },
    scope: options.scope,
    capability<C extends RemoteCapability>(capability: C): CapabilityClient<C> {
      if (allowed && !allowed.has(capabilityKey(capability))) {
        throw new WebLoomError("capability_unavailable", "Capability is unavailable", "dispatch", { capabilityId: capability.id });
      }
      return options.bridge.getClient(capability, options.capabilityScope) as CapabilityClient<C>;
    },
  });
}
