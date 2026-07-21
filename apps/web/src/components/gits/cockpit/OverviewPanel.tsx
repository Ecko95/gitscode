import type {
  AutomodeEpisode,
  AutomodeSnapshot,
  GitsCapacitySnapshot,
  GitsCockpitSnapshot,
  GitsSchedulerSnapshot,
  ServerProcessResourceHistoryResult,
  UsageSummary,
} from "@t3tools/contracts";
import { CODEX_MODEL_TIER_LABELS } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import {
  AlertTriangleIcon,
  BotIcon,
  CheckCircle2Icon,
  CircleDollarSignIcon,
  CircleIcon,
  ListChecksIcon,
  OctagonAlertIcon,
  PlayIcon,
  RefreshCwIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";

import { formatGateDecision, modelTierOf } from "./autopilot/autopilot.logic";
import { BarChart, LineAreaChart, Meter, StatTile, type BarDatum } from "./charts";
import { countGoalsCompletedToday, groupEpisodesByLondonDay } from "./overview.logic";
import {
  EmptyState,
  SectionHeader,
  SignalRow,
  StatBlock,
  StatusPill,
  formatBytes,
  formatCount,
  formatCpuTime,
  formatIsoDate,
  formatSlotRemaining,
  formatUsd,
  isRecord,
  statusTone,
} from "./primitives";
import type { GitsCockpitTab } from "./tabs";

type BuildInfoField = {
  readonly label: string;
  readonly value: string;
};

export type BuildInfoSnapshot =
  | {
      readonly status: "available";
      readonly fields: ReadonlyArray<BuildInfoField>;
      readonly note: string | null;
    }
  | {
      readonly status: "missing";
      readonly fields: [];
      readonly note: null;
    };

function getNestedString(value: unknown, path: ReadonlyArray<string>): string | null {
  let current: unknown = value;
  for (const key of path) {
    if (!isRecord(current) || !(key in current)) {
      return null;
    }
    current = current[key];
  }
  if (typeof current !== "string") {
    return null;
  }
  const trimmed = current.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function dedupeBuildInfoFields(
  fields: ReadonlyArray<BuildInfoField>,
): ReadonlyArray<BuildInfoField> {
  const seen = new Set<string>();
  return fields.filter((field) => {
    const key = `${field.label}:${field.value}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export function normalizeBuildInfo(value: unknown): BuildInfoSnapshot {
  if (!isRecord(value)) {
    return { status: "available", fields: [], note: null };
  }
  const fields = dedupeBuildInfoFields(
    [
      { label: "Version", value: getNestedString(value, ["version"]) },
      { label: "Commit", value: getNestedString(value, ["commit"]) },
      { label: "Commit", value: getNestedString(value, ["commitSha"]) },
      { label: "Commit", value: getNestedString(value, ["gitSha"]) },
      { label: "Commit", value: getNestedString(value, ["git", "sha"]) },
      { label: "Branch", value: getNestedString(value, ["branch"]) },
      { label: "Branch", value: getNestedString(value, ["gitBranch"]) },
      { label: "Branch", value: getNestedString(value, ["git", "branch"]) },
      { label: "Built", value: getNestedString(value, ["time"]) },
      { label: "Built", value: getNestedString(value, ["builtAt"]) },
      { label: "Built", value: getNestedString(value, ["buildTime"]) },
      { label: "Built", value: getNestedString(value, ["buildTimeUtc"]) },
      { label: "Built", value: getNestedString(value, ["build", "time"]) },
      { label: "Built", value: getNestedString(value, ["timestamp"]) },
      { label: "Environment", value: getNestedString(value, ["environment"]) },
      { label: "Environment", value: getNestedString(value, ["deploymentEnv"]) },
      { label: "Environment", value: getNestedString(value, ["deploy", "environment"]) },
      { label: "Source", value: getNestedString(value, ["sourcePath"]) },
      { label: "Source", value: getNestedString(value, ["source"]) },
      { label: "Source", value: getNestedString(value, ["worktree"]) },
      { label: "Source", value: getNestedString(value, ["builder"]) },
    ]
      .filter((field): field is BuildInfoField => field.value !== null)
      .slice(0, 6),
  );
  const note =
    getNestedString(value, ["generatedBy"]) ??
    getNestedString(value, ["deploy", "provider"]) ??
    getNestedString(value, ["provider"]);
  return { status: "available", fields, note };
}

const CAPACITY_FIVE_HOUR_MINUTES = 300;
const CAPACITY_WEEKLY_MINUTES = 10_080;

function findCapacityWindow(
  windows:
    | ReadonlyArray<{ readonly windowMinutes: number | null; readonly usedPercent: number | null }>
    | undefined,
  minutes: number,
) {
  return windows?.find((window) => window.windowMinutes === minutes) ?? null;
}

function ChartCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="min-w-0 rounded-lg border border-border/60 bg-card p-3">
      <h4 className="mb-2 text-[11px] font-medium uppercase text-muted-foreground/70">{title}</h4>
      {children}
    </div>
  );
}

/**
 * Analytics-first Overview ("Command") dashboard: a run-status strip every item of which
 * deep-links to the tab that can act on it, a charts row (resource history, codex capacity,
 * episode ledger, goals pipeline), and a "Tonight" scheduler summary. Build provenance and
 * raw per-process resource detail live below this, in the shell's collapsed secondary panels.
 */
export function CockpitOverviewPanel({
  automode,
  scheduler,
  capacity,
  history,
  episodes,
  usage,
  onNavigate,
}: {
  automode: AutomodeSnapshot | undefined;
  scheduler: GitsSchedulerSnapshot | undefined;
  capacity: GitsCapacitySnapshot | undefined;
  history: ServerProcessResourceHistoryResult | undefined;
  episodes: ReadonlyArray<AutomodeEpisode> | undefined;
  usage: UsageSummary | undefined;
  onNavigate: (tab: GitsCockpitTab) => void;
}) {
  const policy = automode?.policy;
  const goals = automode?.goals ?? [];
  const waitingApproval = goals.filter((goal) => goal.status === "waiting-approval").length;
  const queued = goals.filter((goal) => goal.status === "queued").length;
  const running = goals.filter((goal) => goal.status === "running").length;
  const completedToday = countGoalsCompletedToday(goals);

  const fiveHourWindow = findCapacityWindow(capacity?.codex.windows, CAPACITY_FIVE_HOUR_MINUTES);
  const weeklyWindow = findCapacityWindow(capacity?.codex.windows, CAPACITY_WEEKLY_MINUTES);

  const hasResourceData = (history?.buckets.length ?? 0) > 0;
  const rssSeries = history
    ? [
        {
          id: "rss",
          label: "RSS",
          points: history.buckets.map((bucket) => ({
            t: DateTime.toEpochMillis(bucket.startedAt),
            v: bucket.maxRssBytes / (1024 * 1024),
          })),
        },
      ]
    : [];
  const cpuSeries = history
    ? [
        {
          id: "cpu",
          label: "CPU",
          points: history.buckets.map((bucket) => ({
            t: DateTime.toEpochMillis(bucket.startedAt),
            v: bucket.avgCpuPercent,
          })),
        },
      ]
    : [];

  const hasEpisodeData = (episodes?.length ?? 0) > 0;
  const episodeBarData: BarDatum[] = groupEpisodesByLondonDay(episodes ?? [], 14).map((night) => ({
    label: night.label,
    values: [
      { key: "landed", value: night.landed },
      { key: "flagged", value: night.flagged },
      { key: "failed", value: night.failed },
    ],
  }));

  const defaultModelTier = modelTierOf(policy?.defaultModel ?? null);
  const defaultModelLabel = defaultModelTier
    ? CODEX_MODEL_TIER_LABELS[defaultModelTier]
    : (policy?.defaultModel ?? "not set");
  const slotWindowText = scheduler?.currentSlot
    ? `${scheduler.currentSlot.start}–${scheduler.currentSlot.end} · ${formatSlotRemaining(
        scheduler.slotRemainingMs ?? 0,
      )} left`
    : (scheduler?.arming.disarmedReason ?? "No active slot right now.");
  const gateDecisionText = scheduler?.lastGateDecision
    ? `${formatGateDecision(scheduler.lastGateDecision)} · ${formatIsoDate(scheduler.lastGateDecision.at)}`
    : "No gate decisions recorded yet.";

  return (
    <section className="border-b border-border bg-background">
      <div className="flex flex-col gap-2 border-b border-border/70 px-4 py-4 sm:flex-row sm:items-start sm:justify-between sm:px-5">
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold">Command</h2>
          <p className="mt-1 truncate text-xs text-muted-foreground">
            Automode, scheduler, and fleet status at a glance.
          </p>
        </div>
      </div>

      <div className="grid min-w-0 grid-cols-2 border-b border-border/60 sm:grid-cols-4 xl:grid-cols-8">
        <SignalRow
          label="Automode"
          value={policy?.mode ?? "unknown"}
          tone={
            policy?.mode === "autonomous"
              ? "success"
              : policy?.mode === "supervised"
                ? "warning"
                : "default"
          }
          detail={`${formatCount(goals.length)} goals tracked`}
          onClick={() => onNavigate("autopilot")}
        />
        <SignalRow
          label="Kill switch"
          value={policy?.killSwitchEnabled ? "engaged" : "off"}
          tone={policy?.killSwitchEnabled ? "danger" : "success"}
          detail={
            policy?.killSwitchEnabled
              ? "Automode execution is blocked."
              : "Automode may run within policy."
          }
          onClick={() => onNavigate("autopilot")}
        />
        <SignalRow
          label="Driver"
          value={automode?.driverHalted ? "halted" : "running"}
          tone={automode?.driverHalted ? "danger" : "success"}
          detail={
            automode?.driverHalted
              ? (automode.driverHaltedReason ?? "Halted — reason unknown.")
              : "Running nominally."
          }
          onClick={() => onNavigate("autopilot")}
        />
        <SignalRow
          label="Scheduler"
          value={scheduler?.arming.status ?? "unknown"}
          tone={scheduler?.arming.status === "armed" ? "success" : "default"}
          detail={slotWindowText}
          onClick={() => onNavigate("autopilot")}
        />
        <SignalRow
          label="Held PR"
          value={automode?.heldPrUrl ? `#${automode.heldPrNumber ?? "?"}` : "none"}
          tone={automode?.heldPrUrl ? "warning" : "default"}
          detail={
            automode?.heldPrUrl ? "Awaiting merge — opens in a new tab." : "No PR held for review."
          }
          href={automode?.heldPrUrl ?? undefined}
        />
        <SignalRow
          label="Run merged"
          value={automode?.runMerged ? "merged" : "pending"}
          tone={automode?.runMerged ? "success" : "default"}
          detail={automode?.runMerged ? "Latest run merged to main." : "No merge recorded yet."}
          onClick={() => onNavigate("autopilot")}
        />
        <SignalRow
          label="Active peers"
          value={formatCount(automode?.activePeerCount ?? 0)}
          tone="default"
          detail="Delamain peers currently running."
          onClick={() => onNavigate("fleet")}
        />
        <SignalRow
          label="Approvals"
          value={formatCount(automode?.pendingApprovalCount ?? 0)}
          tone={(automode?.pendingApprovalCount ?? 0) > 0 ? "warning" : "success"}
          detail="Goals waiting on operator approval."
          onClick={() => onNavigate("autopilot")}
        />
      </div>

      <div className="grid gap-3 border-b border-border/60 p-4 sm:grid-cols-2 sm:p-5">
        <ChartCard title="Memory — RSS peak per minute">
          {hasResourceData ? (
            <LineAreaChart series={rssSeries} unit=" MB" />
          ) : (
            <EmptyState label="No resource samples yet." />
          )}
        </ChartCard>
        <ChartCard title="CPU — average per minute">
          {hasResourceData ? (
            <LineAreaChart series={cpuSeries} unit="%" />
          ) : (
            <EmptyState label="No resource samples yet." />
          )}
        </ChartCard>
      </div>

      <div className="grid gap-3 border-b border-border/60 p-4 sm:grid-cols-2 sm:p-5">
        <ChartCard title="Codex capacity">
          {capacity ? (
            <div className="grid gap-3">
              <Meter
                label="5h window"
                value={fiveHourWindow?.usedPercent ?? 0}
                warnAt={75}
                dangerAt={90}
              />
              <Meter
                label="Weekly window"
                value={weeklyWindow?.usedPercent ?? 0}
                warnAt={75}
                dangerAt={90}
              />
            </div>
          ) : (
            <EmptyState label="Codex capacity unavailable." />
          )}
        </ChartCard>
        <ChartCard title="Episodes — last 14 nights">
          {hasEpisodeData ? (
            <BarChart data={episodeBarData} />
          ) : (
            <EmptyState label="No automode episodes recorded yet." />
          )}
        </ChartCard>
      </div>

      <div className="grid grid-cols-2 gap-3 border-b border-border/60 p-4 sm:grid-cols-4 sm:p-5">
        <StatTile
          label="Waiting approval"
          value={waitingApproval}
          icon={OctagonAlertIcon}
          tone={waitingApproval > 0 ? "warning" : "default"}
        />
        <StatTile label="Queued" value={queued} icon={ListChecksIcon} />
        <StatTile
          label="Running"
          value={running}
          icon={PlayIcon}
          tone={running > 0 ? "success" : "default"}
        />
        <StatTile
          label="Completed today"
          value={completedToday}
          icon={CheckCircle2Icon}
          tone="success"
        />
        {usage ? (
          <StatTile
            label="Cost (est.)"
            value={formatUsd(usage.estimatedCostUsd)}
            icon={CircleDollarSignIcon}
          />
        ) : null}
      </div>

      <div className="border-b border-border/60 px-4 py-4 sm:px-5">
        <div className="rounded-lg border border-border/60 bg-card p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">Tonight</h3>
            <StatusPill
              label={
                !scheduler?.config.enabled
                  ? "disabled"
                  : scheduler.arming.status === "armed"
                    ? "armed"
                    : "enabled"
              }
              tone={
                !scheduler?.config.enabled
                  ? "default"
                  : scheduler.arming.status === "armed"
                    ? "success"
                    : "warning"
              }
            />
          </div>
          <dl className="mt-3 grid gap-3 text-xs sm:grid-cols-2">
            <div>
              <dt className="text-muted-foreground">Active/next slot</dt>
              <dd className="mt-0.5 text-foreground">{slotWindowText}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Goals started tonight</dt>
              <dd className="mt-0.5 font-mono tabular-nums text-foreground">
                {formatCount(scheduler?.goalsStartedTonight ?? 0)} /{" "}
                {formatCount(scheduler?.config.maxGoalsPerNight ?? 0)}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Default model</dt>
              <dd className="mt-0.5 text-foreground">{defaultModelLabel}</dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-muted-foreground">Last gate decision</dt>
              <dd className="mt-0.5 text-foreground">{gateDecisionText}</dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="mb-1 text-muted-foreground">Proposal repos</dt>
              <dd className="flex flex-wrap gap-1.5">
                {(policy?.proposalRepos.length ?? 0) === 0 ? (
                  <span className="text-muted-foreground">None opted in.</span>
                ) : (
                  policy!.proposalRepos.map((repo) => (
                    <span
                      key={repo}
                      className="max-w-52 truncate rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[11px]"
                    >
                      {repo}
                    </span>
                  ))
                )}
              </dd>
            </div>
          </dl>
          <div className="mt-3">
            <Button size="sm" variant="outline" onClick={() => onNavigate("autopilot")}>
              Configure in Autopilot
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}

export function BuildProvenancePanel({
  buildInfo,
  loading,
  error,
  onRefresh,
}: {
  buildInfo: BuildInfoSnapshot | undefined;
  loading: boolean;
  error: unknown;
  onRefresh: () => void;
}) {
  const errorMessage = error instanceof Error ? error.message : null;
  const fields = buildInfo?.status === "available" ? buildInfo.fields : [];
  const note = buildInfo?.status === "available" ? buildInfo.note : null;

  return (
    <section className="border-b border-border bg-background">
      <div className="flex flex-col gap-3 border-b border-border/70 px-4 py-4 sm:flex-row sm:items-start sm:justify-between sm:px-5">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="truncate text-base font-semibold">Build Provenance</h2>
            <StatusPill label="local host" tone="default" />
            <StatusPill
              label={
                loading && !buildInfo
                  ? "checking"
                  : buildInfo?.status === "missing"
                    ? "unavailable"
                    : buildInfo?.status === "available"
                      ? "available"
                      : "checking"
              }
              tone={
                loading && !buildInfo
                  ? "warning"
                  : buildInfo?.status === "available"
                    ? "success"
                    : buildInfo?.status === "missing"
                      ? "default"
                      : "warning"
              }
            />
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {buildInfo?.status === "missing"
              ? "This host does not expose /api/gits/build-info."
              : (note ?? "Compact host build metadata when available.")}
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={onRefresh} disabled={loading}>
          <RefreshCwIcon className={cn("size-3.5", loading && "animate-spin")} />
          Refresh
        </Button>
      </div>

      {errorMessage ? (
        <div
          aria-live="polite"
          className="border-b border-border/60 px-4 py-2 text-xs text-destructive sm:px-5"
        >
          {errorMessage}
        </div>
      ) : null}

      {buildInfo?.status === "missing" ? (
        <EmptyState label="Build provenance endpoint not detected." />
      ) : loading && !buildInfo ? (
        <EmptyState label="Checking build provenance..." />
      ) : fields.length === 0 ? (
        <EmptyState label="No recognized provenance fields returned." />
      ) : (
        <div className="grid gap-2 px-4 py-3 sm:grid-cols-2 sm:px-5 xl:grid-cols-4">
          {fields.map((field) => (
            <div
              key={`${field.label}:${field.value}`}
              className="min-w-0 rounded-md border border-border/60 bg-muted/20 px-3 py-2.5"
            >
              <div className="text-[11px] font-medium uppercase text-muted-foreground/70">
                {field.label}
              </div>
              <div className="mt-1 truncate font-mono text-xs text-foreground">
                {field.label === "Built" ? formatIsoDate(field.value) : field.value}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export function ResourceVisibilityPanel({
  snapshot,
  automode,
  history,
  loading,
  error,
  onRefresh,
}: {
  snapshot: GitsCockpitSnapshot;
  automode: AutomodeSnapshot | undefined;
  history: ServerProcessResourceHistoryResult | undefined;
  loading: boolean;
  error: unknown;
  onRefresh: () => void;
}) {
  const resourceError = history ? Option.getOrNull(history.error) : null;
  const errorMessage =
    error instanceof Error ? error.message : resourceError ? resourceError.message : null;
  const topProcesses = history?.topProcesses.slice(0, 5) ?? [];
  const maxRssBytes =
    history?.topProcesses.reduce((max, process) => Math.max(max, process.maxRssBytes), 0) ?? 0;
  const budgetUsage = automode?.budgetUsage;
  const costLabel =
    budgetUsage?.totalCostUsd !== null && budgetUsage?.totalCostUsd !== undefined
      ? formatUsd(budgetUsage.totalCostUsd)
      : "unavailable";
  const costPillLabel =
    budgetUsage?.totalCostUsd !== null && budgetUsage?.totalCostUsd !== undefined
      ? "cost tracked"
      : "cost unavailable";

  return (
    <section className="border-b border-border bg-background">
      <div className="flex flex-col gap-3 border-b border-border/70 px-4 py-4 sm:flex-row sm:items-start sm:justify-between sm:px-5">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="truncate text-base font-semibold">Runtime Visibility</h2>
            <StatusPill label="resources" tone={history ? "success" : "warning"} />
            <StatusPill
              label={costPillLabel}
              tone={
                budgetUsage?.totalCostUsd !== null && budgetUsage?.totalCostUsd !== undefined
                  ? "success"
                  : "warning"
              }
            />
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {history
              ? `${formatCount(history.retainedSampleCount)} retained samples | ${formatCount(
                  history.topProcesses.length,
                )} processes`
              : "Collecting process samples"}
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={onRefresh} disabled={loading}>
          <RefreshCwIcon className={cn("size-3.5", loading && "animate-spin")} />
          Refresh
        </Button>
      </div>

      {errorMessage ? (
        <div
          aria-live="polite"
          className="border-b border-border/60 px-4 py-2 text-xs text-destructive sm:px-5"
        >
          {errorMessage}
        </div>
      ) : null}

      <div className="grid grid-cols-2 border-b border-border/60 sm:grid-cols-4">
        <StatBlock
          label="Sessions"
          value={formatCount(snapshot.totals.activeAgentSessionCount)}
          icon={BotIcon}
        />
        <StatBlock
          label="CPU Time"
          value={history ? formatCpuTime(history.totalCpuSecondsApprox) : "..."}
          icon={CircleIcon}
        />
        <StatBlock
          label="Peak Mem"
          value={history ? formatBytes(maxRssBytes) : "..."}
          icon={CircleIcon}
        />
        <StatBlock label="Cost" value={costLabel} icon={AlertTriangleIcon} />
      </div>

      <div className="min-w-0">
        <SectionHeader title="Top processes" count={topProcesses.length} />
        {topProcesses.length === 0 ? (
          <EmptyState label={loading ? "Collecting process samples..." : "No resource samples."} />
        ) : (
          <div className="divide-y divide-border/60">
            {topProcesses.map((process) => (
              <div
                key={process.processKey}
                className="grid gap-2 px-4 py-2.5 text-xs sm:grid-cols-[minmax(0,1fr)_auto_auto_auto] sm:items-center sm:px-5"
              >
                <div className="min-w-0">
                  <div className="truncate font-medium text-foreground">{process.command}</div>
                  <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                    pid {process.pid} | samples {formatCount(process.sampleCount)}
                  </div>
                </div>
                <div className="font-mono text-[11px] tabular-nums text-muted-foreground">
                  {formatCpuTime(process.cpuSecondsApprox)}
                </div>
                <div className="font-mono text-[11px] tabular-nums text-muted-foreground">
                  {process.currentCpuPercent.toFixed(1)}%
                </div>
                <div className="font-mono text-[11px] tabular-nums text-muted-foreground">
                  {formatBytes(process.maxRssBytes)}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
