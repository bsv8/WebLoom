import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * Build-time contract inventory for WebLoom v4.
 *
 * The inventory is deliberately static. It records the source module and
 * source fingerprints around each defineCapability call; it never imports a
 * capability module, invokes a parser, or uses Function.toString(). A change
 * therefore stops the build and requires an explicit inventory review.
 */

const execFileAsync = promisify(execFile);
const defaultRoot = fileURLToPath(new URL("..", import.meta.url));
const argv = process.argv.slice(2);
const args = new Set(argv);

function optionValues(name) {
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === name && argv[index + 1]) values.push(argv[index + 1]);
  }
  return values;
}

const root = resolve(optionValues("--root")[0] ?? defaultRoot);
const inventoryPath = resolve(root, optionValues("--inventory")[0] ?? "contract-inventory.json");
const sourceRootOptions = optionValues("--source-root");
const sourceRoots = sourceRootOptions.length > 0
  ? sourceRootOptions.map((sourceRoot) => resolve(root, sourceRoot))
  : [resolve(root, "src")];

const sourceExtensions = [".ts", ".tsx"];
const sourceFilePattern = /\.(?:ts|tsx)$/u;
const testFilePattern = /(?:\.test|\.spec|\.typecheck)\.(?:ts|tsx)$/u;

function identityKey(entry) {
  return `${entry.kind}\u0000${entry.id}\u0000${entry.version}`;
}

function hashSource(source) {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

function rel(path) {
  return relative(root, path).split(sep).join("/");
}

async function filesUnder(directory) {
  try {
    await stat(directory);
  } catch {
    return [];
  }
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) result.push(...await filesUnder(path));
    else if (sourceFilePattern.test(entry.name)) result.push(path);
  }
  return result;
}

async function filesAt(sourceRoot) {
  try {
    const sourceRootStat = await stat(sourceRoot);
    if (sourceRootStat.isDirectory()) return filesUnder(sourceRoot);
    return sourceFilePattern.test(sourceRoot) ? [sourceRoot] : [];
  } catch {
    return [];
  }
}

function moduleSpecifierText(node) {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : undefined;
}

function stringProperty(object, name, sourceFile, errors, required = true) {
  const property = object.properties.find((candidate) => (
    (ts.isPropertyAssignment(candidate) || ts.isShorthandPropertyAssignment(candidate))
    && ((ts.isIdentifier(candidate.name) && candidate.name.text === name)
      || (ts.isStringLiteral(candidate.name) && candidate.name.text === name))
  ));
  if (!property) {
    if (required) errors.push(`${rel(sourceFile.fileName)} is missing static capability field ${name}`);
    return undefined;
  }
  const value = ts.isPropertyAssignment(property) ? property.initializer : property.name;
  if (!ts.isStringLiteral(value) && !ts.isNoSubstitutionTemplateLiteral(value)) {
    errors.push(`${rel(sourceFile.fileName)} capability field ${name} must be a string literal`);
    return undefined;
  }
  return value.text;
}

function propertyExpression(object, name) {
  const property = object.properties.find((candidate) => (
    (ts.isPropertyAssignment(candidate) || ts.isShorthandPropertyAssignment(candidate))
    && ((ts.isIdentifier(candidate.name) && candidate.name.text === name)
      || (ts.isStringLiteral(candidate.name) && candidate.name.text === name))
  ));
  if (!property) return undefined;
  return ts.isPropertyAssignment(property) ? property.initializer : property.name;
}

function importBindings(sourceFile) {
  const bindings = new Map();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) continue;
    const module = moduleSpecifierText(statement.moduleSpecifier);
    if (!module) continue;
    const named = statement.importClause.namedBindings;
    if (named && ts.isNamedImports(named)) {
      for (const element of named.elements) {
        const imported = element.propertyName?.text ?? element.name.text;
        bindings.set(element.name.text, { module, imported });
      }
    }
    if (named && ts.isNamespaceImport(named)) {
      bindings.set(named.name.text, { module, imported: "*" });
    }
    if (statement.importClause.name) {
      bindings.set(statement.importClause.name.text, { module, imported: "default" });
    }
  }
  return bindings;
}

function staticImports(sourceFile) {
  const result = [];
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      const module = moduleSpecifierText(statement.moduleSpecifier);
      if (module) result.push(module);
    } else if (ts.isExportDeclaration(statement)) {
      const module = statement.moduleSpecifier && moduleSpecifierText(statement.moduleSpecifier);
      if (module) result.push(module);
    }
  }
  return result;
}

