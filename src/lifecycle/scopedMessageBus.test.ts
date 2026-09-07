import { describe, expect, it } from "vitest";
import { createMessageBus } from "../messaging/messageBus.js";
import { createLifecycleScope } from "./resourceScope.js";
import { createScopedMessageBus } from "./scopedMessageBus.js";

describe("scoped message bus", () => {
  it("removes old subscribers and handlers synchronously on revoke", async () => {
    const base = createMessageBus();
    const scope = createLifecycleScope({ kind: "plugin-instance", metadata: { pluginId: "old-plugin" } });
    const bus = createScopedMessageBus(base, scope);
    let events = 0;
    let commands = 0;

    bus.subscribe("old.event", () => { events += 1; });
    bus.handle("old.command", () => {
      commands += 1;
      return "handled";
    }, { target: "old-plugin" });

    base.publish("old.event", {});
    await expect(base.request("old.command", {}, { target: "old-plugin" })).resolves.toBe("handled");
    expect(events).toBe(1);
    expect(commands).toBe(1);

    scope.revoke("plugin disabled");

    // 不等待异步 dispose；revoke 之后旧入口必须已经不可见。
    base.publish("old.event", {});
    await expect(base.request("old.command", {}, { target: "old-plugin" })).rejects.toThrow(/no handler/i);
    expect(events).toBe(1);
    expect(commands).toBe(1);
    expect(() => bus.publish("old.event", {})).toThrow(/stopping|revoked/i);

    await scope.dispose();
  });

  it("removes dispatch lifecycle listeners when the mailbox entry settles", async () => {
    const base = createMessageBus();
    const scope = createLifecycleScope({ kind: "plugin-instance" });
    const bus = createScopedMessageBus(base, scope);
    base.handle("command.done", () => "done", { target: "command" });

    bus.dispatch("command.done", {}, { target: "command" });
    await Promise.resolve();
    await Promise.resolve();

    // dispatch 已经完成时，scope 不应再保留一条一次性 onDispose 监听。
    const result = await scope.dispose();
    expect(result.attempted).toBe(0);
  });
});
