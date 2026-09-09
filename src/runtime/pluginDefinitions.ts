import type {
  PluginDefinition,
} from "../authoring/definePlugin.js";
import type {
  PluginDependency,
  PluginManifest,
  PluginManifestInput,
  RuntimeUnitDescriptor,
  RuntimeUnitDescriptorInput,
} from "../contracts/plugin.js";
import {
  defineRuntimeUnitProvidedContracts,
  runtimeCapabilityContractVersion,
} from "../contracts/plugin.js";
import type { RuntimeKind } from "../contracts/lifecycle.js";

// Runtime assembly intentionally accepts definitions with product-specific
// config/contribution/extension generics. The materializer normalizes those
// values into the framework's structural manifest before Host registration;
// keeping this boundary generic avoids making every author cast a valid
// definePlugin() result just to call createWindowApp().
export type RuntimePluginDefinition = PluginDefinition<any, any, any> | {
  readonly manifest: PluginManifest | PluginManifestInput;
  readonly setup: import("../contracts/plugin.js").PluginSetup<any, any>;
  /** 多 unit manifest 中 setup 所实现的目标 unit；单一匹配 unit 可省略。 */
  readonly unitId?: string;
};

export interface MaterializedPluginDefinition {
  readonly manifest: PluginManifest;
  /** 当前 Runtime 中由 setup 实现的 unit。 */
  readonly unitId: string;
  readonly setup: import("../contracts/plugin.js").PluginSetup;
}

function normalizeProductDependencies(
  dependencies: readonly PluginDependency[] | undefined,
  runtime: RuntimeKind,
) {
  return dependencies?.map((dependency) => ({
    capability: dependency.capability,
    contractVersion: dependency.contractVersion ?? runtimeCapabilityContractVersion(dependency.capability),
    sourceRuntime: dependency.sourceRuntime ?? runtime,
    ...(dependency.reason !== undefined ? { reason: dependency.reason } : {}),
    ...(dependency.optional !== undefined ? { optional: dependency.optional } : {}),
  }));
}

/** 将作者定义绑定到真实 Runtime；不把 setup 复制进 manifest。 */
export function materializePluginDefinition(
  input: RuntimePluginDefinition,
  runtime: RuntimeKind,
): MaterializedPluginDefinition {
  const manifest = input.manifest;
  const setup = input.setup;
  if (!manifest || typeof manifest.id !== "string" || manifest.id.trim() === "") {
    throw new Error("Plugin manifest id must be a non-empty string");
  }
  const existingUnits: readonly RuntimeUnitDescriptorInput[] = (manifest.units ?? []) as readonly RuntimeUnitDescriptorInput[];
  const requestedUnitId = "unitId" in input ? input.unitId : undefined;
  const matchingUnits = existingUnits.filter((unit) => unit.runtime === undefined || unit.runtime === runtime);
  let implementationUnitId: string;
  if (existingUnits.length === 0) {
    implementationUnitId = manifest.id;
  } else if (requestedUnitId !== undefined) {
    const selected = existingUnits.find((unit) => unit.id === requestedUnitId);
    if (!selected) throw new Error(`Plugin "${manifest.id}" does not declare unit "${requestedUnitId}"`);
    if (selected.runtime !== undefined && selected.runtime !== runtime) {
      throw new Error(`Plugin "${manifest.id}" unit "${requestedUnitId}" targets ${selected.runtime}, not ${runtime}`);
    }
    implementationUnitId = selected.id;
  } else if (matchingUnits.length === 1 && matchingUnits[0]) {
    implementationUnitId = matchingUnits[0].id;
  } else {
    throw new Error(
      `Plugin "${manifest.id}" has ${matchingUnits.length} implementation units for ${runtime}; specify unitId explicitly`,
    );
  }
  const selectedUnit = existingUnits.length > 0
    ? existingUnits.find((unit) => unit.id === implementationUnitId)
    : undefined;
  const units: RuntimeUnitDescriptor[] = selectedUnit
    ? [(() => {
        const unitRuntime = selectedUnit.runtime ?? runtime;
        const provides = [...(selectedUnit.provides ?? [])];
        const dependencies = selectedUnit.dependencies?.map((dependency): import("../contracts/plugin.js").RuntimeUnitDependency => ({
          capability: dependency.capability,
          contractVersion: dependency.contractVersion ?? runtimeCapabilityContractVersion(dependency.capability),
          sourceRuntime: dependency.sourceRuntime ?? unitRuntime,
          ...(dependency.reason !== undefined ? { reason: dependency.reason } : {}),
          ...(dependency.optional !== undefined ? { optional: dependency.optional } : {}),
        }));
        return {
          ...selectedUnit,
          runtime: unitRuntime,
          dependencies,
          ...(provides.length > 0
            ? { providedContracts: { ...defineRuntimeUnitProvidedContracts(provides), ...(selectedUnit.providedContracts ?? {}) } }
            : {}),
        };
      })()]
    : [{
        id: manifest.id,
        runtime,
        dependencies: normalizeProductDependencies(manifest.dependencies, runtime),
        ...(manifest.provides && manifest.provides.length > 0 ? {
          provides: [...manifest.provides],
          providedContracts: defineRuntimeUnitProvidedContracts(manifest.provides),
        } : {}),
        ...(manifest.permissions !== undefined ? { permissions: [...manifest.permissions] } : {}),
        ...(manifest.config !== undefined ? { config: manifest.config } : {}),
        ...(manifest.contribution !== undefined ? { contribution: manifest.contribution } : {}),
      }];
  const normalized: PluginManifest = {
    ...manifest,
    units,
    // Product-level declarations are retained only for compatibility with
    // low-level manifests; the selected unit is the source of truth in Host.
  };
  return { manifest: normalized, unitId: implementationUnitId, setup };
}

export function materializePluginDefinitions(
  inputs: readonly RuntimePluginDefinition[],
  runtime: RuntimeKind,
): MaterializedPluginDefinition[] {
  return inputs.map((input) => materializePluginDefinition(input, runtime));
}
