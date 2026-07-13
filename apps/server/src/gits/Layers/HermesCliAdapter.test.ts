// @effect-diagnostics nodeBuiltinImport:off
import * as Fs from "node:fs/promises";
import * as Os from "node:os";
import * as Path from "node:path";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HermesAdapter } from "../Services/HermesAdapter.ts";
import { AutomodeSupervisor } from "../Services/AutomodeSupervisor.ts";
import { DelamainAdapter } from "../Services/DelamainAdapter.ts";
import { GitsCapacityMonitor } from "../Services/GitsCapacityMonitor.ts";
import { OpenGsdAdapter } from "../Services/OpenGsdAdapter.ts";
import {
  buildProjectContextMarkdown,
  buildHermesCockpitChatArgs,
  buildHermesCockpitChatPrompt,
  buildHermesInspectGitsArgs,
  HERMES_ACP_CHECK_ARGS,
  HERMES_ACP_START_ARGS,
  HERMES_CODEX_OAUTH_ARGS,
  HERMES_DOCTOR_ARGS,
  HERMES_VERSION_ARGS,
  classifyHermesChatAction,
  hermesDirectExecutionBlocked,
  hermesProposalRequiresApproval,
  isLegacyProviderSetupProposalArtifact,
  makeHermesEnv,
  parseHermesModelStatus,
  resolveHermesHome,
  HermesCliAdapterLive,
} from "./HermesCliAdapter.ts";

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;

const execFileMock = vi.hoisted(() =>
  vi.fn<
    (
      file: string,
      args: ReadonlyArray<string>,
      options: Record<string, unknown>,
      callback: ExecFileCallback,
    ) => unknown
  >(),
);

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

