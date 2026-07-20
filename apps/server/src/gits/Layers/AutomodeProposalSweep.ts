import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import type { AutomodeGoal } from "@t3tools/contracts";

import { writeFileStringAtomically } from "../../atomicWrite.ts";
import { ServerConfig } from "../../config.ts";
import { AutomodeEpisodeLedger } from "../../persistence/Services/AutomodeEpisodeLedger.ts";
import { HermesAdapter } from "../Services/HermesAdapter.ts";
import { AutomodeProposalSweep } from "../Services/AutomodeProposalSweep.ts";
import { AutomodeSupervisor } from "../Services/AutomodeSupervisor.ts";
import { HermesTelegramNotifier } from "../Services/HermesTelegramNotifier.ts";
import { hasLiveGoalForRepo } from "./HermesAutomodeBridge.ts";
import { london_instant } from "./GitsSlotScheduler.ts";
import { repoAllowed } from "./AutomodeSupervisor.ts";

const REPLY_HINT = "Reply: APPROVE <id> · REJECT <id>";

const STATE_FILE_NAME = "automode-proposal-sweep-state.json";
const DEFAULT_START_MINUTES = 20 * 60; // 20:00 London dinner window.
const START_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** GITS_PROPOSAL_SWEEP_START_HHMM override; invalid input warns and falls back to 20:00. */
function parseStartMinutes(raw: string | undefined): {
  readonly minutes: number;
  readonly error: string | null;
} {
  const trimmed = raw?.trim() ?? "";
  if (trimmed === "") return { minutes: DEFAULT_START_MINUTES, error: null };
  if (!START_TIME_PATTERN.test(trimmed)) {
    return {
      minutes: DEFAULT_START_MINUTES,
      error: `invalid GITS_PROPOSAL_SWEEP_START_HHMM ${JSON.stringify(raw)}; using 20:00`,
    };
  }
  return {
    minutes:
      Number.parseInt(trimmed.slice(0, 2), 10) * 60 + Number.parseInt(trimmed.slice(3, 5), 10),
    error: null,
  };
}

const PersistedState = Schema.Struct({
  version: Schema.Literal(1),
  lastSweepNightKey: Schema.NullOr(Schema.String),
});
type PersistedState = typeof PersistedState.Type;
const decodePersistedState = Schema.decodeUnknownEffect(Schema.fromJsonString(PersistedState));

class AutomodeProposalSweepStateError extends Schema.TaggedErrorClass<AutomodeProposalSweepStateError>()(
  "AutomodeProposalSweepStateError",
  { message: Schema.String },
) {}

const emptyState: PersistedState = { version: 1, lastSweepNightKey: null };

function loadState(statePath: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs.exists(statePath);
    if (!exists) return emptyState;
    const raw = yield* fs.readFileString(statePath);
    if (raw.trim() === "") {
      return yield* Effect.fail(
        new AutomodeProposalSweepStateError({ message: "Proposal sweep state is empty." }),
      );
    }
    return yield* decodePersistedState(raw).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("gits.sweep.state-invalid", { cause: Cause.pretty(cause) }).pipe(
          Effect.andThen(
            Effect.fail(
              new AutomodeProposalSweepStateError({ message: "Proposal sweep state is invalid." }),
            ),
          ),
        ),
      ),
    );
  });
}

function persistState(statePath: string, state: PersistedState) {
  return writeFileStringAtomically({
    filePath: statePath,
    contents: `${JSON.stringify(state, null, 2)}\n`,
  });
}

