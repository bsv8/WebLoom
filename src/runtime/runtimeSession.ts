// WebLoom 物理 endpoint 的通用 session 生命周期。
//
// 这个模块只管理“哪条连接、当前是否还准入、是否已经排空”。它不理解
// 产品 lease、存储 owner、领域 session 或 CAS；那些仍属于产品层。

import type {
  RuntimeDrainResult,
  RuntimeEndpointBinding,
  RuntimeEndpointState,
} from "../contracts/lifecycle.js";

/** 关闭握手默认等待时间；调用方可以传入更严格的 deadline。 */
export const DEFAULT_RUNTIME_DRAIN_TIMEOUT_MS = 2_000;

/** 一个需要等待真实执行槽结束的框架参与者。 */
export interface RuntimeDrainParticipant {
  /** 等待该参与者自己的真实执行槽结束。 */
  readonly drain: () => Promise<void>;
  /** deadline 到达时报告仍未结束的真实执行槽数量。 */
  readonly pending: () => number;
}

export interface RuntimeEndpointSession {
  /** 本端由框架生成、不可复用的 endpoint 身份。 */
  readonly binding: RuntimeEndpointBinding;
  /** 已由对端首条合法框架消息建立的身份；尚未建立时为空。 */
  readonly remoteBinding?: RuntimeEndpointBinding;
  /** active -> closing -> closed。 */
  readonly state: RuntimeEndpointState;
  /** 最近一次同步关闭原因；只用于本地诊断。 */
  readonly closeReason?: string;
  /** 本端允许的最大 drain 时间；远端只能进一步收紧，不能扩大。 */
  readonly maxDrainTimeoutMs: number;
  /** 精确比较并建立对端 binding；不接受后续替换。 */
  acceptRemoteBinding(binding: unknown): boolean;
  /** 同步停止准入、触发撤权和 abort；幂等。 */
  beginClose(reason?: string): void;
  /** 等待全部参与者排空，始终受 bounded deadline 限制。 */
  drain(timeoutMs?: number): Promise<RuntimeDrainResult>;
  /** 物理 transport 即将关闭时标记终态；幂等。 */
  close(): void;
  /** 注册同步关闭回调。 */
  onBeginClose(listener: (reason: string) => void): () => void;
  /** 注册物理关闭回调。 */
  onClosed(listener: () => void): () => void;
  /** 注册一个真实执行排空参与者。 */
  registerDrainParticipant(participant: RuntimeDrainParticipant): () => void;
}

function validText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

/** 判断值是否为完整的框架 endpoint binding。 */
export function isRuntimeEndpointBinding(value: unknown): value is RuntimeEndpointBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as { runtimeInstanceId?: unknown; connectionId?: unknown };
  return validText(candidate.runtimeInstanceId) && validText(candidate.connectionId);
}

/** 只比较框架 binding，不比较任何产品领域字段。 */
export function sameRuntimeEndpointBinding(
  left: RuntimeEndpointBinding | undefined,
  right: RuntimeEndpointBinding | undefined,
): boolean {
  return left !== undefined && right !== undefined
    && left.runtimeInstanceId === right.runtimeInstanceId
    && left.connectionId === right.connectionId;
}

function copyBinding(value: RuntimeEndpointBinding): RuntimeEndpointBinding {
  return Object.freeze({ runtimeInstanceId: value.runtimeInstanceId, connectionId: value.connectionId });
}

/** 为一个 Runtime endpoint 生成不可复用的连接身份。 */
export function createRuntimeEndpointBinding(runtimeInstanceId: string): RuntimeEndpointBinding {
  let connectionId: string;
  try {
    connectionId = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? `connection:${crypto.randomUUID()}`
      : `connection:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
  } catch {
    connectionId = `connection:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
  }
  if (!validText(runtimeInstanceId)) throw new TypeError("Runtime endpoint requires a valid runtimeInstanceId");
  return copyBinding({ runtimeInstanceId, connectionId });
}

