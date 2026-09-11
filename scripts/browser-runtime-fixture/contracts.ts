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
