/**
 * ProjectionSnapshotQuery - Read-model snapshot query service interface.
 *
 * Exposes the current orchestration projection snapshot for read-only API
 * access.
 *
 * @module ProjectionSnapshotQuery
 */
import type {
  CheckpointRef,
  OrchestrationCheckpointSummary,
  OrchestrationMessage,
  OrchestrationProject,
  OrchestrationProjectShell,
  OrchestrationProposedPlan,
  OrchestrationReadModel,
  OrchestrationShellSnapshot,
  OrchestrationThread,
  OrchestrationThreadShell,
  ProjectId,
  ThreadId,
  TurnId,
  UsageModelBreakdown,
  UsageModelBreakdownInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Option from "effect/Option";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";

export interface ProjectionSnapshotCounts {
  readonly projectCount: number;
  readonly threadCount: number;
}

export interface ProjectionSnapshotSequence {
  readonly snapshotSequence: number;
}

export interface ProjectionThreadDetailSnapshot {
  readonly snapshotSequence: number;
  readonly threadDetail: Option.Option<OrchestrationThread>;
}

export interface ProjectionThreadCheckpointContext {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
  readonly worktreePath: string | null;
  readonly checkpoints: ReadonlyArray<OrchestrationCheckpointSummary>;
}

export interface ProjectionFullThreadDiffContext {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
  readonly worktreePath: string | null;
  readonly latestCheckpointTurnCount: number;
  readonly toCheckpointRef: CheckpointRef | null;
}

/**
 * ProjectionSnapshotQueryShape - Service API for read-model snapshots.
 */
export interface ProjectionSnapshotQueryShape {
  /**
   * Read the lightweight command snapshot used to bootstrap the in-memory
   * orchestration engine without hydrating message/activity/checkpoint bodies.
   */
  readonly getCommandReadModel: () => Effect.Effect<
    OrchestrationReadModel,
    ProjectionRepositoryError
  >;

  /**
   * Read the latest orchestration projection snapshot.
   *
   * Rehydrates from projection tables and derives snapshot sequence from
   * projector cursor state.
   */
  readonly getSnapshot: () => Effect.Effect<OrchestrationReadModel, ProjectionRepositoryError>;

  /**
   * Read the latest orchestration shell snapshot.
   *
   * Returns only projects and thread shell summaries so clients can bootstrap
   * lightweight navigation state without hydrating every thread body.
   */
  readonly getShellSnapshot: () => Effect.Effect<
    OrchestrationShellSnapshot,
    ProjectionRepositoryError
  >;

  /**
   * Read archived thread shell summaries for the archive page.
   *
   * This query is separate from the main shell snapshot so archived threads
   * are never bootstrapped into normal navigation state.
   */
  readonly getArchivedShellSnapshot: () => Effect.Effect<
    OrchestrationShellSnapshot,
    ProjectionRepositoryError
  >;

  /**
   * Read the latest projection snapshot sequence without hydrating read-model
   * entities.
   */
  readonly getSnapshotSequence: () => Effect.Effect<
    ProjectionSnapshotSequence,
    ProjectionRepositoryError
  >;

  /**
   * Read aggregate projection counts without hydrating the full read model.
   */
  readonly getCounts: () => Effect.Effect<ProjectionSnapshotCounts, ProjectionRepositoryError>;

  /**
   * Read the active project for a canonical-equivalent workspace root match.
   */
  readonly getActiveProjectByWorkspaceRoot: (
    workspaceRoot: string,
  ) => Effect.Effect<Option.Option<OrchestrationProject>, ProjectionRepositoryError>;

  /**
   * Read a single active project shell row by id.
   */
  readonly getProjectShellById: (
    projectId: ProjectId,
  ) => Effect.Effect<Option.Option<OrchestrationProjectShell>, ProjectionRepositoryError>;

  /**
   * Read the earliest active thread for a project.
   */
  readonly getFirstActiveThreadIdByProjectId: (
    projectId: ProjectId,
  ) => Effect.Effect<Option.Option<ThreadId>, ProjectionRepositoryError>;

  /**
   * Read the checkpoint context needed to resolve a single thread diff.
   */
  readonly getThreadCheckpointContext: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<ProjectionThreadCheckpointContext>, ProjectionRepositoryError>;

  /**
   * Read only the narrow context needed to compute a full-thread diff from
   * checkpoint 0 to a specific turn count.
   */
  readonly getFullThreadDiffContext: (
    threadId: ThreadId,
    toTurnCount: number,
  ) => Effect.Effect<Option.Option<ProjectionFullThreadDiffContext>, ProjectionRepositoryError>;

  /**
   * Read a single active thread shell row by id.
   */
  readonly getThreadShellById: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<OrchestrationThreadShell>, ProjectionRepositoryError>;

  /**
   * Read a single active thread detail snapshot by id.
   */
  readonly getThreadDetailById: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<OrchestrationThread>, ProjectionRepositoryError>;

  /**
   * Read a single thread detail plus its matching projection snapshot sequence
   * from one consistent database snapshot.
   */
  readonly getThreadDetailSnapshot: (
    threadId: ThreadId,
  ) => Effect.Effect<ProjectionThreadDetailSnapshot, ProjectionRepositoryError>;

  /**
   * Read worktree path and branch for a thread regardless of deleted/archived state.
   * Used by the graveyard retirement handler after thread.deleted fires (plan 21 W2.2).
   */
  readonly getThreadWorktreeInfo: (threadId: ThreadId) => Effect.Effect<
    Option.Option<{
      readonly worktreePath: string | null;
      readonly branch: string | null;
      readonly projectWorkspaceRoot: string | null;
    }>,
    ProjectionRepositoryError
  >;

  /**
   * Returns true when any non-deleted thread has this worktree path.
   * Used by GraveyardReaper to block pruning of pre-W2.5 worktrees that
   * have no owner-recorded events but are still referenced in the projection.
   * ARCHIVED threads block (deleted_at IS NULL covers them).
   *
   * `excludeThreadId` ignores that thread — used by worktree retirement to ask
   * "does any OTHER live thread share this worktree?" (forks share the source
   * thread's worktree path).
   */
  readonly hasLiveThreadForWorktreePath: (
    worktreePath: string,
    excludeThreadId?: string,
  ) => Effect.Effect<boolean, ProjectionRepositoryError>;

  /**
   * Read the projected messages for a single turn — `turn_id` match, or the
   * turn-less partition when `turnId` is null. Provider-runtime ingestion uses
   * this to avoid materializing every thread message on each event.
   *
   * Optional so existing test doubles need not implement it; the live layer
   * always provides it.
   */
  readonly listThreadMessagesByTurn?: (
    threadId: ThreadId,
    turnId: TurnId | null,
  ) => Effect.Effect<ReadonlyArray<OrchestrationMessage>, ProjectionRepositoryError>;

  /**
   * Read a thread's proposed plans without materializing the rest of the thread.
   *
   * Optional so existing test doubles need not implement it; the live layer
   * always provides it.
   */
  readonly listThreadProposedPlans?: (
    threadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<OrchestrationProposedPlan>, ProjectionRepositoryError>;

  /**
   * Aggregate `usage.cost.updated` projection activities into per-model
   * token/cost totals for a rolling window (5h or weekly). Used by the chat
   * usage panel.
   *
   * Optional so existing test doubles need not implement it; the live layer
   * always provides it.
   */
  readonly getUsageModelBreakdown?: (
    input: UsageModelBreakdownInput,
  ) => Effect.Effect<UsageModelBreakdown, ProjectionRepositoryError>;
}

/**
 * ProjectionSnapshotQuery - Service tag for projection snapshot queries.
 */
export class ProjectionSnapshotQuery extends Context.Service<
  ProjectionSnapshotQuery,
  ProjectionSnapshotQueryShape
>()("t3/orchestration/Services/ProjectionSnapshotQuery") {}
