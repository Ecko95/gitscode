// @effect-diagnostics nodeBuiltinImport:off
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, it } from "@effect/vitest";

import { readUsageSummary } from "./GitsUsageReader.ts";

function withUsageHomes(run: (codexHome: string, claudeHome: string) => void) {
  const previousCodex = process.env.GITS_CODEX_USAGE_HOME;
  const previousClaude = process.env.GITS_CLAUDE_USAGE_HOME;
  const root = mkdtempSync(join(tmpdir(), "t3-usage-reader-"));
  const codexHome = join(root, "codex");
  const claudeHome = join(root, "claude");
  process.env.GITS_CODEX_USAGE_HOME = codexHome;
  process.env.GITS_CLAUDE_USAGE_HOME = claudeHome;
  try {
    run(codexHome, claudeHome);
  } finally {
    if (previousCodex === undefined) {
      delete process.env.GITS_CODEX_USAGE_HOME;
    } else {
      process.env.GITS_CODEX_USAGE_HOME = previousCodex;
    }
    if (previousClaude === undefined) {
      delete process.env.GITS_CLAUDE_USAGE_HOME;
    } else {
      process.env.GITS_CLAUDE_USAGE_HOME = previousClaude;
    }
  }
}

it("parses confirmed Codex token_count and Claude message usage JSONL records", () => {
  withUsageHomes((codexHome, claudeHome) => {
    const codexDir = join(codexHome, "sessions", "2026", "07", "06");
    const claudeDir = join(claudeHome, "projects", "-repo");
    mkdirSync(codexDir, { recursive: true });
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(codexDir, "rollout-2026-07-06T20-56-37.jsonl"),
      [
        JSON.stringify({
          timestamp: "2026-07-06T20:56:40.641Z",
          type: "turn_context",
          payload: { model: "gpt-5.5" },
        }),
        JSON.stringify({
          timestamp: "2026-07-06T20:56:49.230Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              last_token_usage: {
                input_tokens: 19440,
                cached_input_tokens: 4992,
                output_tokens: 443,
                reasoning_output_tokens: 0,
                total_tokens: 19883,
              },
            },
            rate_limits: {
              primary: { used_percent: 54, window_minutes: 300, resets_at: 1783383050 },
              secondary: { used_percent: 56, window_minutes: 10080, resets_at: 1783589991 },
              plan_type: "prolite",
            },
          },
        }),
      ].join("\n"),
    );
    const claudeLine = JSON.stringify({
      timestamp: "2026-07-06T17:34:31.942Z",
      type: "assistant",
      message: {
        model: "claude-fable-5",
        usage: {
          input_tokens: 24675,
          cache_creation_input_tokens: 9650,
          cache_read_input_tokens: 18341,
          output_tokens: 780,
        },
      },
      requestId: "req_011CcmCuijax8XAYjechuCab",
      uuid: "e2b68b92-7a56-4aa2-8384-52fd35600a21",
    });
    writeFileSync(join(claudeDir, "session.jsonl"), [claudeLine, claudeLine].join("\n"));

    const summary = readUsageSummary();
    assert.equal(summary.currency, "USD");
    assert.equal(summary.totals.inputTokens, 44115);
    assert.equal(summary.totals.cachedInputTokens, 4992);
    assert.equal(summary.totals.cacheCreationInputTokens, 9650);
    assert.equal(summary.totals.cacheReadInputTokens, 18341);
    assert.equal(summary.totals.outputTokens, 1223);
    assert.equal(summary.models.length, 2);
    assert.equal(summary.models.find((model) => model.model === "gpt-5.5")?.requestCount, 1);
    assert.equal(summary.models.find((model) => model.model === "claude-fable-5")?.requestCount, 1);
    assert.equal(summary.windows.map((window) => window.label).join(","), "5h,weekly");
    assert.equal(summary.days[0]?.date, "2026-07-06");
    assert.equal(summary.sources[0]?.status, "available");
    assert.equal(summary.sources[1]?.status, "available");
  });
});
