import { describe, expect, it } from "vitest";

import { aggregateUsageModelBreakdown, type UsageCostActivityRow } from "./UsageModelBreakdown.ts";

function row(
  overrides: Partial<UsageCostActivityRow> & { payload: unknown },
): UsageCostActivityRow {
  return {
    activityId: overrides.activityId ?? "activity-1",
    turnId: overrides.turnId !== undefined ? overrides.turnId : "turn-1",
    providerName: overrides.providerName ?? "claudeAgent",
    payloadJson: JSON.stringify(overrides.payload),
  };
}

function opusUsage(costUSD?: number) {
  return {
    modelUsage: {
      "claude-opus-4-8": {
        inputTokens: 2,
        outputTokens: 2682,
        cacheReadInputTokens: 34584,
        cacheCreationInputTokens: 100,
        ...(costUSD === undefined ? {} : { costUSD }),
      },
    },
  };
}

describe("aggregateUsageModelBreakdown", () => {
  it("sums tokens and provider-reported cost per model, counting distinct turns", () => {
    const entries = aggregateUsageModelBreakdown([
      row({ activityId: "a1", turnId: "turn-1", payload: opusUsage(0.08) }),
      row({ activityId: "a2", turnId: "turn-1", payload: opusUsage(0.02) }),
      row({ activityId: "a3", turnId: "turn-2", payload: opusUsage(0.1) }),
    ]);

    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry.model).toBe("claude-opus-4-8");
    expect(entry.provider).toBe("claude");
    expect(entry.turns).toBe(2);
    expect(entry.inputTokens).toBe(6);
    expect(entry.cachedInputTokens).toBe((34584 + 100) * 3);
    expect(entry.outputTokens).toBe(2682 * 3);
    expect(entry.estCostUsd).toBeCloseTo(0.2, 10);
  });

  it("prices from the static table when costUSD is absent", () => {
    const entries = aggregateUsageModelBreakdown([
      row({
        payload: {
          modelUsage: {
            "claude-haiku-4-5": {
              inputTokens: 1_000_000,
              outputTokens: 1_000_000,
              cacheReadInputTokens: 1_000_000,
              cacheCreationInputTokens: 0,
            },
          },
        },
      }),
    ]);

    // 1M input @ $1 + 1M output @ $5 + 1M cache read @ $0.1
    expect(entries[0]?.estCostUsd).toBeCloseTo(6.1, 6);
  });

  it("contributes zero cost for unknown models without reported cost", () => {
    const entries = aggregateUsageModelBreakdown([
      row({
        payload: {
          modelUsage: { "mystery-model": { inputTokens: 500, outputTokens: 100 } },
        },
      }),
    ]);

    expect(entries[0]?.estCostUsd).toBe(0);
    expect(entries[0]?.inputTokens).toBe(500);
  });

  it("maps codex sessions to the codex provider and falls back to claude", () => {
    const entries = aggregateUsageModelBreakdown([
      row({
        providerName: "codex",
        payload: { modelUsage: { "gpt-5.5": { inputTokens: 1, outputTokens: 1 } } },
      }),
      row({ providerName: null, payload: opusUsage(0.01) }),
    ]);

    expect(entries.map((entry) => entry.provider).sort()).toEqual(["claude", "codex"]);
  });

  it("skips malformed payloads and counts turnless rows by activity id", () => {
    const entries = aggregateUsageModelBreakdown([
      { activityId: "bad", turnId: null, providerName: null, payloadJson: "not json" },
      row({ activityId: "a1", turnId: null, payload: opusUsage(0.01) }),
      row({ activityId: "a2", turnId: null, payload: opusUsage(0.01) }),
      row({ payload: { noModelUsage: true } }),
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.turns).toBe(2);
  });

  it("sorts entries by estimated cost descending", () => {
    const entries = aggregateUsageModelBreakdown([
      row({
        payload: { modelUsage: { "claude-haiku-4-5": { inputTokens: 1, costUSD: 0.01 } } },
      }),
      row({ payload: opusUsage(0.5) }),
    ]);

    expect(entries.map((entry) => entry.model)).toEqual(["claude-opus-4-8", "claude-haiku-4-5"]);
  });
});
