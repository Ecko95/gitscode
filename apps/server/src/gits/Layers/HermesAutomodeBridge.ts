import * as Effect from "effect/Effect";

import type { HermesProposalDecisionInput } from "@t3tools/contracts";

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
 * Motoko→Automode bridge (audit 2026-07-07 §B4). Decides the proposal, then — only when
 * the operator has opted in via `autoEnqueueApprovedProposals` AND armed autonomous mode —
 * converts a freshly approved proposal into a queued automode goal via the existing
 * draft rails. Everything else (flag off, manual/supervised mode, re-approve, open-gsd /
 * verification / blocked drafts) stays handoff-only, exactly as before.
 *
 * Bridge failures are logged, not surfaced: the decision itself already persisted, and
 * failing the RPC after that would leave the operator unable to retry (re-approve is a
 * guarded no-op). The missing goal is visible in the automode panel either way.
 */
export const decideProposalWithAutomodeBridge = (
  hermes: Pick<HermesAdapterShape, "listProposals" | "decideProposal" | "draftFromProposal">,
  automode: Pick<AutomodeSupervisorShape, "getSnapshot" | "enqueueGoal">,
  input: HermesProposalDecisionInput,
): ReturnType<HermesAdapterShape["decideProposal"]> =>
  Effect.gen(function* () {
    // Capture the snapshot once: its policy arms the bridge and its goals feed the
    // episode-thread dedup below (a card the sweep already enqueued must not double-enqueue).
    const snapshot =
      input.decision === "approve"
        ? yield* automode.getSnapshot().pipe(Effect.catch(() => Effect.succeed(null)))
        : null;
    const bridgeArmed =
      snapshot !== null &&
      snapshot.policy.autoEnqueueApprovedProposals &&
      snapshot.policy.mode === "autonomous";
    // Prior status must be read before deciding: approve→approve must not re-enqueue.
    // Capture the whole card — its episodeId threads proposal → goal (decision 23).
    const priorProposal = bridgeArmed
      ? ((yield* hermes.listProposals()).proposals.find(
          (proposal) => proposal.id === input.proposalId,
        ) ?? null)
      : null;
    const decided = yield* hermes.decideProposal(input);
    if (bridgeArmed && priorProposal?.status !== "approved") {
      yield* hermes.draftFromProposal({ proposalId: input.proposalId }).pipe(
        Effect.flatMap((draft) =>
          draft.kind === "delamain-peer" &&
          draft.status === "draft" &&
          draft.repo !== null &&
          !(
            priorProposal !== null &&
            snapshot !== null &&
            hasLiveGoalForEpisode(snapshot.goals, priorProposal.episodeId)
          )
            ? automode
                .enqueueGoal({
                  title: draft.title,
                  prompt: draft.prompt,
                  repo: draft.repo,
                  origin: "proposal",
                  ...(priorProposal === null ? {} : { episodeId: priorProposal.episodeId }),
                })
                .pipe(Effect.asVoid)
            : Effect.void,
        ),
        Effect.catch((cause) =>
          Effect.logWarning("hermes→automode auto-enqueue failed after approval", {
            proposalId: input.proposalId,
            detail: cause.message,
          }),
        ),
      );
    }
    return decided;
  });
