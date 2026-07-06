import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

const PathString = TrimmedNonEmptyString.check(Schema.isMaxLength(4096));
const SummaryString = TrimmedNonEmptyString.check(Schema.isMaxLength(10_000));
const NonNegativeNumber = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0));

export const UsageProvider = Schema.Literals(["codex", "claude"]);
export type UsageProvider = typeof UsageProvider.Type;

export const UsageTokenTotals = Schema.Struct({
  inputTokens: NonNegativeInt,
  cachedInputTokens: NonNegativeInt,
  cacheCreationInputTokens: NonNegativeInt,
  cacheReadInputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  reasoningOutputTokens: NonNegativeInt,
  totalTokens: NonNegativeInt,
});
export type UsageTokenTotals = typeof UsageTokenTotals.Type;

export const UsageModelSummary = Schema.Struct({
  provider: UsageProvider,
  model: TrimmedNonEmptyString,
  requestCount: NonNegativeInt,
  tokens: UsageTokenTotals,
  estimatedCostUsd: NonNegativeNumber,
});
export type UsageModelSummary = typeof UsageModelSummary.Type;

export const UsageDaySummary = Schema.Struct({
  date: TrimmedNonEmptyString,
  requestCount: NonNegativeInt,
  tokens: UsageTokenTotals,
  estimatedCostUsd: NonNegativeNumber,
});
export type UsageDaySummary = typeof UsageDaySummary.Type;

export const UsageWindowSummary = Schema.Struct({
  provider: UsageProvider,
  label: TrimmedNonEmptyString,
  usedPercent: Schema.NullOr(NonNegativeNumber),
  remainingPercent: Schema.NullOr(NonNegativeNumber),
  windowMinutes: Schema.NullOr(NonNegativeInt),
  resetAt: Schema.NullOr(IsoDateTime),
  sourcePath: Schema.NullOr(PathString),
});
export type UsageWindowSummary = typeof UsageWindowSummary.Type;

export const UsageProviderSource = Schema.Struct({
  provider: UsageProvider,
  status: Schema.Literals(["available", "unavailable", "partial"]),
  homePath: PathString,
  scannedFilePaths: Schema.Array(PathString),
  note: Schema.NullOr(SummaryString),
});
export type UsageProviderSource = typeof UsageProviderSource.Type;

export const UsageSummary = Schema.Struct({
  checkedAt: IsoDateTime,
  currency: Schema.Literal("USD"),
  costEstimate: Schema.Boolean,
  totals: UsageTokenTotals,
  estimatedCostUsd: NonNegativeNumber,
  models: Schema.Array(UsageModelSummary),
  days: Schema.Array(UsageDaySummary),
  windows: Schema.Array(UsageWindowSummary),
  sources: Schema.Array(UsageProviderSource),
  notes: Schema.Array(SummaryString),
});
export type UsageSummary = typeof UsageSummary.Type;
