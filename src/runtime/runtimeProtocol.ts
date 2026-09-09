// Window <-> SharedWorker 的轻量运行时协议。
//
// 服务调用仍复用 RemoteServiceMessageCodec / MessagePort transport；本文件
// 只定义运行时握手、快照和重同步消息。setup 函数、Context 和业务私密值
// 永远不进入这些结构化克隆消息。

import type { PluginStateKind, PluginUnitState } from "../contracts/plugin.js";
import type {
  RemoteServiceMessageCodec,
  RemoteServiceReference,
} from "../contracts/lifecycle.js";
import { createRemoteServiceMessageCodec } from "../contracts/lifecycle.js";
import type { RuntimeKind } from "../contracts/lifecycle.js";

export const RUNTIME_PROTOCOL_VERSION = "webloom.runtime.v1";
export const RUNTIME_HELLO_TYPE = "webloom.runtime.hello";
export const RUNTIME_SNAPSHOT_TYPE = "webloom.runtime.snapshot";
export const RUNTIME_RESYNC_TYPE = "webloom.runtime.resync";
export const RUNTIME_ERROR_TYPE = "webloom.runtime.error";

export interface RuntimeHelloMessage {
  type: typeof RUNTIME_HELLO_TYPE;
  protocolVersion: string;
  connectionId: string;
  runtimeId: string;
}

export interface RuntimeResyncMessage {
  type: typeof RUNTIME_RESYNC_TYPE;
  connectionId: string;
}

export interface RuntimeErrorMessage {
  type: typeof RUNTIME_ERROR_TYPE;
  protocolVersion: string;
  code: "runtime.protocol_mismatch" | "runtime.initialization_failed" | "runtime.invalid_connection";
  message: string;
  pluginId?: string;
  unitId?: string;
  phase?: string;
}

export interface RuntimeSnapshot {
  type: typeof RUNTIME_SNAPSHOT_TYPE;
  protocolVersion: string;
  runtimeId: string;
  runtimeKind: RuntimeKind;
  runtimeInstanceId: string;
  connectionId: string;
  snapshotRevision: number;
  baseline: boolean;
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
    && isNonEmptyString(reference.providerInstanceId)
    && isRuntimeKind(reference.runtime)
    && isNonEmptyString(reference.contractVersion)
    && isNonEmptyString(reference.authorityInstanceId)
    && isNonEmptyString(reference.scopeId)
    && Number.isSafeInteger(reference.handoverGeneration)
    && (reference.handoverGeneration as number) >= 0
    && isRecord(reference.attributes)
    && !Array.isArray(reference.attributes)
    && (reference.status === "starting"
      || reference.status === "ready"
      || reference.status === "unavailable"
      || reference.status === "failed")
    && Number.isSafeInteger(reference.snapshotRevision)
    && (reference.snapshotRevision as number) >= 0
    && (reference.connectionId === undefined || isNonEmptyString(reference.connectionId))
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

export function isRuntimeHello(input: unknown): input is RuntimeHelloMessage {
  if (!isRecord(input)) return false;
  const message = input as Partial<RuntimeHelloMessage>;
  return message.type === RUNTIME_HELLO_TYPE
    && isNonEmptyString(message.protocolVersion)
    && isNonEmptyString(message.connectionId)
    && isNonEmptyString(message.runtimeId);
}

export function isRuntimeResync(input: unknown): input is RuntimeResyncMessage {
  if (!isRecord(input)) return false;
  const message = input as Partial<RuntimeResyncMessage>;
  return message.type === RUNTIME_RESYNC_TYPE
    && isNonEmptyString(message.connectionId);
}

export function isRuntimeSnapshot(input: unknown): input is RuntimeSnapshot {
  if (!isRecord(input)) return false;
  const message = input as Partial<RuntimeSnapshot>;
  return message.type === RUNTIME_SNAPSHOT_TYPE
    && message.protocolVersion === RUNTIME_PROTOCOL_VERSION
    && isNonEmptyString(message.runtimeId)
    && isRuntimeKind(message.runtimeKind)
    && isNonEmptyString(message.runtimeInstanceId)
    && isNonEmptyString(message.connectionId)
    && Number.isSafeInteger(message.snapshotRevision)
    && (message.snapshotRevision as number) >= 0
    && typeof message.baseline === "boolean"
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

export function isRuntimeError(input: unknown): input is RuntimeErrorMessage {
  if (!isRecord(input)) return false;
  const message = input as Partial<RuntimeErrorMessage>;
  return message.type === RUNTIME_ERROR_TYPE
    && isNonEmptyString(message.protocolVersion)
    && (message.code === "runtime.protocol_mismatch"
      || message.code === "runtime.initialization_failed"
      || message.code === "runtime.invalid_connection")
    && isNonEmptyString(message.message)
    && (message.pluginId === undefined || isNonEmptyString(message.pluginId))
    && (message.unitId === undefined || isNonEmptyString(message.unitId))
    && (message.phase === undefined || isNonEmptyString(message.phase));
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
