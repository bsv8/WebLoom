// WebLoom v4 唯一 Runtime wire：webloom.runtime.v1。

import type { RuntimeServiceSnapshot, RuntimeSnapshot, RuntimeKind } from "../contracts/lifecycle.js";
import { WebLoomError } from "../contracts/lifecycle.js";
import { ATTRIBUTES_DTO_LIMITS, validateDto } from "../transport/dto.js";

export const RUNTIME_PROTOCOL_VERSION = "webloom.runtime.v1" as const;
export const RUNTIME_SNAPSHOT_TYPE = `${RUNTIME_PROTOCOL_VERSION}.snapshot` as const;
export const RUNTIME_ERROR_TYPE = `${RUNTIME_PROTOCOL_VERSION}.runtime-error` as const;
export const RUNTIME_CALL_TYPE = `${RUNTIME_PROTOCOL_VERSION}.call` as const;
export const RUNTIME_RESULT_TYPE = `${RUNTIME_PROTOCOL_VERSION}.result` as const;
export const RUNTIME_ERROR_MESSAGE_TYPE = `${RUNTIME_PROTOCOL_VERSION}.error` as const;
export const RUNTIME_CANCEL_TYPE = `${RUNTIME_PROTOCOL_VERSION}.cancel` as const;
export const RUNTIME_NEXT_TYPE = `${RUNTIME_PROTOCOL_VERSION}.next` as const;
export const RUNTIME_CREDIT_TYPE = `${RUNTIME_PROTOCOL_VERSION}.credit` as const;

export interface RuntimeSnapshotUnit {
  /** 插件标识。 */
  readonly pluginId: string;
  /** 单元标识。 */
  readonly unitId: string;
  /** Runtime。 */
  readonly runtime: RuntimeKind;
  /** 实例标识。 */
  readonly instanceId?: string;
  /** 状态。 */
  readonly state: import("../contracts/plugin.js").PluginStateKind;
}

export type RuntimeSnapshotMessage = RuntimeSnapshot & { readonly type: typeof RUNTIME_SNAPSHOT_TYPE };

export interface RuntimeErrorMessage {
  /** 消息类型。 */
  readonly type: typeof RUNTIME_ERROR_TYPE;
  /** 协议版本。 */
  readonly protocolVersion: typeof RUNTIME_PROTOCOL_VERSION;
  /** 结构化错误码。 */
  readonly code: string;
  /** 脱敏消息。 */
  readonly message: string;
  /** 失败阶段。 */
  readonly phase: "validate" | "wait" | "dispatch" | "execute" | "receive" | "dispose";
  /** 可选插件标识。 */
  readonly pluginId?: string;
  /** 可选单元标识。 */
  readonly unitId?: string;
}

export interface RuntimeCallMessage {
  /** 消息类型。 */
  readonly type: typeof RUNTIME_CALL_TYPE;
  /** 协议版本。 */
  readonly protocolVersion: typeof RUNTIME_PROTOCOL_VERSION;
  /** 方向内唯一 call id。 */
  readonly callId: string;
  /** capability 标识。 */
  readonly capabilityId: string;
  /** 契约版本。 */
  readonly contractVersion: string;
  /** exposure 身份。 */
  readonly serviceInstanceId: string;
  /** 调用模式。 */
  readonly mode: "unary" | "stream";
  /** 本次派发的剩余预算。 */
  readonly timeoutMs: number;
  /** 已 parser 验证的请求。 */
  readonly request: unknown;
  /** 产品操作标识。 */
  readonly operationId?: string;
  /** 领域授权标识。 */
  readonly grantId?: string;
  /** stream 初始 credit。 */
  readonly initialCredit?: number;
}

export interface RuntimeUnaryResultMessage {
  /** 消息类型。 */
  readonly type: typeof RUNTIME_RESULT_TYPE;
  /** 协议版本。 */
  readonly protocolVersion: typeof RUNTIME_PROTOCOL_VERSION;
  /** call id。 */
  readonly callId: string;
  /** exposure 身份。 */
  readonly serviceInstanceId: string;
  /** unary 结果。 */
  readonly result: unknown;
}

