import type {
  AutomodeGoal,
  AutomodeSnapshot,
  GitsCockpitProject,
  HermesProposalCard,
  HermesProposalListResult,
} from "@t3tools/contracts";
import { useMutation } from "@tanstack/react-query";
import { OctagonAlertIcon, RefreshCwIcon, RocketIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

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
import { Textarea } from "~/components/ui/textarea";
import { toastManager } from "~/components/ui/toast";
import { usePrimaryEnvironmentId } from "~/environments/primary";
import type { GitsEnvironmentClient } from "~/gitsClient";
import { readGitsEnvironmentClient } from "~/gitsClient";
import { cn } from "~/lib/utils";
import { useStore } from "~/store";

import type { MotokoProposalDecision, MotokoProposalEdits } from "./MotokoPanel";
import { InboxSection } from "./InboxSection";
import { ProposalLaunchSheet } from "./ProposalLaunchSheet";
import {
  guidedAutopilotRepositories,
  isGuidedAutopilotProposal,
} from "./proposal-launch/proposalLaunch.logic";
import { EmptyState, StatusPill, formatCount } from "./primitives";

const TERMINAL_GOAL_STATUSES = new Set(["completed", "failed", "blocked", "rejected"]);

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
      if (!client) throw new Error("No connected GITS environment.");
      return client;
    },
    targetEnvironmentId,
  };
}

