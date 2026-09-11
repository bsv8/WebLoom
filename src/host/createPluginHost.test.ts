import { describe, expect, it } from "vitest";
import { defineCapability } from "../contracts/capability.js";
import { definePlugin } from "../authoring/definePlugin.js";
import { createPluginHost } from "./createPluginHost.js";
import { createRuntimeUnitImplementationRegistry } from "./runtimeUnitImplementationRegistry.js";

const requestParser = { parse(value: unknown): { value: string } {
  if (!value || typeof value !== "object" || typeof (value as { value?: unknown }).value !== "string") throw new Error("value must be a string");
  return value as { value: string };
} };
const responseParser = { parse(value: unknown): { result: string } {
  if (!value || typeof value !== "object" || typeof (value as { result?: unknown }).result !== "string") throw new Error("result must be a string");
  return value as { result: string };
} };

const LocalValue = defineCapability<{ count: number }>({ kind: "local", id: "test.local", version: "1" });
const Echo = defineCapability({ kind: "rpc", id: "test.echo", version: "1", request: requestParser, response: responseParser });

describe("v4 PluginHost", () => {
  it("runs typed local and RPC capabilities through declared plugin setup", async () => {
    const seen: string[] = [];
    const provider = definePlugin({
      id: "provider",
      provides: [LocalValue, Echo] as const,
      startup: "required" as const,
      setup(ctx) {
        ctx.provide(LocalValue, { count: 7 });
        ctx.handle(Echo, async (request, call) => {
          seen.push(`${call.origin}:${call.reference.capabilityId}`);
          return { result: `${request.value}:${ctx.instanceId.length > 0}` };
        });
      },
    });
    const implementations = createRuntimeUnitImplementationRegistry([{
      pluginId: provider.manifest.id,
      unitId: provider.descriptor.id,
      setup: provider.setup,
      capabilities: provider.capabilities,
    }]);
    const host = createPluginHost({ runtimeUnitImplementationRegistry: implementations });
    await host.registerAll([provider.manifest]);

    expect(host.capability(LocalValue)).toEqual({ count: 7 });
    await expect(host.capability(Echo).call({ value: "ok" })).resolves.toEqual({ result: "ok:true" });
    expect(seen).toEqual(["local:test.echo"]);
    expect(host.serviceReferences()).toHaveLength(1);
    await host.dispose();
  });

  it("rejects undeclared capability registration and required policy contradictions", async () => {
    const Other = defineCapability<{ value: number }>({ kind: "local", id: "test.other", version: "1" });
    const bad = definePlugin({
      id: "bad-provider",
      provides: [LocalValue] as const,
      setup(ctx) {
        // @ts-expect-error A plugin may only register a declared local capability.
        ctx.provide(Other, { value: 1 });
      },
    });
    const implementations = createRuntimeUnitImplementationRegistry([{
      pluginId: bad.manifest.id,
      unitId: bad.descriptor.id,
      setup: bad.setup,
      capabilities: bad.capabilities,
    }]);
    const host = createPluginHost({ runtimeUnitImplementationRegistry: implementations });
    await host.registerAll([bad.manifest]);
    expect(host.state("bad-provider").kind).toBe("error-disabled");
    expect(host.serviceReferences()).toEqual([]);
    await host.dispose();

    expect(() => definePlugin({
      id: "invalid-required",
      startup: "required",
      defaultEnabled: false,
      setup() {},
    })).toThrow(/required startup policy/);
  });

  it("keeps required missing dependencies visible", async () => {
    const Missing = defineCapability({ kind: "rpc", id: "test.missing", version: "1", request: requestParser, response: responseParser });
    const required = definePlugin({
      id: "required-consumer",
      dependencies: [{ capability: Missing, sourceRuntime: "window-main" }] as const,
      startup: "required" as const,
      setup() {},
    });
    const implementations = createRuntimeUnitImplementationRegistry([{
      pluginId: required.manifest.id,
      unitId: required.descriptor.id,
      setup: required.setup,
      capabilities: required.capabilities,
    }]);
    const host = createPluginHost({ runtimeUnitImplementationRegistry: implementations });
    await expect(host.registerAll([required.manifest])).rejects.toThrow();
    expect(host.state("required-consumer").kind).toBe("blocked");
    await host.dispose();
  });

  it("turns enable into a durable desired-enabled transition after disable", async () => {
    const plugin = definePlugin({
      id: "reversible",
      provides: [LocalValue] as const,
      setup(ctx) {
        ctx.provide(LocalValue, { count: 11 });
      },
    });
    const implementations = createRuntimeUnitImplementationRegistry([{
      pluginId: plugin.manifest.id,
      unitId: plugin.descriptor.id,
      setup: plugin.setup,
      capabilities: plugin.capabilities,
    }]);
    const host = createPluginHost({ runtimeUnitImplementationRegistry: implementations });
    await host.registerAll([plugin.manifest]);
    const firstInstance = host.state("reversible").instanceId;

    await host.disable("reversible");
    expect(host.state("reversible")).toMatchObject({ kind: "disabled", desiredEnabled: false });

    await host.enable("reversible");
    expect(host.state("reversible")).toMatchObject({ kind: "enabled", desiredEnabled: true });
    expect(host.state("reversible").instanceId).not.toBe(firstInstance);
    expect(host.capability(LocalValue)).toEqual({ count: 11 });
    await host.dispose();
  });
});
