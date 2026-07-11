/**
 * Graveyard reaper — age-based sweep over adopted orphan worktrees (plan 21, W2.4).
 *
 * Runs on a 1-hour interval. For each adopted worktree older than
 * GITS_GRAVEYARD_MAX_AGE_MS (default 7 days):
 *
 *   REBINDING GUARD (evaluated immediately before pruning) — two layers:
 *
 *   Layer 1 — event-store (covers post-W2.5 worktrees with owner-recorded events):
 *   - If a `worktree.owner-recorded` event exists for the path AND no
 *     `thread.deleted` event exists for the owning thread, the worktree is
 *     rebound to a live (or archived-but-not-deleted) thread. Skip without
 *     emitting anything (log graveyard.reaper.skip-rebound).
 *   - Archived-but-not-deleted threads BLOCK pruning — parked work stays on
 *     disk. `thread.deleted` is the only signal that frees the worktree.
 *
 *   Layer 2 — projection DB (final guard for every candidate):
 *   - Check whether any non-deleted thread still has this worktree_path. If yes →
 *     BLOCK (skip-rebound), including when a deleted historical owner has a live fork.
 *   - Uses ProjectionSnapshotQuery.hasLiveThreadForWorktreePath which queries
 *     `projection_threads WHERE worktree_path = ? AND deleted_at IS NULL`.
 *   - ARCHIVED threads block because deleted_at IS NULL covers them.
 *
 *   PRUNE (only when both guard layers pass):
 *   1. captureCheckpoint (raw git ref, no active turn needed — plan 21 Contradiction #1)
 *   2. removeWorktree (force: true — adopted orphans are likely dirty)
 *   3. Emit worktree.buried (trigger: "reaper", finalCheckpointRef from step 1)
 *
 *   Failure modes:
 *   - captureCheckpoint fails → skip removal and retry next sweep
 *   - removeWorktree fails → warn, NO buried event, retry next sweep
 *   - hasLiveThreadForWorktreePath fails → warn, skip (fail-safe: don't prune on error)
 *
 * Layer 1 event-store check is preferred for post-W2.5 worktrees.
 * Layer 2 DB check is the safety net for production worktrees created before W2.5.
 */
// @effect-diagnostics globalDate:off

import * as Crypto from "effect/Crypto";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { CommandId, ThreadId } from "@t3tools/contracts";
import type { CheckpointRef, OrchestrationEvent } from "@t3tools/contracts";

import { ServerConfig } from "../config.ts";
import { CheckpointStore } from "../checkpointing/Services/CheckpointStore.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { GitVcsDriver } from "./GitVcsDriver.ts";
import { graveyardCheckpointRef } from "./WorktreeGraveyardRetirement.ts";

// ponytail: 1h sweep interval hard-coded — YAGNI, add knob if ops needs tuning
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Sentinel used when an adopted orphan has no owner record
const ORPHAN_REAPER_THREAD_ID = ThreadId.make("__graveyard_reaper__");

export interface GraveyardReaperShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class GraveyardReaper extends Context.Service<GraveyardReaper, GraveyardReaperShape>()(
  "t3/vcs/GraveyardReaper",
) {}

// -- rebinding guard helpers (pure, no I/O) --

/**
 * Resolve the owning threadId for a worktree path from event history.
 * Returns null if no `worktree.owner-recorded` event exists for the path.
 */
function getOwnerThreadId(
  worktreePath: string,
  events: ReadonlyArray<OrchestrationEvent>,
): string | null {
  for (const ev of events) {
    if (ev.type === "worktree.owner-recorded") {
      const p = ev.payload as Record<string, unknown>;
      if (p["worktreePath"] === worktreePath && typeof p["threadId"] === "string") {
        return p["threadId"];
      }
    }
  }
  return null;
}

/**
 * Returns true when the worktree is STILL unbound (safe to prune).
 * Returns false if a live or archived-but-not-deleted thread owns the path.
 *
 * Guard logic (event-store only, no DB):
 *   1. Find `worktree.owner-recorded` for path → ownerThreadId
 *   2. If no owner → pure orphan → unbound (true)
 *   3. If owner → check for `thread.deleted` event with matching threadId
 *   4. No `thread.deleted` → thread alive or archived → BLOCK (false)
 *   5. `thread.deleted` present → thread deleted → unbound (true)
 *
 * Correctly blocks archived threads: `thread.archived` ≠ `thread.deleted`.
 * A thread only unblocks the guard after it is explicitly deleted.
 */
export function isStillUnbound(
  worktreePath: string,
  events: ReadonlyArray<OrchestrationEvent>,
): boolean {
  const ownerThreadId = getOwnerThreadId(worktreePath, events);
  if (ownerThreadId === null) {
    return true; // pure orphan — no owner record
  }

  for (const ev of events) {
    if (ev.type === "thread.deleted") {
      const p = ev.payload as Record<string, unknown>;
      if (p["threadId"] === ownerThreadId) {
        return true; // owner deleted → unbound
      }
    }
  }

  // Owner exists and was NOT deleted → thread alive or archived → BLOCK
  return false;
}