export interface RuntimeStreamReadyMessage {
  /** 消息类型。 */
  readonly type: typeof RUNTIME_RESULT_TYPE;
  /** 协议版本。 */
  readonly protocolVersion: typeof RUNTIME_PROTOCOL_VERSION;
  /** call id。 */
  readonly callId: string;
  /** exposure 身份。 */
  readonly serviceInstanceId: string;
  /** stream 建立确认。 */
  readonly streamReady: true;
}

export interface RuntimeStreamDoneMessage {
  /** 消息类型。 */
  readonly type: typeof RUNTIME_RESULT_TYPE;
  /** 协议版本。 */
  readonly protocolVersion: typeof RUNTIME_PROTOCOL_VERSION;
  /** call id。 */
  readonly callId: string;
  /** exposure 身份。 */
  readonly serviceInstanceId: string;
  /** stream 正常结束。 */
  readonly done: true;
}

export type RuntimeResultMessage = RuntimeUnaryResultMessage | RuntimeStreamReadyMessage | RuntimeStreamDoneMessage;

export interface RuntimeErrorResponseMessage {
  /** 消息类型。 */
  readonly type: typeof RUNTIME_ERROR_MESSAGE_TYPE;
  /** 协议版本。 */
  readonly protocolVersion: typeof RUNTIME_PROTOCOL_VERSION;
  /** call id。 */
  readonly callId: string;
  /** exposure 身份。 */
  readonly serviceInstanceId: string;
  /** 结构化错误。 */
  readonly error: { readonly code: string; readonly message: string; readonly phase: RuntimeErrorMessage["phase"]; readonly details?: Readonly<Record<string, unknown>> };
}

export interface RuntimeCancelMessage {
  /** 消息类型。 */
  readonly type: typeof RUNTIME_CANCEL_TYPE;
  /** 协议版本。 */
  readonly protocolVersion: typeof RUNTIME_PROTOCOL_VERSION;
  /** call id。 */
  readonly callId: string;
  /** exposure 身份。 */
  readonly serviceInstanceId: string;
}

export interface RuntimeNextMessage {
  /** 消息类型。 */
  readonly type: typeof RUNTIME_NEXT_TYPE;
  /** 协议版本。 */
  readonly protocolVersion: typeof RUNTIME_PROTOCOL_VERSION;
  /** call id。 */
  readonly callId: string;
  /** exposure 身份。 */
  readonly serviceInstanceId: string;
  /** 连续序号。 */
  readonly sequence: number;
  /** parser 验证的 item。 */
  readonly item: unknown;
}

export interface RuntimeCreditMessage {
  /** 消息类型。 */
  readonly type: typeof RUNTIME_CREDIT_TYPE;
  /** 协议版本。 */
  readonly protocolVersion: typeof RUNTIME_PROTOCOL_VERSION;
  /** call id。 */
  readonly callId: string;
  /** exposure 身份。 */
  readonly serviceInstanceId: string;
  /** 新增 credit。 */
  readonly count: number;
}

export type RuntimeWireMessage = RuntimeSnapshotMessage | RuntimeErrorMessage | RuntimeCallMessage | RuntimeResultMessage | RuntimeErrorResponseMessage | RuntimeCancelMessage | RuntimeNextMessage | RuntimeCreditMessage;

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

const MAX_CALL_ID_LENGTH = 128;
const MAX_ID_LENGTH = 256;
const MAX_VERSION_LENGTH = 64;
const MAX_ERROR_MESSAGE_LENGTH = 1_024;
const MAX_SNAPSHOT_UNITS = 512;
const MAX_SNAPSHOT_SERVICES = 1_024;

function boundedText(value: unknown, maximum: number): value is string {
  return text(value) && value.length <= maximum;
}

function phase(value: unknown): value is RuntimeErrorMessage["phase"] {
  return value === "validate" || value === "wait" || value === "dispatch" || value === "execute" || value === "receive" || value === "dispose";
}

