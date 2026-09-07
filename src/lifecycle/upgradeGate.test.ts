import { describe, expect, it } from "vitest";
import { UpgradeGateRejectedError } from "../contracts/lifecycle.js";
import { createUpgradeGate } from "./upgradeGate.js";

function createGate() {
  return createUpgradeGate({
    protocolVersion: "2",
    buildId: "build:new",
    authorityInstanceId: "authority:new",
    handoverGeneration: 4,
    supportedContractVersions: ["asset.v2", "asset.v1"],
    mode: "two-phase",
    compatibleBuildIds: new Set(["build:old"]),
  });
}

describe("upgrade handover gate", () => {
  it("requires explicit protocol, build, generation, and contract compatibility", () => {
    const gate = createGate();
    const base = {
      connectionId: "connection:peer-1",
      protocolVersion: "2",
      buildId: "build:new",
      authorityInstanceId: "authority:peer",
      handoverGeneration: 4,
      supportedContractVersions: ["asset.v2"],
    } as const;

    expect(gate.handshake({ ...base, protocolVersion: "1" })).toEqual({ accepted: false, reason: "protocol-mismatch" });
    expect(gate.handshake({ ...base, buildId: "build:unknown" })).toEqual({ accepted: false, reason: "build-incompatible" });
    expect(gate.handshake({ ...base, handoverGeneration: 3 })).toEqual({ accepted: false, reason: "stale-generation" });
    expect(gate.handshake({ ...base, handoverGeneration: 5 })).toEqual({ accepted: false, reason: "future-generation" });
    expect(gate.handshake({ ...base, supportedContractVersions: ["asset.v0"] })).toEqual({ accepted: false, reason: "contract-mismatch" });
    expect(gate.handshake({ ...base, buildId: "build:old" })).toMatchObject({
      accepted: true,
      mode: "two-phase",
      handoverGeneration: 4,
      contractVersion: "asset.v2",
      connectionId: "connection:peer-1",
    });
  });

  it("closes new admissions before draining existing I/O", async () => {
    const gate = createGate();
    const handshake = gate.handshake({
      connectionId: "connection:peer-1",
      protocolVersion: "2",
      buildId: "build:new",
      authorityInstanceId: "authority:peer",
      handoverGeneration: 4,
      supportedContractVersions: ["asset.v2"],
    });
    if (!handshake.accepted) throw new Error("test handshake was rejected");
    expect(handshake.session.connectionId).toBe("connection:peer-1");
    const lease = handshake.session.admit({ operation: "write" });
    expect(lease.connectionId).toBe("connection:peer-1");
    expect(gate.activeIo()).toBe(1);
    gate.beginDrain("new worker is taking over");
    expect(gate.state).toBe("draining");
    expect(() => handshake.session.admit({ operation: "read" })).toThrow(UpgradeGateRejectedError);
    lease.assertActive();
    await expect(gate.drain(0)).resolves.toMatchObject({ state: "draining", drained: false, pending: 1 });

    lease.release();
    await expect(gate.drain()).resolves.toMatchObject({ state: "draining", drained: true, pending: 0 });
    expect(gate.activeIo()).toBe(0);
  });

  it("revokes admitted I/O when the gate is closed", () => {
    const gate = createGate();
    const handshake = gate.handshake({
      connectionId: "connection:peer-2",
      protocolVersion: "2",
      buildId: "build:new",
      authorityInstanceId: "authority:peer",
      handoverGeneration: 4,
      supportedContractVersions: ["asset.v1"],
    });
    if (!handshake.accepted) throw new Error("test handshake was rejected");
    const lease = handshake.session.admit({ operation: "write" });
    gate.close("old worker fenced");

    expect(gate.state).toBe("closed");
    expect(lease.revoked).toBe(true);
    expect(lease.signal.aborted).toBe(true);
    expect(() => lease.assertActive()).toThrow(UpgradeGateRejectedError);
    expect(() => gate.assertAccepting()).toThrow(UpgradeGateRejectedError);
  });
});