// -- sweep implementation --
// Exported for testing without the Schedule wrapper.

/**
 * Service dependencies for the sweep effect.
 * Separate type so runSweepOnce can have a matching R channel.
 */
type SweepDeps =
  | OrchestrationEngineService
  | CheckpointStore
  | GitVcsDriver
  | ServerConfig
  | FileSystem.FileSystem
  | Crypto.Crypto
  | ProjectionSnapshotQuery;

// ponytail: no explicit type annotation — let TypeScript infer the R channel from services used;
// the test harness provides matching layers.
export const runSweepOnce = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const checkpointStore = yield* CheckpointStore;
  const gitDriver = yield* GitVcsDriver;
  const serverConfig = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const projectionQuery = yield* ProjectionSnapshotQuery;

  // ponytail: read env var each sweep call so tests can override between runs
  const maxAgeMs: number =
    typeof process.env["GITS_GRAVEYARD_MAX_AGE_MS"] === "string"
      ? Math.max(1, parseInt(process.env["GITS_GRAVEYARD_MAX_AGE_MS"], 10) || DEFAULT_MAX_AGE_MS)
      : DEFAULT_MAX_AGE_MS;

  const now = yield* Clock.currentTimeMillis;

  // Load entire event store once per sweep (in-memory scan — adopted set is small)
  const allEvents: ReadonlyArray<OrchestrationEvent> = yield* Stream.runCollect(
    engine.readEvents(0),
  ).pipe(
    Effect.map((chunk) => Array.from(chunk) as OrchestrationEvent[]),
    Effect.catch((_err) =>
      Effect.logWarning("graveyard.reaper.event-read-failed").pipe(
        Effect.as([] as OrchestrationEvent[]),
      ),
    ),
  );

  // Collect adopted entries
  const adopted: Array<{ worktreePath: string; branch: string | null; adoptedAt: string }> = [];
  for (const ev of allEvents) {
    if (ev.type === "worktree.adopted") {
      const p = ev.payload as Record<string, unknown>;
      if (typeof p["worktreePath"] === "string" && typeof p["adoptedAt"] === "string") {
        adopted.push({
          worktreePath: p["worktreePath"],
          branch: typeof p["branch"] === "string" ? p["branch"] : null,
          adoptedAt: p["adoptedAt"],
        });
      }
    }
  }

  // Track already-buried paths to avoid re-processing
  const buriedPaths = new Set<string>();
  for (const ev of allEvents) {
    if (ev.type === "worktree.buried") {
      const p = ev.payload as Record<string, unknown>;
      if (typeof p["worktreePath"] === "string") {
        buriedPaths.add(p["worktreePath"]);
      }
    }
  }

  let prunedCount = 0;

  for (const entry of adopted) {
    const { worktreePath, branch } = entry;

    if (buriedPaths.has(worktreePath)) continue;

    const adoptedMs = Date.parse(entry.adoptedAt);
    if (Number.isNaN(adoptedMs) || now - adoptedMs <= maxAgeMs) continue;

    // REBINDING GUARD — event history can prove an owner is still active.
    if (!isStillUnbound(worktreePath, allEvents)) {
      yield* Effect.logInfo("graveyard.reaper.skip-rebound", { worktreePath });
      continue;
    }

    // Final liveness guard: always consult the projection immediately before destructive
    // work. Forks share the source thread's path, so a deleted historical owner does not
    // prove the path is unbound while another live thread still references it.
    // Fail-safe: treat query errors as "live thread present" (don't prune on uncertainty).
    const projBound: boolean = yield* projectionQuery
      .hasLiveThreadForWorktreePath(worktreePath)
      .pipe(
        Effect.catch((_err) =>
          Effect.logWarning("graveyard.reaper.projection-check-failed", { worktreePath }).pipe(
            Effect.as(true), // fail-safe: assume bound
          ),
        ),
      );
    if (projBound) {
      yield* Effect.logInfo("graveyard.reaper.skip-rebound", { worktreePath });
      continue;
    }

    // Disk presence check (may have been removed externally)
    const exists: boolean = yield* fs.stat(worktreePath).pipe(
      Effect.map((_stat) => true),
      Effect.catch((_err) => Effect.succeed(false)),
    );
    if (!exists) {
      yield* Effect.logInfo("graveyard.reaper.skip-already-gone", { worktreePath });
      continue;
    }

    // Step 1: capture raw checkpoint ref. A failed capture leaves the worktree
    // untouched so a later sweep can retry without risking uncheckpointed data.
    const checkpointRef = graveyardCheckpointRef(worktreePath);
    const capturedRef: CheckpointRef | null = yield* checkpointStore
      .captureCheckpoint({ cwd: worktreePath, checkpointRef })
      .pipe(
        Effect.as<CheckpointRef | null>(checkpointRef),
        Effect.catch((_err) =>
          Effect.logWarning("worktree.retirement.checkpoint-failed", { worktreePath }).pipe(
            Effect.as<CheckpointRef | null>(null),
          ),
        ),
      );
    if (capturedRef === null) {
      continue;
    }

    // Step 2: remove worktree (force: true — orphans are likely dirty)
    const removed: boolean = yield* gitDriver
      .removeWorktree({ cwd: serverConfig.worktreesDir, path: worktreePath, force: true })
      .pipe(
        Effect.as(true),
        Effect.catch((_err) =>
          Effect.logWarning("graveyard.reaper.prune-failed", { worktreePath }).pipe(
            Effect.as(false),
          ),
        ),
      );

    if (!removed) {
      // No buried event — sweep retries next interval (plan 21 §W2.4 step 3)
      continue;
    }

    // Step 3: emit worktree.buried — this IS the disk-removal record
    const buriedAt = DateTime.formatIso(yield* DateTime.now);
    const uuid = yield* crypto.randomUUIDv4;
    const commandId = CommandId.make(`server:worktree-reaper-bury:${uuid}`);

    // Use actual owner threadId if available; fall back to reaper sentinel
    const ownerThreadId = getOwnerThreadId(worktreePath, allEvents);
    const threadId: ThreadId =
      ownerThreadId !== null ? ThreadId.make(ownerThreadId) : ORPHAN_REAPER_THREAD_ID;

    yield* engine
      .dispatch(
        {
          type: "worktree.bury",
          commandId,
          threadId,
          worktreePath,
          branch,
          trigger: "reaper",
          finalCheckpointRef: capturedRef,
          buriedAt,
        },
        "server",
      )
      .pipe(
        // The worktree is already removed at this point — a lost burial event is a
        // silent disk removal, which the graveyard design forbids. Never swallow it.
        Effect.catch((error) =>
          Effect.logWarning("graveyard.reaper.bury-dispatch-failed", { worktreePath, error }),
        ),
      );

    yield* Effect.logInfo("graveyard.reaper.buried", {
      worktreePath,
      finalCheckpointRef: capturedRef,
    });

    prunedCount += 1;
  }

  if (prunedCount > 0) {
    yield* Effect.logInfo("graveyard.reaper.sweep-complete", {
      prunedCount,
      totalAdopted: adopted.length,
    });
  }
});

