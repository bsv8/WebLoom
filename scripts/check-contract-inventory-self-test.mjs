import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const scanner = fileURLToPath(new URL("./check-contract-inventory.mjs", import.meta.url));
const root = await mkdtemp(join(tmpdir(), "webloom-contract-inventory-self-test-"));

function run(command, arguments_, options = {}) {
  return new Promise((resolve) => {
    execFile(command, arguments_, { ...options, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        code: typeof error?.code === "number" ? error.code : error ? 1 : 0,
        stdout,
        stderr,
      });
    });
  });
}

async function runGit(arguments_) {
  const result = await run("git", arguments_, { cwd: root });
  assert.equal(result.code, 0, `git ${arguments_.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

async function runScanner(arguments_) {
  return run(process.execPath, [scanner, "--root", root, ...arguments_], { cwd: root });
}

try {
  await mkdir(join(root, "src"), { recursive: true });
  const sourcePath = join(root, "src", "capability.ts");
  const inventoryPath = join(root, "contract-inventory.json");
  await writeFile(sourcePath, [
    "declare function defineCapability<T>(definition: T): T;",
    "export const selfTestCapability = defineCapability({",
    '  kind: "local",',
    '  id: "inventory-self-test",',
    '  version: "1.0.0",',
    "});",
    "",
  ].join("\n"), "utf8");

  let result = await runScanner(["--print"]);
  assert.equal(result.code, 0, `initial scanner print failed\n${result.stdout}\n${result.stderr}`);
  await writeFile(inventoryPath, `${result.stdout}\n`, "utf8");

  await runGit(["init", "-q"]);
  await runGit(["config", "user.email", "contract-inventory-self-test@example.invalid"]);
  await runGit(["config", "user.name", "Contract Inventory Self Test"]);
  await runGit(["add", "."]);
  await runGit(["commit", "-qm", "baseline"]);
  const baselineRef = await runGit(["rev-parse", "HEAD"]);

  await writeFile(sourcePath, `${await readFile(sourcePath, "utf8")}// implementation changed\n`, "utf8");
  result = await runScanner(["--print"]);
  assert.equal(result.code, 0, `changed scanner print failed\n${result.stdout}\n${result.stderr}`);
  await writeFile(inventoryPath, `${result.stdout}\n`, "utf8");
  await runGit(["add", "."]);
  await runGit(["commit", "-qm", "changed-source-and-inventory"]);

  // The default HEAD baseline reproduces the historical CI bypass: both the
  // source and inventory from the second commit are treated as current.
  result = await runScanner([]);
  assert.equal(result.code, 0, `HEAD baseline should pass the bypass fixture\n${result.stdout}\n${result.stderr}`);

  result = await runScanner(["--baseline-ref", baselineRef]);
  assert.notEqual(result.code, 0, "an explicit base commit must reject an unchanged contractTestVersion");
  assert.match(`${result.stdout}\n${result.stderr}`, /source fingerprints changed/);
  console.log("WebLoom contract inventory baseline self-test passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
