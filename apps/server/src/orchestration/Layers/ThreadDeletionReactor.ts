import type { OrchestrationEvent } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { TerminalManager } from "../../terminal/Services/Manager.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  ThreadDeletionReactor,
  type ThreadDeletionReactorShape,
} from "../Services/ThreadDeletionReactor.ts";
import { retireWorktree } from "../../vcs/WorktreeGraveyardRetirement.ts";
import { browser_preview_manager } from "../../browser-preview/browser-preview-manager.ts";

type ThreadRuntimeCleanupEvent = Extract<
  OrchestrationEvent,
  { type: "thread.archived" | "thread.deleted" }
>;

export interface ThreadRuntimeCleanupRequest {
  readonly threadId: ThreadRuntimeCleanupEvent["payload"]["threadId"];
  readonly deleteTerminalHistory: boolean;
  readonly retireWorktree: boolean;
}

export function threadRuntimeCleanupRequest(
  event: OrchestrationEvent,
): ThreadRuntimeCleanupRequest | undefined {
  switch (event.type) {
    case "thread.archived":
      return {
        threadId: event.payload.threadId,
        deleteTerminalHistory: false,
        retireWorktree: false,
      };
    case "thread.deleted":
      return {
        threadId: event.payload.threadId,
        deleteTerminalHistory: true,
        retireWorktree: true,
      };
    default:
      return undefined;
  }
}

export const logCleanupCauseUnlessInterrupted = <R, E>({
  effect,
  message,
  threadId,
}: {
  readonly effect: Effect.Effect<void, E, R>;
  readonly message: string;
  readonly threadId: ThreadRuntimeCleanupEvent["payload"]["threadId"];
}): Effect.Effect<void, E, R> =>
  effect.pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.failCause(cause);
      }
      return Effect.logDebug(message, {
        threadId,
        cause: Cause.pretty(cause),
      });
    }),
  );

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;
  const terminalManager = yield* TerminalManager;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;

  const stopProviderSession = (threadId: ThreadRuntimeCleanupEvent["payload"]["threadId"]) =>
    logCleanupCauseUnlessInterrupted({
      effect: providerService.stopSession({ threadId }),
      message: "thread deletion cleanup skipped provider session stop",
      threadId,
    });

  const closeThreadTerminals = (
    threadId: ThreadRuntimeCleanupEvent["payload"]["threadId"],
    deleteHistory: boolean,
  ) =>
    logCleanupCauseUnlessInterrupted({
      effect: terminalManager.close({ threadId, deleteHistory }),
      message: "thread runtime cleanup skipped terminal close",
      threadId,
    });

  const stopBrowserPreview = (threadId: ThreadRuntimeCleanupEvent["payload"]["threadId"]) =>
    Effect.promise(() => browser_preview_manager.stop(threadId));

  const retireWorktreeForThread = (threadId: ThreadRuntimeCleanupEvent["payload"]["threadId"]) =>
    Effect.gen(function* () {
      const worktreeInfo = yield* projectionSnapshotQuery
        .getThreadWorktreeInfo(threadId)
        .pipe(Effect.map(Option.getOrUndefined));
      if (!worktreeInfo?.worktreePath) {
        return; // non-worktree thread — skip
      }
      const repoRoot = worktreeInfo.projectWorkspaceRoot ?? worktreeInfo.worktreePath;
      yield* retireWorktree({
        threadId,
        worktreePath: worktreeInfo.worktreePath,
        branch: worktreeInfo.branch,
        repoRoot,
        trigger: "thread-deleted",
      });
    }).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
        return Effect.logWarning("thread deletion reactor skipped worktree retirement", {
          threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const processThreadRuntimeCleanup = Effect.fn("processThreadRuntimeCleanup")(function* (
    request: ThreadRuntimeCleanupRequest,
  ) {
    const { threadId } = request;
    yield* stopProviderSession(threadId);
    yield* closeThreadTerminals(threadId, request.deleteTerminalHistory);
    yield* stopBrowserPreview(threadId);
    if (request.retireWorktree) yield* retireWorktreeForThread(threadId);
  });

  const processThreadRuntimeCleanupSafely = (request: ThreadRuntimeCleanupRequest) =>
    processThreadRuntimeCleanup(request).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("thread runtime cleanup reactor failed to process event", {
          threadId: request.threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processThreadRuntimeCleanupSafely);

  const start: ThreadDeletionReactorShape["start"] = Effect.fn("start")(function* () {
    const domainEvents = yield* orchestrationEngine.subscribeDomainEvents;
    yield* Effect.forkScoped(
      Stream.runForEach(Stream.fromSubscription(domainEvents), (event) => {
        const request = threadRuntimeCleanupRequest(event);
        return request ? worker.enqueue(request) : Effect.void;
      }),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies ThreadDeletionReactorShape;
});

export const ThreadDeletionReactorLive = Layer.effect(ThreadDeletionReactor, make);