export const AutomodeProposalSweepLive = Layer.effect(
  AutomodeProposalSweep,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const supervisor = yield* AutomodeSupervisor;
    const hermes = yield* HermesAdapter;
    const ledger = yield* AutomodeEpisodeLedger;
    const notifier = yield* HermesTelegramNotifier;
    const parsedStart = parseStartMinutes(process.env.GITS_PROPOSAL_SWEEP_START_HHMM);
    if (parsedStart.error !== null) {
      yield* Effect.logWarning("gits.sweep.start-invalid", { detail: parsedStart.error });
    }
    const startMinutes = parsedStart.minutes;
    const statePath = path.join(config.stateDir, "gits", STATE_FILE_NAME);
    const stateRef = yield* Ref.make(yield* loadState(statePath));
    const semaphore = yield* Semaphore.make(1);

    // Propose to ONE repo: skip it if a goal is already live for it (dedup BEFORE the codex
    // spend), then spawn Hermes, approve the card, draft it, and enqueue the drafted
    // delamain-peer as a queued goal carrying the card's episodeId. A failure here is
    // logged and swallowed so the sweep continues to the next repo. Returns the enqueued
    // goal (null on any skip/failure) so the caller can gate approval and notify.
    const sweepRepo = (repo: string): Effect.Effect<AutomodeGoal | null> =>
      Effect.gen(function* () {
        // Dedup by repo, ahead of hermes: a fresh inspect always mints a new episodeId, so
        // episode dedup could never fire here. A repo whose prior-night sweep or cockpit
        // approve is still live (operator away) must not get another goal + codex burn.
        const snapshot = yield* supervisor.getSnapshot();
        if (hasLiveGoalForRepo(snapshot.goals, repo)) {
          yield* Effect.logInfo("gits.sweep.dedup-skipped", { repo });
          return null;
        }
        // Feedback loop: fold the repo's recent ledger outcomes into the proposal prompt so
        // Hermes doesn't blindly repeat an idea that already ran, landed, or got flagged.
        const episodes = yield* ledger.list_episodes({ repo, limit: 5 });
        const outcomesSection =
          episodes.length === 0
            ? undefined
            : [
                "Recent automode outcomes for this repo:",
                ...episodes.map(
                  (episode) =>
                    `- ${episode.goalTitle}: ${episode.verdict}${episode.flagged ? " (flagged)" : ""}`,
                ),
              ].join("\n");
        // "worktree-spawn" makes the card actionable: a read-only inspect card can only ever
        // draft as "verification", never "delamain-peer" (draftKindFor keys on actionKind).
        const card = yield* hermes.inspectGitsAndPropose({
          projectDir: repo,
          actionKind: "worktree-spawn",
          ...(outcomesSection === undefined ? {} : { prompt: outcomesSection }),
        });
        if (card.status === "blocked" || card.projectDir === null) {
          yield* Effect.logInfo("gits.sweep.card-skipped", {
            repo,
            status: card.status,
            blockedReason: card.blockedReason,
          });
          return null;
        }
        // Approve before drafting — mirrors the approve bridge's decide→draft order.
        // draftFromProposal blocks any card whose status !== "approved".
        yield* hermes.decideProposal({ proposalId: card.id, decision: "approve" });
        const draft = yield* hermes.draftFromProposal({ proposalId: card.id });
        if (draft.kind !== "delamain-peer" || draft.status !== "draft" || draft.repo === null) {
          yield* Effect.logInfo("gits.sweep.draft-skipped", {
            repo,
            kind: draft.kind,
            status: draft.status,
          });
          return null;
        }
        const enqueued = yield* supervisor.enqueueGoal({
          title: draft.title,
          prompt: draft.prompt,
          repo: draft.repo,
          episodeId: card.episodeId,
          origin: "sweep",
        });
        // enqueueGoal prepends the new goal, so it's always the freshest entry.
        return enqueued.goals[0] ?? null;
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("gits.sweep.repo-failed", { repo, cause: Cause.pretty(cause) }).pipe(
            Effect.as(null),
          ),
        ),
      );

    const tick = () =>
      semaphore.withPermits(1)(
        Effect.gen(function* () {
          const now = london_instant(yield* Clock.currentTimeMillis);
          const state = yield* Ref.get(stateRef);
          // Once per night: fire on the first tick at/after the dinner start; a late boot
          // (e.g. 23:00) still sweeps for this night, guarded by the persisted night key.
          if (now.minutesOfDay < startMinutes || state.lastSweepNightKey === now.dateKey) {
            return;
          }
          const policy = yield* supervisor.getPolicy();
          if (
            !policy.nightlyProposalSweep ||
            policy.mode !== "autonomous" ||
            policy.proposalRepos.length === 0
          ) {
            return;
          }
          // Mark the night done BEFORE proposing: a mid-sweep crash must not re-run every
          // tick (hermes shares scarce codex capacity). The operator retries next night.
          const next: PersistedState = { ...state, lastSweepNightKey: now.dateKey };
          yield* persistState(statePath, next).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
          );
          yield* Ref.set(stateRef, next);
          // Sequential: hermes invocations share codex capacity — never parallelise.
          const newGoals: AutomodeGoal[] = [];
          for (const repo of policy.proposalRepos) {
            if (!repoAllowed(policy, repo)) {
              yield* Effect.logWarning("gits.sweep.repo-not-allowed", { repo });
              continue;
            }
            const goal = yield* sweepRepo(repo);
            if (goal === null) continue;
            newGoals.push(goal);
            if (policy.sweepRequiresConfirmation) {
              // Parks the goal at waiting-approval via the shared dispatch-time approval gate:
              // the goal carries origin "sweep" (enqueued above), and goalNeedsApproval in
              // AutomodeSupervisor.ts treats sweep + sweepRequiresConfirmation as needing
              // approval independent of requireApprovalForPeerSpawn.
              yield* supervisor.dispatchGoal({ goalId: goal.id }).pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("gits.sweep.confirm-gate-failed", {
                    goalId: goal.id,
                    cause: Cause.pretty(cause),
                  }),
                ),
              );
            }
          }
          if (newGoals.length > 0) {
            const goalLines = newGoals.map(
              (goal) => `${goal.title} — ${path.basename(goal.repo)} [${goal.id}]`,
            );
            // The reply hint must reflect reality: with confirmation off, goals are already
            // queued for autonomous dispatch — APPROVE/REJECT would be a false gate; STOP is
            // the only real control.
            const text = policy.sweepRequiresConfirmation
              ? ["New goals from tonight's sweep:", ...goalLines, "", REPLY_HINT].join("\n")
              : [
                  "New goals from tonight's sweep (queued for autonomous run — no confirmation required):",
                  ...goalLines,
                  "",
                  "Reply: STOP to halt automode.",
                ].join("\n");
            yield* notifier
              .notify({ subject: "GITS nightly sweep", text })
              .pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("gits.sweep.telegram-failed", { cause: Cause.pretty(cause) }),
                ),
              );
          }
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("gits.sweep.tick-failed", { cause: Cause.pretty(cause) }),
          ),
        ),
      );

    return { tick };
  }),
);
