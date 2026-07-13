// @effect-diagnostics nodeBuiltinImport:off
import * as Fs from "node:fs/promises";
import * as Os from "node:os";
import * as Path from "node:path";

import * as Effect from "effect/Effect";
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
  codexChainPreflight,
  codexReauthCommand,
  hermesDirectExecutionBlocked,
  hermesModelCommand,
  hermesProposalRequiresApproval,
  isLegacyProviderSetupProposalArtifact,
  makeChat,
  makeHermesCliAdapter,
  makeHermesEnv,
  parseCodexChainHealth,
  parseHermesModelStatus,
  readCodexAuthStatus,
  resolveHermesHome,
} from "./HermesCliAdapter.ts";
import {
  AutomodeSupervisor,
  type AutomodeSupervisorShape,
} from "../Services/AutomodeSupervisor.ts";
import { DelamainAdapter, type DelamainAdapterShape } from "../Services/DelamainAdapter.ts";
import { GitsCapacityMonitor } from "../Services/GitsCapacityMonitor.ts";
import type { GitsCapacityMonitorShape } from "../Services/GitsCapacityMonitor.ts";
import { OpenGsdAdapter, type OpenGsdAdapterShape } from "../Services/OpenGsdAdapter.ts";

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

  it("strips every ANTHROPIC_*/CLAUDE_* var from child process env (decision 19)", () => {
    vi.stubEnv("HERMES_YOLO_MODE", "1");
    vi.stubEnv("ANTHROPIC_API_KEY", "SECRET-API-KEY");
    vi.stubEnv("ANTHROPIC_TOKEN", "SECRET-OAUTH-TOKEN");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "SECRET-CC-TOKEN");
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://api.anthropic.example");
    vi.stubEnv("HERMES_INFERENCE_PROVIDER", "anthropic");
    vi.stubEnv("GITS_KEEP_ME", "kept");

    const env = makeHermesEnv("/tmp/gits-hermes");

    expect(Object.keys(env).filter((key) => /^(ANTHROPIC_|CLAUDE_)/.test(key))).toEqual([]);
    expect(env.HERMES_YOLO_MODE).toBeUndefined();
    expect(env.HERMES_INFERENCE_PROVIDER).toBeUndefined();
    expect(env.HERMES_HOME).toBe("/tmp/gits-hermes");
    expect(env.GITS_KEEP_ME).toBe("kept");
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
  it("returns a scheduled result when the capacity fallback is unavailable", async () => {
    const tempDir = await Fs.mkdtemp(Path.join(Os.tmpdir(), "gits-hermes-schedule-"));
    const hermesHome = Path.join(tempDir, "hermes-home");
    const hermesBin = Path.join(tempDir, "hermes");
    await Fs.writeFile(
      hermesBin,
      ["#!/usr/bin/env bash", "printf '%s\\n' 'Scheduled stale scan result'", ""].join("\n"),
      "utf8",
    );
    await Fs.chmod(hermesBin, 0o755);
    vi.stubEnv("GITS_HERMES_BIN", hermesBin);
    vi.stubEnv("GITS_HERMES_HOME", hermesHome);
    vi.stubEnv("GITS_MOTOKO_SCHEDULES_DISABLED", undefined);

    const unusedCapacityMonitor = {
      getSnapshot: () => Effect.die("unused capacity monitor"),
    } satisfies GitsCapacityMonitorShape;
    const unusedDelamainAdapter = {
      listPeers: () => Effect.die("unused Delamain adapter"),
    } as unknown as DelamainAdapterShape;
    const unusedOpenGsdAdapter = {
      getStatus: () => Effect.die("unused Open GSD adapter"),
    } as unknown as OpenGsdAdapterShape;
    const unusedAutomodeSupervisor = {
      getSnapshot: () => Effect.die("unused automode supervisor"),
    } as unknown as AutomodeSupervisorShape;

    const adapter = await Effect.runPromise(
      makeHermesCliAdapter.pipe(
        Effect.provideService(GitsCapacityMonitor, unusedCapacityMonitor),
        Effect.provideService(DelamainAdapter, unusedDelamainAdapter),
        Effect.provideService(OpenGsdAdapter, unusedOpenGsdAdapter),
        Effect.provideService(AutomodeSupervisor, unusedAutomodeSupervisor),
      ),
    );

    const result = await Effect.runPromise(
      adapter.runSchedule({
        kind: "weekly-stale-scan",
      }),
    );

    expect(result.kind).toBe("weekly-stale-scan");
    expect(result.blockedReason).toBeNull();
    expect(result.proposals).toEqual([]);
  });

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

const HEALTHY_AUTH = JSON.stringify({
  version: 1,
  providers: {
    "openai-codex": {
      tokens: {
        access_token: "SECRET-ACCESS",
        refresh_token: "SECRET-REFRESH",
        id_token: "SECRET-ID",
        account_id: "acct-1",
      },
      last_refresh: "2026-07-01T00:00:00Z",
      auth_mode: "chatgpt",
    },
  },
  updated_at: "2026-07-01T00:00:00Z",
  active_provider: "openai-codex",
});
const DEAD_AUTH = JSON.stringify({
  version: 1,
  providers: {
    "openai-codex": {
      tokens: { id_token: "SECRET-ID", account_id: "acct-1" },
      last_refresh: "2026-06-03T00:00:00Z",
      auth_mode: "chatgpt",
      last_auth_error: {
        provider: "openai-codex",
        code: "refresh_token_reused",
        message: "Codex refresh token was already consumed by another client",
        reason: "credential_pool_refresh_failure",
        relogin_required: true,
        at: "2026-06-20T18:12:04+00:00",
      },
    },
  },
  updated_at: "2026-06-20T18:12:04+00:00",
  active_provider: "openai-codex",
});
// Mirrors the real post-`hermes auth add` auth.json: providers entry keeps only
// id_token/account_id plus a STALE relogin_required error, while the live OAuth pair
// lives in credential_pool["openai-codex"].
function poolAuthFixture(entry: Record<string, unknown>): string {
  return JSON.stringify({
    version: 1,
    providers: {
      "openai-codex": {
        tokens: { id_token: "SECRET-ID", account_id: "acct-1" },
        last_refresh: "2026-06-03T00:00:00Z",
        auth_mode: "chatgpt",
        last_auth_error: {
          provider: "openai-codex",
          code: "refresh_token_reused",
          message: "Codex refresh token was already consumed by another client",
          reason: "credential_pool_refresh_failure",
          relogin_required: true,
          at: "2026-06-20T18:12:04+00:00",
        },
      },
    },
    credential_pool: { "openai-codex": [entry] },
    updated_at: "2026-07-13T00:00:00Z",
    active_provider: "openai-codex",
  });
}
const POOL_ENTRY = {
  id: "cred-1",
  label: "openai-codex-oauth-1",
  auth_type: "oauth",
  priority: 0,
  source: "manual:device_code",
  access_token: "SECRET-POOL-ACCESS",
  refresh_token: "SECRET-POOL-REFRESH",
  base_url: "https://chatgpt.com/backend-api/codex",
  last_refresh: "2026-07-13T00:00:00Z",
  request_count: 3,
};
const POOL_ONLY_AUTH = poolAuthFixture(POOL_ENTRY);
const CODEX_PROVIDER_CONFIG = "model:\n  provider: openai-codex\n  default: gpt-5.4\n";

describe("HermesCliAdapter codex chain health", () => {
  it("reports a missing auth.json as missing", () => {
    expect(parseCodexChainHealth(null)).toEqual({ kind: "missing" });
  });

  it("reports a healthy chain as healthy", () => {
    expect(parseCodexChainHealth(HEALTHY_AUTH)).toEqual({ kind: "healthy" });
  });

  it("reports a relogin-required chain as needs-reauth with the error code", () => {
    const result = parseCodexChainHealth(DEAD_AUTH);
    expect(result.kind).toBe("needs-reauth");
    expect(result.kind === "needs-reauth" && result.reason).toContain("refresh_token_reused");
  });

  it("reports missing or empty tokens as needs-reauth without a last_auth_error", () => {
    const missingTokens = JSON.stringify({
      version: 1,
      providers: {
        "openai-codex": {
          tokens: { id_token: "SECRET-ID", account_id: "acct-1" },
        },
      },
    });
    const missingResult = parseCodexChainHealth(missingTokens);
    expect(missingResult.kind).toBe("needs-reauth");
    expect(missingResult.kind === "needs-reauth" && missingResult.reason).toContain(
      "access_token/refresh_token missing",
    );

    const emptyTokens = JSON.stringify({
      version: 1,
      providers: {
        "openai-codex": {
          tokens: { access_token: "", refresh_token: "SECRET-REFRESH" },
        },
      },
    });
    const emptyResult = parseCodexChainHealth(emptyTokens);
    expect(emptyResult.kind).toBe("needs-reauth");
    expect(emptyResult.kind === "needs-reauth" && emptyResult.reason).toContain(
      "access_token/refresh_token missing",
    );
  });

  it("tolerates a non-relogin last_auth_error when both tokens are present", () => {
    const midRotation = JSON.stringify({
      version: 1,
      providers: {
        "openai-codex": {
          tokens: { access_token: "SECRET-ACCESS", refresh_token: "SECRET-REFRESH" },
          last_auth_error: { code: "transient", relogin_required: false },
        },
      },
    });
    expect(parseCodexChainHealth(midRotation)).toEqual({ kind: "healthy" });
  });

  it("reports a pool-only chain (hermes auth add) as healthy despite a stale providers relogin error", () => {
    expect(parseCodexChainHealth(POOL_ONLY_AUTH)).toEqual({ kind: "healthy" });
  });

  it("reports a pool entry without tokens as needs-reauth", () => {
    const { access_token: _access, refresh_token: _refresh, ...tokenless } = POOL_ENTRY;
    const result = parseCodexChainHealth(poolAuthFixture(tokenless));
    expect(result.kind).toBe("needs-reauth");
  });

  it("reports a dead pool entry as needs-reauth with the pool entry's own error reason", () => {
    const result = parseCodexChainHealth(
      poolAuthFixture({ ...POOL_ENTRY, last_status: "dead", last_error_reason: "token_revoked" }),
    );
    expect(result.kind).toBe("needs-reauth");
    expect(result.kind === "needs-reauth" && result.reason).toContain("pool entry dead");
    expect(result.kind === "needs-reauth" && result.reason).toContain("token_revoked");
  });

  it("reports malformed JSON as needs-reauth", () => {
    expect(parseCodexChainHealth("{not json").kind).toBe("needs-reauth");
  });

  it("reports a missing openai-codex entry as needs-reauth", () => {
    expect(parseCodexChainHealth('{"version":1,"providers":{}}').kind).toBe("needs-reauth");
  });

  it("never leaks token values into health results", () => {
    const missingTokens = JSON.stringify({
      version: 1,
      providers: {
        "openai-codex": {
          tokens: { id_token: "SECRET-ID", account_id: "acct-1" },
        },
      },
    });
    const deadPool = poolAuthFixture({
      ...POOL_ENTRY,
      last_status: "dead",
      last_error_reason: "token_revoked",
    });
    for (const authText of [HEALTHY_AUTH, DEAD_AUTH, POOL_ONLY_AUTH, missingTokens, deadPool]) {
      expect(JSON.stringify(parseCodexChainHealth(authText))).not.toContain("SECRET");
    }
  });
});

describe("HermesCliAdapter codex auth status", () => {
  it("reports a dead chain as needs-reauth from hermes-home with the re-login command", async () => {
    const tmp = await Fs.mkdtemp(Path.join(Os.tmpdir(), "gits-hermes-auth-"));
    await Fs.writeFile(Path.join(tmp, "auth.json"), DEAD_AUTH, "utf8");

    const status = await readCodexAuthStatus({
      hermesHome: tmp,
      codexCliAuthPath: Path.join(tmp, "codex-cli-auth.json"),
    });

    expect(status.state).toBe("needs-reauth");
    expect(status.source).toBe("hermes-home");
    expect(status.hermesAuthExists).toBe(true);
    expect(status.message).toContain(codexReauthCommand(tmp));
    expect(status.message).not.toContain("SECRET");
  });

  it("never treats the codex CLI auth file as a hermes auth source", async () => {
    const tmp = await Fs.mkdtemp(Path.join(Os.tmpdir(), "gits-hermes-auth-"));
    const codexCliAuthPath = Path.join(tmp, "codex-cli-auth.json");
    await Fs.writeFile(codexCliAuthPath, "{}", "utf8");

    const status = await readCodexAuthStatus({ hermesHome: tmp, codexCliAuthPath });

    expect(status.state).toBe("missing");
    expect(status.source).toBe("missing");
    expect(status.codexCliAuthExists).toBe(true);
    expect(status.message).not.toMatch(/import/i);
  });
});

describe("HermesCliAdapter codex chain preflight", () => {
  it("blocks a configured non-codex provider with the reconfigure command (decision 19)", async () => {
    const tmp = await Fs.mkdtemp(Path.join(Os.tmpdir(), "gits-hermes-preflight-"));
    const configPath = Path.join(tmp, "config.yaml");
    await Fs.writeFile(configPath, "model:\n  provider: openrouter\n  default: gpt-5.4\n", "utf8");
    await Fs.writeFile(Path.join(tmp, "auth.json"), HEALTHY_AUTH, "utf8");

    const preflight = await codexChainPreflight({ hermesHome: tmp, configPath });

    expect(preflight?.kind).toBe("wrong-provider");
    expect(preflight?.reason).toContain("openrouter");
    expect(preflight?.command).toBe(hermesModelCommand(tmp));
  });

  it("never blocks when no provider is configured", async () => {
    const missingConfigTmp = await Fs.mkdtemp(Path.join(Os.tmpdir(), "gits-hermes-preflight-"));
    await Fs.writeFile(Path.join(missingConfigTmp, "auth.json"), DEAD_AUTH, "utf8");
    expect(
      await codexChainPreflight({
        hermesHome: missingConfigTmp,
        configPath: Path.join(missingConfigTmp, "config.yaml"),
      }),
    ).toBeNull();

    const noModelTmp = await Fs.mkdtemp(Path.join(Os.tmpdir(), "gits-hermes-preflight-"));
    const noModelConfigPath = Path.join(noModelTmp, "config.yaml");
    await Fs.writeFile(noModelConfigPath, "approvals:\n  mode: manual\n", "utf8");
    await Fs.writeFile(Path.join(noModelTmp, "auth.json"), DEAD_AUTH, "utf8");
    expect(
      await codexChainPreflight({ hermesHome: noModelTmp, configPath: noModelConfigPath }),
    ).toBeNull();
  });

  it("blocks a codex provider with a dead chain", async () => {
    const tmp = await Fs.mkdtemp(Path.join(Os.tmpdir(), "gits-hermes-preflight-"));
    const configPath = Path.join(tmp, "config.yaml");
    await Fs.writeFile(configPath, CODEX_PROVIDER_CONFIG, "utf8");
    await Fs.writeFile(Path.join(tmp, "auth.json"), DEAD_AUTH, "utf8");

    const preflight = await codexChainPreflight({ hermesHome: tmp, configPath });

    expect(preflight?.kind).toBe("needs-reauth");
    expect(preflight?.command).toBe(codexReauthCommand(tmp));
  });

  it("blocks a codex provider with no auth.json", async () => {
    const tmp = await Fs.mkdtemp(Path.join(Os.tmpdir(), "gits-hermes-preflight-"));
    const configPath = Path.join(tmp, "config.yaml");
    await Fs.writeFile(configPath, CODEX_PROVIDER_CONFIG, "utf8");

    const preflight = await codexChainPreflight({ hermesHome: tmp, configPath });

    expect(preflight).not.toBeNull();
    expect(preflight?.reason).toBe("no Codex OAuth chain in HERMES_HOME");
  });

  it("passes a codex provider with a healthy chain", async () => {
    const tmp = await Fs.mkdtemp(Path.join(Os.tmpdir(), "gits-hermes-preflight-"));
    const configPath = Path.join(tmp, "config.yaml");
    await Fs.writeFile(configPath, CODEX_PROVIDER_CONFIG, "utf8");
    await Fs.writeFile(Path.join(tmp, "auth.json"), HEALTHY_AUTH, "utf8");

    expect(await codexChainPreflight({ hermesHome: tmp, configPath })).toBeNull();
  });
});

describe("HermesCliAdapter chat preflight", () => {
  it("short-circuits chat before spawning hermes on a dead codex chain", async () => {
    const tmp = await Fs.mkdtemp(Path.join(Os.tmpdir(), "gits-hermes-chat-"));
    await Fs.writeFile(Path.join(tmp, "config.yaml"), CODEX_PROVIDER_CONFIG, "utf8");
    await Fs.writeFile(Path.join(tmp, "auth.json"), DEAD_AUTH, "utf8");
    const markerPath = Path.join(tmp, "fake-hermes");
    await Fs.writeFile(markerPath, '#!/bin/sh\ntouch "$(dirname "$0")/spawned"\n', "utf8");
    await Fs.chmod(markerPath, 0o755);
    vi.stubEnv("GITS_HERMES_HOME", tmp);
    vi.stubEnv("GITS_HERMES_BIN", markerPath);

    const result = await Effect.runPromise(
      makeChat({
        getSnapshot: () => Effect.die(new Error("capacity must not be consulted before preflight")),
      })({ message: "inspect the project status" }),
    );

    expect(result.status).toBe("setup-required");
    expect(result.setupCommand).toBe(codexReauthCommand(tmp));
    expect(result.blockedReason).toContain("re-login");
    expect(JSON.stringify(result)).not.toContain("SECRET");
    const spawned = await Fs.stat(Path.join(tmp, "spawned")).then(
      () => true,
      () => false,
    );
    expect(spawned).toBe(false);
  });

  it("short-circuits chat with the reconfigure command on a non-codex provider (decision 19)", async () => {
    const tmp = await Fs.mkdtemp(Path.join(Os.tmpdir(), "gits-hermes-chat-"));
    await Fs.writeFile(
      Path.join(tmp, "config.yaml"),
      "model:\n  provider: openrouter\n  default: gpt-5.4\n",
      "utf8",
    );
    await Fs.writeFile(Path.join(tmp, "auth.json"), HEALTHY_AUTH, "utf8");
    // spawn prevention is proven by the dead-chain test above (same early return); this test
    // only asserts the decision-19 messaging, so the binary path never needs to exist.
    vi.stubEnv("GITS_HERMES_HOME", tmp);
    vi.stubEnv("GITS_HERMES_BIN", Path.join(tmp, "fake-hermes"));

    const result = await Effect.runPromise(
      makeChat({
        getSnapshot: () => Effect.die(new Error("capacity must not be consulted before preflight")),
      })({ message: "inspect the project status" }),
    );

    expect(result.status).toBe("setup-required");
    expect(result.setupCommand).toBe(hermesModelCommand(tmp));
    expect(result.blockedReason).toContain("openai-codex");
    expect(result.blockedReason).not.toContain("re-login");
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
