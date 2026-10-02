// 通用注册门面的信任绑定回归（PSM-R04 / PSM-R05）。
//
// 归属来自 Scope 签发的实例身份：产品实现注册表与条目 schema，框架负责绑定归属、
// 拒绝越权注销、撤销清理与迟到注册回收。

import { describe, expect, it } from "vitest";
import { createLifecycleScope } from "./resourceScope.js";
import { createScopedRegistryView, isIssuedScopedRegistryView, scopedRegistryViewOwner } from "./scopedRegistry.js";

interface Entry {
  readonly id: string;
  readonly title?: string;
  readonly ownerInstanceId?: string;
}

interface Registry {
  register(entry: Entry): void;
  update(id: string, patch: Partial<Entry>): void;
  unregister(id: string): void;
  list(): readonly Entry[];
}

function registry(): { target: Registry; entries: Map<string, Entry> } {
  const entries = new Map<string, Entry>();
  return {
    entries,
    target: {
      register(entry) { entries.set(entry.id, entry); },
      update(id, patch) {
        const current = entries.get(id);
        if (current) entries.set(id, { ...current, ...patch });
      },
      unregister(id) { entries.delete(id); },
      list() { return [...entries.values()]; },
    },
  };
}

const rules = [{
  method: "register",
  idArgument: 0,
  unregisterMethod: "unregister",
  ownerInstanceIdProperty: "ownerInstanceId",
}] as const;

interface DeferredRegistry {
  /** 门面目标；底层注册可延迟写入。 */
  target: Registry;
  /** 已写入的条目。 */
  entries: Map<string, Entry>;
  /** 手动触发某个延迟注册的真正写入。 */
  late: Map<string, () => void>;
  /** 之后的注册立即写入（模拟“新实例接管”）。 */
  flushMode(): void;
}

/** 生成一个注册延迟写入的注册表目标：模拟 adapter 内部 await 后才真正登记。 */
function deferredRegistry(): DeferredRegistry {
  const entries = new Map<string, Entry>();
  const late = new Map<string, () => void>();
  let deferred = true;
  const target: Registry = {
    register(entry: Entry) {
      if (!deferred) { entries.set(entry.id, entry); return undefined; }
      return new Promise<void>((resolve) => {
        late.set(entry.id, () => { entries.set(entry.id, entry); resolve(); });
      }) as unknown as void;
    },
    update(id: string, patch: Partial<Entry>) {
      const current = entries.get(id);
      if (current) entries.set(id, { ...current, ...patch });
    },
    unregister(id: string) { entries.delete(id); },
    list() { return [...entries.values()]; },
  };
  return { target, entries, late, flushMode() { deferred = false; } };
}

function pluginScope(pluginId: string) {
  const parent = createLifecycleScope({ kind: "root", metadata: { attributes: {} } });
  return parent.child("runtime-unit", { pluginId, attributes: {} });
}

