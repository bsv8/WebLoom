// Worker / 页面升级接管门禁。
//
// 这是一个本地写入栅栏，不是 leader 选举器，也不是跨 Worker 调度器：
// - handshake 只校验协议、构建、接管世代和精确契约版本；
// - active 期间才发放新的 I/O 租约；
// - beginDrain 同步关闭新入口，已有 I/O 可以继续排空；
// - drain 超时返回未排空，调用方不能据此开放下一代写入。
//
// 真正的存储 / 签名服务仍必须在最终边界重复校验 authorityInstanceId 和
// handoverGeneration。这个模块只能提供可复用的接管语义，不能替代服务端校验。

import type {
  CreateUpgradeGateOptions,
  UpgradeDrainResult,
  UpgradeGate,
  UpgradeGateState,
  UpgradeHandshake,
  UpgradeHandshakeResult,
  UpgradeIoLease,
  UpgradeSession,
} from "../contracts/lifecycle.js";
import { UpgradeGateRejectedError } from "../contracts/lifecycle.js";

interface LeaseRecord {
  session: SessionRecord;
  operation: "read" | "write";
  controller: AbortController;
  revoked: boolean;
  reason: string;
  removeExternalAbort?: () => void;
}

interface SessionRecord {
  sessionId: string;
  connectionId: string;
  contractVersion: string;
  controller: AbortController;
  revoked: boolean;
  reason: string;
  leases: Set<LeaseRecord>;
  session?: UpgradeSession;
}

function validGeneration(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}

