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
  }
}

const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
if (packageJson.version !== "0.4.1") violations.push(`package.json version is ${packageJson.version}, expected 0.4.1`);
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
