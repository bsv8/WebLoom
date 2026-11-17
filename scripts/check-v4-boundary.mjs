import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const sourceFiles = [
  "src",
  "dist",
];
const forbidden = [
  /providedContracts/,
  /(?:getProxy|requireProxy)/,
  /(?:onConnection|onPortConnect)/,
  /createServiceBridge/,
  /(?:keymaster|webloom)\.remote-service/i,
  /transferForRequest/,
  /rawSend/,
  /RemoteService(?:Reference|Call|Transport|Message|Codec)/,
  /webloom\.runtime\.v2/,
];
// MessageBus 的事件名仍然是领域无关字符串；这里只拦截 capability/context
// API，避免把合法的 bus.handle("event", ...) 当成旧 capability API。
const stringCapability = /\b(?:ctx|context|app|runtime|peer|host)\.(?:capability|optionalCapability|provide|handle)\s*<[^>]*>??\s*\(\s*["'`]/;
const untypedStringCapability = /\b(?:ctx|context|app|runtime|peer|host)\.(?:capability|optionalCapability|provide|handle)\s*\(\s*["'`]/;
const oldGenericCall = /\.call\s*<[^>]+>\s*\(/;
const intentionalTypecheckFixtures = new Set([
  "src/contracts/capability.typecheck.ts",
]);
// 插件服务模型迭代（PSM）删除的用户启停表面。这些 token 只能出现在历史文档和
// 证明旧接口被拒绝的负面 fixture 里，正式源码与产物一律不允许残留。
const removedEnableDisableSurface = [
  /\bPluginIntent(?:Command|Snapshot|Controller|Coordinator|SubmissionResult|CommandResult)\b/,
  /\bdesiredEnabled\b/,
  /\bdesiredRevision\b/,
  /\bdefaultEnabled\b/,
  /\bcanDisable\b/,
  /\bcreateInMemoryPluginConfigStore\b/,
  /\bsubmitIntent\s*[:(]/,
  /\b(?:host|ctx|context)\.(?:enable|disable|suspend)\s*\(/,
  /\berror-disabled\b/,
];
// 负面 fixture 与回归测试需要引用被删除的符号，因此逐文件豁免，而不是整目录通配。
const intentionalRemovedSurfaceFixtures = new Set([
  "src/contracts/consumer.typecheck.ts",
  "src/host/pluginLifecycle.test.ts",
]);

/** 去掉注释与字符串字面量后再判断“旧接口是否重新出现”。 */
function stripCommentsAndLiterals(content) {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
}
// 依赖拓扑与运行条件是新模型的合法词汇，不能被上面的规则误伤。
const allowedLifecycleVocabulary = /\brevoked:/;

async function filesUnder(directory) {
  const entries = await (await import("node:fs/promises")).readdir(directory, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(path));
    else if (/\.(?:ts|tsx|js|jsx|d\.ts)$/.test(entry.name)) files.push(path);
  }
  return files;
}

const violations = [];
for (const directory of sourceFiles) {
  for (const path of await filesUnder(join(root, directory))) {
    const content = await readFile(path, "utf8");
    const relativePath = relative(root, path);
    for (const pattern of forbidden) if (pattern.test(content)) violations.push(`${relativePath} matches ${pattern}`);
    if (!intentionalTypecheckFixtures.has(relativePath)
      && (stringCapability.test(content) || untypedStringCapability.test(content))) violations.push(`${relativePath} contains a string capability call`);
    if (oldGenericCall.test(content)) violations.push(`${relativePath} contains a manually supplied call generic`);
    if (!intentionalRemovedSurfaceFixtures.has(relativePath)) {
      // 注释与字符串里的“已删除”说明不算回归；真实代码路径里的符号才算。
      const code = stripCommentsAndLiterals(content);
      for (const pattern of removedEnableDisableSurface) {
        if (pattern.test(code)) violations.push(`${relativePath} reintroduces the removed enable/disable surface matching ${pattern}`);
      }
    }
  }
}

const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
// 当前双语言发布版本；插件服务模型的旧启停 API 由上面的边界规则拒绝。
if (packageJson.version !== "0.6.1") violations.push(`packageJson version is ${packageJson.version}, expected 0.6.1`);
const exports = Object.keys(packageJson.exports ?? {});
for (const entry of [".", "./advanced", "./react", "./testing"]) if (!exports.includes(entry)) violations.push(`package.json is missing export ${entry}`);
for (const entry of exports) if (![".", "./advanced", "./react", "./testing"].includes(entry)) violations.push(`package.json exposes non-v4 entry ${entry}`);

const index = await readFile(join(root, "src/index.ts"), "utf8");
for (const pattern of [/\.\/host\//, /\.\/transport\//, /runtimeProtocol/, /createPluginHost/]) {
  if (pattern.test(index)) violations.push(`src/index.ts exposes implementation detail matching ${pattern}`);
}

if (violations.length > 0) {
  console.error(violations.join("\n"));
  process.exitCode = 1;
} else {
  console.log("WebLoom v4 API boundary check passed");
}
