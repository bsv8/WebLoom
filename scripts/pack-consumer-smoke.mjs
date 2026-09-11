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
];
const requiredPackFiles = [
  "package.json",
  "LICENSE",
  "README.md",
  "docs/api.md",
  "docs/migration-baseline.md",
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
  execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], {
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
    throw new Error(`npm pack 返回了意外的包名：${packInfo?.name ?? "<unknown>"}`);
  }
  if (!Array.isArray(packInfo.files) || packInfo.files.length === 0) {
    throw new Error("npm pack 没有返回文件清单");
  }

  const paths = packInfo.files.map((file) => file?.path);
  const pathSet = new Set(paths);
  if (paths.some((path) => typeof path !== "string" || path.length === 0)) {
    throw new Error("npm pack 文件清单包含无效路径");
  }
  if (pathSet.size !== paths.length) {
    throw new Error("npm pack 文件清单包含重复路径");
  }
  for (const path of paths) {
    if (isAbsolute(path) || path.includes("\\") || path.split("/").includes("..")) {
      throw new Error(`npm pack 文件路径不是安全的相对路径：${path}`);
    }
    if (!allowedPackFiles.some((pattern) => pattern.test(path))) {
      throw new Error(`npm pack 包含未列入白名单的文件：${path}`);
    }
  }
  for (const required of requiredPackFiles) {
    if (!pathSet.has(required)) throw new Error(`npm pack 缺少必需文件：${required}`);
  }
  if (!paths.some((path) => /^dist\/chunk-[A-Za-z0-9_-]+\.js$/.test(path))) {
    throw new Error("npm pack 缺少 tsup 共享 JavaScript chunk");
  }

  for (const file of packInfo.files) {
    if (typeof file.size === "number" && file.size > maxPackedFileBytes) {
      throw new Error(`npm pack 单文件超过体积上限：${file.path} (${file.size} bytes)`);
    }
  }
  const tarballBytes = statSync(tarball).size;
  const metadataPackedBytes = Number(packInfo.size);
  const unpackedBytes = Number(packInfo.unpackedSize);
  if (!Number.isFinite(metadataPackedBytes) || metadataPackedBytes !== tarballBytes) {
    throw new Error(`npm pack 元数据与实际 tarball 体积不一致：${packInfo.size} / ${tarballBytes} bytes`);
  }
  if (tarballBytes > maxTarballBytes) {
    throw new Error(`npm pack tarball 超过体积上限：${tarballBytes} bytes`);
  }
  if (!Number.isFinite(unpackedBytes) || unpackedBytes > maxUnpackedBytes) {
    throw new Error(`npm pack 解包内容超过体积上限：${packInfo.unpackedSize} bytes`);
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
  const packOutput = execFileSync("npm", [
    "pack",
    "--json",
    "--ignore-scripts",
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
    throw new Error(`无法解析 npm pack --json 输出：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(packResults) || packResults.length !== 1) {
    throw new Error("npm pack --json 必须返回一个包结果");
  }
  const packInfo = packResults[0];
  const tarballName = typeof packInfo.filename === "string"
    ? packInfo.filename
    : readdirSync(packDirectory).find((name) => name.endsWith(".tgz"));
  if (!tarballName || basename(tarballName) !== tarballName) {
    throw new Error("npm pack 没有生成安全的 WebLoom tarball 文件名");
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

  // Advanced consumer verifies that implementation details are available only
  // through the explicit v4 advanced entry.
  const advancedConsumer = join(smokeRoot, "advanced-consumer");
  installConsumer(advancedConsumer, "webloom-advanced-consumer", { "webloom-framework": dependency });
  writeTypeSmoke(advancedConsumer, `
    import { createPluginHost, createCapabilityRegistry } from "webloom-framework/advanced";
    const host = createPluginHost();
    const registry = createCapabilityRegistry();
    void host;
    void registry;
  `, ["ES2022", "DOM", "DOM.Iterable"]);
  typecheckConsumer(advancedConsumer);
  runRuntimeSmoke(advancedConsumer, `
    const advanced = await import("webloom-framework/advanced");
    if (typeof advanced.createPluginHost !== "function" || typeof advanced.createCapabilityRegistry !== "function") throw new Error("advanced entry is unavailable");
    console.log("advanced consumer smoke passed");
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
    import { createWindowApp } from "webloom-framework";
    import { WebLoomProvider, useWebLoomApp } from "webloom-framework/react";

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
  `, ["ES2022", "DOM", "DOM.Iterable"]);
  typecheckConsumer(reactConsumer);
  runRuntimeSmoke(reactConsumer, `
    const react = await import("webloom-framework/react");
    if (typeof react.WebLoomProvider !== "function" || typeof react.useCapability !== "function") throw new Error("webloom-framework/react entry is unavailable");
    const testing = await import("webloom-framework/testing");
    if (typeof testing.createFakePluginHost !== "function") throw new Error("webloom-framework/testing entry is unavailable");
    await import("react-dom");
    console.log("react consumer smoke passed");
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
