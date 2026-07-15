import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { CodexAccountUsage, UsageSummary } from "./usage.ts";

const decodeUsageSummary = Schema.decodeUnknownSync(UsageSummary);
const decodeCodexAccountUsage = Schema.decodeUnknownSync(CodexAccountUsage);

it("decodes usage summaries", () => {
  const parsed = decodeUsageSummary({
    checkedAt: "2026-07-06T20:56:49.230Z",
    currency: "USD",
    costEstimate: true,
    totals: {
      inputTokens: 10,
      cachedInputTokens: 2,
      cacheCreationInputTokens: 3,
      cacheReadInputTokens: 4,
      outputTokens: 5,
      reasoningOutputTokens: 1,
      totalTokens: 25,
    },
    estimatedCostUsd: 0.01,
    models: [
      {
        provider: "codex",
        model: "gpt-5.5",
        requestCount: 1,
        tokens: {
          inputTokens: 10,
          cachedInputTokens: 2,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          outputTokens: 5,
          reasoningOutputTokens: 1,
          totalTokens: 18,
        },
        estimatedCostUsd: 0.01,
      },
    ],
    days: [
      {
        date: "2026-07-06",
        requestCount: 1,
        tokens: {
          inputTokens: 10,
          cachedInputTokens: 2,
          cacheCreationInputTokens: 3,
          cacheReadInputTokens: 4,
          outputTokens: 5,
          reasoningOutputTokens: 1,
          totalTokens: 25,
        },
        estimatedCostUsd: 0.01,
      },
    ],
    windows: [
      {
        provider: "codex",
        label: "5h",
        usedPercent: 54,
        remainingPercent: 46,
        windowMinutes: 300,
        resetAt: "2026-07-06T23:30:50.000Z",
        sourcePath: "/home/test/.codex/sessions/session.jsonl",
      },
    ],
    sources: [
      {
        provider: "codex",
        status: "available",
        homePath: "/home/test/.codex",
        scannedFilePaths: ["/home/test/.codex/sessions/session.jsonl"],
        note: "confirmed",
      },
    ],
    notes: ["estimated"],
  });

  assert.equal(parsed.models[0]?.model, "gpt-5.5");
  assert.equal(parsed.windows[0]?.label, "5h");
});

it("decodes Codex account usage and reset credits", () => {
  const parsed = decodeCodexAccountUsage({
    checkedAt: "2026-07-15T12:00:00.000Z",
    planType: "plus",
    primary: { usedPercent: 40, windowMinutes: 300, resetAt: "2026-07-15T17:00:00.000Z" },
    secondary: {
      usedPercent: 60,
      windowMinutes: 10080,
      resetAt: "2026-07-20T12:00:00.000Z",
    },
    availableResetCount: 1,
    resetCredits: [
      {
        id: "credit-1",
        title: "Full reset",
        description: null,
        grantedAt: "2026-07-01T12:00:00.000Z",
        expiresAt: "2026-07-18T02:38:00.000Z",
        status: "available",
      },
    ],
  });

  assert.equal(parsed.primary?.windowMinutes, 300);
  assert.equal(parsed.resetCredits[0]?.id, "credit-1");
});
