import * as Effect from "effect/Effect";

import type { HermesProposalDecisionInput } from "@t3tools/contracts";

import type { AutomodeSupervisorShape } from "../Services/AutomodeSupervisor.ts";
import type { HermesAdapterShape } from "../Services/HermesAdapter.ts";

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
    const bridgeArmed =
      input.decision === "approve" &&
      (yield* automode.getSnapshot().pipe(
        Effect.map(
          (snapshot) =>
            snapshot.policy.autoEnqueueApprovedProposals && snapshot.policy.mode === "autonomous",
        ),
        Effect.catch(() => Effect.succeed(false)),
      ));
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
          draft.kind === "delamain-peer" && draft.status === "draft" && draft.repo !== null
            ? automode
                .enqueueGoal({
                  title: draft.title,
                  prompt: draft.prompt,
                  repo: draft.repo,
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