beforeEach(() => {
  execFileMock.mockImplementation((_file, _args, _options, callback) => {
    callback(new Error("execFile mock not configured for this test."), "", "");
    return {};
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  execFileMock.mockReset();
});

describe("HermesCliAdapter command construction", () => {
  it("uses the isolated GITS Hermes home by default", () => {
    vi.stubEnv("GITS_HERMES_HOME", undefined);

    const home = resolveHermesHome();

    expect(home.usingDefaultGitsHome).toBe(true);
    expect(home.hermesHome).toContain(".gits/hermes");
  });

  it("builds fixed Hermes command arguments", () => {
    expect([...HERMES_VERSION_ARGS]).toEqual(["--version"]);
    expect([...HERMES_DOCTOR_ARGS]).toEqual(["doctor"]);
    expect([...HERMES_ACP_CHECK_ARGS]).toEqual(["acp", "--check"]);
    expect([...HERMES_ACP_START_ARGS]).toEqual(["acp"]);
    expect([...HERMES_CODEX_OAUTH_ARGS]).toEqual([
      "auth",
      "add",
      "openai-codex",
      "--type",
      "oauth",
    ]);
    expect(buildHermesInspectGitsArgs("inspect read-only")).toEqual([
      "chat",
      "-q",
      "inspect read-only",
    ]);
    expect(buildHermesCockpitChatArgs("operator request")).toEqual([
      "chat",
      "-Q",
      "--source",
      "gits-cockpit",
      "--max-turns",
      "1",
      "-q",
      "operator request",
    ]);
  });

  it("sets HERMES_HOME and strips YOLO mode from child process env", () => {
    vi.stubEnv("HERMES_YOLO_MODE", "1");

    const env = makeHermesEnv("/tmp/gits-hermes");

    expect(env.HERMES_HOME).toBe("/tmp/gits-hermes");
    expect(env.HERMES_YOLO_MODE).toBeUndefined();
  });

  it("reads non-secret model metadata from Hermes config and cache", () => {
    expect(
      parseHermesModelStatus(
        [
          "model:",
          "  provider: openai-codex",
          "  base_url: https://chatgpt.com/backend-api/codex",
          "  default: gpt-5.4",
        ].join("\n"),
        "context_lengths:\n  gpt-5.4@https://chatgpt.com/backend-api/codex: 272000\n",
      ),
    ).toEqual({
      provider: "openai-codex",
      model: "gpt-5.4",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      contextWindowTokens: 272000,
      contextWindowSource: "cache",
    });
  });
});

describe("HermesCliAdapter cockpit chat", () => {
  it("classifies spawn-shaped operator requests as approval-gated worktree actions", () => {
    expect(classifyHermesChatAction("spawn agents for this new project")).toBe("worktree-spawn");
    expect(classifyHermesChatAction("admin-merge this branch")).toBe("integrate");
    expect(classifyHermesChatAction("delete the repo and reset --hard")).toBe("destructive-shell");
    expect(classifyHermesChatAction("create a branch for this fix")).toBe("repo-write");
    expect(classifyHermesChatAction("inspect the project status")).toBe("read-only");
    expect(classifyHermesChatAction("what branch is deployed right now?")).toBe("read-only");
  });

  it("wraps operator messages in governed proposal instructions", () => {
    const prompt = buildHermesCockpitChatPrompt({
      message: "spawn agents for a new project",
      projectDir: "/tmp/gits",
    });

    expect(prompt).toContain("Selected project root: /tmp/gits");
    expect(prompt).toContain("GITS classified this request as: worktree-spawn");
    expect(prompt).toContain("Do not edit files, spawn peers");
    expect(prompt).toContain("Operator request: spawn agents for a new project");
  });

  it("answers read-only operator questions without proposal-card instructions", () => {
    const prompt = buildHermesCockpitChatPrompt({
      message: "what branch is deployed right now?",
      projectDir: "/tmp/gits",
    });

    expect(prompt).toContain("Respond directly to the operator request");
    expect(prompt).toContain("Do not produce a proposal card for a read-only question.");
    expect(prompt).not.toContain("produce exactly one governed proposal card");
  });

  it("recognizes legacy provider setup proposal artifacts", () => {
    expect(
      isLegacyProviderSetupProposalArtifact({
        id: "hermes-legacy",
        title: "No inference provider configured. Run 'hermes model' to choose a provider and",
        summary: "model, or set an API key",
        detail:
          "No inference provider configured. Run 'hermes model' to choose a provider and model.",
        evidence: ["Generated from Motoko/Hermes proposal output."],
        scope: ["Read-only inspection."],
        risk: "blocked",
        actionKind: "read-only",
        status: "blocked",
        requiresApproval: false,
        recommendedExecutor: "none",
        verificationPlan: ["Confirm no repo mutation occurred."],
        nextCommandOrPrompt: null,
        blockedReason: "Hermes cockpit chat did not complete.",
        source: "hermes cockpit chat",
        projectDir: "/tmp/gits",
        decisionReason: null,
        decidedAt: null,
        createdAt: "2026-06-03T00:00:00.000Z",
        updatedAt: "2026-06-03T00:00:00.000Z",
      }),
    ).toBe(true);
  });

  it("keeps ordinary proposals visible", () => {
    expect(
      isLegacyProviderSetupProposalArtifact({
        id: "hermes-normal",
        title: "Inspect build provenance drift",
        summary: "Capture the deploy metadata mismatch and propose a cleanup.",
        detail: "The hosted worktree metadata is stale and should be refreshed.",
        evidence: ["Operator request was classified by GITS before Hermes response."],
        scope: ["Selected project root: /tmp/gits", "Read-only analysis and recommendation."],
        risk: "low",
        actionKind: "read-only",
        status: "proposed",
        requiresApproval: false,
        recommendedExecutor: "none",
        verificationPlan: ["Review the cited evidence in GITS before taking action."],
        nextCommandOrPrompt: null,
        blockedReason: null,
        source: "hermes cockpit chat",
        projectDir: "/tmp/gits",
        decisionReason: null,
        decidedAt: null,
        createdAt: "2026-06-03T00:00:00.000Z",
        updatedAt: "2026-06-03T00:00:00.000Z",
      }),
    ).toBe(false);
  });

  it("builds deterministic read-only project context with GITS evidence sections", async () => {
    const projectDir = await Fs.mkdtemp(Path.join(Os.tmpdir(), "gits-motoko-context-"));
    await Fs.mkdir(Path.join(projectDir, ".planning"), { recursive: true });
    await Fs.mkdir(Path.join(projectDir, "docs", "gits"), { recursive: true });
    await Fs.writeFile(
      Path.join(projectDir, ".planning", "PROJECT.md"),
      "# Project\n\nCurrent milestone context.",
      "utf8",
    );
    await Fs.writeFile(
      Path.join(projectDir, ".planning", "VERIFICATION.md"),
      "# Verification\n\nLatest verification evidence.",
      "utf8",
    );
    await Fs.writeFile(
      Path.join(projectDir, "docs", "gits", "RUNBOOK.md"),
      "# Runbook\n\nTailnet hosting runbook.",
      "utf8",
    );

    const markdown = await buildProjectContextMarkdown(projectDir, "2026-01-01T00:00:00.000Z", {
      capacitySummary: "Capacity routed to Codex.",
      delamainSummary: "No active Delamain peers.",
      openGsdSummary: "Open GSD available.",
      automodeSummary: "Automode manual.",
    });

    expect(markdown).toContain("Planning: present");
    expect(markdown).toContain("PROJECT.md excerpt:");
    expect(markdown).toContain("VERIFICATION.md");
    expect(markdown).toContain("## Delamain Fleet");
    expect(markdown).toContain("No active Delamain peers.");
    expect(markdown).toContain("## Open GSD");
    expect(markdown).toContain("## Automode Policy");
    expect(markdown).toContain("## Provider Capacity");
    expect(markdown).toContain("Capacity routed to Codex.");
    expect(markdown).toContain("RUNBOOK.md");
    expect(markdown).toContain("Motoko may inspect and propose only.");
  });
});

describe("HermesCliAdapter policy gates", () => {
  it("allows read-only proposals without approval", () => {
    expect(hermesProposalRequiresApproval("read-only")).toBe(false);
    expect(hermesDirectExecutionBlocked("read-only")).toBe(false);
  });

  it("requires approval and blocks direct execution for write-shaped proposals", () => {
    for (const actionKind of [
      "worktree-spawn",
      "repo-write",
      "integrate",
      "destructive-shell",
    ] as const) {
      expect(hermesProposalRequiresApproval(actionKind)).toBe(true);
      expect(hermesDirectExecutionBlocked(actionKind)).toBe(true);
    }
  });
});

describe("HermesCliAdapter schedules", () => {
  const unused = () => Effect.die("unused dependency");
  const TestLayer = HermesCliAdapterLive.pipe(
    Layer.provide(
      Layer.mock(GitsCapacityMonitor)({
        getSnapshot: unused,
      }),
    ),
    Layer.provide(
      Layer.mock(DelamainAdapter)({
        listPeers: unused,
      }),
    ),
    Layer.provide(
      Layer.mock(OpenGsdAdapter)({
        getStatus: unused,
      }),
    ),
    Layer.provide(
      Layer.mock(AutomodeSupervisor)({
        getSnapshot: unused,
      }),
    ),
  );

  it("survives the scheduled capacity lookup fallback and returns the schedule result", async () => {
    const hermesHome = await Fs.mkdtemp(Path.join(Os.tmpdir(), "gits-hermes-schedule-"));
    vi.stubEnv("GITS_HERMES_HOME", hermesHome);
    execFileMock.mockImplementation((_file, args, _options, callback) => {
      expect(args).toContain("chat");
      expect(args).toContain("-q");
      const prompt = args.at(-1);
      expect(prompt).toContain("Provider capacity snapshot: unavailable.");
      callback(null, "Daily briefing complete.", "");
      return {};
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* HermesAdapter;
        return yield* adapter.runSchedule({
          kind: "daily-briefing",
          projectDir: "/tmp/gits",
        });
      }).pipe(Effect.provide(TestLayer)),
    );

    expect(result.kind).toBe("daily-briefing");
    expect(result.blockedReason).toBe(
      "Requires human approval before Delamain spawn, repo write, integrate, or destructive action.",
    );
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]).toMatchObject({
      detail: "Daily briefing complete.",
      evidence: expect.arrayContaining(["Provider capacity snapshot unavailable."]),
    });
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });
});