describe("PSM 通用注册门面", () => {
  it("按 Scope 身份写入 owner，调用方不需要自填", () => {
    const { target, entries } = registry();
    const scope = pluginScope("storage-plugin");
    const view = createScopedRegistryView(target, scope, { name: "web-ui", registrations: rules }).view;
    view.register({ id: "/contacts", title: "联系人" });
    // 归属是框架签发的实例身份，而不是调用方字符串。
    expect(entries.get("/contacts")?.ownerInstanceId).toBe(scope.identity.instanceId);
    expect(entries.get("/contacts")?.ownerInstanceId).toBeTruthy();
  });

  it("传入他人实例归属被拒绝，且不写入注册表", () => {
    const { target, entries } = registry();
    const view = createScopedRegistryView(target, pluginScope("storage-plugin"), { name: "web-ui", registrations: rules }).view;
    expect(() => view.register({ id: "/stolen", ownerInstanceId: "instance:someone-else" })).toThrow(/does not match plugin instance/);
    expect(entries.has("/stolen")).toBe(false);
  });

  it("只能注销本实例登记过的条目", () => {
    const { target, entries } = registry();
    const first = createScopedRegistryView(target, pluginScope("plugin-a"), { name: "web-ui", registrations: rules });
    const second = createScopedRegistryView(target, pluginScope("plugin-b"), { name: "web-ui", registrations: rules });
    first.view.register({ id: "/a" });
    second.view.register({ id: "/b" });
    expect(() => second.view.unregister("/a")).toThrow(/is not owned by this plugin instance/);
    expect(entries.has("/a")).toBe(true);
    second.view.unregister("/b");
    expect(entries.has("/b")).toBe(false);
  });

  it("实例撤销后条目同步撤下，迟到的注册不会复活旧实例", async () => {
    const { target, entries } = registry();
    const scope = pluginScope("storage-plugin");
    const view = createScopedRegistryView(target, scope, { name: "web-ui", registrations: rules }).view;
    view.register({ id: "/a" });
    expect(entries.has("/a")).toBe(true);
    scope.revoke("domain condition");
    // revoke 同步注销：UI 不再挂着旧条目。
    expect(entries.has("/a")).toBe(false);
    // 撤销后的新注册被拒绝，而不是复活旧实例的条目。
    expect(() => view.register({ id: "/late" })).toThrow();
    expect(entries.has("/late")).toBe(false);
    await scope.dispose({ reason: "test" });
  });

  it("撤销实例不会误删另一个实例的同名条目", async () => {
    const { target, entries } = registry();
    const firstScope = pluginScope("plugin-a");
    const secondScope = pluginScope("plugin-b");
    const first = createScopedRegistryView(target, firstScope, { name: "web-ui", registrations: rules }).view;
    first.register({ id: "/shared" });
    // plugin-b 接管同名条目：归属改写为它自己的实例身份。
    createScopedRegistryView(target, secondScope, { name: "web-ui", registrations: rules }).view.register({ id: "/shared" });
    expect(entries.get("/shared")?.ownerInstanceId).toBe(secondScope.identity.instanceId);
    firstScope.revoke("domain condition");
    expect(entries.has("/shared")).toBe(true);
    await firstScope.dispose({ reason: "test" });
    secondScope.revoke("test");
    await secondScope.dispose({ reason: "test" });
  });

  it("签发信息可核对，伪造对象不是框架签发的门面", () => {
    const { target } = registry();
    const view = createScopedRegistryView(target, pluginScope("storage-plugin"), { name: "web-ui", registrations: rules }).view;
    expect(isIssuedScopedRegistryView(view)).toBe(true);
    expect(isIssuedScopedRegistryView({ register() {}, update() {}, unregister() {}, list: () => [] })).toBe(false);
    expect(scopedRegistryViewOwner(view)?.ownerInstanceId).toBeTruthy();
    expect(scopedRegistryViewOwner({})).toBeUndefined();
  });

  it("非插件实例 scope 不能作为归属来源", () => {
    const { target } = registry();
    const root = createLifecycleScope({ kind: "root", metadata: { attributes: {} } });
    // root scope 没有插件身份，不能签发注册门面。
    expect(() => createScopedRegistryView(target, root, { name: "web-ui", registrations: rules })).toThrow(/plugin instance scope/);
  });
  it("更新只能作用于本实例条目，且不能改写归属字段", async () => {
    const { target, entries } = registry();
    const rulesWithUpdate = [
      { method: "register", idArgument: 0, unregisterMethod: "unregister", ownerInstanceIdProperty: "ownerInstanceId" },
      { method: "update", updateIdArgument: 0, unregisterMethod: "unregister", ownerInstanceIdProperty: "ownerInstanceId", immutableProperties: ["ownerInstanceId"] },
    ] as const;
    const first = createScopedRegistryView(target, pluginScope("plugin-a"), { name: "web-ui", registrations: rulesWithUpdate }).view;
    const second = createScopedRegistryView(target, pluginScope("plugin-b"), { name: "web-ui", registrations: rulesWithUpdate }).view;
    first.register({ id: "/a", title: "A" });
    second.register({ id: "/b", title: "B" });
    // 自己的条目可以更新展示字段。
    first.update("/a", { title: "A2" });
    expect(entries.get("/a")?.title).toBe("A2");
    // 别人的条目拒绝更新。
    expect(() => second.update("/a", { title: "hijack" })).toThrow(/is not owned by this plugin instance/);
    expect(entries.get("/a")?.title).toBe("A2");
    // 归属字段不能通过补丁改写：伪造他人实例直接拒绝。
    expect(() => first.update("/a", { ownerInstanceId: "instance:forged" } as never)).toThrow(/does not match plugin instance/);
    // 就算补丁里带上正确的实例身份，也会被剥离：归属只由框架写入。
    const ownInstance = entries.get("/a")?.ownerInstanceId;
    first.update("/a", { ownerInstanceId: ownInstance, title: "A3" } as never);
    expect(entries.get("/a")?.title).toBe("A3");
    expect(entries.get("/a")?.ownerInstanceId).toBe(ownInstance);
    // 撤销后不再能更新自己的旧条目。
    const scope = pluginScope("plugin-a");
    const late = createScopedRegistryView(target, scope, { name: "web-ui", registrations: rulesWithUpdate }).view;
    late.register({ id: "/late", title: "late" });
    scope.revoke("domain condition");
    expect(() => late.update("/late", { title: "after-revoke" })).toThrow();
    expect(entries.has("/late")).toBe(false);
    await scope.dispose({ reason: "test" });
  });

  it("异步注册在撤销之后完成时，条目不会残留", async () => {
    // 底层注册是异步的：写入发生在 late 回调，而不是调用返回时。
    const { target, entries, late } = deferredRegistry();
    const scope = pluginScope("slow-plugin");
    const view = createScopedRegistryView(target, scope, { name: "web-ui", registrations: rules }).view;
    void view.register({ id: "/slow" });
    // 撤销发生在底层注册完成之前。
    scope.revoke("domain condition");
    late.get("/slow")?.();
    await new Promise((resolve) => setTimeout(resolve, 5));
    // 迟到的注册完成后立即被回收，条目不残留。
    expect(entries.has("/slow")).toBe(false);
    await scope.dispose({ reason: "test" });
  });

  it("异步注册晚到不会删掉同名新实例的条目", async () => {
    const { target, entries, late, flushMode } = deferredRegistry();
    const oldScope = pluginScope("plugin-old");
    const oldView = createScopedRegistryView(target, oldScope, { name: "web-ui", registrations: rules }).view;
    void oldView.register({ id: "/shared" });
    oldScope.revoke("domain condition");
    // 新实例接管同名条目。
    const newScope = pluginScope("plugin-new");
    flushMode();
    const newView = createScopedRegistryView(target, newScope, { name: "web-ui", registrations: rules }).view;
    newView.register({ id: "/shared" });
    const newOwner = entries.get("/shared")?.ownerInstanceId;
    expect(newOwner).toBe(newScope.identity.instanceId);
    // 旧实例的异步注册这时才完成。
    late.get("/shared")?.();
    await new Promise((resolve) => setTimeout(resolve, 5));
    // 旧实例的回收不能删掉新实例的条目。
    expect(entries.has("/shared")).toBe(true);
    oldScope.revoke("test");
    await oldScope.dispose({ reason: "test" });
    newScope.revoke("test");
    await newScope.dispose({ reason: "test" });
  });
  it("同名条目被新实例接管后，旧门面的更新与注销都被拒绝", async () => {
    const { target, entries } = registry();
    const rulesWithUpdate = [
      { method: "register", idArgument: 0, unregisterMethod: "unregister", ownerInstanceIdProperty: "ownerInstanceId" },
      { method: "update", updateIdArgument: 0, unregisterMethod: "unregister", ownerInstanceIdProperty: "ownerInstanceId", immutableProperties: ["ownerInstanceId"] },
    ] as const;
    const oldScope = pluginScope("plugin-old");
    const newScope = pluginScope("plugin-new");
    const oldView = createScopedRegistryView(target, oldScope, { name: "web-ui", registrations: rulesWithUpdate }).view;
    const newView = createScopedRegistryView(target, newScope, { name: "web-ui", registrations: rulesWithUpdate }).view;
    oldView.register({ id: "/shared", title: "old" });
    // 新实例接管同名条目（更晚的世代）。
    newView.register({ id: "/shared", title: "new" });
    const newOwner = entries.get("/shared")?.ownerInstanceId;
    expect(newOwner).toBe(newScope.identity.instanceId);

    // 旧门面的历史登记记录不再有效：既不能改写，也不能删除。
    expect(() => oldView.update("/shared", { title: "hijack" })).toThrow(/re-registered by another plugin instance/);
    expect(() => oldView.unregister("/shared")).toThrow(/re-registered by another plugin instance/);
    expect(entries.get("/shared")?.title).toBe("new");
    expect(entries.get("/shared")?.ownerInstanceId).toBe(newOwner);

    // 新实例自己的操作仍然可用。
    newView.update("/shared", { title: "new2" });
    expect(entries.get("/shared")?.title).toBe("new2");
    newView.unregister("/shared");
    expect(entries.has("/shared")).toBe(false);

    // 旧实例撤销时的清理也不会误删新实例的条目。
    oldView.register({ id: "/other" });
    newView.register({ id: "/other" });
    oldScope.revoke("domain condition");
    expect(entries.has("/other")).toBe(true);
    expect(entries.get("/other")?.ownerInstanceId).toBe(newScope.identity.instanceId);
    oldScope.revoke("test");
    await oldScope.dispose({ reason: "test" });
    newScope.revoke("test");
    await newScope.dispose({ reason: "test" });
  });

  it("条件提交在撤销之后不会写入：旧异步登记不会覆盖新实例条目", async () => {
    const { target, entries } = registry();
    const oldScope = pluginScope("plugin-old");
    const newScope = pluginScope("plugin-new");
    const oldView = createScopedRegistryView(target, oldScope, { name: "web-ui", registrations: rules });
    const newView = createScopedRegistryView(target, newScope, { name: "web-ui", registrations: rules });

    // 旧实例先“发起”异步登记（只创建提交句柄，尚未提交）。
    const staged = oldView.stage({ id: "/contacts", title: "old" });
    // 新实例随后登记同名条目，并带上自己的组件闭包内容。
    newView.view.register({ id: "/contacts", title: "new" });
    const newOwner = entries.get("/contacts")?.ownerInstanceId;
    // 旧实例此时被撤销。
    oldScope.revoke("domain condition");

    // 旧提交被围栏拒绝：底层不会写入，也不会覆盖新实例的 owner 与内容。
    expect(await staged.commit()).toBe(false);
    expect(entries.get("/contacts")?.title).toBe("new");
    expect(entries.get("/contacts")?.ownerInstanceId).toBe(newOwner);
    expect(entries.get("/contacts")?.ownerInstanceId).toBe(newScope.identity.instanceId);

    // 撤销后再提交同样被拒。
    const late = newView.stage({ id: "/late", title: "late" });
    newScope.revoke("domain condition");
    expect(await late.commit()).toBe(false);
    expect(entries.has("/late")).toBe(false);
    oldScope.revoke("test");
    await oldScope.dispose({ reason: "test" });
    newScope.revoke("test");
    await newScope.dispose({ reason: "test" });
  });

  it("条件提交成功时写入并被撤销清理", async () => {
    const { target, entries } = registry();
    const scope = pluginScope("plugin-commit");
    const view = createScopedRegistryView(target, scope, { name: "web-ui", registrations: rules });
    expect(await view.stage({ id: "/ok", title: "ok" }).commit()).toBe(true);
    expect(entries.get("/ok")?.ownerInstanceId).toBe(scope.identity.instanceId);
    expect(entries.get("/ok")?.title).toBe("ok");
    scope.revoke("domain condition");
    expect(entries.has("/ok")).toBe(false);
    await scope.dispose({ reason: "test" });
  });
});
