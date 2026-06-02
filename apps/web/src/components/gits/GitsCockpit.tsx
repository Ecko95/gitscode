import type {
  AgentSession,
  AutomodeGoal,
  AutomodeSnapshot,
  DelamainPeer,
  DelamainPeerListResult,
  GitsCapacitySnapshot,
  GitsCockpitProject,
  GitsCockpitSnapshot,
  GitsSkillInventoryItem,
  GitsSkillInventorySnapshot,
  GitsSkillProvider,
  GsdPhase,
  HermesCommandResult,
  HermesExecutionDraft,
  HermesLogTailResult,
  HermesProposalCard,
  HermesProposalListResult,
  HermesScheduleKind,
  HermesScheduleRunResult,
  HermesSessionListResult,
  HermesStatusResult,
  OpenGsdCommandResult,
  OpenGsdStatusResult,
  ServerProcessResourceHistoryResult,
  VerificationGate,
  YourTurnCard,
} from "@t3tools/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import * as Option from "effect/Option";
import {
  AlertTriangleIcon,
  BookOpenCheckIcon,
  BotIcon,
  CheckCircle2Icon,
  CircleStopIcon,
  CircleIcon,
  FilePlus2Icon,
  GaugeIcon,
  GitBranchIcon,
  ListChecksIcon,
  PlayIcon,
  PowerIcon,
  RefreshCwIcon,
  SearchIcon,
  SendIcon,
  ShieldCheckIcon,
  SparklesIcon,
  StarIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  getPrimaryEnvironmentConnection,
  readEnvironmentConnection,
  useSavedEnvironmentRuntimeStore,
} from "../../environments/runtime";
import { usePrimaryEnvironmentId } from "../../environments/primary";
import { cn } from "../../lib/utils";
import { useStore } from "../../store";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset, SidebarTrigger } from "../ui/sidebar";
import { Textarea } from "../ui/textarea";

const NUMBER_FORMAT = new Intl.NumberFormat();
const USD_FORMAT = new Intl.NumberFormat(undefined, {
  currency: "USD",
  maximumFractionDigits: 2,
  minimumFractionDigits: 2,
  style: "currency",
});

