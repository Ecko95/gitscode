import type {
  AutomodeSnapshot,
  DelamainPeerListResult,
  GitsCapacitySnapshot,
  GitsCockpitSnapshot,
  GsdPhase,
  HermesProposalListResult,
  HermesStatusResult,
  OpenGsdStatusResult,
  ServerProcessResourceHistoryResult,
  VerificationGate,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import {
  AlertTriangleIcon,
  BotIcon,
  CheckCircle2Icon,
  CircleIcon,
  GitBranchIcon,
  PowerIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
} from "lucide-react";

import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";

import {
  EmptyState,
  GATE_STATUS_LABELS,
  PHASE_STATUS_LABELS,
  SectionHeader,
  SignalRow,
  StatBlock,
  StatusPill,
  formatBytes,
  formatCount,
  formatCpuTime,
  formatIsoDate,
  formatPercent,
  formatUsd,
  isRecord,
  statusTone,
  tallyValues,
} from "./primitives";

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

export function CockpitOverviewPanel({
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
