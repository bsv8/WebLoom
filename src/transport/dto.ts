// WebLoom v4 的有限 wire DTO walker、transfer 校验和接收资源账本。
//
// 这不是 structuredClone 的实现，也不试图检测任意 Proxy。它只接受规范中
// 明确列出的、可有界计费的 DTO 图；sender、receiver、provider 和 testing
// 都通过这里使用同一套边界。

import { WebLoomError, type RuntimeLimits } from "../contracts/lifecycle.js";

export interface DtoLimits {
  /** DTO 图允许的最长路径深度。 */
  readonly maxDepth: number;
  /** 唯一对象节点上限。 */
  readonly maxNodes: number;
  /** 引用边/字段槽位上限。 */
  readonly maxEdges: number;
  /** 确定性计费预算。 */
  readonly maxBudgetBytes: number;
  /** 普通字符串的 UTF-16 code unit 上限。 */
  readonly maxStringLength: number;
  /** 对象字段名的 UTF-16 code unit 上限。 */
  readonly maxFieldNameLength: number;
}

export const DEFAULT_DTO_LIMITS: DtoLimits = Object.freeze({
  maxDepth: 32,
  maxNodes: 10_000,
  maxEdges: 20_000,
  maxBudgetBytes: 16 * 1024 * 1024,
  maxStringLength: 1_048_576,
  maxFieldNameLength: 256,
});

export const ATTRIBUTES_DTO_LIMITS: DtoLimits = Object.freeze({
  maxDepth: 8,
  maxNodes: 256,
  maxEdges: 1_024,
  maxBudgetBytes: 16 * 1024,
  maxStringLength: 2_048,
  maxFieldNameLength: 128,
});

export const DEFAULT_RUNTIME_LIMITS: RuntimeLimits = Object.freeze({
  maxPeers: 32,
  maxPendingCallsPerPeer: 64,
  maxPendingCallsPerRuntime: 512,
  maxActiveStreamsPerPeer: 16,
  maxActiveStreamsPerRuntime: 128,
  maxExecutionSlotsPerPeer: 64,
  maxExecutionSlotsPerRuntime: 512,
  maxMessageBudgetBytes: DEFAULT_DTO_LIMITS.maxBudgetBytes,
  maxRetainedPayloadBytesPerPeer: 64 * 1024 * 1024,
  maxRetainedPayloadBytesPerRuntime: 256 * 1024 * 1024,
  maxSnapshotUnits: 512,
  maxSnapshotServices: 1_024,
  maxDtoDepth: DEFAULT_DTO_LIMITS.maxDepth,
  maxDtoNodes: DEFAULT_DTO_LIMITS.maxNodes,
  maxDtoEdges: DEFAULT_DTO_LIMITS.maxEdges,
  maxTransferEntries: 64,
  maxTransfers: 32,
  maxMessagePorts: 8,
  maxStreamCredit: 256,
});

export type RuntimeLimitsInput = Partial<RuntimeLimits>;

/** Runtime execution slot 释放时等待调度的回调。 */
export type RuntimeExecutionWaiter = () => void;

/** 一个 Runtime/方向共享的原子配额计数器；仅由 transport 装配层持有。 */
export interface RuntimeBudget {
  readonly limits: RuntimeLimits;
  pendingCalls: number;
  activeStreams: number;
  executionSlots: number;
  retainedPayloadBytes: number;
  /** 以 FIFO 顺序登记一个等待全局 execution slot 的 transport 队列。 */
  registerExecutionWaiter(waiter: RuntimeExecutionWaiter): () => void;
  /** 释放一个全局 execution slot，并公平唤醒一个等待者。 */
  releaseExecutionSlot(): void;
}

