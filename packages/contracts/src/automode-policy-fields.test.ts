import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";
import { AutomodePolicy, AutomodePolicyUpdateInput } from "./gits.ts";

describe("AutomodePolicy held-PR fields", () => {
  it("decodes verificationCommands + integrationBranch", () => {
    const decoded = Schema.decodeUnknownSync(AutomodePolicy)({
      mode: "autonomous",
      killSwitchEnabled: false,
      maxActivePeers: 1,
      allowedRepos: ["/tmp/repo"],
      allowedModels: [],
      defaultModel: null,
      maxBudgetUsd: null,
      maxRuntimeMinutes: null,
      requireApprovalForPeerSpawn: false,
      requireApprovalBeforeIntegrate: true,
      requireApprovalBeforeDestructiveAction: true,
      verificationCommands: [{ label: "typecheck", cmd: ["bun", "typecheck"] }],
      integrationBranch: "auto/gits-self-hosting",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(decoded.verificationCommands[0]?.label).toBe("typecheck");
    expect(decoded.integrationBranch).toBe("auto/gits-self-hosting");
  });

  it("defaults the new fields when absent (back-compat with old persisted policy)", () => {
    const decoded = Schema.decodeUnknownSync(AutomodePolicy)({
      mode: "manual",
      killSwitchEnabled: true,
      maxActivePeers: 1,
      allowedRepos: [],
      allowedModels: [],
      defaultModel: null,
      maxBudgetUsd: null,
      maxRuntimeMinutes: 60,
      requireApprovalForPeerSpawn: true,
      requireApprovalBeforeIntegrate: true,
      requireApprovalBeforeDestructiveAction: true,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(decoded.verificationCommands).toEqual([]);
    expect(decoded.integrationBranch).toBeNull();
  });

  it("accepts the new fields on the update input", () => {
    const decoded = Schema.decodeUnknownSync(AutomodePolicyUpdateInput)({
      mode: "autonomous",
      verificationCommands: [{ label: "test", cmd: ["bun", "run", "test"] }],
      integrationBranch: "auto/x",
    });
    expect(decoded.integrationBranch).toBe("auto/x");
  });
});
