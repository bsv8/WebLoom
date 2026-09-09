import { describe, expect, it, vi } from "vitest";
import { createPluginHost } from "./createPluginHost.js";
import type { CreatePluginHostOptions } from "./createPluginHost.js";
import type { PluginManifest, PluginSetup } from "../contracts/plugin.js";

function createFixtureHost(options: CreatePluginHostOptions = {}): {
  host: ReturnType<typeof createPluginHost>;
  register(pluginId: string, setup: PluginSetup): void;
} {
  const implementations = new Map<string, PluginSetup>();
  const host = createPluginHost({
    ...options,
    runtimeUnitImplementationRegistry: {
      get(pluginId, unitId) {
        return implementations.get(`${pluginId}:${unitId}`);
      },
    },
  });
  return {
    host,
    register(pluginId, setup) {
      implementations.set(`${pluginId}:${pluginId}`, setup);
    },
  };
}

function manifest(input: Omit<PluginManifest, "setup">): PluginManifest {
  return input;
}

describe("WebLoom Plugin Host", () => {
  it("按依赖顺序启动，并在提供者停止时级联等待依赖者", async () => {
    const events: string[] = [];
    const fixture = createFixtureHost({
      rootAttributes: { session: "one" },
    });
    const { host } = fixture;

    fixture.register("consumer", (ctx) => {
      events.push("consumer:start");
      expect(ctx.extension).toEqual({});
      ctx.onDispose(() => { events.push("consumer:dispose"); });
    });
    fixture.register("provider", (ctx) => {
      events.push("provider:start");
      ctx.provide("service.value", { value: 1 });
      return () => { events.push("provider:teardown"); };
    });
    await host.registerAll([
      manifest({
        id: "consumer",
        name: "Consumer",
        meta: { defaultEnabled: true, canDisable: true },
        dependencies: [{ capability: "service.value" }],
      }),
      manifest({
        id: "provider",
        name: "Provider",
        provides: ["service.value"],
        meta: { defaultEnabled: true, canDisable: true },
      }),
    ]);

    expect(host.state("provider").kind).toBe("enabled");
    expect(host.state("consumer").kind).toBe("enabled");
    expect(events.slice(0, 2)).toEqual(["provider:start", "consumer:start"]);

    await host.disable("provider");
    expect(host.state("provider").kind).toBe("disabled");
    expect(host.state("consumer").kind).toBe("blocked");
    expect(host.state("consumer").desiredEnabled).toBe(true);
    expect(events).toContain("consumer:dispose");
    expect(events).toContain("provider:teardown");
    await host.dispose();
  });

  it("通过 Runtime 实例 Scope、Context Extension 和权限策略隔离实例", async () => {
    let seenScopeId = "";
    let seenExtension: Readonly<Record<string, unknown>> | undefined;
    const fixture = createFixtureHost({
      rootAttributes: { tenant: "alpha" },
      contextExtension: ({ scope }) => ({
        service: { scopeId: scope.identity.scopeId },
      }),
      permissionPolicy: ({ requested }) => ({
        approved: requested.filter((permission) => permission !== "write"),
      }),
    });
    const { host } = fixture;
    fixture.register("isolated", (ctx) => {
      seenScopeId = ctx.scope.identity.scopeId;
      seenExtension = ctx.extension;
      expect(ctx.scope.identity.attributes).toMatchObject({ tenant: "alpha" });
      expect(ctx.permissions).toEqual(["read"]);
      expect(() => ctx.permissionLease.assert("write")).toThrow();
    });

    await host.register({
      ...manifest({
        id: "isolated",
        name: "Isolated",
        permissions: ["read", "write"],
        meta: { defaultEnabled: true, canDisable: true },
      }),
    });

    expect(seenScopeId).not.toBe("");
    expect(seenExtension).toMatchObject({ service: { scopeId: seenScopeId } });
    const firstInstance = host.state("isolated").instanceId;
    await host.disable("isolated");
    await host.enable("isolated");
    expect(host.state("isolated").instanceId).not.toBe(firstInstance);
    await host.dispose();
  });

  it("初始化期间收到 disable 时不发布 enabled 且释放迟到实例", async () => {
    let releaseSetup!: () => void;
    const setupReady = new Promise<void>((resolve) => { releaseSetup = resolve; });
    const cleanup = vi.fn();
    const fixture = createFixtureHost();
    const { host } = fixture;
    fixture.register("slow", async (ctx) => {
      await setupReady;
      ctx.onDispose(cleanup);
    });
    const registering = host.register({
      ...manifest({
        id: "slow",
        name: "Slow",
        meta: { defaultEnabled: true, canDisable: true },
      }),
    });

    await Promise.resolve();
    expect(host.state("slow").kind).toBe("starting");
    const disabling = host.disable("slow");
    releaseSetup();
    await registering;
    await disabling;
    expect(host.state("slow").kind).toBe("disabled");
    expect(cleanup).toHaveBeenCalledTimes(1);
    await host.dispose();
  });
});
