import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const sourceFiles = [
  "src/transport/serviceBridge.ts",
  "src/runtime/runtimeProtocol.ts",
];

const mutations = [
  {
    name: "cancel",
    file: "src/transport/serviceBridge.ts",
    find: 'settleUnary(entry, frameworkError("request_cancelled", "dispose", contextFor(entry.capability, reference)));',
    replace: 'void frameworkError("request_cancelled", "dispose", contextFor(entry.capability, reference));',
  },
  {
    name: "deadline",
    file: "src/transport/serviceBridge.ts",
    find: `entry.timer = setTimeout(() => {
        if (entry.settled) return;
        settleUnary(entry, frameworkError("call_timeout", "receive", contextFor(entry.capability, reference)));
        sendCancel(entry);
      }, timeout);`,
    replace: "entry.timer = undefined;",
  },
  {
    name: "instance-filter",
    file: "src/transport/serviceBridge.ts",
    find: 'if (!entry || entry.reference.serviceInstanceId !== message.serviceInstanceId) { ledger.closeUndelivered(); return; }',
    replace: 'if (!entry) { ledger.closeUndelivered(); return; }',
  },
  {
    name: "directory-validation",
    file: "src/runtime/runtimeProtocol.ts",
    find: "if (value.type === RUNTIME_SNAPSHOT_TYPE) return validateSnapshot(value);",
    replace: "if (value.type === RUNTIME_SNAPSHOT_TYPE) return true;",
  },
  {
    name: "revoke",
    file: "src/transport/serviceBridge.ts",
    find: "proxy.revoked = true;",
    replace: "proxy.revoked = false;",
  },
];

const testSource = `
import { describe, expect, it } from "vitest";
import { defineCapability } from "./src/contracts/capability.js";
import { createCapabilityBridge } from "./src/transport/serviceBridge.js";
import { createFakeRuntimeTransport } from "./src/testing/fakes.js";
import { createRuntimeMessageCodec, RUNTIME_PROTOCOL_VERSION, RUNTIME_RESULT_TYPE, RUNTIME_SNAPSHOT_TYPE } from "./src/runtime/runtimeProtocol.js";

const Echo = defineCapability({
  kind: "rpc",
  id: "ablation.echo",
  version: "1",
  request: { parse(value) { if (!value || typeof value !== "object" || typeof value.value !== "string") throw new Error("invalid request"); return value; } },
  response: { parse(value) { if (!value || typeof value !== "object" || typeof value.result !== "string") throw new Error("invalid response"); return value; } },
});

function snapshot(serviceInstanceId, revision = 1) {
  return {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    runtimeId: "ablation-worker",
    runtimeKind: "shared-worker",
    runtimeInstanceId: "ablation-runtime",
    revision,
    state: "ready",
    units: [],
    services: [{ kind: "rpc", capabilityId: Echo.id, contractVersion: Echo.version, serviceInstanceId, attributes: {} }],
  };
}

function pause(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

async function outcome(promise, milliseconds = 250) {
  return Promise.race([
    promise.then((value) => ({ kind: "resolved", value }), (error) => ({ kind: "rejected", error })),
    pause(milliseconds).then(() => ({ kind: "hung" })),
  ]);
}

describe("AT-22 ablation probes", () => {
  it("cancel synchronously fences the pending call", async () => {
    const transport = createFakeRuntimeTransport();
    const bridge = createCapabilityBridge({ transport, defaultCallTimeoutMs: 80 });
    try {
      bridge.applySnapshot(snapshot("service:cancel"));
      const controller = new AbortController();
      const call = bridge.getClient(Echo).call({ value: "cancel" }, { signal: controller.signal, timeoutMs: 80 });
      controller.abort();
      const result = await outcome(call);
      expect(result.kind).toBe("rejected");
      expect(result.error).toMatchObject({ code: "request_cancelled" });
      expect(bridge.pendingCallCount).toBe(0);
    } finally { bridge.dispose(); }
  });

  it("deadline settles a call even when the transport stays silent", async () => {
    const transport = createFakeRuntimeTransport();
    const bridge = createCapabilityBridge({ transport, defaultCallTimeoutMs: 30 });
    try {
      bridge.applySnapshot(snapshot("service:deadline"));
      const result = await outcome(bridge.getClient(Echo).call({ value: "deadline" }, { timeoutMs: 30 }));
      expect(result.kind).toBe("rejected");
      expect(result.error).toMatchObject({ code: "call_timeout" });
      expect(bridge.pendingCallCount).toBe(0);
    } finally { bridge.dispose(); }
  });

  it("ignores a result carrying the wrong service instance", async () => {
    const transport = createFakeRuntimeTransport();
    const bridge = createCapabilityBridge({ transport, defaultCallTimeoutMs: 35 });
    try {
      bridge.applySnapshot(snapshot("service:instance"));
      const call = bridge.getClient(Echo).call({ value: "instance" }, { timeoutMs: 35 });
      while (transport.sent.length === 0) await pause(0);
      const wire = transport.sent[0].message;
      transport.emit({ type: RUNTIME_RESULT_TYPE, protocolVersion: RUNTIME_PROTOCOL_VERSION, callId: wire.callId, serviceInstanceId: "service:wrong", result: { result: "wrong" } });
      const result = await outcome(call);
      expect(result.kind).toBe("rejected");
      expect(result.error).toMatchObject({ code: "call_timeout" });
    } finally { bridge.dispose(); }
  });

  it("rejects an invalid runtime directory before it can be applied", () => {
    const codec = createRuntimeMessageCodec();
    expect(() => codec.decode({
      type: RUNTIME_SNAPSHOT_TYPE,
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      runtimeId: "ablation-worker",
      runtimeKind: "shared-worker",
      runtimeInstanceId: "ablation-runtime",
      revision: 1,
      state: "starting",
      units: [],
      services: [{ kind: "rpc", capabilityId: Echo.id, contractVersion: Echo.version, serviceInstanceId: "service:invalid", attributes: {} }],
    })).toThrow();
  });

  it("revokes the old proxy before a replacement can be used", async () => {
    const transport = createFakeRuntimeTransport();
    const bridge = createCapabilityBridge({ transport, defaultCallTimeoutMs: 100 });
    try {
      bridge.applySnapshot(snapshot("service:first"));
      const oldClient = bridge.getClient(Echo);
      const oldCall = oldClient.call({ value: "old" }, { timeoutMs: 100 });
      while (transport.sent.length === 0) await pause(0);
      bridge.applySnapshot(snapshot("service:second", 2));
      const oldResult = await outcome(oldCall);
      expect(oldResult.kind).toBe("rejected");
      expect(oldResult.error).toMatchObject({ code: "service_revoked" });

      const replacement = bridge.getClient(Echo);
      const replacementCall = replacement.call({ value: "new" }, { timeoutMs: 100 });
      const wire = transport.sent.at(-1).message;
      expect(wire.serviceInstanceId).toBe("service:second");
      transport.emit({ type: RUNTIME_RESULT_TYPE, protocolVersion: RUNTIME_PROTOCOL_VERSION, callId: wire.callId, serviceInstanceId: wire.serviceInstanceId, result: { result: "new" } });
      await expect(replacementCall).resolves.toEqual({ result: "new" });
    } finally { bridge.dispose(); }
  });
});
`;

