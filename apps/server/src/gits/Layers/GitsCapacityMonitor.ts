// @effect-diagnostics nodeBuiltinImport:off
import { execFile } from "node:child_process";
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  GitsCapacityError,
  type DelamainEngine,
  type GitsCapacityRecommendation,
  type GitsCapacitySnapshot,
  type GitsProviderUsage,
  type GitsUsageLevel,
  type GitsUsageSource,
  type GitsUsageWindow,
} from "@t3tools/contracts";

import {
  GitsCapacityMonitor,
  type GitsCapacityMonitorShape,
} from "../Services/GitsCapacityMonitor.ts";

const DEFAULT_TAIL_BYTES = 12 * 1024 * 1024;
const DEFAULT_CURSOR_MONTHLY_BUDGET_USD = 500;
const CURSOR_COMMAND_TIMEOUT_MS = 5_000;

interface RawRateLimit {
  readonly used_percent?: unknown;
  readonly window_minutes?: unknown;
  readonly reset_at?: unknown;
  readonly resets_at?: unknown;
}

interface RawRateLimits {
  readonly primary?: RawRateLimit | null;
  readonly secondary?: RawRateLimit | null;
  readonly plan_type?: unknown;
}

interface RawRateLimitsEvent {
  readonly type?: unknown;
  readonly plan_type?: unknown;
  readonly rate_limits?: RawRateLimits | null;
}

interface CodexUsage {
  readonly planType: string | null;
  readonly limits: ReadonlyArray<GitsUsageWindow>;
  readonly source: GitsUsageSource;
  readonly sourcePath: string | null;
}

interface CursorBudgetTelemetry {
  readonly budgetUsd: number;
  readonly spendUsd: number | null;
  readonly resetAt: string | null;
  readonly source: GitsUsageSource;
  readonly note: string | null;
  readonly accountLabel?: string | null;
}

interface CursorCliSnapshot {
  readonly available: boolean;
  readonly accountLabel: string | null;
  readonly planLabel: string | null;
  readonly note: string | null;
}

interface CursorDashboardSecret {
  readonly token: string;
  readonly teamId: number | null;
}

interface CursorDashboardUser {
  readonly sub?: unknown;
  readonly email?: unknown;
}

interface CursorDashboardUsage {
  readonly startOfMonth?: unknown;
  readonly "gpt-4"?: {
    readonly maxRequestUsage?: unknown;
    readonly numRequests?: unknown;
  };
}

interface CursorDashboardTeamList {
  readonly teams?: ReadonlyArray<{ readonly id?: unknown }>;
}

interface CursorDashboardTeam {
  readonly userId?: unknown;
}

interface CursorDashboardTeamSpend {
  readonly teamMemberSpend?: ReadonlyArray<{
    readonly userId?: unknown;
    readonly spendCents?: unknown;
    readonly hardLimitOverrideDollars?: unknown;
    readonly fastPremiumRequests?: unknown;
  }>;
}

function toCapacityError(message: string, cause?: unknown) {
  return new GitsCapacityError({
    message,
    ...(cause === undefined ? {} : { cause }),
  });
}

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

export function usageLevelFromRemaining(remainingPercent: number | null): GitsUsageLevel {
  if (remainingPercent === null) {
    return "unknown";
  }
  if (remainingPercent < 20) {
    return "critical";
  }
  if (remainingPercent < 40) {
    return "red";
  }
  if (remainingPercent < 75) {
    return "yellow";
  }
  return "green";
}

function codexHome(): string {
  return (
    process.env.GITS_CODEX_USAGE_HOME?.trim() || process.env.CODEX_HOME || join(homedir(), ".codex")
  );
}

function cursorAgentBin(): string {
  return (
    process.env.GITS_CURSOR_AGENT_BIN?.trim() ||
    process.env.CURSOR_AGENT_BIN?.trim() ||
    "cursor-agent"
  );
}

function defaultCursorSecretPath(): string {
  return join(homedir(), ".gits", "secrets", "cursor-dashboard.json");
}

function nonNegativeNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return value;
}

function numeric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function positiveInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return null;
  }
  return value;
}

