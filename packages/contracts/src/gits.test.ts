import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import {
  AutomodeGoal,
  DelamainWorkflowRunInput,
  DelamainWorkflowRunResult,
  GitsBuildInfo,
  GitsCapacitySnapshot,
  GitsMcpInventorySnapshot,
  GitsNote,
  GitsNoteSummary,
  GitsNoteWriteInput,
  GitsNotesError,
  GitsSkillInventorySnapshot,
  HermesChatResult,
  HermesCodexAuthStatus,
  HermesExecutionDraft,
  HermesProposalCard,
  HermesScheduleRunResult,
  HermesStatusResult,
} from "./gits.ts";

const decodeGitsBuildInfo = Schema.decodeUnknownSync(GitsBuildInfo);
const decodeGitsNoteSummary = Schema.decodeUnknownSync(GitsNoteSummary);
const decodeGitsNote = Schema.decodeUnknownSync(GitsNote);
const decodeGitsNoteWriteInput = Schema.decodeUnknownSync(GitsNoteWriteInput);
const decodeGitsNotesError = Schema.decodeUnknownSync(GitsNotesError);
const decodeAutomodeGoal = Schema.decodeUnknownSync(AutomodeGoal);
const decodeGitsSkillInventorySnapshot = Schema.decodeUnknownSync(GitsSkillInventorySnapshot);
const decodeGitsMcpInventorySnapshot = Schema.decodeUnknownSync(GitsMcpInventorySnapshot);
const decodeGitsCapacitySnapshot = Schema.decodeUnknownSync(GitsCapacitySnapshot);
const decodeHermesStatus = Schema.decodeUnknownSync(HermesStatusResult);
const decodeHermesCodexAuthStatus = Schema.decodeUnknownSync(HermesCodexAuthStatus);
const decodeHermesChatResult = Schema.decodeUnknownSync(HermesChatResult);
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

