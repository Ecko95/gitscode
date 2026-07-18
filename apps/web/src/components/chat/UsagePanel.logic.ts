import type { UsageModelBreakdownEntry } from "@t3tools/contracts";

/** Compact token counts: 950, 12.3K, 1.23M. */
export function formatTokens(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return "0";
  if (count < 1_000) return String(Math.round(count));
  if (count < 1_000_000) return `${trimNumber(count / 1_000)}K`;
  return `${trimNumber(count / 1_000_000)}M`;
}

function trimNumber(value: number): string {
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return value.toFixed(digits).replace(/\.0+$/, "");
}

/** Compact USD amounts; sub-cent amounts render as "<$0.01". */
export function formatUsd(amount: number): string {
  if (!Number.isFinite(amount) || amount <= 0) return "$0.00";
  if (amount < 0.005) return "<$0.01";
  return `$${amount.toFixed(2)}`;
}

export function totalTokens(entry: UsageModelBreakdownEntry): number {
  return entry.inputTokens + entry.cachedInputTokens + entry.outputTokens;
}

export type UsageCostSegment = {
  readonly model: string;
  readonly provider: UsageModelBreakdownEntry["provider"];
  readonly widthPercent: number;
  readonly colorIndex: number;
};

/**
 * Distribution segments for the stacked bar. Weighted by estimated cost;
 * falls back to token volume when no entry has a cost (so a cost-less
 * provider still gets a meaningful distribution).
 */
export function buildCostSegments(
  entries: ReadonlyArray<UsageModelBreakdownEntry>,
): Array<UsageCostSegment> {
  const useCost = entries.some((entry) => entry.estCostUsd > 0);
  const weights = entries.map((entry) => (useCost ? entry.estCostUsd : totalTokens(entry)));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (total <= 0) return [];
  return entries
    .map((entry, index) => ({
      model: entry.model,
      provider: entry.provider,
      widthPercent: ((weights[index] ?? 0) / total) * 100,
      colorIndex: Math.min(index, 4),
    }))
    .filter((segment) => segment.widthPercent > 0);
}

export function totalCostUsd(entries: ReadonlyArray<UsageModelBreakdownEntry>): number {
  return entries.reduce((sum, entry) => sum + entry.estCostUsd, 0);
}
