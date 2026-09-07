import { readFile, readdir, stat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const forbidden = [
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

function isLocalAbsolutePath(value) {
  return isAbsolute(value)
    || /^[A-Za-z]:[\\/]/.test(value)
    || /^\\\\/.test(value)
    || /^file:\/\//i.test(value);
}

async function filesUnder(directory) {
  try { await stat(directory); } catch { return []; }
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await filesUnder(path));
    else if (/\.(?:ts|tsx|js|jsx|d\.ts|js\.map)$/.test(entry.name)) result.push(path);
  }
  return result;
}

const paths = [...await filesUnder(join(root, "src")), ...await filesUnder(join(root, "dist"))];
const violations = [];
for (const path of paths) {
  const content = await readFile(path, "utf8");
  for (const pattern of forbidden) {
    if (pattern.test(content)) violations.push(`${relative(root, path)} matches ${pattern}`);
  }
  if (/\.(?:d\.ts|js\.map)$/.test(path)) {
    if (!path.endsWith(".js.map") && containsLocalAbsolutePath(content)) {
      violations.push(`${relative(root, path)} contains a local absolute path`);
    }
    if (path.endsWith(".js.map")) {
      try {
        const sourceMap = JSON.parse(content);
        const sources = [sourceMap.sourceRoot, ...(Array.isArray(sourceMap.sources) ? sourceMap.sources : [])];
        for (const source of sources) {
          if (typeof source === "string" && isLocalAbsolutePath(source)) {
            violations.push(`${relative(root, path)} contains absolute source path ${source}`);
          }
        }
        for (const sourceContent of sourceMap.sourcesContent ?? []) {
          if (typeof sourceContent === "string" && containsLocalAbsolutePath(sourceContent)) {
            violations.push(`${relative(root, path)} contains a local absolute path in sourcesContent`);
          }
        }
      } catch {
        violations.push(`${relative(root, path)} is not valid JSON source map data`);
      }
    }
  }
}

const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
for (const section of ["dependencies", "optionalDependencies", "peerDependencies", "devDependencies"]) {
  for (const name of Object.keys(packageJson[section] ?? {})) {
    if (/^@keymaster\//i.test(name)) violations.push(`package.json ${section} contains ${name}`);
  }
}

if (violations.length > 0) {
  console.error(violations.join("\n"));
  process.exitCode = 1;
} else {
  console.log("WebLoom boundary check passed");
}