describe("Gits notes contracts", () => {
  const summary = {
    id: "VPS localhost callback redirect for windows powershell.md",
    title: "VPS localhost callback redirect for windows powershell",
    updatedAt: "2026-07-14T10:00:00.000Z",
    notionPageId: null,
  };

  it("decodes a note summary, full note, write payload, and typed error", () => {
    expect(decodeGitsNoteSummary(summary)).toEqual(summary);
    expect(
      decodeGitsNote({ ...summary, content: "ssh -N -L 1455:127.0.0.1:1455 user@your-vps" }),
    ).toMatchObject({ id: summary.id, content: expect.stringContaining("ssh -N") });
    expect(
      decodeGitsNoteWriteInput({
        id: summary.id,
        title: summary.title,
        content: "# Callback redirect\n",
      }),
    ).toMatchObject({ id: summary.id, title: summary.title });
    expect(
      decodeGitsNotesError({ _tag: "GitsNotesError", message: "Vault unavailable" }),
    ).toMatchObject({ _tag: "GitsNotesError", message: "Vault unavailable" });
  });

  it.each(["", "notes.txt", "../notes.md", "\0.md"])("rejects invalid note id %j", (id) => {
    expect(() => decodeGitsNoteSummary({ ...summary, id })).toThrow();
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

describe("GitsMcpInventorySnapshot", () => {
  it("accepts local MCP server inventory fields", () => {
    const parsed = decodeGitsMcpInventorySnapshot({
      scannedAt: "2026-06-02T10:00:00.000Z",
      servers: [
        {
          id: "codex:context7",
          provider: "codex",
          providerInstanceId: "codex",
          name: "context7",
          source: "config-file",
          runtimeSource: "codex-app-server",
          status: "unknown",
          runtimeStatus: "running",
          authStatus: "unknown",
          canAuthenticate: false,
          enabled: true,
          command: "npx -y @upstash/context7-mcp",
          transport: "stdio",
          toolCount: 0,
          resourceCount: 0,
          tools: [],
          configPath: "/home/test/.codex/config.toml",
          error: null,
        },
        {
          id: "claude:linear",
          provider: "claude",
          name: "linear",
          source: "config-file",
          status: "disabled",
          authStatus: "unknown",
          enabled: false,
          command: null,
          transport: "sse",
          toolCount: 3,
          resourceCount: 0,
          tools: ["create_issue", "list_issues", "search"],
          configPath: "/home/test/.claude.json",
          error: null,
        },
      ],
      providers: [
        {
          provider: "codex",
          serverCount: 1,
          runningCount: 0,
          disabledCount: 0,
          toolCount: 0,
        },
        {
          provider: "claude",
          serverCount: 1,
          runningCount: 0,
          disabledCount: 1,
          toolCount: 3,
        },
      ],
      totals: {
        serverCount: 2,
        runningCount: 0,
        errorCount: 0,
        disabledCount: 1,
        toolCount: 3,
      },
      warnings: ["Missing cursor MCP config: /home/test/.cursor/mcp.json"],
    });

    expect(parsed.servers[0]?.provider).toBe("codex");
    expect(parsed.servers[0]?.providerInstanceId).toBe("codex");
    expect(parsed.servers[0]?.runtimeSource).toBe("codex-app-server");
    expect(parsed.servers[0]?.canAuthenticate).toBe(false);
    expect(parsed.servers[1]?.canAuthenticate).toBe(false);
    expect(parsed.servers[1]?.enabled).toBe(false);
    expect(parsed.totals.serverCount).toBe(2);
    expect(parsed.warnings[0]).toContain("cursor");
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

describe("AutomodeGoal", () => {
  const legacyGoal = {
    id: "goal-legacy-1",
    title: "Legacy goal",
    prompt: "do the thing",
    repo: "/home/test/project",
    model: null,
    status: "queued",
    peerId: null,
    blockedReason: null,
    createdAt: "2026-06-02T10:00:00.000Z",
    updatedAt: "2026-06-02T10:00:00.000Z",
    approvedAt: null,
    rejectedAt: null,
  } as const;

  it("backfills episodeId when decoding a legacy persisted goal without one", () => {
    // Regression guard for the persisted-state wipe: PersistedAutomodeState embeds this
    // schema, so a legacy automode-state.json (no episodeId) must still decode.
    const parsed = decodeAutomodeGoal(legacyGoal);
    expect(parsed.episodeId).toMatch(/^epi-legacy-[0-9a-f-]{36}$/);
  });

  it("mints a fresh legacy episodeId per decode", () => {
    expect(decodeAutomodeGoal(legacyGoal).episodeId).not.toBe(
      decodeAutomodeGoal(legacyGoal).episodeId,
    );
  });

  it("keeps a provided episodeId", () => {
    const parsed = decodeAutomodeGoal({ ...legacyGoal, episodeId: "epi-abc" });
    expect(parsed.episodeId).toBe("epi-abc");
  });

  it("defaults workflowId to null when decoding a legacy persisted goal without one", () => {
    // Same persisted-state-wipe guard: a legacy automode-state.json predates the
    // workflow-dispatch field, so the decoding default must fill it (not fail decode).
    expect(decodeAutomodeGoal(legacyGoal).workflowId).toBe(null);
  });

  it("keeps a provided workflowId", () => {
    const parsed = decodeAutomodeGoal({ ...legacyGoal, workflowId: "wf-123" });
    expect(parsed.workflowId).toBe("wf-123");
  });

  it("defaults origin to manual when decoding a legacy persisted goal without one", () => {
    // Same persisted-state-wipe guard: a legacy automode-state.json predates the origin
    // field, and every goal minted before it existed was operator-authored ("manual").
    expect(decodeAutomodeGoal(legacyGoal).origin).toBe("manual");
  });

  it("keeps a provided origin", () => {
    const parsed = decodeAutomodeGoal({ ...legacyGoal, origin: "sweep" });
    expect(parsed.origin).toBe("sweep");
  });

  it("defaults branch to null when decoding a legacy persisted goal without one", () => {
    // Same persisted-state-wipe guard: goals dispatched before per-goal branches existed
    // have no branch; the driver falls back to policy.integrationBranch for them.
    expect(decodeAutomodeGoal(legacyGoal).branch).toBe(null);
  });

  it("keeps a provided branch", () => {
    const parsed = decodeAutomodeGoal({ ...legacyGoal, branch: "automode/goal-f948a67a" });
    expect(parsed.branch).toBe("automode/goal-f948a67a");
  });

  it("defaults proposal scheduling fields on legacy goals", () => {
    const parsed = decodeAutomodeGoal(legacyGoal);
    expect(parsed.notBefore).toBeNull();
    expect(parsed.maxRuntimeMinutes).toBeNull();
    expect(parsed.verificationCommands).toEqual([]);
    expect(parsed.integrationBranch).toBeNull();
  });
});

describe("Delamain workflow launch contracts", () => {
  const decodeInput = Schema.decodeUnknownSync(DelamainWorkflowRunInput);
  const encodeInput = Schema.encodeSync(DelamainWorkflowRunInput);
  const decodeResult = Schema.decodeUnknownSync(DelamainWorkflowRunResult);

  it("round-trips a full launch input (script/repo/name/argsJson)", () => {
    const input = {
      script: "/srv/delamain/workflows/automode-goal.ts",
      repo: "/home/test/project",
      name: "Nightly sweep",
      argsJson: '{"title":"Ship it"}',
    };
    expect(encodeInput(decodeInput(input))).toEqual(input);
  });

  it("accepts a bare input with name/argsJson omitted", () => {
    const parsed = decodeInput({
      script: "/srv/delamain/workflows/automode-goal.ts",
      repo: "/home/test/project",
    });
    expect(parsed.name).toBeUndefined();
    expect(parsed.argsJson).toBeUndefined();
  });

  it("accepts explicit null for name/argsJson", () => {
    const parsed = decodeInput({
      script: "/srv/delamain/workflows/automode-goal.ts",
      repo: "/home/test/project",
      name: null,
      argsJson: null,
    });
    expect(parsed.name).toBeNull();
    expect(parsed.argsJson).toBeNull();
  });

  it("decodes the launch result with an arbitrary status string", () => {
    expect(decodeResult({ workflowId: "wf-launch", status: "running" })).toEqual({
      workflowId: "wf-launch",
      status: "running",
    });
  });
});

describe("Hermes Motoko contracts", () => {
  const baseProposal = {
    id: "proposal-1",
    episodeId: "epi-proposal-1",
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

  it("decodes editable proposal execution settings", () => {
    const parsed = decodeHermesProposal({
      ...baseProposal,
      model: "gpt-5.6-sol",
      notBefore: "2026-06-03T00:00:00.000Z",
      maxRuntimeMinutes: 45,
      verificationCommands: [{ label: "typecheck", cmd: ["bun", "typecheck"] }],
      integrationBranch: "auto/proposal-1",
      sourceThreadId: "thread-1",
    });
    expect(parsed).toMatchObject({
      model: "gpt-5.6-sol",
      notBefore: "2026-06-03T00:00:00.000Z",
      maxRuntimeMinutes: 45,
      integrationBranch: "auto/proposal-1",
      sourceThreadId: "thread-1",
    });
    expect(parsed.verificationCommands).toHaveLength(1);
  });

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
      model: {
        provider: "openai-codex",
        model: "gpt-5.4",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        contextWindowTokens: 272000,
        contextWindowSource: "cache",
      },
      codexAuth: {
        state: "needs-reauth",
        source: "hermes-home",
        hermesAuthExists: true,
        codexCliAuthExists: true,
        message:
          "Hermes Codex OAuth chain requires re-login (relogin required (refresh_token_reused)).",
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

  it("still decodes the legacy codex-cli auth source", () => {
    const parsed = decodeHermesCodexAuthStatus({
      state: "detected",
      source: "codex-cli",
      hermesAuthExists: false,
      codexCliAuthExists: true,
      message: "legacy payload",
    });
    expect(parsed.source).toBe("codex-cli");
  });

  it("accepts expanded proposal cards, drafts, and scheduled proposal runs", () => {
    const proposal = decodeHermesProposal(baseProposal);
    const chatResult = decodeHermesChatResult({
      status: "proposal-created",
      actionKind: "repo-write",
      response: "Motoko recommends a guarded implementation handoff.",
      proposal,
      blockedReason: null,
      setupTitle: null,
      setupDetail: null,
      setupCommand: null,
      createdAt: "2026-06-02T10:00:00.000Z",
    });
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

    expect(chatResult.proposal?.id).toBe(proposal.id);
    expect(draft.kind).toBe("delamain-peer");
    expect(schedule.proposals).toHaveLength(1);
  });
});