function envNumber(...names: ReadonlyArray<string>): number | null {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (!value) {
      continue;
    }
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return null;
}

function clampPercent(value: number): number {
  return Math.round(Math.min(100, Math.max(0, value)));
}

function usageLabel(windowMinutes: number | null): string {
  if (windowMinutes === 300) {
    return "5h";
  }
  if (windowMinutes === 10080) {
    return "weekly";
  }
  if (windowMinutes !== null && windowMinutes % 60 === 0 && windowMinutes < 10080) {
    return `${windowMinutes / 60}h`;
  }
  if (windowMinutes !== null && windowMinutes % 1440 === 0) {
    return `${windowMinutes / 1440}d`;
  }
  return "usage";
}

function usageLimitFromRaw(
  raw: RawRateLimit | null | undefined,
  source: GitsUsageSource,
): GitsUsageWindow | null {
  const usedPercentRaw = numeric(raw?.used_percent);
  if (usedPercentRaw === null) {
    return null;
  }
  const usedPercent = clampPercent(usedPercentRaw);
  const remainingPercent = clampPercent(100 - usedPercent);
  const windowMinutes = numeric(raw?.window_minutes);
  const resetAtSeconds = numeric(raw?.reset_at) ?? numeric(raw?.resets_at);

  return {
    label: usageLabel(windowMinutes),
    usedPercent,
    remainingPercent,
    windowMinutes: windowMinutes === null ? null : Math.max(0, Math.floor(windowMinutes)),
    // @effect-diagnostics-next-line globalDate:off
    resetAt: resetAtSeconds === null ? null : new Date(resetAtSeconds * 1000).toISOString(),
    level: usageLevelFromRemaining(remainingPercent),
    source,
    note: null,
  };
}

function usageFromRateLimits(
  rateLimits: RawRateLimits,
  source: GitsUsageSource,
  sourcePath: string | null,
  planType?: string | null,
): CodexUsage | null {
  const limits = [rateLimits.primary, rateLimits.secondary]
    .map((limit) => usageLimitFromRaw(limit, source))
    .filter((limit): limit is GitsUsageWindow => limit !== null)
    .sort((left, right) => (left.windowMinutes ?? 0) - (right.windowMinutes ?? 0));

  if (limits.length === 0) {
    return null;
  }

  return {
    planType:
      planType ??
      (typeof rateLimits.plan_type === "string" && rateLimits.plan_type.trim().length > 0
        ? rateLimits.plan_type.trim()
        : null),
    limits,
    source,
    sourcePath,
  };
}

function usageFromRateLimitEvent(
  event: RawRateLimitsEvent,
  source: GitsUsageSource,
  sourcePath: string | null,
): CodexUsage | null {
  if (event.type !== "codex.rate_limits" || !event.rate_limits) {
    return null;
  }
  return usageFromRateLimits(
    event.rate_limits,
    source,
    sourcePath,
    typeof event.plan_type === "string" ? event.plan_type : null,
  );
}

function safeReadDir(dir: string) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function recentSessionFiles(root: string, limit: number): string[] {
  if (!existsSync(root)) {
    return [];
  }
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const dir = pending.pop();
    if (!dir) {
      continue;
    }
    for (const entry of safeReadDir(dir)) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
      } else if (entry.isFile() && path.endsWith(".jsonl")) {
        files.push(path);
      }
    }
  }
  return files
    .sort((left, right) => statSync(left).mtimeMs - statSync(right).mtimeMs)
    .slice(-limit);
}

function readTail(file: string, maxBytes: number): string {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } catch {
    return "";
  } finally {
    closeSync(fd);
  }
}

function extractJsonObject(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }
  return null;
}

function extractRateLimitEvents(text: string): RawRateLimitsEvent[] {
  const events: RawRateLimitsEvent[] = [];
  const marker = '{"type":"codex.rate_limits"';
  let offset = 0;
  while (offset < text.length) {
    const start = text.indexOf(marker, offset);
    if (start === -1) {
      break;
    }
    const jsonText = extractJsonObject(text, start);
    offset = start + marker.length;
    if (!jsonText) {
      continue;
    }
    offset = start + jsonText.length;
    try {
      const parsed = JSON.parse(jsonText) as RawRateLimitsEvent;
      if (parsed.type === "codex.rate_limits") {
        events.push(parsed);
      }
    } catch {
      // Ignore partial log fragments.
    }
  }
  return events;
}