function resolveLocalImport(fromFile, specifier, knownFiles) {
  if (!specifier.startsWith(".")) return undefined;
  const withoutQuery = specifier.split(/[?#]/u, 1)[0];
  const resolved = resolve(fromFile, "..", withoutQuery);
  const base = /\.(?:[cm]?js|jsx)$/u.test(resolved)
    ? resolved.replace(/\.(?:[cm]?js|jsx)$/u, "")
    : resolved;
  const candidates = [];
  const extension = extname(base);
  if (sourceExtensions.includes(extension)) candidates.push(base);
  else {
    for (const candidateExtension of sourceExtensions) candidates.push(`${base}${candidateExtension}`);
  }
  for (const candidateExtension of sourceExtensions) {
    candidates.push(resolve(base, `index${candidateExtension}`));
  }
  if (knownFiles.has(base)) candidates.unshift(base);
  return candidates.find((candidate) => knownFiles.has(candidate));
}

function expressionText(expression, sourceFile) {
  return sourceFile.text.slice(expression.getStart(sourceFile), expression.end);
}

function parserSource(expression, sourceFile, bindings, knownFiles) {
  if (!expression) return undefined;
  let moduleSpecifier;
  if (ts.isIdentifier(expression)) {
    moduleSpecifier = bindings.get(expression.text)?.module;
  } else if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
    moduleSpecifier = bindings.get(expression.expression.text)?.module;
  }
  const modulePath = moduleSpecifier
    ? resolveLocalImport(sourceFile.fileName, moduleSpecifier, knownFiles)
    : sourceFile.fileName;
  return {
    expression: expressionText(expression, sourceFile),
    module: rel(modulePath ?? sourceFile.fileName),
  };
}

function isDefineCapabilityCall(call, sourceFile, bindings) {
  if (!ts.isIdentifier(call.expression)) return false;
  if (call.expression.text === "defineCapability") return true;
  return bindings.get(call.expression.text)?.imported === "defineCapability";
}

function scanCapabilities(sourceFiles, knownFiles) {
  const errors = [];
  const entries = [];
  const sourceFileMap = new Map();
  for (const path of sourceFiles) {
    const source = ts.createSourceFile(path, fileContents.get(path), ts.ScriptTarget.Latest, true, path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    sourceFileMap.set(path, source);
  }

  for (const sourceFile of sourceFileMap.values()) {
    const bindings = importBindings(sourceFile);
    const visit = (node) => {
      if (ts.isCallExpression(node) && isDefineCapabilityCall(node, sourceFile, bindings)) {
        const argument = node.arguments[0];
        if (!argument || !ts.isObjectLiteralExpression(argument)) {
          errors.push(`${rel(sourceFile.fileName)} defineCapability must receive a static object literal`);
        } else {
          const kind = stringProperty(argument, "kind", sourceFile, errors);
          const id = stringProperty(argument, "id", sourceFile, errors);
          const version = stringProperty(argument, "version", sourceFile, errors);
          if (kind && id && version && ["local", "rpc", "stream"].includes(kind)) {
            const parser = {};
            const transfer = {};
            if (kind === "rpc") {
              for (const field of ["request", "response"]) {
                const source = parserSource(propertyExpression(argument, field), sourceFile, bindings, knownFiles);
                if (!source) errors.push(`${rel(sourceFile.fileName)} ${kind} capability is missing ${field} parser`);
                else parser[field] = source;
              }
              const transferExpression = propertyExpression(argument, "transfer");
              if (transferExpression && ts.isObjectLiteralExpression(transferExpression)) {
                for (const field of ["request", "response"]) {
                  const source = parserSource(propertyExpression(transferExpression, field), sourceFile, bindings, knownFiles);
                  if (source) transfer[field] = source;
                }
              }
            } else if (kind === "stream") {
              for (const field of ["request", "item"]) {
                const source = parserSource(propertyExpression(argument, field), sourceFile, bindings, knownFiles);
                if (!source) errors.push(`${rel(sourceFile.fileName)} ${kind} capability is missing ${field} parser`);
                else parser[field] = source;
              }
              const transferExpression = propertyExpression(argument, "transfer");
              if (transferExpression && ts.isObjectLiteralExpression(transferExpression)) {
                for (const field of ["request", "item"]) {
                  const source = parserSource(propertyExpression(transferExpression, field), sourceFile, bindings, knownFiles);
                  if (source) transfer[field] = source;
                }
              }
            }
            entries.push({
              kind,
              id,
              version,
              module: rel(sourceFile.fileName),
              moduleFingerprint: hashSource(fileContents.get(sourceFile.fileName)),
              ...(Object.keys(parser).length > 0 ? { parser } : {}),
              ...(Object.keys(transfer).length > 0 ? { transfer } : {}),
              dependencyFingerprints: [],
            });
          } else if (kind && !["local", "rpc", "stream"].includes(kind)) {
            errors.push(`${rel(sourceFile.fileName)} capability kind ${JSON.stringify(kind)} is invalid`);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sourceFile, visit);
  }

  const duplicates = new Map();
  for (const entry of entries) {
    const key = identityKey(entry);
    const previous = duplicates.get(key);
    if (previous) errors.push(`duplicate capability identity ${key.replaceAll("\u0000", "/")} in ${previous.module} and ${entry.module}`);
    else duplicates.set(key, entry);
  }
  return { entries, errors, sourceFileMap };
}

function addDependencyFingerprints(entries, sourceFileMap, knownFiles) {
  const sourceByPath = new Map([...sourceFileMap].map(([path, sourceFile]) => [path, sourceFile]));
  for (const entry of entries) {
    const entryPath = resolve(root, entry.module);
    const seen = new Set([entryPath]);
    const queue = [entryPath];
    while (queue.length > 0) {
      const current = queue.shift();
      const sourceFile = sourceByPath.get(current);
      if (!sourceFile) continue;
      for (const specifier of staticImports(sourceFile)) {
        const dependency = resolveLocalImport(current, specifier, knownFiles);
        if (!dependency || seen.has(dependency)) continue;
        seen.add(dependency);
        queue.push(dependency);
      }
    }
    entry.dependencyFingerprints = [...seen]
      .filter((path) => path !== entryPath)
      .sort()
      .map((path) => ({ path: rel(path), fingerprint: hashSource(fileContents.get(path)) }));
    for (const role of Object.values(entry.parser ?? {})) {
      if (role && knownFiles.has(resolve(root, role.module))) role.fingerprint = hashSource(fileContents.get(resolve(root, role.module)));
    }
    for (const role of Object.values(entry.transfer ?? {})) {
      if (role && knownFiles.has(resolve(root, role.module))) role.fingerprint = hashSource(fileContents.get(resolve(root, role.module)));
    }
  }
  return entries;
}

function sortEntries(entries) {
  return [...entries].sort((left, right) => identityKey(left).localeCompare(identityKey(right)));
}

function normalizeEntry(entry) {
  const normalized = {
    kind: entry.kind,
    id: entry.id,
    version: entry.version,
    module: entry.module,
    moduleFingerprint: entry.moduleFingerprint,
    ...(entry.parser ? { parser: entry.parser } : {}),
    ...(entry.transfer ? { transfer: entry.transfer } : {}),
    dependencyFingerprints: entry.dependencyFingerprints,
    contractTestVersion: entry.contractTestVersion,
    ...(entry.auditEvidence !== undefined ? { auditEvidence: entry.auditEvidence } : {}),
    ...(entry.versionChangeEvidence !== undefined ? { versionChangeEvidence: entry.versionChangeEvidence } : {}),
  };
  return normalized;
}

async function readInventory() {
  try {
    const value = JSON.parse(await readFile(inventoryPath, "utf8"));
    if (!value || value.schemaVersion !== 1 || !Array.isArray(value.entries)) throw new Error("schemaVersion 1 with entries[] is required");
    return value;
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw new Error(`Cannot read ${rel(inventoryPath)}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function readHeadInventory() {
  try {
    const { stdout } = await execFileAsync("git", ["show", `HEAD:${rel(inventoryPath)}`], { cwd: root, maxBuffer: 2 * 1024 * 1024 });
    const value = JSON.parse(stdout);
    return value?.schemaVersion === 1 && Array.isArray(value.entries) ? value : undefined;
  } catch {
    return undefined;
  }
}

function mapEntries(entries) {
  return new Map(entries.map((entry) => [identityKey(entry), entry]));
}

function compareInventory(observed, inventory, headInventory) {
  const errors = [];
  if (!inventory) {
    errors.push(`missing ${rel(inventoryPath)}; run node scripts/check-contract-inventory.mjs --print and review the generated inventory`);
    return errors;
  }
  const currentEntries = sortEntries(inventory.entries).map(normalizeEntry);
  const observedEntries = sortEntries(observed).map(normalizeEntry);
  if (JSON.stringify(currentEntries) !== JSON.stringify(observedEntries)) {
    const currentByKey = mapEntries(currentEntries);
    const observedByKey = mapEntries(observedEntries);
    for (const key of new Set([...currentByKey.keys(), ...observedByKey.keys()])) {
      if (!currentByKey.has(key)) errors.push(`contract inventory is missing observed identity ${key.replaceAll("\u0000", "/")}`);
      else if (!observedByKey.has(key)) errors.push(`contract inventory contains stale identity ${key.replaceAll("\u0000", "/")}`);
      else errors.push(`contract inventory fingerprint/metadata differs for ${key.replaceAll("\u0000", "/")}`);
    }
  }
  const currentByKey = mapEntries(currentEntries);
  for (const entry of currentEntries) {
    if (typeof entry.contractTestVersion !== "string" || entry.contractTestVersion.trim() === "") {
      errors.push(`contract inventory entry ${identityKey(entry).replaceAll("\u0000", "/")} needs a non-empty contractTestVersion`);
    }
    if (entry.auditEvidence !== undefined && typeof entry.auditEvidence !== "string") {
      errors.push(`contract inventory entry ${identityKey(entry).replaceAll("\u0000", "/")} auditEvidence must be a string`);
    }
    if (entry.versionChangeEvidence !== undefined && typeof entry.versionChangeEvidence !== "string") {
      errors.push(`contract inventory entry ${identityKey(entry).replaceAll("\u0000", "/")} versionChangeEvidence must be a string`);
    }
  }
  if (headInventory) {
    const oldByKey = mapEntries(headInventory.entries.map(normalizeEntry));
    for (const [key, entry] of currentByKey) {
      const old = oldByKey.get(key);
      if (old && JSON.stringify(old) !== JSON.stringify(entry)) {
        const fingerprintChanged = old.moduleFingerprint !== entry.moduleFingerprint
          || JSON.stringify(old.parser ?? {}) !== JSON.stringify(entry.parser ?? {})
          || JSON.stringify(old.transfer ?? {}) !== JSON.stringify(entry.transfer ?? {})
          || JSON.stringify(old.dependencyFingerprints) !== JSON.stringify(entry.dependencyFingerprints);
        if (fingerprintChanged && old.version === entry.version
          && (!entry.auditEvidence?.trim() || entry.contractTestVersion === old.contractTestVersion)) {
          errors.push(`source fingerprints changed for ${key.replaceAll("\u0000", "/")} without a new contractTestVersion and auditEvidence; bump business version for behavior changes or record reviewed pure-refactor evidence`);
        }
      }
      if (!old) {
        const sameContract = [...oldByKey.values()].find((candidate) => candidate.kind === entry.kind && candidate.id === entry.id);
        if (sameContract && (!entry.versionChangeEvidence?.trim() || entry.contractTestVersion === sameContract.contractTestVersion)) {
          errors.push(`contract version changed for ${entry.kind}/${entry.id} without versionChangeEvidence and a new contractTestVersion`);
        }
      }
    }
  }
  return errors;
}

const allSourceFiles = [...new Set((await Promise.all(sourceRoots.map(filesAt))).flat())]
  .filter((path) => !testFilePattern.test(path));
const fileContents = new Map();
for (const path of allSourceFiles) fileContents.set(path, await readFile(path, "utf8"));
const knownFiles = new Set(allSourceFiles);
const scanned = scanCapabilities(allSourceFiles, knownFiles);
addDependencyFingerprints(scanned.entries, scanned.sourceFileMap, knownFiles);
const inventory = await readInventory();
const metadataByKey = mapEntries(inventory?.entries ?? []);
const observed = scanned.entries.map((entry) => ({
  ...entry,
  ...(metadataByKey.get(identityKey(entry))?.contractTestVersion !== undefined
    ? { contractTestVersion: metadataByKey.get(identityKey(entry)).contractTestVersion }
    : { contractTestVersion: "<set-by-review>" }),
  ...(metadataByKey.get(identityKey(entry))?.auditEvidence !== undefined
    ? { auditEvidence: metadataByKey.get(identityKey(entry)).auditEvidence }
    : {}),
  ...(metadataByKey.get(identityKey(entry))?.versionChangeEvidence !== undefined
    ? { versionChangeEvidence: metadataByKey.get(identityKey(entry)).versionChangeEvidence }
    : {}),
}));

if (args.has("--print")) {
  console.log(JSON.stringify({ schemaVersion: 1, entries: sortEntries(observed).map(normalizeEntry) }, null, 2));
  process.exitCode = scanned.errors.length > 0 ? 1 : 0;
} else {
  const errors = [...scanned.errors, ...compareInventory(observed, inventory, await readHeadInventory())];
  if (errors.length > 0) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else {
    console.log(`WebLoom contract inventory check passed (${observed.length} identities)`);
  }
}
