import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";
import {
  AutomodeEpisode,
  AutomodeEpisodesListInput,
  AutomodePolicy,
  AutomodePolicyUpdateInput,
} from "./gits.ts";

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
    expect(decoded.autoEnqueueApprovedProposals).toBe(false);
    expect(decoded.nightlyProposalSweep).toBe(false);
    expect(decoded.proposalRepos).toEqual([]);
    expect(decoded.telegramDigestEnabled).toBe(true);
    expect(decoded.gitsNotificationsEnabled).toBe(true);
    expect(decoded.telegramNotificationsEnabled).toBe(false);
    expect(decoded.sweepRequiresConfirmation).toBe(true);
  });

  it("accepts the new fields on the update input", () => {
    const decoded = Schema.decodeUnknownSync(AutomodePolicyUpdateInput)({
      mode: "autonomous",
      verificationCommands: [{ label: "test", cmd: ["bun", "run", "test"] }],
      integrationBranch: "auto/x",
      autoEnqueueApprovedProposals: true,
      gitsNotificationsEnabled: false,
      telegramNotificationsEnabled: true,
    });
    expect(decoded.integrationBranch).toBe("auto/x");
    expect(decoded.autoEnqueueApprovedProposals).toBe(true);
    expect(decoded.gitsNotificationsEnabled).toBe(false);
    expect(decoded.telegramNotificationsEnabled).toBe(true);
  });

  it("decodes an explicit telegramDigestEnabled and accepts it on the update input", () => {
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
      telegramDigestEnabled: false,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(decoded.telegramDigestEnabled).toBe(false);

    const updateDecoded = Schema.decodeUnknownSync(AutomodePolicyUpdateInput)({
      telegramDigestEnabled: false,
      sweepRequiresConfirmation: false,
    });
    expect(updateDecoded.telegramDigestEnabled).toBe(false);
    expect(updateDecoded.sweepRequiresConfirmation).toBe(false);
  });
});

describe("Automode episode ledger contract", () => {
  const baseEpisode = {
    id: "epi-1",
    episodeId: "epi-thread-1",
    repo: "/tmp/repo",
    goalId: "goal-1",
    goalTitle: "Ship the thing",
    sliceBranch: "auto/slice-1",
    verdict: "pass" as const,
    confidence: "high" as const,
    recommendation: "auto-merge" as const,
    flagged: false,
    summary: "All good.",
    review: {
      sliceId: "slice-1",
      recommendation: "auto-merge" as const,
      mechanicalPassed: true,
      mechanical: {
        worktree: "/tmp/repo",
        confined: true,
        passed: true,
        results: [],
        checkedAt: "2026-01-01T00:00:00.000Z",
      },
      semantic: null,
      criteriaSource: "authored" as const,
      summary: "All good.",
      checkedAt: "2026-01-01T00:00:00.000Z",
    },
    createdAt: "2026-01-01T00:00:00.000Z",
  };

  it("decodes an AutomodeEpisode row", () => {
    const decoded = Schema.decodeUnknownSync(AutomodeEpisode)(baseEpisode);
    expect(decoded.id).toBe("epi-1");
    expect(decoded.review.recommendation).toBe("auto-merge");
  });

  it("decodes AutomodeEpisodesListInput with both fields optional", () => {
    expect(Schema.decodeUnknownSync(AutomodeEpisodesListInput)({})).toEqual({});
    expect(
      Schema.decodeUnknownSync(AutomodeEpisodesListInput)({ limit: 10, repo: "/tmp/repo" }),
    ).toEqual({ limit: 10, repo: "/tmp/repo" });
  });

  it("rejects a non-positive limit", () => {
    expect(() => Schema.decodeUnknownSync(AutomodeEpisodesListInput)({ limit: 0 })).toThrow();
  });
});
