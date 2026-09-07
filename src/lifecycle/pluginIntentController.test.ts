import { describe, expect, it } from "vitest";
import { createPluginIntentController } from "./pluginIntentController.js";

describe("plugin intent controller", () => {
  it("persists absolute intent and deduplicates the same command", async () => {
    const persisted: number[] = [];
    const controller = createPluginIntentController({
      authorityInstanceId: "authority:1",
      persist: async (snapshot) => { persisted.push(snapshot.revision); },
    });
    const command = {
      commandId: "command:1",
      authorityInstanceId: "authority:1",
      expectedRevision: 0,
      pluginId: "asset",
      desiredEnabled: true,
    } as const;

    await expect(controller.submit(command)).resolves.toMatchObject({ status: "accepted", persisted: true });
    await expect(controller.submit(command)).resolves.toMatchObject({ status: "duplicate", persisted: true });
    expect(persisted).toEqual([1]);
    expect(controller.snapshot()).toMatchObject({ revision: 1, desiredEnabled: { asset: true }, desiredRevision: { asset: 1 } });
  });

  it("checks command content before revision and rejects stale authority", async () => {
    const controller = createPluginIntentController({ authorityInstanceId: "authority:1" });
    await controller.submit({ commandId: "command:1", authorityInstanceId: "authority:1", expectedRevision: 0, pluginId: "asset", desiredEnabled: true });

    await expect(controller.submit({ commandId: "command:1", authorityInstanceId: "authority:1", expectedRevision: 1, pluginId: "asset", desiredEnabled: false })).resolves.toMatchObject({ status: "command-conflict" });
    await expect(controller.submit({ commandId: "command:2", authorityInstanceId: "authority:1", expectedRevision: 0, pluginId: "other", desiredEnabled: true })).resolves.toMatchObject({ status: "revision-conflict", snapshot: { revision: 1 } });
    await expect(controller.submit({ commandId: "command:3", authorityInstanceId: "authority:old", expectedRevision: 1, pluginId: "asset", desiredEnabled: false })).resolves.toMatchObject({ status: "stale-authority", expectedAuthorityInstanceId: "authority:1" });
  });

  it("does not publish a failed persistence attempt as accepted", async () => {
    let fail = true;
    const controller = createPluginIntentController({
      authorityInstanceId: "authority:1",
      persist: async () => { if (fail) throw new Error("storage unavailable"); },
    });
    const command = { commandId: "command:1", authorityInstanceId: "authority:1", expectedRevision: 0, pluginId: "asset", desiredEnabled: true } as const;
    await expect(controller.submit(command)).resolves.toMatchObject({ status: "persistence-failed", snapshot: { revision: 0 } });
    fail = false;
    await expect(controller.submit(command)).resolves.toMatchObject({ status: "accepted", snapshot: { revision: 1 } });
  });

  it("rejects malformed command fields before touching the revision", async () => {
    const controller = createPluginIntentController({ authorityInstanceId: "authority:1" });
    await expect(controller.submit({
      commandId: "command:bad",
      authorityInstanceId: "authority:1",
      expectedRevision: 0,
      pluginId: "asset",
      desiredEnabled: "yes" as unknown as boolean,
    })).resolves.toMatchObject({ status: "command-conflict", commandId: "command:bad" });
    expect(controller.snapshot().revision).toBe(0);
  });
});
