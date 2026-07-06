// @effect-diagnostics nodeBuiltinImport:off
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readdirSync,
  readSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type {
  UsageDaySummary,
  UsageModelSummary,
  UsageProvider,
  UsageProviderSource,
  UsageSummary,
  UsageTokenTotals,
  UsageWindowSummary,
} from "@t3tools/contracts";

const EMPTY_TOKENS: UsageTokenTotals = {
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  totalTokens: 0,
};

const MAX_FILES_PER_PROVIDER = 256;
const MAX_TAIL_BYTES = 8 * 1024 * 1024;
const DEFAULT_LOOKBACK_DAYS = 30;

type RateLimit = {
  readonly used_percent?: unknown;
  readonly window_minutes?: unknown;
  readonly reset_at?: unknown;
  readonly resets_at?: unknown;
};

type TokenEvent = {
  readonly provider: UsageProvider;
  readonly model: string;
  readonly timestamp: string;
  readonly requestKey: string;
  readonly tokens: UsageTokenTotals;
};

type MutableBucket = {
  provider?: UsageProvider;
  model?: string;
  requestCount: number;
  tokens: UsageTokenTotals;
  estimatedCostUsd: number;
};

function checkedAtIso() {
  // @effect-diagnostics-next-line globalDate:off
  return new Date().toISOString();
}

function dateMs(value: string): number | null {
  // @effect-diagnostics-next-line globalDate:off
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function dateKey(value: string): string {
  const ms = dateMs(value);
  if (ms === null) return "unknown";
  // @effect-diagnostics-next-line globalDate:off
  return new Date(ms).toISOString().slice(0, 10);
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return resolve(path);
}

function codexHome(): string {
  return expandHome(
    process.env.GITS_CODEX_USAGE_HOME?.trim() || process.env.CODEX_HOME?.trim() || "~/.codex",
  );
}

function claudeHome(): string {
  return expandHome(
    process.env.GITS_CLAUDE_USAGE_HOME?.trim() || process.env.CLAUDE_HOME?.trim() || "~/.claude",
  );
}

function numberField(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function percent(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(100, Math.max(0, value))
    : null;
}

function addTokens(left: UsageTokenTotals, right: UsageTokenTotals): UsageTokenTotals {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    cacheCreationInputTokens: left.cacheCreationInputTokens + right.cacheCreationInputTokens,
    cacheReadInputTokens: left.cacheReadInputTokens + right.cacheReadInputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningOutputTokens: left.reasoningOutputTokens + right.reasoningOutputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
  };
}

function tokenTotals(value: Record<string, unknown>): UsageTokenTotals {
  const inputTokens = numberField(value.input_tokens ?? value.inputTokens);
  const cachedInputTokens = numberField(value.cached_input_tokens ?? value.cachedInputTokens);
  const cacheCreationInputTokens = numberField(
    value.cache_creation_input_tokens ?? value.cacheCreationInputTokens,
  );
  const cacheReadInputTokens = numberField(
    value.cache_read_input_tokens ?? value.cacheReadInputTokens,
  );
  const outputTokens = numberField(value.output_tokens ?? value.outputTokens);
  const reasoningOutputTokens = numberField(
    value.reasoning_output_tokens ?? value.reasoningOutputTokens,
  );
  return {
    inputTokens,
    cachedInputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens:
      numberField(value.total_tokens ?? value.totalTokens) ||
      inputTokens +
        cachedInputTokens +
        cacheCreationInputTokens +
        cacheReadInputTokens +
        outputTokens +
        reasoningOutputTokens,
  };
}

function estimateCostUsd(provider: UsageProvider, model: string, tokens: UsageTokenTotals): number {
  const normalized = model.toLowerCase();
  const isMini = normalized.includes("mini") || normalized.includes("haiku");
  const isClaude = provider === "claude";
  // ponytail: local heuristic price table; exact vendor billing/rates are not exposed in JSONL.
  const inputPerMillion = isClaude ? (isMini ? 0.8 : 3) : isMini ? 0.25 : 5;
  const cachedPerMillion = isClaude ? (isMini ? 0.08 : 0.3) : isMini ? 0.025 : 0.5;
  const cacheCreatePerMillion = isClaude ? (isMini ? 1 : 3.75) : inputPerMillion;
  const outputPerMillion = isClaude ? (isMini ? 4 : 15) : isMini ? 2 : 15;
  const cost =
    (tokens.inputTokens / 1_000_000) * inputPerMillion +
    (tokens.cachedInputTokens / 1_000_000) * cachedPerMillion +
    (tokens.cacheReadInputTokens / 1_000_000) * cachedPerMillion +
    (tokens.cacheCreationInputTokens / 1_000_000) * cacheCreatePerMillion +
    ((tokens.outputTokens + tokens.reasoningOutputTokens) / 1_000_000) * outputPerMillion;
  return Math.round(cost * 10000) / 10000;
}

function safeReadDir(dir: string) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function recentJsonlFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  // @effect-diagnostics-next-line globalDate:off
  const since = Date.now() - DEFAULT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const dir = pending.pop();
    if (!dir) continue;
    for (const entry of safeReadDir(dir)) {
      const filePath = join(dir, entry.name);
      if (entry.isDirectory()) {
        pending.push(filePath);
        continue;
      }
      if (!entry.isFile() || !filePath.endsWith(".jsonl")) continue;
      try {
        if (statSync(filePath).mtimeMs >= since) files.push(filePath);
      } catch {
        // Ignore disappearing session logs.
      }
    }
  }
  return files
    .sort((left, right) => statSync(left).mtimeMs - statSync(right).mtimeMs)
    .slice(-MAX_FILES_PER_PROVIDER);
}