export function createRuntimeBudget(limits?: RuntimeLimitsInput): RuntimeBudget {
  const waiters = new Set<RuntimeExecutionWaiter>();
  const budget: RuntimeBudget = {
    limits: normalizeRuntimeLimits(limits),
    pendingCalls: 0,
    activeStreams: 0,
    executionSlots: 0,
    retainedPayloadBytes: 0,
    registerExecutionWaiter(waiter) {
      if (typeof waiter !== "function") throw new TypeError("Runtime execution waiter must be a function");
      waiters.add(waiter);
      let registered = true;
      return () => {
        if (!registered) return;
        registered = false;
        waiters.delete(waiter);
      };
    },
    releaseExecutionSlot() {
      budget.executionSlots = Math.max(0, budget.executionSlots - 1);
      const waiter = waiters.values().next().value as RuntimeExecutionWaiter | undefined;
      if (waiter === undefined) return;
      waiters.delete(waiter);
      // Do not re-enter a bridge while it is still unwinding the callback that
      // released the slot. The microtask also makes the FIFO scheduler fair
      // across endpoints that share this RuntimeBudget.
      queueMicrotask(() => {
        try { waiter(); } catch { /* a closed transport may race the wake-up */ }
      });
    },
  };
  return budget;
}

/** 合并并验证可信 Runtime 装配提供的预算。 */
export function normalizeRuntimeLimits(input: RuntimeLimitsInput | undefined): RuntimeLimits {
  const result = { ...DEFAULT_RUNTIME_LIMITS, ...(input ?? {}) };
  for (const [key, value] of Object.entries(result)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`Runtime limit ${key} must be a finite positive integer`);
    }
    const defaultValue = DEFAULT_RUNTIME_LIMITS[key as keyof RuntimeLimits];
    if (value > defaultValue) throw new TypeError(`Runtime limit ${key} cannot exceed the v4 default budget`);
  }
  if (result.maxMessagePorts > result.maxTransfers) throw new TypeError("maxMessagePorts cannot exceed maxTransfers");
  if (result.maxTransferEntries < result.maxTransfers) throw new TypeError("maxTransferEntries cannot be less than maxTransfers");
  if (result.maxStreamCredit > 256) throw new TypeError("maxStreamCredit cannot exceed 256");
  return Object.freeze(result);
}

export interface DtoStats {
  /** 唯一对象节点数。 */
  readonly nodes: number;
  /** 引用边/字段槽位数。 */
  readonly edges: number;
  /** 确定性计费字节数。 */
  readonly budgetBytes: number;
  /** 图中可达的业务 MessagePort。 */
  readonly messagePorts: readonly MessagePort[];
  /** 图中可达的 transfer 资源。 */
  readonly reachableTransferables: readonly Transferable[];
}

export interface ValidateDtoOptions {
  /** DTO 边界；缺省使用 v4 默认值。 */
  readonly limits?: Partial<DtoLimits>;
  /** 已声明的 transfer；MessagePort 只有在这里才可进入规范化图。 */
  readonly transferables?: ReadonlySet<Transferable>;
  /** 原始 parser 输入检查允许暂时观察 MessagePort。 */
  readonly allowUnlistedMessagePorts?: boolean;
  /** 错误所属阶段。 */
  readonly phase?: "validate" | "receive" | "dispatch";
}

function isObject(value: unknown): value is object {
  return value !== null && typeof value === "object";
}

function isMessagePort(value: unknown): value is MessagePort {
  if (!isObject(value)) return false;
  try {
    // Browser realms normally expose the MessagePort brand, while Node's
    // worker_threads implementation currently reports `[object EventTarget]`.
    // `instanceof MessagePort` is not cross-realm safe, so retain the brand
    // fast path and use the complete transferable interface as the fallback.
    if (Object.prototype.toString.call(value) === "[object MessagePort]") return true;
    const candidate = value as Partial<MessagePort>;
    return typeof candidate.postMessage === "function"
      && typeof candidate.start === "function"
      && typeof candidate.close === "function"
      && typeof candidate.addEventListener === "function"
      && typeof candidate.removeEventListener === "function";
  } catch {
    return false;
  }
}

