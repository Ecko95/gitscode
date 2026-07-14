import type {
  AgentSession,
  AutomodeGoal,
  AutomodeSnapshot,
  DelamainInboxResult,
  DelamainPeer,
  DelamainPeerListResult,
  GitsCapacitySnapshot,
  GitsCockpitProject,
  GitsCockpitSnapshot,
  GitsDevCommand,
  GitsDevCommandListResult,
  GitsMcpInventorySnapshot,
  GitsMcpServerItem,
  GitsMcpServerProvider,
  GitsSchedulerSnapshot,
  GitsSkillInventoryItem,
  GitsSkillInventorySnapshot,
  GitsSkillProvider,
  GsdPhase,
  HermesChatResult,
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
  TerminalAttachStreamEvent,
  UsageSummary,
  VerificationGate,
  YourTurnCard,
} from "@t3tools/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import * as Option from "effect/Option";
import {
  AlertTriangleIcon,
  ArrowUpIcon,
  BookOpenCheckIcon,
  BotIcon,
  CheckCircle2Icon,
  CircleStopIcon,
  CircleDollarSignIcon,
  CopyIcon,
  CircleIcon,
  FilePlus2Icon,
  GaugeIcon,
  GitBranchIcon,
  ListChecksIcon,
  LockIcon,
  LockOpenIcon,
  MessageSquarePlusIcon,
  PenLineIcon,
  PlayIcon,
  PlugIcon,
  PowerIcon,
  RefreshCwIcon,
  SearchIcon,
  SendIcon,
  ShieldCheckIcon,
  SparklesIcon,
  StarIcon,
  ExternalLinkIcon,
  SquareTerminalIcon,
  Trash2Icon,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { readEnvironmentApi } from "../../environmentApi";
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
import { Separator } from "../ui/separator";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetPanel,
  SheetPopup,
  SheetTitle,
} from "../ui/sheet";
import { SidebarInset, SidebarTrigger } from "../ui/sidebar";
import { Textarea } from "../ui/textarea";
import { ComposerVoiceButton } from "../chat/ComposerVoiceButton";
import { useVoiceTranscription } from "../../hooks/useVoiceTranscription";

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

type GitsCockpitTab =
  | "overview"
  | "motoko"
  | "dev"
  | "fleet"
  | "automode"
  | "usage"
  | "gsd"
  | "skills"
  | "mcp"
  | "projects";

