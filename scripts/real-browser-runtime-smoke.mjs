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
      // 独立进程组：`pnpm exec` 会再派生一个 vite 进程，只 kill 包装进程会留下
      // 真正占着端口的孙进程，导致下一次运行以 "Port 4178 is already in use" 失败。
      detached: true,
    });
    let serverOutput = "";
    server.stdout.on("data", (chunk) => { serverOutput += String(chunk); });
    server.stderr.on("data", (chunk) => { serverOutput += String(chunk); });
    // preview 子进程的 pipe 会让父进程的事件循环一直存活；只注册 exit 钩子会让
    // 脚本在打印结果后挂住不退出，pnpm test:browser 因此永远等不到结束。
    // 这里终止整个进程组并等待退出，兜底强杀只用于不配合的 preview。
    const stopped = new Promise((resolve) => {
      server.once("exit", () => resolve(undefined));
    });
    const signalGroup = (signal) => {
      try { process.kill(-server.pid, signal); }
      catch { try { server.kill(signal); } catch { /* 进程组已退出 */ } }
    };
    let forceTimer;
    const stopServer = async () => {
      if (server.exitCode === null && !server.killed) {
        signalGroup("SIGTERM");
        // 兜底强杀只用于不配合的 preview；定时器不阻止父进程退出。
        forceTimer = setTimeout(() => signalGroup("SIGKILL"), 5_000);
        forceTimer.unref?.();
      }
      await stopped;
      clearTimeout(forceTimer);
      // 子进程退出后它继承的 pipe 仍会让父进程事件循环存活，脚本打印完结果
      // 就挂着不退出；必须显式销毁这些流。
      server.stdout?.destroy();
      server.stderr?.destroy();
    };
    process.once("exit", () => { if (server && server.exitCode === null) signalGroup("SIGKILL"); });
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
            return readCurrentResult(page);
          };
          const readCurrentResult = async (page) => {
            await page.waitForFunction(
              () => Boolean(window.__WEBLOOM_RESULT__),
              undefined,
              { timeout: 10_000 },
            );
            return page.evaluate(() => window.__WEBLOOM_RESULT__);
          };
          const goto = async (page, url) => page.goto(url, { waitUntil: "domcontentloaded" });
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
            || !first.serviceInstanceId
            || !second.serviceInstanceId
            || first.serviceInstanceId === second.serviceInstanceId
            || first.reverseResult !== "page:reverse"
            || second.reverseResult !== "page:reverse"
            || JSON.stringify(first.streamValues) !== JSON.stringify([1, 2, 3])
            || JSON.stringify(second.streamValues) !== JSON.stringify([1, 2, 3])
            || first.transferDetached !== true
            || second.transferDetached !== true
            || first.transferByteLength !== 8
            || second.transferByteLength !== 8
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

          const transferPage = await context.newPage();
          const transferMatrix = await readResult(transferPage, `${baseUrl}?scenario=transfer-matrix`);
          const transferCases = Array.isArray(transferMatrix?.transferMatrix?.cases)
            ? transferMatrix.transferMatrix.cases
            : [];
          if (!transferMatrix || transferMatrix.ok !== true
            || transferMatrix.transferMatrix?.ok !== true
            || transferCases.length < 10
            || transferCases.some((result) => result?.ok !== true)
            || transferCases.find((result) => result?.marker === "rpc-normal")?.requestBufferDetached !== true
            || transferCases.find((result) => result?.marker === "rpc-normal")?.responseViewsShareBuffer !== true
            || transferCases.find((result) => result?.marker === "rpc-normal")?.requestPortDelivered !== true
            || transferCases.find((result) => result?.marker === "rpc-normal")?.responsePortRoundTrip !== true
            || transferCases.find((result) => result?.marker === "rpc-duplicate")?.ok !== true
            || transferCases.find((result) => result?.marker === "rpc-unreachable-request")?.errorCode !== "transfer_invalid"
            || transferCases.find((result) => result?.marker === "rpc-unreachable-request")?.requestBufferByteLength !== 32
            || transferCases.find((result) => result?.marker === "rpc-unreachable-response")?.errorCode !== "transfer_invalid"
            || transferCases.find((result) => result?.marker === "stream-normal")?.itemViewsShareBuffer?.every((value) => value === true) !== true
            || transferCases.find((result) => result?.marker === "stream-normal")?.itemPortRoundTrips?.every((value) => value === true) !== true
            || transferCases.find((result) => result?.marker === "stream-unreachable-item")?.closedErrorCode !== "transfer_invalid"
            || transferCases.find((result) => result?.marker === "stream-cancel-before-ready")?.closedErrorCode !== "request_cancelled"
            || transferCases.find((result) => result?.marker === "stream-cancel-after-send")?.closedErrorCode !== "request_cancelled"
            || transferCases.find((result) => result?.marker === "stream-cancel-after-send")?.requestBufferDetached !== true
            || transferCases.find((result) => result?.ok === true && result?.marker === "cancel-before-send")?.bufferByteLength !== 32) {
            throw new Error(`real transfer matrix assertions failed: ${JSON.stringify(transferMatrix)}`);
          }
          await transferPage.close();

          const reconnectPage = await context.newPage();
          const reconnectResult = await readResult(reconnectPage, `${baseUrl}?scenario=reconnect`);
          if (!reconnectResult || reconnectResult.ok !== true
            || reconnectResult.scenario !== "reconnect"
            || reconnectResult.reconnected !== true
            || reconnectResult.firstRuntimeInstanceId !== reconnectResult.secondRuntimeInstanceId
            || reconnectResult.firstReverseResult !== "page:reverse"
            || !["service_revoked", "transport_unavailable"].includes(String(reconnectResult.oldProxyError))) {
            throw new Error(`real reconnect assertions failed: ${JSON.stringify(reconnectResult)}`);
          }
          await reconnectPage.close();

          const terminalPages = [await context.newPage(), await context.newPage()];
          await Promise.all(terminalPages.map((page, index) => goto(
            page,
            `${baseUrl}?scenario=${index === 0 ? "terminal-trigger" : "terminal-observer"}`,
          )));
          await Promise.all(terminalPages.map((page) => page.waitForFunction(
            () => window.__WEBLOOM_TERMINAL_READY__?.connected === true
              && window.__WEBLOOM_TERMINAL_READY__?.runtimeReady === true
              && window.__WEBLOOM_TERMINAL_READY__?.subscriptionInstalled === true,
            undefined,
            { timeout: 10_000 },
          )));
          const terminalReady = await Promise.all(terminalPages.map((page) => page.evaluate(
            () => window.__WEBLOOM_TERMINAL_READY__,
          )));
          if (terminalReady.some((state) => !state?.connected || !state.runtimeReady || !state.subscriptionInstalled)) {
            throw new Error(`terminal connection barrier failed: ${JSON.stringify(terminalReady)}`);
          }
          await terminalPages[0].evaluate(() => window.__WEBLOOM_SHUTDOWN__?.());
          const terminalResults = await Promise.all(terminalPages.map((page) => readCurrentResult(page)));
          if (terminalResults.some((result) => !result || result.ok !== true)
            || terminalResults.some((result) => !Array.isArray(result.states)
              || !result.states.includes("stopping")
              || !result.states.includes("disposed"))
            || terminalResults.some((result) => !result.terminalReady?.connected
              || !result.terminalReady?.runtimeReady
              || !result.terminalReady?.subscriptionInstalled)
            || !["service_revoked", "transport_unavailable"].includes(String(terminalResults[0]?.oldProxyError))
            || Number(terminalResults[0]?.elapsedMs) >= 500) {
            throw new Error(`real terminal dispose assertions failed: ${JSON.stringify(terminalResults)}`);
          }
          const latePage = await context.newPage();
          const lateResult = await readResult(latePage, `${baseUrl}?scenario=terminal-late`);
          if (!lateResult || lateResult.ok !== true
            || lateResult.scenario !== "terminal-late"
            || !Array.isArray(lateResult.states)
            || !lateResult.states.includes("disposed")
            || lateResult.states.includes("stopping")) {
            throw new Error(`real late terminal connection assertions failed: ${JSON.stringify(lateResult)}`);
          }
          await latePage.close();
          await Promise.all(terminalPages.map((page) => page.close()));

          const mismatchPage = await context.newPage();
          const mismatchResult = await readResult(mismatchPage, `${baseUrl}?scenario=protocol-mismatch`);
          if (!mismatchResult || mismatchResult.ok !== true
            || mismatchResult.scenario !== "protocol-mismatch"
            || !String(mismatchResult.error ?? "").toLowerCase().includes("protocol")) {
            throw new Error(`real protocol mismatch assertions failed: ${JSON.stringify(mismatchResult)}`);
          }
          await mismatchPage.close();

          // 插件实例消费边界的独立页面（PCB-R08）：动态页面、静态首页贡献、
          // 提供方共享 Picker 三种场景，以及撤权、同名重启和负面断言。
          const consumerPage = await context.newPage();
          await consumerPage.goto(`${baseUrl}plugin-consumer.html`, { waitUntil: "domcontentloaded" });
          await consumerPage.waitForFunction(
            () => Boolean(window.__WEBLOOM_PCB_RESULT__),
            undefined,
            { timeout: 40_000 },
          );
          const consumerResult = await consumerPage.evaluate(() => window.__WEBLOOM_PCB_RESULT__);
          if (!consumerResult || consumerResult.ok !== true
            // 场景一：动态页面按实例读取能力，已声明但缺席的可选能力正常缺席。
            || consumerResult.dynamicTheme !== "dark"
            || consumerResult.optionalState !== "absent:false"
            // 场景二：静态首页贡献按同一实例读取能力。
            || consumerResult.homeTheme !== "home:dark"
            // 场景三：共享 Picker 在提供方 Provider 下运行。
            || consumerResult.sharedPicker !== "picker-open"
            // 注册项、consumer 与实际实例一致。
            || consumerResult.ownerConsistent !== true
            // 网页插件挂载 Storage 注册的三类 UI，组件读取自己的私有实现。
            || consumerResult.storagePage !== "page:bucket-a/contacts=v1"
            || consumerResult.storageSettings !== "settings:bucket-a"
            || consumerResult.storageHeader !== "header:bucket-a"
            || JSON.stringify(consumerResult.webUiKinds) !== JSON.stringify([
              "page", "settings", "header", "page", "settings", "header",
            ])
            // 条目归属由框架按实例身份写入。
            || consumerResult.ownerBound !== true
            // 贡献实例撤销后它的条目被撤下；另一个 Storage 实例不受影响。
            || consumerResult.entriesAfterRevoke !== 0
            || consumerResult.storageUiAfterRevoke !== "page:bucket-b/contacts=v1"
            // 负面：私有实现无公开入口、越权注销、伪造 consumer、插件子树 App hook。
            || consumerResult.privateUnreachable !== true
            || consumerResult.crossOwnerRejected !== true
            || consumerResult.forgedRejected !== true
            || consumerResult.appHookRejected !== true
            // 负面：未声明内置资源注册表的插件既读不到也不能留下资源定义。
            || consumerResult.undeclaredRegistryRejected !== true
            || consumerResult.sneakedAbsent !== true
            // 撤权后旧子树停止渲染、旧 consumer 拒绝；同名重启是新实例。
            || consumerResult.beforeDisable !== "dark"
            || consumerResult.afterDisable !== null
            || consumerResult.revokedRejected !== true
            || consumerResult.newInstance !== true
            || consumerResult.stillRevoked !== true
            || consumerResult.afterRestart !== "dark"
            // 提供方停用后旧 Picker 引用永久失效。
            || consumerResult.pickerRevoked !== true
            // 实例资源按 owner 解析；owner 撤权后不降级为宿主资源。
            || consumerResult.profileData !== "owner-scoped-profile"
            || consumerResult.profileAfterRevoke !== false) {
            throw new Error(`plugin consumer boundary assertions failed: ${JSON.stringify(consumerResult)}`);
          }
          await consumerPage.close();

          // 多 Worker 槽位与所属私有通信（PSM-R11–R13）：一个页面同时连接两个
          // 真实 SharedWorker，验证并存、顺序无关、单边断开与私有跨单元入口。
          const multiWorkerPage = await context.newPage();
          await multiWorkerPage.goto(`${baseUrl}multi-worker.html`, { waitUntil: "domcontentloaded" });
          await multiWorkerPage.waitForFunction(
            () => Boolean(window.__WEBLOOM_MULTI_WORKER_RESULT__),
            undefined,
            { timeout: 40_000 },
          );
          const multiWorkerResult = await multiWorkerPage.evaluate(() => window.__WEBLOOM_MULTI_WORKER_RESULT__);
          if (!multiWorkerResult || multiWorkerResult.ok !== true
            // 两个真实 Worker 都已就绪（先 Vault 后 Storage 的挂接顺序不影响绑定）。
            || multiWorkerResult.vaultReady !== true
            // 必需依赖由 Host 自己收敛：Worker 发布目录后不再需要外部 reconcile。
            || multiWorkerResult.storageAutoConverged !== true
            || multiWorkerResult.vaultAutoConverged !== true
            // 未授权调用方（普通 RuntimeHandle 句柄）拿不到私有函数。
            || multiWorkerResult.unauthorizedCall !== "permission_denied"
            || multiWorkerResult.publicStorage !== "a.txt,b.txt"
            || multiWorkerResult.publicVault !== "100"
            // 同插件同单元的私有跨单元调用可用。
            || multiWorkerResult.privateStorage !== "private:a.txt,b.txt"
            // 其他插件没有私有解析入口（三条路径都被拒）。
            || multiWorkerResult.outsiderRejected !== true
            || typeof multiWorkerResult.outsiderDenials !== "string"
            // 断开 Storage 槽位：Storage 回到等待，Vault 继续工作。
            || multiWorkerResult.storageStateAfterDetach !== "blocked"
            || multiWorkerResult.vaultStillWorks !== "100"
            // 同槽位换成新连接后，旧连接的延迟卸载不能误伤新连接。
            || multiWorkerResult.staleCleanupKeptConnection !== true
            || multiWorkerResult.storageReadyAfterReplace !== true
            || multiWorkerResult.publicStorageAfterReattach !== "a.txt,b.txt"
            // 完整插件包：同一 pluginId 的 Web/Worker 单元。
            || multiWorkerResult.packageUnits !== "worker@shared-worker,web@window-main"
            || multiWorkerResult.vaultPackageUnits !== "worker@shared-worker,web@window-main") {
            throw new Error(`multi worker slot assertions failed: ${JSON.stringify(multiWorkerResult)}`);
          }
          await multiWorkerPage.close();

          console.log(JSON.stringify({
            ok: true,
            build: "production",
            emittedWorkerChunks: workerFiles,
            results,
            transferMatrix,
            reconnect: reconnectResult,
            terminalDispose: terminalResults,
            terminalLate: lateResult,
            protocolMismatch: mismatchResult,
            pluginConsumer: consumerResult,
            multiWorker: multiWorkerResult,
          }, null, 2));
          await context.close();
        } finally {
          await browser.close();
        }
      }
    } finally {
      await stopServer();
    }
  } catch (error) {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  } finally {
    await rm(outputDir, { recursive: true, force: true });
    // 所有清理完成后再退出一次：playwright 的传输层可能仍留有 pipe 句柄，
    // 那样脚本会打印完结果却空转不退出，pnpm run test:browser 永远等不到结束。
    // 先把 stdout 刷完，避免截断最后一行 JSON。
    await new Promise((resolve) => process.stdout.write("", resolve));
    process.exit(process.exitCode ?? 0);
  }
}
