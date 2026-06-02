import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import {
  GitsBuildInfo,
  GitsCapacitySnapshot,
  GitsSkillInventorySnapshot,
  HermesExecutionDraft,
  HermesProposalCard,
  HermesScheduleRunResult,
  HermesStatusResult,
} from "./gits.ts";

const decodeGitsBuildInfo = Schema.decodeUnknownSync(GitsBuildInfo);
const decodeGitsSkillInventorySnapshot = Schema.decodeUnknownSync(GitsSkillInventorySnapshot);
const decodeGitsCapacitySnapshot = Schema.decodeUnknownSync(GitsCapacitySnapshot);
const decodeHermesStatus = Schema.decodeUnknownSync(HermesStatusResult);
const decodeHermesProposal = Schema.decodeUnknownSync(HermesProposalCard);
const decodeHermesDraft = Schema.decodeUnknownSync(HermesExecutionDraft);
const decodeHermesScheduleRun = Schema.decodeUnknownSync(HermesScheduleRunResult);

describe("GitsBuildInfo", () => {
  it("accepts nullable build provenance fields", () => {
    const parsed = decodeGitsBuildInfo({
      branch: "feat/gits-tailnet-hosting-refresh",
      commit: "abcdef1234567890",
      time: "2026-06-02T10:00:00.000Z",
      dirty: false,
      sourcePath: "/srv/t3code/current",
    });

    expect(parsed.branch).toBe("feat/gits-tailnet-hosting-refresh");
    expect(parsed.commit).toBe("abcdef1234567890");
    expect(parsed.time).toBe("2026-06-02T10:00:00.000Z");
    expect(parsed.dirty).toBe(false);
    expect(parsed.sourcePath).toBe("/srv/t3code/current");
  });
});

describe("GitsSkillInventorySnapshot", () => {
  it("accepts local provider skill inventory fields", () => {
    const parsed = decodeGitsSkillInventorySnapshot({
      scannedAt: "2026-06-02T10:00:00.000Z",
      skills: [
        {
          id: "codex:skill:/home/test/.codex/skills/review/SKILL.md",
          provider: "codex",
          kind: "skill",
          name: "review",
          title: "Review",
          description: "Review changed source files.",
          path: "/home/test/.codex/skills/review/SKILL.md",
          sourceRoot: "/home/test/.codex/skills",
          rating: null,
          review: null,
          usageCount: 0,
          lastUsedAt: null,
          lastModifiedAt: "2026-06-02T09:00:00.000Z",
          portability: "native",
          tags: ["codex"],
        },
      ],
      providers: [
        {
          provider: "codex",
          totalCount: 1,
          nativeCount: 1,
          missingPortCount: 0,
          ratedCount: 0,
          reviewedCount: 0,
        },
      ],
      totals: {
        skillCount: 1,
        providerCount: 1,
        ratedCount: 0,
        reviewedCount: 0,
        missingPortCount: 0,
        hermesCandidateCount: 0,
      },
      warnings: [],
      insights: [],
    });

    expect(parsed.skills[0]?.provider).toBe("codex");
    expect(parsed.totals.skillCount).toBe(1);
  });
});

describe("GitsCapacitySnapshot", () => {
  it("accepts Codex and Cursor usage telemetry", () => {
    const parsed = decodeGitsCapacitySnapshot({
      checkedAt: "2026-06-02T10:00:00.000Z",
      codex: {
        provider: "codex",
        displayName: "Codex",
        status: "available",
        source: "codex-session-jsonl",
        accountLabel: null,
        planLabel: "pro",
        windows: [
          {
            label: "5h",
            usedPercent: 80,
            remainingPercent: 20,
            windowMinutes: 300,
            resetAt: null,
            level: "yellow",
            source: "codex-session-jsonl",
            note: null,
          },
        ],
        monthlyBudgetUsd: null,
        monthlySpendUsd: null,
        monthlyUtilizationPercent: null,
        monthlyRemainingUsd: null,
        monthlyResetAt: null,
        note: null,
        updatedAt: "2026-06-02T10:00:00.000Z",
      },
      cursor: {
        provider: "cursor",
        displayName: "Cursor",
        status: "available",
        source: "manual-config",
        accountLabel: null,
        planLabel: null,
        windows: [],
        monthlyBudgetUsd: 500,
        monthlySpendUsd: 50,
        monthlyUtilizationPercent: 10,
        monthlyRemainingUsd: 450,
        monthlyResetAt: null,
        note: null,
        updatedAt: "2026-06-02T10:00:00.000Z",
      },
      recommendation: {
        recommendedEngine: "cursor",
        confidence: "medium",
        reason: "Cursor has configured budget headroom.",
        codexRemainingPercent: 20,
        cursorRemainingPercent: 90,
      },
      notes: [],
    });

    expect(parsed.recommendation.recommendedEngine).toBe("cursor");
  });
});