const GITS_COCKPIT_TABS: ReadonlyArray<{
  id: GitsCockpitTab;
  label: string;
  icon: typeof CircleIcon;
}> = [
  { id: "overview", label: "Overview", icon: GaugeIcon },
  { id: "motoko", label: "Motoko", icon: SparklesIcon },
  { id: "dev", label: "Dev", icon: SquareTerminalIcon },
  { id: "fleet", label: "Fleet", icon: GitBranchIcon },
  { id: "automode", label: "Automode", icon: PowerIcon },
  { id: "usage", label: "Usage", icon: CircleDollarSignIcon },
  { id: "gsd", label: "Open GSD", icon: ListChecksIcon },
  { id: "skills", label: "Skills", icon: BookOpenCheckIcon },
  { id: "mcp", label: "MCP", icon: PlugIcon },
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

function formatTokenLimit(value: number | null | undefined): string {
  if (value === null || value === undefined) {
    return "unknown";
  }
  if (value >= 1_000_000) {
    const millions = value / 1_000_000;
    return `${Number.isInteger(millions) ? millions.toFixed(0) : millions.toFixed(1)}m`;
  }
  if (value >= 1_000) {
    const thousands = value / 1_000;
    return `${Number.isInteger(thousands) ? thousands.toFixed(0) : thousands.toFixed(1)}k`;
  }
  return formatCount(value);
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

function formatSlotRemaining(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
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

type McpOverrideState = Record<string, boolean>;

const MCP_SERVER_OVERRIDE_STORAGE_KEY = "gits:mcp:overrides:v1";

function loadMcpOverrideState(): McpOverrideState {
  if (typeof window === "undefined") {
    return {};
  }
  try {
    const raw = window.localStorage.getItem(MCP_SERVER_OVERRIDE_STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return {};
    }
    const overrides: McpOverrideState = {};
    for (const [serverId, value] of Object.entries(parsed)) {
      if (typeof value === "boolean") {
        overrides[serverId] = value;
      }
    }
    return overrides;
  } catch {
    return {};
  }
}

function saveMcpOverrideState(overrides: McpOverrideState): void {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(MCP_SERVER_OVERRIDE_STORAGE_KEY, JSON.stringify(overrides));
}

function formatMcpProvider(provider: GitsMcpServerProvider): string {
  if (provider === "unknown") {
    return "Unknown";
  }
  return provider.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function isMcpServerEnabled(server: GitsMcpServerItem, overrides: McpOverrideState): boolean {
  return overrides[server.id] ?? server.enabled;
}

function mcpStatusTone(server: GitsMcpServerItem, enabled: boolean): ReturnType<typeof statusTone> {
  if (!enabled) {
    return "default";
  }
  if (server.status === "running") {
    return "success";
  }
  if (server.status === "error") {
    return "danger";
  }
  if (server.status === "stopped") {
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
        onKeyDown={(event) => {
          const count = GITS_COCKPIT_TABS.length;
          const index = GITS_COCKPIT_TABS.findIndex((tab) => tab.id === activeTab);
          let nextIndex: number | null = null;
          if (event.key === "ArrowRight") {
            nextIndex = (index + 1) % count;
          } else if (event.key === "ArrowLeft") {
            nextIndex = (index - 1 + count) % count;
          } else if (event.key === "Home") {
            nextIndex = 0;
          } else if (event.key === "End") {
            nextIndex = count - 1;
          }
          if (nextIndex === null) {
            return;
          }
          event.preventDefault();
          const nextTab = GITS_COCKPIT_TABS[nextIndex]!;
          onTabChange(nextTab.id);
          event.currentTarget
            .querySelector<HTMLButtonElement>(`#gits-cockpit-tab-${nextTab.id}`)
            ?.focus();
        }}
      >
        {GITS_COCKPIT_TABS.map((tab) => {
          const Icon = tab.icon;
          const selected = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`gits-cockpit-tab-${tab.id}`}
              aria-controls={`gits-cockpit-panel-${tab.id}`}
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
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

function UsagePanel({
  usage,
  loading,
  error,
  onRefresh,
}: {
  usage: UsageSummary | undefined;
  loading: boolean;
  error: unknown;
  onRefresh: () => void;
}) {
  const errorMessage = error instanceof Error ? error.message : null;
  const topModels = usage?.models.slice(0, 8) ?? [];

  return (
    <section className="border-b border-border bg-background">
      <div className="flex flex-col gap-3 border-b border-border/70 px-4 py-4 sm:flex-row sm:items-start sm:justify-between sm:px-5">
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h2 className="truncate text-base font-semibold">Usage</h2>
            <StatusPill label="local host" tone="default" />
            <StatusPill label={usage?.costEstimate ? "estimated" : "checking"} tone="warning" />
            <StatusPill label={usage ? formatUsd(usage.estimatedCostUsd) : "..."} tone="default" />
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {usage
              ? `${formatCount(usage.totals.totalTokens)} tokens scanned | ${formatIsoDate(
                  usage.checkedAt,
                )}`
              : "Reading local provider JSONL usage logs."}
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

      {loading && !usage ? (
        <EmptyState label="Reading usage logs..." />
      ) : !usage ? (
        <EmptyState label="Usage summary unavailable." />
      ) : (
        <>
          <div className="grid grid-cols-2 border-b border-border/60 sm:grid-cols-4">
            <StatBlock
              label="Tokens"
              value={formatCount(usage.totals.totalTokens)}
              icon={GaugeIcon}
            />
            <StatBlock
              label="Cost"
              value={formatUsd(usage.estimatedCostUsd)}
              icon={CircleDollarSignIcon}
            />
            <StatBlock
              label="Requests"
              value={formatCount(usage.models.reduce((total, row) => total + row.requestCount, 0))}
              icon={BotIcon}
            />
            <StatBlock label="Days" value={formatCount(usage.days.length)} icon={CircleIcon} />
          </div>

          <div className="grid border-b border-border/60 md:grid-cols-2">
            {usage.windows.length === 0 ? (
              <EmptyState label="No Codex rolling-window rate limit records found." />
            ) : (
              usage.windows.map((window) => (
                <SignalRow
                  key={`${window.provider}:${window.label}`}
                  label={`${window.provider} ${window.label}`}
                  value={formatPercent(window.remainingPercent)}
                  tone={
                    (window.remainingPercent ?? 100) < 20
                      ? "danger"
                      : (window.remainingPercent ?? 100) < 40
                        ? "warning"
                        : "success"
                  }
                  detail={`resets ${formatIsoDate(window.resetAt)} | source ${
                    window.sourcePath ?? "unknown"
                  }`}
                />
              ))
            )}
          </div>

          <ScrollArea chainVerticalScroll scrollFade hideScrollbars className="w-full">
            <table className="w-full min-w-[760px] text-left text-xs">
              <thead className="border-b border-border/60 text-[11px] uppercase text-muted-foreground/70">
                <tr>
                  <th className="px-4 py-2 font-medium sm:px-5">Provider / model</th>
                  <th className="px-3 py-2 font-medium">Requests</th>
                  <th className="px-3 py-2 font-medium">Input</th>
                  <th className="px-3 py-2 font-medium">Cached</th>
                  <th className="px-3 py-2 font-medium">Output</th>
                  <th className="px-3 py-2 font-medium">Cost</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {topModels.map((row) => (
                  <tr key={`${row.provider}:${row.model}`}>
                    <td className="px-4 py-2.5 sm:px-5">
                      <div className="flex min-w-0 items-center gap-2">
                        <StatusPill label={row.provider} tone="default" />
                        <span className="truncate font-medium">{row.model}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 font-mono tabular-nums">
                      {formatCount(row.requestCount)}
                    </td>
                    <td className="px-3 py-2.5 font-mono tabular-nums">
                      {formatCount(row.tokens.inputTokens)}
                    </td>
                    <td className="px-3 py-2.5 font-mono tabular-nums">
                      {formatCount(
                        row.tokens.cachedInputTokens +
                          row.tokens.cacheCreationInputTokens +
                          row.tokens.cacheReadInputTokens,
                      )}
                    </td>
                    <td className="px-3 py-2.5 font-mono tabular-nums">
                      {formatCount(row.tokens.outputTokens + row.tokens.reasoningOutputTokens)}
                    </td>
                    <td className="px-3 py-2.5 font-mono tabular-nums">
                      {formatUsd(row.estimatedCostUsd)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollArea>

          <div className="grid gap-2 px-4 py-3 sm:px-5">
            {usage.sources.map((source) => (
              <div key={source.provider} className="min-w-0 text-[11px] text-muted-foreground">
                <span className="font-medium text-foreground">{source.provider}</span> |{" "}
                {source.status} | {formatCount(source.scannedFilePaths.length)} files |{" "}
                {source.note ?? source.homePath}
              </div>
            ))}
          </div>
        </>
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
  inbox,
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
  killSwitchEnabled,
}: {
  list: DelamainPeerListResult | undefined;
  loading: boolean;
  error: unknown;
  selectedPeerId: string | null;
  logText: string | undefined;
  logLoading: boolean;
  inbox: DelamainInboxResult | undefined;
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
  killSwitchEnabled: boolean;
}) {
  const peers = list?.peers ?? [];
  const selectedPeer = selectedPeerId
    ? (peers.find((peer) => peer.id === selectedPeerId) ?? null)
    : null;
  const supported = new Set(list?.capabilities.supported ?? []);
  // The automode kill switch (R#1) freezes the guarded manual actions
  // (spawn/reply/kill/integrate) server-side; disable them here so the block is a
  // visible, explained state instead of a bare RPC error. `wait` is read-only and
  // stays enabled.
  const canSpawn =
    supported.has("spawn") &&
    spawnRepo.trim().length > 0 &&
    spawnPrompt.trim().length > 0 &&
    !killSwitchEnabled;
  const canReply =
    supported.has("reply") &&
    selectedPeer !== null &&
    replyText.trim().length > 0 &&
    !killSwitchEnabled;
  const canWait = supported.has("wait") && selectedPeer !== null;
  const canKill = supported.has("kill") && selectedPeer !== null && !killSwitchEnabled;
  const canIntegrate = supported.has("integrate") && selectedPeer !== null && !killSwitchEnabled;
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
        <div
          aria-live="polite"
          className="border-b border-border/60 px-4 py-2 text-xs text-destructive sm:px-5"
        >
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
                <div>
                  <span className="text-foreground">Inbox:</span>{" "}
                  {inbox && inbox.messages.length > 0 ? (
                    <ul className="mt-1 grid gap-1">
                      {inbox.messages.map((msg) => (
                        <li key={msg.id} className="truncate font-mono text-[11px]">
                          <span className="text-foreground">{msg.fromPeerId}</span>
                          {msg.deliveredAt ? "" : " (queued)"}: {msg.message}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    "no messages"
                  )}
                </div>
              </div>
              <div className="grid gap-2">
                {killSwitchEnabled ? (
                  <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-600 dark:text-amber-400">
                    Automode kill switch is on — manual peer actions (spawn, reply, kill, integrate)
                    are disabled. Turn it off in the Automode tab to re-enable.
                  </div>
                ) : null}
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

const MOTOKO_CAPSULE_FRAME_SRC = "/gits/motoko-capsule-frame.png";
const MOTOKO_CAPSULE_VIDEO_SRC = "/gits/motoko-capsule-avatar.mp4";
const MOTOKO_CHAT_LOGO_SRC = "/gits/motoko-chat-logo.png";
const MOTOKO_ROOT_ROUTE_VALUE = "";
const MOTOKO_ROOT_ROUTE_SELECT_VALUE = "__root_gits__";
const MOTOKO_ROOT_ROUTE_LABEL = "root/gits";
const MOTOKO_RUNTIME_MODE = "approval-required";
const MOTOKO_CAPSULE_VIDEO_WINDOW_STYLE = {
  height: "49.8%",
  left: "25.1%",
  top: "24.3%",
  width: "49.8%",
};

type MotokoInteractionMode = "default" | "plan";
type MotokoRuntimeMode = "approval-required" | "auto-accept-edits" | "full-access";

const MOTOKO_RUNTIME_MODE_CONFIG: Record<
  MotokoRuntimeMode,
  {
    readonly label: string;
    readonly description: string;
    readonly icon: LucideIcon;
    readonly available: boolean;
  }
> = {
  "approval-required": {
    label: "Supervised",
    description: "Ask before commands and file changes.",
    icon: LockIcon,
    available: true,
  },
  "auto-accept-edits": {
    label: "Auto-accept edits",
    description: "Auto-approve edits, ask before other actions. Unavailable for Motoko.",
    icon: PenLineIcon,
    available: false,
  },
  "full-access": {
    label: "Full access",
    description: "Allow commands and edits without prompts. Unavailable for Motoko.",
    icon: LockOpenIcon,
    available: false,
  },
};
const MOTOKO_RUNTIME_MODE_OPTIONS = Object.keys(MOTOKO_RUNTIME_MODE_CONFIG) as MotokoRuntimeMode[];

interface MotokoTranscriptEntry {
  readonly id: string;
  readonly role: "operator" | "motoko";
  readonly message: string;
  readonly createdAt: string;
  readonly result?: HermesChatResult;
}

type DevCommandSessionState = {
  readonly threadId: string;
  readonly terminalId: string;
  readonly status: "idle" | "starting" | "running" | "exited" | "error" | "closed";
  readonly log: string;
  readonly exitCode: number | null;
  readonly label: string | null;
  readonly updatedAt: string | null;
  readonly pid: number | null;
};

function makeTranscriptEntryId(role: MotokoTranscriptEntry["role"], createdAt: string): string {
  return `${role}:${createdAt}:${Math.floor(performance.now() * 1000)}`;
}

function motokoProjectRouteLabel(project: GitsCockpitProject): string {
  return `${project.project.title} | ${project.project.rootPath}`;
}

function motokoSelectedRouteLabel(selectedProjectRoot: string): string {
  return selectedProjectRoot.trim().length === 0 ? MOTOKO_ROOT_ROUTE_LABEL : selectedProjectRoot;
}

const EMPTY_MOTOKO_TRANSCRIPT: ReadonlyArray<MotokoTranscriptEntry> = [];

type MotokoProposalDecision = "approve" | "reject" | "defer";

const MOTOKO_TRANSCRIPTS_STORAGE_KEY = "gits:motoko:transcripts:v1";
const MOTOKO_TRANSCRIPT_PERSIST_LIMIT = 200;

type MotokoTranscriptState = Readonly<Record<string, ReadonlyArray<MotokoTranscriptEntry>>>;

function loadMotokoTranscripts(): MotokoTranscriptState {
  if (typeof window === "undefined") {
    return {};
  }
  try {
    const raw = window.localStorage.getItem(MOTOKO_TRANSCRIPTS_STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return {};
    }
    const transcripts: Record<string, ReadonlyArray<MotokoTranscriptEntry>> = {};
    for (const [routeKey, entries] of Object.entries(parsed)) {
      if (!Array.isArray(entries)) {
        continue;
      }
      transcripts[routeKey] = entries.filter(
        (entry): entry is MotokoTranscriptEntry =>
          isRecord(entry) &&
          typeof entry.id === "string" &&
          (entry.role === "operator" || entry.role === "motoko") &&
          typeof entry.message === "string" &&
          typeof entry.createdAt === "string",
      );
    }
    return transcripts;
  } catch {
    return {};
  }
}

function saveMotokoTranscripts(transcripts: MotokoTranscriptState): void {
  if (typeof window === "undefined") {
    return;
  }
  const bounded = Object.fromEntries(
    Object.entries(transcripts)
      .filter(([, entries]) => entries.length > 0)
      .map(([routeKey, entries]) => [routeKey, entries.slice(-MOTOKO_TRANSCRIPT_PERSIST_LIMIT)]),
  );
  try {
    window.localStorage.setItem(MOTOKO_TRANSCRIPTS_STORAGE_KEY, JSON.stringify(bounded));
  } catch {
    // Quota or private-mode failure: keep the in-memory transcript, drop persistence.
  }
}

const MOTOKO_PROPOSAL_STATUS_ACCENT: Record<HermesProposalCard["status"], string> = {
  proposed: "border-l-amber-500/60",
  approved: "border-l-emerald-500/60",
  drafted: "border-l-emerald-500/60",
  rejected: "border-l-destructive/60",
  blocked: "border-l-destructive/60",
  deferred: "border-l-border",
};

// Mirrors the server's draftKindFor so the card can announce what approval will do.
function motokoProposalDraftKind(
  proposal: HermesProposalCard,
): "delamain-peer" | "open-gsd" | "verification" {
  if (proposal.recommendedExecutor === "open-gsd") {
    return "open-gsd";
  }
  if (proposal.actionKind === "read-only") {
    return "verification";
  }
  return "delamain-peer";
}

function motokoDecisionSummary(
  decision: MotokoProposalDecision,
  title: string,
  result: {
    decided: HermesProposalCard;
    draft: HermesExecutionDraft | null;
    peer: DelamainPeer | null;
  },
): string {
  if (decision === "reject") {
    return `Rejected proposal "${title}".`;
  }
  if (decision === "defer") {
    return `Deferred proposal "${title}".`;
  }
  if (result.peer) {
    return `Approved "${title}" and dispatched Delamain peer ${result.peer.name ?? result.peer.id} on ${result.draft?.repo ?? "the proposal repo"}.`;
  }
  if (result.draft === null) {
    return `Approved "${title}" (status: ${result.decided.status}).`;
  }
  if (result.draft.status === "blocked") {
    return `Approved "${title}" but nothing was dispatched: ${result.draft.blockedReason ?? "the execution draft is blocked"}.`;
  }
  return `Approved "${title}" and created a ${result.draft.kind} handoff draft.`;
}

function MotokoProposalCardList({ label, items }: { label: string; items: ReadonlyArray<string> }) {
  if (items.length === 0) {
    return null;
  }
  return (
    <div>
      <div className="mb-1 text-[11px] font-medium uppercase text-muted-foreground/80">{label}</div>
      <ul className="grid gap-1 text-[11px] text-muted-foreground">
        {items.map((item, index) => (
          // oxlint-disable-next-line react/no-array-index-key -- lines can repeat; index keeps keys unique
          <li key={`${label}-${index}`} className="break-words">
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

function MotokoProposalCard({
  proposal,
  actionPending,
  onDecision,
  onDraft,
}: {
  proposal: HermesProposalCard;
  actionPending: boolean;
  onDecision: (proposal: HermesProposalCard, decision: MotokoProposalDecision) => void;
  onDraft: (proposalId: string) => void;
}) {
  const draftKind = motokoProposalDraftKind(proposal);
  const canApprove =
    proposal.status === "proposed" ||
    proposal.status === "deferred" ||
    proposal.status === "rejected";
  const canReject = proposal.status === "proposed" || proposal.status === "deferred";
  const canDefer = proposal.status === "proposed" || proposal.status === "blocked";
  const canDraft = proposal.status === "approved";
  const hasDetails =
    proposal.detail.trim().length > 0 ||
    proposal.evidence.length > 0 ||
    proposal.verificationPlan.length > 0 ||
    proposal.scope.length > 0;
  return (
    <article
      className={cn(
        "grid gap-2.5 rounded-lg border border-border/70 border-l-2 bg-card/80 px-3.5 py-3 text-xs shadow-xs",
        MOTOKO_PROPOSAL_STATUS_ACCENT[proposal.status],
      )}
    >
      <header className="grid gap-1.5">
        <div className="flex min-w-0 items-start justify-between gap-2">
          <span className="min-w-0 flex-1 text-[13px] font-semibold leading-snug text-foreground">
            {proposal.title}
          </span>
          <StatusPill label={proposal.status} tone={hermesProposalTone(proposal.status)} />
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
          <StatusPill
            label={`risk ${proposal.risk}`}
            tone={proposal.risk === "blocked" ? "danger" : "default"}
          />
          <span>{proposal.actionKind}</span>
          <span aria-hidden="true">|</span>
          <span>
            {draftKind === "delamain-peer"
              ? "approval dispatches a Delamain peer"
              : draftKind === "open-gsd"
                ? "approval drafts an Open GSD handoff"
                : "approval drafts a verification handoff"}
          </span>
          {proposal.projectDir ? (
            <>
              <span aria-hidden="true">|</span>
              <span className="min-w-0 truncate font-mono">{proposal.projectDir}</span>
            </>
          ) : null}
        </div>
      </header>
      <p className="leading-relaxed text-muted-foreground">{proposal.summary}</p>
      {hasDetails ? (
        <details className="overflow-hidden rounded-md border border-border/60 bg-background/70">
          <summary className="cursor-pointer select-none px-3 py-2 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground">
            Details, evidence & verification
          </summary>
          <div className="grid gap-3 border-t border-border/60 px-3 py-3">
            {proposal.detail.trim().length > 0 ? (
              <p className="whitespace-pre-wrap leading-relaxed text-muted-foreground">
                {proposal.detail}
              </p>
            ) : null}
            <MotokoProposalCardList label="Evidence" items={proposal.evidence} />
            <MotokoProposalCardList label="Verification plan" items={proposal.verificationPlan} />
            <MotokoProposalCardList label="Scope" items={proposal.scope} />
          </div>
        </details>
      ) : null}
      {proposal.blockedReason ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-[11px] text-destructive">
          {proposal.blockedReason}
        </div>
      ) : null}
      {proposal.decisionReason ? (
        <div className="text-[11px] text-muted-foreground">
          Decision note: {proposal.decisionReason}
        </div>
      ) : null}
      <footer className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[11px] text-muted-foreground">
          {proposal.decidedAt
            ? `decided ${formatIsoDate(proposal.decidedAt)}`
            : `proposed ${formatIsoDate(proposal.createdAt)}`}
        </span>
        <div className="flex flex-wrap justify-end gap-2">
          {canDefer ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onDecision(proposal, "defer")}
              disabled={actionPending}
            >
              Defer
            </Button>
          ) : null}
          {canReject ? (
            <Button
              size="sm"
              variant="destructive-outline"
              onClick={() => onDecision(proposal, "reject")}
              disabled={actionPending}
            >
              Reject
            </Button>
          ) : null}
          {canApprove ? (
            <Button
              size="sm"
              onClick={() => onDecision(proposal, "approve")}
              disabled={actionPending}
            >
              <CheckCircle2Icon className="size-3.5" />
              {draftKind === "delamain-peer" ? "Approve & dispatch" : "Approve"}
            </Button>
          ) : null}
          {canDraft ? (
            <Button size="sm" onClick={() => onDraft(proposal.id)} disabled={actionPending}>
              <FilePlus2Icon className="size-3.5" />
              Draft handoff
            </Button>
          ) : null}
        </div>
      </footer>
    </article>
  );
}

function motokoModelControlValue(status: HermesStatusResult | undefined): string {
  const provider = status?.model.provider ?? "unknown";
  const model = status?.model.model ?? "unknown";
  return `${provider}:${model}`;
}

function MotokoFooterModelControl({ status }: { status: HermesStatusResult | undefined }) {
  const provider = status?.model.provider ?? "Hermes";
  const model = status?.model.model ?? "model setup";
  const contextWindowLabel = formatTokenLimit(status?.model.contextWindowTokens);
  const value = motokoModelControlValue(status);

  return (
    <Select
      modal={false}
      value={value}
      items={[{ value, label: model }]}
      onValueChange={() => undefined}
    >
      <SelectTrigger
        aria-label="Motoko model"
        className="shrink-0 font-medium text-muted-foreground/70 hover:text-foreground/80"
        size="sm"
        title={`${provider} | context ${contextWindowLabel}`}
        variant="ghost"
      >
        <SparklesIcon className="size-4" />
        <SelectValue>{model}</SelectValue>
      </SelectTrigger>
      <SelectPopup alignItemWithTrigger={false} popupClassName="w-72">
        <SelectGroup>
          <SelectGroupLabel>Hermes model</SelectGroupLabel>
          <SelectItem value={value} className="py-2">
            <div className="grid min-w-0 gap-0.5">
              <span className="truncate font-medium text-foreground">{model}</span>
              <span className="truncate text-xs leading-4 text-muted-foreground">
                {provider} | context {contextWindowLabel}
              </span>
            </div>
          </SelectItem>
        </SelectGroup>
      </SelectPopup>
    </Select>
  );
}

function MotokoFooterModeControls({
  interactionMode,
  onToggleInteractionMode,
}: {
  interactionMode: MotokoInteractionMode;
  onToggleInteractionMode: () => void;
}) {
  const runtimeModeOption = MOTOKO_RUNTIME_MODE_CONFIG[MOTOKO_RUNTIME_MODE];
  const RuntimeModeIcon = runtimeModeOption.icon;

  return (
    <>
      <Separator orientation="vertical" className="mx-0.5 hidden h-4 sm:block" />
      <Button
        variant="ghost"
        className="shrink-0 whitespace-nowrap px-2 text-muted-foreground/70 hover:text-foreground/80 sm:px-3"
        size="sm"
        type="button"
        onClick={onToggleInteractionMode}
        title={
          interactionMode === "plan"
            ? "Plan mode - click to return to build mode"
            : "Build mode - click to enter plan mode"
        }
      >
        <BotIcon />
        <span className="sr-only sm:not-sr-only">
          {interactionMode === "plan" ? "Plan" : "Build"}
        </span>
      </Button>

      <Separator orientation="vertical" className="mx-0.5 hidden h-4 sm:block" />
      <Select
        modal={false}
        value={MOTOKO_RUNTIME_MODE}
        items={MOTOKO_RUNTIME_MODE_OPTIONS.map((mode) => ({
          value: mode,
          label: MOTOKO_RUNTIME_MODE_CONFIG[mode].label,
        }))}
        onValueChange={() => undefined}
      >
        <SelectTrigger
          aria-label="Motoko runtime mode"
          className="shrink-0 font-medium"
          size="sm"
          title={runtimeModeOption.description}
          variant="ghost"
        >
          <RuntimeModeIcon className="size-4" />
          <SelectValue>{runtimeModeOption.label}</SelectValue>
        </SelectTrigger>
        <SelectPopup alignItemWithTrigger={false} popupClassName="w-72">
          {MOTOKO_RUNTIME_MODE_OPTIONS.map((mode) => {
            const option = MOTOKO_RUNTIME_MODE_CONFIG[mode];
            const OptionIcon = option.icon;
            return (
              <SelectItem key={mode} value={mode} className="py-2" disabled={!option.available}>
                <div className="grid min-w-0 gap-0.5">
                  <span className="inline-flex min-w-0 items-center gap-1.5 font-medium text-foreground">
                    <OptionIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate">{option.label}</span>
                  </span>
                  <span className="text-xs leading-4 text-muted-foreground">
                    {option.description}
                  </span>
                </div>
              </SelectItem>
            );
          })}
        </SelectPopup>
      </Select>
    </>
  );
}

function MotokoContextWindowChip({ status }: { status: HermesStatusResult | undefined }) {
  return (
    <span className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-border/70 bg-muted/24 px-2.5 text-[11px] font-medium text-muted-foreground">
      <GaugeIcon className="size-3.5" />
      <span className="tabular-nums">{formatTokenLimit(status?.model.contextWindowTokens)}</span>
    </span>
  );
}

function MotokoChatComposer({
  status,
  projects,
  selectedProjectRoot,
  chatInput,
  interactionMode,
  actionPending,
  onToggleInteractionMode,
  onProjectRootChange,
  onChatInputChange,
  onChatSubmit,
}: {
  status: HermesStatusResult | undefined;
  projects: ReadonlyArray<GitsCockpitProject>;
  selectedProjectRoot: string;
  chatInput: string;
  interactionMode: MotokoInteractionMode;
  actionPending: boolean;
  onToggleInteractionMode: () => void;
  onProjectRootChange: (value: string) => void;
  onChatInputChange: (value: string) => void;
  onChatSubmit: () => void;
}) {
  const canSend = !actionPending && chatInput.trim().length > 0;
  const chatInputRef = useRef(chatInput);
  chatInputRef.current = chatInput;
  const voiceTranscription = useVoiceTranscription({
    onTranscript: (text) => {
      const current = chatInputRef.current;
      onChatInputChange(current.trim().length > 0 ? `${current} ${text}` : text);
    },
  });
  const routeItems = useMemo(
    () => [
      { value: MOTOKO_ROOT_ROUTE_SELECT_VALUE, label: MOTOKO_ROOT_ROUTE_LABEL },
      ...projects.map((project) => ({
        value: project.project.rootPath,
        label: motokoProjectRouteLabel(project),
      })),
    ],
    [projects],
  );
  const selectedRouteValue =
    selectedProjectRoot.trim().length === 0 ? MOTOKO_ROOT_ROUTE_SELECT_VALUE : selectedProjectRoot;

  const submit = () => {
    if (canSend) {
      onChatSubmit();
    }
  };

  return (
    <form
      className="mx-auto w-full max-w-208"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="rounded-[22px] border border-border/70 bg-card p-px shadow-[0_18px_44px_rgba(0,0,0,0.24)] transition-colors has-focus-within:border-ring/45">
        <div className="overflow-hidden rounded-[20px] border border-border/60 bg-background/96">
          <div className="px-3 pt-3.5 sm:px-4 sm:pt-4">
            <textarea
              value={chatInput}
              placeholder="Ask Motoko"
              className="min-h-24 w-full resize-none bg-transparent text-sm leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/45 sm:min-h-28"
              rows={3}
              onChange={(event) => onChatInputChange(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  submit();
                }
              }}
            />
          </div>
          <div
            data-chat-composer-footer="true"
            className="flex min-w-0 flex-nowrap items-center justify-between gap-2 overflow-visible border-t border-border/55 px-2.5 pb-2.5 pt-2.5 sm:px-3"
          >
            <div className="-m-1 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              <div className="min-w-48 max-w-72 shrink-0">
                <Select
                  modal={false}
                  value={selectedRouteValue}
                  items={routeItems}
                  onValueChange={(value) => {
                    if (typeof value !== "string") {
                      return;
                    }
                    onProjectRootChange(
                      value === MOTOKO_ROOT_ROUTE_SELECT_VALUE ? MOTOKO_ROOT_ROUTE_VALUE : value,
                    );
                  }}
                >
                  <SelectTrigger
                    aria-label="Motoko route"
                    variant="ghost"
                    size="sm"
                    className="min-h-8 w-full min-w-0 rounded-full border border-border/70 bg-muted/24 px-3 py-1.5 text-foreground shadow-none transition-colors hover:bg-accent focus-visible:border-ring/45 focus-visible:bg-background focus-visible:ring-2 focus-visible:ring-ring/24 sm:min-h-8"
                  >
                    <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground/75" />
                    <SelectValue className="min-w-0 font-mono text-[11px]" />
                  </SelectTrigger>
                  <SelectPopup
                    className="max-h-72"
                    popupClassName="max-w-[min(34rem,calc(100vw-2rem))]"
                  >
                    <SelectGroup>
                      <SelectGroupLabel>Motoko route</SelectGroupLabel>
                      <SelectItem value={MOTOKO_ROOT_ROUTE_SELECT_VALUE}>
                        <span className="inline-flex min-w-0 items-center gap-2">
                          <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground/75" />
                          <span className="min-w-0 truncate font-mono text-[11px]">
                            {MOTOKO_ROOT_ROUTE_LABEL}
                          </span>
                        </span>
                      </SelectItem>
                      {projects.map((project) => (
                        <SelectItem key={project.project.id} value={project.project.rootPath}>
                          <span className="grid min-w-0 gap-0.5">
                            <span className="truncate text-sm text-foreground">
                              {project.project.title}
                            </span>
                            <span className="truncate font-mono text-[11px] text-muted-foreground">
                              {project.project.rootPath}
                            </span>
                          </span>
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectPopup>
                </Select>
              </div>

              <MotokoFooterModelControl status={status} />
              <MotokoFooterModeControls
                interactionMode={interactionMode}
                onToggleInteractionMode={onToggleInteractionMode}
              />
            </div>
            <div
              data-chat-composer-actions="right"
              className="flex shrink-0 flex-nowrap items-center justify-end gap-2"
            >
              <MotokoContextWindowChip status={status} />
              <ComposerVoiceButton
                size="icon"
                className="size-9 rounded-full before:rounded-full sm:size-8"
                state={voiceTranscription.state}
                missingApiKey={voiceTranscription.missingApiKey}
                onStart={() => void voiceTranscription.start()}
                onStop={voiceTranscription.stop}
              />
              <Button
                type="submit"
                size="icon"
                className="size-9 rounded-full before:rounded-full sm:size-8"
                disabled={!canSend}
                aria-label="Send message to Motoko"
              >
                <ArrowUpIcon className="size-4" />
              </Button>
            </div>
          </div>
        </div>
      </div>
    </form>
  );
}

function MotokoCapsuleAvatar({
  available,
  pendingCount,
}: {
  available: boolean;
  pendingCount: number;
}) {
  return (
    <div className="overflow-hidden rounded-md border border-border/70 bg-black p-2 shadow-[0_18px_44px_rgba(0,0,0,0.34)]">
      <div className="relative aspect-square overflow-hidden rounded-sm bg-black">
        <img
          alt=""
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-10 size-full select-none object-cover"
          draggable={false}
          src={MOTOKO_CAPSULE_FRAME_SRC}
        />
        <div
          className="absolute z-20 overflow-hidden bg-black shadow-[0_0_28px_rgba(236,72,153,0.2)]"
          style={MOTOKO_CAPSULE_VIDEO_WINDOW_STYLE}
        >
          <video
            aria-hidden="true"
            autoPlay={
              typeof window === "undefined" ||
              !window.matchMedia("(prefers-reduced-motion: reduce)").matches
            }
            className="size-full object-cover"
            loop
            muted
            playsInline
            preload="metadata"
            src={MOTOKO_CAPSULE_VIDEO_SRC}
          />
          <div className="pointer-events-none absolute inset-0 border border-fuchsia-300/20 shadow-[inset_0_0_30px_rgba(236,72,153,0.18)]" />
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 px-1">
        <div className="min-w-0">
          <div className="truncate font-medium text-fuchsia-100/90">Cyberbrain pod</div>
          <div className="truncate text-muted-foreground">{formatCount(pendingCount)} pending</div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <StatusPill label="Motoko" tone={available ? "success" : "warning"} />
          <StatusPill
            label={available ? "online" : "setup"}
            tone={available ? "success" : "warning"}
          />
        </div>
      </div>
    </div>
  );
}

function makeDevTerminalId(commandId: string): string {
  return `gits-dev-${commandId}`;
}

function makeDevThreadId(projectDir: string): string {
  return `gits-dev:${projectDir}`;
}

function handleDevOpenPreview(command: GitsDevCommand): void {
  if (!command.previewUrl) {
    return;
  }
  window.open(command.previewUrl, "_blank", "noopener,noreferrer");
}

function trimTerminalLog(log: string): string {
  const maxLength = 24_000;
  return log.length <= maxLength ? log : log.slice(log.length - maxLength);
}

function reduceDevCommandEvent(
  current: DevCommandSessionState,
  event: TerminalAttachStreamEvent,
): DevCommandSessionState {
  if (event.type === "snapshot") {
    return {
      threadId: current.threadId,
      terminalId: event.snapshot.terminalId,
      status: event.snapshot.status,
      log: trimTerminalLog(event.snapshot.history),
      exitCode: event.snapshot.exitCode,
      label: event.snapshot.label,
      updatedAt: event.snapshot.updatedAt,
      pid: event.snapshot.pid,
    };
  }
  if (event.type === "output") {
    return {
      ...current,
      status: current.status === "idle" ? "running" : current.status,
      log: trimTerminalLog(current.log + event.data),
    };
  }
  if (event.type === "activity") {
    return {
      ...current,
      status: event.hasRunningSubprocess ? "running" : current.status,
      label: event.label,
    };
  }
  if (event.type === "restarted") {
    return {
      threadId: current.threadId,
      terminalId: event.snapshot.terminalId,
      status: event.snapshot.status,
      log: trimTerminalLog(event.snapshot.history),
      exitCode: event.snapshot.exitCode,
      label: event.snapshot.label,
      updatedAt: event.snapshot.updatedAt,
      pid: event.snapshot.pid,
    };
  }
  if (event.type === "exited") {
    return {
      ...current,
      status: "exited",
      exitCode: event.exitCode,
      pid: null,
    };
  }
  if (event.type === "error") {
    return {
      ...current,
      status: "error",
      log: trimTerminalLog(
        `${current.log}${current.log.endsWith("\n") || current.log.length === 0 ? "" : "\n"}[error] ${event.message}\n`,
      ),
    };
  }
  if (event.type === "cleared") {
    return {
      ...current,
      log: "",
    };
  }
  return {
    ...current,
    status: "closed",
    pid: null,
  };
}

function devCommandStatusTone(
  status: DevCommandSessionState["status"],
): ReturnType<typeof statusTone> {
  if (status === "running") {
    return "success";
  }
  if (status === "starting") {
    return "warning";
  }
  if (status === "error") {
    return "danger";
  }
  return "default";
}

function MotokoPanel({
  status,
  capacity,
  sessions,
  projects,
  log,
  proposals,
  loading,
  error,
  actionError,
  chatResult,
  commandResult,
  draft,
  scheduleResult,
  transcript,
  selectedProjectRoot,
  chatInput,
  interactionMode,
  scheduleKind,
  actionPending,
  onRefresh,
  onToggleInteractionMode,
  onProjectRootChange,
  onChatInputChange,
  onScheduleKindChange,
  onCheck,
  onSetupCodexOAuth,
  onStartAcp,
  onInspectGits,
  onChatSubmit,
  onClearChat,
  onNewChat,
  onDecision,
  onWriteContext,
  onDraft,
  onRunSchedule,
}: {
  status: HermesStatusResult | undefined;
  capacity: GitsCapacitySnapshot | undefined;
  sessions: HermesSessionListResult | undefined;
  projects: ReadonlyArray<GitsCockpitProject>;
  log: HermesLogTailResult | undefined;
  proposals: HermesProposalListResult | undefined;
  loading: boolean;
  error: unknown;
  actionError: unknown;
  chatResult: HermesChatResult | undefined;
  commandResult: HermesCommandResult | undefined;
  draft: HermesExecutionDraft | undefined;
  scheduleResult: HermesScheduleRunResult | undefined;
  transcript: ReadonlyArray<MotokoTranscriptEntry>;
  selectedProjectRoot: string;
  chatInput: string;
  interactionMode: MotokoInteractionMode;
  scheduleKind: HermesScheduleKind;
  actionPending: boolean;
  onRefresh: () => void;
  onToggleInteractionMode: () => void;
  onProjectRootChange: (value: string) => void;
  onChatInputChange: (value: string) => void;
  onScheduleKindChange: (value: HermesScheduleKind) => void;
  onCheck: () => void;
  onSetupCodexOAuth: () => void;
  onStartAcp: () => void;
  onInspectGits: () => void;
  onChatSubmit: () => void;
  onClearChat: () => void;
  onNewChat: () => void;
  onDecision: (proposal: HermesProposalCard, decision: MotokoProposalDecision) => void;
  onWriteContext: () => void;
  onDraft: (proposalId: string) => void;
  onRunSchedule: () => void;
}) {
  const cards = proposals?.proposals ?? [];
  const [proposalsOpen, setProposalsOpen] = useState(false);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const node = transcriptRef.current;
    if (node) {
      node.scrollTop = node.scrollHeight;
    }
  }, [transcript.length]);
  const errorMessage =
    error instanceof Error
      ? error.message
      : actionError instanceof Error
        ? actionError.message
        : null;
  const pendingCount = cards.filter((proposal) => proposal.status === "proposed").length;
  const resultCount = [chatResult, commandResult, draft, scheduleResult].filter(Boolean).length;
  const routeLabel = motokoSelectedRouteLabel(selectedProjectRoot);
  const modelLabel = status?.model.model ?? "unknown";
  const contextWindowLabel = formatTokenLimit(status?.model.contextWindowTokens);

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
        <div className="flex shrink-0 items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => setProposalsOpen(true)}>
            <ListChecksIcon className="size-3.5" />
            Proposals
            <span
              className={cn(
                "rounded-full px-1.5 text-[11px] tabular-nums",
                pendingCount > 0
                  ? "bg-amber-500/15 text-amber-600"
                  : "bg-muted text-muted-foreground",
              )}
            >
              {formatCount(pendingCount)}
            </span>
          </Button>
          <Button size="sm" variant="outline" onClick={onRefresh} disabled={loading}>
            <RefreshCwIcon className={cn("size-3.5", loading && "animate-spin")} />
            Refresh
          </Button>
        </div>
      </div>

      {errorMessage ? (
        <div
          aria-live="polite"
          className="border-b border-border/60 px-4 py-2 text-xs text-destructive sm:px-5"
        >
          {errorMessage}
        </div>
      ) : null}

      <div className="grid grid-cols-2 border-b border-border/60 sm:grid-cols-4 xl:grid-cols-8">
        <StatBlock label="Proposals" value={formatCount(cards.length)} icon={SparklesIcon} />
        <StatBlock label="Pending" value={formatCount(pendingCount)} icon={AlertTriangleIcon} />
        <StatBlock
          label="OAuth"
          value={status?.codexAuth.state ?? "unknown"}
          icon={ShieldCheckIcon}
        />
        <StatBlock label="Mode" value={status?.config.approvalMode ?? "unknown"} icon={PowerIcon} />
        <StatBlock
          label="Router"
          value={capacity?.recommendation.recommendedEngine ?? "check"}
          icon={BotIcon}
        />
        <StatBlock label="Model" value={modelLabel} icon={SparklesIcon} />
        <StatBlock label="Context" value={contextWindowLabel} icon={GaugeIcon} />
        <StatBlock
          label="Sessions"
          value={formatCount(sessions?.sessions.length ?? 0)}
          icon={BotIcon}
        />
      </div>

      {status?.setupWarnings.length ? (
        <div className="divide-y divide-border/60 border-b border-border/60">
          {status.setupWarnings.slice(0, 5).map((warning, index) => (
            // oxlint-disable-next-line react/no-array-index-key -- warnings can repeat; index keeps keys unique
            <div key={`warning-${index}`} className="px-4 py-2 text-xs text-amber-600 sm:px-5">
              {warning}
            </div>
          ))}
        </div>
      ) : null}

      <div className="grid min-w-0 grid-cols-1 xl:grid-cols-[minmax(0,1.2fr)_minmax(340px,0.85fr)]">
        <div className="min-w-0 border-b border-border/60 xl:border-b-0 xl:border-r">
          <div className="flex min-h-[46rem] flex-col bg-background">
            <div className="flex items-center justify-between gap-2 border-b border-border/60 px-4 py-2 sm:px-5">
              <div className="flex min-w-0 items-center gap-2 text-xs">
                <span className="font-medium text-muted-foreground">
                  Conversation ({formatCount(transcript.length)})
                </span>
                <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground/70">
                  {routeLabel}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={onClearChat}
                  disabled={transcript.length === 0}
                >
                  <Trash2Icon className="size-3.5" />
                  Clear
                </Button>
                <Button size="sm" variant="outline" onClick={onNewChat}>
                  <MessageSquarePlusIcon className="size-3.5" />
                  New chat
                </Button>
              </div>
            </div>
            <div
              ref={transcriptRef}
              aria-live="polite"
              className="flex-1 overflow-auto bg-[radial-gradient(circle_at_50%_0%,--theme(--color-muted/32%),transparent_36%)] px-4 py-5 text-xs sm:px-5 sm:py-6"
            >
              {transcript.length === 0 ? (
                <div className="flex min-h-96 items-center justify-center">
                  <div className="grid justify-items-center gap-3 text-center">
                    <div className="overflow-hidden rounded-xl border border-border/70 bg-white p-2 shadow-[0_18px_44px_rgba(0,0,0,0.18)]">
                      <img
                        alt=""
                        aria-hidden="true"
                        className="size-24 rounded-lg object-cover"
                        draggable={false}
                        src={MOTOKO_CHAT_LOGO_SRC}
                      />
                    </div>
                    <EmptyState label="Motoko is standing by." />
                    <div className="max-w-80 px-4 text-xs text-muted-foreground">
                      Route {routeLabel} | Hermes {status?.model.provider ?? "provider unknown"} /{" "}
                      {modelLabel} | context {contextWindowLabel}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
                  {transcript.length > 80 ? (
                    <div className="text-center text-[11px] text-muted-foreground">
                      +{formatCount(transcript.length - 80)} earlier messages hidden
                    </div>
                  ) : null}
                  {transcript.slice(-80).map((entry) => {
                    // Prefer the live proposal so inline decision buttons track current status.
                    const entryProposal = entry.result?.proposal
                      ? (cards.find((card) => card.id === entry.result?.proposal?.id) ??
                        entry.result.proposal)
                      : null;
                    return (
                      <div
                        key={entry.id}
                        className={cn(
                          "flex w-full",
                          entry.role === "operator" ? "justify-end" : "justify-start",
                        )}
                      >
                        <div
                          className={cn(
                            "grid max-w-[92%] gap-2 rounded-2xl border px-4 py-3 shadow-xs",
                            entry.role === "operator"
                              ? "rounded-br-md border-primary/30 bg-primary text-primary-foreground"
                              : "rounded-bl-md border-border/70 bg-card/88 text-foreground",
                          )}
                        >
                          <div className="flex min-w-0 items-center justify-between gap-2">
                            <span
                              className={cn(
                                "font-medium",
                                entry.role === "operator"
                                  ? "text-primary-foreground"
                                  : "text-foreground",
                              )}
                            >
                              {entry.role === "operator" ? "You" : "Motoko"}
                            </span>
                            <span
                              className={cn(
                                "text-[11px]",
                                entry.role === "operator"
                                  ? "text-primary-foreground/70"
                                  : "text-muted-foreground",
                              )}
                            >
                              {formatIsoDate(entry.createdAt)}
                            </span>
                          </div>
                          <pre
                            className={cn(
                              "whitespace-pre-wrap font-sans text-[13px] leading-relaxed",
                              entry.role === "operator"
                                ? "text-primary-foreground/95"
                                : "text-foreground",
                            )}
                          >
                            {entry.message}
                          </pre>
                          {entry.result?.status === "setup-required" ? (
                            <div className="grid gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2">
                              <div className="font-medium text-amber-700">
                                {entry.result.setupTitle ?? "Hermes setup required"}
                              </div>
                              {entry.result.setupDetail ? (
                                <pre className="whitespace-pre-wrap font-sans text-[11px] leading-relaxed text-amber-700">
                                  {entry.result.setupDetail}
                                </pre>
                              ) : null}
                              {entry.result.setupCommand ? (
                                <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/60 bg-background px-2 py-2">
                                  <code className="min-w-0 flex-1 overflow-auto text-[11px] text-foreground">
                                    {entry.result.setupCommand}
                                  </code>
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() =>
                                      void navigator.clipboard.writeText(
                                        entry.result!.setupCommand!,
                                      )
                                    }
                                  >
                                    <CopyIcon className="size-3.5" />
                                    Copy
                                  </Button>
                                </div>
                              ) : null}
                            </div>
                          ) : null}
                          {entryProposal ? (
                            <MotokoProposalCard
                              proposal={entryProposal}
                              actionPending={actionPending}
                              onDecision={onDecision}
                              onDraft={onDraft}
                            />
                          ) : null}
                          {entry.result?.blockedReason &&
                          entry.result.status !== "setup-required" ? (
                            <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-[11px] text-destructive">
                              {entry.result.blockedReason}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="border-t border-border/60 bg-background/96 px-4 py-4 backdrop-blur sm:px-5">
              <MotokoChatComposer
                status={status}
                projects={projects}
                selectedProjectRoot={selectedProjectRoot}
                chatInput={chatInput}
                interactionMode={interactionMode}
                actionPending={actionPending}
                onToggleInteractionMode={onToggleInteractionMode}
                onProjectRootChange={onProjectRootChange}
                onChatInputChange={onChatInputChange}
                onChatSubmit={onChatSubmit}
              />
            </div>
          </div>
        </div>

        <div className="min-w-0">
          <div className="grid gap-4 px-4 py-4 text-xs sm:px-5">
            <MotokoCapsuleAvatar
              available={status?.available === true}
              pendingCount={pendingCount}
            />
            <div className="grid gap-2 rounded-md border border-border/70 bg-muted/20 px-3 py-3">
              <div className="flex items-center justify-between gap-2">
                <div className="font-medium text-muted-foreground">Motoko actions</div>
                <StatusPill
                  label={status?.available ? "ready" : "setup"}
                  tone={status?.available ? "success" : "warning"}
                />
              </div>
              <div className="flex flex-wrap gap-2">
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
              </div>
              <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
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
                <Button
                  size="sm"
                  variant="outline"
                  onClick={onRunSchedule}
                  disabled={actionPending}
                >
                  <PlayIcon className="size-3.5" />
                  Run
                </Button>
              </div>
            </div>

            {chatResult || commandResult || draft || scheduleResult ? (
              <div className="grid gap-3">
                <SectionHeader title="Result" count={resultCount} />
                {chatResult ? (
                  <div className="grid gap-2 rounded-md border border-border/70 bg-muted/20 px-3 py-2">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <StatusPill
                        label={chatResult.status}
                        tone={
                          chatResult.status === "blocked"
                            ? "danger"
                            : chatResult.status === "setup-required"
                              ? "warning"
                              : "success"
                        }
                      />
                      <StatusPill label={chatResult.actionKind} tone="default" />
                    </div>
                    <pre className="max-h-48 overflow-auto whitespace-pre-wrap font-sans text-[12px] leading-relaxed text-foreground">
                      {chatResult.response}
                    </pre>
                  </div>
                ) : null}
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

      <Sheet open={proposalsOpen} onOpenChange={setProposalsOpen}>
        <SheetPopup side="right" className="max-w-xl">
          <SheetHeader>
            <SheetTitle>Motoko proposals</SheetTitle>
            <SheetDescription>
              {formatCount(pendingCount)} pending | {formatCount(cards.length)} total
            </SheetDescription>
          </SheetHeader>
          <SheetPanel className="grid gap-3">
            {loading && cards.length === 0 ? (
              <EmptyState label="Loading Motoko proposals..." />
            ) : cards.length === 0 ? (
              <EmptyState label="No Motoko proposals." />
            ) : (
              cards.map((proposal) => (
                <MotokoProposalCard
                  key={proposal.id}
                  proposal={proposal}
                  actionPending={actionPending}
                  onDecision={onDecision}
                  onDraft={onDraft}
                />
              ))
            )}
          </SheetPanel>
        </SheetPopup>
      </Sheet>
    </section>
  );
}

function DevCommandPanel({
  list,
  loading,
  error,
  selectedProjectRoot,
  onRefresh,
  sessionStateByCommandId,
  activeCommandId,
  actionError,
  actionPending,
  onStart,
  onStop,
  onCopyLaunchCommand,
  onOpenPreview,
}: {
  list: GitsDevCommandListResult | undefined;
  loading: boolean;
  error: unknown;
  selectedProjectRoot: string;
  onRefresh: () => void;
  sessionStateByCommandId: Readonly<Record<string, DevCommandSessionState | undefined>>;
  activeCommandId: string | null;
  actionError: string | null;
  actionPending: boolean;
  onStart: (command: GitsDevCommand) => void;
  onStop: (command: GitsDevCommand) => void;
  onCopyLaunchCommand: (command: GitsDevCommand) => void;
  onOpenPreview: (command: GitsDevCommand) => void;
}) {
  return (
    <section className="border-b border-border/60">
      <div className="flex min-w-0 flex-col gap-3 px-4 py-4 sm:px-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold">Dev Commands</h2>
            <p className="text-xs text-muted-foreground">
              Repo launchers start terminal sessions directly and can publish previews on the
              tailnet after the port is ready.
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={onRefresh} disabled={loading}>
            <RefreshCwIcon className={cn("size-3.5", loading && "animate-spin")} />
            Refresh
          </Button>
        </div>
        <div className="grid gap-1 text-xs text-muted-foreground">
          <div>Route: {motokoSelectedRouteLabel(selectedProjectRoot)}</div>
          <div>Config: {list?.configPath ?? "Missing"}</div>
          {list?.magicDnsName ? <div>Tailnet: {list.magicDnsName}</div> : null}
        </div>
        {list?.warnings.length ? (
          <div className="rounded-sm border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            {list.warnings.join(" ")}
          </div>
        ) : null}
        {actionError ? (
          <div
            aria-live="polite"
            className="rounded-sm border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
          >
            {actionError}
          </div>
        ) : null}
      </div>

      {loading ? (
        <div className="px-4 py-6 text-sm text-muted-foreground sm:px-5">
          Loading dev commands...
        </div>
      ) : error ? (
        <div className="px-4 py-6 text-sm text-destructive sm:px-5">
          {error instanceof Error ? error.message : "Failed to load dev commands."}
        </div>
      ) : !list || list.commands.length === 0 ? (
        <div className="px-4 py-6 text-sm text-muted-foreground sm:px-5">
          No repo launchers found.
        </div>
      ) : (
        <div className="divide-y divide-border/60">
          {list.commands.map((command) => {
            const session = sessionStateByCommandId[command.id];
            const status = session?.status ?? "idle";
            return (
              <div key={command.id} className="grid gap-3 px-4 py-4 sm:px-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div role="status" className="flex flex-wrap items-center gap-2">
                      <h3 className="text-sm font-medium">{command.name}</h3>
                      <StatusPill label={status} tone={devCommandStatusTone(status)} />
                      {command.localPort !== null ? (
                        <span className="font-mono text-[11px] text-muted-foreground">
                          {command.localHost ?? "127.0.0.1"}:{command.localPort}
                        </span>
                      ) : null}
                      {command.previewUrl ? (
                        <span className="font-mono text-[11px] text-muted-foreground">
                          {command.previewUrl}
                        </span>
                      ) : null}
                    </div>
                    {command.description ? (
                      <p className="mt-1 text-xs text-muted-foreground">{command.description}</p>
                    ) : null}
                    <div className="mt-2 grid gap-1 font-mono text-[11px] text-muted-foreground">
                      <div>{command.cwd}</div>
                      <div>{command.command}</div>
                      {session?.label ? <div>Session: {session.label}</div> : null}
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="default"
                      onClick={() => onStart(command)}
                      disabled={actionPending && activeCommandId === command.id}
                    >
                      <PlayIcon className="size-3.5" />
                      Start
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => onStop(command)}
                      disabled={actionPending && activeCommandId === command.id}
                    >
                      <CircleStopIcon className="size-3.5" />
                      Stop
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => onCopyLaunchCommand(command)}
                      aria-label={`Copy launch command for ${command.name}`}
                    >
                      <CopyIcon className="size-3.5" />
                    </Button>
                    {command.previewUrl ? (
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => onOpenPreview(command)}
                        aria-label={`Open preview for ${command.name}`}
                      >
                        <ExternalLinkIcon className="size-3.5" />
                      </Button>
                    ) : null}
                  </div>
                </div>
                <div className="rounded-sm border border-border/60 bg-muted/20">
                  <div className="flex items-center justify-between border-b border-border/60 px-3 py-2">
                    <span className="text-[11px] font-medium uppercase text-muted-foreground">
                      Terminal
                    </span>
                    <span className="font-mono text-[11px] text-muted-foreground">
                      {session?.updatedAt ? formatIsoDate(session.updatedAt) : "idle"}
                    </span>
                  </div>
                  <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[11px] text-foreground">
                    {session?.log?.trim().length ? session.log : "No output yet."}
                  </pre>
                </div>
              </div>
            );
          })}
        </div>
      )}
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
        <div
          aria-live="polite"
          className="border-b border-border/60 px-4 py-2 text-xs text-destructive sm:px-5"
        >
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
            <StatusPill label="local host" tone="default" />
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
        <div
          aria-live="polite"
          className="border-b border-border/60 px-4 py-2 text-xs text-destructive sm:px-5"
        >
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
              {visibleSkills.length > 160 ? (
                <div className="px-4 py-2 text-[11px] text-muted-foreground sm:px-5">
                  +{formatCount(visibleSkills.length - 160)} more skills
                </div>
              ) : null}
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
                <div
                  role="group"
                  aria-label={`Skill rating: ${selectedSkill.rating ?? 0} of 5`}
                  className="flex flex-wrap gap-1"
                >
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
                        aria-pressed={selected}
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
                        {formatCount(provider.missingPortCount)} missing ports
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

const NO_MCP_SERVERS: GitsMcpInventorySnapshot["servers"] = [];

function McpServersPanel({
  snapshot,
  loading,
  error,
  overrides,
  onRefresh,
  onToggleServer,
}: {
  snapshot: GitsMcpInventorySnapshot | undefined;
  loading: boolean;
  error: unknown;
  overrides: McpOverrideState;
  onRefresh: () => void;
  onToggleServer: (serverId: string, enabled: boolean) => void;
}) {
  const [providerFilter, setProviderFilter] = useState<GitsMcpServerProvider | "all">("all");
  const [search, setSearch] = useState("");
  const [selectedServerId, setSelectedServerId] = useState<string | null>(null);
  const servers = snapshot?.servers ?? NO_MCP_SERVERS;
  const visibleServers = useMemo(() => {
    const query = search.trim().toLowerCase();
    return servers.filter((server) => {
      if (providerFilter !== "all" && server.provider !== providerFilter) {
        return false;
      }
      if (!query) {
        return true;
      }
      return [
        server.name,
        server.provider,
        server.command ?? "",
        server.transport ?? "",
        server.tools.join(" "),
      ]
        .join(" ")
        .toLowerCase()
        .includes(query);
    });
  }, [providerFilter, search, servers]);
  const selectedServer =
    (selectedServerId ? servers.find((server) => server.id === selectedServerId) : null) ??
    visibleServers[0] ??
    null;
  const enabledCount = servers.filter((server) => isMcpServerEnabled(server, overrides)).length;
  const overriddenCount = servers.filter(
    (server) => overrides[server.id] !== undefined && overrides[server.id] !== server.enabled,
  ).length;
  const errorMessage = error instanceof Error ? error.message : null;

  useEffect(() => {
    if (selectedServerId && visibleServers.some((server) => server.id === selectedServerId)) {
      return;
    }
    setSelectedServerId(visibleServers[0]?.id ?? null);
  }, [selectedServerId, visibleServers]);

  return (
    <section className="border-b border-border bg-background">
      <div className="flex flex-col gap-3 border-b border-border/70 px-4 py-4 sm:flex-row sm:items-start sm:justify-between sm:px-5">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="truncate text-base font-semibold">MCP Servers</h2>
            <StatusPill label="local host" tone="default" />
            <StatusPill
              label={loading && !snapshot ? "scanning" : "read-only"}
              tone={loading && !snapshot ? "warning" : "success"}
            />
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {formatCount(snapshot?.totals.serverCount ?? 0)} servers | {formatCount(enabledCount)}{" "}
            enabled | {formatCount(snapshot?.totals.toolCount ?? 0)} tools |{" "}
            {formatCount(overriddenCount)} overrides
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
          label="Servers"
          value={formatCount(snapshot?.totals.serverCount ?? 0)}
          icon={PlugIcon}
        />
        <StatBlock label="Enabled" value={formatCount(enabledCount)} icon={CheckCircle2Icon} />
        <StatBlock
          label="Tools"
          value={formatCount(snapshot?.totals.toolCount ?? 0)}
          icon={BotIcon}
        />
        <StatBlock
          label="Disabled"
          value={formatCount(snapshot?.totals.disabledCount ?? 0)}
          icon={CircleStopIcon}
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
                placeholder="Search MCP servers"
                className="pl-8"
                onChange={(event) => setSearch(event.currentTarget.value)}
              />
            </div>
            <select
              value={providerFilter}
              className="h-8 min-w-0 rounded-md border border-input bg-background px-3 text-xs"
              onChange={(event) =>
                setProviderFilter(event.currentTarget.value as GitsMcpServerProvider | "all")
              }
            >
              <option value="all">All providers</option>
              <option value="codex">Codex</option>
              <option value="claude">Claude</option>
              <option value="cursor">Cursor</option>
            </select>
          </div>

          <SectionHeader title="Servers" count={visibleServers.length} />
          {loading && visibleServers.length === 0 ? (
            <EmptyState label="Scanning local MCP config..." />
          ) : visibleServers.length === 0 ? (
            <EmptyState label="No MCP servers match the current filters." />
          ) : (
            <div className="divide-y divide-border/60">
              {visibleServers.slice(0, 160).map((server) => {
                const enabled = isMcpServerEnabled(server, overrides);
                return (
                  <button
                    key={server.id}
                    type="button"
                    className={cn(
                      "flex w-full min-w-0 cursor-pointer items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/35 sm:px-5",
                      selectedServer?.id === server.id && "bg-muted/55",
                    )}
                    onClick={() => setSelectedServerId(server.id)}
                  >
                    <PlugIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <span className="truncate text-xs font-medium">{server.name}</span>
                        <StatusPill label={formatMcpProvider(server.provider)} tone="default" />
                        <StatusPill
                          label={enabled ? "enabled" : "disabled"}
                          tone={enabled ? "success" : "default"}
                        />
                      </div>
                      <div className="mt-1 line-clamp-2 font-mono text-[11px] text-muted-foreground">
                        {server.command ?? server.transport ?? "no command"}
                      </div>
                    </div>
                  </button>
                );
              })}
              {visibleServers.length > 160 ? (
                <div className="px-4 py-2 text-[11px] text-muted-foreground sm:px-5">
                  +{formatCount(visibleServers.length - 160)} more servers
                </div>
              ) : null}
            </div>
          )}
        </div>

        <div className="min-w-0">
          <SectionHeader title="Details" count={selectedServer ? 1 : 0} />
          {selectedServer ? (
            <div className="grid gap-4 px-4 py-4 text-xs sm:px-5">
              <div className="min-w-0">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <h3 className="truncate text-sm font-semibold">{selectedServer.name}</h3>
                  <StatusPill label={formatMcpProvider(selectedServer.provider)} tone="default" />
                  <StatusPill
                    label={selectedServer.status}
                    tone={mcpStatusTone(
                      selectedServer,
                      isMcpServerEnabled(selectedServer, overrides),
                    )}
                  />
                  <StatusPill label={`auth: ${selectedServer.authStatus}`} tone="default" />
                </div>
                {selectedServer.command ? (
                  <div className="mt-2 truncate font-mono text-[11px] text-muted-foreground">
                    {selectedServer.command}
                  </div>
                ) : null}
              </div>

              <div className="grid gap-2">
                <div className="text-[11px] font-medium uppercase text-muted-foreground/80">
                  State
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant={isMcpServerEnabled(selectedServer, overrides) ? "default" : "outline"}
                    onClick={() =>
                      onToggleServer(
                        selectedServer.id,
                        !isMcpServerEnabled(selectedServer, overrides),
                      )
                    }
                  >
                    <PowerIcon className="size-3.5" />
                    {isMcpServerEnabled(selectedServer, overrides) ? "Disable" : "Enable"}
                  </Button>
                  {overrides[selectedServer.id] !== undefined &&
                  overrides[selectedServer.id] !== selectedServer.enabled ? (
                    <StatusPill label="local override" tone="warning" />
                  ) : null}
                </div>
              </div>

              <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1.5">
                <span className="text-muted-foreground">Transport</span>
                <span className="text-right font-mono">
                  {selectedServer.transport ?? "unknown"}
                </span>
                <span className="text-muted-foreground">Source</span>
                <span className="text-right font-mono">{selectedServer.source}</span>
                <span className="text-muted-foreground">Tools</span>
                <span className="text-right font-mono">
                  {formatCount(selectedServer.toolCount)}
                </span>
                <span className="text-muted-foreground">Resources</span>
                <span className="text-right font-mono">
                  {formatCount(selectedServer.resourceCount)}
                </span>
              </div>

              {selectedServer.tools.length > 0 ? (
                <div className="grid gap-2">
                  <SectionHeader title="Tools" count={selectedServer.tools.length} />
                  <div className="flex flex-wrap gap-1.5">
                    {selectedServer.tools.slice(0, 40).map((tool) => (
                      <StatusPill key={tool} label={tool} tone="default" />
                    ))}
                  </div>
                </div>
              ) : null}

              {selectedServer.configPath ? (
                <div className="grid gap-1">
                  <div className="text-[11px] font-medium uppercase text-muted-foreground/80">
                    Config
                  </div>
                  <div className="truncate font-mono text-[11px] text-muted-foreground">
                    {selectedServer.configPath}
                  </div>
                </div>
              ) : null}

              {selectedServer.error ? (
                <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-destructive">
                  {selectedServer.error}
                </div>
              ) : null}

              <div className="grid gap-2">
                <SectionHeader title="Provider summaries" count={snapshot?.providers.length ?? 0} />
                <div className="overflow-hidden rounded-md border border-border/70">
                  {(snapshot?.providers ?? []).map((provider) => (
                    <div
                      key={provider.provider}
                      className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-3 border-b border-border/60 px-3 py-2 last:border-b-0"
                    >
                      <span className="truncate font-medium">
                        {formatMcpProvider(provider.provider)}
                      </span>
                      <span className="font-mono text-muted-foreground">
                        {formatCount(provider.serverCount)}
                      </span>
                      <span className="font-mono text-muted-foreground">
                        {formatCount(provider.toolCount)} tools
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {(snapshot?.warnings ?? []).length > 0 ? (
                <div className="rounded-md border border-amber-500/25 bg-amber-500/5 p-3 text-amber-700 dark:text-amber-300">
                  {(snapshot?.warnings ?? []).slice(0, 3).join(" | ")}
                </div>
              ) : null}
            </div>
          ) : (
            <EmptyState label="Select an MCP server to inspect." />
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
  scheduler,
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
  autoEnqueueProposals,
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
  onAutoEnqueueProposalsChange,
  onGoalTitleChange,
  onGoalRepoChange,
  onGoalModelChange,
  onGoalPromptChange,
  onSavePolicy,
  onEnqueueGoal,
  onApproveGoal,
  onRejectGoal,
  onDispatchGoal,
  onSchedulerEnabledChange,
  onSchedulerArm,
  onSchedulerDisarm,
  onResumeDriver,
}: {
  snapshot: AutomodeSnapshot | undefined;
  scheduler: GitsSchedulerSnapshot | undefined;
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
  autoEnqueueProposals: boolean;
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
  onAutoEnqueueProposalsChange: (value: boolean) => void;
  onGoalTitleChange: (value: string) => void;
  onGoalRepoChange: (value: string) => void;
  onGoalModelChange: (value: string) => void;
  onGoalPromptChange: (value: string) => void;
  onSavePolicy: () => void;
  onEnqueueGoal: () => void;
  onApproveGoal: (goalId: string) => void;
  onRejectGoal: (goalId: string) => void;
  onDispatchGoal: (goalId: string) => void;
  onSchedulerEnabledChange: (value: boolean) => void;
  onSchedulerArm: () => void;
  onSchedulerDisarm: () => void;
  onResumeDriver: () => void;
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
        <div
          aria-live="polite"
          className="border-b border-border/60 px-4 py-2 text-xs text-destructive sm:px-5"
        >
          {errorMessage}
        </div>
      ) : null}

      {snapshot?.driverHalted ? (
        <div
          aria-live="polite"
          className="flex min-w-0 flex-wrap items-center justify-between gap-2 border-b border-border/60 bg-destructive/5 px-4 py-2 text-xs text-destructive sm:px-5"
        >
          <span className="min-w-0">
            Driver halted{snapshot.driverHaltedReason ? `: ${snapshot.driverHaltedReason}` : "."}
          </span>
          <Button size="sm" variant="outline" onClick={onResumeDriver} disabled={actionPending}>
            <PlayIcon className="size-3.5" />
            Resume driver
          </Button>
        </div>
      ) : null}
      {scheduler ? (
        <div className="grid gap-2 border-b border-border/60 px-4 py-3 text-xs sm:px-5">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="font-medium">Night scheduler</span>
            <StatusPill
              label={scheduler.config.enabled ? "enabled" : "disabled"}
              tone={scheduler.config.enabled ? "success" : "default"}
            />
            <StatusPill
              label={
                scheduler.arming.status === "armed"
                  ? `armed${scheduler.arming.nightKey ? ` ${scheduler.arming.nightKey}` : ""}`
                  : "disarmed"
              }
              tone={scheduler.arming.status === "armed" ? "success" : "warning"}
            />
            <span className="text-muted-foreground">
              {scheduler.currentSlot
                ? `slot ${scheduler.currentSlot.start}–${scheduler.currentSlot.end}${
                    scheduler.slotRemainingMs !== null
                      ? ` (${formatSlotRemaining(scheduler.slotRemainingMs)} left)`
                      : ""
                  }`
                : "no active slot"}{" "}
              | {formatCount(scheduler.goalsStartedTonight)} /{" "}
              {formatCount(scheduler.config.maxGoalsPerNight)} goals tonight
            </span>
          </div>
          {scheduler.lastGateDecision ? (
            <div className="text-muted-foreground">
              Last gate: {scheduler.lastGateDecision.allowed ? "allowed" : "denied"}
              {scheduler.lastGateDecision.reason
                ? ` — ${scheduler.lastGateDecision.reason}`
                : ""} (
              {formatIsoDate(scheduler.lastGateDecision.at)})
            </div>
          ) : null}
          {scheduler.arming.status === "disarmed" && scheduler.arming.disarmedReason ? (
            <div className="text-destructive">{scheduler.arming.disarmedReason}</div>
          ) : null}
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
            <label className="flex items-center gap-2 text-muted-foreground">
              <input
                type="checkbox"
                checked={scheduler.config.enabled}
                onChange={(event) => onSchedulerEnabledChange(event.currentTarget.checked)}
                disabled={actionPending}
              />
              Scheduler enabled
            </label>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={onSchedulerArm}
                disabled={
                  actionPending || !scheduler.config.enabled || scheduler.arming.status === "armed"
                }
              >
                Arm tonight
              </Button>
              <Button
                size="sm"
                variant="destructive-outline"
                onClick={onSchedulerDisarm}
                disabled={actionPending || scheduler.arming.status !== "armed"}
              >
                Disarm
              </Button>
            </div>
          </div>
          {scheduler.config.enabled ? (
            <p className="text-muted-foreground">
              Scheduler gates autonomous starts — disable for supervised daytime runs, or dispatch
              manually.
            </p>
          ) : null}
        </div>
      ) : null}
      {snapshot && (snapshot.heldPrUrl !== null || snapshot.runMerged) ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2 border-b border-border/60 px-4 py-2 text-xs sm:px-5">
          <span className="font-medium text-muted-foreground">Last run</span>
          {snapshot.runMerged ? <StatusPill label="run merged" tone="success" /> : null}
          {snapshot.heldPrUrl ? (
            <a
              href={snapshot.heldPrUrl}
              target="_blank"
              rel="noreferrer"
              className="text-primary underline-offset-2 hover:underline"
            >
              Held PR{snapshot.heldPrNumber !== null ? ` #${snapshot.heldPrNumber}` : ""}
            </a>
          ) : null}
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
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={autoEnqueueProposals}
                onChange={(event) => onAutoEnqueueProposalsChange(event.currentTarget.checked)}
              />
              Auto-enqueue approved Motoko proposals (autonomous mode only)
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
  // One chat per Motoko route: keyed by trimmed project root ("" = root/gits).
  const [motokoTranscripts, setMotokoTranscripts] = useState<MotokoTranscriptState>(() =>
    loadMotokoTranscripts(),
  );
  useEffect(() => {
    saveMotokoTranscripts(motokoTranscripts);
  }, [motokoTranscripts]);
  const motokoRoute = selectedProjectRoot.trim();
  const motokoTranscript = motokoTranscripts[motokoRoute] ?? EMPTY_MOTOKO_TRANSCRIPT;
  const appendMotokoTranscript = (routeKey: string, entry: MotokoTranscriptEntry) => {
    setMotokoTranscripts((current) => ({
      ...current,
      [routeKey]: [...(current[routeKey] ?? []), entry],
    }));
  };
  const [motokoInteractionMode, setMotokoInteractionMode] =
    useState<MotokoInteractionMode>("default");
  const [motokoScheduleKind, setMotokoScheduleKind] =
    useState<HermesScheduleKind>("daily-briefing");
  const [gsdInitInput, setGsdInitInput] = useState("");
  const [gsdAutoInitInput, setGsdAutoInitInput] = useState("");
  const [gsdModel, setGsdModel] = useState("");
  const [gsdMaxBudget, setGsdMaxBudget] = useState("");
  const [automodeMode, setAutomodeMode] = useState<AutomodeSnapshot["policy"]["mode"]>("manual");
  const [automodePolicyDirty, setAutomodePolicyDirty] = useState(false);
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
  const [automodeAutoEnqueueProposals, setAutomodeAutoEnqueueProposals] = useState(false);
  const [skillReviews, setSkillReviews] = useState<SkillReviewState>(() => loadSkillReviewState());
  const [mcpOverrides, setMcpOverrides] = useState<McpOverrideState>(() => loadMcpOverrideState());
  const [automodeGoalTitle, setAutomodeGoalTitle] = useState("");
  const [automodeGoalRepo, setAutomodeGoalRepo] = useState("");
  const [automodeGoalModel, setAutomodeGoalModel] = useState("");
  const [automodeGoalPrompt, setAutomodeGoalPrompt] = useState("");
  const [devSessionStateByCommandId, setDevSessionStateByCommandId] = useState<
    Record<string, DevCommandSessionState | undefined>
  >({});
  const [devActionError, setDevActionError] = useState<string | null>(null);
  const [devActiveCommandId, setDevActiveCommandId] = useState<string | null>(null);
  const [devActionPending, setDevActionPending] = useState(false);
  const [openGsdCommandResult, setOpenGsdCommandResult] = useState<
    OpenGsdCommandResult | undefined
  >(undefined);
  const [hermesCommandResult, setHermesCommandResult] = useState<HermesCommandResult | undefined>(
    undefined,
  );
  const devTerminalDetachByCommandIdRef = useRef(new Map<string, () => void>());
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
  const schedulerQuery = useQuery({
    queryKey: [
      "gits",
      "automode",
      "scheduler",
      targetEnvironmentId,
      activeRemoteRuntime?.connectionState,
      activeRemoteRuntime?.authState,
    ],
    queryFn: async () => readGitsClient().automode.schedulerSnapshot(),
    refetchInterval: 10_000,
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
  const devCommandsQuery = useQuery({
    queryKey: [
      "gits",
      "dev-commands",
      targetEnvironmentId,
      selectedProjectRoot,
      activeRemoteRuntime?.connectionState,
      activeRemoteRuntime?.authState,
    ],
    queryFn: async () => readGitsClient().devCommands.list({ projectDir: selectedProjectRoot }),
    enabled: selectedProjectRoot.trim().length > 0,
    refetchInterval: 30_000,
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
  const mcpQuery = useQuery({
    queryKey: ["gits", "mcp"],
    queryFn: async (): Promise<GitsMcpInventorySnapshot> => {
      const response = await fetch("/api/gits/mcp", {
        headers: { accept: "application/json" },
      });
      if (!response.ok) {
        throw new Error(`MCP inventory request failed with ${response.status}.`);
      }
      return (await response.json()) as GitsMcpInventorySnapshot;
    },
    refetchInterval: 60_000,
    retry: false,
  });
  const usageQuery = useQuery({
    queryKey: ["gits", "usage"],
    queryFn: async (): Promise<UsageSummary> => {
      const response = await fetch("/api/gits/usage", {
        headers: { accept: "application/json" },
      });
      if (!response.ok) {
        throw new Error(`Usage request failed with ${response.status}.`);
      }
      return (await response.json()) as UsageSummary;
    },
    enabled: activeTab === "usage",
    refetchOnMount: "always",
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
  const inboxQuery = useQuery({
    queryKey: ["gits", "delamain", "peer-inbox", targetEnvironmentId, selectedPeerId],
    queryFn: async () =>
      readGitsClient().delamain.messages.inbox({ peerId: selectedPeerId!, includeDelivered: true }),
    enabled: selectedPeerId !== null,
    refetchInterval: selectedPeerId ? 5_000 : false,
  });
  const hermesCheckMutation = useMutation({
    mutationFn: async () => readGitsClient().hermes.check(),
    onSuccess: async (result) => {
      setHermesCommandResult(result);
      await hermesQuery.refetch();
    },
  });
  const hermesSetupMutation = useMutation({
    mutationFn: async () => readGitsClient().hermes.setupCodexOAuth(),
    onSuccess: async (result) => {
      setHermesCommandResult(result);
      await Promise.all([hermesQuery.refetch(), hermesLogQuery.refetch()]);
    },
  });
  const hermesAcpMutation = useMutation({
    mutationFn: async () =>
      readGitsClient().hermes.startAcpSession(
        selectedProjectRoot.trim().length > 0 ? { cwd: selectedProjectRoot.trim() } : {},
      ),
    onSuccess: async (result) => {
      setHermesCommandResult(result);
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
    // routeKey travels with the request so replies land in the chat they were sent from,
    // even if the operator switches repos mid-flight.
    mutationFn: async (input: { message: string; routeKey: string }) => {
      const effectiveMessage =
        motokoInteractionMode === "plan"
          ? [
              "Motoko interaction mode: plan.",
              "Respond with analysis, options, and a proposed approval path. Do not recommend direct execution.",
              "",
              input.message,
            ].join("\n")
          : input.message;

      return readGitsClient().hermes.chat({
        message: effectiveMessage,
        ...(input.routeKey.length > 0 ? { projectDir: input.routeKey } : {}),
      });
    },
    onMutate: async (input) => {
      appendMotokoTranscript(input.routeKey, {
        id: makeTranscriptEntryId("operator", new Date().toISOString()),
        role: "operator",
        message: input.message,
        createdAt: new Date().toISOString(),
      });
    },
    onSuccess: async (result, input) => {
      appendMotokoTranscript(input.routeKey, {
        id: makeTranscriptEntryId("motoko", result.createdAt),
        role: "motoko",
        message: result.response,
        createdAt: result.createdAt,
        result,
      });
      setMotokoChatInput("");
      await Promise.all([
        hermesLogQuery.refetch(),
        hermesQuery.refetch(),
        ...(result.proposal ? [hermesProposalsQuery.refetch()] : []),
      ]);
    },
    onError: (error, input) => {
      appendMotokoTranscript(input.routeKey, {
        id: makeTranscriptEntryId("motoko", new Date().toISOString()),
        role: "motoko",
        message: error instanceof Error ? error.message : "Motoko chat failed.",
        createdAt: new Date().toISOString(),
      });
    },
  });
  const hermesDecisionMutation = useMutation({
    mutationFn: async (input: {
      proposalId: string;
      decision: MotokoProposalDecision;
      routeKey: string;
      title: string;
    }) => {
      const client = readGitsClient();
      const decided = await client.hermes.decideProposal({
        proposalId: input.proposalId,
        decision: input.decision,
      });
      if (input.decision !== "approve" || decided.status !== "approved") {
        return { decided, draft: null, peer: null };
      }
      // Approval means "go": draft the handoff and, for delamain work, dispatch the peer now.
      const draft = await client.hermes.draftFromProposal({ proposalId: input.proposalId });
      if (draft.status !== "draft" || draft.kind !== "delamain-peer" || draft.repo === null) {
        return { decided, draft, peer: null };
      }
      const peer = await client.delamain.spawnPeer({ repo: draft.repo, prompt: draft.prompt });
      return { decided, draft, peer };
    },
    onSuccess: async (result, input) => {
      appendMotokoTranscript(input.routeKey, {
        id: makeTranscriptEntryId("motoko", new Date().toISOString()),
        role: "motoko",
        message: motokoDecisionSummary(input.decision, input.title, result),
        createdAt: new Date().toISOString(),
      });
      await Promise.all([
        hermesProposalsQuery.refetch(),
        hermesQuery.refetch(),
        ...(result.peer ? [delamainQuery.refetch()] : []),
      ]);
    },
    onError: (error, input) => {
      appendMotokoTranscript(input.routeKey, {
        id: makeTranscriptEntryId("motoko", new Date().toISOString()),
        role: "motoko",
        message: `Decision on "${input.title}" failed: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
        createdAt: new Date().toISOString(),
      });
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
    onSuccess: async (result) => {
      setOpenGsdCommandResult(result);
      await query.refetch();
    },
  });
  const gsdAutoMutation = useMutation({
    mutationFn: async () =>
      readGitsClient().openGsd.runAuto({
        ...gsdCommonInput(),
        ...(gsdAutoInitInput.trim().length > 0 ? { initInput: gsdAutoInitInput.trim() } : {}),
      }),
    onSuccess: async (result) => {
      setOpenGsdCommandResult(result);
      await query.refetch();
    },
  });
  const automodeKillSwitchEnabled = automodeQuery.data?.policy.killSwitchEnabled ?? true;
  const automodePolicyInput = () => {
    const maxPeers = Math.max(0, Math.floor(Number(automodeMaxPeers)));
    const maxBudget = Number(automodeMaxBudget);
    const maxRuntime = Math.max(0, Math.floor(Number(automodeMaxRuntime)));
    return {
      mode: automodeMode,
      killSwitchEnabled: automodeKillSwitchEnabled,
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
      autoEnqueueApprovedProposals: automodeAutoEnqueueProposals,
    };
  };
  const automodePolicyMutation = useMutation({
    mutationFn: async () => readGitsClient().automode.updatePolicy(automodePolicyInput()),
    onSuccess: async () => {
      setAutomodePolicyDirty(false);
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
  const schedulerSetConfigMutation = useMutation({
    mutationFn: async (input: { enabled: boolean }) =>
      readGitsClient().automode.schedulerSetConfig(input),
    onSuccess: async () => {
      await schedulerQuery.refetch();
    },
  });
  const schedulerArmMutation = useMutation({
    mutationFn: async () => readGitsClient().automode.schedulerArm(),
    onSuccess: async () => {
      await schedulerQuery.refetch();
    },
  });
  const schedulerDisarmMutation = useMutation({
    mutationFn: async () =>
      readGitsClient().automode.schedulerDisarm({ reason: "Disarmed in cockpit." }),
    onSuccess: async () => {
      await schedulerQuery.refetch();
    },
  });
  const driverResumeMutation = useMutation({
    mutationFn: async () => readGitsClient().automode.resumeDriver(),
    onSuccess: async () => {
      await automodeQuery.refetch();
    },
  });
  const handleDevStart = async (command: GitsDevCommand) => {
    if (!targetEnvironmentId) {
      setDevActionError("No target environment is available.");
      return;
    }
    const api = readEnvironmentApi(targetEnvironmentId);
    if (!api) {
      setDevActionError("Environment API is not available.");
      return;
    }
    const threadId = makeDevThreadId(selectedProjectRoot);
    const terminalId = makeDevTerminalId(command.id);
    setDevActionPending(true);
    setDevActiveCommandId(command.id);
    setDevActionError(null);
    devTerminalDetachByCommandIdRef.current.get(command.id)?.();
    devTerminalDetachByCommandIdRef.current.delete(command.id);
    setDevSessionStateByCommandId((current) => ({
      ...current,
      [command.id]: {
        threadId,
        terminalId,
        status: "starting",
        log: "",
        exitCode: null,
        label: null,
        updatedAt: new Date().toISOString(),
        pid: null,
      },
    }));
    try {
      await api.terminal
        .close({ threadId, terminalId, deleteHistory: true })
        .catch(() => undefined);
      await api.terminal.open({ threadId, terminalId, cwd: command.cwd });
      const detach = api.terminal.attach(
        { threadId, terminalId, cwd: command.cwd, restartIfNotRunning: false },
        (event) => {
          setDevSessionStateByCommandId((current) => {
            const previous =
              current[command.id] ??
              ({
                threadId,
                terminalId,
                status: "idle",
                log: "",
                exitCode: null,
                label: null,
                updatedAt: null,
                pid: null,
              } satisfies DevCommandSessionState);
            return {
              ...current,
              [command.id]: reduceDevCommandEvent(previous, event),
            };
          });
        },
      );
      devTerminalDetachByCommandIdRef.current.set(command.id, detach);
      await api.terminal.write({ threadId, terminalId, data: `${command.launchCommand}\n` });
    } catch (error) {
      setDevActionError(error instanceof Error ? error.message : "Failed to start dev command.");
      setDevSessionStateByCommandId((current) => ({
        ...current,
        [command.id]: {
          threadId,
          terminalId,
          status: "error",
          log:
            error instanceof Error
              ? `[error] ${error.message}\n`
              : "[error] Failed to start dev command.\n",
          exitCode: null,
          label: null,
          updatedAt: new Date().toISOString(),
          pid: null,
        },
      }));
    } finally {
      setDevActionPending(false);
      setDevActiveCommandId(null);
    }
  };
  const handleDevStop = async (command: GitsDevCommand) => {
    if (!targetEnvironmentId) {
      setDevActionError("No target environment is available.");
      return;
    }
    const api = readEnvironmentApi(targetEnvironmentId);
    if (!api) {
      setDevActionError("Environment API is not available.");
      return;
    }
    const threadId =
      devSessionStateByCommandId[command.id]?.threadId ?? makeDevThreadId(selectedProjectRoot);
    const terminalId = makeDevTerminalId(command.id);
    setDevActionPending(true);
    setDevActiveCommandId(command.id);
    setDevActionError(null);
    try {
      await api.terminal
        .write({ threadId, terminalId, data: "\u0003exit\n" })
        .catch(() => undefined);
      await api.terminal
        .close({ threadId, terminalId, deleteHistory: false })
        .catch(() => undefined);
      devTerminalDetachByCommandIdRef.current.get(command.id)?.();
      devTerminalDetachByCommandIdRef.current.delete(command.id);
      setDevSessionStateByCommandId((current) => ({
        ...current,
        [command.id]: {
          ...(current[command.id] ?? {
            threadId,
            terminalId,
            log: "",
            exitCode: null,
            label: null,
            updatedAt: null,
            pid: null,
          }),
          status: "closed",
          updatedAt: new Date().toISOString(),
          pid: null,
        },
      }));
    } catch (error) {
      setDevActionError(error instanceof Error ? error.message : "Failed to stop dev command.");
    } finally {
      setDevActionPending(false);
      setDevActiveCommandId(null);
    }
  };
  const handleDevCopyLaunchCommand = async (command: GitsDevCommand) => {
    try {
      await navigator.clipboard.writeText(command.launchCommand);
      setDevActionError(null);
    } catch (error) {
      setDevActionError(error instanceof Error ? error.message : "Failed to copy launch command.");
    }
  };
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
  const automodeActionError =
    automodePolicyMutation.error ??
    automodeKillSwitchMutation.error ??
    automodeEnqueueMutation.error ??
    automodeApproveMutation.error ??
    automodeRejectMutation.error ??
    automodeDispatchMutation.error ??
    schedulerSetConfigMutation.error ??
    schedulerArmMutation.error ??
    schedulerDisarmMutation.error ??
    driverResumeMutation.error;
  const automodeActionPending =
    automodePolicyMutation.isPending ||
    automodeKillSwitchMutation.isPending ||
    automodeEnqueueMutation.isPending ||
    automodeApproveMutation.isPending ||
    automodeRejectMutation.isPending ||
    automodeDispatchMutation.isPending ||
    schedulerSetConfigMutation.isPending ||
    schedulerArmMutation.isPending ||
    schedulerDisarmMutation.isPending ||
    driverResumeMutation.isPending;
  const setAutomodePolicyField =
    <T,>(setter: (value: T) => void) =>
    (value: T) => {
      setAutomodePolicyDirty(true);
      setter(value);
    };
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

  const toggleMcpServer = (serverId: string, enabled: boolean) => {
    setMcpOverrides((current) => {
      const next = { ...current, [serverId]: enabled };
      saveMcpOverrideState(next);
      return next;
    });
  };

  useEffect(() => {
    const peers = delamainQuery.data?.peers;
    if (peers === undefined) {
      return;
    }
    if (selectedPeerId !== null && peerIds.has(selectedPeerId)) {
      return;
    }
    setSelectedPeerId(peers[0]?.id ?? null);
  }, [delamainQuery.data?.peers, peerIds, selectedPeerId]);

  useEffect(() => {
    const projects = query.data?.projects;
    if (projects === undefined) {
      return;
    }
    const projectRoots = projects.map((project) => project.project.rootPath);
    if (
      selectedProjectRoot === MOTOKO_ROOT_ROUTE_VALUE ||
      projectRoots.includes(selectedProjectRoot)
    ) {
      return;
    }
    setSelectedProjectRoot(MOTOKO_ROOT_ROUTE_VALUE);
  }, [query.data?.projects, selectedProjectRoot]);

  useEffect(() => {
    const policy = automodeQuery.data?.policy;
    if (!policy || automodePolicyDirty) {
      return;
    }
    setAutomodeMode(policy.mode);
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
    setAutomodeAutoEnqueueProposals(policy.autoEnqueueApprovedProposals);
  }, [automodePolicyDirty, automodeQuery.data?.policy]);

  useEffect(() => {
    if (automodeGoalRepo.trim().length > 0) {
      return;
    }
    setAutomodeGoalRepo(selectedProjectRoot);
  }, [automodeGoalRepo, selectedProjectRoot]);

  useEffect(() => {
    const detachByCommandId = devTerminalDetachByCommandIdRef.current;
    return () => {
      for (const detach of detachByCommandId.values()) {
        detach();
      }
      detachByCommandId.clear();
      setDevSessionStateByCommandId({});
    };
  }, [selectedProjectRoot]);

  const tabCounts = useMemo<Record<GitsCockpitTab, string>>(
    () => ({
      overview: "live",
      motoko: formatCount(hermesProposalsQuery.data?.proposals.length ?? 0),
      dev: formatCount(devCommandsQuery.data?.commands.length ?? 0),
      fleet: formatCount(delamainQuery.data?.peers.length ?? 0),
      automode: formatCount(automodeQuery.data?.goals.length ?? 0),
      usage: usageQuery.data ? formatUsd(usageQuery.data.estimatedCostUsd) : "open",
      gsd: openGsdQuery.data?.available ? "ready" : "check",
      skills: formatCount(skillsQuery.data?.totals.skillCount ?? 0),
      mcp: formatCount(mcpQuery.data?.totals.serverCount ?? 0),
      projects: formatCount(query.data?.totals.projectCount ?? 0),
    }),
    [
      automodeQuery.data?.goals.length,
      devCommandsQuery.data?.commands.length,
      delamainQuery.data?.peers.length,
      hermesProposalsQuery.data?.proposals.length,
      mcpQuery.data?.totals.serverCount,
      openGsdQuery.data?.available,
      query.data?.totals.projectCount,
      skillsQuery.data?.totals.skillCount,
      usageQuery.data,
    ],
  );
  // ponytail: 5s/10s pollers excluded so the header spinner only reflects slower, user-meaningful refreshes
  const isRefreshing =
    capacityQuery.isFetching ||
    hermesQuery.isFetching ||
    hermesSessionsQuery.isFetching ||
    hermesLogQuery.isFetching ||
    devCommandsQuery.isFetching ||
    openGsdQuery.isFetching ||
    buildInfoQuery.isFetching ||
    skillsQuery.isFetching ||
    mcpQuery.isFetching ||
    usageQuery.isFetching;

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
              ...(selectedProjectRoot ? [devCommandsQuery.refetch()] : []),
              openGsdQuery.refetch(),
              resourceQuery.refetch(),
              buildInfoQuery.refetch(),
              skillsQuery.refetch(),
              mcpQuery.refetch(),
              usageQuery.refetch(),
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
            <div
              role="tabpanel"
              id={`gits-cockpit-panel-${activeTab}`}
              aria-labelledby={`gits-cockpit-tab-${activeTab}`}
            >
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
                  inbox={inboxQuery.data}
                  actionError={actionError ?? logQuery.error}
                  spawnRepo={spawnRepo}
                  spawnName={spawnName}
                  spawnPrompt={spawnPrompt}
                  replyText={replyText}
                  actionPending={actionPending}
                  killSwitchEnabled={automodeQuery.data?.policy.killSwitchEnabled ?? false}
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
                  scheduler={schedulerQuery.data}
                  loading={automodeQuery.isPending || automodeQuery.isFetching}
                  error={automodeQuery.error}
                  actionError={automodeActionError}
                  actionPending={automodeActionPending}
                  policyMode={automodeMode}
                  killSwitchEnabled={automodeKillSwitchEnabled}
                  maxActivePeers={automodeMaxPeers}
                  allowedRepos={automodeAllowedRepos}
                  allowedModels={automodeAllowedModels}
                  defaultModel={automodeDefaultModel}
                  maxBudget={automodeMaxBudget}
                  maxRuntime={automodeMaxRuntime}
                  requireSpawnApproval={automodeRequireSpawnApproval}
                  requireIntegrateApproval={automodeRequireIntegrateApproval}
                  requireDestructiveApproval={automodeRequireDestructiveApproval}
                  autoEnqueueProposals={automodeAutoEnqueueProposals}
                  goalTitle={automodeGoalTitle}
                  goalRepo={automodeGoalRepo}
                  goalModel={automodeGoalModel}
                  goalPrompt={automodeGoalPrompt}
                  onRefresh={() => void automodeQuery.refetch()}
                  onPolicyModeChange={setAutomodePolicyField(setAutomodeMode)}
                  onKillSwitchChange={(next) => void automodeKillSwitchMutation.mutate(next)}
                  onMaxActivePeersChange={setAutomodePolicyField(setAutomodeMaxPeers)}
                  onAllowedReposChange={setAutomodePolicyField(setAutomodeAllowedRepos)}
                  onAllowedModelsChange={setAutomodePolicyField(setAutomodeAllowedModels)}
                  onDefaultModelChange={setAutomodePolicyField(setAutomodeDefaultModel)}
                  onMaxBudgetChange={setAutomodePolicyField(setAutomodeMaxBudget)}
                  onMaxRuntimeChange={setAutomodePolicyField(setAutomodeMaxRuntime)}
                  onRequireSpawnApprovalChange={setAutomodePolicyField(
                    setAutomodeRequireSpawnApproval,
                  )}
                  onRequireIntegrateApprovalChange={setAutomodePolicyField(
                    setAutomodeRequireIntegrateApproval,
                  )}
                  onRequireDestructiveApprovalChange={setAutomodePolicyField(
                    setAutomodeRequireDestructiveApproval,
                  )}
                  onAutoEnqueueProposalsChange={setAutomodePolicyField(
                    setAutomodeAutoEnqueueProposals,
                  )}
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
                  onSchedulerEnabledChange={(enabled) =>
                    void schedulerSetConfigMutation.mutate({ enabled })
                  }
                  onSchedulerArm={() => void schedulerArmMutation.mutate()}
                  onSchedulerDisarm={() => void schedulerDisarmMutation.mutate()}
                  onResumeDriver={() => void driverResumeMutation.mutate()}
                />
              ) : null}
              {activeTab === "usage" ? (
                <UsagePanel
                  usage={usageQuery.data}
                  loading={usageQuery.isPending || usageQuery.isFetching}
                  error={usageQuery.error}
                  onRefresh={() => void usageQuery.refetch()}
                />
              ) : null}
              {activeTab === "motoko" ? (
                <MotokoPanel
                  status={hermesQuery.data}
                  capacity={capacityQuery.data}
                  sessions={hermesSessionsQuery.data}
                  projects={query.data?.projects ?? []}
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
                  chatResult={hermesChatMutation.data}
                  commandResult={hermesCommandResult}
                  draft={hermesDraftMutation.data}
                  scheduleResult={hermesScheduleMutation.data}
                  transcript={motokoTranscript}
                  selectedProjectRoot={selectedProjectRoot}
                  chatInput={motokoChatInput}
                  interactionMode={motokoInteractionMode}
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
                  onToggleInteractionMode={() =>
                    setMotokoInteractionMode((mode) => (mode === "plan" ? "default" : "plan"))
                  }
                  onProjectRootChange={setSelectedProjectRoot}
                  onChatInputChange={setMotokoChatInput}
                  onScheduleKindChange={setMotokoScheduleKind}
                  onCheck={() => void hermesCheckMutation.mutate()}
                  onSetupCodexOAuth={() => void hermesSetupMutation.mutate()}
                  onStartAcp={() => void hermesAcpMutation.mutate()}
                  onInspectGits={() => void hermesInspectMutation.mutate()}
                  onChatSubmit={() => {
                    const message = motokoChatInput.trim();
                    if (message.length === 0) {
                      return;
                    }
                    void hermesChatMutation.mutate({ message, routeKey: motokoRoute });
                  }}
                  onClearChat={() =>
                    setMotokoTranscripts((current) => ({ ...current, [motokoRoute]: [] }))
                  }
                  onNewChat={() => {
                    setMotokoTranscripts((current) => ({ ...current, [motokoRoute]: [] }));
                    setMotokoChatInput("");
                    hermesChatMutation.reset();
                  }}
                  onDecision={(proposal, decision) =>
                    void hermesDecisionMutation.mutate({
                      proposalId: proposal.id,
                      decision,
                      routeKey: motokoRoute,
                      title: proposal.title,
                    })
                  }
                  onWriteContext={() => void hermesContextMutation.mutate()}
                  onDraft={(proposalId) => void hermesDraftMutation.mutate(proposalId)}
                  onRunSchedule={() => void hermesScheduleMutation.mutate()}
                />
              ) : null}
              {activeTab === "dev" ? (
                <DevCommandPanel
                  list={devCommandsQuery.data}
                  loading={devCommandsQuery.isFetching}
                  error={devCommandsQuery.error}
                  selectedProjectRoot={selectedProjectRoot}
                  onRefresh={() => void devCommandsQuery.refetch()}
                  sessionStateByCommandId={devSessionStateByCommandId}
                  activeCommandId={devActiveCommandId}
                  actionError={devActionError}
                  actionPending={devActionPending}
                  onStart={(command) => void handleDevStart(command)}
                  onStop={(command) => void handleDevStop(command)}
                  onCopyLaunchCommand={(command) => void handleDevCopyLaunchCommand(command)}
                  onOpenPreview={handleDevOpenPreview}
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
              {activeTab === "mcp" ? (
                <McpServersPanel
                  snapshot={mcpQuery.data}
                  loading={mcpQuery.isPending || mcpQuery.isFetching}
                  error={mcpQuery.error}
                  overrides={mcpOverrides}
                  onRefresh={() => void mcpQuery.refetch()}
                  onToggleServer={toggleMcpServer}
                />
              ) : null}
              {activeTab === "projects" ? <CockpitContent snapshot={query.data} /> : null}
            </div>
          </>
        ) : null}
      </ScrollArea>
    </SidebarInset>
  );
}
