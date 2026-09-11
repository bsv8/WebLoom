import { defineCapability } from "../../src/index.ts";

export interface WorkerRequest {
  readonly type?: string;
  readonly reverse?: boolean;
}

export interface WorkerResponse {
  readonly workerRealm: string;
  readonly setupCount: number;
  readonly workerRuntimeInstanceId: string;
  readonly reverseResult?: string;
  readonly shutdownStarted?: boolean;
}

export const WorkerRpc = defineCapability<WorkerRequest, WorkerResponse>({
  kind: "rpc",
  id: "fixture.worker",
  version: "1",
  request: {
    parse(value: unknown): WorkerRequest {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid worker request");
      const candidate = value as { type?: unknown; reverse?: unknown };
      if (candidate.type !== undefined && typeof candidate.type !== "string") throw new Error("invalid worker request type");
      if (candidate.reverse !== undefined && typeof candidate.reverse !== "boolean") throw new Error("invalid reverse flag");
      return value as WorkerRequest;
    },
  },
  response: {
    parse(value: unknown): WorkerResponse {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid worker response");
      const candidate = value as Record<string, unknown>;
      if (typeof candidate.workerRealm !== "string"
        || !Number.isSafeInteger(candidate.setupCount)
        || typeof candidate.workerRuntimeInstanceId !== "string") throw new Error("invalid worker response");
      if (candidate.reverseResult !== undefined && typeof candidate.reverseResult !== "string") throw new Error("invalid reverse result");
      if (candidate.shutdownStarted !== undefined && typeof candidate.shutdownStarted !== "boolean") throw new Error("invalid shutdown response");
      return value as WorkerResponse;
    },
  },
});

export interface PageRequest {
  readonly value: string;
}

export interface PageResponse {
  readonly result: string;
}

export const PageRpc = defineCapability<PageRequest, PageResponse>({
  kind: "rpc",
  id: "fixture.page",
  version: "1",
  request: {
    parse(value: unknown): PageRequest {
      if (!value || typeof value !== "object" || Array.isArray(value) || typeof (value as { value?: unknown }).value !== "string") {
        throw new Error("invalid page request");
      }
      return value as PageRequest;
    },
  },
  response: {
    parse(value: unknown): PageResponse {
      if (!value || typeof value !== "object" || Array.isArray(value) || typeof (value as { result?: unknown }).result !== "string") {
        throw new Error("invalid page response");
      }
      return value as PageResponse;
    },
  },
});

export interface TransferRequest {
  readonly buffer: ArrayBuffer;
}

export interface TransferResponse {
  readonly buffer: ArrayBuffer;
  readonly byteLength: number;
}

function isArrayBuffer(value: unknown): value is ArrayBuffer {
  return Object.prototype.toString.call(value) === "[object ArrayBuffer]";
}

function isPortLike(value: unknown): value is MessagePort {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<MessagePort>;
  return typeof candidate.postMessage === "function"
    && typeof candidate.start === "function"
    && typeof candidate.close === "function"
    && typeof candidate.addEventListener === "function"
    && typeof candidate.removeEventListener === "function";
}

export const TransferRpc = defineCapability<TransferRequest, TransferResponse>({
  kind: "rpc",
  id: "fixture.transfer",
  version: "1",
  request: {
    parse(value: unknown): TransferRequest {
      if (!value || typeof value !== "object" || !isArrayBuffer((value as { buffer?: unknown }).buffer)) throw new Error("invalid transfer request");
      return value as TransferRequest;
    },
  },
  response: {
    parse(value: unknown): TransferResponse {
      if (!value || typeof value !== "object" || !isArrayBuffer((value as { buffer?: unknown }).buffer) || !Number.isSafeInteger((value as { byteLength?: unknown }).byteLength)) {
        throw new Error("invalid transfer response");
      }
      return value as TransferResponse;
    },
  },
  transfer: {
    request(value) { return [value.buffer]; },
    response(value) { return [value.buffer]; },
  },
});

export type TransferMode = "normal" | "duplicate" | "unreachable";

export interface BusinessPortRequest {
  readonly buffer: ArrayBuffer;
  readonly firstView: Uint8Array;
  readonly secondView: Uint8Array;
  readonly port: MessagePort;
  readonly marker: string;
  readonly transferMode: TransferMode;
  readonly responseTransferMode: TransferMode;
}

export interface BusinessPortResponse {
  readonly buffer: ArrayBuffer;
  readonly firstView: Uint8Array;
  readonly secondView: Uint8Array;
  readonly port: MessagePort;
  readonly marker: string;
  readonly transferMode: TransferMode;
  readonly responseTransferMode: TransferMode;
  readonly byteLength: number;
}

function isTransferMode(value: unknown): value is TransferMode {
  return value === "normal" || value === "duplicate" || value === "unreachable";
}

function requireBusinessPort(value: unknown, field: string): MessagePort {
  if (!isPortLike(value)) throw new Error(`invalid ${field}`);
  return value;
}

function requireSharedView(value: unknown, buffer: ArrayBuffer, field: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.buffer !== buffer || value.byteLength === 0) {
    throw new Error(`invalid ${field}`);
  }
  return value;
}

function unreachablePort(): MessagePort {
  const channel = new MessageChannel();
  channel.port1.close();
  channel.port2.close();
  return channel.port1;
}

