// WebLoom v4 唯一 Runtime wire：webloom.runtime.v1。

import type { RuntimeServiceSnapshot, RuntimeSnapshot, RuntimeKind, RuntimeEndpointBinding } from "../contracts/lifecycle.js";
import { WebLoomError } from "../contracts/lifecycle.js";
import { ATTRIBUTES_DTO_LIMITS, isPreparedPayload, normalizeRuntimeLimits, validateDto, type DtoStats, type PreparedPayload, type RuntimeLimitsInput } from "../transport/dto.js";

export const RUNTIME_PROTOCOL_VERSION = "webloom.runtime.v1" as const;
export const RUNTIME_SNAPSHOT_TYPE = `${RUNTIME_PROTOCOL_VERSION}.snapshot` as const;
export const RUNTIME_ERROR_TYPE = `${RUNTIME_PROTOCOL_VERSION}.runtime-error` as const;
export const RUNTIME_CALL_TYPE = `${RUNTIME_PROTOCOL_VERSION}.call` as const;
export const RUNTIME_RESULT_TYPE = `${RUNTIME_PROTOCOL_VERSION}.result` as const;
export const RUNTIME_ERROR_MESSAGE_TYPE = `${RUNTIME_PROTOCOL_VERSION}.error` as const;
export const RUNTIME_CANCEL_TYPE = `${RUNTIME_PROTOCOL_VERSION}.cancel` as const;
export const RUNTIME_NEXT_TYPE = `${RUNTIME_PROTOCOL_VERSION}.next` as const;
export const RUNTIME_CREDIT_TYPE = `${RUNTIME_PROTOCOL_VERSION}.credit` as const;
export const RUNTIME_CLOSE_TYPE = `${RUNTIME_PROTOCOL_VERSION}.close` as const;
export const RUNTIME_CLOSE_ACK_TYPE = `${RUNTIME_PROTOCOL_VERSION}.close-ack` as const;

/** 每条 Runtime wire 消息所属的框架 endpoint 身份。 */
export type RuntimeSessionBinding = RuntimeEndpointBinding;

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

export type RuntimeSnapshotMessage = RuntimeSnapshot & { readonly type: typeof RUNTIME_SNAPSHOT_TYPE; readonly binding: RuntimeSessionBinding };

