import { describe, expect, it } from "vitest";
import type { PluginManifest, RuntimeUnitDependency } from "../contracts/plugin.js";
import { buildPluginGraph, validatePluginGraph, PluginGraphValidationError } from "./pluginGraph.js";

type PluginOverrides = Omit<Partial<PluginManifest>, "meta"> & {
  meta?: Partial<PluginManifest["meta"]>;
};

function plugin(id: string, options: PluginOverrides = {}): PluginManifest {
  const { meta: metaOverrides, ...rest } = options;
  return {
    id,
    name: id,
    meta: {
      kind: "business",
      startup: "optional",
      defaultEnabled: true,
      canDisable: true,
      ...metaOverrides,
    },
    ...rest,
  };
}

describe("plugin dependency graph", () => {
  const runtimeDependency = (
    capability: string,
    sourceExecution: RuntimeUnitDependency["sourceExecution"] = "coordinator-worker",
    scope: RuntimeUnitDependency["scope"] = "root"
  ): RuntimeUnitDependency => ({
    capability,
    contractVersion: `${capability}.v1`,
    sourceExecution,
    scope,
  });

  it("aggregates runtime-unit capabilities and dependencies", () => {
    const graph = buildPluginGraph([
      plugin("provider", { units: [{ id: "provider.worker", execution: "coordinator-worker", lifetime: "root", provides: ["remote.asset"], providedContracts: { "remote.asset": "remote.asset.v1" } }] }),
      plugin("consumer", { units: [{ id: "consumer.window", execution: "window", lifetime: "owner-session", dependencies: [runtimeDependency("remote.asset")] }] }),
    ]);

    expect(graph.provides.provider).toEqual(["remote.asset"]);
    expect(graph.dependencies.consumer).toEqual(["remote.asset"]);
    expect(graph.reverse.provider).toMatchObject([{ pluginId: "consumer", capabilities: ["remote.asset"] }]);
  });

  it("matches a cross-environment runtime dependency by version, source, and scope", () => {
    const provider = plugin("provider", {
      units: [{
        id: "provider.worker",
        execution: "coordinator-worker",
        lifetime: "root",
        provides: ["remote.asset"],
        providedContracts: { "remote.asset": "remote.asset.v1" },
      }],
    });
    const consumer = plugin("consumer", {
      units: [{
        id: "consumer.window",
        execution: "window",
        lifetime: "owner-session",
        dependencies: [runtimeDependency("remote.asset")],
      }],
    });

    // Window 图不把 Worker capability 当成本地 Provider，但仍须验证
    // 完整 manifest 中确实存在精确的远程契约。
    expect(() => validatePluginGraph([provider, consumer], { execution: "window" })).not.toThrow();
  });

  it("rejects a runtime dependency when the provider contract is not exact", () => {
    const provider = plugin("provider", {
      units: [{
        id: "provider.worker",
        execution: "coordinator-worker",
        lifetime: "root",
        provides: ["remote.asset"],
        providedContracts: { "remote.asset": "remote.asset.v2" },
      }],
    });
    const consumer = plugin("consumer", {
      units: [{
        id: "consumer.window",
        execution: "window",
        lifetime: "owner-session",
        dependencies: [runtimeDependency("remote.asset")],
      }],
    });

    expect(() => validatePluginGraph([provider, consumer], { execution: "window" })).toThrow(/没有匹配的契约版本/);
    try {
      validatePluginGraph([provider, consumer], { execution: "window" });
    } catch (error) {
      expect((error as PluginGraphValidationError).diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "plugin.dependency_contract_unavailable", ids: ["consumer", "remote.asset"] }),
      ]));
    }
  });

  it("does not advertise an unselected Worker unit from a Window graph", () => {
    const manifests = [
      plugin("multi-runtime", {
        units: [
          { id: "multi-runtime.worker", execution: "coordinator-worker", lifetime: "root", provides: ["worker.only"] },
          { id: "multi-runtime.window", execution: "window", lifetime: "owner-session", provides: ["window.only"] },
        ],
      }),
      plugin("window-consumer", {
        units: [{ id: "window-consumer.window", execution: "window", lifetime: "owner-session", dependencies: [runtimeDependency("window.only", "window", "owner-session")] }],
      }),
    ];

    const windowGraph = buildPluginGraph(manifests, { execution: "window" });
    expect(windowGraph.provides["multi-runtime"]).toEqual(["window.only"]);
    expect(windowGraph.providers?.["worker.only"]).toBeUndefined();
    expect(windowGraph.units).toMatchObject({
      "multi-runtime:multi-runtime.window": { execution: "window", provides: ["window.only"] },
    });
    expect(() => validatePluginGraph([
      plugin("worker-consumer", { dependencies: [{ capability: "worker.only" }] }),
      ...manifests,
    ], { execution: "window" })).toThrow(/缺少硬依赖能力/);
    expect(buildPluginGraph(manifests).provides["multi-runtime"]).toEqual([]);
  });

  it("does not let an explicit unit inherit product-level runtime declarations", () => {
    const manifest = plugin("unit-only", {
      dependencies: [{ capability: "product-only" }],
      contribution: { domains: [] },
      units: [{
        id: "unit-only.window",
        execution: "window",
        lifetime: "root",
        dependencies: [runtimeDependency("unit-only")],
      }],
    });

    expect(buildPluginGraph([manifest], { execution: "window" }).dependencies["unit-only"])
      .toEqual(["unit-only"]);
    expect(() => validatePluginGraph([manifest], { execution: "window" }))
      .toThrow(/产品级 fallback/);
  });

  it("reports duplicate providers, missing hard dependencies, and cycles", () => {
    const duplicate = [
      plugin("one", { provides: ["shared"] }),
      plugin("two", { provides: ["shared"] }),
    ];
    expect(() => validatePluginGraph(duplicate)).toThrow(PluginGraphValidationError);
    try {
      validatePluginGraph(duplicate);
    } catch (error) {
      expect((error as PluginGraphValidationError).diagnostics[0]).toMatchObject({ code: "capability.duplicate_provider" });
    }

    expect(() => validatePluginGraph([plugin("consumer", { dependencies: [{ capability: "missing" }] })])).toThrow(/缺少硬依赖能力/);
    expect(() => validatePluginGraph([plugin("unit-consumer", {
      units: [{
        id: "unit-consumer.window",
        execution: "window",
        lifetime: "owner-session",
        dependencies: [runtimeDependency("unit-missing", "coordinator-worker", "root")],
      }],
    })])).toThrow(/缺少硬依赖能力/);

    const cycle = [
      plugin("a", { provides: ["a.service"], dependencies: [{ capability: "b.service" }] }),
      plugin("b", { provides: ["b.service"], dependencies: [{ capability: "a.service" }] }),
    ];
    expect(() => validatePluginGraph(cycle)).toThrow(/硬依赖环/);
  });

  it("rejects a runtime-unit dependency without an exact cross-environment contract", () => {
    const invalidDependency = { capability: "remote.asset" } as unknown as RuntimeUnitDependency;
    expect(() => validatePluginGraph([plugin("invalid-unit", {
      units: [{
        id: "invalid-unit.window",
        execution: "window",
        lifetime: "owner-session",
        dependencies: [invalidDependency],
      }],
    })])).toThrow(/依赖契约无效/);
    try {
      validatePluginGraph([plugin("invalid-unit", {
        units: [{
          id: "invalid-unit.window",
          execution: "window",
          lifetime: "owner-session",
          dependencies: [invalidDependency],
        }],
      })]);
    } catch (error) {
      expect((error as PluginGraphValidationError).diagnostics[0]).toMatchObject({
        code: "plugin.dependency_contract_invalid",
        ids: ["invalid-unit", "invalid-unit.window", "remote.asset"],
      });
    }
  });

  it("allows optional dependencies and explicitly declared multi-provider capabilities", () => {
    const optionalGraph = buildPluginGraph([
      plugin("optional-provider", { provides: ["optional.service"] }),
      plugin("optional-consumer", { dependencies: [{ capability: "optional.service", optional: true }] }),
    ]);
    expect(optionalGraph.optionalDependencies?.["optional-consumer"]).toEqual(["optional.service"]);
    expect(optionalGraph.reverse["optional-provider"]).toBeUndefined();

    expect(() => validatePluginGraph([
      plugin("optional-consumer", { dependencies: [{ capability: "not-installed", optional: true }] }),
    ])).not.toThrow();

    expect(() => validatePluginGraph([
      plugin("one", { provides: ["shared"] }),
      plugin("two", { provides: ["shared"] }),
    ], { multiProviderCapabilities: new Set(["shared"]) })).not.toThrow();
  });
});