export function readCodexUsageFromHome(
  home: string,
  maxBytes = DEFAULT_TAIL_BYTES,
): CodexUsage | null {
  let latest: CodexUsage | null = null;
  for (const file of recentSessionFiles(join(home, "sessions"), 16)) {
    const text = readTail(file, Math.min(maxBytes, 1024 * 1024));
    for (const line of text.split(/\r?\n/)) {
      if (!line.includes('"rate_limits"')) {
        continue;
      }
      try {
        const parsed = JSON.parse(line) as {
          readonly payload?: { readonly rate_limits?: RawRateLimits };
        };
        if (parsed.payload?.rate_limits) {
          latest =
            usageFromRateLimits(parsed.payload.rate_limits, "codex-session-jsonl", file) ?? latest;
        }
      } catch {
        // Tail chunks can begin mid-line; ignore partial JSONL records.
      }
    }
  }
  if (latest) {
    return latest;
  }

  const files = [
    join(home, "log", "codex-tui.log"),
    join(home, "logs_2.sqlite"),
    join(home, "logs_2.sqlite-wal"),
  ]
    .filter((file) => existsSync(file))
    .sort((left, right) => statSync(left).mtimeMs - statSync(right).mtimeMs);

  for (const file of files) {
    const text = readTail(file, maxBytes);
    for (const event of extractRateLimitEvents(text)) {
      latest = usageFromRateLimitEvent(event, "codex-log", file) ?? latest;
    }
  }

  return latest;
}

function unavailableCodexUsage(checkedAt: string): GitsProviderUsage {
  return {
    provider: "codex",
    displayName: "Codex",
    status: "unavailable",
    source: "unavailable",
    accountLabel: null,
    planLabel: null,
    windows: [],
    monthlyBudgetUsd: null,
    monthlySpendUsd: null,
    monthlyUtilizationPercent: null,
    monthlyRemainingUsd: null,
    monthlyResetAt: null,
    note: "No local Codex rate-limit telemetry found. Start or resume a Codex session to emit 5h and weekly rate_limits.",
    updatedAt: checkedAt,
  };
}

function readCodexProviderUsage(checkedAt: string): GitsProviderUsage {
  const usage = readCodexUsageFromHome(codexHome());
  if (!usage) {
    return unavailableCodexUsage(checkedAt);
  }

  return {
    provider: "codex",
    displayName: "Codex",
    status: "available",
    source: usage.source,
    accountLabel: null,
    planLabel: usage.planType,
    windows: [...usage.limits],
    monthlyBudgetUsd: null,
    monthlySpendUsd: null,
    monthlyUtilizationPercent: null,
    monthlyRemainingUsd: null,
    monthlyResetAt: null,
    note: usage.sourcePath ? `Read from ${usage.sourcePath}.` : null,
    updatedAt: checkedAt,
  };
}

function parseCursorJsonNumber(
  value: Record<string, unknown>,
  keys: ReadonlyArray<string>,
): number | null {
  for (const key of keys) {
    const direct = nonNegativeNumber(value[key]);
    if (direct !== null) {
      return direct;
    }
  }
  return null;
}

function parseCursorJsonString(
  value: Record<string, unknown>,
  keys: ReadonlyArray<string>,
): string | null {
  for (const key of keys) {
    const direct = value[key];
    if (typeof direct === "string" && direct.trim().length > 0) {
      return direct.trim();
    }
  }
  return null;
}

