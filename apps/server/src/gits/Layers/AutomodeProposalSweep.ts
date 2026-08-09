import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import type { AutomodeGoal, ThreadId } from "@t3tools/contracts";

import { writeFileStringAtomically } from "../../atomicWrite.ts";
import { shortGoalCode } from "../HermesTelegramCommand.ts";
import { ServerConfig } from "../../config.ts";
import { AutomodeEpisodeLedger } from "../../persistence/Services/AutomodeEpisodeLedger.ts";
import { HermesAdapter } from "../Services/HermesAdapter.ts";
import { AutomodeProposalSweep } from "../Services/AutomodeProposalSweep.ts";
import { AutomodeSupervisor } from "../Services/AutomodeSupervisor.ts";
import { CockpitInbox } from "../Services/CockpitInbox.ts";
import { HermesTelegramNotifier } from "../Services/HermesTelegramNotifier.ts";
import { AutomodeNotifications } from "./AutomodeNotifications.ts";
import { hasLiveGoalForRepo } from "./HermesAutomodeBridge.ts";
import { london_instant } from "./GitsSlotScheduler.ts";
import { repoAllowed } from "./AutomodeSupervisor.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";

const STATE_FILE_NAME = "automode-proposal-sweep-state.json";
const DEFAULT_START_MINUTES = 20 * 60; // 20:00 London dinner window.
const START_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export function selectContinuationsByRepo(readModel: {
  readonly projects: ReadonlyArray<{ readonly id: string; readonly workspaceRoot: string }>;
  readonly threads: ReadonlyArray<{
    readonly id: ThreadId;
    readonly projectId: string;
    readonly title: string;
    readonly updatedAt: string;
    readonly archivedAt: string | null;
    readonly deletedAt: string | null;
    readonly latestTurn: { readonly state: string } | null;
    readonly proposedPlans: ReadonlyArray<{
      readonly implementedAt: string | null;
      readonly implementationThreadId: string | null;
    }>;
  }>;
}) {
  const projects = new Map(
    readModel.projects.map((project) => [project.id, project.workspaceRoot]),
  );
  const candidates = new Map<
    string,
    { readonly id: ThreadId; readonly title: string; readonly reason: string }
  >();
  for (const thread of readModel.threads.toSorted((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  )) {
    const repo = projects.get(thread.projectId);
    if (
      repo === undefined ||
      candidates.has(repo) ||
      thread.archivedAt !== null ||
      thread.deletedAt !== null
    ) {
      continue;
    }
    const pendingPlan = thread.proposedPlans.some(
      (plan) => plan.implementedAt === null && plan.implementationThreadId === null,
    );
    const interrupted =
      thread.latestTurn?.state === "interrupted" || thread.latestTurn?.state === "error";
    if (pendingPlan || interrupted) {
      candidates.set(repo, {
        id: thread.id,
        title: thread.title,
        reason: pendingPlan
          ? "an accepted plan remains unimplemented"
          : "the last turn did not complete",
      });
    }
  }
  return candidates;
}

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
    const notifications = yield* AutomodeNotifications;
    const inbox = yield* CockpitInbox;
    const projection = yield* ProjectionSnapshotQuery;
    const parsedStart = parseStartMinutes(process.env.GITS_PROPOSAL_SWEEP_START_HHMM);
    if (parsedStart.error !== null) {
      yield* Effect.logWarning("gits.sweep.start-invalid", { detail: parsedStart.error });
    }
    const startMinutes = parsedStart.minutes;
    const statePath = path.join(config.stateDir, "gits", STATE_FILE_NAME);
    const stateRef = yield* Ref.make(yield* loadState(statePath));
    const semaphore = yield* Semaphore.make(1);

    const sweepRepo = (
      repo: string,
      continuation?: { readonly id: ThreadId; readonly title: string; readonly reason: string },
    ): Effect.Effect<{ readonly proposed: boolean; readonly goal: AutomodeGoal | null }> =>
      Effect.gen(function* () {
        // Dedup by repo, ahead of hermes: a fresh inspect always mints a new episodeId, so
        // episode dedup could never fire here. A repo whose prior-night sweep or cockpit
        // approve is still live (operator away) must not get another goal + codex burn.
        const snapshot = yield* supervisor.getSnapshot();
        if (hasLiveGoalForRepo(snapshot.goals, repo)) {
          yield* Effect.logInfo("gits.sweep.dedup-skipped", { repo });
          return { proposed: false, goal: null };
        }
        // Feedback loop: fold the repo's recent ledger outcomes into the proposal prompt so
        // Hermes doesn't blindly repeat an idea that already ran, landed, or got flagged.
        const episodes = yield* ledger.list_episodes({ repo, limit: 5 });
        const promptSections = [
          ...(episodes.length === 0
            ? []
            : [
                [
                  "Recent automode outcomes for this repo:",
                  ...episodes.map(
                    (episode) =>
                      `- ${episode.goalTitle}: ${episode.verdict}${episode.flagged ? " (flagged)" : ""}`,
                  ),
                ].join("\n"),
              ]),
          ...(continuation === undefined
            ? []
            : [
                `Unfinished past thread ${continuation.id} (${continuation.title}): ${continuation.reason}. Propose the smallest safe continuation if it is still relevant.`,
              ]),
        ];
        // "worktree-spawn" makes the card actionable: a read-only inspect card can only ever
        // draft as "verification", never "delamain-peer" (draftKindFor keys on actionKind).
        const card = yield* hermes.inspectGitsAndPropose({
          projectDir: repo,
          actionKind: "worktree-spawn",
          ...(promptSections.length === 0 ? {} : { prompt: promptSections.join("\n\n") }),
          ...(continuation === undefined ? {} : { sourceThreadId: continuation.id }),
        });
        const eventKey = `proposal:${card.id}:created`;
        yield* inbox.record({
          episodeId: card.episodeId,
          proposalId: card.id,
          goalId: null,
          title: card.title,
          repository: card.projectDir,
          eventKey,
          state: "pending-review",
          reason: "Proposal ready for review.",
          deepLink: `/gits?panel=autopilot&proposal=${encodeURIComponent(card.id)}`,
        });
        yield* notifications.notify({
          key: eventKey,
          subject: "New Motoko proposal",
          text: `${card.title} — ${path.basename(repo)}`,
          url: `/gits?panel=autopilot&proposal=${encodeURIComponent(card.id)}`,
          gitsEnabled: snapshot.policy.gitsNotificationsEnabled,
          telegramEnabled: snapshot.policy.telegramNotificationsEnabled,
        });
        if (card.status === "blocked" || card.projectDir === null) {
          yield* Effect.logInfo("gits.sweep.card-skipped", {
            repo,
            status: card.status,
            blockedReason: card.blockedReason,
          });
          return { proposed: false, goal: null };
        }
        // A review-required sweep stops at the proposal. The cockpit approval bridge owns
        // decide -> draft -> enqueue, so edits are applied before any runnable goal exists.
        if (snapshot.policy.sweepRequiresConfirmation) {
          return { proposed: true, goal: null };
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
          return { proposed: false, goal: null };
        }
        const enqueued = yield* supervisor.enqueueGoal({
          title: draft.title,
          prompt: draft.prompt,
          repo: draft.repo,
          episodeId: card.episodeId,
          origin: "sweep",
        });
        // enqueueGoal prepends the new goal, so it's always the freshest entry.
        return { proposed: true, goal: enqueued.goals[0] ?? null };
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("gits.sweep.repo-failed", { repo, cause: Cause.pretty(cause) }).pipe(
            Effect.as({ proposed: false, goal: null }),
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
          let proposalCount = 0;
          let attemptedRepos = 0;
          const readModel = yield* projection.getSnapshot().pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("gits.sweep.continuations-unavailable", {
                cause: Cause.pretty(cause),
              }).pipe(Effect.as(null)),
            ),
          );
          const continuationByRepo =
            readModel === null ? new Map() : selectContinuationsByRepo(readModel);
          for (const repo of policy.proposalRepos) {
            if (!repoAllowed(policy, repo)) {
              yield* Effect.logWarning("gits.sweep.repo-not-allowed", { repo });
              continue;
            }
            attemptedRepos += 1;
            const { proposed, goal } = yield* sweepRepo(repo, continuationByRepo.get(repo));
            if (proposed) proposalCount += 1;
            if (goal === null) continue;
            newGoals.push(goal);
          }
          if (attemptedRepos > 0 && proposalCount === 0) {
            // A sweep night is consumed up front, so a silent zero-goal run means the owner
            // waits a whole day without knowing anything went wrong. Always say so.
            // ponytail: generic message; per-repo reasons live in the gits.sweep.* logs.
            yield* notifier
              .notify({
                subject: "GITS nightly sweep",
                text: `Sweep ran for ${attemptedRepos} repo(s) but drafted no goals. Check the cockpit logs (gits.sweep.*) for reasons.`,
              })
              .pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("gits.sweep.telegram-failed", { cause: Cause.pretty(cause) }),
                ),
              );
          }
          if (newGoals.length > 0) {
            const goalLines = newGoals.map(
              (goal) => `${goal.title} — ${path.basename(goal.repo)} [${shortGoalCode(goal.id)}]`,
            );
            // The reply hint must reflect reality: with confirmation off, goals are already
            // queued for autonomous dispatch — APPROVE/REJECT would be a false gate; STOP is
            // the only real control.
            const text = [
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
