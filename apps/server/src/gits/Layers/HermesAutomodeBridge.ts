import * as Effect from "effect/Effect";

import { HermesAdapterError, type HermesProposalDecisionInput } from "@t3tools/contracts";

import type { AutomodeSupervisorShape } from "../Services/AutomodeSupervisor.ts";
import type { CockpitInboxShape } from "../Services/CockpitInbox.ts";
import type { GitsSlotSchedulerShape } from "../Services/GitsSlotScheduler.ts";
import type { HermesAdapterShape } from "../Services/HermesAdapter.ts";

const TERMINAL_GOAL_STATUSES = new Set(["completed", "failed", "blocked", "rejected"]);

/**
 * Episode-thread dedup shared by the sweep and the approve bridge: a proposal already
 * carried into a live (non-terminal) goal must not be enqueued again. Both entry points
 * thread the proposal's episodeId onto the goal, so one live goal per episodeId is enough.
 */
export const hasLiveGoalForEpisode = (
  goals: ReadonlyArray<{ readonly episodeId: string; readonly status: string }>,
  episodeId: string,
): boolean =>
  goals.some((goal) => goal.episodeId === episodeId && !TERMINAL_GOAL_STATUSES.has(goal.status));

/**
 * Repo-level dedup for the nightly sweep. Each inspect mints a fresh episodeId, so
 * episode dedup can never fire on the sweep path; a repo with a still-live goal (a
 * prior night's sweep or a cockpit approve, operator away) must be skipped BEFORE the
 * codex spend, or goals pile up unboundedly.
 */
export const hasLiveGoalForRepo = (
  goals: ReadonlyArray<{ readonly repo: string; readonly status: string }>,
  repo: string,
): boolean => goals.some((goal) => goal.repo === repo && !TERMINAL_GOAL_STATUSES.has(goal.status));

/**
 * Motoko→Automode bridge. Approval always queues an actionable Delamain draft; the
 * Automode policy and scheduler still control when it can dispatch. Re-approval retries
 * a prior enqueue failure and remains idempotent once a live episode goal exists.
 */
