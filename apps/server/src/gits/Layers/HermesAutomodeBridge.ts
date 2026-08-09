import * as Effect from "effect/Effect";

import { HermesAdapterError, type HermesProposalDecisionInput } from "@t3tools/contracts";

import type { AutomodeSupervisorShape } from "../Services/AutomodeSupervisor.ts";
import type { HermesAdapterShape } from "../Services/HermesAdapter.ts";

const TERMINAL_GOAL_STATUSES = ["completed", "failed", "blocked", "rejected"];

/**
 * Episode-thread dedup shared by the sweep and the approve bridge: a proposal already
 * carried into a live (non-terminal) goal must not be enqueued again. Both entry points
 * thread the proposal's episodeId onto the goal, so one live goal per episodeId is enough.
 */
export const hasLiveGoalForEpisode = (
  goals: ReadonlyArray<{ readonly episodeId: string; readonly status: string }>,
  episodeId: string,
): boolean =>
  goals.some(
    (goal) => goal.episodeId === episodeId && !TERMINAL_GOAL_STATUSES.includes(goal.status),
  );

/**
 * Repo-level dedup for the nightly sweep. Each inspect mints a fresh episodeId, so
 * episode dedup can never fire on the sweep path; a repo with a still-live goal (a
 * prior night's sweep or a cockpit approve, operator away) must be skipped BEFORE the
 * codex spend, or goals pile up unboundedly.
 */
export const hasLiveGoalForRepo = (
  goals: ReadonlyArray<{ readonly repo: string; readonly status: string }>,
  repo: string,
): boolean =>
  goals.some((goal) => goal.repo === repo && !TERMINAL_GOAL_STATUSES.includes(goal.status));

/**
 * Motoko→Automode bridge. Approval always queues an actionable Delamain draft; the
 * Automode policy and scheduler still control when it can dispatch. Re-approval retries
 * a prior enqueue failure and remains idempotent once a live episode goal exists.
 */
export const decideProposalWithAutomodeBridge = (
  hermes: Pick<HermesAdapterShape, "listProposals" | "decideProposal" | "draftFromProposal">,
  automode: Pick<AutomodeSupervisorShape, "getSnapshot" | "enqueueGoal">,
  input: HermesProposalDecisionInput,
) =>
  Effect.gen(function* () {
    const snapshot =
      input.decision === "approve"
        ? yield* automode
            .getSnapshot()
            .pipe(
              Effect.mapError(
                (cause) =>
                  new HermesAdapterError({ message: "Failed to validate Automode policy.", cause }),
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
    }
    const decided = yield* hermes.decideProposal(input);
    if (
      snapshot !== null &&
      priorProposal !== null &&
      !hasLiveGoalForEpisode(snapshot.goals, priorProposal.episodeId)
    ) {
      const draft = yield* hermes.draftFromProposal({ proposalId: input.proposalId });
      if (draft.kind === "delamain-peer" && draft.status === "draft" && draft.repo !== null) {
        yield* automode
          .enqueueGoal({
            title: draft.title,
            prompt: draft.prompt,
            repo: draft.repo,
            ...(decided.model === null ? {} : { model: decided.model }),
            notBefore: decided.notBefore,
            maxRuntimeMinutes: decided.maxRuntimeMinutes,
            verificationCommands: decided.verificationCommands,
            integrationBranch: decided.integrationBranch,
            origin: "proposal",
            episodeId: priorProposal.episodeId,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new HermesAdapterError({ message: "Failed to queue approved proposal.", cause }),
            ),
          );
      }
    }
    return decided;
  }).pipe(
    Effect.mapError((cause) =>
      cause._tag === "HermesAdapterError"
        ? cause
        : new HermesAdapterError({ message: "Failed to approve proposal.", cause }),
    ),
  );