function runVitest(root, testPath) {
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", ["exec", "vitest", "run", "--root", root, testPath, "--reporter=dot"], {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.stderr.on("data", (chunk) => { output += String(chunk); });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal, output }));
  });
}

function mutate(source, mutation) {
  if (!source.includes(mutation.find)) throw new Error(`AT-22 mutation target not found: ${mutation.name}`);
  return source.replace(mutation.find, mutation.replace);
}

const tempRoot = await mkdtemp(join(tmpdir(), "webloom-v4-ablation-"));
const testPath = join(tempRoot, "ablation.test.ts");
try {
  await cp(join(projectRoot, "src"), join(tempRoot, "src"), { recursive: true });
  await writeFile(testPath, testSource, "utf8");
  const originals = new Map();
  for (const relative of sourceFiles) originals.set(relative, await readFile(join(tempRoot, relative), "utf8"));

  const baseline = await runVitest(tempRoot, testPath);
  if (baseline.code !== 0) throw new Error(`AT-22 baseline failed\n${baseline.output}`);
  console.log("AT-22 baseline: pass");

  for (const mutation of mutations) {
    const original = originals.get(mutation.file);
    await writeFile(join(tempRoot, mutation.file), mutate(original, mutation), "utf8");
    const ablated = await runVitest(tempRoot, testPath);
    await writeFile(join(tempRoot, mutation.file), original, "utf8");
    if (ablated.code === 0) throw new Error(`AT-22 ablation unexpectedly passed: ${mutation.name}\n${ablated.output}`);
    console.log(`AT-22 ${mutation.name}: fails as expected`);
  }

  const restored = await runVitest(tempRoot, testPath);
  if (restored.code !== 0) throw new Error(`AT-22 restored source failed\n${restored.output}`);
  console.log("AT-22 restored: pass");
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
