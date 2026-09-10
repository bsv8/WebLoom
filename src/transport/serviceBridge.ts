// 跨 Worker 服务桥的 WebLoom v2 实现。
//
// capability() / getProxy() 只创建惰性代理。第一次 call() 在同一个总
// deadline 内等待完整目录和远端执行；绑定成功后代理永久固定到一份
// runtimeInstanceId + serviceInstanceId，目录替换、断线和 Runtime 重启只会
// 撤销它，绝不静默换绑。

import type {
  LifecycleScope,
  RemoteServiceBridge,
  RemoteServiceCallContext,
  RemoteServiceCallOptions,
  RemoteServiceErrorCode,
  RemoteServiceLookup,
  RemoteServiceProxy,
  RemoteServiceReference,
  RemoteServiceSnapshot,
  RemoteServiceSnapshotResult,
  RemoteServiceTransport,
} from "../contracts/lifecycle.js";
import {
  RemoteServiceError,
} from "../contracts/lifecycle.js";

export interface CreateServiceBridgeOptions {
  /** 要接受的精确服务协议版本。 */
  protocolVersion: string;
  /** 实际端口 RPC 传输；桥不负责重放请求。 */
  transport: RemoteServiceTransport;
  /** 默认总 deadline；必须有限且大于零。 */
  defaultCallTimeoutMs?: number;
}

interface ProxyRecord {
  boundReference?: RemoteServiceReference;
  revoked: boolean;
  reason: string;
  controller: AbortController;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isSafeAttributeValue(value: unknown, seen: Set<object>): boolean {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const valid = Array.isArray(value)
    ? value.every((item) => isSafeAttributeValue(item, seen))
    : isPlainRecord(value)
      && !Reflect.ownKeys(value).some((key) => typeof key !== "string")
      && Object.values(value).every((item) => isSafeAttributeValue(item, seen));
  seen.delete(value);
  return valid;
}

function isValidAttributes(value: unknown): value is Readonly<Record<string, unknown>> {
  return isPlainRecord(value) && isSafeAttributeValue(value, new Set<object>());
}

function isValidSnapshot(snapshot: RemoteServiceSnapshot): boolean {
  if (!snapshot || typeof snapshot !== "object"
    || typeof snapshot.protocolVersion !== "string"
    || snapshot.protocolVersion.length === 0
    || typeof snapshot.runtimeInstanceId !== "string"
    || snapshot.runtimeInstanceId.length === 0
    || !Number.isSafeInteger(snapshot.revision)
    || snapshot.revision < 0
    || !Array.isArray(snapshot.services)) return false;
  if (snapshot.runtimeId !== undefined && (typeof snapshot.runtimeId !== "string" || snapshot.runtimeId.length === 0)) return false;
  if (snapshot.runtimeKind !== undefined && snapshot.runtimeKind !== "window-main" && snapshot.runtimeKind !== "shared-worker") return false;
  if (snapshot.state !== undefined
    && snapshot.state !== "starting"
    && snapshot.state !== "ready"
    && snapshot.state !== "stopping"
    && snapshot.state !== "failed"
    && snapshot.state !== "disposed") return false;

  const bindingKeys = new Set<string>();
  const serviceCapabilityKeys = new Set<string>();
  const readyLookupKeys = new Set<string>();
  for (const service of snapshot.services) {
    if (!service || typeof service !== "object"
      || typeof service.capabilityId !== "string" || service.capabilityId.length === 0
      || typeof service.contractVersion !== "string" || service.contractVersion.length === 0
      || (service.runtime !== "window-main" && service.runtime !== "shared-worker")
      || service.runtimeInstanceId !== snapshot.runtimeInstanceId
      || typeof service.serviceInstanceId !== "string" || service.serviceInstanceId.length === 0
      || (service.status !== "starting" && service.status !== "ready" && service.status !== "unavailable" && service.status !== "failed")
      || !isValidAttributes(service.attributes)
      || (service.grantId !== undefined && (typeof service.grantId !== "string" || service.grantId.length === 0))
      || (service.authorizationRevision !== undefined
        && (!Number.isSafeInteger(service.authorizationRevision) || service.authorizationRevision < 0))) return false;
    if (snapshot.runtimeKind !== undefined && service.runtime !== snapshot.runtimeKind) return false;

    const key = bindingKey(service);
    if (bindingKeys.has(key)) return false;
    bindingKeys.add(key);
    const serviceCapabilityKey = `${service.capabilityId}\u0000${service.serviceInstanceId}`;
    if (serviceCapabilityKeys.has(serviceCapabilityKey)) return false;
    serviceCapabilityKeys.add(serviceCapabilityKey);
    if (service.status === "ready") {
      const lookupKey = `${service.capabilityId}\u0000${service.contractVersion}\u0000${service.runtime}`;
      if (readyLookupKeys.has(lookupKey)) return false;
      readyLookupKeys.add(lookupKey);
    }
  }
  return true;
}

function referenceKey(reference: RemoteServiceReference): string {
  return [
    reference.capabilityId,
    reference.contractVersion,
    reference.runtime,
    reference.runtimeInstanceId,
    reference.serviceInstanceId,
    reference.status,
    stableAttributes(reference.attributes),
    reference.grantId ?? "null",
    reference.authorizationRevision ?? "null",
  ].join("\u0000");
}

function bindingKey(reference: RemoteServiceReference): string {
  return [
    reference.capabilityId,
    reference.contractVersion,
    reference.runtime,
    reference.runtimeInstanceId,
    reference.serviceInstanceId,
  ].join("\u0000");
}

function lookupMatches(reference: RemoteServiceReference, lookup: RemoteServiceLookup): boolean {
  return reference.capabilityId === lookup.capabilityId
    && reference.contractVersion === lookup.contractVersion
    && (lookup.runtime === undefined || reference.runtime === lookup.runtime);
}

function ensureTimeout(value: number | undefined, label: string): number {
  const timeout = value ?? 30_000;
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new TypeError(`${label} must be a finite number greater than zero`);
  }
  return timeout;
}

