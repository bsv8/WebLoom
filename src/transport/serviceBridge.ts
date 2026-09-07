// 跨 Worker 服务桥的本地实现。
//
// 桥只处理握手、服务目录连续性和代理失效；它不做自动寻址、不传递
// PluginContext，也不替代本地依赖装配器。真正的 RPC 入口仍必须在提供端
// 按引用、租约和宿主绑定属性再次校验。

import type {
  LifecycleScope,
  RemoteServiceBridge,
  RemoteServiceCallContext,
  RemoteServiceHandshake,
  RemoteServiceLookup,
  RemoteServiceProxy,
  RemoteServiceReference,
  RemoteServiceSnapshot,
  RemoteServiceSnapshotResult,
  RemoteServiceTransport,
} from "../contracts/lifecycle.js";
import { RemoteServiceUnavailableError } from "../contracts/lifecycle.js";

export interface CreateServiceBridgeOptions {
  /** 桥协议版本；握手要求精确匹配。 */
  protocolVersion: string;
  /** 实际端口 RPC 传输；桥不负责重放请求。 */
  transport: RemoteServiceTransport;
}

function makeRequestId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return `service-request:${crypto.randomUUID()}`;
    }
  } catch {
    // 测试 / 旧 Worker 没有 Web Crypto 时退回非安全唯一值；它不是授权凭据。
  }
  return `service-request:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
}

function mergeSignals(...signals: Array<AbortSignal | undefined>): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const activeSignals = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (activeSignals.length === 0) {
    return { signal: new AbortController().signal, dispose: () => undefined };
  }
  if (activeSignals.length === 1) {
    const [signal] = activeSignals;
    // length 已知为 1；显式判断是为了兼容 noUncheckedIndexedAccess。
    if (signal) return { signal, dispose: () => undefined };
  }
  const alreadyAborted = activeSignals.find((signal) => signal.aborted);
  if (alreadyAborted) {
    const controller = new AbortController();
    controller.abort(alreadyAborted.reason);
    return { signal: controller.signal, dispose: () => undefined };
  }
  const controller = new AbortController();
  const abort = (source: AbortSignal) => {
    try {
      controller.abort(source.reason);
    } catch {
      controller.abort();
    }
  };
  const listeners = activeSignals.map((signal) => {
    const listener = () => abort(signal);
    signal.addEventListener("abort", listener, { once: true });
    return { signal, listener };
  });
  return {
    signal: controller.signal,
    dispose: () => {
      for (const item of listeners) item.signal.removeEventListener("abort", item.listener);
    },
  };
}

function stableAttributes(value: Readonly<Record<string, unknown>>): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (!input || typeof input !== "object") return input;
    return Object.fromEntries(
      Object.entries(input as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalize(item)]),
    );
  };
  return JSON.stringify(normalize(value));
}

function referenceKey(reference: RemoteServiceReference): string {
  return [
    reference.capabilityId,
    reference.providerInstanceId,
    reference.execution,
    reference.contractVersion,
    reference.authorityInstanceId,
    reference.scopeId,
    reference.handoverGeneration,
    stableAttributes(reference.attributes),
    reference.grantId ?? "null",
    reference.authorizationRevision ?? "null",
    // 代理绑定的是某一份权威目录快照；目录修订后即使 Provider 实例未变，
    // 旧代理也不能继续使用旧授权视图，必须重新取得当前引用。
    reference.snapshotRevision,
  ].join("\u0000");
}

function lookupMatches(reference: RemoteServiceReference, lookup: RemoteServiceLookup): boolean {
  return reference.status === "ready"
    && reference.capabilityId === lookup.capabilityId
    && reference.contractVersion === lookup.contractVersion
    && (lookup.execution === undefined || reference.execution === lookup.execution)
    && (lookup.scopeId === undefined || reference.scopeId === lookup.scopeId);
}

interface ProxyRecord {
  reference: RemoteServiceReference;
  revoked: boolean;
  reason: string;
  controller: AbortController;
}

/**
 * 创建一个绑定端口的服务桥。
 *
 * 快照规则：必须先接受 baseline；后续 revision 必须连续递增。发现缺口后
 * 立即清空代理，等待新 baseline，不能拿旧服务继续运行。
 */
export function createServiceBridge(options: CreateServiceBridgeOptions): RemoteServiceBridge {
  let currentState: RemoteServiceBridge["state"] = "disconnected";
  let currentConnectionId: string | undefined;
  let currentAuthorityInstanceId: string | undefined;
  let lastRevision: number | undefined;
  let hasBaseline = false;
  const references = new Map<string, RemoteServiceReference>();
  const proxies = new Set<ProxyRecord>();
  const listeners = new Set<() => void>();

  const notify = () => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // 观察者异常不能让服务桥停止接收撤权消息。
      }
    }
  };

  const revokeProxy = (proxy: ProxyRecord, reason: string) => {
    if (proxy.revoked) return;
    proxy.revoked = true;
    proxy.reason = reason;
    try {
      proxy.controller.abort(new RemoteServiceUnavailableError(reason));
    } catch {
      proxy.controller.abort();
    }
  };

  const invalidateProxies = (reason: string, keep?: ReadonlySet<string>) => {
    for (const proxy of proxies) {
      if (!keep?.has(referenceKey(proxy.reference))) {
        revokeProxy(proxy, reason);
        // Proxy 对象仍可被调用方持有；这里只移除桥内部的追踪记录，
        // 避免每次 Provider 重建都累积一个永不再用的旧实例记录。
        proxies.delete(proxy);
      }
    }
  };

  const clearReferences = (reason: string) => {
    references.clear();
    invalidateProxies(reason);
  };

  const bridge: RemoteServiceBridge = {
    get state() {
      return currentState;
    },
    get connectionId() {
      return currentConnectionId;
    },
    get authorityInstanceId() {
      return currentAuthorityInstanceId;
    },
    handshake(input: RemoteServiceHandshake) {
      if (input.protocolVersion !== options.protocolVersion) {
        clearReferences("service bridge protocol mismatch");
        currentConnectionId = undefined;
        currentAuthorityInstanceId = undefined;
        lastRevision = undefined;
        hasBaseline = false;
        currentState = "disconnected";
        notify();
        return { accepted: false, reason: "protocol-mismatch" as const };
      }

      const isNewBinding = currentConnectionId !== input.connectionId
        || currentAuthorityInstanceId !== input.authorityInstanceId;
      if (isNewBinding) {
        clearReferences("remote service authority or connection changed");
        lastRevision = undefined;
        hasBaseline = false;
      }
      currentConnectionId = input.connectionId;
      currentAuthorityInstanceId = input.authorityInstanceId;
      currentState = "handshaking";
      notify();
      return { accepted: true };
    },
    applySnapshot(snapshot: RemoteServiceSnapshot): RemoteServiceSnapshotResult {
      if (snapshot.connectionId !== currentConnectionId) {
        return {
          accepted: false,
          reason: "wrong-connection",
          receivedRevision: snapshot.snapshotRevision,
        };
      }
      if (snapshot.authorityInstanceId !== currentAuthorityInstanceId) {
        return {
          accepted: false,
          reason: "wrong-authority",
          receivedRevision: snapshot.snapshotRevision,
        };
      }
      if (!Number.isSafeInteger(snapshot.snapshotRevision) || snapshot.snapshotRevision < 0) {
        return {
          accepted: false,
          reason: "stale-revision",
          receivedRevision: snapshot.snapshotRevision,
        };
      }
      if (!snapshot.baseline && !hasBaseline) {
        currentState = "stale";
        clearReferences("service bridge baseline required");
        notify();
        return {
          accepted: false,
          reason: "baseline-required",
          receivedRevision: snapshot.snapshotRevision,
        };
      }
      if (lastRevision !== undefined && snapshot.snapshotRevision <= lastRevision) {
        return {
          accepted: false,
          reason: "stale-revision",
          receivedRevision: snapshot.snapshotRevision,
        };
      }
      if (!snapshot.baseline && lastRevision !== undefined && snapshot.snapshotRevision !== lastRevision + 1) {
        currentState = "stale";
        clearReferences("service bridge revision gap");
        hasBaseline = false;
        notify();
        return {
          accepted: false,
          reason: "revision-gap",
          expectedRevision: lastRevision + 1,
          receivedRevision: snapshot.snapshotRevision,
        };
      }

      const next = new Map<string, RemoteServiceReference>();
      for (const reference of snapshot.services) {
        // 目录包也必须自洽；不能让一条伪造的 entry 借当前握手身份
        // 把代理指向另一条 authority，或借旧 revision 混入当前快照。
        // 不自洽的条目按 fail-closed 处理：忽略它，而不是猜测兼容版本。
        if (
          reference.authorityInstanceId !== currentAuthorityInstanceId
          || reference.snapshotRevision !== snapshot.snapshotRevision
        ) continue;
        next.set(referenceKey(reference), Object.freeze({ ...reference }));
      }
      references.clear();
      for (const [key, reference] of next) references.set(key, reference);
      const validKeys = new Set(
        [...next.values()]
          .filter((reference) => reference.status === "ready")
          .map(referenceKey)
      );
      invalidateProxies("remote service reference is no longer ready", validKeys);
      lastRevision = snapshot.snapshotRevision;
      hasBaseline = true;
      currentState = "ready";
      notify();
      return {
        accepted: true,
        state: currentState,
        snapshotRevision: snapshot.snapshotRevision,
      };
    },
    getProxy(lookup: RemoteServiceLookup, scope?: LifecycleScope): RemoteServiceProxy | undefined {
      if (currentState !== "ready") return undefined;
      const matches = [...references.values()].filter((candidate) => lookupMatches(candidate, lookup));
      if (matches.length > 1) {
        throw new RemoteServiceUnavailableError(
          `Service reference is ambiguous for "${lookup.capabilityId}" version "${lookup.contractVersion}"`
        );
      }
      const reference = matches[0];
      if (!reference) return undefined;
      const record: ProxyRecord = {
        reference,
        revoked: false,
        reason: "remote service proxy revoked",
        controller: new AbortController(),
      };
      proxies.add(record);
      let removeScopeRevoke: (() => void) | undefined;
      let removeScopeDispose: (() => void) | undefined;
      let proxy: RemoteServiceProxy;
      const revokeFromScope = (reason: string) => {
        revokeProxy(record, reason);
        proxies.delete(record);
        removeScopeRevoke?.();
        removeScopeDispose?.();
      };
      if (scope) {
        try {
          removeScopeRevoke = scope.onRevoke(revokeFromScope);
          removeScopeDispose = scope.onDispose(revokeFromScope, `service-proxy:${reference.capabilityId}`);
        } catch {
          record.revoked = true;
        }
      }
      if (record.revoked) {
        proxies.delete(record);
        removeScopeRevoke?.();
        removeScopeDispose?.();
        return undefined;
      }
      proxy = {
        reference,
        get revoked() {
          return record.revoked;
        },
        async call<TRequest, TResult>(
          request: TRequest,
          callOptions: { signal?: AbortSignal; operationId?: string; requestId?: string } = {}
        ) {
          if (record.revoked) throw new RemoteServiceUnavailableError(record.reason);
          const current = references.get(referenceKey(reference));
          if (currentState !== "ready" || !current || current.status !== "ready") {
            record.revoked = true;
            record.reason = "Remote service reference is no longer ready";
            throw new RemoteServiceUnavailableError(record.reason);
          }
          const merged = mergeSignals(scope?.signal, record.controller.signal, callOptions.signal);
          const connectionId = currentConnectionId;
          if (!connectionId) {
            merged.dispose();
            throw new RemoteServiceUnavailableError("Remote service connection is no longer active");
          }
          const context: RemoteServiceCallContext = {
            // requestId 只作为旧调用方的业务 operationId 别名；真正的
            // MessagePort callId 由传输层每次调用单独生成。
            operationId: callOptions.operationId ?? callOptions.requestId ?? makeRequestId(),
            connectionId,
            reference,
            grantId: reference.grantId,
            signal: merged.signal,
          };
          let result: Promise<TResult>;
          try {
            result = Promise.resolve(options.transport.call<TRequest, TResult>(request, context));
          } catch (error) {
            merged.dispose();
            throw error;
          }
          try {
            const value = await Promise.race([
              result,
              new Promise<TResult>((_, reject) => {
                if (merged.signal.aborted) {
                  reject(merged.signal.reason ?? new RemoteServiceUnavailableError("Remote service request aborted"));
                  return;
                }
                const onAbort = () => reject(merged.signal.reason ?? new RemoteServiceUnavailableError("Remote service request aborted"));
                merged.signal.addEventListener("abort", onAbort, { once: true });
                result.finally(() => merged.signal.removeEventListener("abort", onAbort)).catch(() => undefined);
              }),
            ]);
            if (record.revoked || currentState !== "ready" || references.get(referenceKey(reference))?.status !== "ready") {
              throw new RemoteServiceUnavailableError("Remote service request belongs to an invalidated proxy");
            }
            return value;
          } finally {
            merged.dispose();
            // 代理被撤销后保留在集合中没有安全意义，避免长期增长；撤销
            // 本身已经不可逆，因此不会被未来同名服务复用。
            if (record.revoked) {
              proxies.delete(record);
              removeScopeRevoke?.();
              removeScopeDispose?.();
            }
          }
        },
        revoke(reason = "remote service proxy revoked") {
          revokeProxy(record, reason);
          proxies.delete(record);
          removeScopeRevoke?.();
          removeScopeDispose?.();
        },
      };
      return proxy;
    },
    requireProxy(lookup: RemoteServiceLookup, scope?: LifecycleScope): RemoteServiceProxy {
      const proxy = bridge.getProxy(lookup, scope);
      if (!proxy) {
        throw new RemoteServiceUnavailableError(
          `Service "${lookup.capabilityId}" version "${lookup.contractVersion}" is not ready`
        );
      }
      return proxy;
    },
    invalidate(reason = "remote service bridge invalidated") {
      clearReferences(reason);
      currentState = "stale";
      lastRevision = undefined;
      hasBaseline = false;
      notify();
    },
    disconnect(reason = "remote service connection disconnected") {
      clearReferences(reason);
      currentConnectionId = undefined;
      currentAuthorityInstanceId = undefined;
      lastRevision = undefined;
      hasBaseline = false;
      currentState = "disconnected";
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    services() {
      return [...references.values()];
    },
  };

  return bridge;
}

/** 兼容“服务桥 / 远程服务桥”两种调用语义；实现仍只有一套。 */
export const createRemoteServiceBridge = createServiceBridge;