function validDetails(value: unknown): boolean {
  if (value === undefined) return true;
  if (!record(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) return false;
    }
  } catch {
    return false;
  }
  let budget = 0;
  for (const [key, child] of Object.entries(value)) {
    if (key.length > 128) return false;
    if (typeof child === "string") { if (child.length > 1_024) return false; budget += key.length * 2 + child.length * 2; }
    else if (typeof child === "number") { if (!Number.isFinite(child)) return false; budget += key.length * 2 + 8; }
    else if (typeof child === "boolean" || child === null) budget += key.length * 2 + 8;
    else return false;
    if (budget > 4 * 1024) return false;
  }
  return true;
}

function validIdentity(message: Record<string, unknown>): boolean {
  return boundedText(message.protocolVersion, MAX_VERSION_LENGTH) && message.protocolVersion === RUNTIME_PROTOCOL_VERSION;
}

function validServiceIdentity(message: Record<string, unknown>): boolean {
  return boundedText(message.callId, MAX_CALL_ID_LENGTH) && boundedText(message.serviceInstanceId, MAX_ID_LENGTH);
}

function validateSnapshot(value: Record<string, unknown>): boolean {
  if (value.type !== RUNTIME_SNAPSHOT_TYPE || !validIdentity(value) || !boundedText(value.runtimeId, MAX_ID_LENGTH) || !boundedText(value.runtimeInstanceId, MAX_ID_LENGTH) || (value.runtimeKind !== "window-main" && value.runtimeKind !== "shared-worker") || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0 || !["starting", "ready", "stopping", "failed", "disposed"].includes(String(value.state)) || !Array.isArray(value.units) || !Array.isArray(value.services) || value.units.length > MAX_SNAPSHOT_UNITS || value.services.length > MAX_SNAPSHOT_SERVICES) return false;
  if (value.state !== "ready" && value.services.length !== 0) return false;
  const unitKeys = new Set<string>();
  for (const unit of value.units) {
    if (!record(unit) || !boundedText(unit.pluginId, MAX_ID_LENGTH) || !boundedText(unit.unitId, MAX_ID_LENGTH) || unit.runtime !== value.runtimeKind || !["registered", "starting", "stopping", "enabled", "disabled", "blocked", "error-disabled", "cleanup-pending", "unknown"].includes(String(unit.state))) return false;
    if (unit.instanceId !== undefined && !boundedText(unit.instanceId, MAX_ID_LENGTH)) return false;
    const key = `${unit.pluginId}\u0000${unit.unitId}`;
    if (unitKeys.has(key)) return false;
    unitKeys.add(key);
  }
  const serviceKeys = new Set<string>();
  for (const item of value.services) {
    if (!record(item) || (item.kind !== "rpc" && item.kind !== "stream") || !boundedText(item.capabilityId, MAX_ID_LENGTH) || !boundedText(item.contractVersion, MAX_VERSION_LENGTH) || !boundedText(item.serviceInstanceId, MAX_ID_LENGTH) || !record(item.attributes) || Array.isArray(item.attributes)) return false;
    try {
      const stats = validateDto(item.attributes, { limits: ATTRIBUTES_DTO_LIMITS, phase: "validate" });
      if (stats.messagePorts.length > 0 || stats.reachableTransferables.length > 0) return false;
    } catch { return false; }
    if (item.grantId !== undefined && !boundedText(item.grantId, MAX_ID_LENGTH)) return false;
    if (item.authorizationRevision !== undefined && (!Number.isSafeInteger(item.authorizationRevision) || (item.authorizationRevision as number) < 0)) return false;
    const key = `${item.kind}\u0000${item.capabilityId}\u0000${item.contractVersion}`;
    if (serviceKeys.has(key)) return false;
    serviceKeys.add(key);
  }
  return true;
}

