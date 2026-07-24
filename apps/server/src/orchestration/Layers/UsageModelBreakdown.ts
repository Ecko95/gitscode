/**
 * UsageModelBreakdown - pure aggregation of `usage.cost.updated` projection
 * activities into per-model token/cost totals for the usage panel.
 *
 * Data source: `projection_thread_activities` rows with kind
 * `usage.cost.updated`. Their payload carries a `modelUsage` record keyed by
 * model id ({inputTokens, outputTokens, cacheReadInputTokens,
 * cacheCreationInputTokens, costUSD?}). Today only the Claude adapter emits
 * these; Codex `turn.completed` carries no usage/cost, so codex turns do not
 * appear here.
 */
import type { UsageModelBreakdownEntry, UsageProvider } from "@t3tools/contracts";

/**
 * STATIC PRICE TABLE - USD per million tokens. Edit here to add models.
 *
 * Used only when a `modelUsage` entry has no provider-reported `costUSD`
 * (Claude reports its own costUSD, so this is a fallback). Models absent from
 * this table with no reported cost contribute 0 to `estCostUsd` - we never
 * invent numbers.
 *
 * cacheRead = 0.1x input; cacheWrite = 1.25x input (5-minute TTL writes).
 */
export const MODEL_PRICES_USD_PER_MTOK: Record<
  string,
  { input: number; output: number; cacheRead: number; cacheWrite: number }
> = {
  "claude-fable-5": { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-7": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-6": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  // ponytail: standard Sonnet 5 rates; introductory $2/$10 runs through
  // 2026-08-31, so this fallback reads ~50% high until then.
  "claude-sonnet-5": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

export type UsageCostActivityRow = {
  readonly activityId: string;
  readonly turnId: string | null;
  readonly providerName: string | null;
  readonly payloadJson: string;
};

function toCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
}

function providerFromSession(providerName: string | null): UsageProvider {
  return providerName === "codex" ? "codex" : "claude";
}

function fallbackCostUsd(
  model: string,
  usage: { input: number; cacheRead: number; cacheCreation: number; output: number },
): number {
  const prices = MODEL_PRICES_USD_PER_MTOK[model];
  if (!prices) return 0;
  return (
    (usage.input * prices.input +
      usage.cacheRead * prices.cacheRead +
      usage.cacheCreation * prices.cacheWrite +
      usage.output * prices.output) /
    1_000_000
  );
}

export function aggregateUsageModelBreakdown(
  rows: ReadonlyArray<UsageCostActivityRow>,
): Array<UsageModelBreakdownEntry> {
  const accumulators = new Map<
    string,
    {
      provider: UsageProvider;
      model: string;
      turnKeys: Set<string>;
      inputTokens: number;
      cachedInputTokens: number;
      outputTokens: number;
      estCostUsd: number;
    }
  >();

  for (const row of rows) {
    let payload: unknown;
    try {
      payload = JSON.parse(row.payloadJson);
    } catch {
      continue;
    }
    if (typeof payload !== "object" || payload === null) continue;
    const modelUsage = (payload as { modelUsage?: unknown }).modelUsage;
    if (typeof modelUsage !== "object" || modelUsage === null) continue;

    const provider = providerFromSession(row.providerName);
    for (const [model, rawUsage] of Object.entries(modelUsage)) {
      if (typeof rawUsage !== "object" || rawUsage === null || model.trim() === "") continue;
      const usage = rawUsage as Record<string, unknown>;
      const input = toCount(usage["inputTokens"]);
      const cacheRead = toCount(usage["cacheReadInputTokens"]);
      const cacheCreation = toCount(usage["cacheCreationInputTokens"]);
      const output = toCount(usage["outputTokens"]);
      const reportedCost = usage["costUSD"];
      const cost =
        typeof reportedCost === "number" && Number.isFinite(reportedCost) && reportedCost >= 0
          ? reportedCost
          : fallbackCostUsd(model, { input, cacheRead, cacheCreation, output });

      const key = `${provider}\u0000${model}`;
      let accumulator = accumulators.get(key);
      if (!accumulator) {
        accumulator = {
          provider,
          model,
          turnKeys: new Set<string>(),
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 0,
          estCostUsd: 0,
        };
        accumulators.set(key, accumulator);
      }
      accumulator.turnKeys.add(row.turnId ?? row.activityId);
      accumulator.inputTokens += input;
      accumulator.cachedInputTokens += cacheRead + cacheCreation;
      accumulator.outputTokens += output;
      accumulator.estCostUsd += cost;
    }
  }

  return [...accumulators.values()]
    .map((accumulator) => ({
      provider: accumulator.provider,
      model: accumulator.model,
      turns: accumulator.turnKeys.size,
      inputTokens: accumulator.inputTokens,
      cachedInputTokens: accumulator.cachedInputTokens,
      outputTokens: accumulator.outputTokens,
      estCostUsd: Math.round(accumulator.estCostUsd * 1_000_000) / 1_000_000,
    }))
    .sort((a, b) => b.estCostUsd - a.estCostUsd || b.turns - a.turns);
}
