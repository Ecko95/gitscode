/**
 * InactivityReapRetirementReactor — periodic sweep that retires worktrees
 * for inactivity-reaped provider sessions (plan 21, W2.2b).
 *
 * After ProviderSessionReaper stops an idle session (trigger: inactivity_threshold),
 * the session's status in ProviderSessionDirectory becomes "stopped". This reactor
 * periodically scans those stopped sessions and retires their worktrees with
 * trigger "inactivity-reap" if retirement has not already started.
 *
 * Sweep logic per stopped session:
 *   1. getThreadWorktreeInfo — if no worktreePath, skip (non-worktree thread).
 *   2. Scan event store for worktree.retiring-started or worktree.buried for that
 *      path — if found, skip (already handled by ThreadDeletionReactor or a prior sweep).
 *   3. getThreadShellById — if absent/deleted (None), skip (ThreadDeletionReactor owns that).
 *   3b. Inactivity-age guard: retire only if thread has been inactive longer than
 *       INACTIVITY_AGE_THRESHOLD_MS (matches ProviderSessionReaper's threshold).
 *       Activity anchor = latestUserMessageAt ?? createdAt (null latestUserMessageAt
 *       means no user messages yet → treat thread age as inactivity age).
 *       This protects sessions stopped via crash or manual stop from being retired
 *       while the user is still active.
 *   4. retire with trigger "inactivity-reap".
 *
 * Failure modes follow retireWorktree's existing semantics (checkpoint fail → null ref,
 * removeWorktree fail → retiring-started stays as recovery marker).
 *
 * Lives at RuntimeDependenciesLive level (alongside GraveyardOrphanAdopter and
 * GraveyardReaper) so all retirement service deps are available without cascading
 * ProviderRuntimeLayerLive's R type.
 */
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { OrchestrationEvent } from "@t3tools/contracts";
import type { ProviderRuntimeBindingWithMetadata } from "../provider/Services/ProviderSessionDirectory.ts";

import { CheckpointStore } from "../checkpointing/Services/CheckpointStore.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { RuntimeReceiptBus } from "../orchestration/Services/RuntimeReceiptBus.ts";
import type { ProviderSessionDirectoryShape } from "../provider/Services/ProviderSessionDirectory.ts";
import { ProviderSessionDirectory } from "../provider/Services/ProviderSessionDirectory.ts";
import { GitVcsDriver } from "./GitVcsDriver.ts";
import { retireWorktree } from "./WorktreeGraveyardRetirement.ts";

// ponytail: same interval as ProviderSessionReaper's sweep — no config knob needed
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

// ponytail: mirrors ProviderSessionReaper's DEFAULT_INACTIVITY_THRESHOLD_MS (30 min).
// That constant is private to its layer to avoid an R-type cascade; shared constant
// here is the next-simplest option. Promote to a shared module if the value ever diverges.
const INACTIVITY_AGE_THRESHOLD_MS = 30 * 60 * 1000;

export interface InactivityReapRetirementReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class InactivityReapRetirementReactor extends Context.Service<
  InactivityReapRetirementReactor,
  InactivityReapRetirementReactorShape
>()("t3/vcs/InactivityReapRetirementReactor") {}

function hasRetirementEvent(
  worktreePath: string,
  events: ReadonlyArray<OrchestrationEvent>,
): boolean {
  for (const ev of events) {
    if (ev.type === "worktree.retiring-started" || ev.type === "worktree.buried") {
      const p = ev.payload as Record<string, unknown>;
      if (p["worktreePath"] === worktreePath) return true;
    }
  }
  return false;
}

type SweepDeps =
  | OrchestrationEngineService
  | CheckpointStore
  | GitVcsDriver
  | RuntimeReceiptBus
  | Crypto.Crypto
  | ProviderSessionDirectory
  | ProjectionSnapshotQuery;

