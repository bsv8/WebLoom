// WebLoom React 子入口独立回归测试。
//
// 覆盖 Provider/Host 切换、Host 生命周期重渲染、capability 撤销，以及
// useResourceSelector 的相等判断和订阅清理。测试只使用 WebLoom 通用 fake，
// 不依赖具体产品或其它产品包。

// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  PluginHostProvider,
  useOptionalCapability,
  usePluginRuntime,
  useResourceSelector,
} from "../react.js";
import { createRuntimeUnitImplementationRegistry } from "../host/runtimeUnitImplementationRegistry.js";
import { createFakePluginHost } from "../testing/fakes.js";

afterEach(() => {
  cleanup();
});

function CapabilityValue({ capability, onRender }: { capability: string; onRender?: () => void }) {
  onRender?.();
  const value = useOptionalCapability<string>(capability);
  return <output data-testid="capability">{value ?? "missing"}</output>;
}

describe("WebLoom React bindings", () => {
  it("switches Provider hosts and unsubscribes the previous host", async () => {
    const firstHost = createFakePluginHost({ capabilities: { "demo.value": "first" } });
    const secondHost = createFakePluginHost({ capabilities: { "demo.value": "second" } });
    let renders = 0;

    function View() {
      return <CapabilityValue capability="demo.value" onRender={() => { renders += 1; }} />;
    }

    const rendered = render(
      <PluginHostProvider host={firstHost}>
        <View />
      </PluginHostProvider>,
    );
    expect(screen.getByTestId("capability").textContent).toBe("first");

    await act(async () => {
      rendered.rerender(
        <PluginHostProvider host={secondHost}>
          <View />
        </PluginHostProvider>,
      );
    });
    expect(screen.getByTestId("capability").textContent).toBe("second");
    const rendersAfterSwitch = renders;

    // 旧 Host 的通知不应再进入当前 React 树。
    await act(async () => {
      firstHost.provide("old-host-only", true);
    });
    expect(renders).toBe(rendersAfterSwitch);

    await act(async () => {
      secondHost.provide("new-host-only", true);
    });
    await waitFor(() => expect(renders).toBeGreaterThan(rendersAfterSwitch));
  });

  it("rerenders for register, enable, disable, and unregister transitions", async () => {
    const plugin = {
      id: "demo-plugin",
      name: "Demo plugin",
      meta: { defaultEnabled: true, canDisable: true },
    };
    const host = createFakePluginHost({
      runtimeUnitImplementationRegistry: createRuntimeUnitImplementationRegistry([{
        pluginId: plugin.id,
        unitId: plugin.id,
        setup(ctx) {
          ctx.provide("demo.service", "running");
        },
      }]),
    });

    function RuntimeState() {
      const runtime = usePluginRuntime();
      return <output data-testid="runtime-state">{runtime.state(plugin.id).kind}</output>;
    }

    render(
      <PluginHostProvider host={host}>
        <RuntimeState />
      </PluginHostProvider>,
    );
    expect(screen.getByTestId("runtime-state").textContent).toBe("disabled");

    await act(async () => {
      await host.register(plugin);
    });
    await waitFor(() => expect(screen.getByTestId("runtime-state").textContent).toBe("enabled"));

    await act(async () => {
      await host.disable(plugin.id);
    });
    await waitFor(() => expect(screen.getByTestId("runtime-state").textContent).toBe("disabled"));

    await act(async () => {
      await host.enable(plugin.id);
    });
    await waitFor(() => expect(screen.getByTestId("runtime-state").textContent).toBe("enabled"));

    await act(async () => {
      await host.unregister(plugin.id);
    });
    await waitFor(() => expect(screen.getByTestId("runtime-state").textContent).toBe("disabled"));
    expect(host.installed()).not.toContain(plugin.id);
  });

  it("returns the new hook state after a capability is revoked", async () => {
    const host = createFakePluginHost({ capabilities: { "demo.capability": "available" } });

    render(
      <PluginHostProvider host={host}>
        <CapabilityValue capability="demo.capability" />
      </PluginHostProvider>,
    );
    expect(screen.getByTestId("capability").textContent).toBe("available");

    await act(async () => {
      host.capabilities.revoke("demo.capability");
      // capability registry 的直接 revoke 不负责 Host 版本；真实 Host
      // 生命周期会 bump，这里用一次 Host 内建 capability 变更模拟该边界。
      host.provide("revision.tick", true);
    });
    await waitFor(() => expect(screen.getByTestId("capability").textContent).toBe("missing"));
  });

  it("keeps resource selector output stable and removes provider subscriptions", async () => {
    const host = createFakePluginHost();
    let value = 1;
    let subscribeCount = 0;
    let unsubscribeCount = 0;
    const invalidators = new Set<() => void>();
    host.resourceRegistry.register<{ value: number }, readonly string[]>({
      id: "demo.resource",
      scope: "global",
      key: (args) => ["demo.resource", args[0] ?? "default"],
      load: async () => ({ value }),
      subscribe: (_args, _context, invalidate) => {
        subscribeCount += 1;
        invalidators.add(invalidate);
        return () => {
          unsubscribeCount += 1;
          invalidators.delete(invalidate);
        };
      },
      equals: (previous, next) => previous?.value === next?.value,
      invalidation: "immediate",
    });

    let renders = 0;
    function ResourceView() {
      renders += 1;
      const selected = useResourceSelector<{ value: number }, number>(
        host.resourceStore,
        "demo.resource",
        ["stable"],
        (snapshot) => snapshot.data?.value ?? -1,
      );
      return <output data-testid="resource-value">{selected}</output>;
    }

    const rendered = render(<ResourceView />);
    await waitFor(() => expect(screen.getByTestId("resource-value").textContent).toBe("1"));
    expect(subscribeCount).toBe(1);
    const rendersBeforeEqualInvalidation = renders;

    await act(async () => {
      for (const invalidate of invalidators) invalidate();
    });
    await waitFor(() => expect(screen.getByTestId("resource-value").textContent).toBe("1"));
    expect(renders).toBe(rendersBeforeEqualInvalidation);

    value = 2;
    await act(async () => {
      for (const invalidate of invalidators) invalidate();
    });
    await waitFor(() => expect(screen.getByTestId("resource-value").textContent).toBe("2"));

    rendered.unmount();
    expect(unsubscribeCount).toBe(1);
    const rendersAfterUnmount = renders;
    await act(async () => {
      host.resourceStore.invalidate("demo.resource", ["stable"]);
    });
    expect(renders).toBe(rendersAfterUnmount);
  });
});
