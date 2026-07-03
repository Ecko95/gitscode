/**
 * Worktree graveyard retirement handler (plan 21, W2.2).
 *
 * Single shared Effect function used by ThreadDeletionReactor.
 * Not a new reactor — injected via the DrainableWorker callback closure.
 *
 * Retirement flow:
 *   1. Dispatch `worktree.retire.start` → store retiring-started event
 *   2. Publish WorktreeRetiringStartedReceipt
 *   3. Capture raw checkpoint ref (captureCheckpoint — no active turn needed)
 *   4. git worktree remove (GitVcsDriver.removeWorktree)
 *   5. Dispatch `worktree.bury` → store buried event
 *   6. Publish WorktreeBuriedReceipt
 *
 * Failure modes per plan 21:
 *   - captureCheckpoint fails → warn, bury with null ref (burial proceeds)
 *   - removeWorktree fails    → warn, NO buried event (retiring-started stays as recovery marker)
 *
 * NOTE(plan 21 W2.2): the inactivity-reap trigger is wired in ThreadDeletionReactor only.
 * ProviderSessionReaper cannot use retireWorktree directly because yielding its service
 * dependencies cascades into ProviderRuntimeLayerLive's R in a way TS cannot resolve
 * via RuntimeCoreDependenciesLive's provideMerge chain (the ReactorLayerLive chain works
 * because RuntimeReceiptBusLive is explicitly in that chain). See TODO in ProviderSessionReaper.
 */
import type { ThreadId } from "@t3tools/contracts";
import { CheckpointRef, CommandId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { CheckpointStore } from "../checkpointing/Services/CheckpointStore.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { RuntimeReceiptBus } from "../orchestration/Services/RuntimeReceiptBus.ts";
import { GitVcsDriver } from "./GitVcsDriver.ts";

// ponytail: unique ref per worktree path using simple hex hash — no deps needed
export function graveyardCheckpointRef(worktreePath: string): CheckpointRef {
  let h = 5381;
  for (let i = 0; i < worktreePath.length; i++) {
    h = ((h << 5) + h) ^ worktreePath.charCodeAt(i);
    h = h >>> 0;
  }
  return CheckpointRef.make(`refs/t3/graveyard/${h.toString(16).padStart(8, "0")}/final`);
}

const serverCommandId = (tag: string) =>
  Crypto.Crypto.pipe(
    Effect.flatMap((crypto) =>
      crypto.randomUUIDv4.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`))),
    ),
  );

export interface RetireWorktreeInput {
  readonly threadId: ThreadId;
  readonly worktreePath: string;
  readonly branch: string | null;
  readonly repoRoot: string;
  readonly trigger: "thread-deleted" | "inactivity-reap";
}

/**
 * Retire a worktree: emit retiring-started, capture checkpoint, remove, emit buried.
 * Requires CheckpointStore, GitVcsDriver, OrchestrationEngineService, RuntimeReceiptBus,
 * and Crypto.Crypto in the Effect context. These are satisfied via the DrainableWorker
 * callback pattern in ThreadDeletionReactor (R propagates to the layer's requirements).
 */
export const retireWorktree = Effect.fn("retireWorktree")(function* (input: RetireWorktreeInput) {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const checkpointStore = yield* CheckpointStore;
  const gitDriver = yield* GitVcsDriver;
  const receiptBus = yield* RuntimeReceiptBus;

  const nowIso = () => Effect.map(DateTime.now, DateTime.formatIso);

  const initiatedAt = yield* nowIso();

  // Step 1: emit retiring-started
  const retireCommandId = yield* serverCommandId("worktree-retire-start");
  yield* orchestrationEngine.dispatch({
    type: "worktree.retire.start",
    commandId: retireCommandId,
    threadId: input.threadId,
    worktreePath: input.worktreePath,
    branch: input.branch,
    trigger: input.trigger,
    initiatedAt,
  });

  // Step 2: publish receipt so tests can synchronize
  yield* receiptBus.publish({
    type: "worktree.retiring.started",
    threadId: input.threadId,
    worktreePath: input.worktreePath,
    createdAt: initiatedAt,
  });

  // Step 3: capture raw checkpoint ref (no active turn required — plan 21 Contradiction #1)
  const checkpointRef = graveyardCheckpointRef(input.worktreePath);
  const capturedRef: CheckpointRef | null = yield* checkpointStore
    .captureCheckpoint({
      cwd: input.worktreePath,
      checkpointRef,
    })
    .pipe(
      Effect.as<CheckpointRef | null>(checkpointRef),
      Effect.catch((_err) =>
        Effect.logWarning("worktree.retirement.checkpoint-failed", {
          threadId: input.threadId,
          worktreePath: input.worktreePath,
        }).pipe(Effect.as<CheckpointRef | null>(null)),
      ),
    );

  // Step 4: remove worktree — if this fails, do NOT emit buried (recovery marker stays)
  const removeResult: boolean = yield* gitDriver
    .removeWorktree({
      cwd: input.repoRoot,
      path: input.worktreePath,
      force: false,
    })
    .pipe(
      Effect.as(true),
      Effect.catch((_err) =>
        Effect.logWarning("worktree.burial.remove-failed", {
          threadId: input.threadId,
          worktreePath: input.worktreePath,
        }).pipe(Effect.as(false)),
      ),
    );

  if (!removeResult) {
    return; // retiring-started stays as recovery marker (plan 21 §Failure Modes)
  }

  // Step 5: emit buried
  const buriedAt = yield* nowIso();
  const buryCommandId = yield* serverCommandId("worktree-bury");
  yield* orchestrationEngine.dispatch({
    type: "worktree.bury",
    commandId: buryCommandId,
    threadId: input.threadId,
    worktreePath: input.worktreePath,
    branch: input.branch,
    trigger: "retirement",
    finalCheckpointRef: capturedRef,
    buriedAt,
  });

  // Step 6: publish buried receipt
  yield* receiptBus.publish({
    type: "worktree.buried",
    threadId: input.threadId,
    worktreePath: input.worktreePath,
    trigger: "retirement",
    finalCheckpointRef: capturedRef,
    createdAt: buriedAt,
  });
});
