import { describe, expect, it } from "vitest";
import { createRuntimeUnitImplementationRegistry } from "./runtimeUnitImplementationRegistry.js";

describe("RuntimeUnitImplementationRegistry", () => {
  it("按 productId + unitId 隔离执行实现，并拒绝重复项", () => {
    const workerSetup = () => undefined;
    const windowSetup = () => undefined;
    const registry = createRuntimeUnitImplementationRegistry([
      { pluginId: "demo", unitId: "demo.worker", setup: workerSetup },
      { pluginId: "demo", unitId: "demo.window", setup: windowSetup },
    ]);

    expect(registry.get("demo", "demo.worker")).toBe(workerSetup);
    expect(registry.get("demo", "demo.window")).toBe(windowSetup);
    expect(registry.get("other", "demo.worker")).toBeUndefined();
    expect(() => registry.register({ pluginId: "demo", unitId: "demo.worker", setup: workerSetup })).toThrow(/重复注册/u);

    registry.unregister("demo", "demo.worker");
    expect(registry.get("demo", "demo.worker")).toBeUndefined();
  });
});