function isArrayBuffer(value: unknown): value is ArrayBuffer {
  if (!isObject(value)) return false;
  try {
    return Object.prototype.toString.call(value) === "[object ArrayBuffer]";
  } catch {
    return false;
  }
}

function isSharedArrayBuffer(value: unknown): boolean {
  if (!isObject(value)) return false;
  try {
    return Object.prototype.toString.call(value) === "[object SharedArrayBuffer]";
  } catch {
    return false;
  }
}

function isBlob(value: unknown): value is Blob {
  if (!isObject(value)) return false;
  try {
    const tag = Object.prototype.toString.call(value);
    return tag === "[object Blob]" || tag === "[object File]";
  } catch {
    return false;
  }
}

function isDate(value: unknown): value is Date {
  if (!isObject(value)) return false;
  try { return Object.prototype.toString.call(value) === "[object Date]"; } catch { return false; }
}

function isSupportedTransfer(value: unknown): value is Transferable {
  return isArrayBuffer(value) || isMessagePort(value);
}

function ownKeys(value: object): PropertyKey[] {
  try { return Reflect.ownKeys(value); } catch { throw new Error("DTO property inspection failed"); }
}

function rejectCustomKeys(value: object): void {
  for (const key of ownKeys(value)) throw new Error(`Unsupported custom property ${String(key)}`);
}

function descriptorValue(value: object, key: PropertyKey, label: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) throw new Error(`${label} must contain enumerable data properties`);
  return descriptor.value;
}

function arrayIndex(key: string): number | undefined {
  if (!/^(?:0|[1-9][0-9]*)$/.test(key)) return undefined;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 ? index : undefined;
}

function isTypedArray(value: object): boolean {
  try { return ArrayBuffer.isView(value) && Object.prototype.toString.call(value) !== "[object DataView]"; } catch { return false; }
}

function assertFixedBuffer(value: ArrayBuffer): number {
  if (isSharedArrayBuffer(value)) throw new Error("SharedArrayBuffer is not supported");
  try {
    if ((value as ArrayBuffer & { resizable?: unknown }).resizable === true) throw new Error("Resizable ArrayBuffer is not supported");
    // A zero-byte buffer is valid; slice distinguishes it from a detached buffer.
    ArrayBuffer.prototype.slice.call(value, 0, 0);
    const length = value.byteLength;
    if (!Number.isSafeInteger(length) || length < 0) throw new Error("Invalid ArrayBuffer length");
    rejectCustomKeys(value);
    return length;
  } catch (error) {
    if (error instanceof Error && error.message.includes("not supported")) throw error;
    throw new Error("Detached or invalid ArrayBuffer");
  }
}

function assertNoCustomViewProperties(value: object, length: number): void {
  for (const key of ownKeys(value)) {
    if (typeof key !== "string") throw new Error("TypedArray symbols are not supported");
    const index = arrayIndex(key);
    if (index === undefined || index >= length) throw new Error("TypedArray has unsupported custom properties");
    descriptorValue(value, key, "TypedArray");
  }
}

function error(code: "invalid_message" | "resource_limit_exceeded", message: string, phase: ValidateDtoOptions["phase"] = "validate"): never {
  throw new WebLoomError(code, message, phase ?? "validate");
}

/**
 * 检查一个有限 DTO 图。遍历只读取 data property descriptor，不主动执行
 * 普通对象 getter；Proxy 的 trap 无法由 JavaScript 通用地检测或隔离。
 */
