import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

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

export const UsageWindowKey = Schema.Literals(["fiveHour", "weekly"]);
export type UsageWindowKey = typeof UsageWindowKey.Type;

export const UsageModelBreakdownInput = Schema.Struct({ window: UsageWindowKey });
export type UsageModelBreakdownInput = typeof UsageModelBreakdownInput.Type;

export const UsageModelBreakdownEntry = Schema.Struct({
  provider: UsageProvider,
  model: TrimmedNonEmptyString,
  turns: NonNegativeInt,
  inputTokens: NonNegativeInt,
  cachedInputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  estCostUsd: NonNegativeNumber,
});
export type UsageModelBreakdownEntry = typeof UsageModelBreakdownEntry.Type;

export const UsageModelBreakdown = Schema.Struct({
  window: UsageWindowKey,
  since: IsoDateTime,
  checkedAt: IsoDateTime,
  entries: Schema.Array(UsageModelBreakdownEntry),
});
export type UsageModelBreakdown = typeof UsageModelBreakdown.Type;

export const CodexAccountUsageInput = Schema.Struct({ threadId: ThreadId });
export type CodexAccountUsageInput = typeof CodexAccountUsageInput.Type;

export const CodexAccountUsageWindow = Schema.Struct({
  usedPercent: NonNegativeNumber,
  windowMinutes: Schema.NullOr(NonNegativeInt),
  resetAt: Schema.NullOr(IsoDateTime),
});
export type CodexAccountUsageWindow = typeof CodexAccountUsageWindow.Type;

export const CodexResetCredit = Schema.Struct({
  id: TrimmedNonEmptyString,
  title: Schema.NullOr(TrimmedNonEmptyString),
  description: Schema.NullOr(TrimmedNonEmptyString),
  grantedAt: IsoDateTime,
  expiresAt: Schema.NullOr(IsoDateTime),
  status: Schema.Literals(["available", "redeeming", "redeemed", "unknown"]),
});
export type CodexResetCredit = typeof CodexResetCredit.Type;

export const CodexAccountUsage = Schema.Struct({
  checkedAt: IsoDateTime,
  planType: Schema.NullOr(TrimmedNonEmptyString),
  primary: Schema.NullOr(CodexAccountUsageWindow),
  secondary: Schema.NullOr(CodexAccountUsageWindow),
  availableResetCount: NonNegativeInt,
  resetCredits: Schema.Array(CodexResetCredit),
});
export type CodexAccountUsage = typeof CodexAccountUsage.Type;

export const CodexResetCreditConsumeInput = Schema.Struct({
  threadId: ThreadId,
  creditId: TrimmedNonEmptyString,
});
export type CodexResetCreditConsumeInput = typeof CodexResetCreditConsumeInput.Type;

export const CodexResetCreditConsumeResult = Schema.Struct({
  outcome: Schema.Literals(["reset", "nothingToReset", "noCredit", "alreadyRedeemed"]),
});
export type CodexResetCreditConsumeResult = typeof CodexResetCreditConsumeResult.Type;
