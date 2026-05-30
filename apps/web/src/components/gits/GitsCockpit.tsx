import type {
  AgentSession,
  AutomodeGoal,
  AutomodeSnapshot,
  DelamainPeer,
  DelamainPeerListResult,
  GitsCockpitProject,
  GitsCockpitSnapshot,
  GsdPhase,
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
  BotIcon,
  CheckCircle2Icon,
  CircleStopIcon,
  CircleIcon,
  FilePlus2Icon,
  GitBranchIcon,
  ListChecksIcon,
  PlayIcon,
  PowerIcon,
  RefreshCwIcon,
  SendIcon,
  ShieldCheckIcon,
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

function formatCount(value: number): string {
  return NUMBER_FORMAT.format(value);
}

function formatUsd(value: number): string {
  return USD_FORMAT.format(value);
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
  const [selectedPeerId, setSelectedPeerId] = useState<string | null>(null);
  const [spawnRepo, setSpawnRepo] = useState("");
  const [spawnName, setSpawnName] = useState("");
  const [spawnPrompt, setSpawnPrompt] = useState("");
  const [replyText, setReplyText] = useState("");
  const [selectedProjectRoot, setSelectedProjectRoot] = useState("");
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
          onClick={() => void query.refetch()}
          disabled={query.isFetching}
        >
          <RefreshCwIcon className={cn("size-3.5", query.isFetching && "animate-spin")} />
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
            <ResourceVisibilityPanel
              snapshot={query.data}
              automode={automodeQuery.data}
              history={resourceQuery.data}
              loading={resourceQuery.isPending || resourceQuery.isFetching}
              error={resourceQuery.error}
              onRefresh={() => void resourceQuery.refetch()}
            />
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
                if (window.confirm(`Open an integration PR for Delamain peer ${selectedPeerId}?`)) {
                  void integrateMutation.mutate();
                }
              }}
            />
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
            <CockpitContent snapshot={query.data} />
          </>
        ) : null}
      </ScrollArea>
    </SidebarInset>
  );
}
