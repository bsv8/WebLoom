// 插件服务模型与所属 UI 的真实浏览器验收（PSM-R08 / PSM-R10）。
//
// 覆盖：动态页面注册、静态首页贡献、提供方共享 Picker、网页插件挂载贡献方注册的
// 页面/设置块/指示灯三类 UI，以及私有实现不可解析、越权注销、撤权清理等负面断言。
// 所有渲染都用真实的 PluginConsumerProvider + hooks；结果写进
// window.__WEBLOOM_PCB_RESULT__ 供 real-browser-runtime-smoke.mjs 断言。

import { createContext, createElement, StrictMode, useContext, type ReactElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import {
  PluginConsumerProvider,
  WebLoomProvider,
  useHasPluginCapability,
  useOptionalPluginCapability,
  usePluginCapability,
  useWebLoomApp,
} from "../../src/react.ts";
import { createWindowApp, definePlugin, RESOURCE_REGISTRY, type PluginConsumer } from "../../src/index.ts";
import { hostForWindowApp } from "../../src/runtime/windowRuntime.ts";
import {
  Absent,
  Picker,
  Theme,
  WEB_UI_REGISTRY,
  type RegisteredPage,
  type WebUiEntry,
  type WebUiRegistryTarget,
} from "./plugin-consumer-contracts.ts";
import { createScopedRegistryView } from "../../src/advanced.ts";

declare global {
  interface Window {
    __WEBLOOM_PCB_RESULT__?: Record<string, unknown>;
  }
}

/** 场景一：动态页面按本实例身份读取主题能力。 */
function DynamicPage() {
  const theme = usePluginCapability(Theme);
  return createElement("output", { id: "page-theme" }, theme.name);
}

/** 已声明但缺席的可选能力：应渲染缺席状态而不是抛错。 */
function OptionalBadge() {
  const absent = useOptionalPluginCapability(Absent);
  const has = useHasPluginCapability(Absent);
  return createElement("output", { id: "page-optional" }, `${absent?.present === true ? "present" : "absent"}:${String(has)}`);
}

/** 提供方导出的共享组件；它只能在提供方自己的 Provider 下运行。 */
function SharedPicker() {
  const picker = usePluginCapability(Picker);
  return createElement("output", { id: "shared-picker" }, picker.open());
}

/**
 * Storage 私有实现的 React Context。
 *
 * 这是“插件自己的 UI 访问自己的私有实现”的通道：值只在贡献插件的闭包与 Provider
 * 里存在，没有任何 capability descriptor，其他插件拿不到。
 */
const StoragePrivateContext = createContext<StoragePrivate | undefined>(undefined);

/** 假 Storage 的私有实现；不对外发布。 */
interface StoragePrivate {
  readonly bucket: string;
  readonly save: (path: string, data: string) => string;
}

/** 存储页面：读取私有 Context，不经过任何公开 capability。 */
function StoragePage() {
  const storage = useContext(StoragePrivateContext);
  return createElement("output", { id: "storage-page" }, `page:${storage?.save("contacts", "v1") ?? "no-private"}`);
}

/** 存储设置块：同一个私有实现，不重复声明权限。 */
function StorageSettings() {
  const storage = useContext(StoragePrivateContext);
  return createElement("output", { id: "storage-settings" }, `settings:${storage?.bucket ?? "no-private"}`);
}

/** 存储指示灯：第三个 UI 接口，同样只用自己的私有实现。 */
function StorageHeader() {
  const storage = useContext(StoragePrivateContext);
  return createElement("output", { id: "storage-header" }, `header:${storage?.bucket ?? "no-private"}`);
}

/** 网页插件按贡献方 consumer 挂载一个已注册条目。 */
function MountedWebUi({ entry }: { readonly entry: WebUiEntry }) {
  return createElement(
    PluginConsumerProvider,
    { consumer: entry.consumer },
    createElement(entry.render),
  );
}

/** 网页插件自己的挂载容器：按 kind 分组渲染，不接触贡献方的私有实现。 */
function WebUiSurface({ entries }: { readonly entries: readonly WebUiEntry[] }) {
  return createElement(
    "div",
    { id: "web-ui-surface" },
    entries.map((entry) => createElement(
      "section",
      { key: entry.id, "data-kind": entry.kind },
      createElement(MountedWebUi, { entry }),
    )),
  );
}

/** 静态首页贡献：只用本实例的 consumer 读取能力，不依赖 App。 */
function HomeContribution() {
  const theme = usePluginCapability(Theme);
  return createElement("output", { id: "home-theme" }, `home:${theme.name}`);
}

/** 负面用例：在插件 Provider 内调用 App hook，必须被拒绝。 */
function AppHookProbe() {
  useWebLoomApp();
  return createElement("output", { id: "app-probe" }, "unreachable");
}

/** 渲染一段子树；Provider 撤权后由 Provider 自己停止渲染旧子树。 */
function Boundary({ consumer, children }: { readonly consumer: PluginConsumer; readonly children: ReactNode[] }) {
  return createElement(PluginConsumerProvider, { consumer }, ...children);
}

async function run(): Promise<Record<string, unknown>> {
  const issued = new Map<string, PluginConsumer[]>();
  const issue = (key: string, consumer: PluginConsumer): void => {
    const list = issued.get(key) ?? [];
    list.push(consumer);
    issued.set(key, list);
  };
  // 下游自己的注册表：这里只保留 id、所属实例和 consumer。结构、排序与跳转
  // 仍由下游定义，框架只保证 consumer 与真实实例一致。
  let registeredPage: RegisteredPage | undefined;

  // 主题插件只发布公开的 Theme。
  const themePlugin = definePlugin({
    id: "pcb-theme-plugin",
    provides: [Theme] as const,
    setup(ctx) {
      ctx.provide(Theme, { name: "dark" });
    },
  });
  // 动态页面插件：捕获 setup 阶段的 consumer，登记页面与实例资源。
  const pagePlugin = definePlugin({
    id: "pcb-page-plugin",
    // RESOURCE_REGISTRY 是 Host 内置的 local 能力，但仍然必须显式声明：
    // 框架不因为它是内置能力就免检，未声明的读取会被拒绝。
    dependencies: [{ capability: Theme }, { capability: Absent, optional: true }, { capability: RESOURCE_REGISTRY }] as const,
    setup(ctx) {
      issue("page", ctx.consumer);
      registeredPage = { instanceId: ctx.instanceId, pluginId: ctx.pluginId, consumer: ctx.consumer };
      ctx.capability(RESOURCE_REGISTRY).register({
        id: "pcb.profile",
        scope: "plugin",
        invalidation: "immediate",
        key: () => ["pcb.profile"],
        load: async () => "owner-scoped-profile",
      });
    },
  });
  // 提供方导出的共享 Picker。
  const pickerPlugin = definePlugin({
    id: "pcb-picker-plugin",
    provides: [Picker] as const,
    setup(ctx) {
      issue("picker", ctx.consumer);
      ctx.provide(Picker, { open: () => "picker-open" });
    },
  });
  // 负面：没有声明内置资源注册表的插件，读取必须被拒绝，且不会登记资源。
  let undeclaredRegistryRejected = false;
  const undeclaredPlugin = definePlugin({
    id: "pcb-undeclared-registry",
    dependencies: [{ capability: Theme }] as const,
    setup(ctx) {
      try {
        ctx.capability(RESOURCE_REGISTRY).register({
          id: "pcb.sneaked",
          scope: "plugin",
          invalidation: "immediate",
          key: () => ["pcb.sneaked"],
          load: async () => "sneaked",
        });
      } catch {
        undeclaredRegistryRejected = true;
      }
    },
  });

  // 网页插件：只提供 typed UI 注册服务，不声明任何业务插件依赖。
  const webEntries: WebUiEntry[] = [];
  let webPlugin!: PluginConsumer;
  const webPluginDefinition = definePlugin({
    id: "psm-web-plugin",
    provides: [WEB_UI_REGISTRY] as const,
    setup(ctx) {
      webPlugin = ctx.consumer;
      // 注册表目标由网页插件自己实现；归属绑定与越权注销由框架 facade 完成。
      const target: WebUiRegistryTarget = {
        register(entry) {
          webEntries.push(entry);
        },
        update(id, patch) {
          const index = webEntries.findIndex((item) => item.id === id);
          if (index < 0) return;
          webEntries[index] = { ...webEntries[index]!, ...patch };
        },
        unregister(id) {
          const index = webEntries.findIndex((item) => item.id === id);
          if (index >= 0) webEntries.splice(index, 1);
        },
        list() { return [...webEntries]; },
        ownerOf(id) { return webEntries.find((item) => item.id === id)?.ownerInstanceId; },
      };
      ctx.provide(WEB_UI_REGISTRY, target);
    },
  });

  /**
   * 假 Storage：私有实现只在闭包与私有 Context 中；三类 UI 通过网页注册服务登记，
   * 条目携带自己的 consumer，网页插件挂载时不接触私有实现。
   */
  const buildStorage = (id: string, bucket: string) => definePlugin({
    id,
    dependencies: [{ capability: WEB_UI_REGISTRY }] as const,
    setup(ctx) {
      issue(`storage:${id}`, ctx.consumer);
      // 私有实现：不对外登记为 capability。
      const storage: StoragePrivate = {
        bucket,
        save: (path, data) => `${bucket}/${path}=${data}`,
      };
      const register = createScopedRegistryView(
        ctx.capability(WEB_UI_REGISTRY),
        ctx.scope,
        {
          name: "web-ui",
          registrations: [{
            method: "register",
            idArgument: 0,
            unregisterMethod: "unregister",
            ownerInstanceIdProperty: "ownerInstanceId",
          }],
        },
      );
      // 三类 UI 各自一个组件闭包，内部包住同一个私有 Context。
      // 子组件必须作为元素进入 Provider 子树：直接调用会在 Provider 建立上下文
      // 之前执行，私有 Context 就读不到。
      const withPrivate = (component: () => ReactNode) => () => createElement(
        StoragePrivateContext.Provider,
        { value: storage },
        createElement(component),
      );
      const view = register.view;
      view.register({ id: `${id}:page`, kind: "page", order: 10, title: "存储页面", consumer: ctx.consumer, render: withPrivate(StoragePage) });
      view.register({ id: `${id}:settings`, kind: "settings", order: 20, title: "存储设置", consumer: ctx.consumer, render: withPrivate(StorageSettings) });
      view.register({ id: `${id}:header`, kind: "header", order: 30, title: "存储指示灯", consumer: ctx.consumer, render: withPrivate(StorageHeader) });
      crossOwnerView = view;
      crossOwnerEntryId = `${id}:page`;
    },
  });
  let crossOwnerView: ReturnType<typeof createScopedRegistryView>["view"] | undefined;
  let crossOwnerEntryId = "";
  const storagePlugin = buildStorage("psm-storage-plugin", "bucket-a");
  const secondStoragePlugin = buildStorage("psm-storage-plugin-2", "bucket-b");

  const app = await createWindowApp({ plugins: [webPluginDefinition, themePlugin, pagePlugin, pickerPlugin, undeclaredPlugin, storagePlugin, secondStoragePlugin] });
  const host = hostForWindowApp(app);
  const container = document.createElement("div");
  container.id = "pcb-root";
  document.body.appendChild(container);
  const read = (id: string): string | null => document.getElementById(id)?.textContent ?? null;
  const tick = async (): Promise<void> => { await new Promise<void>((resolve) => setTimeout(resolve, 30)); };
  /**
   * 渲染一棵临时子树，用于必须观察到渲染期抛错的负面用例。
   *
   * concurrent root 的 render 错误只会走全局 error 报告，调用方拿不到异常；
   * 因此这些用例统一走 flushSync，让 React 同步渲染并把错误抛回调用点，
   * 否则“被拒绝”和“没渲染出来”无法区分。
   */
  const renderProbe = (element: ReactElement): void => {
    const probeHost = document.createElement("div");
    probeHost.id = "pcb-negative-root";
    document.body.appendChild(probeHost);
    const root = createRoot(probeHost);
    try {
      flushSync(() => root.render(element));
    } finally {
      root.unmount();
      probeHost.remove();
    }
  };

  try {
    // 场景一：动态页面注册。
    const pageConsumer = issued.get("page")![0]!;
    const dynamicRoot = createRoot(container);
    dynamicRoot.render(createElement(StrictMode, null, createElement(Boundary, { consumer: pageConsumer }, [createElement(DynamicPage), createElement(OptionalBadge)])));
    await tick();
    const dynamicTheme = read("page-theme");
    const optionalState = read("page-optional");
    // 动态注册项的 owner 与 consumer 必须一致。
    const ownerConsistent = registeredPage?.instanceId === pageConsumer.instanceId && registeredPage.pluginId === pageConsumer.pluginId;
    dynamicRoot.unmount();

    // 场景二：静态首页贡献；场景三：提供方共享 Picker 嵌在消费方子树内。
    const pickerConsumer = issued.get("picker")![0]!;
    const comboRoot = createRoot(container);
    comboRoot.render(createElement(StrictMode, null,
      createElement(Boundary, { consumer: pageConsumer }, [
        createElement(HomeContribution),
        createElement(Boundary, { consumer: pickerConsumer }, [createElement(SharedPicker)]),
      ])));
    await tick();
    const homeTheme = read("home-theme");
    const sharedPicker = read("shared-picker");
    comboRoot.unmount();

    // 负面：私有实现没有公开解析入口。网页插件只声明注册服务，取不到任何私有对象。
    let privateUnreachable = true;
    try {
      // 用任意字符串/结构都拿不到私有实现：框架没有发布它的 capability。
      (webPlugin as unknown as { capability(id: string): unknown }).capability("fixture.psm.storage.private");
      privateUnreachable = false;
    } catch { privateUnreachable = true; }
    // 跨实例注销他人条目被拒绝。
    let crossOwnerRejected = false;
    try { crossOwnerView?.unregister("psm-storage-plugin:page"); } catch { crossOwnerRejected = true; }

    // 负面：伪造 consumer（结构相同但不是 Host 签发）被 Provider 拒绝。
    let forgedRejected = false;
    try {
      const forged = { ...pageConsumer } as PluginConsumer;
      renderProbe(createElement(Boundary, { consumer: forged }, [createElement(DynamicPage)]));
    } catch { forgedRejected = true; }

    // 负面：插件 Provider 内调用 App hook 被拒绝。
    let appHookRejected = false;
    try {
      renderProbe(createElement(WebLoomProvider, { app }, createElement(Boundary, { consumer: pageConsumer }, [createElement(AppHookProbe)])));
    } catch { appHookRejected = true; }

    // 撤权后旧 consumer 永久失效；同名重启产生新实例与新 consumer。
    const lifecycleRoot = createRoot(container);
    lifecycleRoot.render(createElement(Boundary, { consumer: pageConsumer }, [createElement(DynamicPage)]));
    await tick();
    const beforeDisable = read("page-theme");
    await host.revoke("pcb-page-plugin", "fixture revoke");
    await tick();
    const afterDisable = read("page-theme");
    let revokedRejected = false;
    try { pageConsumer.capability(Theme); } catch { revokedRejected = true; }

    await host.retry("pcb-page-plugin");
    await tick();
    const restarted = issued.get("page")![1]!;
    const newInstance = restarted.instanceId !== pageConsumer.instanceId;
    let stillRevoked = false;
    try { pageConsumer.capability(Theme); } catch { stillRevoked = true; }
    lifecycleRoot.render(createElement(Boundary, { consumer: restarted }, [createElement(DynamicPage)]));
    await tick();
    const afterRestart = read("page-theme");
    lifecycleRoot.unmount();

    // 网页插件按贡献方 consumer 挂载 Storage 的三类 UI。
    const webRoot = createRoot(container);
    webRoot.render(createElement(StrictMode, null, createElement(WebUiSurface, { entries: webEntries })));
    await tick();
    const storagePage = read("storage-page");
    const storageSettings = read("storage-settings");
    const storageHeader = read("storage-header");
    const webUiKinds = [...container.querySelectorAll("[data-kind]")].map((node) => node.getAttribute("data-kind"));
    // 条目 owner 由框架写入的实例身份，网页插件不能自填。
    const ownerBound = webEntries.every((entry) => typeof entry.ownerInstanceId === "string" && entry.ownerInstanceId !== "");
    webRoot.unmount();

    // 贡献实例撤销后：条目被撤下，重新挂载不再渲染旧私有 UI。
    await host.revoke("psm-storage-plugin", "domain condition");
    await tick();
    const entriesAfterRevoke = webEntries.filter((entry) => entry.id.startsWith("psm-storage-plugin:")).length;
    // 撤销只影响该实例：另一个 Storage 实例的条目仍然挂载并读自己的私有实现。
    const afterRoot = createRoot(container);
    afterRoot.render(createElement(WebUiSurface, { entries: webEntries }));
    await tick();
    const storageUiAfterRevoke = read("storage-page");
    afterRoot.unmount();

    // 提供方停用后共享 Picker 的旧 consumer 永久失效。
    await host.revoke("pcb-picker-plugin", "fixture revoke");
    let pickerRevoked = false;
    try { pickerConsumer.capability(Picker); } catch { pickerRevoked = true; }

    // 资源：实例资源按 owner 解析；撤权后不降级为宿主资源。
    const store = host.resourceStore;
    store.ensure("pcb.profile", []);
    await tick();
    await tick();
    const profileData = store.read("pcb.profile", [])?.data;
    await host.revoke("pcb-page-plugin", "fixture revoke");
    const profileAfterRevoke = store.read("pcb.profile", []) !== undefined;
    // 未声明注册表的插件不能留下任何资源定义。
    const sneakedAbsent = host.resourceRegistry.get("pcb.sneaked") === undefined;

    return {
      ok: true,
      dynamicTheme,
      optionalState,
      homeTheme,
      sharedPicker,
      ownerConsistent,
      storagePage,
      storageSettings,
      storageHeader,
      webUiKinds,
      ownerBound,
      entriesAfterRevoke,
      storageUiAfterRevoke,
      privateUnreachable,
      crossOwnerRejected,
      forgedRejected,
      appHookRejected,
      undeclaredRegistryRejected,
      sneakedAbsent,
      beforeDisable,
      afterDisable,
      revokedRejected,
      newInstance,
      stillRevoked,
      afterRestart,
      pickerRevoked,
      profileData,
      profileAfterRevoke,
    };
  } finally {
    await app.dispose().catch(() => undefined);
    container.remove();
  }
}

void run()
  .then((result) => { window.__WEBLOOM_PCB_RESULT__ = result; })
  .catch((error) => {
    window.__WEBLOOM_PCB_RESULT__ = { ok: false, error: error instanceof Error ? error.message : String(error) };
  });