/** 创建一条由 Runtime/transport 共用的 endpoint session。 */
export function createRuntimeEndpointSession(
  binding: RuntimeEndpointBinding,
  options: { readonly defaultDrainTimeoutMs?: number } = {},
): RuntimeEndpointSession {
  if (!isRuntimeEndpointBinding(binding)) throw new TypeError("Runtime endpoint binding is invalid");
  const localBinding = copyBinding(binding);
  const beginCloseListeners = new Set<(reason: string) => void>();
  const closedListeners = new Set<() => void>();
  const participants = new Set<RuntimeDrainParticipant>();
  const defaultTimeout = options.defaultDrainTimeoutMs ?? DEFAULT_RUNTIME_DRAIN_TIMEOUT_MS;
  if (!Number.isFinite(defaultTimeout) || defaultTimeout < 1 || defaultTimeout > 300_000) {
    throw new TypeError("defaultDrainTimeoutMs must be a finite number from 1 to 300000");
  }
  let state: RuntimeEndpointState = "active";
  let remoteBindingValue: RuntimeEndpointBinding | undefined;
  let closeReasonValue: string | undefined;
  let drainPromise: Promise<RuntimeDrainResult> | undefined;

  const session: RuntimeEndpointSession = {
    binding: localBinding,
    maxDrainTimeoutMs: defaultTimeout,
    get remoteBinding() { return remoteBindingValue; },
    get state() { return state; },
    get closeReason() { return closeReasonValue; },
    acceptRemoteBinding(value: unknown): boolean {
      if (!isRuntimeEndpointBinding(value) || state === "closed") return false;
      const next = copyBinding(value);
      if (remoteBindingValue === undefined) {
        remoteBindingValue = next;
        return true;
      }
      return sameRuntimeEndpointBinding(remoteBindingValue, next);
    },
    beginClose(reason = "Runtime endpoint closing"): void {
      if (state !== "active") return;
      state = "closing";
      closeReasonValue = reason.slice(0, 256);
      for (const listener of [...beginCloseListeners]) {
        try { listener(closeReasonValue); } catch { /* observer isolation */ }
      }
    },
    drain(timeoutMs = defaultTimeout): Promise<RuntimeDrainResult> {
      if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
        return Promise.reject(new TypeError("drain timeoutMs must be a finite number from 1 to 300000"));
      }
      if (drainPromise) return drainPromise;
      // A physical close is not proof that non-cooperative JavaScript has
      // stopped.  Preserve the live participant count instead of fabricating
      // a successful drain after the transport has disappeared.
      const currentParticipants = [...participants];
      if (state === "closed") {
        const pendingExecutions = currentParticipants.reduce((total, participant) => {
          try { return total + Math.max(0, participant.pending()); } catch { return total; }
        }, 0);
        const result: RuntimeDrainResult = {
          state,
          drained: pendingExecutions === 0,
          timedOut: pendingExecutions !== 0,
          pendingExecutions,
        };
        drainPromise = Promise.resolve(result);
        return drainPromise;
      }
      if (state === "active") session.beginClose("Runtime endpoint drain requested");
      drainPromise = new Promise<RuntimeDrainResult>((resolve) => {
        let settled = false;
        const settle = (timedOut: boolean, failed: boolean): void => {
          if (settled) return;
          settled = true;
          if (timer !== undefined) clearTimeout(timer);
          const pendingExecutions = currentParticipants.reduce((total, participant) => {
            try { return total + Math.max(0, participant.pending()); } catch { return total; }
          }, 0);
          resolve({ state, drained: !timedOut && !failed && pendingExecutions === 0, timedOut, pendingExecutions });
        };
        const effectiveTimeout = Math.min(timeoutMs, defaultTimeout);
        const timer = setTimeout(() => settle(true, false), effectiveTimeout);
        void Promise.allSettled(currentParticipants.map((participant) => {
          try { return participant.drain(); } catch (error) { return Promise.reject(error); }
        })).then((results) => settle(false, results.some((result) => result.status === "rejected")));
      });
      return drainPromise;
    },
    close(): void {
      if (state === "closed") return;
      if (state === "active") session.beginClose("Runtime endpoint physically closed");
      state = "closed";
      for (const listener of [...closedListeners]) {
        try { listener(); } catch { /* observer isolation */ }
      }
      beginCloseListeners.clear();
      closedListeners.clear();
    },
    onBeginClose(listener) {
      if (state !== "active") {
        try { listener(closeReasonValue ?? "Runtime endpoint closing"); } catch { /* observer isolation */ }
        return () => undefined;
      }
      beginCloseListeners.add(listener);
      return () => beginCloseListeners.delete(listener);
    },
    onClosed(listener) {
      if (state === "closed") {
        try { listener(); } catch { /* observer isolation */ }
        return () => undefined;
      }
      closedListeners.add(listener);
      return () => closedListeners.delete(listener);
    },
    registerDrainParticipant(participant) {
      if (state === "closed") return () => undefined;
      participants.add(participant);
      return () => participants.delete(participant);
    },
  };
  return session;
}
