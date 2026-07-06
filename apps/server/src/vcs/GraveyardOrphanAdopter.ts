/**
 * Graveyard orphan adopter — one-shot startup scan (plan 21, W2.3).
 *
 * Runs once at boot after reactors start. For every path found under worktreesDir:
 *
 *   (a) No worktree events at all → dispatch `worktree.adopt`
 *
 *   (b) `worktree.retiring-started` but no `worktree.buried`
 *       → crash-recovery: re-run retireWorktree (idempotent raw-checkpoint path)
 *
 *   (c) `worktree.buried` or `worktree.adopted` already — untouched.
 *
 *   (d) `worktree.owner-recorded` present, no retirement events:
 *       → look up owning thread in projection:
 *           thread alive (exists, not deleted) → BOUND — skip, log debug
 *           thread absent/deleted → orphan → dispatch `worktree.adopt`
 *
 * Never silently deletes. Adoption emits before any state change.
 */
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import * as Crypto from "effect/Crypto";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { CommandId, ThreadId } from "@t3tools/contracts";
import type { OrchestrationEvent } from "@t3tools/contracts";

import { ServerConfig } from "../config.ts";
import { CheckpointStore } from "../checkpointing/Services/CheckpointStore.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { RuntimeReceiptBus } from "../orchestration/Services/RuntimeReceiptBus.ts";
import { GitVcsDriver } from "./GitVcsDriver.ts";
import { retireWorktree } from "./WorktreeGraveyardRetirement.ts";

// ponytail: synthetic threadId for orphan resume — retiring-started already carries
// the real one; this sentinel only flows through retireWorktree's call signature.
const ORPHAN_THREAD_ID = ThreadId.make("__graveyard_orphan__");

interface WorktreePathInfo {
  readonly fullPath: string;
  readonly branch: string | null;
}

type WorktreePathStatus =
  | { readonly kind: "none" }
  | { readonly kind: "owner-only"; readonly threadId: typeof ThreadId.Type }
  | { readonly kind: "retiring" }
  | { readonly kind: "buried" }
  | { readonly kind: "adopted" };

function classifyEvents(events: ReadonlyArray<OrchestrationEvent>): WorktreePathStatus {
  let ownerThreadId: typeof ThreadId.Type | null = null;
  let hasRetiring = false;
  let hasBuried = false;
  let hasAdopted = false;
  for (const ev of events) {
    if (ev.type === "worktree.owner-recorded") {
      const p = ev.payload as Record<string, unknown>;
      if (typeof p["threadId"] === "string") ownerThreadId = p["threadId"] as typeof ThreadId.Type;
    } else if (ev.type === "worktree.retiring-started") hasRetiring = true;
    else if (ev.type === "worktree.buried") hasBuried = true;
    else if (ev.type === "worktree.adopted") hasAdopted = true;
  }
  if (hasBuried) return { kind: "buried" };
  if (hasAdopted) return { kind: "adopted" };
  if (hasRetiring) return { kind: "retiring" };
  if (ownerThreadId !== null) return { kind: "owner-only", threadId: ownerThreadId };
  return { kind: "none" };
}

/** Service interface — run is an Effect called once at startup. */
export interface GraveyardOrphanAdopterShape {
  // ponytail: R=never — all deps captured at Layer construction; E=never — all errors caught internally
  readonly run: Effect.Effect<void, never, never>;
}

export class GraveyardOrphanAdopter extends Context.Service<
  GraveyardOrphanAdopter,
  GraveyardOrphanAdopterShape
>()("t3/vcs/GraveyardOrphanAdopter") {}

export const GraveyardOrphanAdopterLive: Layer.Layer<
  GraveyardOrphanAdopter,
  never,
  | OrchestrationEngineService
  | CheckpointStore
  | GitVcsDriver
  | RuntimeReceiptBus
  | ProjectionSnapshotQuery
  | FileSystem.FileSystem
  | Path.Path
  | ServerConfig
  | Crypto.Crypto