export interface RuntimeErrorMessage {
  /** 消息类型。 */
  readonly type: typeof RUNTIME_ERROR_TYPE;
  /** 协议版本。 */
  readonly protocolVersion: typeof RUNTIME_PROTOCOL_VERSION;
  /** 发送此错误的物理 endpoint 绑定。 */
  readonly binding: RuntimeSessionBinding;
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

interface RuntimeCallMessageBase {
  /** 消息类型。 */
  readonly type: typeof RUNTIME_CALL_TYPE;
  /** 协议版本。 */
  readonly protocolVersion: typeof RUNTIME_PROTOCOL_VERSION;
  /** 发起调用的物理 endpoint 绑定。 */
  readonly binding: RuntimeSessionBinding;
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
}

export interface RuntimeUnaryCallMessage extends RuntimeCallMessageBase {
  /** 调用模式。 */
  readonly mode: "unary";
  /** unary 请求不携带 stream credit。 */
  readonly initialCredit?: never;
  /** unary 请求不携带 stream 字节 credit。 */
  readonly initialByteCredit?: never;
  /** unary 请求不携带默认窗口协商标记。 */
  readonly initialByteCreditAuto?: never;
}

export interface RuntimeStreamCallMessage extends RuntimeCallMessageBase {
  /** 调用模式。 */
  readonly mode: "stream";
  /** stream 初始 credit。 */
  readonly initialCredit: number;
  /** stream 初始字节 credit；按 DTO budgetBytes 计费，必须由调用端确定并发送。 */
  readonly initialByteCredit: number;
  /** 未显式配置时允许 Provider 按自身剩余容量缩小窗口。 */
  readonly initialByteCreditAuto?: true;
}

export type RuntimeCallMessage = RuntimeUnaryCallMessage | RuntimeStreamCallMessage;

export interface RuntimeUnaryResultMessage {
  /** 消息类型。 */
  readonly type: typeof RUNTIME_RESULT_TYPE;
  /** 协议版本。 */
  readonly protocolVersion: typeof RUNTIME_PROTOCOL_VERSION;
  /** 发送结果的物理 endpoint 绑定。 */
  readonly binding: RuntimeSessionBinding;
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
  /** 发送结果的物理 endpoint 绑定。 */
  readonly binding: RuntimeSessionBinding;
  /** call id。 */
  readonly callId: string;
  /** exposure 身份。 */
  readonly serviceInstanceId: string;
  /** stream 建立确认。 */
  readonly streamReady: true;
  /** Provider 实际接受并预留的初始字节窗口。 */
  readonly acceptedInitialByteCredit: number;
}

export interface RuntimeStreamDoneMessage {
  /** 消息类型。 */
  readonly type: typeof RUNTIME_RESULT_TYPE;
  /** 协议版本。 */
  readonly protocolVersion: typeof RUNTIME_PROTOCOL_VERSION;
  /** 发送结果的物理 endpoint 绑定。 */
  readonly binding: RuntimeSessionBinding;
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
  /** 发送错误响应的物理 endpoint 绑定。 */
  readonly binding: RuntimeSessionBinding;
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
  /** 发送取消的物理 endpoint 绑定。 */
  readonly binding: RuntimeSessionBinding;
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
  /** 发送 stream item 的物理 endpoint 绑定。 */
  readonly binding: RuntimeSessionBinding;
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
  /** 发送 credit 的物理 endpoint 绑定。 */
  readonly binding: RuntimeSessionBinding;
  /** call id。 */
  readonly callId: string;
  /** exposure 身份。 */
  readonly serviceInstanceId: string;
  /** 新增 credit。 */
  readonly count: number;
  /** 新增字节 credit；旧 v1 消息可省略，接收端会按已发送 item 兼容推导。 */
  readonly bytes?: number;
}

/** 请求对端先同步 fence、再等待真实执行排空。 */
export interface RuntimeCloseMessage {
  /** 消息类型。 */
  readonly type: typeof RUNTIME_CLOSE_TYPE;
  /** 协议版本。 */
  readonly protocolVersion: typeof RUNTIME_PROTOCOL_VERSION;
  /** 发起关闭的物理 endpoint 绑定。 */
  readonly binding: RuntimeSessionBinding;
  /** 对端 drain 的最大等待时间。 */
  readonly timeoutMs?: number;
}

/** 对端完成或超时 drain 后返回的关闭确认。 */
export interface RuntimeCloseAckMessage {
  /** 消息类型。 */
  readonly type: typeof RUNTIME_CLOSE_ACK_TYPE;
  /** 协议版本。 */
  readonly protocolVersion: typeof RUNTIME_PROTOCOL_VERSION;
  /** 发送确认的物理 endpoint 绑定。 */
  readonly binding: RuntimeSessionBinding;
  /** 确认对应的发起方 binding，防止旧 close-ack 误配新 session。 */
  readonly acknowledgedBinding: RuntimeSessionBinding;
  /** 对端本次 drain 的结果。 */
  readonly drained: boolean;
  /** 是否达到 bounded deadline。 */
  readonly timedOut: boolean;
  /** deadline 到达时仍存活的执行槽数量。 */
  readonly pendingExecutions: number;
}

export type RuntimeWireMessage = RuntimeSnapshotMessage | RuntimeErrorMessage | RuntimeCallMessage | RuntimeResultMessage | RuntimeErrorResponseMessage | RuntimeCancelMessage | RuntimeNextMessage | RuntimeCreditMessage | RuntimeCloseMessage | RuntimeCloseAckMessage;

/** wire payload 在一次 transport decode 中对应的字段。 */
export type RuntimePayloadField = "request" | "result" | "item";

/** transport 已完成一次 payload walker 后交给本地 listener 的元数据。 */
export interface RuntimeDecodedPayload {
  /** payload 所在 wire 字段。 */
  readonly field: RuntimePayloadField;
  /** 与 stats 对应的原始 payload。 */
  readonly value: unknown;
  /** 唯一一次接收端 walker 的结果。 */
  readonly stats: DtoStats;
}

/** 一次 decode 的 message 和热 payload 统计。 */
export interface RuntimeDecodedMessage {
  /** 已通过 envelope 与 payload 边界检查的 message。 */
  readonly message: RuntimeWireMessage;
  /** call/result/next 才有 payload；控制消息没有。 */
  readonly payload?: RuntimeDecodedPayload;
}

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
const MAX_STREAM_CREDIT = 256;
const MAX_STREAM_BYTE_CREDIT = 64 * 1024 * 1024;
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

function validBinding(value: unknown): value is RuntimeSessionBinding {
  if (!record(value)) return false;
  return boundedText(value.runtimeInstanceId, MAX_ID_LENGTH) && boundedText(value.connectionId, MAX_ID_LENGTH);
}

/** close-ack 的结果组合必须能被真实 drain 语义解释。 */
function validDrainResult(value: Record<string, unknown>): boolean {
  if (typeof value.drained !== "boolean" || typeof value.timedOut !== "boolean"
    || !Number.isSafeInteger(value.pendingExecutions) || (value.pendingExecutions as number) < 0) return false;
  // A successful drain cannot also time out or retain execution slots.
  if (value.drained && (value.timedOut || value.pendingExecutions !== 0)) return false;
  // A timeout must report the work which prevented completion.  A non-timeout
  // failure is allowed for a participant that rejected while no slot remains.
  if (value.timedOut && (!value.pendingExecutions || value.drained)) return false;
  return true;
}

function validServiceIdentity(message: Record<string, unknown>): boolean {
  return boundedText(message.callId, MAX_CALL_ID_LENGTH) && boundedText(message.serviceInstanceId, MAX_ID_LENGTH);
}

function dtoLimits(limits: ReturnType<typeof normalizeRuntimeLimits>): { readonly maxDepth: number; readonly maxNodes: number; readonly maxEdges: number; readonly maxBudgetBytes: number } {
  return { maxDepth: limits.maxDtoDepth, maxNodes: limits.maxDtoNodes, maxEdges: limits.maxDtoEdges, maxBudgetBytes: limits.maxMessageBudgetBytes };
}

function validateSnapshot(value: Record<string, unknown>, limits: ReturnType<typeof normalizeRuntimeLimits>): boolean {
  if (value.type !== RUNTIME_SNAPSHOT_TYPE || !validIdentity(value) || !validBinding(value.binding) || !boundedText(value.runtimeId, MAX_ID_LENGTH) || !boundedText(value.runtimeInstanceId, MAX_ID_LENGTH) || (value.runtimeKind !== "window-main" && value.runtimeKind !== "shared-worker") || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0 || !["starting", "ready", "stopping", "failed", "disposed"].includes(String(value.state)) || !Array.isArray(value.units) || !Array.isArray(value.services) || value.units.length > Math.min(MAX_SNAPSHOT_UNITS, limits.maxSnapshotUnits) || value.services.length > Math.min(MAX_SNAPSHOT_SERVICES, limits.maxSnapshotServices)) return false;
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
  try {
    validateDto(value, { limits: dtoLimits(limits), phase: "validate" });
    return true;
  } catch {
    return false;
  }
}

function validPayload(value: unknown, prepared: PreparedPayload | undefined, limits: ReturnType<typeof normalizeRuntimeLimits>): DtoStats | undefined {
  if (prepared && isPreparedPayload(prepared) && prepared.value === value) {
    const stats = prepared.stats;
    return stats.depth <= limits.maxDtoDepth
      && stats.nodes <= limits.maxDtoNodes
      && stats.edges <= limits.maxDtoEdges
      && stats.budgetBytes <= limits.maxMessageBudgetBytes
      ? stats
      : undefined;
  }
  try {
    return validateDto(value, { limits: dtoLimits(limits), allowUnlistedMessagePorts: true, phase: "validate" });
  } catch {
    return undefined;
  }
}

interface MessageValidationResult {
  readonly valid: boolean;
  readonly payload?: RuntimeDecodedPayload;
}

function validateMessage(value: unknown, prepared: PreparedPayload | undefined, limits: ReturnType<typeof normalizeRuntimeLimits>): MessageValidationResult {
  if (!record(value) || !text(value.type) || !validIdentity(value)) return { valid: false };
  if (value.type === RUNTIME_SNAPSHOT_TYPE) return { valid: validateSnapshot(value, limits) };
  if (!validBinding(value.binding)) return { valid: false };
  if (value.type === RUNTIME_ERROR_TYPE) return { valid: boundedText(value.code, MAX_ID_LENGTH) && boundedText(value.message, MAX_ERROR_MESSAGE_LENGTH) && phase(value.phase) && (value.pluginId === undefined || boundedText(value.pluginId, MAX_ID_LENGTH)) && (value.unitId === undefined || boundedText(value.unitId, MAX_ID_LENGTH)) };
  if (value.type === RUNTIME_CALL_TYPE) {
    const stats = Object.hasOwn(value, "request") ? validPayload(value.request, prepared, limits) : undefined;
    const valid = validServiceIdentity(value) && boundedText(value.capabilityId, MAX_ID_LENGTH) && boundedText(value.contractVersion, MAX_VERSION_LENGTH) && stats !== undefined && (value.mode === "unary" || value.mode === "stream") && typeof value.timeoutMs === "number" && Number.isFinite(value.timeoutMs) && value.timeoutMs > 0 && value.timeoutMs <= 300_000 && (value.operationId === undefined || boundedText(value.operationId, MAX_ID_LENGTH)) && (value.grantId === undefined || boundedText(value.grantId, MAX_ID_LENGTH)) && (value.mode !== "stream"
      ? !Object.hasOwn(value, "initialCredit") && !Object.hasOwn(value, "initialByteCredit") && !Object.hasOwn(value, "initialByteCreditAuto")
      : Number.isSafeInteger(value.initialCredit) && (value.initialCredit as number) >= 1 && (value.initialCredit as number) <= MAX_STREAM_CREDIT && Number.isSafeInteger(value.initialByteCredit) && (value.initialByteCredit as number) >= 1 && (value.initialByteCredit as number) <= MAX_STREAM_BYTE_CREDIT && (value.initialByteCreditAuto === undefined || value.initialByteCreditAuto === true));
    return { valid, ...(valid && stats ? { payload: { field: "request", value: value.request, stats } } : {}) };
  }
  if (value.type === RUNTIME_RESULT_TYPE) {
    const hasResult = Object.hasOwn(value, "result");
    const stats = hasResult ? validPayload(value.result, prepared, limits) : undefined;
    const valid = validServiceIdentity(value) && (!hasResult || stats !== undefined) && ((value.streamReady === true && !hasResult && !Object.hasOwn(value, "done") && Number.isSafeInteger(value.acceptedInitialByteCredit) && (value.acceptedInitialByteCredit as number) >= 1 && (value.acceptedInitialByteCredit as number) <= MAX_STREAM_BYTE_CREDIT) || (value.done === true && !hasResult && !Object.hasOwn(value, "streamReady") && !Object.hasOwn(value, "acceptedInitialByteCredit")) || (hasResult && !Object.hasOwn(value, "done") && !Object.hasOwn(value, "streamReady") && !Object.hasOwn(value, "acceptedInitialByteCredit")));
    return { valid, ...(valid && stats ? { payload: { field: "result", value: value.result, stats } } : {}) };
  }
  if (value.type === RUNTIME_ERROR_MESSAGE_TYPE) return { valid: validServiceIdentity(value) && record(value.error) && boundedText(value.error.code, MAX_ID_LENGTH) && boundedText(value.error.message, MAX_ERROR_MESSAGE_LENGTH) && phase(value.error.phase) && validDetails(value.error.details) };
  if (value.type === RUNTIME_CANCEL_TYPE) return { valid: validServiceIdentity(value) };
  if (value.type === RUNTIME_NEXT_TYPE) {
    const stats = Object.hasOwn(value, "item") ? validPayload(value.item, prepared, limits) : undefined;
    const valid = validServiceIdentity(value) && stats !== undefined && Number.isSafeInteger(value.sequence) && (value.sequence as number) >= 1;
    return { valid, ...(valid && stats ? { payload: { field: "item", value: value.item, stats } } : {}) };
  }
  if (value.type === RUNTIME_CREDIT_TYPE) return { valid: validServiceIdentity(value) && Number.isSafeInteger(value.count) && (value.count as number) >= 1 && (value.count as number) <= MAX_STREAM_CREDIT && (value.bytes === undefined || (Number.isSafeInteger(value.bytes) && (value.bytes as number) >= 0 && (value.bytes as number) <= MAX_STREAM_BYTE_CREDIT)) };
  if (value.type === RUNTIME_CLOSE_TYPE) return { valid: !Object.hasOwn(value, "reason") && (value.timeoutMs === undefined || (Number.isFinite(value.timeoutMs) && (value.timeoutMs as number) >= 1 && (value.timeoutMs as number) <= 300_000)) };
  if (value.type === RUNTIME_CLOSE_ACK_TYPE) return { valid: validBinding(value.acknowledgedBinding) && validDrainResult(value) };
  return { valid: false };
}

export interface RuntimeMessageCodec {
  /** 严格验证并冻结 v4 message。 */
  encode(message: RuntimeWireMessage, prepared?: PreparedPayload): RuntimeWireMessage;
  /** 严格解析 v4 message；旧协议直接拒绝。 */
  decode(value: unknown): RuntimeWireMessage;
  /** 解析一次并返回热 payload 的 walker 统计，供同一 endpoint 的 listener 复用。 */
  decodeWithStats(value: unknown): RuntimeDecodedMessage;
}

export function createRuntimeMessageCodec(options: { readonly limits?: RuntimeLimitsInput } = {}): RuntimeMessageCodec {
  const limits = normalizeRuntimeLimits(options.limits);
  return {
    encode(message, prepared) {
      if (!validateMessage(message, prepared, limits).valid) throw new WebLoomError("invalid_snapshot", "Invalid WebLoom runtime message", "validate");
      return message;
    },
    decode(value) {
      return this.decodeWithStats(value).message;
    },
    decodeWithStats(value) {
      if (!record(value) || value.protocolVersion !== RUNTIME_PROTOCOL_VERSION) throw new WebLoomError("protocol_mismatch", "Unsupported WebLoom runtime protocol", "validate");
      const result = validateMessage(value, undefined, limits);
      if (!result.valid) throw new WebLoomError("invalid_snapshot", "Invalid WebLoom runtime message", "validate");
      return Object.freeze({ message: value as unknown as RuntimeWireMessage, ...(result.payload ? { payload: Object.freeze(result.payload) } : {}) });
    },
  };
}

export function isRuntimeSnapshot(value: RuntimeWireMessage): value is RuntimeSnapshotMessage {
  return value.type === RUNTIME_SNAPSHOT_TYPE;
}