// Exported for unit testing without the Schedule wrapper (same pattern as GraveyardReaper).
export const runSweepOnce = Effect.gen(function* () {
  const engine: OrchestrationEngineShape = yield* OrchestrationEngineService;
  const directory: ProviderSessionDirectoryShape = yield* ProviderSessionDirectory;
  const projectionQuery: ProjectionSnapshotQueryShape = yield* ProjectionSnapshotQuery;
  const now: number = yield* Clock.currentTimeMillis;

  const bindings: ReadonlyArray<ProviderRuntimeBindingWithMetadata> = yield* directory
    .listBindings()
    .pipe(
      Effect.catch((_err) =>
        Effect.logWarning("inactivity-reap-retirement.sweep.list-failed").pipe(
          Effect.as([] as ReadonlyArray<ProviderRuntimeBindingWithMetadata>),
        ),
      ),
    );

  const stopped = bindings.filter((b) => b.status === "stopped");
  if (stopped.length === 0) return;

  // Load event store once per sweep to check retirement status.
  const allEvents: ReadonlyArray<OrchestrationEvent> = yield* Stream.runCollect(
    engine.readEvents(0),
  ).pipe(
    Effect.map((chunk) => Array.from(chunk) as OrchestrationEvent[]),
    Effect.catch((_err) =>
      Effect.logWarning("inactivity-reap-retirement.sweep.event-read-failed").pipe(
        Effect.as([] as OrchestrationEvent[]),
      ),
    ),
  );

  let retiredCount = 0;

  for (const binding of stopped) {
    const { threadId } = binding;

    // Step 1: get worktree info — skip non-worktree threads
    const worktreeInfo = yield* projectionQuery.getThreadWorktreeInfo(threadId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.catch((_err) => Effect.succeed(undefined)),
    );
    if (!worktreeInfo?.worktreePath) continue;

    const { worktreePath } = worktreeInfo;

    // Step 2: skip if retirement already started or completed
    if (hasRetirementEvent(worktreePath, allEvents)) continue;

    // Step 3: skip if thread is deleted — ThreadDeletionReactor owns that case
    const shell = yield* projectionQuery
      .getThreadShellById(threadId)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isNone(shell)) continue;

    // Step 3b: inactivity-age guard — retire only if the thread has actually been
    // inactive long enough. A "stopped" binding can result from a crash or manual
    // stop, not just inactivity reaping; without this guard we'd retire worktrees
    // for users who are still active.
    //
    // Activity anchor: latestUserMessageAt if present, else createdAt (no messages
    // yet → the thread's own age is the best proxy for inactivity).
    const { latestUserMessageAt, createdAt } = shell.value;
    const activityAnchor = latestUserMessageAt ?? createdAt;
    const anchorMs = Date.parse(activityAnchor);
    const inactivityMs = now - anchorMs;
    if (Number.isNaN(anchorMs) || inactivityMs < INACTIVITY_AGE_THRESHOLD_MS) {
      yield* Effect.logDebug("inactivity-reap-retirement.skipped-recent-activity", {
        threadId,
        worktreePath,
        inactivityMs,
        thresholdMs: INACTIVITY_AGE_THRESHOLD_MS,
      });
      continue;
    }

    // Step 4: retire
    yield* Effect.logInfo("inactivity-reap-retirement.retiring", {
      threadId,
      worktreePath,
    });

    yield* retireWorktree({
      threadId,
      worktreePath,
      branch: worktreeInfo.branch,
      repoRoot: worktreeInfo.projectWorkspaceRoot ?? worktreePath,
      trigger: "inactivity-reap",
    }).pipe(
      Effect.catchCause((_cause) =>
        Effect.logWarning("inactivity-reap-retirement.retire-failed", {
          threadId,
          worktreePath,
        }),
      ),
    );

    retiredCount += 1;
  }

  if (retiredCount > 0) {
    yield* Effect.logInfo("inactivity-reap-retirement.sweep-complete", {
      retiredCount,
      totalStopped: stopped.length,
    });
  }
});

export const InactivityReapRetirementReactorLive: Layer.Layer<
  InactivityReapRetirementReactor,
  never,
  SweepDeps
> = Layer.effect(
  InactivityReapRetirementReactor,
  Effect.gen(function* () {
    // Capture all service shapes at construction time (plan 21 W2.2b).
    // capturedLayer closes over captured shapes → start() R = never.
    // Clock is NOT captured: Clock.currentTimeMillis is Effect<number, never, never>
    // and uses the fiber's built-in clock — no explicit provision needed.
    const engine = yield* OrchestrationEngineService;
    const checkpointStore = yield* CheckpointStore;
    const gitDriver = yield* GitVcsDriver;
    const receiptBus = yield* RuntimeReceiptBus;
    const crypto = yield* Crypto.Crypto;
    const directory = yield* ProviderSessionDirectory;
    const projectionQuery = yield* ProjectionSnapshotQuery;

    const capturedLayer = Layer.mergeAll(
      Layer.succeed(OrchestrationEngineService, engine),
      Layer.succeed(CheckpointStore, checkpointStore),
      Layer.succeed(GitVcsDriver, gitDriver),
      Layer.succeed(RuntimeReceiptBus, receiptBus),
      Layer.succeed(Crypto.Crypto, crypto),
      Layer.succeed(ProviderSessionDirectory, directory),
      Layer.succeed(ProjectionSnapshotQuery, projectionQuery),
    );

    const start = (): Effect.Effect<void, never, Scope.Scope> =>
      Effect.gen(function* () {
        yield* Effect.forkScoped(
          runSweepOnce.pipe(
            Effect.provide(capturedLayer),
            Effect.catch((error: unknown) =>
              Effect.logWarning("inactivity-reap-retirement.sweep-failed", { error }),
            ),
            Effect.catchDefect((defect: unknown) =>
              Effect.logWarning("inactivity-reap-retirement.sweep-defect", { defect }),
            ),
            Effect.repeat(Schedule.spaced(Duration.millis(SWEEP_INTERVAL_MS))),
          ),
        );

        yield* Effect.logInfo("inactivity-reap-retirement.started", {
          sweepIntervalMs: SWEEP_INTERVAL_MS,
        });
      });

    return { start } satisfies InactivityReapRetirementReactorShape;
  }),
);
