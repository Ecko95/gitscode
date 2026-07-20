import type { AutomodeGoal, AutomodeSnapshot, GitsSchedulerSnapshot } from "@t3tools/contracts";
import { ListChecksIcon, PlayIcon, PowerIcon, RefreshCwIcon, ShieldCheckIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";

import {
  EmptyState,
  SectionHeader,
  StatusPill,
  formatCount,
  formatIsoDate,
  formatSlotRemaining,
  formatUsd,
  parseLines,
  statusTone,
} from "./primitives";

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

export function AutomodePanel({
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
  nightlyProposalSweep,
  proposalRepos,
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
  onNightlyProposalSweepChange,
  onProposalReposChange,
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
  nightlyProposalSweep: boolean;
  proposalRepos: string;
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
  onNightlyProposalSweepChange: (value: boolean) => void;
  onProposalReposChange: (value: string) => void;
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
  const proposalRepoList = parseLines(proposalRepos);
  const allowedRepoList = parseLines(allowedRepos);
  const proposalReposNotAllowed = proposalRepoList.filter(
    (repo) =>
      !allowedRepoList.some((a) => repo === a || repo.startsWith(a.endsWith("/") ? a : a + "/")),
  );

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

          <div className="grid gap-2 border-t border-border/60 pt-3 text-xs">
            <label className="flex items-center gap-2 text-muted-foreground">
              <input
                type="checkbox"
                checked={nightlyProposalSweep}
                onChange={(event) => onNightlyProposalSweepChange(event.currentTarget.checked)}
              />
              Nightly proposal sweep
            </label>
            <p className="text-muted-foreground">
              Proposes from 20:00 London ·{" "}
              {nightlyProposalSweep
                ? `${formatCount(proposalRepoList.length)} repos opted in`
                : "sweep disabled"}
            </p>
            <Textarea
              value={proposalRepos}
              placeholder="Proposal repos (one path per line)"
              className="min-h-24 text-xs"
              onChange={(event) => onProposalReposChange(event.currentTarget.value)}
            />
            {proposalReposNotAllowed.length > 0 ? (
              <ul className="grid gap-1 text-destructive">
                {proposalReposNotAllowed.map((repo) => (
                  <li key={repo} className="truncate font-mono text-[11px]">
                    {repo} — won&apos;t run — repo not in allowedRepos
                  </li>
                ))}
              </ul>
            ) : null}
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
