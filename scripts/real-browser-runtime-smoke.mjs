import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const fixtureRoot = fileURLToPath(new URL("./browser-runtime-fixture", import.meta.url));
const port = Number(process.env.WEBLOOM_BROWSER_PORT ?? 4178);
const baseUrl = `http://127.0.0.1:${port}/`;

let playwright;
try {
  playwright = await import("playwright");
} catch {
  console.error("unsupported: install the Playwright dev dependency and Chromium to run the real SharedWorker fixture");
  process.exitCode = 2;
}

function run(command, args, cwd = projectRoot) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.stderr.on("data", (chunk) => { output += String(chunk); });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        if (output.trim()) process.stdout.write(output);
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} failed (${signal ?? code})\n${output}`));
    });
  });
}

async function listFiles(root, prefix = "") {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(join(root, entry.name), relative));
    else files.push(relative);
  }
  return files;
}

if (playwright) {
  const outputDir = await mkdtemp(join(tmpdir(), "webloom-browser-runtime-dist-"));
  let server;
  try {
    // Build before serving. The browser must receive Vite's emitted
    // SharedWorker chunk, never a source .ts URL or an inlined data URL.
    await run("pnpm", ["exec", "vite", "build", fixtureRoot, "--outDir", outputDir, "--emptyOutDir"]);
    const builtFiles = await listFiles(outputDir);
    const workerFiles = builtFiles.filter((file) => (
      file.endsWith(".js")
      && (basename(file).startsWith("worker-") || basename(file).startsWith("incompatible-worker-"))
    ));
    if (workerFiles.length === 0) {
      throw new Error(`production fixture did not emit a SharedWorker chunk: ${builtFiles.join(", ")}`);
    }
    const workerSource = await readFile(join(outputDir, workerFiles[0]), "utf8");
    if (workerSource.includes("interface ") || workerSource.includes("import { definePlugin")) {
      throw new Error(`production SharedWorker chunk still contains source TypeScript: ${workerFiles[0]}`);
    }

    server = spawn("pnpm", ["exec", "vite", "preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort", "--outDir", outputDir], {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let serverOutput = "";
    server.stdout.on("data", (chunk) => { serverOutput += String(chunk); });
    server.stderr.on("data", (chunk) => { serverOutput += String(chunk); });
    const stopServer = () => {
      if (server && !server.killed) server.kill("SIGTERM");
    };
    process.once("exit", stopServer);
    try {
      let ready = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          const response = await fetch(baseUrl);
          if (response.ok) {
            ready = true;
            break;
          }
        } catch {
          // Vite preview is still starting.
        }
        await delay(50);
      }
      if (!ready) throw new Error(`fixture preview did not start: ${serverOutput}`);

      let browser;
      try {
        browser = await playwright.chromium.launch({ headless: true });
      } catch (error) {
        console.error(`unsupported: Chromium is unavailable (${error instanceof Error ? error.message : String(error)})`);
        process.exitCode = 2;
      }
      if (browser) {
        try {
          const context = await browser.newContext();
          const readResult = async (page, url) => {
            await page.goto(url);
            await page.waitForFunction(
              () => Boolean(window.__WEBLOOM_RESULT__),
              undefined,
              { timeout: 10_000 },
            );
            return page.evaluate(() => window.__WEBLOOM_RESULT__);
          };
          const pages = [await context.newPage(), await context.newPage()];
          const results = await Promise.all(pages.map((page) => readResult(page, baseUrl)));
          if (results.some((result) => !result || result.ok !== true)) {
            throw new Error(`fixture failed: ${JSON.stringify(results)}`);
          }
          const first = results[0];
          const second = results[1];
          if (!first || !second
            || first.workerRealm !== "SharedWorkerGlobalScope"
            || second.workerRealm !== "SharedWorkerGlobalScope"
            || first.windowRealm !== "Window"
            || second.windowRealm !== "Window"
            || first.setupCount !== 1
            || second.setupCount !== 1
            || first.workerRuntimeInstanceId !== second.workerRuntimeInstanceId
            || first.connectionId === second.connectionId
            || typeof first.workerUrl !== "string"
            || first.workerUrl.startsWith("data:")
            || first.workerUrl.endsWith(".ts")) {
            throw new Error(`real production realm assertions failed: ${JSON.stringify(results)}`);
          }
          const workerResponse = await fetch(new URL(first.workerUrl, baseUrl));
          if (!workerResponse.ok || (await workerResponse.text()).includes("interface ")) {
            throw new Error(`emitted SharedWorker URL is not executable JavaScript: ${first.workerUrl}`);
          }
          await Promise.all(pages.map((page) => page.close()));

          const reconnectPage = await context.newPage();
          const reconnectResult = await readResult(reconnectPage, `${baseUrl}?scenario=reconnect`);
          if (!reconnectResult || reconnectResult.ok !== true
            || reconnectResult.scenario !== "reconnect"
            || reconnectResult.reconnected !== true
            || reconnectResult.firstConnectionId === reconnectResult.secondConnectionId) {
            throw new Error(`real reconnect assertions failed: ${JSON.stringify(reconnectResult)}`);
          }
          await reconnectPage.close();

          const mismatchPage = await context.newPage();
          const mismatchResult = await readResult(mismatchPage, `${baseUrl}?scenario=protocol-mismatch`);
          if (!mismatchResult || mismatchResult.ok !== true
            || mismatchResult.scenario !== "protocol-mismatch"
            || !String(mismatchResult.error ?? "").toLowerCase().includes("protocol")) {
            throw new Error(`real protocol mismatch assertions failed: ${JSON.stringify(mismatchResult)}`);
          }
          await mismatchPage.close();

          console.log(JSON.stringify({
            ok: true,
            build: "production",
            emittedWorkerChunks: workerFiles,
            results,
            reconnect: reconnectResult,
            protocolMismatch: mismatchResult,
          }, null, 2));
          await context.close();
        } finally {
          await browser.close();
        }
      }
    } finally {
      stopServer();
    }
  } catch (error) {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
}
