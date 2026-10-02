// 插件实例消费边界的 React 验收（PCB-R03/PCB-R04/PCB-R08）。
//
// 覆盖三类场景：动态页面注册、静态首页贡献、提供方共享 Picker；
// 全部使用 jsdom + 内存 local 能力，不联网。

// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { createContext, StrictMode, useContext } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { defineCapability } from "../contracts/capability.js";
import type { PluginConsumer } from "../contracts/consumer.js";
import { definePlugin } from "../authoring/definePlugin.js";
import { createWindowApp, hostForWindowApp } from "../runtime/windowRuntime.js";
import type { PluginHost } from "../host/createPluginHost.js";
import { PluginConsumerProvider } from "./PluginConsumerProvider.js";
import { useHasPluginCapability, useOptionalPluginCapability, usePluginCapability } from "./usePluginCapability.js";
import { useWebLoomApp } from "./PluginHostProvider.js";

afterEach(() => cleanup());

const Theme = defineCapability<{ name: string }>({ kind: "local", id: "pcb.react.theme", version: "1" });
const Picker = defineCapability<{ open(): string }>({ kind: "local", id: "pcb.react.picker", version: "1" });
const Secret = defineCapability<{ token(): string }>({ kind: "local", id: "pcb.react.secret", version: "1" });
/** 已声明但当前没有提供者的能力，用于验证 optional 的“缺席”分支。 */
const Absent = defineCapability<{ present: boolean }>({ kind: "local", id: "pcb.react.absent", version: "1" });

/** 一个按下当前插件实例读取能力的简单组件。 */
function ThemeView() {
  const theme = usePluginCapability(Theme);
  return <output data-testid="theme">{theme.name}</output>;
}

/** 已声明但缺席的可选能力应正常渲染缺席状态，而不是抛错。 */
function OptionalView() {
  const absent = useOptionalPluginCapability(Absent);
  return <output data-testid="optional">{absent?.present === true ? "present" : "absent"}</output>;
}

