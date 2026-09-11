// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { defineCapability } from "../contracts/capability.js";
import { definePlugin } from "../authoring/definePlugin.js";
import { createWindowApp, hostForWindowApp } from "../runtime/windowRuntime.js";
import { WebLoomProvider } from "./PluginHostProvider.js";
import { useOptionalCapability } from "./useCapability.js";
import { usePluginRuntime, usePluginState } from "./usePluginRuntime.js";

afterEach(() => cleanup());

const Value = defineCapability<{ value: string }>({ kind: "local", id: "react.value", version: "1" });
const Other = defineCapability<{ value: string }>({ kind: "local", id: "react.other", version: "1" });

function CapabilityView({ onRender }: { onRender?: () => void }) {
  onRender?.();
  const value = useOptionalCapability(Value);
  return <output data-testid="value">{value?.value ?? "missing"}</output>;
}

describe("v4 React bindings", () => {
  it("switches the App Provider and unsubscribes the previous App", async () => {
    const first = await createWindowApp({ plugins: [definePlugin({ id: "first", provides: [Value] as const, setup(ctx) { ctx.provide(Value, { value: "first" }); } })] });
    const second = await createWindowApp({ plugins: [definePlugin({ id: "second", provides: [Value] as const, setup(ctx) { ctx.provide(Value, { value: "second" }); } })] });
    let renders = 0;
    const view = render(<WebLoomProvider app={first}><CapabilityView onRender={() => { renders += 1; }} /></WebLoomProvider>);
    expect(screen.getByTestId("value").textContent).toBe("first");
    await act(async () => { view.rerender(<WebLoomProvider app={second}><CapabilityView onRender={() => { renders += 1; }} /></WebLoomProvider>); });
    expect(screen.getByTestId("value").textContent).toBe("second");
    const afterSwitch = renders;
    await first.dispose();
    expect(renders).toBe(afterSwitch);
    await second.dispose();
  });

  it("does not rerender a capability consumer for an unrelated App change", async () => {
    const app = await createWindowApp({ plugins: [
      definePlugin({ id: "value", provides: [Value] as const, startup: "required" as const, setup(ctx) { ctx.provide(Value, { value: "stable" }); } }),
      definePlugin({ id: "other", provides: [Other] as const, setup(ctx) { ctx.provide(Other, { value: "other" }); } }),
    ] });
    const host = hostForWindowApp(app);
    let renders = 0;
    render(<WebLoomProvider app={app}><CapabilityView onRender={() => { renders += 1; }} /></WebLoomProvider>);
    expect(screen.getByTestId("value").textContent).toBe("stable");
    const before = renders;
    await act(async () => { await host.disable("other"); });
    await waitFor(() => expect(host.state("other").kind).toBe("disabled"));
    expect(screen.getByTestId("value").textContent).toBe("stable");
    expect(renders).toBe(before);
    await app.dispose();
  });

  it("exposes typed plugin lifecycle state through the App Provider", async () => {
    const app = await createWindowApp({ plugins: [definePlugin({ id: "lifecycle", setup() {} })] });
    function StateView() {
      const state = usePluginState("lifecycle");
      const runtime = usePluginRuntime();
      return <output data-testid="state">{`${state?.kind}:${runtime.isEnabled("lifecycle")}`}</output>;
    }
    render(<WebLoomProvider app={app}><StateView /></WebLoomProvider>);
    expect(screen.getByTestId("state").textContent).toBe("enabled:true");
    await hostForWindowApp(app).disable("lifecycle");
    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("disabled:false"));
    await app.dispose();
  });
});