> = Layer.effect(
  GraveyardOrphanAdopter,
  Effect.gen(function* () {
    // Capture all service shapes at Layer construction time.
    // The run Effect closes over these shapes, so its own R channel is never.
    const serverConfig = yield* ServerConfig;
    const engine: OrchestrationEngineShape = yield* OrchestrationEngineService;
    const checkpointStore = yield* CheckpointStore;
    const gitDriver = yield* GitVcsDriver;
    const receiptBus = yield* RuntimeReceiptBus;
    const projectionQuery = yield* ProjectionSnapshotQuery;
    const fs = yield* FileSystem.FileSystem;
    const pathSvc = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;

    // Provider layer used to satisfy retireWorktree's R channel via Effect.provide
    const retirementProviderLayer = Layer.mergeAll(
      Layer.succeed(OrchestrationEngineService, engine),
      Layer.succeed(CheckpointStore, checkpointStore),
      Layer.succeed(GitVcsDriver, gitDriver),
      Layer.succeed(RuntimeReceiptBus, receiptBus),
      Layer.succeed(Crypto.Crypto, crypto),
      Layer.succeed(ProjectionSnapshotQuery, projectionQuery),
    );

    const enumeratePaths = (): Effect.Effect<WorktreePathInfo[], never, never> =>
      Effect.gen(function* () {
        const repoEntries = yield* fs
          .readDirectory(serverConfig.worktreesDir, { recursive: false })
          .pipe(Effect.catch((_err) => Effect.succeed([] as string[])));

        const paths: WorktreePathInfo[] = [];
        for (const repoEntry of repoEntries) {
          const repoDir = pathSvc.join(serverConfig.worktreesDir, repoEntry);
          const stat = yield* fs.stat(repoDir).pipe(Effect.catch((_err) => Effect.succeed(null)));
          if (!stat || stat.type !== "Directory") continue;

          const branchEntries = yield* fs
            .readDirectory(repoDir, { recursive: false })
            .pipe(Effect.catch((_err) => Effect.succeed([] as string[])));

          for (const branchEntry of branchEntries) {
            const fullPath = pathSvc.join(repoDir, branchEntry);
            const bstat = yield* fs
              .stat(fullPath)
              .pipe(Effect.catch((_err) => Effect.succeed(null)));
            if (!bstat || bstat.type !== "Directory") continue;
            // ponytail: branch = null — sanitised dir entry ≠ original branch name
            paths.push({ fullPath, branch: null });
          }
        }
        return paths;
      });

    const readEventsForPath = (
      worktreePath: string,
    ): Effect.Effect<OrchestrationEvent[], never, never> =>
      Stream.runCollect(
        engine.readEvents(0).pipe(
          Stream.filter((ev) => {
            if (ev.aggregateKind !== "worktree") return false;
            const p = ev.payload as Record<string, unknown>;
            return p["worktreePath"] === worktreePath;
          }),
        ),
      ).pipe(
        Effect.map((chunk) => Array.from(chunk) as OrchestrationEvent[]),
        Effect.catch((_err) =>
          Effect.logWarning("graveyard.adopter.event-read-failed", { worktreePath }).pipe(
            Effect.as([] as OrchestrationEvent[]),
          ),
        ),
      );

    const processPathInner = (info: WorktreePathInfo) =>
      Effect.gen(function* () {
        const events = yield* readEventsForPath(info.fullPath);
        const status = classifyEvents(events);

        if (status.kind === "buried" || status.kind === "adopted") {
          return; // case (c): untouched
        }

        if (status.kind === "retiring") {
          // case (b): crash-recovery per plan 21 §Failure Modes
          yield* Effect.logInfo("graveyard.adopter.resume-retirement", {
            worktreePath: info.fullPath,
          });
          const retiringEv = events.find((ev) => ev.type === "worktree.retiring-started");
          const threadId =
            retiringEv && "threadId" in retiringEv.payload
              ? (retiringEv.payload.threadId as typeof ORPHAN_THREAD_ID)
              : ORPHAN_THREAD_ID;

          // ponytail: use worktreePath as repoRoot — linked worktree IS a valid git context;
          // removeWorktree failure leaves retiring-started as marker → retry next boot.
          yield* retireWorktree({
            threadId,
            worktreePath: info.fullPath,
            branch: info.branch,
            repoRoot: info.fullPath,
            trigger: "thread-deleted",
          }).pipe(Effect.provide(retirementProviderLayer));
          return;
        }

        if (status.kind === "owner-only") {
          // case (d): owner-recorded with no retirement history — check thread liveness.
          // getThreadShellById filters WHERE deleted_at IS NULL AND archived_at IS NULL
          // (ProjectionSnapshotQuery.ts:717) so None = absent OR deleted/archived.
          const shell = yield* projectionQuery
            .getThreadShellById(status.threadId)
            .pipe(Effect.orElseSucceed(() => Option.none()));
          if (Option.isSome(shell)) {
            // Thread is alive — this is a healthy bound worktree, never adopt it.
            yield* Effect.logDebug("graveyard.adopter.bound-skip", {
              worktreePath: info.fullPath,
              threadId: status.threadId,
            });
            return;
          }
          // Thread absent/deleted — fall through to orphan adoption below.
          yield* Effect.logInfo("graveyard.adopter.dead-thread-orphan", {
            worktreePath: info.fullPath,
            threadId: status.threadId,
          });
        }

        // case (a)/(d-dead): none or owner-only with dead/absent thread → emit worktree.adopted
        yield* Effect.logInfo("graveyard.adopter.adopting-orphan", {
          worktreePath: info.fullPath,
        });
        const adoptedAt = DateTime.formatIso(yield* DateTime.now);
        const uuid = yield* crypto.randomUUIDv4;
        const commandId = CommandId.make(`server:worktree-adopt:${uuid}`);
        yield* engine.dispatch(
          {
            type: "worktree.adopt",
            commandId,
            worktreePath: info.fullPath,
            branch: info.branch,
            adoptedAt,
          },
          "server",
        );
      });

    // ponytail: ignoreCause on processPath — typed + untyped errors from retirement/dispatch
    // are swallowed (logged by ignoreCause); interrupts propagate via Cause.
    const processPath = (info: WorktreePathInfo): Effect.Effect<void, never, never> =>
      processPathInner(info).pipe(Effect.ignoreCause({ log: true }));

    const run: Effect.Effect<void, never, never> = Effect.gen(function* () {
      yield* Effect.logInfo("graveyard.adopter.scan.start", {
        worktreesDir: serverConfig.worktreesDir,
      });
      const paths = yield* enumeratePaths();
      yield* Effect.logInfo("graveyard.adopter.scan.found", { count: paths.length });

      for (const info of paths) {
        yield* processPath(info);
      }

      yield* Effect.logInfo("graveyard.adopter.scan.complete");
    });

    return { run };
  }),
);