function makeSessionId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return `upgrade-session:${crypto.randomUUID()}`;
    }
  } catch {
    // 会话标识用于防止误绑定；真正的授权仍由握手和最终边界校验。
  }
  return `upgrade-session:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
}

function buildIsCompatible(options: CreateUpgradeGateOptions, buildId: string): boolean {
  try {
    if (options.isBuildCompatible) return options.isBuildCompatible(buildId);
  } catch {
    return false;
  }
  return buildId === options.buildId || options.compatibleBuildIds?.has(buildId) === true;
}

/** 创建一个绑定当前构建和接管世代的升级门禁。 */
export function createUpgradeGate(options: CreateUpgradeGateOptions): UpgradeGate {
  if (!options.protocolVersion || !options.buildId || !options.authorityInstanceId) {
    throw new Error("升级门禁的 protocolVersion、buildId 和 authorityInstanceId 必须有效");
  }
  if (!validGeneration(options.handoverGeneration)) {
    throw new Error("升级门禁的 handoverGeneration 必须是非负安全整数");
  }
  const contractVersions = uniqueStrings(options.supportedContractVersions);
  if (contractVersions.length === 0) {
    throw new Error("升级门禁至少需要一个 supportedContractVersions");
  }

  let currentState: UpgradeGateState = "active";
  let closeReason = "upgrade gate closed";
  const leases = new Set<LeaseRecord>();
  const sessions = new Set<SessionRecord>();
  const sessionByObject = new WeakMap<UpgradeSession, SessionRecord>();
  const emptyWaiters = new Set<() => void>();

  const notifyEmpty = () => {
    if (leases.size !== 0) return;
    for (const resolve of [...emptyWaiters]) {
      emptyWaiters.delete(resolve);
      resolve();
    }
  };

  const removeLease = (record: LeaseRecord) => {
    if (!leases.delete(record)) return;
    record.session.leases.delete(record);
    record.removeExternalAbort?.();
    record.removeExternalAbort = undefined;
    notifyEmpty();
  };

  const revokeSession = (record: SessionRecord, reason: string) => {
    if (record.revoked) return;
    record.revoked = true;
    record.reason = reason;
    try {
      record.controller.abort(new UpgradeGateRejectedError(reason));
    } catch {
      record.controller.abort();
    }
    for (const lease of [...record.leases]) revokeLease(lease, reason);
    sessions.delete(record);
  };

  const revokeLease = (record: LeaseRecord, reason: string) => {
    if (record.revoked) return;
    record.revoked = true;
    record.reason = reason;
    try {
      record.controller.abort(new UpgradeGateRejectedError(reason));
    } catch {
      record.controller.abort();
    }
    removeLease(record);
  };

  const assertAccepting = () => {
    if (currentState === "active") return;
    throw new UpgradeGateRejectedError(currentState === "draining" ? "draining" : "closed", closeReason);
  };

  const handshake = (input: UpgradeHandshake): UpgradeHandshakeResult => {
    if (currentState !== "active") {
      return { accepted: false, reason: currentState === "draining" ? "draining" : "closed" };
    }
    if (
      typeof input.connectionId !== "string"
      || input.connectionId.length === 0
      || input.protocolVersion !== options.protocolVersion
      || typeof input.protocolVersion !== "string"
      || typeof input.buildId !== "string"
      || typeof input.authorityInstanceId !== "string"
      || input.authorityInstanceId.length === 0
    ) {
      return { accepted: false, reason: "protocol-mismatch" };
    }
    if (!buildIsCompatible(options, input.buildId)) {
      return { accepted: false, reason: "build-incompatible" };
    }
    if (!validGeneration(input.handoverGeneration)) {
      return { accepted: false, reason: "stale-generation" };
    }
    if (input.handoverGeneration < options.handoverGeneration) {
      return { accepted: false, reason: "stale-generation" };
    }
    if (input.handoverGeneration > options.handoverGeneration) {
      return { accepted: false, reason: "future-generation" };
    }
    const contractVersion = contractVersions.find((version) => input.supportedContractVersions.includes(version));
    if (!contractVersion) return { accepted: false, reason: "contract-mismatch" };
    const sessionRecord: SessionRecord = {
      sessionId: makeSessionId(),
      connectionId: input.connectionId,
      contractVersion,
      controller: new AbortController(),
      revoked: false,
      reason: "upgrade session closed",
      leases: new Set(),
    };
    const session: UpgradeSession = {
      connectionId: sessionRecord.connectionId,
      sessionId: sessionRecord.sessionId,
      authorityInstanceId: options.authorityInstanceId,
      handoverGeneration: options.handoverGeneration,
      contractVersion,
      get revoked() {
        return sessionRecord.revoked || !sessions.has(sessionRecord);
      },
      signal: sessionRecord.controller.signal,
      assertActive() {
        if (sessionRecord.revoked || !sessions.has(sessionRecord)) {
          throw new UpgradeGateRejectedError(sessionRecord.reason, "升级握手会话已失效");
        }
        if (currentState === "closed") {
          throw new UpgradeGateRejectedError("closed", closeReason);
        }
      },
      admit(input) {
        return admitForSession(sessionRecord, input);
      },
      close(reason = "upgrade session closed") {
        revokeSession(sessionRecord, reason);
      },
    };
    sessionRecord.session = session;
    sessions.add(sessionRecord);
    sessionByObject.set(session, sessionRecord);
    return {
      accepted: true,
      mode: options.mode ?? "cold-switch",
      handoverGeneration: options.handoverGeneration,
      contractVersion,
      connectionId: sessionRecord.connectionId,
      sessionId: sessionRecord.sessionId,
      session,
    };
  };

  const admitForSession = (
    sessionRecord: SessionRecord,
    input: { operation: "read" | "write"; signal?: AbortSignal }
  ): UpgradeIoLease => {
    if (sessionRecord.revoked || !sessions.has(sessionRecord)) {
      throw new UpgradeGateRejectedError(sessionRecord.reason, "升级握手会话已失效");
    }
    assertAccepting();
    if (input.signal?.aborted) {
      throw new UpgradeGateRejectedError("caller-aborted", "I/O 在取得接管租约前已取消");
    }

    const record: LeaseRecord = {
      session: sessionRecord,
      operation: input.operation,
      controller: new AbortController(),
      revoked: false,
      reason: "upgrade I/O lease released",
    };
    leases.add(record);
    sessionRecord.leases.add(record);
    if (input.signal) {
      const onAbort = () => revokeLease(record, "caller-aborted");
      input.signal.addEventListener("abort", onAbort, { once: true });
      record.removeExternalAbort = () => input.signal?.removeEventListener("abort", onAbort);
    }

    const lease: UpgradeIoLease = {
      connectionId: sessionRecord.connectionId,
      sessionId: sessionRecord.sessionId,
      authorityInstanceId: options.authorityInstanceId,
      handoverGeneration: options.handoverGeneration,
      contractVersion: sessionRecord.contractVersion,
      operation: record.operation,
      get revoked() {
        return record.revoked || !leases.has(record);
      },
      signal: record.controller.signal,
      assertActive() {
        if (record.revoked || !leases.has(record)) {
          throw new UpgradeGateRejectedError(record.reason, "升级 I/O 租约已失效");
        }
        // beginDrain 不撤销已发租约；它只阻止新 I/O，给已提交操作一个排空窗口。
        if (currentState === "closed") {
          throw new UpgradeGateRejectedError("closed", closeReason);
        }
      },
      release() {
        if (record.revoked) return;
        record.revoked = true;
        record.reason = "upgrade I/O lease released";
        removeLease(record);
      },
    };
    return lease;
  };

  const admit = (input: Parameters<UpgradeGate["admit"]>[0]): UpgradeIoLease => {
    const sessionRecord = sessionByObject.get(input.session);
    if (!sessionRecord) {
      throw new UpgradeGateRejectedError("invalid-session", "I/O 必须使用当前门禁握手返回的会话");
    }
    return admitForSession(sessionRecord, input);
  };

  const beginDrain = (reason = "upgrade handover draining") => {
    if (currentState !== "active") return;
    closeReason = reason;
    currentState = "draining";
  };

  const drain = async (timeoutMs?: number): Promise<UpgradeDrainResult> => {
    beginDrain();
    if (leases.size === 0) return { state: currentState, drained: true, pending: 0 };
    if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 0)) {
      throw new Error("升级排空 timeoutMs 必须是非负有限数");
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let timerResolve: (() => void) | undefined;
    const empty = new Promise<void>((resolve) => {
      emptyWaiters.add(resolve);
      timerResolve = resolve;
    });
    const timeoutPromise = timeoutMs === undefined
      ? undefined
      : new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, timeoutMs);
        });
    if (timeoutPromise) await Promise.race([empty, timeoutPromise]);
    else await empty;
    if (timeout !== undefined) clearTimeout(timeout);
    if (timerResolve) emptyWaiters.delete(timerResolve);
    const pending = leases.size;
    return { state: currentState, drained: pending === 0, pending };
  };

  const close = (reason = "upgrade gate closed") => {
    if (currentState === "closed") return;
    closeReason = reason;
    currentState = "closed";
    for (const session of [...sessions]) revokeSession(session, reason);
    for (const lease of [...leases]) revokeLease(lease, reason);
    notifyEmpty();
  };

  return {
    get state() { return currentState; },
    mode: options.mode ?? "cold-switch",
    authorityInstanceId: options.authorityInstanceId,
    handoverGeneration: options.handoverGeneration,
    handshake,
    assertAccepting,
    admit,
    beginDrain,
    drain,
    close,
    activeIo: () => leases.size,
  };
}