// -- layer --

export const GraveyardReaperLive: Layer.Layer<
  GraveyardReaper,
  never,
  | OrchestrationEngineService
  | CheckpointStore
  | GitVcsDriver
  | ServerConfig
  | FileSystem.FileSystem
  | Crypto.Crypto
  | ProjectionSnapshotQuery
> = Layer.effect(
  GraveyardReaper,
  Effect.gen(function* () {
    // Capture service shapes once at layer construction; start() closes over them.
    // This matches the GraveyardOrphanAdopter pattern (R=never on start's return).
    const engine = yield* OrchestrationEngineService;
    const checkpointStore = yield* CheckpointStore;
    const gitDriver = yield* GitVcsDriver;
    const serverConfig = yield* ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const crypto = yield* Crypto.Crypto;
    const projectionQuery = yield* ProjectionSnapshotQuery;

    // ponytail: read env var at construction — single knob, never changes at runtime
    const maxAgeMs: number =
      typeof process.env["GITS_GRAVEYARD_MAX_AGE_MS"] === "string"
        ? Math.max(1, parseInt(process.env["GITS_GRAVEYARD_MAX_AGE_MS"], 10) || DEFAULT_MAX_AGE_MS)
        : DEFAULT_MAX_AGE_MS;

    const capturedLayer = Layer.mergeAll(
      Layer.succeed(OrchestrationEngineService, engine),
      Layer.succeed(CheckpointStore, checkpointStore),
      Layer.succeed(GitVcsDriver, gitDriver),
      Layer.succeed(ServerConfig, serverConfig),
      Layer.succeed(FileSystem.FileSystem, fs),
      Layer.succeed(Crypto.Crypto, crypto),
      Layer.succeed(ProjectionSnapshotQuery, projectionQuery),
    );

    const start = (): Effect.Effect<void, never, Scope.Scope> =>
      Effect.gen(function* () {
        yield* Effect.forkScoped(
          runSweepOnce.pipe(
            Effect.provide(capturedLayer),
            Effect.catch((error: unknown) =>
              Effect.logWarning("graveyard.reaper.sweep-failed", { error }),
            ),
            Effect.catchDefect((defect: unknown) =>
              Effect.logWarning("graveyard.reaper.sweep-defect", { defect }),
            ),
            Effect.repeat(Schedule.spaced(Duration.millis(SWEEP_INTERVAL_MS))),
          ),
        );

        yield* Effect.logInfo("graveyard.reaper.started", {
          maxAgeMs,
          sweepIntervalMs: SWEEP_INTERVAL_MS,
        });
      });

    return { start } satisfies GraveyardReaperShape;
  }),
);
