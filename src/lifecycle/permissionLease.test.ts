import { describe, expect, it } from "vitest";
import {
  PermissionDeniedError,
  PermissionLeaseRevokedError,
} from "../contracts/lifecycle.js";
import { createLifecycleScope } from "./resourceScope.js";
import { createPermissionLease } from "./permissionLease.js";

const identity = {
  scopeId: "scope:plugin",
  instanceId: "instance:plugin",
  kind: "plugin-instance" as const,
  pluginId: "plugin-a",
  attributes: {
    tenant: "alpha",
    session: "session:1",
    generation: 3,
  },
};

describe("permission lease", () => {
  it("grants only requested ∩ approved permissions", () => {
    const lease = createPermissionLease({
      identity,
      requested: ["storage.read", "storage.write", "vault.manage"],
      approved: ["storage.read", "vault.manage"],
    });
    expect(lease.has("storage.read")).toBe(true);
    expect(lease.has("storage.write")).toBe(false);
    expect(() => lease.assert("storage.write")).toThrow(PermissionDeniedError);
    expect(() => lease.assertBinding({ pluginId: "plugin-b" })).toThrow(PermissionLeaseRevokedError);
  });

  it("applies the current session constraint as a third intersection", () => {
    const lease = createPermissionLease({
      identity,
      requested: ["storage.read", "storage.write"],
      approved: ["storage.read", "storage.write"],
      sessionConstraints: ["storage.read"],
    });
    expect(lease.binding.sessionConstraints).toEqual(["storage.read"]);
    expect(lease.has("storage.read")).toBe(true);
    expect(lease.has("storage.write")).toBe(false);
    expect(() => lease.assert("storage.write")).toThrow(PermissionDeniedError);
  });

  it("revokes with the scope and does not accept a replacement owner", () => {
    const scope = createLifecycleScope({ kind: "plugin-instance", metadata: identity });
    const lease = createPermissionLease({
      identity: { ...identity, scopeId: scope.identity.scopeId },
      scope,
      requested: ["storage.read"],
      approved: ["storage.read"],
    });
    lease.assert("storage.read");
    scope.revoke("key switched");
    expect(lease.revoked).toBe(true);
    expect(lease.has("storage.read")).toBe(false);
    expect(() => lease.assert("storage.read")).toThrow(PermissionLeaseRevokedError);
    expect(() => lease.assertBinding({ attributes: { tenant: "other" } })).toThrow(PermissionLeaseRevokedError);
  });

  it("captures policy and user-grant revisions and rejects stale bindings", () => {
    const lease = createPermissionLease({
      identity,
      requested: ["identity.read"],
      approved: ["identity.read"],
      policyRevision: 4,
      grantRevision: 9,
    });

    expect(lease.binding).toMatchObject({ policyRevision: 4, grantRevision: 9 });
    lease.assertBinding({ policyRevision: 4, grantRevision: 9 });
    expect(() => lease.assertBinding({ policyRevision: 3 })).toThrow(PermissionLeaseRevokedError);
    expect(() => lease.assertBinding({ grantRevision: 8 })).toThrow(PermissionLeaseRevokedError);
  });
});