function readTail(file: string): string {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, MAX_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } catch {
    return "";
  } finally {
    closeSync(fd);
  }
}

function usageLabel(windowMinutes: number | null): string {
  if (windowMinutes === 300) return "5h";
  if (windowMinutes === 10080) return "weekly";
  if (windowMinutes !== null && windowMinutes % 60 === 0 && windowMinutes < 10080) {
    return `${windowMinutes / 60}h`;
  }
  if (windowMinutes !== null && windowMinutes % 1440 === 0) {
    return `${windowMinutes / 1440}d`;
  }
  return "usage";
}

function windowFromRateLimit(
  provider: UsageProvider,
  raw: RateLimit | null | undefined,
  sourcePath: string,
): UsageWindowSummary | null {
  const usedPercent = percent(raw?.used_percent);
  if (usedPercent === null) return null;
  const windowMinutesRaw = numberField(raw?.window_minutes);
  const windowMinutes = windowMinutesRaw > 0 ? windowMinutesRaw : null;
  const resetSeconds = numberField(raw?.reset_at ?? raw?.resets_at);
  return {
    provider,
    label: usageLabel(windowMinutes),
    usedPercent,
    remainingPercent: Math.max(0, 100 - usedPercent),
    windowMinutes,
    // @effect-diagnostics-next-line globalDate:off
    resetAt: resetSeconds > 0 ? new Date(resetSeconds * 1000).toISOString() : null,
    sourcePath,
  };
}

