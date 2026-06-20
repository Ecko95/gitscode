/**
 * ProjectionThreadVisualPlanRepository - Projection repository interface for
 * thread visual plans (the GITS-native builder.io-style visual plan documents).
 *
 * Owns persistence for the per-thread `PlanContent` document + comments
 * projected from `thread.visual-plan-upserted` orchestration events. Content
 * and comments are stored as JSON columns.
 *
 * @module ProjectionThreadVisualPlanRepository
 */
import {
  IsoDateTime,
  OrchestrationVisualPlanId,
  PlanComment,
  PlanContent,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionThreadVisualPlan = Schema.Struct({
  planId: OrchestrationVisualPlanId,
  threadId: ThreadId,
  turnId: Schema.NullOr(TurnId),
  content: PlanContent,
  comments: Schema.Array(PlanComment),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ProjectionThreadVisualPlan = typeof ProjectionThreadVisualPlan.Type;

export const ListProjectionThreadVisualPlansInput = Schema.Struct({
  threadId: ThreadId,
});
export type ListProjectionThreadVisualPlansInput =
  typeof ListProjectionThreadVisualPlansInput.Type;

export const DeleteProjectionThreadVisualPlansInput = Schema.Struct({
  threadId: ThreadId,
});
export type DeleteProjectionThreadVisualPlansInput =
  typeof DeleteProjectionThreadVisualPlansInput.Type;

export interface ProjectionThreadVisualPlanRepositoryShape {
  readonly upsert: (
    visualPlan: ProjectionThreadVisualPlan,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly listByThreadId: (
    input: ListProjectionThreadVisualPlansInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionThreadVisualPlan>, ProjectionRepositoryError>;
  readonly deleteByThreadId: (
    input: DeleteProjectionThreadVisualPlansInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionThreadVisualPlanRepository extends Context.Service<
  ProjectionThreadVisualPlanRepository,
  ProjectionThreadVisualPlanRepositoryShape
>()(
  "t3/persistence/Services/ProjectionThreadVisualPlans/ProjectionThreadVisualPlanRepository",
) {}