export function validateDto(value: unknown, options: ValidateDtoOptions = {}): DtoStats {
  const limits: DtoLimits = { ...DEFAULT_DTO_LIMITS, ...(options.limits ?? {}) };
  const transferables = options.transferables ?? new Set<Transferable>();
  const messagePorts: MessagePort[] = [];
  const reachableTransferables: Transferable[] = [];
  const seen = new Map<object, number>();
  const active = new Set<object>();
  let nodes = 0;
  let edges = 0;
  let budgetBytes = 0;

  const charge = (amount: number): void => {
    if (!Number.isSafeInteger(amount) || amount < 0 || budgetBytes > limits.maxBudgetBytes - amount) error("resource_limit_exceeded", "DTO budget exceeded", options.phase);
    budgetBytes += amount;
  };
  const addEdge = (): void => {
    edges += 1;
    if (edges > limits.maxEdges) error("resource_limit_exceeded", "DTO edge limit exceeded", options.phase);
    charge(16);
  };
  const addNode = (): void => {
    nodes += 1;
    if (nodes > limits.maxNodes) error("resource_limit_exceeded", "DTO node limit exceeded", options.phase);
    charge(32);
  };
  const child = (childValue: unknown, depth: number): number => {
    addEdge();
    return walk(childValue, depth);
  };

  const walk = (current: unknown, depth: number): number => {
    if (depth > limits.maxDepth) error("resource_limit_exceeded", "DTO depth limit exceeded", options.phase);
    if (current === null || current === undefined) { charge(8); return 0; }
    switch (typeof current) {
      case "boolean": charge(8); return 0;
      case "string":
        if (current.length > limits.maxStringLength) error("resource_limit_exceeded", "DTO string limit exceeded", options.phase);
        charge(current.length * 2); return 0;
      case "number":
        if (!Number.isFinite(current)) error("invalid_message", "DTO number must be finite", options.phase);
        charge(8); return 0;
      case "bigint":
        if (current < -(2n ** 63n) || current > (2n ** 63n) - 1n) error("invalid_message", "DTO bigint must fit signed 64-bit", options.phase);
        charge(8); return 0;
      case "function":
      case "symbol":
        error("invalid_message", "Unsupported DTO value", options.phase);
    }
    if (!isObject(current)) error("invalid_message", "Unsupported DTO value", options.phase);
    if (active.has(current)) error("invalid_message", "DTO cycles are not supported", options.phase);
    const known = seen.get(current);
    if (known !== undefined) {
      if (depth + known > limits.maxDepth) error("resource_limit_exceeded", "DTO depth limit exceeded", options.phase);
      return known;
    }
    addNode();
    active.add(current);
    let subtreeDepth = 0;
    try {
      if (isMessagePort(current)) {
        if (!options.allowUnlistedMessagePorts && !transferables.has(current)) error("invalid_message", "MessagePort was not declared by the capability", options.phase);
        messagePorts.push(current);
        reachableTransferables.push(current);
      } else if (isSharedArrayBuffer(current)) {
        error("invalid_message", "SharedArrayBuffer is not supported", options.phase);
      } else if (isArrayBuffer(current)) {
        reachableTransferables.push(current);
        charge(assertFixedBuffer(current));
      } else if (ArrayBuffer.isView(current)) {
        const view = current as ArrayBufferView & { buffer: ArrayBufferLike; byteLength: number; byteOffset: number };
        if (isSharedArrayBuffer(view.buffer)) error("invalid_message", "SharedArrayBuffer is not supported", options.phase);
        if (!isArrayBuffer(view.buffer)) error("invalid_message", "Unsupported view backing buffer", options.phase);
        const byteLength = assertFixedBuffer(view.buffer);
        if (!Number.isSafeInteger(view.byteLength) || !Number.isSafeInteger(view.byteOffset) || view.byteLength < 0 || view.byteOffset < 0 || view.byteOffset + view.byteLength > byteLength) error("invalid_message", "Invalid buffer view", options.phase);
        if (isTypedArray(current)) {
          const length = (current as unknown as { length: number }).length;
          if (!Number.isSafeInteger(length) || length < 0) error("invalid_message", "Invalid TypedArray length", options.phase);
          assertNoCustomViewProperties(current, length);
        } else rejectCustomKeys(current);
        reachableTransferables.push(view.buffer);
        subtreeDepth = Math.max(subtreeDepth, 1 + child(view.buffer, depth + 1));
        charge(32);
      } else if (isDate(current)) {
        rejectCustomKeys(current);
        if (!Number.isFinite(current.getTime())) error("invalid_message", "Invalid Date", options.phase);
        charge(16);
      } else if (isBlob(current)) {
        rejectCustomKeys(current);
        const size = current.size;
        const type = current.type;
        if (!Number.isSafeInteger(size) || size < 0 || type.length > limits.maxStringLength) error("resource_limit_exceeded", "Blob metadata exceeds DTO budget", options.phase);
        charge(size + type.length * 2);
        if (Object.prototype.toString.call(current) === "[object File]") {
          const name = (current as File).name;
          if (name.length > limits.maxStringLength) error("resource_limit_exceeded", "File name exceeds DTO budget", options.phase);
          charge(name.length * 2);
        }
      } else if (Array.isArray(current)) {
        const keys = ownKeys(current);
        if (keys.some((key) => typeof key !== "string")) error("invalid_message", "Array symbols are not supported", options.phase);
        const names = keys as string[];
        const lengthDescriptor = Object.getOwnPropertyDescriptor(current, "length");
        const length = lengthDescriptor?.value;
        if (!lengthDescriptor || !Number.isSafeInteger(length) || length < 0 || names.length !== length + 1 || !names.includes("length")) error("invalid_message", "Arrays must be dense DTO arrays", options.phase);
        for (let index = 0; index < length; index += 1) {
          const name = String(index);
          if (!names.includes(name)) error("invalid_message", "Arrays must be dense DTO arrays", options.phase);
          const valueAtIndex = descriptorValue(current, name, "Array");
          subtreeDepth = Math.max(subtreeDepth, 1 + child(valueAtIndex, depth + 1));
        }
      } else {
        let prototype: object | null;
        try { prototype = Object.getPrototypeOf(current); } catch { error("invalid_message", "DTO prototype inspection failed", options.phase); }
        if (prototype !== Object.prototype && prototype !== null) error("invalid_message", "DTO records must use Object.prototype or null prototype", options.phase);
        const keys = ownKeys(current);
        for (const key of keys) {
          if (typeof key !== "string") error("invalid_message", "DTO symbols are not supported", options.phase);
          if (key.length > limits.maxFieldNameLength) error("resource_limit_exceeded", "DTO field name limit exceeded", options.phase);
          charge(key.length * 2);
          subtreeDepth = Math.max(subtreeDepth, 1 + child(descriptorValue(current, key, "Record"), depth + 1));
        }
      }
    } finally {
      active.delete(current);
    }
    seen.set(current, subtreeDepth);
    return subtreeDepth;
  };

  walk(value, 0);
  return Object.freeze({ nodes, edges, budgetBytes, messagePorts: Object.freeze(messagePorts), reachableTransferables: Object.freeze(reachableTransferables) });
}

