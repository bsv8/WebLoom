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
      startup: "optional",
      defaultEnabled: true,
      canDisable: true,
      ...metaOverrides,
    },
    ...rest,
  };
}

const runtimeDependency = (
  capability: string,
  sourceRuntime: RuntimeUnitDependency["sourceRuntime"] = "shared-worker",
): RuntimeUnitDependency => ({
  capability,
  contractVersion: `${capability}.v1`,
  sourceRuntime,
});
describe("plugin dependency graph", () => {
  it("aggregates RuntimeUnit capabilities and dependencies", () => {
    const graph = buildPluginGraph([
      plugin("provider", {
        units: [{
          id: "provider.worker",
          runtime: "shared-worker",
          provides: ["remote.asset"],
          providedContracts: { "remote.asset": "remote.asset.v1" },
        }],
      }),
      plugin("consumer", {
        units: [{
          id: "consumer.window",
          runtime: "window-main",
          dependencies: [runtimeDependency("remote.asset")],
        }],
      }),
    ]);

    expect(graph.provides.provider).toEqual(["remote.asset"]);
    expect(graph.dependencies.consumer).toEqual(["remote.asset"]);
    expect(graph.reverse.provider).toMatchObject([{ pluginId: "consumer", capabilities: ["remote.asset"] }]);
  });

  it("matches a cross-Runtime dependency by version and source Runtime", () => {
    const provider = plugin("provider", {
      units: [{
        id: "provider.worker",
        runtime: "shared-worker",
        provides: ["remote.asset"],
        providedContracts: { "remote.asset": "remote.asset.v1" },
      }],
    });
    const consumer = plugin("consumer", {
      units: [{
        id: "consumer.window",
        runtime: "window-main",
        dependencies: [runtimeDependency("remote.asset")],
      }],
    });

    expect(() => validatePluginGraph([provider, consumer], { runtime: "window-main" })).not.toThrow();
  });

  it("rejects a Runtime dependency when the provider contract is not exact", () => {
    const provider = plugin("provider", {
      units: [{
        id: "provider.worker",
        runtime: "shared-worker",
        provides: ["remote.asset"],
        providedContracts: { "remote.asset": "remote.asset.v2" },
      }],
    });
    const consumer = plugin("consumer", {
      units: [{
        id: "consumer.window",
        runtime: "window-main",
        dependencies: [runtimeDependency("remote.asset")],
      }],
    });

    expect(() => validatePluginGraph([provider, consumer], { runtime: "window-main" })).toThrow(/没有匹配的契约版本/);
    try {
      validatePluginGraph([provider, consumer], { runtime: "window-main" });
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
          { id: "multi-runtime.worker", runtime: "shared-worker", provides: ["worker.only"] },
          { id: "multi-runtime.window", runtime: "window-main", provides: ["window.only"] },
        ],
      }),
      plugin("window-consumer", {
        units: [{
          id: "window-consumer.window",
          runtime: "window-main",
          dependencies: [runtimeDependency("window.only", "window-main")],
        }],
      }),
    ];

    const windowGraph = buildPluginGraph(manifests, { runtime: "window-main" });
    expect(windowGraph.provides["multi-runtime"]).toEqual(["window.only"]);
    expect(windowGraph.providers?.["worker.only"]).toBeUndefined();
    expect(windowGraph.units).toMatchObject({
      "multi-runtime:multi-runtime.window": { runtime: "window-main", provides: ["window.only"] },
    });
    expect(() => validatePluginGraph([
      plugin("worker-consumer", {
        units: [{
          id: "worker-consumer.window",
          runtime: "window-main",
          dependencies: [runtimeDependency("worker.only")],
        }],
      }),
      ...manifests,
    ], { runtime: "window-main" })).toThrow(/没有匹配的契约版本|缺少硬依赖能力/);
    expect(buildPluginGraph(manifests).provides["multi-runtime"]).toEqual([]);
  });

  it("does not let an explicit unit inherit product-level runtime declarations", () => {
    const manifest = plugin("unit-only", {
      dependencies: [{ capability: "product-only" }],
      contribution: { domains: [] },
      units: [{
        id: "unit-only.window",
        runtime: "window-main",
        dependencies: [runtimeDependency("unit-only", "window-main")],
      }],
    });

    expect(buildPluginGraph([manifest], { runtime: "window-main" }).dependencies["unit-only"])
      .toEqual(["unit-only"]);
    expect(() => validatePluginGraph([manifest], { runtime: "window-main" }))
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
        runtime: "window-main",
        dependencies: [runtimeDependency("unit-missing")],
      }],
    })])).toThrow(/缺少硬依赖能力/);

    const cycle = [
      plugin("a", { provides: ["a.service"], dependencies: [{ capability: "b.service" }] }),
      plugin("b", { provides: ["b.service"], dependencies: [{ capability: "a.service" }] }),
    ];
    expect(() => validatePluginGraph(cycle)).toThrow(/硬依赖环/);
  });

  it("rejects a RuntimeUnit dependency without an exact Runtime contract", () => {
    const invalidDependency = { capability: "remote.asset" } as unknown as RuntimeUnitDependency;
    expect(() => validatePluginGraph([plugin("invalid-unit", {
      units: [{
        id: "invalid-unit.window",
        runtime: "window-main",
        dependencies: [invalidDependency],
      }],
    })])).toThrow(/依赖契约无效/);
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