describe("Hermes Motoko contracts", () => {
  const baseProposal = {
    id: "proposal-1",
    title: "Inspect project status",
    summary: "Review current project blockers.",
    detail: "Motoko proposes a read-only inspection.",
    evidence: ["GITS cockpit snapshot is available."],
    scope: ["Read-only analysis."],
    risk: "low",
    actionKind: "read-only",
    status: "proposed",
    requiresApproval: false,
    recommendedExecutor: "none",
    verificationPlan: ["Confirm no repo mutation occurred."],
    nextCommandOrPrompt: null,
    blockedReason: null,
    source: "hermes cockpit chat",
    projectDir: "/home/test/project",
    decisionReason: null,
    decidedAt: null,
    createdAt: "2026-06-02T10:00:00.000Z",
    updatedAt: "2026-06-02T10:00:00.000Z",
  } as const;

  it("accepts Motoko status with setup warnings and profile status", () => {
    const parsed = decodeHermesStatus({
      available: true,
      binaryPath: "hermes",
      version: "0.15.1",
      checkedAt: "2026-06-02T10:00:00.000Z",
      capabilities: ["status", "doctor", "acp", "proposals", "profile"],
      unsupported: [],
      config: {
        hermesHome: "/home/test/.gits/hermes",
        usingDefaultGitsHome: true,
        configPath: "/home/test/.gits/hermes/config.yaml",
        soulPath: "/home/test/.gits/hermes/SOUL.md",
        approvalMode: "manual",
        yoloModeDetected: false,
        codexCliAuthPath: "/home/test/.codex/auth.json",
      },
      codexAuth: {
        state: "detected",
        source: "codex-cli",
        hermesAuthExists: false,
        codexCliAuthExists: true,
        message: "Codex CLI OAuth credentials are present.",
      },
      soul: {
        exists: true,
        managedByGits: true,
        path: "/home/test/.gits/hermes/SOUL.md",
        summary: "Motoko identity is installed.",
        updatedAt: "2026-06-02T10:00:00.000Z",
      },
      acp: {
        available: true,
        check: {
          status: "ok",
          exitCode: 0,
          stdout: "ok",
          stderr: "",
          checkedAt: "2026-06-02T10:00:00.000Z",
        },
        version: "0.15.1",
      },
      doctor: {
        status: "warning",
        exitCode: 1,
        stdout: "",
        stderr: "config missing",
        checkedAt: "2026-06-02T10:00:00.000Z",
      },
      policy: {
        mode: "observe-propose-only",
        directMergeAllowed: false,
        directDestructiveShellAllowed: false,
        repoWritesRequireDelamain: true,
        humanApprovalRequiredForWriteActions: true,
        notes: ["Motoko proposes only."],
      },
      motokoProfile: {
        exists: true,
        managedByGits: true,
        distributionPath: "/repo/profiles/motoko-gits",
        soulPath: "/repo/profiles/motoko-gits/SOUL.md",
        configExamplePath: "/repo/profiles/motoko-gits/config.yaml.example",
        summary: "Motoko profile distribution is available.",
        updatedAt: "2026-06-02T10:00:00.000Z",
      },
      proposalCount: 1,
      setupWarnings: ["config missing"],
    });

    expect(parsed.policy.repoWritesRequireDelamain).toBe(true);
    expect(parsed.motokoProfile.managedByGits).toBe(true);
  });

  it("accepts expanded proposal cards, drafts, and scheduled proposal runs", () => {
    const proposal = decodeHermesProposal(baseProposal);
    const draft = decodeHermesDraft({
      id: "draft-1",
      proposalId: proposal.id,
      kind: "delamain-peer",
      status: "draft",
      title: "Implement scoped work",
      repo: "/home/test/project",
      sourceBranch: "main",
      targetBranch: "main",
      prompt: "Implement the approved proposal in an isolated worktree.",
      risk: "medium",
      fileOwnership: ["apps/server"],
      verificationCommands: ["bun typecheck"],
      blockedReason: null,
      createdAt: "2026-06-02T10:00:00.000Z",
    });
    const schedule = decodeHermesScheduleRun({
      kind: "daily-briefing",
      ranAt: "2026-06-02T10:00:00.000Z",
      proposals: [proposal],
      blockedReason: null,
    });

    expect(draft.kind).toBe("delamain-peer");
    expect(schedule.proposals).toHaveLength(1);
  });
});