/** 验证 transfer extractor 的原始列表、可达性和数量预算。 */
export interface TransferValidation {
  /** 去重后、与 payload 可达集合一致的 transfer 列表。 */
  readonly transfer: readonly Transferable[];
  /** 与 transfer 上下文一致的生产 DTO walker 结果。 */
  readonly stats: DtoStats;
}

/** 验证 transfer 并返回同一次 walker 的计费结果，避免接收端丢失 transfer 上下文后二次误判。 */
export function validateTransferListWithStats(
  value: unknown,
  transfer: readonly Transferable[] | undefined,
  options: { readonly limits?: RuntimeLimitsInput; readonly phase?: "validate" | "receive" | "dispatch" } = {},
): TransferValidation {
  const limits = normalizeRuntimeLimits(options.limits);
  if (transfer === undefined) {
    const stats = validateDto(value, {
      limits: {
        maxDepth: limits.maxDtoDepth,
        maxNodes: limits.maxDtoNodes,
        maxEdges: limits.maxDtoEdges,
        maxBudgetBytes: limits.maxMessageBudgetBytes,
      },
      transferables: new Set<Transferable>(),
      phase: options.phase ?? "validate",
    });
    return { transfer: Object.freeze([]), stats };
  }
  if (!Array.isArray(transfer) || transfer.length > limits.maxTransferEntries) {
    throw new WebLoomError("transfer_invalid", "Capability transfer list exceeds its bounded entry limit", options.phase ?? "validate");
  }
  const result: Transferable[] = [];
  const seen = new Set<Transferable>();
  let ports = 0;
  for (const item of transfer) {
    if (!isSupportedTransfer(item)) throw new WebLoomError("transfer_invalid", "Capability transfer extractor returned an unsupported resource", options.phase ?? "validate");
    if (seen.has(item)) continue;
    seen.add(item);
    result.push(item);
    if (isMessagePort(item)) ports += 1;
    if (result.length > limits.maxTransfers || ports > limits.maxMessagePorts) throw new WebLoomError("transfer_invalid", "Capability transfer list exceeds its bounded resource limit", options.phase ?? "validate");
  }
  const stats = validateDto(value, {
    limits: {
      maxDepth: limits.maxDtoDepth,
      maxNodes: limits.maxDtoNodes,
      maxEdges: limits.maxDtoEdges,
      maxBudgetBytes: limits.maxMessageBudgetBytes,
    },
    transferables: new Set(result),
    phase: options.phase ?? "validate",
  });
  const reachable = new Set(stats.reachableTransferables);
  if (result.some((item) => !reachable.has(item))) throw new WebLoomError("transfer_invalid", "Capability transfer resource is not reachable from its payload", options.phase ?? "validate");
  return { transfer: Object.freeze(result), stats };
}