function mergeSignals(...signals: Array<AbortSignal | undefined>): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const active = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (active.length === 0) return { signal: new AbortController().signal, dispose: () => undefined };
  const alreadyAborted = active.find((signal) => signal.aborted);
  if (alreadyAborted) {
    const controller = new AbortController();
    controller.abort(alreadyAborted.reason);
    return { signal: controller.signal, dispose: () => undefined };
  }
  const controller = new AbortController();
  const listeners = active.map((signal) => {
    const listener = () => {
      try { controller.abort(signal.reason); } catch { controller.abort(); }
    };
    signal.addEventListener("abort", listener, { once: true });
    return { signal, listener };
  });
  return {
    signal: controller.signal,
    dispose: () => {
      for (const { signal, listener } of listeners) signal.removeEventListener("abort", listener);
    },
  };
}

function abortedError(signal: AbortSignal, fallback: RemoteServiceErrorCode = "request_cancelled"): Error {
  const reason = signal.reason;
  if (reason instanceof Error && typeof (reason as Error & { code?: unknown }).code === "string") return reason;
  if (reason instanceof Error && fallback === "request_cancelled") {
    return new RemoteServiceError("request_cancelled", reason.message);
  }
  return new RemoteServiceError(fallback, fallback === "call_timeout" ? "Remote service call timed out" : "Remote service request was cancelled");
}

function callTimeoutError(timeoutMs: number): RemoteServiceError {
  return new RemoteServiceError("call_timeout", `Remote service call exceeded its ${timeoutMs}ms deadline`, { timeoutMs });
}