function readCursorDashboardSecret(): CursorDashboardSecret | null {
  const envToken =
    process.env.GITS_CURSOR_WORKOS_TOKEN?.trim() ||
    process.env.GITS_CURSOR_DASHBOARD_TOKEN?.trim() ||
    process.env.WORKOS_CURSOR_SESSION_TOKEN?.trim();
  const envTeamId = envNumber("GITS_CURSOR_TEAM_ID", "CURSOR_TEAM_ID");
  if (envToken) {
    return {
      token: envToken,
      teamId: envTeamId === null ? null : Math.floor(envTeamId),
    };
  }

  const path = process.env.GITS_CURSOR_DASHBOARD_SECRET_FILE?.trim() || defaultCursorSecretPath();
  if (!existsSync(path)) {
    return null;
  }

  try {
    const raw = readFileSync(path, "utf8").trim();
    if (raw.length === 0) {
      return null;
    }
    if (!raw.startsWith("{")) {
      return {
        token: raw,
        teamId: envTeamId === null ? null : Math.floor(envTeamId),
      };
    }

    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    const token =
      parseCursorJsonString(record, [
        "workosCursorSessionToken",
        "WorkosCursorSessionToken",
        "token",
        "cookie",
      ]) ?? null;
    if (!token) {
      return null;
    }
    const fileTeamId =
      positiveInteger(record.teamId) ??
      positiveInteger(record.team_id) ??
      positiveInteger(Number(record.teamId));
    return {
      token,
      teamId: envTeamId === null ? fileTeamId : Math.floor(envTeamId),
    };
  } catch {
    return null;
  }
}

