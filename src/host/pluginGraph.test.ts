import { describe, expect, it } from "vitest";
import { defineCapability, capabilityDescriptor, capabilityKey } from "../contracts/capability.js";
import type { PluginManifest } from "../contracts/plugin.js";
import { buildPluginGraph, selectRuntimeUnit, validatePluginGraph } from "./pluginGraph.js";

const parser = { parse(value: unknown): { value: string } {
  if (!value || typeof value !== "object" || typeof (value as { value?: unknown }).value !== "string") throw new Error("invalid");
  return value as { value: string };
} };
const result = { parse(value: unknown): { result: string } {
  if (!value || typeof value !== "object" || typeof (value as { result?: unknown }).result !== "string") throw new Error("invalid");
  return value as { result: string };
} };
const Echo = defineCapability({ kind: "rpc", id: "graph.echo", version: "1", request: parser, response: result });

function manifest(id: string, unit: NonNullable<PluginManifest["units"]>[number]): PluginManifest {
  return { id, name: id, startup: "optional", defaultEnabled: true, canDisable: true, units: [unit] };
}

describe("v4 plugin graph", () => {
  it("compares static capability identity, preserves graph order and selects one runtime unit", () => {
    const provider = manifest("provider", { id: "provider.unit", runtime: "window-main", provides: [capabilityDescriptor(Echo)] });
    const consumer = manifest("consumer", { id: "consumer.unit", runtime: "window-main", dependencies: [{ capability: capabilityDescriptor(Echo), sourceRuntime: "window-main" }] });
    const graph = buildPluginGraph([consumer, provider], { runtime: "window-main" });
    const key = capabilityKey(Echo);
    expect(graph.plugins).toEqual(["consumer", "provider"]);
    expect(graph.providers[key]).toEqual(["provider"]);
    expect(graph.dependencies.consumer).toEqual([capabilityDescriptor(Echo)]);
    expect(selectRuntimeUnit(provider, "window-main")?.id).toBe("provider.unit");
    expect(Object.isFrozen(graph)).toBe(true);
  });

  it("rejects missing, ambiguous, cyclic and cross-runtime local dependencies", () => {
    const missing = manifest("missing-consumer", { id: "missing.unit", runtime: "window-main", dependencies: [{ capability: capabilityDescriptor(Echo), sourceRuntime: "window-main" }] });
    expect(() => validatePluginGraph([missing], { runtime: "window-main" })).toThrow(/missing capability/);

    const one = manifest("one", { id: "one.unit", runtime: "window-main", provides: [capabilityDescriptor(Echo)] });
    const two = manifest("two", { id: "two.unit", runtime: "window-main", provides: [capabilityDescriptor(Echo)] });
    expect(() => validatePluginGraph([one, two], { runtime: "window-main" })).toThrow(/ambiguous providers/);

    const cycleA = manifest("cycle-a", { id: "cycle-a.unit", runtime: "window-main", dependencies: [{ capability: capabilityDescriptor(Echo), sourceRuntime: "window-main" }] });
    const cycleB = manifest("cycle-b", { id: "cycle-b.unit", runtime: "window-main", provides: [capabilityDescriptor(Echo)], dependencies: [{ capability: capabilityDescriptor(Echo), sourceRuntime: "window-main" }] });
    expect(() => validatePluginGraph([cycleA, cycleB], { runtime: "window-main" })).toThrow(/cycle|missing|ambiguous/);

    const Local = defineCapability<{ value: number }>({ kind: "local", id: "graph.local", version: "1" });
    const localConsumer = manifest("local-consumer", { id: "local-consumer.unit", runtime: "window-main", dependencies: [{ capability: capabilityDescriptor(Local), sourceRuntime: "shared-worker" }] });
    expect(() => validatePluginGraph([localConsumer], { runtime: "window-main", externalRuntimeDependencies: true })).toThrow(/local capability/);
  });

  it("requires explicit unit selection for multiple applicable units", () => {
    const multi = {
      id: "multi",
      name: "multi",
      startup: "optional" as const,
      defaultEnabled: true,
      canDisable: true,
      units: [
        { id: "a", runtime: "window-main" as const },
        { id: "b", runtime: "window-main" as const },
      ],
    } satisfies PluginManifest;
    expect(selectRuntimeUnit(multi, "window-main")).toBeUndefined();
  });
});
