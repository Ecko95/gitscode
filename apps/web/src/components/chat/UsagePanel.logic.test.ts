import type { UsageModelBreakdownEntry } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  buildCostSegments,
  formatTokens,
  formatUsd,
  totalCostUsd,
  totalTokens,
} from "./UsagePanel.logic";

function entry(overrides: Partial<UsageModelBreakdownEntry>): UsageModelBreakdownEntry {
  return {
    provider: "claude",
    model: "claude-opus-4-8",
    turns: 1,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    estCostUsd: 0,
    ...overrides,
  };
}

describe("formatTokens", () => {
  it("formats magnitudes compactly", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(12_345)).toBe("12.3K");
    expect(formatTokens(1_234_567)).toBe("1.23M");
    expect(formatTokens(250_000_000)).toBe("250M");
  });
});

describe("formatUsd", () => {
  it("formats amounts with a sub-cent floor", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(0.001)).toBe("<$0.01");
    expect(formatUsd(0.084352)).toBe("$0.08");
    expect(formatUsd(12.5)).toBe("$12.50");
  });
});

describe("buildCostSegments", () => {
  it("weights by cost when any entry has cost", () => {
    const segments = buildCostSegments([
      entry({ model: "a", estCostUsd: 3 }),
      entry({ model: "b", estCostUsd: 1 }),
      entry({ model: "c", estCostUsd: 0, inputTokens: 999 }),
    ]);
    expect(segments.map((s) => s.model)).toEqual(["a", "b"]);
    expect(segments[0]?.widthPercent).toBeCloseTo(75);
    expect(segments[1]?.widthPercent).toBeCloseTo(25);
  });

  it("falls back to token volume when no entry has cost", () => {
    const segments = buildCostSegments([
      entry({ model: "a", inputTokens: 100, outputTokens: 100 }),
      entry({ model: "b", cachedInputTokens: 600 }),
    ]);
    expect(segments[0]?.widthPercent).toBeCloseTo(25);
    expect(segments[1]?.widthPercent).toBeCloseTo(75);
  });

  it("returns nothing for empty or zero-weight input", () => {
    expect(buildCostSegments([])).toEqual([]);
    expect(buildCostSegments([entry({})])).toEqual([]);
  });

  it("clamps color indices to the palette size", () => {
    const segments = buildCostSegments(
      Array.from({ length: 7 }, (_, index) => entry({ model: `m${index}`, estCostUsd: 1 })),
    );
    expect(segments[6]?.colorIndex).toBe(4);
  });
});

describe("totals", () => {
  it("sums cost and tokens", () => {
    const entries = [
      entry({ estCostUsd: 0.1, inputTokens: 1, cachedInputTokens: 2, outputTokens: 3 }),
      entry({ estCostUsd: 0.2 }),
    ];
    expect(totalCostUsd(entries)).toBeCloseTo(0.3);
    expect(totalTokens(entries[0]!)).toBe(6);
  });
});