function readCursorUsageFile(): Partial<CursorBudgetTelemetry> | null {
  const path = process.env.GITS_CURSOR_USAGE_FILE?.trim();
  if (!path) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    const budgetUsd = parseCursorJsonNumber(record, [
      "monthlyBudgetUsd",
      "monthly_budget_usd",
      "budgetUsd",
      "budget_usd",
    ]);
    const spendUsd = parseCursorJsonNumber(record, [
      "monthlySpendUsd",
      "monthly_spend_usd",
      "spendUsd",
      "spend_usd",
      "usedUsd",
      "used_usd",
    ]);
    const resetAt = parseCursorJsonString(record, [
      "monthlyResetAt",
      "monthly_reset_at",
      "resetAt",
      "reset_at",
    ]);
    return {
      ...(budgetUsd === null ? {} : { budgetUsd }),
      ...(spendUsd === null ? {} : { spendUsd }),
      ...(resetAt === null ? {} : { resetAt }),
      source: "manual-config",
      note: `Read Cursor usage from ${path}.`,
    };
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function cursorDashboardUrl(path: string): string {
  return `https://cursor.com/api/${path}`;
}

async function cursorDashboardFetch<T>(
  secret: CursorDashboardSecret,
  path: string,
  input?: { readonly method?: "GET" | "POST"; readonly body?: Record<string, unknown> },
): Promise<T> {
  const method = input?.method ?? "GET";
  // @effect-diagnostics-next-line globalFetch:off
  const response = await fetch(cursorDashboardUrl(path), {
    method,
    headers: {
      "Content-Type": "application/json",
      Cookie: `WorkosCursorSessionToken=${secret.token}`,
      Origin: "https://cursor.com",
    },
    ...(method === "POST" ? { body: JSON.stringify(input?.body ?? {}) } : {}),
  });
  if (!response.ok) {
    throw new Error(`Cursor dashboard API returned HTTP ${response.status} for ${path}.`);
  }
  return (await response.json()) as T;
}

function addOneMonthIso(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  // @effect-diagnostics-next-line globalDate:off
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  // @effect-diagnostics-next-line globalDate:off
  const reset = new Date(date);
  reset.setMonth(reset.getMonth() + 1);
  return reset.toISOString();
}

function parseCursorTeamId(value: unknown): number | null {
  const direct = positiveInteger(value);
  if (direct !== null) {
    return direct;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

async function resolveCursorTeamId(secret: CursorDashboardSecret): Promise<number | null> {
  if (secret.teamId !== null) {
    return secret.teamId;
  }
  const teams = await cursorDashboardFetch<CursorDashboardTeamList>(secret, "dashboard/teams", {
    method: "POST",
    body: {},
  });
  const firstTeam = teams.teams?.[0];
  return parseCursorTeamId(firstTeam?.id);
}

export async function readCursorDashboardTelemetry(): Promise<Partial<CursorBudgetTelemetry> | null> {
  const secret = readCursorDashboardSecret();
  if (!secret) {
    return null;
  }

  try {
    const user = await cursorDashboardFetch<CursorDashboardUser>(secret, "auth/me");
    const userSub = typeof user.sub === "string" ? user.sub : null;
    const email = typeof user.email === "string" ? user.email : null;
    const individualUsage =
      userSub === null
        ? null
        : await cursorDashboardFetch<CursorDashboardUsage>(
            secret,
            `usage?user=${encodeURIComponent(userSub)}`,
          ).catch(() => null);
    const resetAt = addOneMonthIso(individualUsage?.startOfMonth);
    const teamId = await resolveCursorTeamId(secret).catch(() => null);
    if (teamId === null) {
      return {
        source: "cursor-dashboard-cookie",
        resetAt,
        accountLabel: email,
        note: "Cursor dashboard cookie worked, but no team spend endpoint was available for this account.",
      };
    }

    const team = await cursorDashboardFetch<CursorDashboardTeam>(secret, "dashboard/team", {
      method: "POST",
      body: { teamId },
    });
    const teamUserId = team.userId;
    const spend = await cursorDashboardFetch<CursorDashboardTeamSpend>(
      secret,
      "dashboard/get-team-spend",
      {
        method: "POST",
        body: { teamId },
      },
    );
    const member =
      spend.teamMemberSpend?.find((entry) => entry.userId === teamUserId) ??
      spend.teamMemberSpend?.find((entry) => entry.userId === userSub) ??
      null;
    const memberRecord = asRecord(member);
    const spendCents = memberRecord ? parseCursorJsonNumber(memberRecord, ["spendCents"]) : null;
    const hardLimitUsd = memberRecord
      ? parseCursorJsonNumber(memberRecord, ["hardLimitOverrideDollars"])
      : null;
    return {
      budgetUsd: hardLimitUsd ?? DEFAULT_CURSOR_MONTHLY_BUDGET_USD,
      spendUsd: spendCents === null ? null : spendCents / 100,
      resetAt,
      source: "cursor-dashboard-cookie",
      accountLabel: email,
      note:
        spendCents === null
          ? "Cursor dashboard auth succeeded, but team spend did not include spendCents for this user."
          : "Cursor spend read from cursor.com dashboard usage with local session cookie.",
    };
  } catch {
    return null;
  }
}

function readCursorBudgetTelemetry(): CursorBudgetTelemetry {
  const fileTelemetry = readCursorUsageFile();
  const budgetUsd =
    envNumber("GITS_CURSOR_MONTHLY_BUDGET_USD", "CURSOR_MONTHLY_BUDGET_USD") ??
    fileTelemetry?.budgetUsd ??
    DEFAULT_CURSOR_MONTHLY_BUDGET_USD;
  const spendUsd =
    envNumber("GITS_CURSOR_MONTHLY_SPEND_USD", "CURSOR_MONTHLY_SPEND_USD") ??
    fileTelemetry?.spendUsd ??
    null;
  const resetAt =
    process.env.GITS_CURSOR_MONTHLY_RESET_AT?.trim() || fileTelemetry?.resetAt || null;
  const source: GitsUsageSource =
    spendUsd !== null ? "manual-config" : (fileTelemetry?.source ?? "cursor-budget-config");

  return {
    budgetUsd,
    spendUsd,
    resetAt,
    source,
    note:
      spendUsd === null
        ? "Cursor CLI does not expose billing in the local status output. Set GITS_CURSOR_MONTHLY_SPEND_USD or GITS_CURSOR_USAGE_FILE to track spend against the configured monthly cap."
        : (fileTelemetry?.note ?? "Cursor monthly spend supplied by local configuration."),
  };
}

function execCursor(args: ReadonlyArray<string>) {
  return new Promise<{
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
  }>((resolve) => {
    execFile(
      cursorAgentBin(),
      [...args],
      {
        encoding: "utf8",
        timeout: CURSOR_COMMAND_TIMEOUT_MS,
      },
      (error, stdout, stderr) => {
        const exitCode =
          !error || typeof (error as { readonly code?: unknown }).code !== "number"
            ? error
              ? 1
              : 0
            : (error as { readonly code: number }).code;
        resolve({
          exitCode,
          stdout: stdout.slice(0, 20_000),
          stderr: stderr.slice(0, 20_000),
        });
      },
    );
  });
}

function parseCursorAbout(stdout: string): Pick<CursorCliSnapshot, "accountLabel" | "planLabel"> {
  const accountLabel = stdout.match(/^\s*User Email\s+(.+)$/m)?.[1]?.trim() ?? null;
  const planLabel = stdout.match(/^\s*Subscription Tier\s+(.+)$/m)?.[1]?.trim() ?? null;
  return {
    accountLabel: nonEmpty(accountLabel),
    planLabel: nonEmpty(planLabel),
  };
}

async function readCursorCliSnapshot(): Promise<CursorCliSnapshot> {
  const [status, about] = await Promise.all([execCursor(["status"]), execCursor(["about"])]);
  const parsed = parseCursorAbout(about.stdout);
  const loggedIn = status.exitCode === 0 || about.exitCode === 0;
  return {
    available: loggedIn,
    accountLabel: parsed.accountLabel,
    planLabel: parsed.planLabel,
    note: loggedIn
      ? null
      : (nonEmpty(status.stderr) ??
        nonEmpty(about.stderr) ??
        "Cursor Agent is not authenticated or unavailable."),
  };
}

function readCursorProviderUsage(checkedAt: string) {
  return Effect.promise(async (): Promise<GitsProviderUsage> => {
    const [cli, dashboardTelemetry] = await Promise.all([
      readCursorCliSnapshot(),
      readCursorDashboardTelemetry(),
    ]);
    const configuredBudget = readCursorBudgetTelemetry();
    const budget: CursorBudgetTelemetry = {
      budgetUsd: dashboardTelemetry?.budgetUsd ?? configuredBudget.budgetUsd,
      spendUsd: dashboardTelemetry?.spendUsd ?? configuredBudget.spendUsd,
      resetAt: dashboardTelemetry?.resetAt ?? configuredBudget.resetAt,
      source: dashboardTelemetry?.source ?? configuredBudget.source,
      note: dashboardTelemetry?.note ?? configuredBudget.note,
      accountLabel: dashboardTelemetry?.accountLabel ?? null,
    };
    const utilizationPercent =
      budget.spendUsd === null || budget.budgetUsd <= 0
        ? null
        : clampPercent((budget.spendUsd / budget.budgetUsd) * 100);
    const remainingPercent =
      utilizationPercent === null ? null : clampPercent(100 - utilizationPercent);
    const monthlyRemainingUsd =
      budget.spendUsd === null ? null : Math.max(0, budget.budgetUsd - budget.spendUsd);

    return {
      provider: "cursor",
      displayName: "Cursor",
      status: cli.available ? "available" : "configured",
      source: budget.source,
      accountLabel: budget.accountLabel ?? cli.accountLabel,
      planLabel: cli.planLabel,
      windows: [
        {
          label: "monthly",
          usedPercent: utilizationPercent,
          remainingPercent,
          windowMinutes: null,
          resetAt: budget.resetAt,
          level: usageLevelFromRemaining(remainingPercent),
          source: budget.source,
          note: budget.note,
        },
      ],
      monthlyBudgetUsd: budget.budgetUsd,
      monthlySpendUsd: budget.spendUsd,
      monthlyUtilizationPercent: utilizationPercent,
      monthlyRemainingUsd,
      monthlyResetAt: budget.resetAt,
      note: cli.note ?? budget.note,
      updatedAt: checkedAt,
    };
  });
}

function lowestRemainingPercent(usage: GitsProviderUsage): number | null {
  const values = usage.windows
    .map((window) => window.remainingPercent)
    .filter((value): value is number => value !== null);
  if (values.length === 0) {
    return null;
  }
  return Math.min(...values);
}

function cursorRemainingPercent(usage: GitsProviderUsage): number | null {
  return usage.monthlyUtilizationPercent === null
    ? null
    : clampPercent(100 - usage.monthlyUtilizationPercent);
}

export function recommendDelamainEngine(
  codex: GitsProviderUsage,
  cursor: GitsProviderUsage,
): GitsCapacityRecommendation {
  const codexRemaining = lowestRemainingPercent(codex);
  const cursorRemaining = cursorRemainingPercent(cursor);
  const cursorUsable = cursor.status !== "unavailable";
  let recommendedEngine: DelamainEngine = "codex";
  let confidence: GitsCapacityRecommendation["confidence"] = "medium";
  let reason = "Codex has usable local rate-limit headroom; keep Delamain on Codex by default.";

  if (cursorRemaining !== null && cursorRemaining < 10) {
    return {
      recommendedEngine,
      confidence: "high",
      reason: "Cursor monthly budget is nearly exhausted, so keep new Delamain peers on Codex.",
      codexRemainingPercent: codexRemaining,
      cursorRemainingPercent: cursorRemaining,
    };
  }

  if (codexRemaining !== null && codexRemaining < 20 && cursorUsable) {
    recommendedEngine = "cursor";
    confidence = cursorRemaining === null ? "medium" : "high";
    reason =
      cursorRemaining === null
        ? "Codex is below 20% on at least one active window and Cursor is available; Cursor spend is not yet measured, so this is a conservative balance recommendation."
        : "Codex is below 20% on at least one active window while Cursor has monthly budget headroom.";
  } else if (
    codexRemaining !== null &&
    codexRemaining < 40 &&
    cursorRemaining !== null &&
    cursorRemaining > 50
  ) {
    recommendedEngine = "cursor";
    confidence = "medium";
    reason = "Codex is in the red zone and Cursor is underutilized against the monthly budget.";
  } else if (codexRemaining === null && cursorUsable) {
    recommendedEngine = "cursor";
    confidence = "low";
    reason =
      "Codex rate-limit telemetry is unavailable and Cursor is authenticated; prefer Cursor only when the operator approves the tradeoff.";
  }

  return {
    recommendedEngine,
    confidence,
    reason,
    codexRemainingPercent: codexRemaining,
    cursorRemainingPercent: cursorRemaining,
  };
}

export function formatCapacityForHermes(snapshot: GitsCapacitySnapshot): string {
  const codexWindows =
    snapshot.codex.windows.length === 0
      ? "unavailable"
      : snapshot.codex.windows
          .map(
            (window) =>
              `${window.label}: ${window.usedPercent ?? "?"}% used, ${window.remainingPercent ?? "?"}% remaining`,
          )
          .join("; ");
  const cursorWindow = snapshot.cursor.windows[0];
  const cursorUsage =
    cursorWindow && cursorWindow.usedPercent !== null
      ? `${cursorWindow.usedPercent}% of ${snapshot.cursor.monthlyBudgetUsd ?? "?"} USD monthly budget used`
      : `${snapshot.cursor.monthlyBudgetUsd ?? "?"} USD monthly budget configured; spend telemetry unavailable`;

  return [
    "Provider capacity snapshot:",
    `- Codex: ${codexWindows}.`,
    `- Cursor: ${cursorUsage}.`,
    `- Recommended Delamain engine: ${snapshot.recommendation.recommendedEngine} (${snapshot.recommendation.confidence}) because ${snapshot.recommendation.reason}`,
    "Use this only for proposal routing. Hermes must not spawn agents directly; GITS approval and Delamain execution remain required.",
  ].join("\n");
}

export const GitsCapacityMonitorLive = Layer.succeed(GitsCapacityMonitor, {
  getSnapshot: () =>
    Effect.gen(function* () {
      const checkedAt = yield* nowIso;
      const [codex, cursor] = yield* Effect.all([
        Effect.sync(() => readCodexProviderUsage(checkedAt)),
        readCursorProviderUsage(checkedAt),
      ]);

      return {
        checkedAt,
        codex,
        cursor,
        recommendation: recommendDelamainEngine(codex, cursor),
        notes: [
          "Codex utilization is derived from local Codex rate-limit events; no OAuth token material is read or exposed.",
          "Cursor billing is read from cursor.com dashboard when a local WorkosCursorSessionToken is configured; otherwise GITS falls back to local budget configuration.",
        ],
      } satisfies GitsCapacitySnapshot;
    }).pipe(
      Effect.mapError((cause) =>
        toCapacityError("Failed to read GITS provider capacity telemetry.", cause),
      ),
    ),
} satisfies GitsCapacityMonitorShape);