function RepositoryPicker({
  value,
  onChange,
  projects,
}: {
  readonly value: ReadonlyArray<string>;
  readonly onChange: (value: ReadonlyArray<string>) => void;
  readonly projects: ReadonlyArray<GitsCockpitProject> | undefined;
}) {
  if (!projects || projects.length === 0) {
    return (
      <Textarea
        aria-label="Watched repositories"
        className="min-h-20 font-mono text-xs"
        placeholder="One repository path per line"
        value={value.join("\n")}
        onChange={(event) =>
          onChange(
            event.currentTarget.value
              .split("\n")
              .map((entry) => entry.trim())
              .filter(Boolean),
          )
        }
      />
    );
  }
  return (
    <Combobox<string, true> multiple value={[...value]} onValueChange={onChange}>
      <ComboboxChips aria-label="Watched repositories">
        {value.map((repository) => (
          <ComboboxChip key={repository}>{repository}</ComboboxChip>
        ))}
        <ComboboxChipsInput placeholder={value.length === 0 ? "Choose repositories" : undefined} />
      </ComboboxChips>
      <ComboboxPopup>
        <ComboboxEmpty>No repositories found.</ComboboxEmpty>
        <ComboboxList>
          {projects.map((entry) => (
            <ComboboxItem key={entry.project.id} value={entry.project.rootPath}>
              <span className="grid min-w-0">
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

function goalTone(goal: AutomodeGoal): "default" | "success" | "warning" | "danger" {
  if (goal.status === "running") return "success";
  if (goal.status === "queued" || goal.status === "waiting-approval") return "warning";
  return "default";
}

export function AutopilotPanel({
  snapshot,
  loading,
  error,
  projects,
  proposals,
  focusedProposalId,
  onProposalDecision,
  onRefresh,
}: {
  readonly snapshot: AutomodeSnapshot | undefined;
  readonly loading: boolean;
  readonly error: unknown;
  readonly projects?: ReadonlyArray<GitsCockpitProject>;
  readonly proposals: HermesProposalListResult | undefined;
  readonly focusedProposalId: string | null;
  readonly onProposalDecision: (
    proposal: HermesProposalCard,
    decision: MotokoProposalDecision,
    edits: MotokoProposalEdits,
  ) => Promise<AutomodeGoal | null>;
  readonly onRefresh: () => void;
}) {
  const { readGitsClient, targetEnvironmentId } = useAutopilotGitsClient();
  const policy = snapshot?.policy;
  const on = policy?.mode === "autonomous" && !policy.killSwitchEnabled;
  const policyRepositories = useMemo(
    () => (policy ? guidedAutopilotRepositories(policy) : []),
    [policy],
  );
  const repositoryKey = policyRepositories.join("\n");
  const [repositories, setRepositories] = useState<ReadonlyArray<string>>(policyRepositories);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [stopOpen, setStopOpen] = useState(false);
  const [selectedProposal, setSelectedProposal] = useState<HermesProposalCard | null>(null);
  const notificationTest =
    typeof window === "undefined"
      ? null
      : new URLSearchParams(window.location.search).get("notificationTest");
  const proposalTest = notificationTest === "proposal";
  const [launchOpen, setLaunchOpen] = useState(proposalTest);

  const openProposal = useCallback((proposal: HermesProposalCard, resetStep = true) => {
    setSelectedProposal(proposal);
    setLaunchOpen(true);
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    url.searchParams.set("panel", "autopilot");
    url.searchParams.set("proposal", proposal.id);
    if (resetStep) url.searchParams.set("proposalStep", "idea");
    window.history.replaceState(null, "", url);
  }, []);

  const changeLaunchOpen = (open: boolean) => {
    setLaunchOpen(open);
    if (open || proposalTest || typeof window === "undefined") return;
    const url = new URL(window.location.href);
    url.searchParams.delete("proposal");
    url.searchParams.delete("proposalStep");
    window.history.replaceState(null, "", url);
  };

  useEffect(() => setRepositories(repositoryKey.split("\n").filter(Boolean)), [repositoryKey]);

  useEffect(() => {
    if (!focusedProposalId) return;
    const proposal = proposals?.proposals.find((candidate) => candidate.id === focusedProposalId);
    if (
      proposal &&
      ["proposed", "approved"].includes(proposal.status) &&
      isGuidedAutopilotProposal(proposal)
    ) {
      openProposal(proposal, false);
    }
  }, [focusedProposalId, proposals, openProposal]);

  const configure = useMutation({
    mutationFn: (enabled: boolean) => {
      if (enabled && repositories.length === 0) {
        throw new Error("Choose at least one watched repository before turning Autopilot on.");
      }
      return readGitsClient().automode.configure({ enabled, repositories: [...repositories] });
    },
    onSuccess: () => {
      setValidationError(null);
      onRefresh();
    },
    onError: (cause) =>
      setValidationError(
        cause instanceof Error ? cause.message : "Autopilot could not be updated.",
      ),
  });
  const stopAll = useMutation({
    mutationFn: () => readGitsClient().automode.stopAll(),
    onSuccess: (result) => {
      setStopOpen(false);
      toastManager.add({
        title: "Emergency stop complete",
        description: `${formatCount(result.stoppedPeers)} running peer(s) stopped.`,
        type: result.failures > 0 ? "error" : "success",
      });
      onRefresh();
    },
  });

  const pendingProposals = useMemo(
    () =>
      proposals?.proposals.filter(
        (proposal) => proposal.status === "proposed" && isGuidedAutopilotProposal(proposal),
      ) ?? [],
    [proposals],
  );
  const focusedProposalUnavailable =
    focusedProposalId !== null &&
    proposals !== undefined &&
    !proposals.proposals.some(
      (proposal) =>
        proposal.id === focusedProposalId &&
        ["proposed", "approved"].includes(proposal.status) &&
        isGuidedAutopilotProposal(proposal),
    )
      ? "This proposal is no longer available for guided Autopilot. Refresh the Inbox or review it in Motoko."
      : null;
  const visibleGoals =
    snapshot?.goals.filter((goal) => !TERMINAL_GOAL_STATUSES.has(goal.status)).slice(0, 5) ?? [];
  const errorMessage =
    validationError ??
    focusedProposalUnavailable ??
    (error instanceof Error ? error.message : null) ??
    (stopAll.error instanceof Error ? stopAll.error.message : null);

  return (
    <section className="border-b border-border bg-background">
      <header className="flex flex-col gap-4 border-b border-border/70 px-4 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-5">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="font-heading text-xl font-semibold">Autopilot</h2>
            <StatusPill label={on ? "On" : "Paused"} tone={on ? "success" : "warning"} />
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Review an idea, choose a model, and queue it. Safety gates stay automatic.
          </p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={onRefresh} disabled={loading}>
            <RefreshCwIcon className={cn("size-3.5", loading && "animate-spin")} />
            Refresh
          </Button>
          <Button
            size="sm"
            variant={on ? "outline" : "default"}
            disabled={configure.isPending || !policy}
            onClick={() => configure.mutate(!on)}
          >
            {on ? "Pause" : "Turn on"}
          </Button>
          <Button size="sm" variant="destructive" onClick={() => setStopOpen(true)}>
            <OctagonAlertIcon /> Emergency Stop
          </Button>
        </div>
      </header>

      {notificationTest === "delivery" ? (
        <div className="border-b border-success/25 bg-success/8 px-4 py-3 text-sm text-success-foreground sm:px-5">
          Notification click confirmed — Android opened the GITS PWA.
        </div>
      ) : null}
      {errorMessage ? (
        <p
          role="alert"
          className="border-b border-destructive/25 bg-destructive/6 px-4 py-3 text-sm text-destructive sm:px-5"
        >
          {errorMessage}
        </p>
      ) : null}

      <div className="grid border-b border-border/60 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
        <section className="grid content-start gap-3 border-b border-border/60 px-4 py-5 sm:px-5 lg:border-r lg:border-b-0">
          <div>
            <h3 className="text-sm font-semibold">Watched repositories</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Autopilot proposes and runs work only here.
            </p>
          </div>
          <RepositoryPicker value={repositories} onChange={setRepositories} projects={projects} />
          {policy && repositories.join("\n") !== repositoryKey ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => configure.mutate(Boolean(on))}
              disabled={configure.isPending}
            >
              Save repositories
            </Button>
          ) : null}
        </section>

        <section className="px-4 py-5 sm:px-5" aria-labelledby="proposal-heading">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 id="proposal-heading" className="text-sm font-semibold">
                Ideas ready to validate
              </h3>
              <p className="mt-1 text-xs text-muted-foreground">
                Accepting adds exactly one Goal to the queue.
              </p>
            </div>
            <StatusPill
              label={formatCount(pendingProposals.length)}
              tone={pendingProposals.length > 0 ? "warning" : "default"}
            />
          </div>
          {pendingProposals.length === 0 ? (
            <EmptyState label="No proposals waiting." />
          ) : (
            <div className="mt-3 grid gap-2">
              {pendingProposals.slice(0, 3).map((proposal) => (
                <article
                  key={proposal.id}
                  className="flex items-start gap-3 rounded-xl border border-border/70 p-3"
                >
                  <RocketIcon className="mt-0.5 size-4 shrink-0 text-info-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{proposal.title}</p>
                    <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                      {proposal.summary}
                    </p>
                  </div>
                  <Button size="sm" variant="outline" onClick={() => openProposal(proposal)}>
                    Review
                  </Button>
                </article>
              ))}
            </div>
          )}
        </section>
      </div>

      <InboxSection readGitsClient={readGitsClient} environmentId={targetEnvironmentId} />

      <section className="px-4 py-5 sm:px-5" aria-labelledby="queue-heading">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h3 id="queue-heading" className="text-sm font-semibold">
              Queue
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Accepted work waiting or running now.
            </p>
          </div>
          <StatusPill label={formatCount(visibleGoals.length)} tone="default" />
        </div>
        {visibleGoals.length === 0 ? (
          <EmptyState label="The queue is empty." />
        ) : (
          <div className="mt-3 divide-y divide-border/60 rounded-xl border border-border/70">
            {visibleGoals.map((goal) => (
              <article key={goal.id} className="flex items-center gap-3 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{goal.title}</p>
                  <p className="truncate font-mono text-[11px] text-muted-foreground">
                    {goal.repo.slice(goal.repo.lastIndexOf("/") + 1) || goal.repo}
                  </p>
                </div>
                <StatusPill label={goal.status} tone={goalTone(goal)} />
              </article>
            ))}
          </div>
        )}
      </section>

      {policy ? (
        <ProposalLaunchSheet
          open={launchOpen}
          onOpenChange={changeLaunchOpen}
          proposal={selectedProposal}
          policy={policy}
          {...(proposalTest ? { testMode: "proposal" as const } : {})}
          onDecision={onProposalDecision}
        />
      ) : null}

      <AlertDialog open={stopOpen} onOpenChange={setStopOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Emergency stop?</AlertDialogTitle>
            <AlertDialogDescription>
              Pause future work and stop every running autonomous peer.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              disabled={stopAll.isPending}
              onClick={() => stopAll.mutate()}
            >
              {stopAll.isPending ? "Stopping…" : "Emergency stop"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </section>
  );
}