function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }
  const units = ["KB", "MB", "GB"] as const;
  let unitIndex = -1;
  let next = value;
  do {
    next /= 1024;
    unitIndex += 1;
  } while (next >= 1024 && unitIndex < units.length - 1);
  return `${next.toFixed(next >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

function formatCpuTime(seconds: number): string {
  if (seconds < 60) {
    return `${seconds.toFixed(seconds >= 10 ? 1 : 2)}s`;
  }
  const minutes = seconds / 60;
  if (minutes < 60) {
    return `${minutes.toFixed(minutes >= 10 ? 1 : 2)}m`;
  }
  return `${(minutes / 60).toFixed(2)}h`;
}

const PHASE_STATUS_LABELS: Record<GsdPhase["status"], string> = {
  unknown: "Unknown",
  discussing: "Discussing",
  planned: "Planned",
  executing: "Executing",
  blocked: "Blocked",
  completed: "Completed",
  verified: "Verified",
};

const GATE_STATUS_LABELS: Record<VerificationGate["status"], string> = {
  unknown: "Unknown",
  missing: "Missing",
  pending: "Pending",
  blocked: "Blocked",
  failed: "Failed",
  passed: "Passed",
};

type GitsCockpitTab = "overview" | "motoko" | "fleet" | "automode" | "gsd" | "skills" | "projects";

const GITS_COCKPIT_TABS: ReadonlyArray<{
  id: GitsCockpitTab;
  label: string;
  icon: typeof CircleIcon;
}> = [
  { id: "overview", label: "Overview", icon: GaugeIcon },
  { id: "motoko", label: "Motoko", icon: SparklesIcon },
  { id: "fleet", label: "Fleet", icon: GitBranchIcon },
  { id: "automode", label: "Automode", icon: PowerIcon },
  { id: "gsd", label: "Open GSD", icon: ListChecksIcon },
  { id: "skills", label: "Skills", icon: BookOpenCheckIcon },
  { id: "projects", label: "Projects", icon: CircleIcon },
];

type BuildInfoField = {
  readonly label: string;
  readonly value: string;
};

type BuildInfoSnapshot =
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

type SkillReviewState = Record<
  string,
  {
    readonly rating: number | null;
    readonly review: string;
  }
>;

const SKILL_REVIEW_STORAGE_KEY = "gits:skills:reviews:v1";

function formatCount(value: number): string {
  return NUMBER_FORMAT.format(value);
}

function formatUsd(value: number): string {
  return USD_FORMAT.format(value);
}

function formatIsoDate(value: string | null | undefined): string {
  if (!value) {
    return "unknown";
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatPercent(value: number | null | undefined): string {
  return value === null || value === undefined ? "..." : `${value.toFixed(0)}%`;
}

function tallyValues<T extends string>(values: ReadonlyArray<T>): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

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

function normalizeBuildInfo(value: unknown): BuildInfoSnapshot {
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

function loadSkillReviewState(): SkillReviewState {
  if (typeof window === "undefined") {
    return {};
  }
  try {
    const raw = window.localStorage.getItem(SKILL_REVIEW_STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return {};
    }
    const reviews: SkillReviewState = {};
    for (const [skillId, value] of Object.entries(parsed)) {
      if (!isRecord(value)) {
        continue;
      }
      const rating = typeof value.rating === "number" ? value.rating : null;
      const review = typeof value.review === "string" ? value.review : "";
      reviews[skillId] = {
        rating:
          rating !== null && Number.isInteger(rating) && rating >= 1 && rating <= 5 ? rating : null,
        review,
      };
    }
    return reviews;
  } catch {
    return {};
  }
}

function saveSkillReviewState(reviews: SkillReviewState): void {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(SKILL_REVIEW_STORAGE_KEY, JSON.stringify(reviews));
}

function formatSkillProvider(provider: GitsSkillProvider): string {
  if (provider === "gits") {
    return "GITS";
  }
  return provider.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatSkillKind(kind: GitsSkillInventoryItem["kind"]): string {
  return kind.replaceAll("-", " ");
}

function portabilityTone(
  portability: GitsSkillInventoryItem["portability"],
): ReturnType<typeof statusTone> {
  if (portability === "native" || portability === "ported") {
    return "success";
  }
  if (portability === "missing-port" || portability === "candidate") {
    return "warning";
  }
  return "default";
}

function applySkillReviews(
  skill: GitsSkillInventoryItem,
  reviews: SkillReviewState,
): GitsSkillInventoryItem {
  const review = reviews[skill.id];
  if (!review) {
    return skill;
  }
  return {
    ...skill,
    rating: review.rating,
    review: review.review.trim().length > 0 ? review.review : null,
  };
}

function statusTone(status: string): "default" | "warning" | "danger" | "success" {
  if (status === "passed" || status === "verified" || status === "completed") {
    return "success";
  }
  if (status === "blocked" || status === "failed") {
    return "danger";
  }
  if (status === "missing" || status === "pending" || status === "planned") {
    return "warning";
  }
  return "default";
}

function StatusPill({ label, tone }: { label: string; tone: ReturnType<typeof statusTone> }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center rounded-full border px-2 text-[11px] font-medium",
        tone === "success" &&
          "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
        tone === "warning" &&
          "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300",
        tone === "danger" && "border-destructive/30 bg-destructive/10 text-destructive",
        tone === "default" && "border-border bg-muted/35 text-muted-foreground",
      )}
    >
      {label}
    </span>
  );
}

function StatBlock({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: string;
  icon: typeof CircleIcon;
}) {
  return (
    <div className="min-w-0 border-r border-b border-border/60 px-4 py-3 last:border-r-0 sm:px-5">
      <div className="flex min-w-0 items-center gap-1.5 text-[11px] font-medium uppercase text-muted-foreground/70">
        <Icon className="size-3.5 shrink-0" />
        <span className="truncate">{label}</span>
      </div>
      <div className="mt-1 truncate font-mono text-xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function EmptyState({ label }: { label: string }) {
  return <div className="px-4 py-3 text-xs text-muted-foreground sm:px-5">{label}</div>;
}

function SectionHeader({ title, count }: { title: string; count: number }) {
  return (
    <div className="flex min-w-0 items-center justify-between border-b border-border/60 px-4 py-2.5 sm:px-5">
      <h3 className="truncate text-xs font-semibold uppercase text-muted-foreground/80">{title}</h3>
      <span className="font-mono text-[11px] text-muted-foreground">{formatCount(count)}</span>
    </div>
  );
}

function YourTurnList({ cards }: { cards: ReadonlyArray<YourTurnCard> }) {
  if (cards.length === 0) {
    return <EmptyState label="No current handoff cards." />;
  }

  return (
    <div className="divide-y divide-border/60">
      {cards.slice(0, 6).map((card) => (
        <div key={card.id} className="grid gap-1 px-4 py-3 text-xs sm:px-5">
          <div className="flex min-w-0 items-center gap-2">
            <AlertTriangleIcon
              className={cn(
                "size-3.5 shrink-0",
                card.severity === "critical" ? "text-destructive" : "text-amber-500",
              )}
            />
            <span className="truncate font-medium text-foreground">{card.title}</span>
            <StatusPill label={card.kind.replaceAll("-", " ")} tone="warning" />
          </div>
          <p className="line-clamp-2 text-muted-foreground">{card.detail}</p>
        </div>
      ))}
    </div>
  );
}

function PhaseTable({ phases }: { phases: ReadonlyArray<GsdPhase> }) {
  if (phases.length === 0) {
    return <EmptyState label="No phase directories found." />;
  }

  return (
    <ScrollArea chainVerticalScroll scrollFade hideScrollbars className="w-full">
      <table className="w-full min-w-[680px] text-left text-xs">
        <thead className="border-b border-border/60 text-[11px] uppercase text-muted-foreground/70">
          <tr>
            <th className="px-4 py-2 font-medium sm:px-5">Phase</th>
            <th className="px-3 py-2 font-medium">State</th>
            <th className="px-3 py-2 font-medium">Artifacts</th>
            <th className="px-3 py-2 font-medium">Flags</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/60">
          {phases.map((phase) => (
            <tr key={phase.id}>
              <td className="min-w-0 px-4 py-2.5 sm:px-5">
                <div className="font-medium text-foreground">{phase.title}</div>
                <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">{phase.id}</div>
              </td>
              <td className="px-3 py-2.5">
                <StatusPill
                  label={PHASE_STATUS_LABELS[phase.status]}
                  tone={statusTone(phase.status)}
                />
              </td>
              <td className="px-3 py-2.5 text-muted-foreground">
                {[
                  phase.hasContext ? "context" : null,
                  phase.hasSpec ? "spec" : null,
                  phase.hasPlan ? "plan" : null,
                  phase.hasFrozenContract ? "frozen" : null,
                  phase.hasVerification ? "verification" : null,
                  phase.hasSummary ? "summary" : null,
                ]
                  .filter(Boolean)
                  .join(", ") || "none"}
              </td>
              <td className="px-3 py-2.5 text-muted-foreground">
                {phase.riskFlags.length > 0 ? phase.riskFlags.join(", ") : "none"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollArea>
  );
}

function GateList({ gates }: { gates: ReadonlyArray<VerificationGate> }) {
  if (gates.length === 0) {
    return <EmptyState label="No verification gates found." />;
  }

  return (
    <div className="divide-y divide-border/60">
      {gates.slice(0, 8).map((gate) => (
        <div key={gate.id} className="flex min-w-0 items-center gap-3 px-4 py-2.5 sm:px-5">
          <ShieldCheckIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-medium">{gate.label}</div>
            <div className="truncate text-[11px] text-muted-foreground">
              {gate.evidenceSummary ?? gate.phaseId ?? "Project gate"}
            </div>
          </div>
          <StatusPill label={GATE_STATUS_LABELS[gate.status]} tone={statusTone(gate.status)} />
        </div>
      ))}
    </div>
  );
}

function AgentSessionList({ sessions }: { sessions: ReadonlyArray<AgentSession> }) {
  if (sessions.length === 0) {
    return <EmptyState label="No active provider sessions." />;
  }

  return (
    <div className="divide-y divide-border/60">
      {sessions.map((session) => (
        <div key={session.id} className="flex min-w-0 items-center gap-3 px-4 py-2.5 sm:px-5">
          <BotIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-medium">{session.provider}</div>
            <div className="truncate text-[11px] text-muted-foreground">
              {session.model ?? "No model"} | {session.worktreePath ?? session.cwd}
            </div>
          </div>
          <StatusPill label={session.status} tone={statusTone(session.status)} />
        </div>
      ))}
    </div>
  );
}

function barToneClass(tone: ReturnType<typeof statusTone>): string {
  if (tone === "success") {
    return "bg-emerald-500";
  }
  if (tone === "warning") {
    return "bg-amber-500";
  }
  if (tone === "danger") {
    return "bg-destructive";
  }
  return "bg-muted-foreground/45";
}

function DistributionPanel({
  title,
  rows,
}: {
  title: string;
  rows: ReadonlyArray<{
    label: string;
    value: number;
    tone: ReturnType<typeof statusTone>;
  }>;
}) {
  const total = rows.reduce((sum, row) => sum + row.value, 0);

  return (
    <div className="min-w-0 border-b border-r border-border/60 last:border-r-0 xl:border-b-0">
      <SectionHeader title={title} count={total} />
      <div className="grid gap-2 px-4 py-3 sm:px-5">
        {rows.length === 0 ? (
          <EmptyState label="No data." />
        ) : (
          rows.map((row) => {
            const width = total === 0 ? 0 : Math.max(4, Math.round((row.value / total) * 100));
            return (
              <div key={row.label} className="grid gap-1.5 text-xs">
                <div className="flex min-w-0 items-center justify-between gap-3">
                  <span className="truncate text-muted-foreground">{row.label}</span>
                  <span className="font-mono text-[11px] tabular-nums">
                    {formatCount(row.value)}
                  </span>
                </div>
                <div className="h-2 overflow-hidden rounded-sm bg-muted">
                  <div
                    className={cn("h-full rounded-sm", barToneClass(row.tone))}
                    style={{ width: `${width}%` }}
                  />
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function SignalRow({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: string;
  detail: string;
  tone: ReturnType<typeof statusTone>;
}) {
  return (
    <div className="grid min-h-16 gap-1 border-b border-r border-border/60 px-4 py-3 last:border-r-0 sm:px-5">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <span className="truncate text-xs font-medium text-foreground">{label}</span>
        <StatusPill label={value} tone={tone} />
      </div>
      <div className="line-clamp-2 text-[11px] text-muted-foreground">{detail}</div>
    </div>
  );
}

function CockpitTabNav({
  activeTab,
  counts,
  onTabChange,
}: {
  activeTab: GitsCockpitTab;
  counts: Record<GitsCockpitTab, string>;
  onTabChange: (tab: GitsCockpitTab) => void;
}) {
  return (
    <div className="sticky top-0 z-10 border-b border-border bg-card/95 px-2 py-2 backdrop-blur">
      <div
        role="tablist"
        aria-label="GITS cockpit sections"
        className="flex min-w-0 gap-1 overflow-x-auto"
      >
        {GITS_COCKPIT_TABS.map((tab) => {
          const Icon = tab.icon;
          const selected = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={selected}
              className={cn(
                "inline-flex h-9 shrink-0 items-center gap-2 rounded-md px-3 text-xs font-medium transition-colors",
                selected
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
              )}
              onClick={() => onTabChange(tab.id)}
            >
              <Icon className="size-3.5" />
              <span>{tab.label}</span>
              <span
                className={cn(
                  "rounded-sm px-1.5 py-0.5 font-mono text-[10px] tabular-nums",
                  selected ? "bg-primary-foreground/15" : "bg-muted text-muted-foreground",
                )}
              >
                {counts[tab.id]}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function BuildProvenancePanel({
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
        <div className="border-b border-border/60 px-4 py-2 text-xs text-destructive sm:px-5">
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

function CockpitOverviewPanel({
  snapshot,
  delamain,
  automode,
  openGsd,
  hermes,
  proposals,
  capacity,
  history,
  buildInfo,
}: {
  snapshot: GitsCockpitSnapshot;
  delamain: DelamainPeerListResult | undefined;
  automode: AutomodeSnapshot | undefined;
  openGsd: OpenGsdStatusResult | undefined;
  hermes: HermesStatusResult | undefined;
  proposals: HermesProposalListResult | undefined;
  capacity: GitsCapacitySnapshot | undefined;
  history: ServerProcessResourceHistoryResult | undefined;
  buildInfo: BuildInfoSnapshot | undefined;
}) {
  const phases = snapshot.projects.flatMap((project) => project.phases);
  const gates = snapshot.projects.flatMap((project) => project.verificationGates);
  const yourTurn = snapshot.projects.flatMap((project) => project.yourTurn);
  const peers = delamain?.peers ?? [];
  const phaseCounts = tallyValues(phases.map((phase) => phase.status));
  const gateCounts = tallyValues(gates.map((gate) => gate.status));
  const peerCounts = tallyValues(peers.map((peer) => peer.status));
  const phaseRows = (Object.keys(PHASE_STATUS_LABELS) as Array<GsdPhase["status"]>)
    .map((status) => ({
      label: PHASE_STATUS_LABELS[status],
      value: phaseCounts[status] ?? 0,
      tone: statusTone(status),
    }))
    .filter((row) => row.value > 0);
  const gateRows = (Object.keys(GATE_STATUS_LABELS) as Array<VerificationGate["status"]>)
    .map((status) => ({
      label: GATE_STATUS_LABELS[status],
      value: gateCounts[status] ?? 0,
      tone: statusTone(status),
    }))
    .filter((row) => row.value > 0);
  const peerRows = Object.entries(peerCounts)
    .map(([status, value]) => ({
      label: status,
      value,
      tone: statusTone(status),
    }))
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
  const blockedPhaseCount = phases.filter((phase) => phase.status === "blocked").length;
  const failedGateCount = gates.filter(
    (gate) => gate.status === "failed" || gate.status === "blocked",
  ).length;
  const criticalTurnCount = yourTurn.filter((card) => card.severity === "critical").length;
  const issueCount =
    blockedPhaseCount + failedGateCount + criticalTurnCount + (automode?.pendingApprovalCount ?? 0);
  const resourceError = history ? Option.getOrNull(history.error) : null;
  const pendingProposalCount =
    proposals?.proposals.filter((proposal) => proposal.status === "proposed").length ?? 0;
  const topProposal = proposals?.proposals.find((proposal) => proposal.status === "proposed");

  return (
    <section className="border-b border-border bg-background">
      <div className="flex flex-col gap-2 border-b border-border/70 px-4 py-4 sm:flex-row sm:items-start sm:justify-between sm:px-5">
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h2 className="truncate text-base font-semibold">Overview</h2>
            <StatusPill
              label={issueCount === 0 ? "clear" : `${formatCount(issueCount)} attention`}
              tone={issueCount === 0 ? "success" : "warning"}
            />
            <StatusPill
              label={buildInfo?.status === "available" ? "provenance" : "runtime"}
              tone={buildInfo?.status === "available" ? "success" : "default"}
            />
          </div>
          <p className="mt-1 truncate text-xs text-muted-foreground">
            scanned {formatIsoDate(snapshot.scannedAt)} |{" "}
            {formatCount(snapshot.totals.projectCount)} projects |{" "}
            {formatCount(snapshot.totals.phaseCount)} phases
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 border-b border-border/60 sm:grid-cols-4 xl:grid-cols-8">
        <StatBlock
          label="Projects"
          value={formatCount(snapshot.totals.projectCount)}
          icon={CircleIcon}
        />
        <StatBlock
          label="Planning"
          value={formatCount(snapshot.totals.planningProjectCount)}
          icon={CheckCircle2Icon}
        />
        <StatBlock
          label="Phases"
          value={formatCount(snapshot.totals.phaseCount)}
          icon={GitBranchIcon}
        />
        <StatBlock
          label="Gates"
          value={formatCount(snapshot.totals.verificationGateCount)}
          icon={ShieldCheckIcon}
        />
        <StatBlock
          label="Your Turn"
          value={formatCount(snapshot.totals.pendingYourTurnCount)}
          icon={AlertTriangleIcon}
        />
        <StatBlock
          label="Agents"
          value={formatCount(snapshot.totals.activeAgentSessionCount)}
          icon={BotIcon}
        />
        <StatBlock
          label="Peers"
          value={formatCount(peers.length || snapshot.totals.peerCount)}
          icon={CircleIcon}
        />
        <StatBlock
          label="Approvals"
          value={formatCount(automode?.pendingApprovalCount ?? 0)}
          icon={PowerIcon}
        />
      </div>

      <div className="grid min-w-0 border-b border-border/60 sm:grid-cols-2 xl:grid-cols-7">
        <SignalRow
          label="Motoko"
          value={hermes?.available ? "ready" : "setup"}
          tone={hermes?.available ? "success" : "warning"}
          detail={
            hermes
              ? (hermes.setupWarnings[0] ??
                `${formatCount(hermes.proposalCount)} proposals | ${hermes.config.hermesHome}`)
              : "Hermes operator status unavailable"
          }
        />
        <SignalRow
          label="Proposals"
          value={formatCount(pendingProposalCount)}
          tone={pendingProposalCount > 0 ? "warning" : "success"}
          detail={topProposal?.title ?? "No pending Motoko proposals"}
        />
        <SignalRow
          label="Capacity"
          value={capacity?.recommendation.recommendedEngine ?? "check"}
          tone={
            capacity?.recommendation.confidence === "high"
              ? "success"
              : capacity
                ? "warning"
                : "default"
          }
          detail={capacity?.recommendation.reason ?? "Provider capacity unavailable"}
        />
        <SignalRow
          label="Delamain"
          value={delamain?.capabilities.available ? "ready" : "offline"}
          tone={delamain?.capabilities.available ? "success" : "warning"}
          detail={`${formatCount(peers.length)} live peers`}
        />
        <SignalRow
          label="Automode"
          value={automode?.policy.mode ?? "unknown"}
          tone={
            automode?.policy.killSwitchEnabled
              ? "warning"
              : automode?.policy.mode === "autonomous"
                ? "success"
                : "default"
          }
          detail={
            automode
              ? `${formatCount(automode.goals.length)} goals | ${formatCount(
                  automode.pendingApprovalCount,
                )} approvals`
              : "Automode state unavailable"
          }
        />
        <SignalRow
          label="Open GSD"
          value={openGsd?.available ? "ready" : "check"}
          tone={openGsd?.available ? "success" : "warning"}
          detail={openGsd?.version ?? openGsd?.packageName ?? "GSD CLI state unavailable"}
        />
        <SignalRow
          label="Resources"
          value={history ? formatPercent(history.topProcesses[0]?.currentCpuPercent ?? 0) : "check"}
          tone={resourceError ? "warning" : history ? "success" : "default"}
          detail={
            resourceError
              ? resourceError.message
              : history
                ? `${formatCount(history.retainedSampleCount)} samples | ${formatCpuTime(
                    history.totalCpuSecondsApprox,
                  )} CPU`
                : "Runtime resource history unavailable"
          }
        />
        <SignalRow
          label="Build"
          value={
            buildInfo?.status === "available"
              ? "ready"
              : buildInfo?.status === "missing"
                ? "missing"
                : "check"
          }
          tone={
            buildInfo?.status === "available"
              ? "success"
              : buildInfo?.status === "missing"
                ? "default"
                : "warning"
          }
          detail={
            buildInfo?.status === "available"
              ? buildInfo.fields
                  .slice(0, 2)
                  .map((field) =>
                    field.label === "Built"
                      ? `${field.label} ${formatIsoDate(field.value)}`
                      : `${field.label} ${field.value}`,
                  )
                  .join(" | ") || "Build metadata detected"
              : buildInfo?.status === "missing"
                ? "No /api/gits/build-info endpoint"
                : "Checking build provenance"
          }
        />
      </div>

      <div className="grid min-w-0 xl:grid-cols-3">
        <DistributionPanel title="Phase states" rows={phaseRows} />
        <DistributionPanel title="Verification gates" rows={gateRows} />
        <DistributionPanel title="Peer status" rows={peerRows} />
      </div>
    </section>
  );
}

function ResourceVisibilityPanel({
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
        <div className="border-b border-border/60 px-4 py-2 text-xs text-destructive sm:px-5">
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

function peerStatusTone(peer: DelamainPeer): ReturnType<typeof statusTone> {
  return statusTone(peer.status);
}

function PeerFleetPanel({
  list,
  loading,
  error,
  selectedPeerId,
  logText,
  logLoading,
  actionError,
  spawnRepo,
  spawnName,
  spawnPrompt,
  replyText,
  actionPending,
  onRefresh,
  onSelectPeer,
  onSpawnRepoChange,
  onSpawnNameChange,
  onSpawnPromptChange,
  onReplyTextChange,
  onSpawn,
  onReply,
  onWait,
  onKill,
  onIntegrate,
}: {
  list: DelamainPeerListResult | undefined;
  loading: boolean;
  error: unknown;
  selectedPeerId: string | null;
  logText: string | undefined;
  logLoading: boolean;
  actionError: unknown;
  spawnRepo: string;
  spawnName: string;
  spawnPrompt: string;
  replyText: string;
  actionPending: boolean;
  onRefresh: () => void;
  onSelectPeer: (peerId: string) => void;
  onSpawnRepoChange: (value: string) => void;
  onSpawnNameChange: (value: string) => void;
  onSpawnPromptChange: (value: string) => void;
  onReplyTextChange: (value: string) => void;
  onSpawn: () => void;
  onReply: () => void;
  onWait: () => void;
  onKill: () => void;
  onIntegrate: () => void;
}) {
  const peers = list?.peers ?? [];
  const selectedPeer = selectedPeerId
    ? (peers.find((peer) => peer.id === selectedPeerId) ?? null)
    : null;
  const supported = new Set(list?.capabilities.supported ?? []);
  const canSpawn =
    supported.has("spawn") && spawnRepo.trim().length > 0 && spawnPrompt.trim().length > 0;
  const canReply = supported.has("reply") && selectedPeer !== null && replyText.trim().length > 0;
  const canWait = supported.has("wait") && selectedPeer !== null;
  const canKill = supported.has("kill") && selectedPeer !== null;
  const canIntegrate = supported.has("integrate") && selectedPeer !== null;
  const errorMessage =
    error instanceof Error
      ? error.message
      : actionError instanceof Error
        ? actionError.message
        : null;

  return (
    <section className="border-b border-border bg-background">
      <div className="flex flex-col gap-3 border-b border-border/70 px-4 py-4 sm:flex-row sm:items-start sm:justify-between sm:px-5">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="truncate text-base font-semibold">Delamain Peer Fleet</h2>
            <StatusPill
              label={list?.capabilities.available ? "available" : "unavailable"}
              tone={list?.capabilities.available ? "success" : "warning"}
            />
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {list?.capabilities.binaryPath ?? "delamain"} |{" "}
            {list ? `${list.capabilities.supported.length} controls detected` : "checking"}
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={onRefresh} disabled={loading}>
          <RefreshCwIcon className={cn("size-3.5", loading && "animate-spin")} />
          Refresh
        </Button>
      </div>

      {errorMessage ? (
        <div className="border-b border-border/60 px-4 py-2 text-xs text-destructive sm:px-5">
          {errorMessage}
        </div>
      ) : null}

      <div className="grid min-w-0 grid-cols-1 xl:grid-cols-[minmax(0,1fr)_minmax(380px,0.8fr)]">
        <div className="min-w-0 border-r border-border/60">
          <SectionHeader title="Peers" count={peers.length} />
          {loading && peers.length === 0 ? (
            <EmptyState label="Loading peers..." />
          ) : peers.length === 0 ? (
            <EmptyState label="No live Delamain peers." />
          ) : (
            <div className="divide-y divide-border/60">
              {peers.map((peer) => (
                <button
                  key={peer.id}
                  type="button"
                  className={cn(
                    "flex w-full min-w-0 cursor-pointer items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/35 sm:px-5",
                    selectedPeerId === peer.id && "bg-muted/55",
                  )}
                  onClick={() => onSelectPeer(peer.id)}
                >
                  <BotIcon className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-xs font-medium">{peer.name ?? peer.id}</span>
                      <StatusPill label={peer.rawStatus} tone={peerStatusTone(peer)} />
                    </div>
                    <div className="mt-1 truncate text-[11px] text-muted-foreground">
                      {peer.engine} | {peer.branch ?? "no branch"} |{" "}
                      {peer.sourceRepo ?? peer.worktreePath ?? "no repo"}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}

          <div className="border-t border-border/60 px-4 py-4 sm:px-5">
            <div className="grid gap-2">
              <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,0.7fr)]">
                <Input
                  nativeInput
                  size="sm"
                  value={spawnRepo}
                  placeholder="Repository path"
                  onChange={(event) => onSpawnRepoChange(event.currentTarget.value)}
                />
                <Input
                  nativeInput
                  size="sm"
                  value={spawnName}
                  placeholder="Peer name"
                  onChange={(event) => onSpawnNameChange(event.currentTarget.value)}
                />
              </div>
              <Textarea
                value={spawnPrompt}
                placeholder="Spawn prompt"
                className="min-h-20 text-xs"
                onChange={(event) => onSpawnPromptChange(event.currentTarget.value)}
              />
              <div className="flex justify-end">
                <Button size="sm" onClick={onSpawn} disabled={!canSpawn || actionPending}>
                  <BotIcon className="size-3.5" />
                  Spawn Peer
                </Button>
              </div>
            </div>
          </div>
        </div>

        <div className="min-w-0">
          <SectionHeader title="Selected peer" count={selectedPeer ? 1 : 0} />
          {selectedPeer ? (
            <div className="grid gap-3 px-4 py-3 text-xs sm:px-5">
              <div className="grid gap-1 text-muted-foreground">
                <div className="truncate">
                  <span className="text-foreground">ID:</span> {selectedPeer.id}
                </div>
                <div className="truncate">
                  <span className="text-foreground">Worktree:</span>{" "}
                  {selectedPeer.worktreePath ?? "none"}
                </div>
                <div className="truncate">
                  <span className="text-foreground">Branch:</span> {selectedPeer.branch ?? "none"}
                </div>
                <div className="truncate">
                  <span className="text-foreground">Merge target:</span>{" "}
                  {selectedPeer.mergeBranch ?? selectedPeer.baseBranch ?? "none"}
                </div>
                <div className="truncate">
                  <span className="text-foreground">PR:</span>{" "}
                  {selectedPeer.prUrl ? (
                    <a
                      href={selectedPeer.prUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-primary underline-offset-2 hover:underline"
                    >
                      {selectedPeer.prUrl}
                    </a>
                  ) : (
                    "none"
                  )}
                </div>
                <div className="truncate">
                  <span className="text-foreground">Integration:</span>{" "}
                  {selectedPeer.integrationStatus ?? "none"}
                </div>
                <div className="truncate">
                  <span className="text-foreground">Last event:</span>{" "}
                  {selectedPeer.lastEvent ?? "none"}
                </div>
              </div>
              <div className="grid gap-2">
                <Textarea
                  value={replyText}
                  placeholder="Reply to this peer"
                  className="min-h-20 text-xs"
                  onChange={(event) => onReplyTextChange(event.currentTarget.value)}
                />
                <div className="flex flex-wrap justify-end gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={onReply}
                    disabled={!canReply || actionPending}
                  >
                    <SendIcon className="size-3.5" />
                    Reply
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive-outline"
                    onClick={onKill}
                    disabled={!canKill || actionPending}
                  >
                    <CircleStopIcon className="size-3.5" />
                    Kill
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={onWait}
                    disabled={!canWait || actionPending}
                  >
                    <ListChecksIcon className="size-3.5" />
                    Wait
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={onIntegrate}
                    disabled={!canIntegrate || actionPending}
                  >
                    <GitBranchIcon className="size-3.5" />
                    Integrate
                  </Button>
                </div>
              </div>
              <div className="overflow-hidden rounded-md border border-border/70 bg-muted/20">
                <div className="border-b border-border/60 px-3 py-2 font-medium text-muted-foreground">
                  Log
                </div>
                <pre className="max-h-80 overflow-auto whitespace-pre-wrap px-3 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
                  {logLoading ? "Loading log..." : logText || "No log output."}
                </pre>
              </div>
            </div>
          ) : (
            <EmptyState label="Select a peer to inspect logs and controls." />
          )}
        </div>
      </div>
    </section>
  );
}

function commandResultTone(status: OpenGsdCommandResult["status"]): ReturnType<typeof statusTone> {
  if (status === "completed") {
    return "success";
  }
  return status === "timed-out" ? "warning" : "danger";
}

function hermesCommandResultTone(
  status: HermesCommandResult["status"],
): ReturnType<typeof statusTone> {
  if (status === "completed" || status === "started") {
    return "success";
  }
  if (status === "action-required" || status === "timed-out") {
    return "warning";
  }
  return "danger";
}

function hermesProposalTone(status: HermesProposalCard["status"]): ReturnType<typeof statusTone> {
  if (status === "approved" || status === "drafted") {
    return "success";
  }
  if (status === "blocked" || status === "rejected") {
    return "danger";
  }
  if (status === "deferred") {
    return "default";
  }
  return "warning";
}

const MOTOKO_SCHEDULE_OPTIONS: ReadonlyArray<{
  readonly value: HermesScheduleKind;
  readonly label: string;
}> = [
  { value: "daily-briefing", label: "Daily briefing" },
  { value: "weekly-stale-scan", label: "Weekly stale scan" },
  { value: "tailnet-health", label: "Tailnet health" },
  { value: "skills-review", label: "Skills review" },
  { value: "memory-review", label: "Memory review" },
  { value: "verification-sentinel", label: "Verification sentinel" },
];

function MotokoPanel({
  status,
  capacity,
  sessions,
  log,
  proposals,
  loading,
  error,
  actionError,
  commandResult,
  draft,
  scheduleResult,
  selectedProjectRoot,
  chatInput,
  scheduleKind,
  actionPending,
  onRefresh,
  onProjectRootChange,
  onChatInputChange,
  onScheduleKindChange,
  onCheck,
  onSetupCodexOAuth,
  onStartAcp,
  onInspectGits,
  onChatSubmit,
  onDecision,
  onWriteContext,
  onDraft,
  onRunSchedule,
}: {
  status: HermesStatusResult | undefined;
  capacity: GitsCapacitySnapshot | undefined;
  sessions: HermesSessionListResult | undefined;
  log: HermesLogTailResult | undefined;
  proposals: HermesProposalListResult | undefined;
  loading: boolean;
  error: unknown;
  actionError: unknown;
  commandResult: HermesCommandResult | undefined;
  draft: HermesExecutionDraft | undefined;
  scheduleResult: HermesScheduleRunResult | undefined;
  selectedProjectRoot: string;
  chatInput: string;
  scheduleKind: HermesScheduleKind;
  actionPending: boolean;
  onRefresh: () => void;
  onProjectRootChange: (value: string) => void;
  onChatInputChange: (value: string) => void;
  onScheduleKindChange: (value: HermesScheduleKind) => void;
  onCheck: () => void;
  onSetupCodexOAuth: () => void;
  onStartAcp: () => void;
  onInspectGits: () => void;
  onChatSubmit: () => void;
  onDecision: (proposalId: string, decision: "approve" | "reject" | "defer") => void;
  onWriteContext: () => void;
  onDraft: (proposalId: string) => void;
  onRunSchedule: () => void;
}) {
  const cards = proposals?.proposals ?? [];
  const errorMessage =
    error instanceof Error
      ? error.message
      : actionError instanceof Error
        ? actionError.message
        : null;
  const pendingCount = cards.filter((proposal) => proposal.status === "proposed").length;

  return (
    <section className="border-b border-border bg-background">
      <div className="flex flex-col gap-3 border-b border-border/70 px-4 py-4 sm:flex-row sm:items-start sm:justify-between sm:px-5">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="truncate text-base font-semibold">Motoko</h2>
            <StatusPill
              label={status?.available ? "ready" : "setup"}
              tone={status?.available ? "success" : "warning"}
            />
            <StatusPill
              label={status?.acp.available ? "ACP" : "ACP check"}
              tone={status?.acp.available ? "success" : "warning"}
            />
          </div>
          <p className="mt-1 truncate text-xs text-muted-foreground">
            Hermes operator for GITS | {status?.version ?? "version unknown"} |{" "}
            {status?.config.hermesHome ?? "~/.gits/hermes"}
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={onRefresh} disabled={loading}>
          <RefreshCwIcon className={cn("size-3.5", loading && "animate-spin")} />
          Refresh
        </Button>
      </div>

      {errorMessage ? (
        <div className="border-b border-border/60 px-4 py-2 text-xs text-destructive sm:px-5">
          {errorMessage}
        </div>
      ) : null}

      <div className="grid grid-cols-2 border-b border-border/60 sm:grid-cols-4 xl:grid-cols-6">
        <StatBlock label="Proposals" value={formatCount(cards.length)} icon={SparklesIcon} />
        <StatBlock label="Pending" value={formatCount(pendingCount)} icon={AlertTriangleIcon} />
        <StatBlock
          label="OAuth"
          value={status?.codexAuth.source ?? "unknown"}
          icon={ShieldCheckIcon}
        />
        <StatBlock label="Mode" value={status?.config.approvalMode ?? "unknown"} icon={PowerIcon} />
        <StatBlock
          label="Router"
          value={capacity?.recommendation.recommendedEngine ?? "check"}
          icon={BotIcon}
        />
        <StatBlock
          label="Sessions"
          value={formatCount(sessions?.sessions.length ?? 0)}
          icon={BotIcon}
        />
      </div>

      {status?.setupWarnings.length ? (
        <div className="divide-y divide-border/60 border-b border-border/60">
          {status.setupWarnings.slice(0, 5).map((warning) => (
            <div key={warning} className="px-4 py-2 text-xs text-amber-600 sm:px-5">
              {warning}
            </div>
          ))}
        </div>
      ) : null}

      <div className="grid min-w-0 grid-cols-1 xl:grid-cols-[minmax(0,1fr)_minmax(380px,0.8fr)]">
        <div className="min-w-0 border-r border-border/60">
          <div className="grid gap-2 border-b border-border/60 px-4 py-4 sm:px-5">
            <Input
              nativeInput
              size="sm"
              value={selectedProjectRoot}
              placeholder="Selected project root"
              onChange={(event) => onProjectRootChange(event.currentTarget.value)}
            />
            <Textarea
              value={chatInput}
              placeholder="Ask Motoko"
              className="min-h-24 text-xs"
              onChange={(event) => onChatInputChange(event.currentTarget.value)}
            />
            <div className="flex flex-wrap justify-end gap-2">
              <Button size="sm" variant="outline" onClick={onCheck} disabled={actionPending}>
                <CheckCircle2Icon className="size-3.5" />
                Check
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={onSetupCodexOAuth}
                disabled={actionPending}
              >
                <ShieldCheckIcon className="size-3.5" />
                Setup OAuth
              </Button>
              <Button size="sm" variant="outline" onClick={onStartAcp} disabled={actionPending}>
                <BotIcon className="size-3.5" />
                Start ACP
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={onWriteContext}
                disabled={actionPending || selectedProjectRoot.trim().length === 0}
              >
                <FilePlus2Icon className="size-3.5" />
                Write Context
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={onInspectGits}
                disabled={actionPending || selectedProjectRoot.trim().length === 0}
              >
                <SearchIcon className="size-3.5" />
                Inspect
              </Button>
              <Button
                size="sm"
                onClick={onChatSubmit}
                disabled={actionPending || chatInput.trim().length === 0}
              >
                <SendIcon className="size-3.5" />
                Ask
              </Button>
            </div>
          </div>

          <div className="grid gap-2 border-b border-border/60 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:px-5">
            <select
              value={scheduleKind}
              className="h-8 min-w-0 rounded-md border border-input bg-background px-3 text-xs"
              onChange={(event) =>
                onScheduleKindChange(event.currentTarget.value as HermesScheduleKind)
              }
            >
              {MOTOKO_SCHEDULE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <Button size="sm" variant="outline" onClick={onRunSchedule} disabled={actionPending}>
              <PlayIcon className="size-3.5" />
              Run
            </Button>
          </div>

          <SectionHeader title="Proposal cards" count={cards.length} />
          {loading && cards.length === 0 ? (
            <EmptyState label="Loading Motoko proposals..." />
          ) : cards.length === 0 ? (
            <EmptyState label="No Motoko proposals." />
          ) : (
            <div className="divide-y divide-border/60">
              {cards.slice(0, 80).map((proposal) => (
                <div key={proposal.id} className="grid gap-3 px-4 py-3 text-xs sm:px-5">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                      {proposal.title}
                    </span>
                    <StatusPill
                      label={proposal.status}
                      tone={hermesProposalTone(proposal.status)}
                    />
                    <StatusPill
                      label={proposal.risk}
                      tone={proposal.risk === "blocked" ? "danger" : "default"}
                    />
                    <StatusPill label={proposal.recommendedExecutor} tone="default" />
                  </div>
                  <p className="line-clamp-3 text-muted-foreground">{proposal.summary}</p>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <div>
                      <div className="mb-1 text-[11px] font-medium uppercase text-muted-foreground/80">
                        Evidence
                      </div>
                      <ul className="grid gap-1 text-[11px] text-muted-foreground">
                        {proposal.evidence.slice(0, 3).map((item) => (
                          <li key={item} className="line-clamp-2">
                            {item}
                          </li>
                        ))}
                      </ul>
                    </div>
                    <div>
                      <div className="mb-1 text-[11px] font-medium uppercase text-muted-foreground/80">
                        Verification
                      </div>
                      <ul className="grid gap-1 text-[11px] text-muted-foreground">
                        {proposal.verificationPlan.slice(0, 3).map((item) => (
                          <li key={item} className="line-clamp-2">
                            {item}
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                  {proposal.blockedReason ? (
                    <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-[11px] text-destructive">
                      {proposal.blockedReason}
                    </div>
                  ) : null}
                  <div className="flex flex-wrap justify-end gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => onDecision(proposal.id, "defer")}
                      disabled={actionPending}
                    >
                      Defer
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive-outline"
                      onClick={() => onDecision(proposal.id, "reject")}
                      disabled={actionPending}
                    >
                      Reject
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => onDecision(proposal.id, "approve")}
                      disabled={actionPending || proposal.status === "blocked"}
                    >
                      Approve
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => onDraft(proposal.id)}
                      disabled={actionPending || proposal.status !== "approved"}
                    >
                      Draft
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="min-w-0">
          <SectionHeader title="Result" count={commandResult || draft || scheduleResult ? 1 : 0} />
          <div className="grid gap-3 px-4 py-3 text-xs sm:px-5">
            {commandResult ? (
              <div className="grid gap-2 rounded-md border border-border/70 bg-muted/20 px-3 py-2">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <StatusPill
                    label={commandResult.status}
                    tone={hermesCommandResultTone(commandResult.status)}
                  />
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {commandResult.action} | {formatCount(commandResult.durationMs)} ms
                  </span>
                </div>
                <pre className="max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-muted-foreground">
                  {[commandResult.stdout, commandResult.stderr].filter(Boolean).join("\n") ||
                    "No command output."}
                </pre>
              </div>
            ) : null}
            {draft ? (
              <div className="grid gap-2 rounded-md border border-border/70 bg-muted/20 px-3 py-2">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <StatusPill
                    label={draft.status}
                    tone={draft.status === "draft" ? "success" : "danger"}
                  />
                  <StatusPill label={draft.kind} tone="default" />
                </div>
                <div className="truncate font-medium">{draft.title}</div>
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-muted-foreground">
                  {draft.prompt}
                </pre>
              </div>
            ) : null}
            {scheduleResult ? (
              <div className="grid gap-2 rounded-md border border-border/70 bg-muted/20 px-3 py-2">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <StatusPill
                    label={scheduleResult.blockedReason ? "blocked" : scheduleResult.kind}
                    tone={scheduleResult.blockedReason ? "danger" : "success"}
                  />
                  <span className="text-muted-foreground">
                    {formatIsoDate(scheduleResult.ranAt)}
                  </span>
                </div>
                <div className="text-muted-foreground">
                  {scheduleResult.blockedReason ??
                    `${formatCount(scheduleResult.proposals.length)} proposal cards generated.`}
                </div>
              </div>
            ) : null}
            <div className="overflow-hidden rounded-md border border-border/70 bg-muted/20">
              <div className="border-b border-border/60 px-3 py-2 font-medium text-muted-foreground">
                Log
              </div>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap px-3 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
                {log?.text ?? "No Hermes log output."}
              </pre>
            </div>
            <div className="overflow-hidden rounded-md border border-border/70 bg-muted/20">
              <div className="border-b border-border/60 px-3 py-2 font-medium text-muted-foreground">
                Sessions
              </div>
              {(sessions?.sessions.length ?? 0) === 0 ? (
                <EmptyState label="No Hermes sessions found." />
              ) : (
                <div className="divide-y divide-border/60">
                  {sessions?.sessions.map((session) => (
                    <div key={session.id} className="px-3 py-2">
                      <div className="truncate font-mono text-[11px] text-foreground">
                        {session.id}
                      </div>
                      <div className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">
                        {session.title ?? session.summary ?? session.status}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function OpenGsdPanel({
  status,
  loading,
  error,
  projects,
  selectedProjectRoot,
  initInput,
  autoInitInput,
  model,
  maxBudget,
  commandResult,
  actionError,
  actionPending,
  onRefresh,
  onProjectRootChange,
  onInitInputChange,
  onAutoInitInputChange,
  onModelChange,
  onMaxBudgetChange,
  onInit,
  onAuto,
}: {
  status: OpenGsdStatusResult | undefined;
  loading: boolean;
  error: unknown;
  projects: ReadonlyArray<GitsCockpitProject>;
  selectedProjectRoot: string;
  initInput: string;
  autoInitInput: string;
  model: string;
  maxBudget: string;
  commandResult: OpenGsdCommandResult | undefined;
  actionError: unknown;
  actionPending: boolean;
  onRefresh: () => void;
  onProjectRootChange: (value: string) => void;
  onInitInputChange: (value: string) => void;
  onAutoInitInputChange: (value: string) => void;
  onModelChange: (value: string) => void;
  onMaxBudgetChange: (value: string) => void;
  onInit: () => void;
  onAuto: () => void;
}) {
  const supported = new Set(status?.supported ?? []);
  const canInit =
    supported.has("init") && selectedProjectRoot.trim().length > 0 && initInput.trim().length > 0;
  const canAuto = supported.has("auto") && selectedProjectRoot.trim().length > 0;
  const errorMessage =
    error instanceof Error
      ? error.message
      : actionError instanceof Error
        ? actionError.message
        : null;

  return (
    <section className="border-b border-border bg-background">
      <div className="flex flex-col gap-3 border-b border-border/70 px-4 py-4 sm:flex-row sm:items-start sm:justify-between sm:px-5">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="truncate text-base font-semibold">Open GSD</h2>
            <StatusPill
              label={status?.available ? "available" : "unavailable"}
              tone={status?.available ? "success" : "warning"}
            />
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {status?.cliName ?? "gsd-sdk"} | {status?.packageName ?? "@opengsd/get-shit-done-redux"}{" "}
            | {status?.version ?? "version unknown"}
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={onRefresh} disabled={loading}>
          <RefreshCwIcon className={cn("size-3.5", loading && "animate-spin")} />
          Refresh
        </Button>
      </div>

      {errorMessage ? (
        <div className="border-b border-border/60 px-4 py-2 text-xs text-destructive sm:px-5">
          {errorMessage}
        </div>
      ) : null}

      <div className="grid min-w-0 grid-cols-1 xl:grid-cols-[minmax(0,1fr)_minmax(380px,0.8fr)]">
        <div className="grid min-w-0 gap-3 border-r border-border/60 px-4 py-4 sm:px-5">
          <select
            value={selectedProjectRoot}
            className="h-8 min-w-0 rounded-md border border-input bg-background px-3 text-xs"
            onChange={(event) => onProjectRootChange(event.currentTarget.value)}
          >
            {projects.length === 0 ? (
              <option value="">No project</option>
            ) : (
              projects.map((project) => (
                <option key={project.project.id} value={project.project.rootPath}>
                  {project.project.title}
                </option>
              ))
            )}
          </select>

          <div className="grid gap-2 sm:grid-cols-2">
            <Input
              nativeInput
              size="sm"
              value={model}
              placeholder="Model"
              onChange={(event) => onModelChange(event.currentTarget.value)}
            />
            <Input
              nativeInput
              size="sm"
              value={maxBudget}
              placeholder="Max budget USD"
              onChange={(event) => onMaxBudgetChange(event.currentTarget.value)}
            />
          </div>

          <div className="grid gap-2">
            <Input
              nativeInput
              size="sm"
              value={initInput}
              placeholder="@docs/prd.md"
              onChange={(event) => onInitInputChange(event.currentTarget.value)}
            />
            <div className="flex justify-end">
              <Button size="sm" onClick={onInit} disabled={!canInit || actionPending}>
                <FilePlus2Icon className="size-3.5" />
                Init
              </Button>
            </div>
          </div>

          <div className="grid gap-2">
            <Input
              nativeInput
              size="sm"
              value={autoInitInput}
              placeholder="Optional @prd"
              onChange={(event) => onAutoInitInputChange(event.currentTarget.value)}
            />
            <div className="flex justify-end">
              <Button
                size="sm"
                variant="outline"
                onClick={onAuto}
                disabled={!canAuto || actionPending}
              >
                <PlayIcon className="size-3.5" />
                Auto
              </Button>
            </div>
          </div>
        </div>

        <div className="min-w-0">
          <SectionHeader title="Last Open GSD run" count={commandResult ? 1 : 0} />
          {commandResult ? (
            <div className="grid gap-3 px-4 py-3 text-xs sm:px-5">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <StatusPill
                  label={commandResult.status}
                  tone={commandResultTone(commandResult.status)}
                />
                <span className="font-mono text-muted-foreground">
                  {commandResult.command} | {formatCount(commandResult.durationMs)} ms
                </span>
              </div>
              <div className="truncate font-mono text-[11px] text-muted-foreground">
                {commandResult.args.join(" ")}
              </div>
              <div className="overflow-hidden rounded-md border border-border/70 bg-muted/20">
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap px-3 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
                  {[commandResult.stdout, commandResult.stderr].filter(Boolean).join("\n") ||
                    "No command output."}
                </pre>
              </div>
            </div>
          ) : (
            <EmptyState label="No Open GSD command has run in this cockpit session." />
          )}
        </div>
      </div>
    </section>
  );
}

function SkillsPanel({
  snapshot,
  loading,
  error,
  reviews,
  onRefresh,
  onRatingChange,
  onReviewChange,
}: {
  snapshot: GitsSkillInventorySnapshot | undefined;
  loading: boolean;
  error: unknown;
  reviews: SkillReviewState;
  onRefresh: () => void;
  onRatingChange: (skillId: string, rating: number | null) => void;
  onReviewChange: (skillId: string, review: string) => void;
}) {
  const [providerFilter, setProviderFilter] = useState<GitsSkillProvider | "all">("all");
  const [search, setSearch] = useState("");
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const skills = useMemo(
    () => (snapshot?.skills ?? []).map((skill) => applySkillReviews(skill, reviews)),
    [reviews, snapshot?.skills],
  );
  const visibleSkills = useMemo(() => {
    const query = search.trim().toLowerCase();
    return skills.filter((skill) => {
      if (providerFilter !== "all" && skill.provider !== providerFilter) {
        return false;
      }
      if (!query) {
        return true;
      }
      return [
        skill.name,
        skill.title,
        skill.description ?? "",
        skill.path,
        skill.provider,
        skill.kind,
        skill.portability,
      ]
        .join(" ")
        .toLowerCase()
        .includes(query);
    });
  }, [providerFilter, search, skills]);
  const selectedSkill =
    (selectedSkillId ? skills.find((skill) => skill.id === selectedSkillId) : null) ??
    visibleSkills[0] ??
    null;
  const ratedCount = skills.filter((skill) => skill.rating !== null).length;
  const reviewedCount = skills.filter((skill) => skill.review !== null).length;
  const errorMessage = error instanceof Error ? error.message : null;

  useEffect(() => {
    if (selectedSkillId && visibleSkills.some((skill) => skill.id === selectedSkillId)) {
      return;
    }
    setSelectedSkillId(visibleSkills[0]?.id ?? null);
  }, [selectedSkillId, visibleSkills]);

  return (
    <section className="border-b border-border bg-background">
      <div className="flex flex-col gap-3 border-b border-border/70 px-4 py-4 sm:flex-row sm:items-start sm:justify-between sm:px-5">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="truncate text-base font-semibold">Skills Intelligence</h2>
            <StatusPill
              label={loading && !snapshot ? "scanning" : "read-only"}
              tone={loading && !snapshot ? "warning" : "success"}
            />
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {formatCount(snapshot?.totals.skillCount ?? 0)} skills |{" "}
            {formatCount(snapshot?.totals.missingPortCount ?? 0)} missing ports |{" "}
            {formatCount(ratedCount)} rated | {formatCount(reviewedCount)} reviewed
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={onRefresh} disabled={loading}>
          <RefreshCwIcon className={cn("size-3.5", loading && "animate-spin")} />
          Refresh
        </Button>
      </div>

      {errorMessage ? (
        <div className="border-b border-border/60 px-4 py-2 text-xs text-destructive sm:px-5">
          {errorMessage}
        </div>
      ) : null}

      <div className="grid grid-cols-2 border-b border-border/60 sm:grid-cols-4">
        <StatBlock
          label="Skills"
          value={formatCount(snapshot?.totals.skillCount ?? 0)}
          icon={BookOpenCheckIcon}
        />
        <StatBlock
          label="Providers"
          value={formatCount(snapshot?.totals.providerCount ?? 0)}
          icon={CircleIcon}
        />
        <StatBlock
          label="Missing Ports"
          value={formatCount(snapshot?.totals.missingPortCount ?? 0)}
          icon={GitBranchIcon}
        />
        <StatBlock
          label="HERMES"
          value={formatCount(snapshot?.totals.hermesCandidateCount ?? 0)}
          icon={SparklesIcon}
        />
      </div>

      <div className="grid min-w-0 grid-cols-1 xl:grid-cols-[minmax(0,1fr)_minmax(380px,0.85fr)]">
        <div className="min-w-0 border-r border-border/60">
          <div className="grid gap-2 border-b border-border/60 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_180px] sm:px-5">
            <div className="relative min-w-0">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                nativeInput
                size="sm"
                value={search}
                placeholder="Search skills"
                className="pl-8"
                onChange={(event) => setSearch(event.currentTarget.value)}
              />
            </div>
            <select
              value={providerFilter}
              className="h-8 min-w-0 rounded-md border border-input bg-background px-3 text-xs"
              onChange={(event) =>
                setProviderFilter(event.currentTarget.value as GitsSkillProvider | "all")
              }
            >
              <option value="all">All providers</option>
              <option value="codex">Codex</option>
              <option value="claude">Claude</option>
              <option value="cursor">Cursor</option>
            </select>
          </div>

          <SectionHeader title="Inventory" count={visibleSkills.length} />
          {loading && visibleSkills.length === 0 ? (
            <EmptyState label="Scanning local provider skills..." />
          ) : visibleSkills.length === 0 ? (
            <EmptyState label="No skills match the current filters." />
          ) : (
            <div className="divide-y divide-border/60">
              {visibleSkills.slice(0, 160).map((skill) => (
                <button
                  key={skill.id}
                  type="button"
                  className={cn(
                    "flex w-full min-w-0 cursor-pointer items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/35 sm:px-5",
                    selectedSkill?.id === skill.id && "bg-muted/55",
                  )}
                  onClick={() => setSelectedSkillId(skill.id)}
                >
                  <BookOpenCheckIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <span className="truncate text-xs font-medium">{skill.title}</span>
                      <StatusPill label={formatSkillProvider(skill.provider)} tone="default" />
                      <StatusPill
                        label={skill.portability.replaceAll("-", " ")}
                        tone={portabilityTone(skill.portability)}
                      />
                    </div>
                    <div className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">
                      {skill.description ?? skill.path}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="min-w-0">
          <SectionHeader title="Review" count={selectedSkill ? 1 : 0} />
          {selectedSkill ? (
            <div className="grid gap-4 px-4 py-4 text-xs sm:px-5">
              <div className="min-w-0">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <h3 className="truncate text-sm font-semibold">{selectedSkill.title}</h3>
                  <StatusPill
                    label={`${formatSkillProvider(selectedSkill.provider)} ${formatSkillKind(
                      selectedSkill.kind,
                    )}`}
                    tone="default"
                  />
                </div>
                <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                  {selectedSkill.path}
                </div>
                {selectedSkill.description ? (
                  <p className="mt-2 text-muted-foreground">{selectedSkill.description}</p>
                ) : null}
              </div>

              <div className="grid gap-2">
                <div className="text-[11px] font-medium uppercase text-muted-foreground/80">
                  Rating
                </div>
                <div className="flex flex-wrap gap-1">
                  {[1, 2, 3, 4, 5].map((rating) => {
                    const selected = (selectedSkill.rating ?? 0) >= rating;
                    return (
                      <Button
                        key={rating}
                        size="icon-sm"
                        variant={selected ? "default" : "outline"}
                        onClick={() =>
                          onRatingChange(
                            selectedSkill.id,
                            selectedSkill.rating === rating ? null : rating,
                          )
                        }
                        aria-label={`Rate ${rating}`}
                      >
                        <StarIcon className={cn("size-3.5", selected && "fill-current")} />
                      </Button>
                    );
                  })}
                </div>
              </div>

              <div className="grid gap-2">
                <div className="text-[11px] font-medium uppercase text-muted-foreground/80">
                  Review
                </div>
                <Textarea
                  value={reviews[selectedSkill.id]?.review ?? ""}
                  placeholder="Notes, quality issues, porting ideas"
                  className="min-h-28 text-xs"
                  onChange={(event) => onReviewChange(selectedSkill.id, event.currentTarget.value)}
                />
              </div>

              <div className="grid gap-2">
                <SectionHeader title="Provider summaries" count={snapshot?.providers.length ?? 0} />
                <div className="overflow-hidden rounded-md border border-border/70">
                  {(snapshot?.providers ?? []).map((provider) => (
                    <div
                      key={provider.provider}
                      className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-3 border-b border-border/60 px-3 py-2 last:border-b-0"
                    >
                      <span className="truncate font-medium">
                        {formatSkillProvider(provider.provider)}
                      </span>
                      <span className="font-mono text-muted-foreground">
                        {formatCount(provider.totalCount)}
                      </span>
                      <span className="font-mono text-muted-foreground">
                        {formatCount(provider.missingPortCount)} ports
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="grid gap-2">
                <SectionHeader title="Insights" count={snapshot?.insights.length ?? 0} />
                {(snapshot?.insights ?? []).length === 0 ? (
                  <EmptyState label="No skill insights yet." />
                ) : (
                  <div className="grid gap-2">
                    {(snapshot?.insights ?? []).map((insight) => (
                      <div key={insight.id} className="rounded-md border border-border/70 p-3">
                        <div className="flex min-w-0 items-center gap-2">
                          <SparklesIcon className="size-3.5 shrink-0 text-muted-foreground" />
                          <span className="truncate font-medium">{insight.title}</span>
                          <StatusPill
                            label={insight.severity}
                            tone={statusTone(insight.severity)}
                          />
                        </div>
                        <p className="mt-1 text-muted-foreground">{insight.detail}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {(snapshot?.warnings ?? []).length > 0 ? (
                <div className="rounded-md border border-amber-500/25 bg-amber-500/5 p-3 text-amber-700 dark:text-amber-300">
                  {(snapshot?.warnings ?? []).slice(0, 3).join(" | ")}
                </div>
              ) : null}
            </div>
          ) : (
            <EmptyState label="Select a skill to review." />
          )}
        </div>
      </div>
    </section>
  );
}

function parseLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function automodeGoalTone(goal: AutomodeGoal): ReturnType<typeof statusTone> {
  if (goal.status === "running" || goal.status === "completed") {
    return "success";
  }
  if (goal.status === "waiting-approval" || goal.status === "queued") {
    return "warning";
  }
  if (goal.status === "blocked" || goal.status === "failed" || goal.status === "rejected") {
    return "danger";
  }
  return "default";
}

function AutomodePanel({
  snapshot,
  loading,
  error,
  actionError,
  actionPending,
  policyMode,
  killSwitchEnabled,
  maxActivePeers,
  allowedRepos,
  allowedModels,
  defaultModel,
  maxBudget,
  maxRuntime,
  requireSpawnApproval,
  requireIntegrateApproval,
  requireDestructiveApproval,
  goalTitle,
  goalRepo,
  goalModel,
  goalPrompt,
  onRefresh,
  onPolicyModeChange,
  onKillSwitchChange,
  onMaxActivePeersChange,
  onAllowedReposChange,
  onAllowedModelsChange,
  onDefaultModelChange,
  onMaxBudgetChange,
  onMaxRuntimeChange,
  onRequireSpawnApprovalChange,
  onRequireIntegrateApprovalChange,
  onRequireDestructiveApprovalChange,
  onGoalTitleChange,
  onGoalRepoChange,
  onGoalModelChange,
  onGoalPromptChange,
  onSavePolicy,
  onEnqueueGoal,
  onApproveGoal,
  onRejectGoal,
  onDispatchGoal,
}: {
  snapshot: AutomodeSnapshot | undefined;
  loading: boolean;
  error: unknown;
  actionError: unknown;
  actionPending: boolean;
  policyMode: AutomodeSnapshot["policy"]["mode"];
  killSwitchEnabled: boolean;
  maxActivePeers: string;
  allowedRepos: string;
  allowedModels: string;
  defaultModel: string;
  maxBudget: string;
  maxRuntime: string;
  requireSpawnApproval: boolean;
  requireIntegrateApproval: boolean;
  requireDestructiveApproval: boolean;
  goalTitle: string;
  goalRepo: string;
  goalModel: string;
  goalPrompt: string;
  onRefresh: () => void;
  onPolicyModeChange: (value: AutomodeSnapshot["policy"]["mode"]) => void;
  onKillSwitchChange: (value: boolean) => void;
  onMaxActivePeersChange: (value: string) => void;
  onAllowedReposChange: (value: string) => void;
  onAllowedModelsChange: (value: string) => void;
  onDefaultModelChange: (value: string) => void;
  onMaxBudgetChange: (value: string) => void;
  onMaxRuntimeChange: (value: string) => void;
  onRequireSpawnApprovalChange: (value: boolean) => void;
  onRequireIntegrateApprovalChange: (value: boolean) => void;
  onRequireDestructiveApprovalChange: (value: boolean) => void;
  onGoalTitleChange: (value: string) => void;
  onGoalRepoChange: (value: string) => void;
  onGoalModelChange: (value: string) => void;
  onGoalPromptChange: (value: string) => void;
  onSavePolicy: () => void;
  onEnqueueGoal: () => void;
  onApproveGoal: (goalId: string) => void;
  onRejectGoal: (goalId: string) => void;
  onDispatchGoal: (goalId: string) => void;
}) {
  const goals = snapshot?.goals ?? [];
  const budgetUsage = snapshot?.budgetUsage;
  const policyBudget = snapshot?.policy.maxBudgetUsd ?? null;
  const budgetStatus =
    policyBudget === null
      ? "No budget cap"
      : budgetUsage?.totalCostUsd !== null && budgetUsage?.totalCostUsd !== undefined
        ? `${formatUsd(budgetUsage.totalCostUsd)} / ${formatUsd(policyBudget)}`
        : `unavailable / ${formatUsd(policyBudget)}`;
  const tokenStatus =
    budgetUsage?.totalProcessedTokens !== null && budgetUsage?.totalProcessedTokens !== undefined
      ? `${formatCount(budgetUsage.totalProcessedTokens)} tokens`
      : "tokens unavailable";
  const canEnqueue =
    goalTitle.trim().length > 0 && goalRepo.trim().length > 0 && goalPrompt.trim().length > 0;
  const errorMessage =
    error instanceof Error
      ? error.message
      : actionError instanceof Error
        ? actionError.message
        : null;

  return (
    <section className="border-b border-border bg-background">
      <div className="flex flex-col gap-3 border-b border-border/70 px-4 py-4 sm:flex-row sm:items-start sm:justify-between sm:px-5">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="truncate text-base font-semibold">Automode</h2>
            <StatusPill label={snapshot?.policy.mode ?? "manual"} tone="default" />
            <StatusPill
              label={snapshot?.policy.killSwitchEnabled ? "kill switch" : "armed"}
              tone={snapshot?.policy.killSwitchEnabled ? "danger" : "success"}
            />
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {formatCount(snapshot?.activePeerCount ?? 0)} active peers |{" "}
            {formatCount(snapshot?.pendingApprovalCount ?? 0)} approvals | {budgetStatus} |{" "}
            {tokenStatus}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={onRefresh} disabled={loading}>
            <RefreshCwIcon className={cn("size-3.5", loading && "animate-spin")} />
            Refresh
          </Button>
          <Button
            size="sm"
            variant={killSwitchEnabled ? "outline" : "destructive-outline"}
            onClick={() => onKillSwitchChange(!killSwitchEnabled)}
            disabled={actionPending}
          >
            <PowerIcon className="size-3.5" />
            {killSwitchEnabled ? "Arm" : "Kill"}
          </Button>
        </div>
      </div>

      {errorMessage ? (
        <div className="border-b border-border/60 px-4 py-2 text-xs text-destructive sm:px-5">
          {errorMessage}
        </div>
      ) : null}

      <div className="grid min-w-0 grid-cols-1 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <div className="grid min-w-0 gap-3 border-r border-border/60 px-4 py-4 sm:px-5">
          <div className="grid gap-2 sm:grid-cols-2">
            <select
              value={policyMode}
              className="h-8 min-w-0 rounded-md border border-input bg-background px-3 text-xs"
              onChange={(event) =>
                onPolicyModeChange(event.currentTarget.value as AutomodeSnapshot["policy"]["mode"])
              }
            >
              <option value="manual">manual</option>
              <option value="supervised">supervised</option>
              <option value="autonomous">autonomous</option>
            </select>
            <Input
              nativeInput
              size="sm"
              value={maxActivePeers}
              placeholder="Max active peers"
              onChange={(event) => onMaxActivePeersChange(event.currentTarget.value)}
            />
          </div>

          <div className="grid gap-2 sm:grid-cols-3">
            <Input
              nativeInput
              size="sm"
              value={defaultModel}
              placeholder="Default model"
              onChange={(event) => onDefaultModelChange(event.currentTarget.value)}
            />
            <Input
              nativeInput
              size="sm"
              value={maxBudget}
              placeholder="Max budget USD"
              onChange={(event) => onMaxBudgetChange(event.currentTarget.value)}
            />
            <Input
              nativeInput
              size="sm"
              value={maxRuntime}
              placeholder="Max runtime min"
              onChange={(event) => onMaxRuntimeChange(event.currentTarget.value)}
            />
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            <Textarea
              value={allowedRepos}
              placeholder="Allowed repos"
              className="min-h-24 text-xs"
              onChange={(event) => onAllowedReposChange(event.currentTarget.value)}
            />
            <Textarea
              value={allowedModels}
              placeholder="Allowed models"
              className="min-h-24 text-xs"
              onChange={(event) => onAllowedModelsChange(event.currentTarget.value)}
            />
          </div>

          <div className="grid gap-2 text-xs text-muted-foreground">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={requireSpawnApproval}
                onChange={(event) => onRequireSpawnApprovalChange(event.currentTarget.checked)}
              />
              Peer spawn approval
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={requireIntegrateApproval}
                onChange={(event) => onRequireIntegrateApprovalChange(event.currentTarget.checked)}
              />
              Integrate approval
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={requireDestructiveApproval}
                onChange={(event) =>
                  onRequireDestructiveApprovalChange(event.currentTarget.checked)
                }
              />
              Destructive approval
            </label>
          </div>

          <div className="flex justify-end">
            <Button size="sm" onClick={onSavePolicy} disabled={actionPending}>
              <ShieldCheckIcon className="size-3.5" />
              Save Policy
            </Button>
          </div>
        </div>

        <div className="min-w-0">
          <SectionHeader title="Goal queue" count={goals.length} />
          <div className="grid gap-2 border-b border-border/60 px-4 py-4 sm:px-5">
            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.7fr)]">
              <Input
                nativeInput
                size="sm"
                value={goalTitle}
                placeholder="Goal title"
                onChange={(event) => onGoalTitleChange(event.currentTarget.value)}
              />
              <Input
                nativeInput
                size="sm"
                value={goalRepo}
                placeholder="Repository path"
                onChange={(event) => onGoalRepoChange(event.currentTarget.value)}
              />
              <Input
                nativeInput
                size="sm"
                value={goalModel}
                placeholder="Model"
                onChange={(event) => onGoalModelChange(event.currentTarget.value)}
              />
            </div>
            <Textarea
              value={goalPrompt}
              placeholder="Goal prompt"
              className="min-h-20 text-xs"
              onChange={(event) => onGoalPromptChange(event.currentTarget.value)}
            />
            <div className="flex justify-end">
              <Button
                size="sm"
                variant="outline"
                onClick={onEnqueueGoal}
                disabled={!canEnqueue || actionPending}
              >
                <ListChecksIcon className="size-3.5" />
                Queue Goal
              </Button>
            </div>
          </div>

          {goals.length === 0 ? (
            <EmptyState label="No queued goals." />
          ) : (
            <div className="divide-y divide-border/60">
              {goals.slice(0, 8).map((goal) => (
                <div key={goal.id} className="grid gap-2 px-4 py-3 text-xs sm:px-5">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-medium">{goal.title}</span>
                    <StatusPill label={goal.status} tone={automodeGoalTone(goal)} />
                  </div>
                  <div className="truncate font-mono text-[11px] text-muted-foreground">
                    {goal.repo} | {goal.model ?? snapshot?.policy.defaultModel ?? "no model"}
                  </div>
                  {goal.blockedReason ? (
                    <div className="text-[11px] text-destructive">{goal.blockedReason}</div>
                  ) : null}
                  <div className="flex flex-wrap justify-end gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => onApproveGoal(goal.id)}
                      disabled={actionPending}
                    >
                      Approve
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => onDispatchGoal(goal.id)}
                      disabled={actionPending || goal.status === "rejected"}
                    >
                      <PlayIcon className="size-3.5" />
                      Dispatch
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive-outline"
                      onClick={() => onRejectGoal(goal.id)}
                      disabled={actionPending || goal.status === "rejected"}
                    >
                      Reject
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function ProjectPanel({ project }: { project: GitsCockpitProject }) {
  return (
    <section className="overflow-hidden border-b border-border bg-background">
      <div className="flex flex-col gap-2 border-b border-border/70 px-4 py-4 sm:flex-row sm:items-start sm:justify-between sm:px-5">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="truncate text-base font-semibold">{project.project.title}</h2>
            <StatusPill
              label={project.project.planning.state}
              tone={project.project.planning.state === "present" ? "success" : "warning"}
            />
          </div>
          <div className="mt-1 flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {project.project.clientName ? <span>{project.project.clientName}</span> : null}
            <span className="truncate font-mono">{project.project.rootPath}</span>
            {project.project.repo.remoteUrl ? (
              <span className="inline-flex min-w-0 items-center gap-1">
                <GitBranchIcon className="size-3 shrink-0" />
                <span className="truncate">{project.project.repo.remoteUrl}</span>
              </span>
            ) : null}
          </div>
        </div>
        <div className="grid grid-cols-4 gap-2 text-right text-xs sm:w-72">
          <div>
            <div className="font-mono font-semibold">
              {formatCount(project.project.planning.milestoneCount)}
            </div>
            <div className="text-muted-foreground">milestones</div>
          </div>
          <div>
            <div className="font-mono font-semibold">{formatCount(project.phases.length)}</div>
            <div className="text-muted-foreground">phases</div>
          </div>
          <div>
            <div className="font-mono font-semibold">
              {formatCount(project.verificationGates.length)}
            </div>
            <div className="text-muted-foreground">gates</div>
          </div>
          <div>
            <div className="font-mono font-semibold">{formatCount(project.yourTurn.length)}</div>
            <div className="text-muted-foreground">turns</div>
          </div>
        </div>
      </div>

      {project.project.planning.warnings.length > 0 ? (
        <div className="border-b border-border/60 bg-amber-500/8 px-4 py-2 text-xs text-amber-700 dark:text-amber-300 sm:px-5">
          {project.project.planning.warnings.join(" ")}
        </div>
      ) : null}

      <div className="grid min-w-0 grid-cols-1 xl:grid-cols-[minmax(0,1.4fr)_minmax(320px,0.6fr)]">
        <div className="min-w-0 border-r border-border/60">
          <SectionHeader title="GSD phases" count={project.phases.length} />
          <PhaseTable phases={project.phases} />
        </div>
        <div className="min-w-0 divide-y divide-border/60">
          <div>
            <SectionHeader title="Your Turn" count={project.yourTurn.length} />
            <YourTurnList cards={project.yourTurn} />
          </div>
          <div>
            <SectionHeader title="Verification gates" count={project.verificationGates.length} />
            <GateList gates={project.verificationGates} />
          </div>
          <div>
            <SectionHeader title="Agent sessions" count={project.agentSessions.length} />
            <AgentSessionList sessions={project.agentSessions} />
          </div>
        </div>
      </div>
    </section>
  );
}

function CockpitContent({ snapshot }: { snapshot: GitsCockpitSnapshot }) {
  return (
    <>
      <div className="grid grid-cols-2 border-b border-border/60 sm:grid-cols-4 xl:grid-cols-7">
        <StatBlock
          label="Projects"
          value={formatCount(snapshot.totals.projectCount)}
          icon={CircleIcon}
        />
        <StatBlock
          label="Planning"
          value={formatCount(snapshot.totals.planningProjectCount)}
          icon={CheckCircle2Icon}
        />
        <StatBlock
          label="Phases"
          value={formatCount(snapshot.totals.phaseCount)}
          icon={GitBranchIcon}
        />
        <StatBlock
          label="Gates"
          value={formatCount(snapshot.totals.verificationGateCount)}
          icon={ShieldCheckIcon}
        />
        <StatBlock
          label="Your Turn"
          value={formatCount(snapshot.totals.pendingYourTurnCount)}
          icon={AlertTriangleIcon}
        />
        <StatBlock
          label="Agents"
          value={formatCount(snapshot.totals.activeAgentSessionCount)}
          icon={BotIcon}
        />
        <StatBlock label="Peers" value={formatCount(snapshot.totals.peerCount)} icon={CircleIcon} />
      </div>

      {snapshot.projects.length === 0 ? (
        <div className="px-5 py-8 text-sm text-muted-foreground">No projects registered.</div>
      ) : (
        snapshot.projects.map((project) => (
          <ProjectPanel key={project.project.id} project={project} />
        ))
      )}
    </>
  );
}

export function GitsCockpit() {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const activeEnvironmentId = useStore((state) => state.activeEnvironmentId);
  const activeRemoteRuntime = useSavedEnvironmentRuntimeStore((state) =>
    activeEnvironmentId ? state.byId[activeEnvironmentId] : null,
  );
  const targetEnvironmentId = activeEnvironmentId ?? primaryEnvironmentId;
  const [activeTab, setActiveTab] = useState<GitsCockpitTab>("overview");
  const [selectedPeerId, setSelectedPeerId] = useState<string | null>(null);
  const [spawnRepo, setSpawnRepo] = useState("");
  const [spawnName, setSpawnName] = useState("");
  const [spawnPrompt, setSpawnPrompt] = useState("");
  const [replyText, setReplyText] = useState("");
  const [selectedProjectRoot, setSelectedProjectRoot] = useState("");
  const [motokoChatInput, setMotokoChatInput] = useState("");
  const [motokoScheduleKind, setMotokoScheduleKind] =
    useState<HermesScheduleKind>("daily-briefing");
  const [gsdInitInput, setGsdInitInput] = useState("");
  const [gsdAutoInitInput, setGsdAutoInitInput] = useState("");
  const [gsdModel, setGsdModel] = useState("");
  const [gsdMaxBudget, setGsdMaxBudget] = useState("");
  const [automodeMode, setAutomodeMode] = useState<AutomodeSnapshot["policy"]["mode"]>("manual");
  const [automodeKillSwitch, setAutomodeKillSwitch] = useState(true);
  const [automodeMaxPeers, setAutomodeMaxPeers] = useState("1");
  const [automodeAllowedRepos, setAutomodeAllowedRepos] = useState("");
  const [automodeAllowedModels, setAutomodeAllowedModels] = useState("");
  const [automodeDefaultModel, setAutomodeDefaultModel] = useState("");
  const [automodeMaxBudget, setAutomodeMaxBudget] = useState("");
  const [automodeMaxRuntime, setAutomodeMaxRuntime] = useState("60");
  const [automodeRequireSpawnApproval, setAutomodeRequireSpawnApproval] = useState(true);
  const [automodeRequireIntegrateApproval, setAutomodeRequireIntegrateApproval] = useState(true);
  const [automodeRequireDestructiveApproval, setAutomodeRequireDestructiveApproval] =
    useState(true);
  const [skillReviews, setSkillReviews] = useState<SkillReviewState>(() => loadSkillReviewState());
  const [automodeGoalTitle, setAutomodeGoalTitle] = useState("");
  const [automodeGoalRepo, setAutomodeGoalRepo] = useState("");
  const [automodeGoalModel, setAutomodeGoalModel] = useState("");
  const [automodeGoalPrompt, setAutomodeGoalPrompt] = useState("");
  const readEnvironmentClient = () => {
    if (targetEnvironmentId && targetEnvironmentId !== primaryEnvironmentId) {
      const connection = readEnvironmentConnection(targetEnvironmentId);
      if (!connection) {
        throw new Error("Remote environment is not connected.");
      }
      return connection.client;
    }
    return getPrimaryEnvironmentConnection().client;
  };
  const readGitsClient = () => readEnvironmentClient().gits;
  const query = useQuery({
    queryKey: [
      "gits",
      "cockpit",
      targetEnvironmentId,
      activeRemoteRuntime?.connectionState,
      activeRemoteRuntime?.authState,
    ],
    queryFn: async () => {
      return readGitsClient().getCockpit();
    },
    refetchInterval: 10_000,
  });
  const delamainQuery = useQuery({
    queryKey: [
      "gits",
      "delamain",
      "peers",
      targetEnvironmentId,
      activeRemoteRuntime?.connectionState,
      activeRemoteRuntime?.authState,
    ],
    queryFn: async () => readGitsClient().delamain.listPeers(),
    refetchInterval: 5_000,
  });
  const openGsdQuery = useQuery({
    queryKey: [
      "gits",
      "open-gsd",
      "status",
      targetEnvironmentId,
      activeRemoteRuntime?.connectionState,
      activeRemoteRuntime?.authState,
    ],
    queryFn: async () => readGitsClient().openGsd.getStatus(),
    refetchInterval: 30_000,
  });
  const automodeQuery = useQuery({
    queryKey: [
      "gits",
      "automode",
      "snapshot",
      targetEnvironmentId,
      activeRemoteRuntime?.connectionState,
      activeRemoteRuntime?.authState,
    ],
    queryFn: async () => readGitsClient().automode.getSnapshot(),
    refetchInterval: 5_000,
  });
  const capacityQuery = useQuery({
    queryKey: [
      "gits",
      "capacity",
      targetEnvironmentId,
      activeRemoteRuntime?.connectionState,
      activeRemoteRuntime?.authState,
    ],
    queryFn: async () => readGitsClient().capacity.getSnapshot(),
    refetchInterval: 30_000,
  });
  const hermesQuery = useQuery({
    queryKey: [
      "gits",
      "hermes",
      "status",
      targetEnvironmentId,
      activeRemoteRuntime?.connectionState,
      activeRemoteRuntime?.authState,
    ],
    queryFn: async () => readGitsClient().hermes.getStatus(),
    refetchInterval: 30_000,
  });
  const hermesSessionsQuery = useQuery({
    queryKey: [
      "gits",
      "hermes",
      "sessions",
      targetEnvironmentId,
      activeRemoteRuntime?.connectionState,
      activeRemoteRuntime?.authState,
    ],
    queryFn: async () => readGitsClient().hermes.listSessions({ limit: 8 }),
    refetchInterval: 30_000,
  });
  const hermesLogQuery = useQuery({
    queryKey: [
      "gits",
      "hermes",
      "log",
      targetEnvironmentId,
      activeRemoteRuntime?.connectionState,
      activeRemoteRuntime?.authState,
    ],
    queryFn: async () => readGitsClient().hermes.tailLog({ lines: 80 }),
    refetchInterval: 30_000,
  });
  const hermesProposalsQuery = useQuery({
    queryKey: [
      "gits",
      "hermes",
      "proposals",
      targetEnvironmentId,
      activeRemoteRuntime?.connectionState,
      activeRemoteRuntime?.authState,
    ],
    queryFn: async () => readGitsClient().hermes.listProposals(),
    refetchInterval: 10_000,
  });
  const resourceQuery = useQuery({
    queryKey: [
      "gits",
      "runtime-resources",
      targetEnvironmentId,
      activeRemoteRuntime?.connectionState,
      activeRemoteRuntime?.authState,
    ],
    queryFn: async () =>
      readEnvironmentClient().server.getProcessResourceHistory({
        windowMs: 15 * 60_000,
        bucketMs: 60_000,
      }),
    refetchInterval: 10_000,
  });
  const buildInfoQuery = useQuery({
    queryKey: ["gits", "build-info"],
    queryFn: async (): Promise<BuildInfoSnapshot> => {
      const response = await fetch("/api/gits/build-info", {
        headers: { accept: "application/json" },
      });
      if (response.status === 404 || response.status === 501) {
        return { status: "missing", fields: [], note: null };
      }
      if (!response.ok) {
        throw new Error(`Build info request failed with ${response.status}.`);
      }
      return normalizeBuildInfo(await response.json());
    },
    refetchInterval: 60_000,
    retry: false,
  });
  const skillsQuery = useQuery({
    queryKey: ["gits", "skills"],
    queryFn: async (): Promise<GitsSkillInventorySnapshot> => {
      const response = await fetch("/api/gits/skills", {
        headers: { accept: "application/json" },
      });
      if (!response.ok) {
        throw new Error(`Skills inventory request failed with ${response.status}.`);
      }
      return (await response.json()) as GitsSkillInventorySnapshot;
    },
    refetchInterval: 60_000,
    retry: false,
  });
  const peerIds = useMemo(
    () => new Set((delamainQuery.data?.peers ?? []).map((peer) => peer.id)),
    [delamainQuery.data?.peers],
  );
  const selectedPeer = selectedPeerId
    ? delamainQuery.data?.peers.find((peer) => peer.id === selectedPeerId)
    : null;
  const logQuery = useQuery({
    queryKey: ["gits", "delamain", "peer-log", targetEnvironmentId, selectedPeerId],
    queryFn: async () =>
      readGitsClient().delamain.readPeerLog({ peerId: selectedPeerId!, lines: 160 }),
    enabled: selectedPeerId !== null,
    refetchInterval: selectedPeerId ? 5_000 : false,
  });
  const hermesCheckMutation = useMutation({
    mutationFn: async () => readGitsClient().hermes.check(),
    onSuccess: async () => {
      await hermesQuery.refetch();
    },
  });
  const hermesSetupMutation = useMutation({
    mutationFn: async () => readGitsClient().hermes.setupCodexOAuth(),
    onSuccess: async () => {
      await Promise.all([hermesQuery.refetch(), hermesLogQuery.refetch()]);
    },
  });
  const hermesAcpMutation = useMutation({
    mutationFn: async () =>
      readGitsClient().hermes.startAcpSession(
        selectedProjectRoot.trim().length > 0 ? { cwd: selectedProjectRoot.trim() } : {},
      ),
    onSuccess: async () => {
      await Promise.all([hermesQuery.refetch(), hermesLogQuery.refetch()]);
    },
  });
  const hermesContextMutation = useMutation({
    mutationFn: async () =>
      readGitsClient().hermes.writeProjectContext({ projectDir: selectedProjectRoot.trim() }),
    onSuccess: async () => {
      await hermesLogQuery.refetch();
    },
  });
  const hermesInspectMutation = useMutation({
    mutationFn: async () =>
      readGitsClient().hermes.inspectGits({ projectDir: selectedProjectRoot.trim() }),
    onSuccess: async () => {
      await Promise.all([
        hermesProposalsQuery.refetch(),
        hermesLogQuery.refetch(),
        hermesQuery.refetch(),
      ]);
    },
  });
  const hermesChatMutation = useMutation({
    mutationFn: async () =>
      readGitsClient().hermes.chat({
        message: motokoChatInput.trim(),
        ...(selectedProjectRoot.trim().length > 0
          ? { projectDir: selectedProjectRoot.trim() }
          : {}),
      }),
    onSuccess: async () => {
      setMotokoChatInput("");
      await Promise.all([
        hermesProposalsQuery.refetch(),
        hermesLogQuery.refetch(),
        hermesQuery.refetch(),
      ]);
    },
  });
  const hermesDecisionMutation = useMutation({
    mutationFn: async (input: { proposalId: string; decision: "approve" | "reject" | "defer" }) =>
      readGitsClient().hermes.decideProposal(input),
    onSuccess: async () => {
      await Promise.all([hermesProposalsQuery.refetch(), hermesQuery.refetch()]);
    },
  });
  const hermesDraftMutation = useMutation({
    mutationFn: async (proposalId: string) =>
      readGitsClient().hermes.draftFromProposal({ proposalId }),
    onSuccess: async () => {
      await hermesProposalsQuery.refetch();
    },
  });
  const hermesScheduleMutation = useMutation({
    mutationFn: async () =>
      readGitsClient().hermes.runSchedule({
        kind: motokoScheduleKind,
        ...(selectedProjectRoot.trim().length > 0
          ? { projectDir: selectedProjectRoot.trim() }
          : {}),
      }),
    onSuccess: async () => {
      await Promise.all([hermesProposalsQuery.refetch(), hermesQuery.refetch()]);
    },
  });
  const spawnMutation = useMutation({
    mutationFn: async () =>
      readGitsClient().delamain.spawnPeer({
        repo: spawnRepo.trim(),
        prompt: spawnPrompt.trim(),
        ...(spawnName.trim().length > 0 ? { name: spawnName.trim() } : {}),
      }),
    onSuccess: async (peer) => {
      setSelectedPeerId(peer.id);
      setSpawnPrompt("");
      await delamainQuery.refetch();
    },
  });
  const replyMutation = useMutation({
    mutationFn: async () =>
      readGitsClient().delamain.sendPeerReply({
        peerId: selectedPeerId!,
        prompt: replyText.trim(),
      }),
    onSuccess: async () => {
      setReplyText("");
      await Promise.all([delamainQuery.refetch(), logQuery.refetch()]);
    },
  });
  const killMutation = useMutation({
    mutationFn: async () => readGitsClient().delamain.killPeer({ peerId: selectedPeerId! }),
    onSuccess: async () => {
      await Promise.all([delamainQuery.refetch(), logQuery.refetch()]);
    },
  });
  const waitMutation = useMutation({
    mutationFn: async () => readGitsClient().delamain.waitForPeer({ peerId: selectedPeerId! }),
    onSuccess: async (peer) => {
      setSelectedPeerId(peer.id);
      await Promise.all([delamainQuery.refetch(), logQuery.refetch()]);
    },
  });
  const integrateMutation = useMutation({
    mutationFn: async () => readGitsClient().delamain.integratePeer({ peerId: selectedPeerId! }),
    onSuccess: async (result) => {
      setSelectedPeerId(result.peer.id);
      await Promise.all([delamainQuery.refetch(), logQuery.refetch()]);
    },
  });
  const gsdCommonInput = () => {
    const maxBudget = Number(gsdMaxBudget);
    return {
      projectDir: selectedProjectRoot.trim(),
      ...(gsdModel.trim().length > 0 ? { model: gsdModel.trim() } : {}),
      ...(Number.isFinite(maxBudget) && maxBudget >= 0 && gsdMaxBudget.trim().length > 0
        ? { maxBudgetUsd: maxBudget }
        : {}),
    };
  };
  const gsdInitMutation = useMutation({
    mutationFn: async () =>
      readGitsClient().openGsd.initProject({
        ...gsdCommonInput(),
        input: gsdInitInput.trim(),
      }),
    onSuccess: async () => {
      await query.refetch();
    },
  });
  const gsdAutoMutation = useMutation({
    mutationFn: async () =>
      readGitsClient().openGsd.runAuto({
        ...gsdCommonInput(),
        ...(gsdAutoInitInput.trim().length > 0 ? { initInput: gsdAutoInitInput.trim() } : {}),
      }),
    onSuccess: async () => {
      await query.refetch();
    },
  });
  const automodePolicyInput = () => {
    const maxPeers = Math.max(0, Math.floor(Number(automodeMaxPeers)));
    const maxBudget = Number(automodeMaxBudget);
    const maxRuntime = Math.max(0, Math.floor(Number(automodeMaxRuntime)));
    return {
      mode: automodeMode,
      killSwitchEnabled: automodeKillSwitch,
      maxActivePeers: Number.isFinite(maxPeers) ? maxPeers : 0,
      allowedRepos: parseLines(automodeAllowedRepos),
      allowedModels: parseLines(automodeAllowedModels),
      defaultModel: automodeDefaultModel.trim().length > 0 ? automodeDefaultModel.trim() : null,
      maxBudgetUsd:
        Number.isFinite(maxBudget) && maxBudget >= 0 && automodeMaxBudget.trim().length > 0
          ? maxBudget
          : null,
      maxRuntimeMinutes:
        Number.isFinite(maxRuntime) && automodeMaxRuntime.trim().length > 0 ? maxRuntime : null,
      requireApprovalForPeerSpawn: automodeRequireSpawnApproval,
      requireApprovalBeforeIntegrate: automodeRequireIntegrateApproval,
      requireApprovalBeforeDestructiveAction: automodeRequireDestructiveApproval,
    };
  };
  const automodePolicyMutation = useMutation({
    mutationFn: async () => readGitsClient().automode.updatePolicy(automodePolicyInput()),
    onSuccess: async () => {
      await automodeQuery.refetch();
    },
  });
  const automodeKillSwitchMutation = useMutation({
    mutationFn: async (killSwitchEnabled: boolean) =>
      readGitsClient().automode.updatePolicy({ killSwitchEnabled }),
    onSuccess: async () => {
      await automodeQuery.refetch();
    },
  });
  const automodeEnqueueMutation = useMutation({
    mutationFn: async () =>
      readGitsClient().automode.enqueueGoal({
        title: automodeGoalTitle.trim(),
        repo: automodeGoalRepo.trim(),
        prompt: automodeGoalPrompt.trim(),
        ...(automodeGoalModel.trim().length > 0 ? { model: automodeGoalModel.trim() } : {}),
      }),
    onSuccess: async () => {
      setAutomodeGoalTitle("");
      setAutomodeGoalPrompt("");
      await automodeQuery.refetch();
    },
  });
  const automodeApproveMutation = useMutation({
    mutationFn: async (goalId: string) => readGitsClient().automode.approveGoal({ goalId }),
    onSuccess: async () => {
      await automodeQuery.refetch();
    },
  });
  const automodeRejectMutation = useMutation({
    mutationFn: async (goalId: string) =>
      readGitsClient().automode.rejectGoal({ goalId, reason: "Rejected in cockpit." }),
    onSuccess: async () => {
      await automodeQuery.refetch();
    },
  });
  const automodeDispatchMutation = useMutation({
    mutationFn: async (goalId: string) => readGitsClient().automode.dispatchGoal({ goalId }),
    onSuccess: async () => {
      await Promise.all([automodeQuery.refetch(), delamainQuery.refetch()]);
    },
  });
  const actionError =
    spawnMutation.error ??
    replyMutation.error ??
    killMutation.error ??
    waitMutation.error ??
    integrateMutation.error;
  const actionPending =
    spawnMutation.isPending ||
    replyMutation.isPending ||
    killMutation.isPending ||
    waitMutation.isPending ||
    integrateMutation.isPending;
  const openGsdActionError = gsdInitMutation.error ?? gsdAutoMutation.error;
  const openGsdActionPending = gsdInitMutation.isPending || gsdAutoMutation.isPending;
  const openGsdCommandResult = gsdAutoMutation.data ?? gsdInitMutation.data;
  const hermesActionError =
    hermesCheckMutation.error ??
    hermesSetupMutation.error ??
    hermesAcpMutation.error ??
    hermesContextMutation.error ??
    hermesInspectMutation.error ??
    hermesChatMutation.error ??
    hermesDecisionMutation.error ??
    hermesDraftMutation.error ??
    hermesScheduleMutation.error;
  const hermesActionPending =
    hermesCheckMutation.isPending ||
    hermesSetupMutation.isPending ||
    hermesAcpMutation.isPending ||
    hermesContextMutation.isPending ||
    hermesInspectMutation.isPending ||
    hermesChatMutation.isPending ||
    hermesDecisionMutation.isPending ||
    hermesDraftMutation.isPending ||
    hermesScheduleMutation.isPending;
  const hermesCommandResult =
    hermesAcpMutation.data ?? hermesSetupMutation.data ?? hermesCheckMutation.data;
  const automodeActionError =
    automodePolicyMutation.error ??
    automodeKillSwitchMutation.error ??
    automodeEnqueueMutation.error ??
    automodeApproveMutation.error ??
    automodeRejectMutation.error ??
    automodeDispatchMutation.error;
  const automodeActionPending =
    automodePolicyMutation.isPending ||
    automodeKillSwitchMutation.isPending ||
    automodeEnqueueMutation.isPending ||
    automodeApproveMutation.isPending ||
    automodeRejectMutation.isPending ||
    automodeDispatchMutation.isPending;
  const updateSkillReview = (
    skillId: string,
    updater: (current: SkillReviewState[string]) => SkillReviewState[string],
  ) => {
    setSkillReviews((current) => {
      const next = {
        ...current,
        [skillId]: updater(current[skillId] ?? { rating: null, review: "" }),
      };
      saveSkillReviewState(next);
      return next;
    });
  };

  useEffect(() => {
    if (selectedPeerId !== null && peerIds.has(selectedPeerId)) {
      return;
    }
    setSelectedPeerId(delamainQuery.data?.peers[0]?.id ?? null);
  }, [delamainQuery.data?.peers, peerIds, selectedPeerId]);

  useEffect(() => {
    const projectRoots = query.data?.projects.map((project) => project.project.rootPath) ?? [];
    if (selectedProjectRoot && projectRoots.includes(selectedProjectRoot)) {
      return;
    }
    setSelectedProjectRoot(projectRoots[0] ?? "");
  }, [query.data?.projects, selectedProjectRoot]);

  useEffect(() => {
    const policy = automodeQuery.data?.policy;
    if (!policy) {
      return;
    }
    setAutomodeMode(policy.mode);
    setAutomodeKillSwitch(policy.killSwitchEnabled);
    setAutomodeMaxPeers(String(policy.maxActivePeers));
    setAutomodeAllowedRepos(policy.allowedRepos.join("\n"));
    setAutomodeAllowedModels(policy.allowedModels.join("\n"));
    setAutomodeDefaultModel(policy.defaultModel ?? "");
    setAutomodeMaxBudget(policy.maxBudgetUsd === null ? "" : String(policy.maxBudgetUsd));
    setAutomodeMaxRuntime(
      policy.maxRuntimeMinutes === null ? "" : String(policy.maxRuntimeMinutes),
    );
    setAutomodeRequireSpawnApproval(policy.requireApprovalForPeerSpawn);
    setAutomodeRequireIntegrateApproval(policy.requireApprovalBeforeIntegrate);
    setAutomodeRequireDestructiveApproval(policy.requireApprovalBeforeDestructiveAction);
  }, [automodeQuery.data?.policy]);

  useEffect(() => {
    if (automodeGoalRepo.trim().length > 0) {
      return;
    }
    setAutomodeGoalRepo(selectedProjectRoot);
  }, [automodeGoalRepo, selectedProjectRoot]);

  const tabCounts = useMemo<Record<GitsCockpitTab, string>>(
    () => ({
      overview: "live",
      motoko: formatCount(hermesProposalsQuery.data?.proposals.length ?? 0),
      fleet: formatCount(delamainQuery.data?.peers.length ?? 0),
      automode: formatCount(automodeQuery.data?.goals.length ?? 0),
      gsd: openGsdQuery.data?.available ? "ready" : "check",
      skills: formatCount(skillsQuery.data?.totals.skillCount ?? 0),
      projects: formatCount(query.data?.totals.projectCount ?? 0),
    }),
    [
      automodeQuery.data?.goals.length,
      delamainQuery.data?.peers.length,
      hermesProposalsQuery.data?.proposals.length,
      openGsdQuery.data?.available,
      query.data?.totals.projectCount,
      skillsQuery.data?.totals.skillCount,
    ],
  );
  const isRefreshing =
    query.isFetching ||
    delamainQuery.isFetching ||
    automodeQuery.isFetching ||
    capacityQuery.isFetching ||
    hermesQuery.isFetching ||
    hermesSessionsQuery.isFetching ||
    hermesLogQuery.isFetching ||
    hermesProposalsQuery.isFetching ||
    openGsdQuery.isFetching ||
    resourceQuery.isFetching ||
    buildInfoQuery.isFetching ||
    skillsQuery.isFetching;

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <header className="flex min-h-14 shrink-0 items-center justify-between gap-3 border-b border-border bg-card px-4 sm:px-5">
        <div className="flex min-w-0 items-center gap-2">
          <SidebarTrigger className="size-7 shrink-0 md:hidden" />
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold">GITS Cockpit</h1>
            <p className="truncate text-xs text-muted-foreground">DevOS, GSD, and fleet control</p>
          </div>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            void Promise.all([
              query.refetch(),
              delamainQuery.refetch(),
              automodeQuery.refetch(),
              capacityQuery.refetch(),
              hermesQuery.refetch(),
              hermesSessionsQuery.refetch(),
              hermesLogQuery.refetch(),
              hermesProposalsQuery.refetch(),
              openGsdQuery.refetch(),
              resourceQuery.refetch(),
              buildInfoQuery.refetch(),
              skillsQuery.refetch(),
            ]);
          }}
          disabled={isRefreshing}
        >
          <RefreshCwIcon className={cn("size-3.5", isRefreshing && "animate-spin")} />
          Refresh
        </Button>
      </header>

      <ScrollArea chainVerticalScroll scrollFade className="min-h-0 flex-1">
        {query.isPending ? (
          <div className="px-5 py-8 text-sm text-muted-foreground">Loading cockpit state...</div>
        ) : query.error ? (
          <div className="px-5 py-8 text-sm text-destructive">
            {query.error instanceof Error ? query.error.message : "Failed to load cockpit state."}
          </div>
        ) : query.data ? (
          <>
            <CockpitTabNav activeTab={activeTab} counts={tabCounts} onTabChange={setActiveTab} />
            {activeTab === "overview" ? (
              <>
                <CockpitOverviewPanel
                  snapshot={query.data}
                  delamain={delamainQuery.data}
                  automode={automodeQuery.data}
                  openGsd={openGsdQuery.data}
                  hermes={hermesQuery.data}
                  proposals={hermesProposalsQuery.data}
                  capacity={capacityQuery.data}
                  history={resourceQuery.data}
                  buildInfo={buildInfoQuery.data}
                />
                <BuildProvenancePanel
                  buildInfo={buildInfoQuery.data}
                  loading={buildInfoQuery.isPending || buildInfoQuery.isFetching}
                  error={buildInfoQuery.error}
                  onRefresh={() => void buildInfoQuery.refetch()}
                />
                <ResourceVisibilityPanel
                  snapshot={query.data}
                  automode={automodeQuery.data}
                  history={resourceQuery.data}
                  loading={resourceQuery.isPending || resourceQuery.isFetching}
                  error={resourceQuery.error}
                  onRefresh={() => void resourceQuery.refetch()}
                />
              </>
            ) : null}
            {activeTab === "fleet" ? (
              <PeerFleetPanel
                list={delamainQuery.data}
                loading={delamainQuery.isPending || delamainQuery.isFetching}
                error={delamainQuery.error}
                selectedPeerId={selectedPeer?.id ?? selectedPeerId}
                logText={logQuery.data?.text}
                logLoading={logQuery.isPending || logQuery.isFetching}
                actionError={actionError}
                spawnRepo={spawnRepo}
                spawnName={spawnName}
                spawnPrompt={spawnPrompt}
                replyText={replyText}
                actionPending={actionPending}
                onRefresh={() => void delamainQuery.refetch()}
                onSelectPeer={setSelectedPeerId}
                onSpawnRepoChange={setSpawnRepo}
                onSpawnNameChange={setSpawnName}
                onSpawnPromptChange={setSpawnPrompt}
                onReplyTextChange={setReplyText}
                onSpawn={() => void spawnMutation.mutate()}
                onReply={() => void replyMutation.mutate()}
                onWait={() => void waitMutation.mutate()}
                onKill={() => {
                  if (!selectedPeerId) {
                    return;
                  }
                  if (window.confirm(`Kill Delamain peer ${selectedPeerId}?`)) {
                    void killMutation.mutate();
                  }
                }}
                onIntegrate={() => {
                  if (!selectedPeerId) {
                    return;
                  }
                  if (
                    window.confirm(`Open an integration PR for Delamain peer ${selectedPeerId}?`)
                  ) {
                    void integrateMutation.mutate();
                  }
                }}
              />
            ) : null}
            {activeTab === "automode" ? (
              <AutomodePanel
                snapshot={automodeQuery.data}
                loading={automodeQuery.isPending || automodeQuery.isFetching}
                error={automodeQuery.error}
                actionError={automodeActionError}
                actionPending={automodeActionPending}
                policyMode={automodeMode}
                killSwitchEnabled={automodeKillSwitch}
                maxActivePeers={automodeMaxPeers}
                allowedRepos={automodeAllowedRepos}
                allowedModels={automodeAllowedModels}
                defaultModel={automodeDefaultModel}
                maxBudget={automodeMaxBudget}
                maxRuntime={automodeMaxRuntime}
                requireSpawnApproval={automodeRequireSpawnApproval}
                requireIntegrateApproval={automodeRequireIntegrateApproval}
                requireDestructiveApproval={automodeRequireDestructiveApproval}
                goalTitle={automodeGoalTitle}
                goalRepo={automodeGoalRepo}
                goalModel={automodeGoalModel}
                goalPrompt={automodeGoalPrompt}
                onRefresh={() => void automodeQuery.refetch()}
                onPolicyModeChange={setAutomodeMode}
                onKillSwitchChange={(next) => {
                  setAutomodeKillSwitch(next);
                  void automodeKillSwitchMutation.mutate(next);
                }}
                onMaxActivePeersChange={setAutomodeMaxPeers}
                onAllowedReposChange={setAutomodeAllowedRepos}
                onAllowedModelsChange={setAutomodeAllowedModels}
                onDefaultModelChange={setAutomodeDefaultModel}
                onMaxBudgetChange={setAutomodeMaxBudget}
                onMaxRuntimeChange={setAutomodeMaxRuntime}
                onRequireSpawnApprovalChange={setAutomodeRequireSpawnApproval}
                onRequireIntegrateApprovalChange={setAutomodeRequireIntegrateApproval}
                onRequireDestructiveApprovalChange={setAutomodeRequireDestructiveApproval}
                onGoalTitleChange={setAutomodeGoalTitle}
                onGoalRepoChange={setAutomodeGoalRepo}
                onGoalModelChange={setAutomodeGoalModel}
                onGoalPromptChange={setAutomodeGoalPrompt}
                onSavePolicy={() => void automodePolicyMutation.mutate()}
                onEnqueueGoal={() => void automodeEnqueueMutation.mutate()}
                onApproveGoal={(goalId) => void automodeApproveMutation.mutate(goalId)}
                onRejectGoal={(goalId) => {
                  if (window.confirm(`Reject automode goal ${goalId}?`)) {
                    void automodeRejectMutation.mutate(goalId);
                  }
                }}
                onDispatchGoal={(goalId) => void automodeDispatchMutation.mutate(goalId)}
              />
            ) : null}
            {activeTab === "motoko" ? (
              <MotokoPanel
                status={hermesQuery.data}
                capacity={capacityQuery.data}
                sessions={hermesSessionsQuery.data}
                log={hermesLogQuery.data}
                proposals={hermesProposalsQuery.data}
                loading={
                  hermesQuery.isPending ||
                  hermesQuery.isFetching ||
                  hermesSessionsQuery.isFetching ||
                  hermesLogQuery.isFetching ||
                  hermesProposalsQuery.isFetching ||
                  capacityQuery.isFetching
                }
                error={
                  hermesQuery.error ??
                  hermesSessionsQuery.error ??
                  hermesLogQuery.error ??
                  hermesProposalsQuery.error ??
                  capacityQuery.error
                }
                actionError={hermesActionError}
                commandResult={hermesCommandResult}
                draft={hermesDraftMutation.data}
                scheduleResult={hermesScheduleMutation.data}
                selectedProjectRoot={selectedProjectRoot}
                chatInput={motokoChatInput}
                scheduleKind={motokoScheduleKind}
                actionPending={hermesActionPending}
                onRefresh={() => {
                  void Promise.all([
                    hermesQuery.refetch(),
                    hermesSessionsQuery.refetch(),
                    hermesLogQuery.refetch(),
                    hermesProposalsQuery.refetch(),
                    capacityQuery.refetch(),
                  ]);
                }}
                onProjectRootChange={setSelectedProjectRoot}
                onChatInputChange={setMotokoChatInput}
                onScheduleKindChange={setMotokoScheduleKind}
                onCheck={() => void hermesCheckMutation.mutate()}
                onSetupCodexOAuth={() => void hermesSetupMutation.mutate()}
                onStartAcp={() => void hermesAcpMutation.mutate()}
                onInspectGits={() => void hermesInspectMutation.mutate()}
                onChatSubmit={() => void hermesChatMutation.mutate()}
                onDecision={(proposalId, decision) =>
                  void hermesDecisionMutation.mutate({ proposalId, decision })
                }
                onWriteContext={() => void hermesContextMutation.mutate()}
                onDraft={(proposalId) => void hermesDraftMutation.mutate(proposalId)}
                onRunSchedule={() => void hermesScheduleMutation.mutate()}
              />
            ) : null}
            {activeTab === "gsd" ? (
              <OpenGsdPanel
                status={openGsdQuery.data}
                loading={openGsdQuery.isPending || openGsdQuery.isFetching}
                error={openGsdQuery.error}
                projects={query.data.projects}
                selectedProjectRoot={selectedProjectRoot}
                initInput={gsdInitInput}
                autoInitInput={gsdAutoInitInput}
                model={gsdModel}
                maxBudget={gsdMaxBudget}
                commandResult={openGsdCommandResult}
                actionError={openGsdActionError}
                actionPending={openGsdActionPending}
                onRefresh={() => void openGsdQuery.refetch()}
                onProjectRootChange={setSelectedProjectRoot}
                onInitInputChange={setGsdInitInput}
                onAutoInitInputChange={setGsdAutoInitInput}
                onModelChange={setGsdModel}
                onMaxBudgetChange={setGsdMaxBudget}
                onInit={() => void gsdInitMutation.mutate()}
                onAuto={() => {
                  if (!selectedProjectRoot) {
                    return;
                  }
                  if (window.confirm(`Run gsd-sdk auto in ${selectedProjectRoot}?`)) {
                    void gsdAutoMutation.mutate();
                  }
                }}
              />
            ) : null}
            {activeTab === "skills" ? (
              <SkillsPanel
                snapshot={skillsQuery.data}
                loading={skillsQuery.isPending || skillsQuery.isFetching}
                error={skillsQuery.error}
                reviews={skillReviews}
                onRefresh={() => void skillsQuery.refetch()}
                onRatingChange={(skillId, rating) =>
                  updateSkillReview(skillId, (current) => ({ ...current, rating }))
                }
                onReviewChange={(skillId, review) =>
                  updateSkillReview(skillId, (current) => ({ ...current, review }))
                }
              />
            ) : null}
            {activeTab === "projects" ? <CockpitContent snapshot={query.data} /> : null}
          </>
        ) : null}
      </ScrollArea>
    </SidebarInset>
  );
}
