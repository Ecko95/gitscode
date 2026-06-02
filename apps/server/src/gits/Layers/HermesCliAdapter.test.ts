// @effect-diagnostics nodeBuiltinImport:off
import * as Fs from "node:fs/promises";
import * as Os from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

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
  makeHermesEnv,
  resolveHermesHome,
} from "./HermesCliAdapter.ts";

afterEach(() => {
  vi.unstubAllEnvs();
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
});

describe("HermesCliAdapter cockpit chat", () => {
  it("classifies spawn-shaped operator requests as approval-gated worktree actions", () => {
    expect(classifyHermesChatAction("spawn agents for this new project")).toBe("worktree-spawn");
    expect(classifyHermesChatAction("admin-merge this branch")).toBe("integrate");
    expect(classifyHermesChatAction("delete the repo and reset --hard")).toBe("destructive-shell");
    expect(classifyHermesChatAction("inspect the project status")).toBe("read-only");
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