function validateMessage(value: unknown): value is RuntimeWireMessage {
  if (!record(value) || !text(value.type) || !validIdentity(value)) return false;
  if (value.type === RUNTIME_SNAPSHOT_TYPE) return validateSnapshot(value);
  if (value.type === RUNTIME_ERROR_TYPE) return boundedText(value.code, MAX_ID_LENGTH) && boundedText(value.message, MAX_ERROR_MESSAGE_LENGTH) && phase(value.phase) && (value.pluginId === undefined || boundedText(value.pluginId, MAX_ID_LENGTH)) && (value.unitId === undefined || boundedText(value.unitId, MAX_ID_LENGTH));
  if (value.type === RUNTIME_CALL_TYPE) return validServiceIdentity(value) && boundedText(value.capabilityId, MAX_ID_LENGTH) && boundedText(value.contractVersion, MAX_VERSION_LENGTH) && Object.hasOwn(value, "request") && validPayload(value.request) && (value.mode === "unary" || value.mode === "stream") && typeof value.timeoutMs === "number" && Number.isFinite(value.timeoutMs) && value.timeoutMs > 0 && value.timeoutMs <= 300_000 && (value.operationId === undefined || boundedText(value.operationId, MAX_ID_LENGTH)) && (value.grantId === undefined || boundedText(value.grantId, MAX_ID_LENGTH)) && (value.mode !== "stream" ? !Object.hasOwn(value, "initialCredit") : (Number.isSafeInteger(value.initialCredit) && (value.initialCredit as number) >= 1 && (value.initialCredit as number) <= 256));
  if (value.type === RUNTIME_RESULT_TYPE) return validServiceIdentity(value) && ((!Object.hasOwn(value, "result") || validPayload(value.result)) && ((value.streamReady === true && !Object.hasOwn(value, "result") && !Object.hasOwn(value, "done")) || (value.done === true && !Object.hasOwn(value, "result") && !Object.hasOwn(value, "streamReady")) || (Object.hasOwn(value, "result") && !Object.hasOwn(value, "done") && !Object.hasOwn(value, "streamReady"))));
  if (value.type === RUNTIME_ERROR_MESSAGE_TYPE) return validServiceIdentity(value) && record(value.error) && boundedText(value.error.code, MAX_ID_LENGTH) && boundedText(value.error.message, MAX_ERROR_MESSAGE_LENGTH) && phase(value.error.phase) && validDetails(value.error.details);
  if (value.type === RUNTIME_CANCEL_TYPE) return validServiceIdentity(value);
  if (value.type === RUNTIME_NEXT_TYPE) return validServiceIdentity(value) && Object.hasOwn(value, "item") && validPayload(value.item) && Number.isSafeInteger(value.sequence) && (value.sequence as number) >= 1;
  if (value.type === RUNTIME_CREDIT_TYPE) return validServiceIdentity(value) && Number.isSafeInteger(value.count) && (value.count as number) >= 1 && (value.count as number) <= 256;
  return false;
}

function validPayload(value: unknown): boolean {
  try {
    validateDto(value, { allowUnlistedMessagePorts: true, phase: "validate" });
    return true;
  } catch {
    return false;
  }
}

export interface RuntimeMessageCodec {
  /** 严格验证并冻结 v4 message。 */
  encode(message: RuntimeWireMessage): RuntimeWireMessage;
  /** 严格解析 v4 message；旧协议直接拒绝。 */
  decode(value: unknown): RuntimeWireMessage;
}

export function createRuntimeMessageCodec(): RuntimeMessageCodec {
  return {
    encode(message) {
      if (!validateMessage(message)) throw new WebLoomError("invalid_snapshot", "Invalid WebLoom runtime message", "validate");
      return message;
    },
    decode(value) {
      if (!record(value) || value.protocolVersion !== RUNTIME_PROTOCOL_VERSION) throw new WebLoomError("protocol_mismatch", "Unsupported WebLoom runtime protocol", "validate");
      if (!validateMessage(value)) throw new WebLoomError("invalid_snapshot", "Invalid WebLoom runtime message", "validate");
      return value;
    },
  };
}

export function isRuntimeSnapshot(value: RuntimeWireMessage): value is RuntimeSnapshotMessage {
  return value.type === RUNTIME_SNAPSHOT_TYPE;
}
