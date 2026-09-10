// Window <-> SharedWorker 的 WebLoom v2 运行时协议。
//
// Runtime 只发布完整快照。没有 hello、握手、baseline 或 resync 控制消息；
// 端口本身就是连接边界，服务调用则只走 call/result/error/cancel。

import type { PluginStateKind, PluginUnitState } from "../contracts/plugin.js";
import type {
  RemoteServiceMessageCodec,
  RemoteServiceReference,
  RuntimeKind,
} from "../contracts/lifecycle.js";
import { createRemoteServiceMessageCodec } from "../contracts/lifecycle.js";

export const RUNTIME_PROTOCOL_VERSION = "webloom.runtime.v2";
export const RUNTIME_SNAPSHOT_TYPE = "webloom.runtime.snapshot";
export const RUNTIME_ERROR_TYPE = "webloom.runtime.error";

export interface RuntimeErrorMessage {
  type: typeof RUNTIME_ERROR_TYPE;
  protocolVersion: string;
  code: "runtime_initialization_failed" | "protocol_mismatch" | "transport_unavailable";
  message: string;
  pluginId?: string;
  unitId?: string;
  phase?: "startup" | "snapshot";
}

export interface RuntimeSnapshot {
  type: typeof RUNTIME_SNAPSHOT_TYPE;
  protocolVersion: string;
  runtimeId: string;
  runtimeKind: RuntimeKind;
  runtimeInstanceId: string;
  revision: number;
  state: "starting" | "ready" | "stopping" | "failed" | "disposed";
  units: readonly RuntimeSnapshotUnit[];
  services: readonly RemoteServiceReference[];
}

export interface RuntimeSnapshotUnit {
  pluginId: string;
  unitId: string;
  runtime: RuntimeKind;
  instanceId?: string;
  state: PluginStateKind;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null;
}

function isNonEmptyString(input: unknown): input is string {
  return typeof input === "string" && input.length > 0;
}

function isRuntimeKind(input: unknown): input is RuntimeKind {
  return input === "window-main" || input === "shared-worker";
}

function isPluginStateKind(input: unknown): input is PluginStateKind {
  return input === "registered"
    || input === "starting"
    || input === "stopping"
    || input === "enabled"
    || input === "disabled"
    || input === "blocked"
    || input === "error-disabled"
    || input === "cleanup-pending"
    || input === "unknown";
}

function isRemoteServiceReference(input: unknown): input is RemoteServiceReference {
  if (!isRecord(input)) return false;
  const reference = input as Partial<RemoteServiceReference>;
  return isNonEmptyString(reference.capabilityId)
    && isNonEmptyString(reference.contractVersion)
    && isRuntimeKind(reference.runtime)
    && isNonEmptyString(reference.runtimeInstanceId)
    && isNonEmptyString(reference.serviceInstanceId)
    && (reference.status === "starting"
      || reference.status === "ready"
      || reference.status === "unavailable"
      || reference.status === "failed")
    && isRecord(reference.attributes)
    && !Array.isArray(reference.attributes)
    && (reference.grantId === undefined || isNonEmptyString(reference.grantId))
    && (reference.authorizationRevision === undefined
      || (Number.isSafeInteger(reference.authorizationRevision) && reference.authorizationRevision >= 0));
}

function isRuntimeSnapshotUnit(input: unknown): input is RuntimeSnapshotUnit {
  if (!isRecord(input)) return false;
  const unit = input as Partial<RuntimeSnapshotUnit>;
  return isNonEmptyString(unit.pluginId)
    && isNonEmptyString(unit.unitId)
    && isRuntimeKind(unit.runtime)
    && isPluginStateKind(unit.state)
    && (unit.instanceId === undefined || isNonEmptyString(unit.instanceId));
}

export function createRuntimeMessageCodec(): RemoteServiceMessageCodec {
  return createRemoteServiceMessageCodec({
    prefix: "webloom.runtime",
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
  });
}

/** 只验证外层结构；协议版本接受由 RuntimeHandle 单独处理。 */
export function isRuntimeSnapshot(input: unknown): input is RuntimeSnapshot {
  if (!isRecord(input)) return false;
  const message = input as Partial<RuntimeSnapshot>;
  return message.type === RUNTIME_SNAPSHOT_TYPE
    && isNonEmptyString(message.protocolVersion)
    && isNonEmptyString(message.runtimeId)
    && isRuntimeKind(message.runtimeKind)
    && isNonEmptyString(message.runtimeInstanceId)
    && Number.isSafeInteger(message.revision)
    && (message.revision as number) >= 0
    && Array.isArray(message.units)
    && message.units.every(isRuntimeSnapshotUnit)
    && Array.isArray(message.services)
    && message.services.every(isRemoteServiceReference)
    && (message.state === "starting"
      || message.state === "ready"
      || message.state === "stopping"
      || message.state === "failed"
      || message.state === "disposed");
}

export function isRuntimeSnapshotProtocol(input: RuntimeSnapshot): boolean {
  return input.protocolVersion === RUNTIME_PROTOCOL_VERSION;
}

export function isRuntimeError(input: unknown): input is RuntimeErrorMessage {
  if (!isRecord(input)) return false;
  const message = input as Partial<RuntimeErrorMessage>;
  return message.type === RUNTIME_ERROR_TYPE
    && isNonEmptyString(message.protocolVersion)
    && (message.code === "runtime_initialization_failed"
      || message.code === "protocol_mismatch"
      || message.code === "transport_unavailable")
    && isNonEmptyString(message.message)
    && (message.pluginId === undefined || isNonEmptyString(message.pluginId))
    && (message.unitId === undefined || isNonEmptyString(message.unitId))
    && (message.phase === undefined || message.phase === "startup" || message.phase === "snapshot");
}

/** 将 Host 的 PluginUnitState 映射成不会泄露领域配置的运行时快照。 */
export function unitSnapshotFromState(
  state: PluginUnitState,
  runtime: RuntimeKind,
): RuntimeSnapshotUnit {
  return {
    pluginId: state.pluginId,
    unitId: state.unitId,
    runtime,
    ...(state.instanceId !== undefined ? { instanceId: state.instanceId } : {}),
    state: state.kind,
  };
}
