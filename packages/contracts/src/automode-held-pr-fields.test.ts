import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";
import { AutomodeSnapshot, AutomodeRecordHeldPrInput } from "./gits.ts";

const baseSnapshot = {
  policy: {
    mode: "autonomous",
    killSwitchEnabled: false,
    maxActivePeers: 1,
    allowedRepos: [],
    allowedModels: [],
    defaultModel: null,
    maxBudgetUsd: null,
    maxRuntimeMinutes: null,
    requireApprovalForPeerSpawn: false,
    requireApprovalBeforeIntegrate: true,
    requireApprovalBeforeDestructiveAction: true,
    verificationCommands: [],
    integrationBranch: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  budgetUsage: {
    source: "unavailable",
    totalCostUsd: null,
    totalProcessedTokens: null,
    updatedAt: null,
    note: null,
  },
  goals: [],
  activePeerCount: 0,
  pendingApprovalCount: 0,
  driverHalted: false,
  driverHaltedReason: null,
  lastEvent: null,
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("AutomodeSnapshot held-PR fields", () => {
  it("decodes heldPrUrl/heldPrNumber/runMerged", () => {
    const decoded = Schema.decodeUnknownSync(AutomodeSnapshot)({
      ...baseSnapshot,
      heldPrUrl: "https://github.com/Ecko95/gitscode/pull/30",
      heldPrNumber: 30,
      runMerged: true,
    });
    expect(decoded.heldPrUrl).toContain("/pull/30");
    expect(decoded.heldPrNumber).toBe(30);
    expect(decoded.runMerged).toBe(true);
  });

  it("defaults the new fields for back-compat (absent)", () => {
    const decoded = Schema.decodeUnknownSync(AutomodeSnapshot)(baseSnapshot);
    expect(decoded.heldPrUrl).toBeNull();
    expect(decoded.heldPrNumber).toBeNull();
    expect(decoded.runMerged).toBe(false);
  });

  it("validates the record-held-pr input", () => {
    const decoded = Schema.decodeUnknownSync(AutomodeRecordHeldPrInput)({
      url: "https://github.com/Ecko95/gitscode/pull/30",
      number: 30,
    });
    expect(decoded.number).toBe(30);
  });
});