export const decideProposalWithAutomodeBridge = (
  hermes: Pick<HermesAdapterShape, "listProposals" | "decideProposal" | "draftFromProposal">,
  automode: Pick<AutomodeSupervisorShape, "getSnapshot" | "enqueueGoal" | "updateQueuedGoal">,
  input: HermesProposalDecisionInput,
  dependencies?: {
    readonly scheduler: Pick<GitsSlotSchedulerShape, "scheduleApprovedGoal">;
    readonly inbox: Pick<CockpitInboxShape, "record">;
  },
) =>
  Effect.gen(function* () {
    const snapshot =
      input.decision === "approve"
        ? yield* automode.getSnapshot().pipe(
            Effect.mapError(
              (cause) =>
                new HermesAdapterError({
                  message: "Failed to validate Automode policy.",
                  cause,
                }),
            ),
          )
        : null;
    const priorProposal = snapshot
      ? ((yield* hermes.listProposals()).proposals.find(
          (proposal) => proposal.id === input.proposalId,
        ) ?? null)
      : null;
    if (
      snapshot !== null &&
      priorProposal !== null &&
      priorProposal.actionKind !== "read-only" &&
      priorProposal.recommendedExecutor !== "open-gsd"
    ) {
      const repo = input.projectDir ?? priorProposal.projectDir;
      const model = input.model === undefined ? priorProposal.model : input.model;
      const effectiveModel = model ?? snapshot.policy.defaultModel;
      const runtime =
        input.maxRuntimeMinutes === undefined
          ? priorProposal.maxRuntimeMinutes
          : input.maxRuntimeMinutes;
      const verification = input.verificationCommands ?? priorProposal.verificationCommands;
      const integrationBranch =
        input.integrationBranch === undefined
          ? priorProposal.integrationBranch
          : input.integrationBranch;
      if (repo === null || !snapshot.policy.allowedRepos.includes(repo)) {
        return yield* new HermesAdapterError({
          message: "Proposal repository is not allowed by Automode policy.",
        });
      }
      if (
        effectiveModel !== null &&
        snapshot.policy.allowedModels.length > 0 &&
        !snapshot.policy.allowedModels.includes(effectiveModel)
      ) {
        return yield* new HermesAdapterError({
          message: "Proposal model is not allowed by Automode policy.",
        });
      }
      if (
        snapshot.policy.maxRuntimeMinutes !== null &&
        (runtime === null || runtime > snapshot.policy.maxRuntimeMinutes)
      ) {
        return yield* new HermesAdapterError({
          message: "Proposal runtime exceeds the Automode policy limit.",
        });
      }
      if (
        snapshot.policy.verificationCommands.length > 0 &&
        verification.some(
          (command) =>
            !snapshot.policy.verificationCommands.some(
              (allowed) => JSON.stringify(allowed) === JSON.stringify(command),
            ),
        )
      ) {
        return yield* new HermesAdapterError({
          message: "Proposal verification commands are not allowed by Automode policy.",
        });
      }
      if (
        snapshot.policy.integrationBranch !== null &&
        integrationBranch !== snapshot.policy.integrationBranch
      ) {
        return yield* new HermesAdapterError({
          message: "Proposal integration branch does not match Automode policy.",
        });
      }
    }
    const decided = yield* hermes.decideProposal(input);
    if (snapshot !== null && priorProposal !== null) {
      const draft = yield* hermes.draftFromProposal({
        proposalId: input.proposalId,
      });
      if (draft.kind === "delamain-peer" && draft.status === "draft" && draft.repo !== null) {
        const existing = snapshot.goals.find(
          (goal) =>
            goal.episodeId === priorProposal.episodeId && !TERMINAL_GOAL_STATUSES.has(goal.status),
        );
        const editable =
          existing !== undefined && ["queued", "waiting-approval"].includes(existing.status);
        const update = {
          title: draft.title,
          prompt: draft.prompt,
          repo: draft.repo,
          notBefore: decided.notBefore,
          maxRuntimeMinutes: decided.maxRuntimeMinutes,
          verificationCommands: decided.verificationCommands,
          integrationBranch: decided.integrationBranch,
        };
        if (existing === undefined) {
          yield* automode
            .enqueueGoal({
              ...update,
              ...(decided.model === null ? {} : { model: decided.model }),
              origin: "proposal",
              episodeId: priorProposal.episodeId,
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new HermesAdapterError({
                    message: "Failed to queue approved proposal.",
                    cause,
                  }),
              ),
            );
        } else if (editable) {
          yield* automode
            .updateQueuedGoal({
              ...update,
              goalId: existing.id,
              model: decided.model,
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new HermesAdapterError({
                    message: "Failed to queue approved proposal.",
                    cause,
                  }),
              ),
            );
        }
      }
    }
    if (dependencies !== undefined) {
      const current =
        input.decision === "approve"
          ? (yield* automode.getSnapshot()).goals.find(
              (goal) =>
                goal.episodeId === decided.episodeId && !TERMINAL_GOAL_STATUSES.has(goal.status),
            )
          : undefined;
      if (input.decision !== "approve" || current !== undefined) {
        let targetsCurrentNight = false;
        if (input.decision === "approve") {
          const scheduled = yield* dependencies.scheduler.scheduleApprovedGoal({
            eligibleAt: decided.notBefore,
          });
          targetsCurrentNight = scheduled.targetsCurrentNight;
        }
        const eventKey = `proposal:${decided.id}:${input.decision}`;
        const deepLink =
          current === undefined
            ? `/gits?panel=autopilot&proposal=${encodeURIComponent(decided.id)}`
            : `/gits?panel=autopilot&goal=${encodeURIComponent(current.id)}`;
        yield* dependencies.inbox.record({
          episodeId: decided.episodeId,
          proposalId: decided.id,
          goalId: current?.id ?? null,
          title: decided.title,
          repository: decided.projectDir,
          eventKey,
          state:
            input.decision === "approve"
              ? "approved-queued"
              : input.decision === "reject"
                ? "rejected"
                : "deferred",
          reason:
            input.decision === "approve"
              ? "Approved and queued for autonomous work."
              : input.decision === "reject"
                ? "Proposal rejected."
                : "Proposal deferred.",
          deepLink,
        });
        if (targetsCurrentNight) {
          yield* dependencies.inbox.record({
            episodeId: decided.episodeId,
            proposalId: decided.id,
            goalId: current!.id,
            title: decided.title,
            repository: decided.projectDir,
            eventKey: `goal:${current!.id}:scheduled`,
            state: "scheduled-tonight",
            reason: "Scheduled for the current autonomy night.",
            deepLink,
          });
        }
      }
    }
    return decided;
  }).pipe(
    Effect.mapError((cause) =>
      cause._tag === "HermesAdapterError"
        ? cause
        : new HermesAdapterError({
            message: "Failed to approve proposal.",
            cause,
          }),
    ),
  );
