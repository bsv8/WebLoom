// 在干净临时目录安装当前 tarball，验证公开入口和声明可以被独立消费者加载。
// 该脚本不读取 WebLoom 源码，也不依赖仓库外的产品包。

import { execFileSync } from "node:child_process";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const smokeRoot = mkdtempSync(join(tmpdir(), "webloom-pack-consumer-"));

// 发布包只允许包含公共入口、声明、许可证、文档和 tsup 生成的共享文件。
const allowedPackFiles = [
  /^package\.json$/,
  /^LICENSE$/,
  /^README\.md$/,
  /^docs\/(?:api|migration-baseline)\.md$/,
  /^docs\/proposals\/browser-runtime-v1\/(?:requirements|implementation-plan|verification)\.md$/,
  /^docs\/proposals\/shared-worker-call-first\/(?:implementation-plan|SWCF-009-typed-transfer-follow-up)\.md$/,
  /^dist\/(?:index|advanced|react|testing)\.(?:js|d\.ts|js\.map)$/,
  /^dist\/chunk-[A-Za-z0-9_-]+\.js(?:\.map)?$/,
  /^dist\/[^/]+\.d\.ts$/,
  /^docs\/proposals\/webloom-v4\/(?:requirements|implementation-plan|verification)\.md$/,
  // 下游迁移说明随包发布，README 直接链接它们。
  /^docs\/plugin-consumer-migration\.md$/,
  /^docs\/plugin-service-migration\.md$/,
];
const requiredPackFiles = [
  "package.json",
  "LICENSE",
  "README.md",
  "docs/api.md",
  "docs/migration-baseline.md",
  "docs/plugin-consumer-migration.md",
  "docs/plugin-service-migration.md",
  "dist/index.js",
  "dist/index.d.ts",
  "dist/advanced.js",
  "dist/advanced.d.ts",
  "dist/react.js",
  "dist/react.d.ts",
  "dist/testing.js",
  "dist/testing.d.ts",
];
const forbiddenPublishedContent = [
  /@keymaster\//i,
  /\bownerPublicKeyHex\b/,
  /\bvaultStatus\b/i,
  /\bbucketGeneration\b/i,
  /\bP2PKH\b/i,
  /\bBSV\b/i,
  /\bKeymaster\b/i,
  /\bMSFile\b/i,
];
const localAbsolutePath = /(?:file:\/\/|(?:^|[\s"'`])\/(?:home|Users|private|tmp|var|mnt|opt|workspace)\/|(?:^|[\s"'`])[A-Za-z]:[\\/])/m;
const absoluteModuleSpecifier = /\b(?:from|import|export)\b[^"'`\r\n]{0,80}["'](?:\/(?![/*\s])|[A-Za-z]:[\\/]|file:\/\/)/m;

function containsLocalAbsolutePath(content) {
  return localAbsolutePath.test(content) || absoluteModuleSpecifier.test(content);
}
const maxTarballBytes = 512 * 1024;
const maxUnpackedBytes = 2 * 1024 * 1024;
const maxPackedFileBytes = 1024 * 1024;

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function installConsumer(directory, packageName, dependencies, devDependencies = {}) {
  mkdirSync(directory, { recursive: true });
  writeJson(join(directory, "package.json"), {
    name: packageName,
    private: true,
    type: "module",
    dependencies,
    devDependencies: {
      typescript: "5.5.4",
      ...devDependencies,
    },
  });
  execFileSync("pnpm", ["install", "--ignore-scripts", "--no-frozen-lockfile"], {
    cwd: directory,
    stdio: "inherit",
  });
}

function writeTypeSmoke(directory, source, lib) {
  writeFileSync(join(directory, "smoke.ts"), `${source.trim()}\n`);
  writeJson(join(directory, "tsconfig.json"), {
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      lib,
      strict: true,
      skipLibCheck: true,
      noEmit: true,
      forceConsistentCasingInFileNames: true,
    },
    include: ["smoke.ts"],
  });
}

function typecheckConsumer(directory) {
  const binaryName = process.platform === "win32" ? "tsc.cmd" : "tsc";
  execFileSync(join(directory, "node_modules", ".bin", binaryName), [
    "--noEmit",
    "--project",
    "tsconfig.json",
  ], {
    cwd: directory,
    stdio: "inherit",
  });
}

function runRuntimeSmoke(directory, source) {
  writeFileSync(join(directory, "smoke.mjs"), `${source.trim()}\n`);
  execFileSync(process.execPath, ["smoke.mjs"], { cwd: directory, stdio: "inherit" });
}

function isLocalAbsolutePath(value) {
  return isAbsolute(value)
    || /^[A-Za-z]:[\\/]/.test(value)
    || /^\\\\/.test(value)
    || /^file:\/\//i.test(value);
}

function assertPackMetadata(packInfo, tarball) {
  if (!packInfo || packInfo.name !== "webloom-framework") {
    throw new Error(`pnpm pack 返回了意外的包名：${packInfo?.name ?? "<unknown>"}`);
  }
  if (!Array.isArray(packInfo.files) || packInfo.files.length === 0) {
    throw new Error("pnpm pack 没有返回文件清单");
  }

  const paths = packInfo.files.map((file) => file?.path);
  const pathSet = new Set(paths);
  if (paths.some((path) => typeof path !== "string" || path.length === 0)) {
    throw new Error("pnpm pack 文件清单包含无效路径");
  }
  if (pathSet.size !== paths.length) {
    throw new Error("pnpm pack 文件清单包含重复路径");
  }
  for (const path of paths) {
    if (isAbsolute(path) || path.includes("\\") || path.split("/").includes("..")) {
      throw new Error(`pnpm pack 文件路径不是安全的相对路径：${path}`);
    }
    if (!allowedPackFiles.some((pattern) => pattern.test(path))) {
      throw new Error(`pnpm pack 包含未列入白名单的文件：${path}`);
    }
  }
  for (const required of requiredPackFiles) {
    if (!pathSet.has(required)) throw new Error(`pnpm pack 缺少必需文件：${required}`);
  }
  if (!paths.some((path) => /^dist\/chunk-[A-Za-z0-9_-]+\.js$/.test(path))) {
    throw new Error("pnpm pack 缺少 tsup 共享 JavaScript chunk");
  }

  for (const file of packInfo.files) {
    const filePath = resolve(packageRoot, file.path);
    const size = statSync(filePath).size;
    if (size > maxPackedFileBytes) {
      throw new Error(`pnpm pack 单文件超过体积上限：${file.path} (${size} bytes)`);
    }
  }
  const tarballBytes = statSync(tarball).size;
  const unpackedBytes = packInfo.files.reduce(
    (total, file) => total + statSync(resolve(packageRoot, file.path)).size,
    0,
  );
  if (tarballBytes > maxTarballBytes) {
    throw new Error(`pnpm pack tarball 超过体积上限：${tarballBytes} bytes`);
  }
  if (!Number.isFinite(unpackedBytes) || unpackedBytes > maxUnpackedBytes) {
    throw new Error(`pnpm pack 解包内容超过体积上限：${unpackedBytes} bytes`);
  }
  console.log(`tarball gate passed: ${paths.length} files, ${tarballBytes} packed bytes, ${unpackedBytes} unpacked bytes`);
  return paths;
}

function assertPackedGeneratedFiles(packageDirectory, paths) {
  const violations = [];
  for (const path of paths) {
    if (!path.endsWith(".d.ts") && !path.endsWith(".js.map")) continue;
    const filePath = resolve(packageDirectory, path);
    const relativePath = relative(packageDirectory, filePath);
    if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
      violations.push(`${path} resolves outside the packed package`);
      continue;
    }
    const content = readFileSync(filePath, "utf8");
    for (const pattern of forbiddenPublishedContent) {
      if (pattern.test(content)) violations.push(`${path} matches ${pattern}`);
    }
    if (!path.endsWith(".js.map") && containsLocalAbsolutePath(content)) {
      violations.push(`${path} contains a local absolute path`);
    }
    if (!path.endsWith(".js.map")) continue;
    try {
      const sourceMap = JSON.parse(content);
      const sources = [
        sourceMap.sourceRoot,
        ...(Array.isArray(sourceMap.sources) ? sourceMap.sources : []),
      ];
      for (const source of sources) {
        if (typeof source === "string" && isLocalAbsolutePath(source)) {
          violations.push(`${path} contains absolute source path ${source}`);
        }
      }
      for (const sourceContent of sourceMap.sourcesContent ?? []) {
        if (typeof sourceContent === "string" && containsLocalAbsolutePath(sourceContent)) {
          violations.push(`${path} contains a local absolute path in sourcesContent`);
        }
      }
    } catch {
      violations.push(`${path} is not valid JSON source map data`);
    }
  }
  if (violations.length > 0) throw new Error(violations.join("\n"));
  console.log("packed declaration/source-map gate passed");
}

try {
  const packDirectory = join(smokeRoot, "pack");
  mkdirSync(packDirectory);
  const packOutput = execFileSync("pnpm", [
    "--config.ignore-scripts=true",
    "pack",
    "--json",
    "--skip-manifest-obfuscation",
    "--pack-destination",
    packDirectory,
  ], {
    cwd: packageRoot,
    encoding: "utf8",
  });
  let packResults;
  try {
    packResults = JSON.parse(packOutput);
  } catch (error) {
    throw new Error(`无法解析 pnpm pack --json 输出：${error instanceof Error ? error.message : String(error)}`);
  }
  const packInfo = Array.isArray(packResults)
    ? packResults.length === 1 ? packResults[0] : undefined
    : packResults;
  if (!packInfo || typeof packInfo !== "object") {
    throw new Error("pnpm pack --json 必须返回一个包结果");
  }
  const tarballName = typeof packInfo.filename === "string"
    ? basename(packInfo.filename)
    : readdirSync(packDirectory).find((name) => name.endsWith(".tgz"));
  if (!tarballName || basename(tarballName) !== tarballName) {
    throw new Error("pnpm pack 没有生成安全的 WebLoom tarball 文件名");
  }
  const tarball = join(packDirectory, tarballName);
  const packPaths = assertPackMetadata(packInfo, tarball);

  const unpackDirectory = join(smokeRoot, "unpacked");
  mkdirSync(unpackDirectory);
  execFileSync("tar", ["-xzf", tarball, "-C", unpackDirectory], { stdio: "inherit" });
  assertPackedGeneratedFiles(join(unpackDirectory, "package"), packPaths);
  const dependency = `file:${tarball}`;

  // core-only 消费者不安装 React；同时用 tsc 验证公开核心声明。
  const coreConsumer = join(smokeRoot, "core-consumer");
  installConsumer(coreConsumer, "webloom-core-consumer", { "webloom-framework": dependency });
  writeTypeSmoke(coreConsumer, `
    import { createWindowApp, defineCapability, definePlugin } from "webloom-framework";
    import type { PluginConsumer, AvailableConsumerCapability, PluginDefinition } from "webloom-framework";
    import { createPluginHost } from "webloom-framework/advanced";

    const Demo = defineCapability<{ value: number }>({
      kind: "local", id: "demo.service", version: "1",
    });

    const demo = definePlugin({
      id: "demo",
      provides: [Demo] as const,
      setup: (context) => {
        context.provide(Demo, { value: 1 });
      },
    });
    const app = await createWindowApp({ plugins: [demo] });
    if (app.runtimeKind !== "window-main") throw new Error("Window Runtime API is unavailable");
    if (app.capability(Demo).value !== 1) throw new Error("typed local capability is unavailable");
    await app.dispose();

    // 插件实例消费视图是 core 公开类型：能从 setup 的 ctx 取出并保存，
    // 交给下游 UI 注册/资源加载器长期持有（PCB-R02/R07）。
    const consumerPlugin = definePlugin({
      id: "demo-consumer",
      dependencies: [{ capability: Demo }] as const,
      runtime: "window-main",
      setup: (context) => {
        // consumer 只暴露受限读取入口：读取声明过的依赖 OK。
        const consumer: PluginConsumer = context.consumer;
        const theme = defineCapability<{ name: string }>({ kind: "local", id: "demo.theme", version: "1" });
        const available: AvailableConsumerCapability<readonly [], readonly [{ readonly capability: typeof Demo }]> = Demo;
        void available;
        void consumer.optionalCapability(Demo);
        // 窄化 consumer：未声明的 capability 在编译期就无法传入。
        const narrow: PluginConsumer<readonly [], readonly [{ readonly capability: typeof Demo }]> = consumer;
        // @ts-expect-error capability 参数必须是契约对象，不能是字符串 id
        narrow.capability("demo.service");
        // @ts-expect-error capability 参数必须是契约对象，数字也不行
        narrow.optionalCapability(1);
        // @ts-expect-error 未声明的 capability 不能传给窄化 consumer
        narrow.capability(theme);
        // @ts-expect-error 窄化 consumer 也不是管理入口
        narrow.provide;
        // @ts-expect-error 消费视图不是管理入口，没有 provide
        consumer.provide;
        // @ts-expect-error 消费视图不是管理入口，没有 handle
        consumer.handle;
        // @ts-expect-error 消费视图不暴露完整 Host
        consumer.host;
        // @ts-expect-error 消费视图不暴露 App
        consumer.app;
      },
    });
    void consumerPlugin;
  `, ["ES2022", "DOM", "DOM.Iterable"]);
  typecheckConsumer(coreConsumer);
  runRuntimeSmoke(coreConsumer, `
    const core = await import("webloom-framework");
    if (typeof core.createWindowApp !== "function" || typeof core.defineCapability !== "function") throw new Error("webloom-framework core entry is unavailable");
    const advanced = await import("webloom-framework/advanced");
    if (typeof advanced.createPluginHost !== "function") throw new Error("webloom-framework/advanced entry is unavailable");
    const testing = await import("webloom-framework/testing");
    if (typeof testing.createFakeRuntimeTransport !== "function") throw new Error("webloom-framework/testing entry is unavailable");
    console.log("core-only consumer smoke passed");
  `);

  // core-only 运行时装载：真实走一遍实例消费视图，确认撤销语义在发布包里
  // 与源码一致，且 core 入口不需要 React。
  runRuntimeSmoke(coreConsumer, `
    const core = await import("webloom-framework");
    const Demo = core.defineCapability({ kind: "local", id: "smoke.demo", version: "1" });
    const held = [];
    const provider = core.definePlugin({
      id: "smoke-provider",
      provides: [Demo],
      setup(ctx) { ctx.provide(Demo, { value: 7 }); },
    });
    const consumerPlugin = core.definePlugin({
      id: "smoke-consumer",
      dependencies: [{ capability: Demo }],
      runtime: "window-main",
      setup(ctx) { held.push(ctx.consumer); },
    });
    const app = await core.createWindowApp({ plugins: [provider, consumerPlugin] });
    const consumer = held[0];
    if (!consumer) throw new Error("setup did not receive a PluginConsumer");
    if (consumer.capability(Demo).value !== 7) throw new Error("consumer capability read failed");
    // 同一契约重复读取必须返回稳定引用（React 快照需要）。
    if (consumer.capability(Demo) !== consumer.capability(Demo)) throw new Error("consumer capability reference is not stable");
    // Host 生命周期管理属于装配层，只从 advanced 入口取；core 消费者不
    // 需要它也能读能力（上面的 capability 读取已在 core 完成）。
    const { hostForWindowApp } = await import("webloom-framework/advanced");
    const host = hostForWindowApp(app);
    // 新模型没有用户启停接口：装配清单里的插件全部参与系统，释放只能由可信
    // 装配层显式 revoke，并且留下可诊断的运行条件。
    for (const removed of ["enable", "disable", "submitIntent", "suspend"]) {
      if (typeof host[removed] === "function") throw new Error("Host still exposes a user enable/disable API: " + removed);
    }
    if ("desiredEnabled" in host.state("smoke-consumer")) throw new Error("plugin state still exposes desiredEnabled");
    await host.revoke("smoke-consumer", "smoke stop");
    // 撤权后旧视图永久失效，不再按 pluginId 自动重绑。
    let revoked = false;
    try { consumer.capability(Demo); } catch { revoked = true; }
    if (!revoked) throw new Error("revoked PluginConsumer still resolved capabilities");
    if (consumer.status !== "revoked") throw new Error("revoked PluginConsumer did not report revoked status");
    await host.retry("smoke-consumer");
    if (held.length !== 2) throw new Error("restart did not issue a new PluginConsumer");
    if (held[1].instanceId === consumer.instanceId) throw new Error("restart reused the old instance id");
    // 旧 consumer 仍然失效；同名重启不会让旧视图复活。
    let stillRevoked = false;
    try { consumer.capability(Demo); } catch { stillRevoked = true; }
    if (!stillRevoked) throw new Error("old PluginConsumer was reactivated after restart");
    await app.dispose();
    console.log("core-only PluginConsumer runtime smoke passed");
  `);

  // Advanced consumer verifies that implementation details are available only
  // through the explicit v4 advanced entry.
  const advancedConsumer = join(smokeRoot, "advanced-consumer");
  installConsumer(advancedConsumer, "webloom-advanced-consumer", { "webloom-framework": dependency });
  writeTypeSmoke(advancedConsumer, `
    import { createPluginHost, createCapabilityRegistry } from "webloom-framework/advanced";
    import { defineCapability, RESOURCE_REGISTRY, type ResourceContext, type ResourceDefinition } from "webloom-framework";
    const host = createPluginHost();
    const registry = createCapabilityRegistry();
    void host;
    void registry;

    // 实例所属资源的 typed 能力解析（PCB-R05）：资源上下文只提供
    // capability()/optionalCapability()，插件侧没有字符串 getCapability(id)。
    const Profile = defineCapability<{ name: string }>({ kind: "local", id: "smoke.profile", version: "1" });
    const definition: ResourceDefinition<string> = {
      id: "smoke.profile",
      scope: "plugin",
      invalidation: "immediate",
      key: (_args: readonly string[], context: ResourceContext) => [context.capability(Profile).name],
      load: async (_args: readonly string[], context: ResourceContext) => context.capability(Profile).name,
    };
    void definition;
    // @ts-expect-error 插件资源不再提供字符串 getCapability 入口
    const removed: unknown = (undefined as unknown as ResourceContext).getCapability;
    void removed;
    // @ts-expect-error RESOURCE_REGISTRY 的 register 需要完整资源定义
    RESOURCE_REGISTRY.value.register({ id: "x" });
  `, ["ES2022", "DOM", "DOM.Iterable"]);
  typecheckConsumer(advancedConsumer);
  runRuntimeSmoke(advancedConsumer, `
    const advanced = await import("webloom-framework/advanced");
    if (typeof advanced.createPluginHost !== "function" || typeof advanced.createCapabilityRegistry !== "function") throw new Error("advanced entry is unavailable");
    console.log("advanced consumer smoke passed");
  `);

  // 资源 owner 的 typed 解析：插件资源按自身实例解析能力，宿主资源走
  // 装配层 resolver；两者不互相降级（PCB-R05）。
  runRuntimeSmoke(advancedConsumer, `
    const core = await import("webloom-framework");
    const { hostForWindowApp } = await import("webloom-framework/advanced");
    // 被资源消费的 Profile 能力由插件自己提供，避免依赖外部装配顺序：
    // 这样 setup 执行时能力已经在本实例目录中，资源 loader 才能按 owner
    // 身份解析它（PCB-R05）。
    const Profile = core.defineCapability({ kind: "local", id: "smoke.resource.profile", version: "1" });
    const plugin = core.definePlugin({
      id: "smoke-resource-plugin",
      provides: [Profile],
      dependencies: [{ capability: core.RESOURCE_REGISTRY }],
      runtime: "window-main",
      setup(ctx) {
        ctx.provide(Profile, { name: "owner-scoped" });
        ctx.capability(core.RESOURCE_REGISTRY).register({
          id: "smoke.profile",
          scope: "plugin",
          invalidation: "immediate",
          key: () => ["smoke.profile"],
          // 资源 loader 使用定义所属实例的 typed 能力，而不是全局查询。
          load: async (_args, context) => context.capability(Profile).name,
        });
      },
    });
    const app = await core.createWindowApp({ plugins: [plugin] });
    const host = hostForWindowApp(app);
    host.resourceStore.ensure("smoke.profile", []);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const data = host.resourceStore.read("smoke.profile", [])?.data;
    if (data !== "owner-scoped") throw new Error("plugin-owned resource did not resolve its owner capability");
    // 撤权后定义注销，读取不会降级为宿主资源。
    await host.revoke("smoke-resource-plugin", "smoke stop");
    if (host.resourceStore.read("smoke.profile", []) !== undefined) throw new Error("revoked owner resource still readable");
    await app.dispose();
    console.log("resource owner typed capability smoke passed");
  `);

  // React 消费者安装 React 和声明包，验证 webloom-framework/react 的运行时及类型边界。
  const reactConsumer = join(smokeRoot, "react-consumer");
  installConsumer(reactConsumer, "webloom-react-consumer", {
    "webloom-framework": dependency,
    react: "18.3.1",
    "react-dom": "18.3.1",
  }, {
    "@types/react": "18.3.3",
    "@types/react-dom": "18.3.0",
  });
  writeTypeSmoke(reactConsumer, `
    import { createElement, type ReactElement } from "react";
    import { createWindowApp, defineCapability, type PluginConsumer } from "webloom-framework";
    import {
      PluginConsumerProvider,
      WebLoomProvider,
      usePluginCapability,
      useHasPluginCapability,
      useOptionalPluginCapability,
      useWebLoomApp,
    } from "webloom-framework/react";

    const app = await createWindowApp({ plugins: [] });
    function Probe(): ReactElement {
      const current = useWebLoomApp();
      return createElement("output", null, current.runtimeKind);
    }
    const element: ReactElement = createElement(
      WebLoomProvider,
      { app, children: createElement(Probe) },
    );
    void element;

    // 插件实例消费边界的 React 接入：Provider 只接受框架签发的 consumer，
    // 三个插件 hook 只能在该实例的声明范围内读取能力（PCB-R03）。
    const Theme = defineCapability<{ name: string }>({ kind: "local", id: "smoke.theme", version: "1" });
    const Absent = defineCapability<{ ok: boolean }>({ kind: "local", id: "smoke.absent", version: "1" });
    function ThemeProbe(): ReactElement {
      const theme = usePluginCapability(Theme);
      const has = useHasPluginCapability(Absent);
      const absent = useOptionalPluginCapability(Absent);
      void has;
      void absent;
      return createElement("output", null, theme.name);
    }
    function ConsumerTree({ consumer }: { consumer: PluginConsumer }): ReactElement {
      return createElement(
        PluginConsumerProvider,
        { consumer, children: createElement(ThemeProbe) },
      );
    }
    void ConsumerTree;
  `, ["ES2022", "DOM", "DOM.Iterable"]);
  typecheckConsumer(reactConsumer);
  runRuntimeSmoke(reactConsumer, `
    const react = await import("webloom-framework/react");
    if (typeof react.WebLoomProvider !== "function" || typeof react.useCapability !== "function") throw new Error("webloom-framework/react entry is unavailable");
    // 插件实例消费边界的公开 React 面：Provider 与三个插件 hook。
    for (const name of ["PluginConsumerProvider", "usePluginCapability", "useOptionalPluginCapability", "useHasPluginCapability"]) {
      if (typeof react[name] !== "function") throw new Error("webloom-framework/react entry is missing " + name);
    }
    // 内部防误用 context 不是公共 API，不应从子入口扩散出去。
    if (react.PluginConsumerContext !== undefined) throw new Error("PluginConsumerContext must not be a public export");
    if (react.usePluginConsumer !== undefined) throw new Error("usePluginConsumer must not be a public export");
    if (react.useIsInsidePluginBoundary !== undefined) throw new Error("useIsInsidePluginBoundary must not be a public export");
    const testing = await import("webloom-framework/testing");
    if (typeof testing.createFakePluginHost !== "function") throw new Error("webloom-framework/testing entry is unavailable");
    await import("react-dom");
    console.log("react consumer smoke passed");
  `);

  // React 运行时装载：真实创建窗口 App，签发 consumer 并在 Provider 下
  // 渲染；撤权后 Provider 停止渲染旧实例子树。
  runRuntimeSmoke(reactConsumer, `
    const core = await import("webloom-framework");
    const reactDom = await import("react-dom/server");
    const React = await import("react");
    const ui = await import("webloom-framework/react");
    const { hostForWindowApp } = await import("webloom-framework/advanced");
    const Theme = core.defineCapability({ kind: "local", id: "smoke.react.theme", version: "1" });
    const held = [];
    const app = await core.createWindowApp({ plugins: [
      core.definePlugin({ id: "smoke.react.provider", provides: [Theme], setup(ctx) { ctx.provide(Theme, { name: "dark" }); } }),
      core.definePlugin({ id: "smoke.react.consumer", dependencies: [{ capability: Theme }], runtime: "window-main", setup(ctx) { held.push(ctx.consumer); } }),
    ] });
    const consumer = held[0];
    function View() {
      const theme = ui.usePluginCapability(Theme);
      return React.createElement("output", null, theme.name);
    }
    const markup = reactDom.renderToStaticMarkup(
      React.createElement(ui.PluginConsumerProvider, { consumer }, React.createElement(View)),
    );
    if (!markup.includes("dark")) throw new Error("PluginConsumerProvider did not render the plugin capability");
    const host = hostForWindowApp(app);
    await host.revoke("smoke.react.consumer", "smoke stop");
    const afterRevoke = reactDom.renderToStaticMarkup(
      React.createElement(ui.PluginConsumerProvider, { consumer }, React.createElement(View)),
    );
    if (afterRevoke.includes("dark")) throw new Error("revoked plugin subtree kept rendering");
    // 伪造 consumer（结构相同但不是框架签发）在 Provider 处被拒绝。
    const forged = { pluginId: "smoke.react.consumer", unitId: "smoke.react.consumer", instanceId: "fake", status: "active", capability: () => { throw new Error("nope"); }, optionalCapability: () => undefined, subscribe: () => () => {} };
    let rejected = false;
    try { reactDom.renderToStaticMarkup(React.createElement(ui.PluginConsumerProvider, { consumer: forged }, React.createElement(View))); } catch { rejected = true; }
    if (!rejected) throw new Error("forged PluginConsumer was accepted by the Provider");
    await app.dispose();
    console.log("react PluginConsumerProvider runtime smoke passed");
  `);

  // Worker 消费者不安装 React；其声明只使用 ES2022 + WebWorker lib。
  const workerConsumer = join(smokeRoot, "worker-consumer");
  installConsumer(workerConsumer, "webloom-worker-consumer", { "webloom-framework": dependency });
  writeTypeSmoke(workerConsumer, `
    /// <reference lib="webworker" />
    import { createWindowApp, type WindowApp } from "webloom-framework";

    const workerScope: WorkerGlobalScope = self;
    const appPromise: Promise<WindowApp> = createWindowApp({ plugins: [] });
    void workerScope;
    void appPromise;
  `, ["ES2022", "WebWorker"]);
  typecheckConsumer(workerConsumer);
  writeFileSync(join(workerConsumer, "worker-runtime.mjs"), [
    'import { parentPort } from "node:worker_threads";',
    'const core = await import("webloom-framework");',
    'parentPort?.postMessage(typeof core.createWindowApp === "function" && typeof core.defineCapability === "function");',
  ].join("\n"));
  runRuntimeSmoke(workerConsumer, `
    import { Worker } from "node:worker_threads";
    const worker = new Worker(new URL("./worker-runtime.mjs", import.meta.url), { type: "module" });
    const available = await new Promise((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
    });
    await worker.terminate();
    if (available !== true) throw new Error("webloom-framework core entry is unavailable in a Worker");
    console.log("worker consumer smoke passed");
  `);

  console.log("WebLoom pack consumer smoke passed");
} finally {
  rmSync(smokeRoot, { recursive: true, force: true });
}