export function validateTransferList(
  value: unknown,
  transfer: readonly Transferable[] | undefined,
  options: { readonly limits?: RuntimeLimitsInput; readonly phase?: "validate" | "receive" | "dispatch" } = {},
): readonly Transferable[] {
  return validateTransferListWithStats(value, transfer, options).transfer;
}

/** 对接收端已有的 MessageEvent.ports 建立一次性关闭账本。 */
export interface ReceivePortLedger {
  /** 本次消息实际收到的 raw ports。 */
  readonly ports: readonly MessagePort[];
  /** raw 账本是否通过数量、类型和去重检查。 */
  readonly valid: boolean;
  /** 将所有端口的关闭责任移交业务调用者。 */
  handoff(): void;
  /** 关闭尚未移交的端口；幂等。 */
  closeUndelivered(): void;
}

export function createReceivePortLedger(
  ports: readonly MessagePort[] | undefined,
  options: { readonly limits?: RuntimeLimitsInput; readonly phase?: "validate" | "receive" | "dispatch" } = {},
): ReceivePortLedger {
  const limits = normalizeRuntimeLimits(options.limits);
  const source = Array.isArray(ports) ? ports : [];
  let invalid = ports !== undefined && !Array.isArray(ports);
  invalid = invalid || source.length > limits.maxTransferEntries;
  const unique: MessagePort[] = [];
  const seen = new Set<MessagePort>();
  for (const port of source) {
    if (!isMessagePort(port) || seen.has(port)) invalid = true;
    else { seen.add(port); unique.push(port); }
  }
  if (unique.length > limits.maxMessagePorts) invalid = true;
  let handedOff = false;
  let closed = false;
  const close = (): void => {
    if (closed || handedOff) return;
    closed = true;
    for (const port of unique) { try { port.close(); } catch { /* best effort */ } }
  };
  if (invalid) close();
  return {
    ports: Object.freeze(unique),
    valid: !invalid,
    handoff() { if (!closed) handedOff = true; },
    closeUndelivered: close,
  };
}