function parseCodexFile(filePath: string): {
  events: TokenEvent[];
  windows: UsageWindowSummary[];
} {
  const events: TokenEvent[] = [];
  const windows: UsageWindowSummary[] = [];
  let model = "codex-unknown";
  let eventIndex = 0;

  for (const line of readTail(filePath).split(/\r?\n/)) {
    if (!line.trim().startsWith("{")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const record = parsed as {
      readonly timestamp?: unknown;
      readonly type?: unknown;
      readonly payload?: Record<string, unknown>;
    };
    const payload = record.payload;
    if (typeof payload?.model === "string" && payload.model.trim().length > 0) {
      model = payload.model.trim();
    }
    if (payload?.type !== "token_count" || typeof record.timestamp !== "string") continue;
    const info = payload.info;
    if (typeof info !== "object" || info === null) continue;
    const usage = (info as Record<string, unknown>).last_token_usage;
    if (typeof usage !== "object" || usage === null || Array.isArray(usage)) continue;
    eventIndex += 1;
    events.push({
      provider: "codex",
      model,
      timestamp: record.timestamp,
      requestKey: `${filePath}:${eventIndex}`,
      tokens: tokenTotals(usage as Record<string, unknown>),
    });
    const rateLimits = payload.rate_limits;
    if (typeof rateLimits === "object" && rateLimits !== null) {
      const rateLimitRecord = rateLimits as {
        readonly primary?: RateLimit;
        readonly secondary?: RateLimit;
      };
      for (const window of [
        windowFromRateLimit("codex", rateLimitRecord.primary, filePath),
        windowFromRateLimit("codex", rateLimitRecord.secondary, filePath),
      ]) {
        if (window) windows.push(window);
      }
    }
  }

  return { events, windows };
}

function parseClaudeFile(filePath: string): TokenEvent[] {
  const events: TokenEvent[] = [];
  const seenRequests = new Set<string>();
  for (const line of readTail(filePath).split(/\r?\n/)) {
    if (!line.includes('"usage"') || !line.trim().startsWith("{")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const record = parsed as {
      readonly timestamp?: unknown;
      readonly requestId?: unknown;
      readonly uuid?: unknown;
      readonly message?: { readonly model?: unknown; readonly usage?: unknown };
    };
    if (typeof record.timestamp !== "string") continue;
    if (typeof record.message?.model !== "string" || record.message.model.trim().length === 0) {
      continue;
    }
    const usage = record.message.usage;
    if (typeof usage !== "object" || usage === null || Array.isArray(usage)) continue;
    const requestKey =
      typeof record.requestId === "string" && record.requestId.trim().length > 0
        ? record.requestId
        : typeof record.uuid === "string"
          ? record.uuid
          : `${filePath}:${events.length + 1}`;
    if (seenRequests.has(requestKey)) continue;
    seenRequests.add(requestKey);
    events.push({
      provider: "claude",
      model: record.message.model.trim(),
      timestamp: record.timestamp,
      requestKey,
      tokens: tokenTotals(usage as Record<string, unknown>),
    });
  }
  return events;
}

function addEvent(
  buckets: Map<string, MutableBucket>,
  key: string,
  event: TokenEvent,
  includeProviderAndModel: boolean,
) {
  const bucket = buckets.get(key) ?? {
    requestCount: 0,
    tokens: { ...EMPTY_TOKENS },
    estimatedCostUsd: 0,
  };
  bucket.requestCount += 1;
  bucket.tokens = addTokens(bucket.tokens, event.tokens);
  bucket.estimatedCostUsd += estimateCostUsd(event.provider, event.model, event.tokens);
  if (includeProviderAndModel) {
    bucket.provider = event.provider;
    bucket.model = event.model;
  }
  buckets.set(key, bucket);
}

function latestWindows(windows: UsageWindowSummary[]): UsageWindowSummary[] {
  const byKey = new Map<string, UsageWindowSummary>();
  for (const window of windows) {
    byKey.set(`${window.provider}:${window.label}`, window);
  }
  return [...byKey.values()].sort(
    (left, right) => (left.windowMinutes ?? 0) - (right.windowMinutes ?? 0),
  );
}

function makeSource(
  provider: UsageProvider,
  homePath: string,
  scannedFilePaths: string[],
  parsedCount: number,
  note: string | null,
): UsageProviderSource {
  return {
    provider,
    status:
      scannedFilePaths.length === 0 ? "unavailable" : parsedCount > 0 ? "available" : "partial",
    homePath,
    scannedFilePaths,
    note,
  };
}

export function readUsageSummary(): UsageSummary {
  const checkedAt = checkedAtIso();
  const codexRoot = join(codexHome(), "sessions");
  const claudeRoot = join(claudeHome(), "projects");
  const codexFiles = recentJsonlFiles(codexRoot);
  const claudeFiles = recentJsonlFiles(claudeRoot);
  const events: TokenEvent[] = [];
  const windows: UsageWindowSummary[] = [];
  const seenEventKeys = new Set<string>();

  const pushEvent = (event: TokenEvent) => {
    const key = `${event.provider}:${event.requestKey}`;
    if (seenEventKeys.has(key)) return;
    seenEventKeys.add(key);
    events.push(event);
  };

  for (const file of codexFiles) {
    const parsed = parseCodexFile(file);
    for (const event of parsed.events) {
      pushEvent(event);
    }
    windows.push(...parsed.windows);
  }
  for (const file of claudeFiles) {
    for (const event of parseClaudeFile(file)) {
      pushEvent(event);
    }
  }

  const modelBuckets = new Map<string, MutableBucket>();
  const dayBuckets = new Map<string, MutableBucket>();
  let totals = { ...EMPTY_TOKENS };
  let estimatedCostUsd = 0;
  for (const event of events) {
    totals = addTokens(totals, event.tokens);
    estimatedCostUsd += estimateCostUsd(event.provider, event.model, event.tokens);
    addEvent(modelBuckets, `${event.provider}:${event.model}`, event, true);
    addEvent(dayBuckets, dateKey(event.timestamp), event, false);
  }

  const models: UsageModelSummary[] = [...modelBuckets.values()]
    .map((bucket) => ({
      provider: bucket.provider ?? "codex",
      model: bucket.model ?? "unknown",
      requestCount: bucket.requestCount,
      tokens: bucket.tokens,
      estimatedCostUsd: Math.round(bucket.estimatedCostUsd * 10000) / 10000,
    }))
    .sort(
      (left, right) =>
        right.estimatedCostUsd - left.estimatedCostUsd || left.model.localeCompare(right.model),
    );

  const days: UsageDaySummary[] = [...dayBuckets.entries()]
    .map(([date, bucket]) => ({
      date,
      requestCount: bucket.requestCount,
      tokens: bucket.tokens,
      estimatedCostUsd: Math.round(bucket.estimatedCostUsd * 10000) / 10000,
    }))
    .sort((left, right) => right.date.localeCompare(left.date));

  return {
    checkedAt,
    currency: "USD",
    costEstimate: true,
    totals,
    estimatedCostUsd: Math.round(estimatedCostUsd * 10000) / 10000,
    models,
    days,
    windows: latestWindows(windows),
    sources: [
      makeSource(
        "codex",
        codexHome(),
        codexFiles,
        events.filter((event) => event.provider === "codex").length,
        "Confirmed Codex format: sessions/**/*.jsonl event_msg payload.type=token_count with last_token_usage and rate_limits.",
      ),
      makeSource(
        "claude",
        claudeHome(),
        claudeFiles,
        events.filter((event) => event.provider === "claude").length,
        "Confirmed Claude format: projects/**/*.jsonl assistant message.usage with requestId dedupe.",
      ),
    ],
    notes: [
      "USD values are local estimates; provider billing exports are not present in the JSONL records.",
      "Scans recent JSONL files only for cockpit latency.",
      "TODO: Cursor/OpenCode usage logs are not parsed until their local JSONL location and format are confirmed.",
    ],
  };
}