/** 创建一个无连接握手、无增量 revision 状态机的服务桥。 */
export function createServiceBridge(options: CreateServiceBridgeOptions): RemoteServiceBridge {
  const defaultCallTimeoutMs = ensureTimeout(options.defaultCallTimeoutMs, "defaultCallTimeoutMs");
  let currentState: RemoteServiceBridge["state"] = "empty";
  let currentRuntimeInstanceId: string | undefined;
  let currentRevision: number | undefined;
  let currentServices: readonly RemoteServiceReference[] = [];
  let terminalError: RemoteServiceError | undefined;
  const proxies = new Set<ProxyRecord>();
  const listeners = new Set<() => void>();

  const notify = (): void => {
    for (const listener of [...listeners]) {
      try { listener(); } catch { /* 观察者不能阻断撤权 */ }
    }
  };

  const revokeProxy = (record: ProxyRecord, reason: string, code: RemoteServiceErrorCode = "service_revoked"): void => {
    if (record.revoked) return;
    record.revoked = true;
    record.reason = reason;
    try { record.controller.abort(new RemoteServiceError(code, reason)); } catch { record.controller.abort(); }
  };

  const revokeAll = (reason: string, code: RemoteServiceErrorCode = "service_revoked"): void => {
    for (const record of proxies) revokeProxy(record, reason, code);
  };

  const currentMatches = (lookup: RemoteServiceLookup): RemoteServiceReference[] => (
    currentServices.filter((reference) => reference.status === "ready" && lookupMatches(reference, lookup))
  );

  const findBinding = (record: ProxyRecord, lookup: RemoteServiceLookup): RemoteServiceReference | undefined => {
    if (record.boundReference) return record.boundReference;
    if (terminalError) throw terminalError;
    const matches = currentMatches(lookup);
    if (matches.length > 1) {
      throw new RemoteServiceError(
        "capability_unavailable",
        `Service "${lookup.capabilityId}" version "${lookup.contractVersion}" has multiple ready instances`,
      );
    }
    const reference = matches[0];
    if (reference) {
      record.boundReference = Object.freeze({
        ...reference,
        attributes: Object.freeze({ ...reference.attributes }),
      });
      return record.boundReference;
    }
    return undefined;
  };

  const waitForBinding = (
    record: ProxyRecord,
    lookup: RemoteServiceLookup,
    signal: AbortSignal,
  ): Promise<RemoteServiceReference> => {
    const immediate = findBinding(record, lookup);
    if (immediate) return Promise.resolve(immediate);
    if (record.revoked) return Promise.reject(new RemoteServiceError("service_revoked", record.reason));
    if (signal.aborted) return Promise.reject(abortedError(signal));

    return new Promise<RemoteServiceReference>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        removeListener();
        callback();
      };
      const check = (): void => {
        if (record.revoked) {
          finish(() => reject(new RemoteServiceError("service_revoked", record.reason)));
          return;
        }
        if (signal.aborted) {
          finish(() => reject(abortedError(signal)));
          return;
        }
        try {
          const reference = findBinding(record, lookup);
          if (reference) finish(() => resolve(reference));
        } catch (error) {
          finish(() => reject(error));
        }
      };
      const onAbort = () => check();
      const listener = () => check();
      const removeListener = (): void => {
        signal.removeEventListener("abort", onAbort);
        listeners.delete(listener);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      listeners.add(listener);
      check();
    });
  };

  const bridge: RemoteServiceBridge = {
    get state() { return currentState; },
    get runtimeInstanceId() { return currentRuntimeInstanceId; },
    get defaultCallTimeoutMs() { return defaultCallTimeoutMs; },
    applySnapshot(snapshot: RemoteServiceSnapshot): RemoteServiceSnapshotResult {
      if (currentState === "disposed") return { accepted: false, reason: "disposed" };
      if (snapshot.protocolVersion !== options.protocolVersion) {
        return { accepted: false, reason: "protocol-mismatch", receivedRevision: snapshot.revision };
      }
      // Validate the complete directory before revoking any proxy or changing
      // the current authority. A single foreign/duplicate/unsafe reference
      // therefore cannot cause a partial state transition.
      if (!isValidSnapshot(snapshot)) {
        return { accepted: false, reason: "invalid-snapshot", receivedRevision: snapshot.revision };
      }
      if (currentRuntimeInstanceId === snapshot.runtimeInstanceId
        && currentRevision !== undefined
        && snapshot.revision <= currentRevision) {
        return { accepted: false, reason: "stale-revision", receivedRevision: snapshot.revision };
      }

      const runtimeChanged = currentRuntimeInstanceId !== undefined
        && currentRuntimeInstanceId !== snapshot.runtimeInstanceId;
      if (runtimeChanged) revokeAll("Runtime instance changed; proxy cannot be rebound", "service_stale");

      const nextServices = snapshot.services.map((service) => Object.freeze({
        ...service,
        attributes: Object.freeze({ ...service.attributes }),
      }));
      const nextReady = new Map(nextServices
        .filter((service) => service.status === "ready")
        .map((service) => [bindingKey(service), service] as const));
      if (!runtimeChanged) {
        for (const record of proxies) {
          const bound = record.boundReference;
          if (!bound) continue;
          const replacement = nextReady.get(bindingKey(bound));
          if (!replacement || referenceKey(replacement) !== referenceKey(bound)) {
            revokeProxy(record, "Bound service instance was replaced or revoked", "service_revoked");
          }
        }
      }

      currentRuntimeInstanceId = snapshot.runtimeInstanceId;
      currentRevision = snapshot.revision;
      currentServices = Object.freeze(nextServices);
      terminalError = undefined;
      if (snapshot.state === "failed") {
        currentState = "stale";
        terminalError = new RemoteServiceError("runtime_initialization_failed", "Remote Runtime initialization failed");
      } else if (snapshot.state === "disposed" || snapshot.state === "stopping") {
        currentState = "stale";
        terminalError = new RemoteServiceError("transport_unavailable", "Remote Runtime is no longer accepting calls");
        revokeAll("Remote Runtime is no longer accepting calls", "transport_unavailable");
      } else if (snapshot.state === "ready") {
        currentState = "ready";
      } else {
        currentState = "empty";
      }
      notify();
      return { accepted: true, state: currentState, revision: snapshot.revision };
    },
    markProtocolMismatch(reason = "Remote Runtime protocol version mismatch"): void {
      if (currentState === "disposed") return;
      terminalError = new RemoteServiceError("protocol_mismatch", reason);
      revokeAll(reason, "protocol_mismatch");
      currentState = "stale";
      notify();
    },
    markInitializationFailed(reason = "Remote Runtime initialization failed"): void {
      if (currentState === "disposed") return;
      terminalError = new RemoteServiceError("runtime_initialization_failed", reason);
      revokeAll(reason, "runtime_initialization_failed");
      currentState = "stale";
      notify();
    },
    getProxy(lookup: RemoteServiceLookup, scope?: LifecycleScope): RemoteServiceProxy {
      const record: ProxyRecord = {
        revoked: false,
        reason: "Remote service proxy revoked",
        controller: new AbortController(),
      };
      proxies.add(record);
      let removeScopeRevoke: (() => void) | undefined;
      let removeScopeDispose: (() => void) | undefined;
      const revokeFromScope = (reason: string): void => {
        revokeProxy(record, reason, "service_revoked");
        proxies.delete(record);
        removeScopeRevoke?.();
        removeScopeDispose?.();
      };
      if (scope) {
        try {
          removeScopeRevoke = scope.onRevoke(revokeFromScope);
          removeScopeDispose = scope.onDispose(revokeFromScope, `service-proxy:${lookup.capabilityId}`);
        } catch {
          revokeFromScope("Remote service proxy scope is already revoked");
        }
      }
      const proxy: RemoteServiceProxy = {
        get reference() { return record.boundReference; },
        get revoked() { return record.revoked; },
        async call<TRequest, TResult>(request: TRequest, callOptions: RemoteServiceCallOptions = {}): Promise<TResult> {
          if (record.revoked) throw new RemoteServiceError("service_revoked", record.reason);
          const timeoutMs = ensureTimeout(callOptions.timeoutMs ?? defaultCallTimeoutMs, "timeoutMs");
          const deadlineAt = Date.now() + timeoutMs;
          const timeoutController = new AbortController();
          const timeout = setTimeout(() => {
            try { timeoutController.abort(callTimeoutError(timeoutMs)); } catch { timeoutController.abort(); }
          }, timeoutMs);
          const merged = mergeSignals(scope?.signal, record.controller.signal, callOptions.signal, timeoutController.signal);
          try {
            const reference = await waitForBinding(record, lookup, merged.signal);
            if (merged.signal.aborted) throw abortedError(merged.signal);
            const context: RemoteServiceCallContext = {
              operationId: callOptions.operationId ?? callOptions.requestId,
              reference,
              grantId: reference.grantId,
              signal: merged.signal,
              deadlineAt,
              timeoutMs,
            };
            let result: Promise<TResult>;
            try {
              result = Promise.resolve(options.transport.call<TRequest, TResult>(request, context));
            } catch (error) {
              throw error;
            }
            const value = await Promise.race([
              result,
              new Promise<TResult>((_, reject) => {
                if (merged.signal.aborted) {
                  reject(abortedError(merged.signal));
                  return;
                }
                const onAbort = () => reject(abortedError(merged.signal));
                merged.signal.addEventListener("abort", onAbort, { once: true });
                result.finally(() => merged.signal.removeEventListener("abort", onAbort)).catch(() => undefined);
              }),
            ]);
            if (record.revoked) throw new RemoteServiceError("service_revoked", record.reason);
            return value;
          } catch (error) {
            if (merged.signal.aborted) throw abortedError(merged.signal);
            if (error instanceof RemoteServiceError) throw error;
            throw error;
          } finally {
            clearTimeout(timeout);
            merged.dispose();
            if (record.revoked) {
              proxies.delete(record);
              removeScopeRevoke?.();
              removeScopeDispose?.();
            }
          }
        },
        revoke(reason = "Remote service proxy revoked"): void {
          revokeFromScope(reason);
        },
      };
      return proxy;
    },
    requireProxy(lookup: RemoteServiceLookup, scope?: LifecycleScope): RemoteServiceProxy {
      return bridge.getProxy(lookup, scope) as RemoteServiceProxy;
    },
    invalidate(reason = "Remote service directory invalidated"): void {
      if (currentState === "disposed") return;
      currentServices = [];
      currentRevision = undefined;
      terminalError = undefined;
      revokeAll(reason, "service_revoked");
      currentState = "stale";
      notify();
    },
    disconnect(reason = "Remote service transport disconnected"): void {
      if (currentState === "disposed") return;
      currentServices = [];
      currentRevision = undefined;
      currentRuntimeInstanceId = undefined;
      terminalError = new RemoteServiceError("transport_unavailable", reason);
      revokeAll(reason, "transport_unavailable");
      currentState = "stale";
      notify();
    },
    dispose(reason = "Remote service bridge disposed"): void {
      if (currentState === "disposed") return;
      currentServices = [];
      currentRevision = undefined;
      currentRuntimeInstanceId = undefined;
      terminalError = new RemoteServiceError("transport_unavailable", reason);
      revokeAll(reason, "transport_unavailable");
      currentState = "disposed";
      notify();
      proxies.clear();
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    services(): readonly RemoteServiceReference[] {
      return currentServices;
    },
  };
  return bridge;
}