/** 比较 extractor 声明的 MessagePort 集合与 MessageEvent.ports。 */
export function assertReceivedPortSet(
  ledger: ReceivePortLedger,
  expected: readonly Transferable[],
  options: { readonly limits?: RuntimeLimitsInput; readonly phase?: "validate" | "receive" | "dispatch" } = {},
): void {
  const expectedPorts = expected.filter(isMessagePort);
  const actual = new Set(ledger.ports);
  const wanted = new Set(expectedPorts);
  if (actual.size !== wanted.size || [...actual].some((port) => !wanted.has(port))) {
    ledger.closeUndelivered();
    throw new WebLoomError("transfer_invalid", "Received MessagePort set does not match the capability transfer declaration", options.phase ?? "receive");
  }
}

/** 在 parser 前检查原始载荷，允许随后由契约 extractor 决定是否接收其中的 port。 */
export function validateRawDto(value: unknown, limits: RuntimeLimitsInput | undefined, phase: "validate" | "receive" = "receive"): DtoStats {
  const normalized = normalizeRuntimeLimits(limits);
  return validateDto(value, {
    limits: { maxDepth: normalized.maxDtoDepth, maxNodes: normalized.maxDtoNodes, maxEdges: normalized.maxDtoEdges, maxBudgetBytes: normalized.maxMessageBudgetBytes },
    allowUnlistedMessagePorts: true,
    phase,
  });
}

function cloneAttributeValue(value: unknown, seen: Map<object, unknown>): unknown {
  if (value === null || typeof value !== "object") return value;
  const existing = seen.get(value);
  if (existing !== undefined) return existing;
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    seen.set(value, result);
    const length = (Object.getOwnPropertyDescriptor(value, "length")?.value ?? 0) as number;
    for (let index = 0; index < length; index += 1) {
      const child = Object.getOwnPropertyDescriptor(value, String(index))?.value;
      result.push(cloneAttributeValue(child, seen));
    }
    return result;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error("Capability attributes must contain only records and arrays");
  const result = Object.create(prototype) as Record<string, unknown>;
  seen.set(value, result);
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) throw new Error("Capability attributes must contain data properties");
    result[key] = cloneAttributeValue(descriptor.value, seen);
  }
  return result;
}

/** 深复制并冻结公开 attributes；输入/输出均经过同一有限 DTO 校验。 */
export function cloneFrozenAttributes(value: Readonly<Record<string, unknown>> | undefined): Readonly<Record<string, unknown>> {
  const source = value ?? {};
  try {
    const stats = validateDto(source, { limits: ATTRIBUTES_DTO_LIMITS, phase: "validate" });
    if (stats.messagePorts.length > 0 || stats.reachableTransferables.length > 0) throw new Error("Capability attributes cannot contain transferable resources");
    if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error("Capability attributes must be a finite record");
    const clone = cloneAttributeValue(source, new Map<object, unknown>());
    const clonedStats = validateDto(clone, { limits: ATTRIBUTES_DTO_LIMITS, phase: "validate" });
    if (!clone || typeof clone !== "object" || Array.isArray(clone) || clonedStats.messagePorts.length > 0 || clonedStats.reachableTransferables.length > 0) throw new Error("Capability attributes must be a finite record");
    const freeze = (current: unknown, seen: Set<object>): void => {
      if (!current || typeof current !== "object" || seen.has(current)) return;
      seen.add(current);
      if (Array.isArray(current)) for (const item of current) freeze(item, seen);
      else for (const key of Object.keys(current)) freeze((current as Record<string, unknown>)[key], seen);
      Object.freeze(current);
    };
    freeze(clone, new Set<object>());
    return clone as Readonly<Record<string, unknown>>;
  } catch (error) {
    if (error instanceof WebLoomError) throw error;
    throw new WebLoomError("invalid_message", "Capability attributes are not a finite cloneable record", "validate");
  }
}