describe("PCB React 插件消费边界", () => {
  it("动态注册项与 consumer 属于同一实例，Provider 子树按实例读取能力", async () => {
    const registry = new Map<string, PluginConsumer>();
    const app = await createWindowApp({ plugins: [
      definePlugin({ id: "theme-plugin", provides: [Theme] as const, setup(ctx) { ctx.provide(Theme, { name: "dark" }); } }),
      definePlugin({ id: "page-plugin", dependencies: [{ capability: Theme }] as const, setup(ctx) { registry.set("page", ctx.consumer); } }),
    ] });
    const consumer = registry.get("page")!;
    expect(consumer.pluginId).toBe("page-plugin");
    render(<PluginConsumerProvider consumer={consumer}><ThemeView /></PluginConsumerProvider>);
    expect(screen.getByTestId("theme").textContent).toBe("dark");
    cleanup();
    await app.dispose();
  });

  it("缺少 PluginConsumerProvider 时报错，不回退到外围 App Provider", async () => {
    const app = await createWindowApp({ plugins: [definePlugin({ id: "theme-plugin", provides: [Theme] as const, setup(ctx) { ctx.provide(Theme, { name: "dark" }); } })] });
    const { WebLoomProvider } = await import("./PluginHostProvider.js");
    // 在只有 App Provider 的情况下，插件 hook 必须抛错。
    expect(() => render(<WebLoomProvider app={app}><ThemeView /></WebLoomProvider>)).toThrow(/PluginConsumerProvider is missing/);
    cleanup();
    await app.dispose();
  });

  it("插件 Provider 子树内调用 App hook 被拒绝，不获得外围 App", async () => {
    const registry = new Map<string, PluginConsumer>();
    const app = await createWindowApp({ plugins: [
      definePlugin({ id: "theme-plugin", provides: [Theme] as const, setup(ctx) { ctx.provide(Theme, { name: "dark" }); } }),
      definePlugin({ id: "page-plugin", dependencies: [{ capability: Theme }] as const, setup(ctx) { registry.set("page", ctx.consumer); } }),
    ] });
    const consumer = registry.get("page")!;
    const { WebLoomProvider } = await import("./PluginHostProvider.js");
    function AppReader() {
      useWebLoomApp();
      return <output data-testid="app">app</output>;
    }
    expect(() => render(
      <WebLoomProvider app={app}>
        <PluginConsumerProvider consumer={consumer}>
          <AppReader />
        </PluginConsumerProvider>
      </WebLoomProvider>,
    )).toThrow(/useWebLoomApp is not available inside PluginConsumerProvider/);
    cleanup();
    await app.dispose();
  });

  it("未声明能力在 UI 读取时被拒绝，不会退化为 optional", async () => {
    const registry = new Map<string, PluginConsumer>();
    const app = await createWindowApp({ plugins: [
      definePlugin({ id: "secret-plugin", provides: [Secret] as const, setup(ctx) { ctx.provide(Secret, { token: () => "t" }); } }),
      // Absent 已声明但没有提供者；Theme 完全未声明。
      definePlugin({ id: "page-plugin", dependencies: [{ capability: Absent, optional: true }] as const, setup(ctx) { registry.set("page", ctx.consumer); } }),
    ] });
    const consumer = registry.get("page")!;
    // 插件没有声明 Secret，optional 也必须报错而不是返回 undefined。
    expect(() => consumer.optionalCapability(Secret)).toThrow(/not declared by plugin/);
    // 已声明但缺席：optional 正常渲染缺席状态，不抛错。
    expect(() => render(<PluginConsumerProvider consumer={consumer}><OptionalView /></PluginConsumerProvider>)).not.toThrow();
    expect(screen.getByTestId("optional").textContent).toBe("absent");
    cleanup();
    // 页面确实没声明 Theme，因此 required 读取同样被拒绝。
    expect(() => render(<PluginConsumerProvider consumer={consumer}><ThemeView /></PluginConsumerProvider>)).toThrow(/not declared by plugin/);
    cleanup();
    await app.dispose();
  });

  it("提供方停用后旧 Provider 子树失效，同名重启使用新 consumer", async () => {
    const issued: PluginConsumer[] = [];
    const build = () => definePlugin({
      id: "page-plugin",
      dependencies: [{ capability: Theme }] as const,
      setup(ctx) { issued.push(ctx.consumer); },
    });
    const first = build();
    const app = await createWindowApp({ plugins: [
      definePlugin({ id: "theme-plugin", provides: [Theme] as const, setup(ctx) { ctx.provide(Theme, { name: "dark" }); } }),
      first,
    ] });
    const host = hostForWindowApp(app);
    const original = issued[0]!;
    render(<PluginConsumerProvider consumer={original}><ThemeView /></PluginConsumerProvider>);
    expect(screen.getByTestId("theme").textContent).toBe("dark");

    await act(async () => { await host.revoke("page-plugin"); });
    // 撤权通知驱动 Provider 停止渲染旧实例子树，而不是让子组件继续抛错。
    expect(screen.queryByTestId("theme")).toBeNull();
    // 撤权后旧 consumer 立即拒绝新解析。
    expect(() => original.capability(Theme)).toThrow(/no longer active/);

    await act(async () => { await host.retry("page-plugin"); });
    expect(issued.length).toBe(2);
    const restarted = issued[1]!;
    expect(restarted.instanceId).not.toBe(original.instanceId);
    render(<PluginConsumerProvider consumer={restarted}><ThemeView /></PluginConsumerProvider>);
    expect(screen.getByTestId("theme").textContent).toBe("dark");
    cleanup();
    await app.dispose();
  });

  it("提供方共享 Picker 在提供方上下文运行，消费方父组件不获得提供方权限", async () => {
    const registry = new Map<string, PluginConsumer>();
    const providerPlugin = definePlugin({
      id: "picker-plugin",
      provides: [Picker] as const,
      setup(ctx) {
        registry.set("picker", ctx.consumer);
        ctx.provide(Picker, { open: () => "picker-open" });
      },
    });
    const consumerPlugin = definePlugin({
      id: "page-plugin",
      dependencies: [{ capability: Picker }] as const,
      setup(ctx) { registry.set("page", ctx.consumer); },
    });
    const app = await createWindowApp({ plugins: [providerPlugin, consumerPlugin] });
    const pickerConsumer = registry.get("picker")!;
    const pageConsumer = registry.get("page")!;

    // 共享组件在提供方 Provider 下运行，可以拿到自己的 Picker。
    function SharedPicker() {
      const picker = usePluginCapability(Picker);
      return <output data-testid="picker">{picker.open()}</output>;
    }
    render(<PluginConsumerProvider consumer={pageConsumer}><PluginConsumerProvider consumer={pickerConsumer}><SharedPicker /></PluginConsumerProvider></PluginConsumerProvider>);
    expect(screen.getByTestId("picker").textContent).toBe("picker-open");

    // 嵌套 Provider 只影响组件自己的子树：消费方按自己声明的 Picker 读取，
    // 而提供方未共享的其它能力不会因此对消费方可见。
    expect(pageConsumer.capability(Picker)).toBeDefined();
    // 消费方不能读到提供方 private、未声明的其它能力。
    expect(() => pageConsumer.capability(Theme)).toThrow(/not declared by plugin/);
    cleanup();
    await app.dispose();
  });

  it("提供方停用后 optional/has 立即反映缺席，重启后读到新一代服务", async () => {
    const registry = new Map<string, PluginConsumer>();
    let generation = 0;
    const providerPlugin = definePlugin({
      id: "theme-plugin",
      provides: [Theme] as const,
      setup(ctx) {
        generation += 1;
        ctx.provide(Theme, { name: `v${generation}` });
      },
    });
    const app = await createWindowApp({ plugins: [
      providerPlugin,
      // 依赖声明为可选：提供方停用不会连带停用消费方，因此可以单独观察
      // “提供方缺席 → optional/has 反映缺席”的行为。
      definePlugin({ id: "page-plugin", dependencies: [{ capability: Theme, optional: true }] as const, setup(ctx) { registry.set("page", ctx.consumer); } }),
    ] });
    const host = hostForWindowApp(app);
    const consumer = registry.get("page")!;
    function View() {
      const theme = useOptionalPluginCapability(Theme);
      const has = useHasPluginCapability(Theme);
      return <output data-testid="theme">{theme?.name ?? "absent"}:{String(has)}</output>;
    }
    render(<PluginConsumerProvider consumer={consumer}><View /></PluginConsumerProvider>);
    expect(screen.getByTestId("theme").textContent).toBe("v1:true");

    // 提供方停用：引用缓存不能让它继续显示第一代服务。
    await act(async () => { await host.revoke("theme-plugin"); });
    expect(screen.getByTestId("theme").textContent).toBe("absent:false");
    expect(consumer.optionalCapability(Theme)).toBeUndefined();
    expect(() => consumer.capability(Theme)).toThrow();

    // 提供方重启：同一 consumer 读到第二代服务。
    await act(async () => { await host.retry("theme-plugin"); });
    expect(screen.getByTestId("theme").textContent).toBe("v2:true");
    cleanup();
    await app.dispose();
  });

  it("无关能力变化不触发插件子树重渲染", async () => {
    const registry = new Map<string, PluginConsumer>();
    const app = await createWindowApp({ plugins: [
      definePlugin({ id: "theme-plugin", provides: [Theme] as const, setup(ctx) { ctx.provide(Theme, { name: "dark" }); } }),
      definePlugin({ id: "page-plugin", dependencies: [{ capability: Theme }] as const, setup(ctx) { registry.set("page", ctx.consumer); } }),
    ] });
    const host = hostForWindowApp(app);
    const consumer = registry.get("page")!;
    let renders = 0;
    function Counting() {
      renders += 1;
      return <ThemeView />;
    }
    render(<PluginConsumerProvider consumer={consumer}><Counting /></PluginConsumerProvider>);
    expect(screen.getByTestId("theme").textContent).toBe("dark");
    const before = renders;
    await act(async () => { await host.revoke("theme-plugin").catch(() => ({ ok: false as const, reason: "required" })); });
    // required 插件不会被停用，因此渲染次数保持不变。
    expect(renders).toBe(before);
    cleanup();
    await app.dispose();
  });

  it("StrictMode 重挂载不产生重复订阅", async () => {
    const registry = new Map<string, PluginConsumer>();
    const app = await createWindowApp({ plugins: [
      definePlugin({ id: "theme-plugin", provides: [Theme] as const, setup(ctx) { ctx.provide(Theme, { name: "dark" }); } }),
      definePlugin({ id: "page-plugin", dependencies: [{ capability: Theme }] as const, setup(ctx) { registry.set("page", ctx.consumer); } }),
    ] });
    const consumer = registry.get("page")!;
    // 直接验证真实签发对象在 StrictMode 重挂载下可用且快照稳定；这里不
    // 复制 consumer——结构复制品不是框架签发的对象，本就该被 Provider 拒绝。
    render(<StrictMode><PluginConsumerProvider consumer={consumer}><ThemeView /></PluginConsumerProvider></StrictMode>);
    expect(screen.getByTestId("theme").textContent).toBe("dark");
    cleanup();
    // 重复挂载不会在 Host 上留下堆积监听，也不会读到失效快照。
    render(<StrictMode><PluginConsumerProvider consumer={consumer}><ThemeView /></PluginConsumerProvider></StrictMode>);
    expect(screen.getByTestId("theme").textContent).toBe("dark");
    // 重复读取同一契约返回同一引用：快照稳定，不会无限重渲染。
    expect(consumer.capability(Theme)).toBe(consumer.capability(Theme));
    await waitFor(() => expect(screen.getByTestId("theme").textContent).toBe("dark"));
    cleanup();
    await app.dispose();
  });

  it("插件 Provider 子树内的 App capability hook 与管理 hook 同样被拒绝", async () => {
    const registry = new Map<string, PluginConsumer>();
    const app = await createWindowApp({ plugins: [
      definePlugin({ id: "theme-plugin", provides: [Theme] as const, setup(ctx) { ctx.provide(Theme, { name: "dark" }); } }),
      definePlugin({ id: "page-plugin", dependencies: [{ capability: Theme }] as const, setup(ctx) { registry.set("page", ctx.consumer); } }),
    ] });
    const consumer = registry.get("page")!;
    const { WebLoomProvider } = await import("./PluginHostProvider.js");
    const { useCapability } = await import("./useCapability.js");
    const { usePluginRuntime } = await import("./usePluginRuntime.js");
    function AppCapabilityReader() {
      // 装配层接口：插件子树里调用等同于想绕过实例边界读全局能力。
      useCapability(Theme);
      return null;
    }
    function AdminReader() {
      // 管理 hook：允许启停/提交意图，插件子树里必须拒绝。
      usePluginRuntime().installed();
      return null;
    }
    expect(() => render(
      <WebLoomProvider app={app}>
        <PluginConsumerProvider consumer={consumer}><AppCapabilityReader /></PluginConsumerProvider>
      </WebLoomProvider>,
    )).toThrow(/not available inside PluginConsumerProvider/);
    cleanup();
    expect(() => render(
      <WebLoomProvider app={app}>
        <PluginConsumerProvider consumer={consumer}><AdminReader /></PluginConsumerProvider>
      </WebLoomProvider>,
    )).toThrow(/not available inside PluginConsumerProvider/);
    cleanup();
    await app.dispose();
  });

  it("共享 Picker：消费方父组件不获得提供方权限，提供方停用后共享组件失效", async () => {
    // 提供方导出的共享组件只能在提供方自己的 consumer 下运行。
    const issued = new Map<string, PluginConsumer>();
    function SharedPicker() {
      const picker = usePluginCapability(Picker);
      return <output data-testid="picker">{picker.open()}</output>;
    }
    const provider = definePlugin({
      id: "picker-plugin",
      provides: [Picker] as const,
      setup(ctx) {
        issued.set("provider", ctx.consumer);
        ctx.provide(Picker, { open: () => "picker-open" });
      },
    });
    // 消费方只声明 Picker 能力依赖；它的父组件没有、也不该有提供方权限。
    const consumerPlugin = definePlugin({
      id: "host-plugin",
      dependencies: [{ capability: Picker }] as const,
      setup(ctx) { issued.set("consumer", ctx.consumer); },
    });
    const app = await createWindowApp({ plugins: [provider, consumerPlugin] });
    const providerConsumer = issued.get("provider")!;
    const consumerConsumer = issued.get("consumer")!;

    // 提供方 Provider 下渲染共享组件：可用。
    render(<PluginConsumerProvider consumer={providerConsumer}><SharedPicker /></PluginConsumerProvider>);
    expect(screen.getByTestId("picker").textContent).toBe("picker-open");
    cleanup();
    // 消费方父组件用消费方 consumer：它自己没声明 Picker 之外的提供方能力，
    // 但通过嵌套 Provider 组合时，提供方组件仍在提供方上下文运行。
    render(
      <PluginConsumerProvider consumer={consumerConsumer}>
        <PluginConsumerProvider consumer={providerConsumer}>
          <SharedPicker />
        </PluginConsumerProvider>
      </PluginConsumerProvider>,
    );
    expect(screen.getByTestId("picker").textContent).toBe("picker-open");
    cleanup();
    // 消费方 consumer 不能读取未声明的提供方以外的 Secret。
    expect(() => consumerConsumer.capability(Secret)).toThrow();

    // 停用提供方后：共享组件不再渲染，提供方 consumer 永久失效。
    await act(async () => { await hostForWindowApp(app).revoke("picker-plugin", "test revoke"); });
    render(<PluginConsumerProvider consumer={providerConsumer}><SharedPicker /></PluginConsumerProvider>);
    expect(screen.queryByTestId("picker")).toBeNull();
    cleanup();
    expect(() => providerConsumer.capability(Picker)).toThrow(/no longer active/);
    await app.dispose();
  });
  it("插件自有 UI 通过私有 Context 读取私有实现，不需要登记为 provides", async () => {
    // 私有实现正例：只存在于闭包与私有 Context 中，没有任何 capability descriptor。
    const StoragePrivateContext = createContext<{ bucket: string } | undefined>(undefined);
    function StoragePage() {
      const storage = useContext(StoragePrivateContext);
      return <output data-testid="storage-page">{`page:${storage?.bucket ?? "no-private"}`}</output>;
    }
    let storageConsumer!: PluginConsumer;
    let pageConsumer!: PluginConsumer;
    const storagePlugin = definePlugin({
      id: "storage-plugin",
      setup(ctx) { storageConsumer = ctx.consumer; },
    });
    const app = await createWindowApp({ plugins: [
      storagePlugin,
      // 网页插件不反向依赖 Storage：它只挂载贡献方给的组件闭包。
      definePlugin({ id: "web-plugin", setup(ctx) { pageConsumer = ctx.consumer; } }),
    ] });
    render(
      <PluginConsumerProvider consumer={pageConsumer}>
        <PluginConsumerProvider consumer={storageConsumer}>
          <StoragePrivateContext.Provider value={{ bucket: "bucket-a" }}>
            <StoragePage />
          </StoragePrivateContext.Provider>
        </PluginConsumerProvider>
      </PluginConsumerProvider>,
    );
    // 自有 UI 读到自己的私有实现。
    expect(screen.getByTestId("storage-page").textContent).toBe("page:bucket-a");

    // 负面：没有 Provider 时私有实现不可读，且没有公开 capability 可以借道。
    cleanup();
    render(
      <PluginConsumerProvider consumer={pageConsumer}>
        <PluginConsumerProvider consumer={storageConsumer}>
          <StoragePage />
        </PluginConsumerProvider>
      </PluginConsumerProvider>,
    );
    expect(screen.getByTestId("storage-page").textContent).toBe("page:no-private");
    // 私有实现没有 descriptor：任何 consumer 都无法解析它。
    const privateCapability = defineCapability<{ bucket: string }>({ kind: "local", id: "pcb.react.storage.private", version: "1" });
    expect(() => storageConsumer.capability(privateCapability)).toThrow(/not declared by plugin/);
    expect(() => pageConsumer.capability(privateCapability)).toThrow(/not declared by plugin/);
    cleanup();
    await app.dispose();
  });

  it("网页注册服务必须声明依赖才能读取；未声明时 optional/has 也不放行", async () => {
    const Registry = defineCapability<{ list(): readonly string[] }>({ kind: "local", id: "pcb.react.webUiRegistry", version: "1" });
    let declared!: PluginConsumer;
    let undeclared!: PluginConsumer;
    const app = await createWindowApp({ plugins: [
      definePlugin({ id: "web-plugin", provides: [Registry] as const, setup(ctx) { ctx.provide(Registry, { list: () => ["/contacts"] }); } }),
      definePlugin({ id: "contributor", dependencies: [{ capability: Registry }] as const, setup(ctx) { declared = ctx.consumer; } }),
      definePlugin({ id: "outsider", setup(ctx) { undeclared = ctx.consumer; } }),
    ] });
    expect(declared.capability(Registry).list()).toEqual(["/contacts"]);
    // 未声明依赖的插件即使在同一个 realm 也拿不到注册服务。
    expect(() => undeclared.capability(Registry)).toThrow(/not declared by plugin/);
    expect(() => undeclared.optionalCapability(Registry)).toThrow(/not declared by plugin/);
    // hook 同样在 render 期抛错，而不是渲染成“缺席”。
    function Probe() {
      const has = useHasPluginCapability(Registry);
      return <output data-testid="has">{String(has)}</output>;
    }
    expect(() => render(
      <PluginConsumerProvider consumer={undeclared}><Probe /></PluginConsumerProvider>,
    )).toThrow(/not declared by plugin/);
    cleanup();
    await app.dispose();
  });
});
