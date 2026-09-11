import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const scanner = fileURLToPath(new URL("./check-contract-inventory.mjs", import.meta.url));
const args = process.argv.slice(2);

function runGit(arguments_) {
  return new Promise((resolve) => {
    execFile("git", arguments_, { maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        code: typeof error?.code === "number" ? error.code : error ? 1 : 0,
        stdout,
        stderr,
      });
    });
  });
}

const configuredRef = process.env.CONTRACT_INVENTORY_BASELINE_REF?.trim();
const pullRequestBase = process.env.GITHUB_BASE_SHA?.trim();
let baselineRef = configuredRef || pullRequestBase;
if (!baselineRef) {
  const result = await runGit(["merge-base", "HEAD", "origin/main"]);
  if (result.code === 0) baselineRef = result.stdout.trim();
}
if (!baselineRef) {
  throw new Error("Cannot determine contract inventory baseline; set CONTRACT_INVENTORY_BASELINE_REF or provide GITHUB_BASE_SHA");
}

const child = spawn(process.execPath, [scanner, "--baseline-ref", baselineRef, ...args], { stdio: "inherit" });
child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on("close", (code) => {
  process.exitCode = code ?? 1;
});
