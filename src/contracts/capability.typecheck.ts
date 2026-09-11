import { defineCapability } from "./capability.js";
import type {
  RemoteCapability,
  RpcCapability,
  RpcClient,
  RuntimeHandle,
  StreamClient,
} from "../index.js";

const requestParser = {
  parse(value: unknown): { value: string } {
    if (!value || typeof value !== "object" || typeof (value as { value?: unknown }).value !== "string") {
      throw new Error("invalid request");
    }
    return value as { value: string };
  },
};
const responseParser = {
  parse(value: unknown): { result: string } {
    if (!value || typeof value !== "object" || typeof (value as { result?: unknown }).result !== "string") {
      throw new Error("invalid response");
    }
    return value as { result: string };
  },
};
const itemParser = { parse(value: unknown): number { if (!Number.isInteger(value)) throw new Error("invalid item"); return value as number; } };

const LocalValue = defineCapability<{ count: number }>({ kind: "local", id: "typecheck.local", version: "1" });
const Echo = defineCapability({ kind: "rpc", id: "typecheck.echo", version: "1", request: requestParser, response: responseParser });
const Events = defineCapability({ kind: "stream", id: "typecheck.events", version: "1", request: requestParser, item: itemParser });

declare const runtime: RuntimeHandle;
declare const rpc: RpcClient<typeof Echo>;
declare const stream: StreamClient<typeof Events>;

rpc.call({ value: "ok" });
// @ts-expect-error RPC request must be inferred from the capability parser.
rpc.call({ value: 1 });

// @ts-expect-error RPC result type must remain tied to the same capability.
const wrongResponse: Promise<{ result: number }> = rpc.call({ value: "ok" });
void wrongResponse;

stream.subscribe({ value: "topic" }, {
  onNext(item) {
    // @ts-expect-error stream item type must be inferred from the item parser.
    const wrongItem: string = item;
    void wrongItem;
  },
});

// @ts-expect-error a local capability cannot cross a Runtime peer boundary.
runtime.capability(LocalValue);

// @ts-expect-error remote capability lookup requires the typed capability object, not a legacy string.
runtime.capability("typecheck.echo");

// @ts-expect-error an explicitly declared request type rejects a parser with a different output type.
const wrongParser: RpcCapability<{ value: string }, { result: string }> = defineCapability({
  kind: "rpc",
  id: "typecheck.wrong-parser",
  version: "1",
  request: { parse: (_value: unknown): number => 1 },
  response: responseParser,
});
void wrongParser;

// Keep the public constraint visible to the fixture itself.
declare const remote: RemoteCapability;
void remote;