export const BusinessPortRpc = defineCapability<BusinessPortRequest, BusinessPortResponse>({
  kind: "rpc",
  id: "fixture.business-port",
  version: "1",
  request: {
    parse(value: unknown): BusinessPortRequest {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid business port request");
      const candidate = value as Record<string, unknown>;
      if (!isArrayBuffer(candidate.buffer) || typeof candidate.marker !== "string" || !isTransferMode(candidate.transferMode) || !isTransferMode(candidate.responseTransferMode)) {
        throw new Error("invalid business port request");
      }
      return {
        buffer: candidate.buffer,
        firstView: requireSharedView(candidate.firstView, candidate.buffer, "business request first view"),
        secondView: requireSharedView(candidate.secondView, candidate.buffer, "business request second view"),
        port: requireBusinessPort(candidate.port, "business request port"),
        marker: candidate.marker,
        transferMode: candidate.transferMode,
        responseTransferMode: candidate.responseTransferMode,
      };
    },
  },
  response: {
    parse(value: unknown): BusinessPortResponse {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid business port response");
      const candidate = value as Record<string, unknown>;
      if (!isArrayBuffer(candidate.buffer) || typeof candidate.marker !== "string" || !isTransferMode(candidate.transferMode) || !isTransferMode(candidate.responseTransferMode) || !Number.isSafeInteger(candidate.byteLength)) {
        throw new Error("invalid business port response");
      }
      return {
        buffer: candidate.buffer,
        firstView: requireSharedView(candidate.firstView, candidate.buffer, "business response first view"),
        secondView: requireSharedView(candidate.secondView, candidate.buffer, "business response second view"),
        port: requireBusinessPort(candidate.port, "business response port"),
        marker: candidate.marker,
        transferMode: candidate.transferMode,
        responseTransferMode: candidate.responseTransferMode,
        byteLength: candidate.byteLength,
      };
    },
  },
  transfer: {
    request(value) {
      if (value.transferMode === "duplicate") return [value.buffer, value.port, value.buffer, value.port];
      if (value.transferMode === "unreachable") return [value.buffer, unreachablePort()];
      return [value.buffer, value.port];
    },
    response(value) {
      if (value.responseTransferMode === "duplicate") return [value.buffer, value.port, value.buffer, value.port];
      if (value.responseTransferMode === "unreachable") return [value.buffer, unreachablePort()];
      return [value.buffer, value.port];
    },
  },
});

export interface BusinessPortStreamRequest {
  readonly buffer: ArrayBuffer;
  readonly firstView: Uint8Array;
  readonly secondView: Uint8Array;
  readonly port: MessagePort;
  readonly count: number;
  readonly delayMs: number;
  readonly transferMode: TransferMode;
  readonly itemTransferMode: TransferMode;
}

export interface BusinessPortStreamItem {
  readonly index: number;
  readonly buffer: ArrayBuffer;
  readonly firstView: Uint8Array;
  readonly secondView: Uint8Array;
  readonly port: MessagePort;
  readonly transferMode: TransferMode;
}

export const BusinessPortEvents = defineCapability<BusinessPortStreamRequest, BusinessPortStreamItem>({
  kind: "stream",
  id: "fixture.business-port-events",
  version: "1",
  request: {
    parse(value: unknown): BusinessPortStreamRequest {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid business stream request");
      const candidate = value as Record<string, unknown>;
      if (!isArrayBuffer(candidate.buffer) || !Number.isSafeInteger(candidate.count) || (candidate.count as number) < 0 || !Number.isSafeInteger(candidate.delayMs) || (candidate.delayMs as number) < 0 || !isTransferMode(candidate.transferMode) || !isTransferMode(candidate.itemTransferMode)) {
        throw new Error("invalid business stream request");
      }
      return {
        buffer: candidate.buffer,
        firstView: requireSharedView(candidate.firstView, candidate.buffer, "business stream request first view"),
        secondView: requireSharedView(candidate.secondView, candidate.buffer, "business stream request second view"),
        port: requireBusinessPort(candidate.port, "business stream request port"),
        count: candidate.count as number,
        delayMs: candidate.delayMs as number,
        transferMode: candidate.transferMode,
        itemTransferMode: candidate.itemTransferMode,
      };
    },
  },
  item: {
    parse(value: unknown): BusinessPortStreamItem {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid business stream item");
      const candidate = value as Record<string, unknown>;
      if (!Number.isSafeInteger(candidate.index) || !isArrayBuffer(candidate.buffer) || !isTransferMode(candidate.transferMode)) throw new Error("invalid business stream item");
      return {
        index: candidate.index as number,
        buffer: candidate.buffer,
        firstView: requireSharedView(candidate.firstView, candidate.buffer, "business stream item first view"),
        secondView: requireSharedView(candidate.secondView, candidate.buffer, "business stream item second view"),
        port: requireBusinessPort(candidate.port, "business stream item port"),
        transferMode: candidate.transferMode,
      };
    },
  },
  transfer: {
    request(value) {
      if (value.transferMode === "duplicate") return [value.buffer, value.port, value.buffer, value.port];
      if (value.transferMode === "unreachable") return [value.buffer, unreachablePort()];
      return [value.buffer, value.port];
    },
    item(value) {
      if (value.transferMode === "duplicate") return [value.buffer, value.port, value.buffer, value.port];
      if (value.transferMode === "unreachable") return [value.buffer, unreachablePort()];
      return [value.buffer, value.port];
    },
  },
});

export interface EventRequest {
  readonly count: number;
}

export const Events = defineCapability<EventRequest, number>({
  kind: "stream",
  id: "fixture.events",
  version: "1",
  request: {
    parse(value: unknown): EventRequest {
      if (!value || typeof value !== "object" || !Number.isSafeInteger((value as { count?: unknown }).count) || (value as { count: number }).count < 0) {
        throw new Error("invalid event request");
      }
      return value as EventRequest;
    },
  },
  item: {
    parse(value: unknown): number {
      if (!Number.isSafeInteger(value)) throw new Error("invalid event item");
      return value as number;
    },
  },
});
