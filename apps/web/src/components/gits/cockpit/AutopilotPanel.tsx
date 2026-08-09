import type {
  AutomodeEpisode,
  AutomodeGoal,
  AutomodeGoalStatus,
  AutomodeMode,
  AutomodePolicyUpdateInput,
  AutomodeSnapshot,
  CodexModelTier,
  GitsCockpitProject,
  GitsSchedulerSnapshot,
  HermesProposalCard,
  HermesProposalListResult,
  MotokoAuthority,
} from "@t3tools/contracts";
import { CODEX_MODEL_TIER_LABELS, CODEX_MODEL_TIERS } from "@t3tools/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  ListChecksIcon,
  OctagonAlertIcon,
  PlayIcon,
  PowerIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  SkullIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

import { usePrimaryEnvironmentId } from "~/environments/primary";
import type { GitsEnvironmentClient } from "~/gitsClient";
import { readGitsEnvironmentClient } from "~/gitsClient";
import { cn } from "~/lib/utils";
import { useStore } from "~/store";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
} from "~/components/ui/combobox";
import { Input } from "~/components/ui/input";
import {
  MotokoProposalReview,
  type MotokoProposalDecision,
  type MotokoProposalEdits,
} from "./MotokoPanel";
import {
  Select,
  SelectGroup,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { Textarea } from "~/components/ui/textarea";
import { toastManager } from "~/components/ui/toast";
import { InboxSection } from "./InboxSection";

import {
  type AutopilotPolicyForm,
  formStateToPolicyUpdate,
  formatGateDecision,
  modelTierOf,
  nextPolicyFormState,
  policyToFormState,
  reposNotAllowed,
  verdictTone,
} from "./autopilot/autopilot.logic";
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

const MODEL_TIERS = Object.keys(CODEX_MODEL_TIERS) as ReadonlyArray<CodexModelTier>;
const AUTOMODE_MODES: ReadonlyArray<AutomodeMode> = ["manual", "supervised", "autonomous"];
const GOAL_STATUS_FILTERS: ReadonlyArray<"all" | AutomodeGoalStatus> = [
  "all",
  "waiting-approval",
  "queued",
  "running",
  "blocked",
  "completed",
  "failed",
  "rejected",
];
const MOTOKO_AUTHORITY_OPTIONS: ReadonlyArray<{
  value: MotokoAuthority;
  label: string;
  description: string;
}> = [
  {
    value: "observe",
    label: "Observe",
    description: "Read-only — Motoko cannot send peer messages.",
  },
  {
    value: "respond",
    label: "Respond",
    description: "Motoko may reply to open messages, but not start new ones.",
  },
  {
    value: "dispatch",
    label: "Dispatch",
    description:
      "Motoko may send new peer messages. Integrate, merge, and destructive actions stay human-gated.",
  },
];
const SWITCHBOARD_FIELDS: ReadonlyArray<{
  field: keyof Pick<
    AutomodePolicyUpdateInput,
    | "nightlyProposalSweep"
    | "sweepRequiresConfirmation"
    | "autoEnqueueApprovedProposals"
    | "telegramDigestEnabled"
    | "gitsNotificationsEnabled"
    | "telegramNotificationsEnabled"
  >;
  label: string;
  description: string;
}> = [
  {
    field: "nightlyProposalSweep",
    label: "Nightly proposal sweep",
    description: "Motoko proposes changes nightly from 20:00 London for opted-in repos.",
  },
  {
    field: "sweepRequiresConfirmation",
    label: "Sweep requires confirmation",
    description: "Sweep goals wait for your APPROVE before running.",
  },
  {
    field: "autoEnqueueApprovedProposals",
    label: "Auto-enqueue approved proposals",
    description:
      "Approved Motoko proposals join the goal queue automatically (autonomous mode only).",
  },
  {
    field: "gitsNotificationsEnabled",
    label: "GITS/PWA notifications",
    description: "Notify this device about proposals and Automode attention states.",
  },
  {
    field: "telegramNotificationsEnabled",
    label: "Telegram notifications",
    description: "Send proposal and Automode attention notifications through Telegram.",
  },
  {
    field: "telegramDigestEnabled",
    label: "Telegram digest",
    description: "Send the daily Telegram digest/report.",
  },
];

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

function formatFilterLabel(value: "all" | AutomodeGoalStatus): string {
  return value === "all" ? "All" : value.replace(/-/g, " ");
}

function tierLabelShort(tier: CodexModelTier): string {
  return CODEX_MODEL_TIER_LABELS[tier].split(" —")[0] ?? tier;
}

function repoBasename(repo: string): string {
  const trimmed = repo.replace(/\/+$/, "");
  const parts = trimmed.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? repo;
}

/** Panel-local client access: `GitsCockpit.tsx` (owned by another agent) doesn't thread
 *  `readGitsClient` down to this panel, so this mirrors the same construction
 *  `useGitsCockpitQueries.ts` uses (primary vs. active-environment resolution) rather than
 *  waiting on a shell change. See `~/gitsClient.ts` for the shared environmentId->client lookup. */
function useAutopilotGitsClient(): {
  readGitsClient: () => GitsEnvironmentClient;
  targetEnvironmentId: string | null;
} {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const activeEnvironmentId = useStore((state) => state.activeEnvironmentId);
  const targetEnvironmentId = activeEnvironmentId ?? primaryEnvironmentId;
  return {
    readGitsClient: () => {
      const client = targetEnvironmentId ? readGitsEnvironmentClient(targetEnvironmentId) : null;
      if (!client) {
        throw new Error("No connected GITS environment.");
      }
      return client;
    },
    targetEnvironmentId,
  };
}

function toastError(title: string, error: unknown) {
  toastManager.add({
    title,
    description: error instanceof Error ? error.message : "Unknown error.",
    type: "error",
  });
}

/** Multi-repo picker: a Combobox chip-list when `projects` is available (the shell doesn't
 *  pass it today — see the `projects` prop below), otherwise the same one-path-per-line
 *  textarea every other repo list field already uses. */
function RepoMultiSelect({
  value,
  onChange,
  projects,
  placeholder,
}: {
  value: ReadonlyArray<string>;
  onChange: (next: ReadonlyArray<string>) => void;
  projects: ReadonlyArray<GitsCockpitProject> | undefined;
  placeholder: string;
}) {
  if (!projects || projects.length === 0) {
    return (
      <Textarea
        value={value.join("\n")}
        placeholder={placeholder}
        className="min-h-20 text-xs"
        onChange={(event) => onChange(parseLines(event.currentTarget.value))}
      />
    );
  }
  return (
    <Combobox<string, true> multiple value={[...value]} onValueChange={(next) => onChange(next)}>
      <ComboboxChips>
        {value.map((repo) => (
          <ComboboxChip key={repo}>
            <span className="max-w-48 truncate px-1">{repo}</span>
          </ComboboxChip>
        ))}
        <ComboboxChipsInput placeholder={value.length === 0 ? placeholder : undefined} />
      </ComboboxChips>
      <ComboboxPopup>
        <ComboboxEmpty>No projects found.</ComboboxEmpty>
        <ComboboxList>
          {projects.map((entry) => (
            <ComboboxItem key={entry.project.id} value={entry.project.rootPath}>
              <span className="grid min-w-0 gap-0.5">
                <span className="truncate text-sm">{entry.project.title}</span>
                <span className="truncate font-mono text-[11px] text-muted-foreground">
                  {entry.project.rootPath}
                </span>
              </span>
            </ComboboxItem>
          ))}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
}

export function AutopilotPanel({
  snapshot,
  scheduler,
  loading,
  error,
  actionError,
  actionPending,
  killSwitchEnabled,
  goalTitle,
  goalRepo,
  goalModel,
  goalPrompt,
  projects,
  proposals,
  focusedProposalId,
  onProposalDecision,
  onRefresh,
  onKillSwitchChange,
  onGoalTitleChange,
  onGoalRepoChange,
  onGoalModelChange,
  onGoalPromptChange,
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
  killSwitchEnabled: boolean;
  goalTitle: string;
  goalRepo: string;
  goalModel: string;
  goalPrompt: string;
  /** Not sent by the shell today (only Motoko/GSD panels get it) — falls back to a
   *  textarea for repo entry until `GitsCockpit.tsx` is updated to pass it. */
  projects?: ReadonlyArray<GitsCockpitProject>;
  proposals: HermesProposalListResult | undefined;
  focusedProposalId: string | null;
  onProposalDecision: (
    proposal: HermesProposalCard,
    decision: MotokoProposalDecision,
    edits: MotokoProposalEdits,
  ) => void;
  onRefresh: () => void;
  onKillSwitchChange: (value: boolean) => void;
  onGoalTitleChange: (value: string) => void;
  onGoalRepoChange: (value: string) => void;
  onGoalModelChange: (value: string) => void;
  onGoalPromptChange: (value: string) => void;
  onEnqueueGoal: () => void;
  onApproveGoal: (goalId: string) => void;
  onRejectGoal: (goalId: string) => void;
  onDispatchGoal: (goalId: string) => void;
  onSchedulerEnabledChange: (value: boolean) => void;
  onSchedulerArm: () => void;
  onSchedulerDisarm: () => void;
  onResumeDriver: () => void;
}) {
  const { readGitsClient, targetEnvironmentId } = useAutopilotGitsClient();

  // ---------------------------------------------------------------------------
  // Episode ledger ("Overnight results")
  // ---------------------------------------------------------------------------
  // ponytail: query key skips connectionState/authState (unlike useGitsCockpitQueries.ts's
  // siblings) — a reconnect blip can serve one stale poll; the 30s refetch heals it.
  const episodesQuery = useQuery({
    queryKey: ["gits", "automode", "episodes", targetEnvironmentId],
    queryFn: async () => readGitsClient().automode.episodesList({ limit: 25 }),
    refetchInterval: 30_000,
  });

  // ---------------------------------------------------------------------------
  // Emergency stop + per-goal kill
  // ---------------------------------------------------------------------------
  const [stopAllDialogOpen, setStopAllDialogOpen] = useState(false);
  const stopAllMutation = useMutation({
    mutationFn: async () => readGitsClient().automode.stopAll(),
    onSuccess: (result) => {
      setStopAllDialogOpen(false);
      toastManager.add({
        title: "Emergency stop",
        description: `${formatCount(result.stoppedPeers)} peer(s) stopped${
          result.failures > 0 ? `, ${formatCount(result.failures)} failed` : ""
        }.`,
        type: result.failures > 0 ? "error" : "success",
      });
      onRefresh();
    },
    onError: (cause) => toastError("Emergency stop failed", cause),
  });

  const [killGoalTarget, setKillGoalTarget] = useState<AutomodeGoal | null>(null);
  const killGoalMutation = useMutation({
    mutationFn: async (goalId: string) => readGitsClient().automode.killGoal({ goalId }),
    onSuccess: () => {
      setKillGoalTarget(null);
      onRefresh();
    },
    onError: (cause) => toastError("Kill goal failed", cause),
  });

  // ---------------------------------------------------------------------------
  // Automation switchboard + proposalRepos — immediate commit, optimistic with rollback.
  // A single pending-patch object covers every field that commits on change instead of
  // batching into the policy form's Save button.
  // ---------------------------------------------------------------------------
  const [pendingPatch, setPendingPatch] = useState<AutomodePolicyUpdateInput>({});
  const quickPolicyMutation = useMutation({
    mutationFn: async (patch: AutomodePolicyUpdateInput) =>
      readGitsClient().automode.updatePolicy(patch),
    onMutate: async (patch) => {
      setPendingPatch((current) => ({ ...current, ...patch }));
    },
    onSuccess: () => {
      setPendingPatch({});
      onRefresh();
    },
    onError: (cause) => {
      setPendingPatch({});
      toastError("Update failed", cause);
    },
  });
  const policy = snapshot?.policy;
  const effectiveProposalRepos = pendingPatch.proposalRepos ?? policy?.proposalRepos ?? [];

  // ---------------------------------------------------------------------------
  // Policy form — panel-owned dirty-merge state, seeded from `snapshot.policy` (which the
  // shell already passes) rather than the shell's individually-threaded field props, since
  // those don't cover the new fields (motokoAuthority, verificationCommands, ...). Fixes the
  // 2026-07-07 audit's clobber bug (#5) via `nextPolicyFormState`.
  // ---------------------------------------------------------------------------
  const [policyForm, setPolicyForm] = useState<AutopilotPolicyForm | null>(null);
  const [policyDirty, setPolicyDirty] = useState(false);
  const [policyError, setPolicyError] = useState<string | null>(null);

  useEffect(() => {
    if (!policy) return;
    setPolicyForm((current) =>
      current === null
        ? policyToFormState(policy)
        : nextPolicyFormState(current, policy, policyDirty),
    );
  }, [policy, policyDirty]);

  const updatePolicyForm = (patch: Partial<AutopilotPolicyForm>) => {
    setPolicyDirty(true);
    setPolicyForm((current) => (current ? { ...current, ...patch } : current));
  };
  const discardPolicyChanges = () => {
    setPolicyDirty(false);
    setPolicyError(null);
    if (policy) setPolicyForm(policyToFormState(policy));
  };
  const policySaveMutation = useMutation({
    mutationFn: async (input: AutomodePolicyUpdateInput) =>
      readGitsClient().automode.updatePolicy(input),
    onSuccess: () => {
      setPolicyDirty(false);
      setPolicyError(null);
      onRefresh();
    },
    onError: (cause) => setPolicyError(cause instanceof Error ? cause.message : "Save failed."),
  });
  const handleSavePolicy = () => {
    if (!policyForm) return;
    const result = formStateToPolicyUpdate(policyForm);
    if (!result.ok) {
      setPolicyError(result.error);
      return;
    }
    setPolicyError(null);
    policySaveMutation.mutate(result.input);
  };

  // ---------------------------------------------------------------------------
  // Goal queue
  // ---------------------------------------------------------------------------
  const [goalFilter, setGoalFilter] = useState<"all" | AutomodeGoalStatus>("all");
  const goals = snapshot?.goals ?? [];
  const filteredGoals = goalFilter === "all" ? goals : goals.filter((g) => g.status === goalFilter);

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
      <MotokoProposalReview
        proposals={proposals}
        proposalId={focusedProposalId}
        actionPending={actionPending}
        onDecision={onProposalDecision}
      />
      <div className="flex flex-col gap-3 border-b border-border/70 px-4 py-4 sm:flex-row sm:items-start sm:justify-between sm:px-5">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="truncate text-base font-semibold">Autopilot</h2>
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
            variant="destructive"
            onClick={() => setStopAllDialogOpen(true)}
            disabled={stopAllMutation.isPending}
          >
            <OctagonAlertIcon className="size-3.5" />
            Emergency Stop
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

      <AlertDialog open={stopAllDialogOpen} onOpenChange={setStopAllDialogOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Emergency stop?</AlertDialogTitle>
            <AlertDialogDescription>
              Kills every running peer and arms the kill switch.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose
              disabled={stopAllMutation.isPending}
              render={<Button variant="outline" disabled={stopAllMutation.isPending} />}
            >
              Cancel
            </AlertDialogClose>
            <Button
              variant="destructive"
              disabled={stopAllMutation.isPending}
              onClick={() => stopAllMutation.mutate()}
            >
              {stopAllMutation.isPending ? "Stopping…" : "Emergency stop"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>

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

      <InboxSection readGitsClient={readGitsClient} environmentId={targetEnvironmentId} />

      <h3 className="border-b border-border/60 px-4 py-2.5 text-xs font-semibold uppercase text-muted-foreground/80 sm:px-5">
        Automation switchboard
      </h3>
      <div className="grid gap-3 border-b border-border/60 px-4 py-4 sm:grid-cols-2 sm:px-5">
        {SWITCHBOARD_FIELDS.map(({ field, label, description }) => {
          const value = Boolean(pendingPatch[field] ?? policy?.[field] ?? false);
          return (
            <label key={field} className="flex items-start gap-2.5">
              <Switch
                checked={value}
                onCheckedChange={(checked) => quickPolicyMutation.mutate({ [field]: checked })}
                disabled={!policy || quickPolicyMutation.isPending}
                className="mt-0.5"
              />
              <span className="min-w-0">
                <span className="block text-xs font-medium">{label}</span>
                <span className="block text-[11px] text-muted-foreground">{description}</span>
              </span>
            </label>
          );
        })}
      </div>

      <div className="grid min-w-0 grid-cols-1 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <div className="grid min-w-0 gap-4 border-r border-border/60 px-4 py-4 sm:px-5">
          {scheduler ? (
            <div className="grid gap-2 rounded-lg border border-border/60 p-3 text-xs">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="font-medium">Night scheduler</span>
                <StatusPill
                  label={scheduler.arming.status === "armed" ? "armed" : "disarmed"}
                  tone={scheduler.arming.status === "armed" ? "success" : "warning"}
                />
                <label className="ml-auto flex items-center gap-2 text-muted-foreground">
                  Enabled
                  <Switch
                    checked={scheduler.config.enabled}
                    onCheckedChange={onSchedulerEnabledChange}
                    disabled={actionPending}
                  />
                </label>
              </div>
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
              {scheduler.lastGateDecision ? (
                <div className="text-muted-foreground">
                  Last gate: {formatGateDecision(scheduler.lastGateDecision)} (
                  {formatIsoDate(scheduler.lastGateDecision.at)})
                </div>
              ) : null}
              {scheduler.arming.status === "disarmed" && scheduler.arming.disarmedReason ? (
                <div className="text-destructive">{scheduler.arming.disarmedReason}</div>
              ) : null}
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={onSchedulerArm}
                  disabled={
                    actionPending ||
                    !scheduler.config.enabled ||
                    scheduler.arming.status === "armed"
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
              <div className="border-t border-border/60 pt-2">
                <span className="mb-1 block text-muted-foreground">
                  Proposal repos ({formatCount(effectiveProposalRepos.length)} opted in)
                </span>
                <RepoMultiSelect
                  value={effectiveProposalRepos}
                  onChange={(repos) => quickPolicyMutation.mutate({ proposalRepos: [...repos] })}
                  projects={projects}
                  placeholder="Proposal repos (one path per line)"
                />
                {reposNotAllowed(effectiveProposalRepos, policy?.allowedRepos ?? []).length > 0 ? (
                  <ul className="mt-1 grid gap-0.5 text-destructive">
                    {reposNotAllowed(effectiveProposalRepos, policy?.allowedRepos ?? []).map(
                      (repo) => (
                        <li key={repo} className="truncate font-mono text-[11px]">
                          {repo} — won&apos;t run — not in allowedRepos
                        </li>
                      ),
                    )}
                  </ul>
                ) : null}
              </div>
            </div>
          ) : null}

          {policyForm ? (
            <div className="grid gap-3">
              <span className="text-xs font-semibold uppercase text-muted-foreground/80">
                Policy
              </span>
              <div className="grid gap-2 sm:grid-cols-2">
                <Select<AutomodeMode>
                  value={policyForm.mode}
                  onValueChange={(value) => value !== null && updatePolicyForm({ mode: value })}
                >
                  <SelectTrigger size="sm">
                    <SelectValue>{policyForm.mode}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectGroup>
                      {AUTOMODE_MODES.map((mode) => (
                        <SelectItem key={mode} value={mode}>
                          {mode}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectPopup>
                </Select>
                <Input
                  nativeInput
                  size="sm"
                  value={policyForm.maxActivePeers}
                  placeholder="Max active peers"
                  onChange={(event) =>
                    updatePolicyForm({ maxActivePeers: event.currentTarget.value })
                  }
                />
              </div>

              <div>
                <Select<MotokoAuthority>
                  value={policyForm.motokoAuthority}
                  onValueChange={(value) =>
                    value !== null && updatePolicyForm({ motokoAuthority: value })
                  }
                >
                  <SelectTrigger size="sm" className="w-full">
                    <SelectValue>{policyForm.motokoAuthority}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup className="w-72">
                    <SelectGroup>
                      {MOTOKO_AUTHORITY_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value} className="py-2">
                          <span className="grid min-w-0 gap-0.5">
                            <span className="text-sm">{option.label}</span>
                            <span className="truncate text-[11px] text-muted-foreground">
                              {option.description}
                            </span>
                          </span>
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectPopup>
                </Select>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {
                    MOTOKO_AUTHORITY_OPTIONS.find((o) => o.value === policyForm.motokoAuthority)
                      ?.description
                  }
                </p>
              </div>

              <div className="grid gap-2 sm:grid-cols-2">
                <div>
                  <Select<CodexModelTier | "custom">
                    value={policyForm.defaultModelTier}
                    onValueChange={(value) =>
                      value !== null && updatePolicyForm({ defaultModelTier: value })
                    }
                  >
                    <SelectTrigger size="sm" className="w-full">
                      <SelectValue>
                        {policyForm.defaultModelTier === "custom"
                          ? "custom…"
                          : tierLabelShort(policyForm.defaultModelTier)}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      <SelectGroup>
                        {MODEL_TIERS.map((tier) => (
                          <SelectItem key={tier} value={tier}>
                            {CODEX_MODEL_TIER_LABELS[tier]}
                          </SelectItem>
                        ))}
                        <SelectItem value="custom">custom…</SelectItem>
                      </SelectGroup>
                    </SelectPopup>
                  </Select>
                  {policyForm.defaultModelTier === "custom" ? (
                    <Input
                      nativeInput
                      size="sm"
                      className="mt-1.5"
                      value={policyForm.defaultModelCustom}
                      placeholder="Custom default model slug"
                      onChange={(event) =>
                        updatePolicyForm({ defaultModelCustom: event.currentTarget.value })
                      }
                    />
                  ) : null}
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <Input
                    nativeInput
                    size="sm"
                    value={policyForm.maxBudgetUsd}
                    placeholder="Max budget USD"
                    onChange={(event) =>
                      updatePolicyForm({ maxBudgetUsd: event.currentTarget.value })
                    }
                  />
                  <Input
                    nativeInput
                    size="sm"
                    value={policyForm.maxRuntimeMinutes}
                    placeholder="Max runtime min"
                    onChange={(event) =>
                      updatePolicyForm({ maxRuntimeMinutes: event.currentTarget.value })
                    }
                  />
                </div>
              </div>

              <div>
                <span className="mb-1 block text-[11px] text-muted-foreground">Allowed models</span>
                <div className="flex flex-wrap gap-3">
                  {MODEL_TIERS.map((tier) => {
                    const checked = policyForm.allowedModelTiers.includes(tier);
                    return (
                      <label key={tier} className="flex items-center gap-1.5 text-xs">
                        <Checkbox
                          checked={checked}
                          onCheckedChange={(next) =>
                            updatePolicyForm({
                              allowedModelTiers: next
                                ? [...policyForm.allowedModelTiers, tier]
                                : policyForm.allowedModelTiers.filter((t) => t !== tier),
                            })
                          }
                        />
                        {tierLabelShort(tier)}
                      </label>
                    );
                  })}
                </div>
                <Textarea
                  value={policyForm.allowedModelsExtra}
                  placeholder="Additional allowed model slugs (one per line)"
                  className="mt-1.5 min-h-16 text-xs"
                  onChange={(event) =>
                    updatePolicyForm({ allowedModelsExtra: event.currentTarget.value })
                  }
                />
              </div>

              <div>
                <span className="mb-1 block text-[11px] text-muted-foreground">Allowed repos</span>
                <RepoMultiSelect
                  value={policyForm.allowedRepos}
                  onChange={(repos) => updatePolicyForm({ allowedRepos: repos })}
                  projects={projects}
                  placeholder="Allowed repos (one path per line)"
                />
              </div>

              <div className="grid gap-2 text-xs text-muted-foreground">
                <label className="flex items-center gap-2">
                  <Checkbox
                    checked={policyForm.requireApprovalForPeerSpawn}
                    onCheckedChange={(checked) =>
                      updatePolicyForm({ requireApprovalForPeerSpawn: Boolean(checked) })
                    }
                  />
                  Peer spawn approval
                </label>
                <label className="flex items-center gap-2">
                  <Checkbox
                    checked={policyForm.requireApprovalBeforeIntegrate}
                    onCheckedChange={(checked) =>
                      updatePolicyForm({ requireApprovalBeforeIntegrate: Boolean(checked) })
                    }
                  />
                  Integrate approval
                </label>
                <label className="flex items-center gap-2">
                  <Checkbox
                    checked={policyForm.requireApprovalBeforeDestructiveAction}
                    onCheckedChange={(checked) =>
                      updatePolicyForm({ requireApprovalBeforeDestructiveAction: Boolean(checked) })
                    }
                  />
                  Destructive approval
                </label>
              </div>

              <Input
                nativeInput
                size="sm"
                value={policyForm.integrationBranch}
                placeholder="Integration branch"
                onChange={(event) =>
                  updatePolicyForm({ integrationBranch: event.currentTarget.value })
                }
              />

              <div>
                <span className="mb-1 block text-[11px] text-muted-foreground">
                  Verification commands (JSON array of {"{"}label, cmd, timeoutSeconds?{"}"})
                </span>
                <Textarea
                  value={policyForm.verificationCommandsText}
                  placeholder='[{"label":"test","cmd":["bun","test"]}]'
                  className="min-h-24 font-mono text-xs"
                  onChange={(event) =>
                    updatePolicyForm({ verificationCommandsText: event.currentTarget.value })
                  }
                />
              </div>

              {policyError ? <p className="text-xs text-destructive">{policyError}</p> : null}

              <div className="flex justify-end gap-2">
                {policyDirty ? (
                  <Button size="sm" variant="ghost" onClick={discardPolicyChanges}>
                    Discard changes
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  onClick={handleSavePolicy}
                  disabled={!policyDirty || policySaveMutation.isPending}
                >
                  <ShieldCheckIcon className="size-3.5" />
                  {policySaveMutation.isPending ? "Saving…" : "Save Policy"}
                </Button>
              </div>
            </div>
          ) : (
            <EmptyState label="Loading policy…" />
          )}
        </div>

        <div className="min-w-0">
          <SectionHeader title="Goal queue" count={filteredGoals.length} />
          <div className="flex flex-wrap gap-1.5 border-b border-border/60 px-4 py-2.5 sm:px-5">
            {GOAL_STATUS_FILTERS.map((filterValue) => (
              <Button
                key={filterValue}
                size="xs"
                variant={goalFilter === filterValue ? "default" : "outline"}
                onClick={() => setGoalFilter(filterValue)}
              >
                {formatFilterLabel(filterValue)}
              </Button>
            ))}
          </div>

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

          {filteredGoals.length === 0 ? (
            <EmptyState
              label={goals.length === 0 ? "No queued goals." : "No goals match this filter."}
            />
          ) : (
            <div className="divide-y divide-border/60">
              {filteredGoals.map((goal) => {
                const tier = modelTierOf(goal.model ?? snapshot?.policy.defaultModel ?? null);
                return (
                  <div key={goal.id} className="grid gap-2 px-4 py-3 text-xs sm:px-5">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate font-medium">{goal.title}</span>
                      <StatusPill label={goal.status} tone={automodeGoalTone(goal)} />
                      <StatusPill
                        label={tier ? tierLabelShort(tier) : (goal.model ?? "no model")}
                        tone="default"
                      />
                    </div>
                    <div className="truncate font-mono text-[11px] text-muted-foreground">
                      {goal.repo} · {goal.episodeId}
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
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() => setKillGoalTarget(goal)}
                        disabled={killGoalMutation.isPending}
                      >
                        <SkullIcon className="size-3.5" />
                        Kill
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <AlertDialog
        open={killGoalTarget !== null}
        onOpenChange={(open) => {
          if (!open && !killGoalMutation.isPending) setKillGoalTarget(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Kill goal?</AlertDialogTitle>
            <AlertDialogDescription>
              {killGoalTarget ? (
                <>
                  This stops <strong>{killGoalTarget.title}</strong> and its peer, if running.
                </>
              ) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose
              disabled={killGoalMutation.isPending}
              render={<Button variant="outline" disabled={killGoalMutation.isPending} />}
            >
              Cancel
            </AlertDialogClose>
            <Button
              variant="destructive"
              disabled={killGoalMutation.isPending || !killGoalTarget}
              onClick={() => killGoalTarget && killGoalMutation.mutate(killGoalTarget.id)}
            >
              {killGoalMutation.isPending ? "Killing…" : "Kill goal"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>

      <SectionHeader title="Overnight results" count={episodesQuery.data?.length ?? 0} />
      {episodesQuery.error ? (
        <div className="px-4 py-3 text-xs text-destructive sm:px-5">
          {episodesQuery.error instanceof Error
            ? episodesQuery.error.message
            : "Failed to load episode history."}
        </div>
      ) : !episodesQuery.data || episodesQuery.data.length === 0 ? (
        <EmptyState
          label={episodesQuery.isPending ? "Loading…" : "No completed runs yet tonight."}
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-xs">
            <thead>
              <tr className="border-b border-border/60 text-[11px] uppercase text-muted-foreground/80">
                <th className="px-4 py-2 font-medium sm:px-5">Created</th>
                <th className="px-2 py-2 font-medium">Repo</th>
                <th className="px-2 py-2 font-medium">Goal</th>
                <th className="px-2 py-2 font-medium">Verdict</th>
                <th className="px-2 py-2 font-medium">Flagged</th>
                <th className="px-2 py-2 font-medium">Slice branch</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {episodesQuery.data.map((episode: AutomodeEpisode) => (
                <tr key={episode.id}>
                  <td className="whitespace-nowrap px-4 py-2 text-muted-foreground sm:px-5">
                    {formatIsoDate(episode.createdAt)}
                  </td>
                  <td className="px-2 py-2 font-mono text-[11px]">{repoBasename(episode.repo)}</td>
                  <td className="max-w-56 truncate px-2 py-2">{episode.goalTitle}</td>
                  <td className="px-2 py-2">
                    <StatusPill label={episode.verdict} tone={verdictTone(episode.verdict)} />
                  </td>
                  <td className="px-2 py-2">
                    {episode.flagged ? <StatusPill label="flagged" tone="danger" /> : null}
                  </td>
                  <td className="max-w-56 truncate px-2 py-2 font-mono text-[11px] text-primary">
                    {episode.sliceBranch ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
