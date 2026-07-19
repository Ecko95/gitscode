import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { writeFileStringAtomically } from "../../atomicWrite.ts";
import { ServerConfig } from "../../config.ts";
import { HermesAdapter } from "../Services/HermesAdapter.ts";
import { AutomodeProposalSweep } from "../Services/AutomodeProposalSweep.ts";
import { AutomodeSupervisor } from "../Services/AutomodeSupervisor.ts";
import { hasLiveGoalForRepo } from "./HermesAutomodeBridge.ts";
import { london_instant } from "./GitsSlotScheduler.ts";
import { repoAllowed } from "./AutomodeSupervisor.ts";

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
    // delamain-peer as a waiting-approval goal carrying the card's episodeId. A failure here
    // is logged and swallowed so the sweep continues to the next repo.
    const sweepRepo = (repo: string) =>
      Effect.gen(function* () {
        // Dedup by repo, ahead of hermes: a fresh inspect always mints a new episodeId, so
        // episode dedup could never fire here. A repo whose prior-night sweep or cockpit
        // approve is still live (operator away) must not get another goal + codex burn.
        const snapshot = yield* supervisor.getSnapshot();
        if (hasLiveGoalForRepo(snapshot.goals, repo)) {
          yield* Effect.logInfo("gits.sweep.dedup-skipped", { repo });
          return;
        }
        // "worktree-spawn" makes the card actionable: a read-only inspect card can only ever
        // draft as "verification", never "delamain-peer" (draftKindFor keys on actionKind).
        const card = yield* hermes.inspectGitsAndPropose({
          projectDir: repo,
          actionKind: "worktree-spawn",
        });
        if (card.status === "blocked" || card.projectDir === null) {
          yield* Effect.logInfo("gits.sweep.card-skipped", {
            repo,
            status: card.status,
            blockedReason: card.blockedReason,
          });
          return;
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
          return;
        }
        yield* supervisor.enqueueGoal({
          title: draft.title,
          prompt: draft.prompt,
          repo: draft.repo,
          episodeId: card.episodeId,
        });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("gits.sweep.repo-failed", { repo, cause: Cause.pretty(cause) }),
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
          for (const repo of policy.proposalRepos) {
            if (!repoAllowed(policy, repo)) {
              yield* Effect.logWarning("gits.sweep.repo-not-allowed", { repo });
              continue;
            }
            yield* sweepRepo(repo);
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
