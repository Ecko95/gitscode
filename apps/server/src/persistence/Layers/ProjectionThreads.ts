import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteProjectionThreadInput,
  GetProjectionThreadInput,
  ListProjectionThreadsByProjectInput,
  ProjectionThread,
  ProjectionThreadRepository,
  type ProjectionThreadRepositoryShape,
} from "../Services/ProjectionThreads.ts";
import { ModelSelection } from "@t3tools/contracts";

const ProjectionThreadDbRow = ProjectionThread.mapFields(
  Struct.assign({
    modelSelection: Schema.fromJsonString(ModelSelection),
  }),
);
type ProjectionThreadDbRow = typeof ProjectionThreadDbRow.Type;

const makeProjectionThreadRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionThreadRow = SqlSchema.void({
    Request: ProjectionThread,
    execute: (row) =>
      sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          parent_thread_id,
          forked_from_message_id,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          deleted_at
        )
        VALUES (
          ${row.threadId},
          ${row.projectId},
          ${row.title},
          ${JSON.stringify(row.modelSelection)},
          ${row.runtimeMode},
          ${row.interactionMode},
          ${row.branch},
          ${row.worktreePath},
          ${row.parentThreadId},
          ${row.forkedFromMessageId},
          ${row.latestTurnId},
          ${row.createdAt},
          ${row.updatedAt},
          ${row.archivedAt},
          ${row.latestUserMessageAt},
          ${row.pendingApprovalCount},
          ${row.pendingUserInputCount},
          ${row.hasActionableProposedPlan},
          ${row.deletedAt}
        )
        ON CONFLICT (thread_id)
        DO UPDATE SET
          project_id = excluded.project_id,
          title = excluded.title,
          model_selection_json = excluded.model_selection_json,
          runtime_mode = excluded.runtime_mode,
          interaction_mode = excluded.interaction_mode,
          branch = excluded.branch,
          worktree_path = excluded.worktree_path,
          parent_thread_id = excluded.parent_thread_id,
          forked_from_message_id = excluded.forked_from_message_id,
          latest_turn_id = excluded.latest_turn_id,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          archived_at = excluded.archived_at,
          latest_user_message_at = excluded.latest_user_message_at,
          pending_approval_count = excluded.pending_approval_count,
          pending_user_input_count = excluded.pending_user_input_count,
          has_actionable_proposed_plan = excluded.has_actionable_proposed_plan,
          deleted_at = excluded.deleted_at
      `,
  });

  const getProjectionThreadRow = SqlSchema.findOneOption({
    Request: GetProjectionThreadInput,
    Result: ProjectionThreadDbRow,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          title,
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          branch,
          worktree_path AS "worktreePath",
          parent_thread_id AS "parentThreadId",
          forked_from_message_id AS "forkedFromMessageId",
          latest_turn_id AS "latestTurnId",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          latest_user_message_at AS "latestUserMessageAt",
          pending_approval_count AS "pendingApprovalCount",
          pending_user_input_count AS "pendingUserInputCount",
          has_actionable_proposed_plan AS "hasActionableProposedPlan",
          deleted_at AS "deletedAt"
        FROM projection_threads
        WHERE thread_id = ${threadId}
      `,
  });

  const listProjectionThreadRows = SqlSchema.findAll({
    Request: ListProjectionThreadsByProjectInput,
    Result: ProjectionThreadDbRow,
    execute: ({ projectId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          title,
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          branch,
          worktree_path AS "worktreePath",
          parent_thread_id AS "parentThreadId",
          forked_from_message_id AS "forkedFromMessageId",
          latest_turn_id AS "latestTurnId",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          latest_user_message_at AS "latestUserMessageAt",
          pending_approval_count AS "pendingApprovalCount",
          pending_user_input_count AS "pendingUserInputCount",
          has_actionable_proposed_plan AS "hasActionableProposedPlan",
          deleted_at AS "deletedAt"
        FROM projection_threads
        WHERE project_id = ${projectId}
        ORDER BY created_at ASC, thread_id ASC
      `,
  });

  const deleteProjectionThreadRow = SqlSchema.void({
    Request: DeleteProjectionThreadInput,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM projection_threads
        WHERE thread_id = ${threadId}
      `,
  });

  // Recomputes the four shell-summary columns for one thread from SQL
  // aggregates instead of materializing every message/activity/plan/approval
  // row per event. The pending-user-input aggregate mirrors
  // derivePendingUserInputCountFromActivities exactly: for each requestId, only
  // state-changing activities participate (requested / resolved / stale-or-
  // unknown failed), and the request is open iff its latest such activity is a
  // request. The has-actionable-proposed-plan aggregate mirrors
  // deriveHasActionableProposedPlan (latest plan for latest_turn_id, else latest
  // plan overall, actionable iff not implemented). Backfilled identically by
  // migration 024.
  const refreshProjectionThreadShellSummaryRow = SqlSchema.void({
    Request: GetProjectionThreadInput,
    execute: ({ threadId }) =>
      sql`
        UPDATE projection_threads
        SET
          latest_user_message_at = (
            SELECT MAX(message.created_at)
            FROM projection_thread_messages AS message
            WHERE message.thread_id = projection_threads.thread_id
              AND message.role = 'user'
          ),
          pending_approval_count = COALESCE((
            SELECT COUNT(*)
            FROM projection_pending_approvals
            WHERE projection_pending_approvals.thread_id = projection_threads.thread_id
              AND projection_pending_approvals.status = 'pending'
          ), 0),
          pending_user_input_count = COALESCE((
            WITH latest_user_input_states AS (
              SELECT latest.kind
              FROM (
                SELECT
                  activity.kind AS kind,
                  ROW_NUMBER() OVER (
                    PARTITION BY json_extract(activity.payload_json, '$.requestId')
                    ORDER BY activity.created_at DESC, activity.activity_id DESC
                  ) AS row_number
                FROM projection_thread_activities AS activity
                WHERE activity.thread_id = projection_threads.thread_id
                  AND json_extract(activity.payload_json, '$.requestId') IS NOT NULL
                  AND (
                    activity.kind IN ('user-input.requested', 'user-input.resolved')
                    OR (
                      activity.kind = 'provider.user-input.respond.failed'
                      AND (
                        lower(COALESCE(json_extract(activity.payload_json, '$.detail'), ''))
                          LIKE '%stale pending user-input request%'
                        OR lower(COALESCE(json_extract(activity.payload_json, '$.detail'), ''))
                          LIKE '%unknown pending user-input request%'
                      )
                    )
                  )
              ) AS latest
              WHERE latest.row_number = 1
            )
            SELECT COUNT(*)
            FROM latest_user_input_states
            WHERE latest_user_input_states.kind = 'user-input.requested'
          ), 0),
          has_actionable_proposed_plan = COALESCE((
            SELECT CASE
              WHEN projection_threads.latest_turn_id IS NOT NULL
                AND EXISTS (
                  SELECT 1
                  FROM projection_thread_proposed_plans AS latest_turn_plan_exists
                  WHERE latest_turn_plan_exists.thread_id = projection_threads.thread_id
                    AND latest_turn_plan_exists.turn_id = projection_threads.latest_turn_id
                )
                THEN CASE
                  WHEN (
                    SELECT latest_turn_plan.implemented_at
                    FROM projection_thread_proposed_plans AS latest_turn_plan
                    WHERE latest_turn_plan.thread_id = projection_threads.thread_id
                      AND latest_turn_plan.turn_id = projection_threads.latest_turn_id
                    ORDER BY latest_turn_plan.updated_at DESC, latest_turn_plan.plan_id DESC
                    LIMIT 1
                  ) IS NULL
                    THEN 1
                    ELSE 0
                  END
              WHEN EXISTS (
                SELECT 1
                FROM projection_thread_proposed_plans AS any_plan
                WHERE any_plan.thread_id = projection_threads.thread_id
              )
                THEN CASE
                  WHEN (
                    SELECT latest_plan.implemented_at
                    FROM projection_thread_proposed_plans AS latest_plan
                    WHERE latest_plan.thread_id = projection_threads.thread_id
                    ORDER BY latest_plan.updated_at DESC, latest_plan.plan_id DESC
                    LIMIT 1
                  ) IS NULL
                    THEN 1
                    ELSE 0
                  END
              ELSE 0
            END
          ), 0)
        WHERE projection_threads.thread_id = ${threadId}
      `,
  });

  const upsert: ProjectionThreadRepositoryShape["upsert"] = (row) =>
    upsertProjectionThreadRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadRepository.upsert:query")),
    );

  const getById: ProjectionThreadRepositoryShape["getById"] = (input) =>
    getProjectionThreadRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadRepository.getById:query")),
    );

  const listByProjectId: ProjectionThreadRepositoryShape["listByProjectId"] = (input) =>
    listProjectionThreadRows(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadRepository.listByProjectId:query")),
    );

  const deleteById: ProjectionThreadRepositoryShape["deleteById"] = (input) =>
    deleteProjectionThreadRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadRepository.deleteById:query")),
    );

  const refreshShellSummary: ProjectionThreadRepositoryShape["refreshShellSummary"] = (input) =>
    refreshProjectionThreadShellSummaryRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadRepository.refreshShellSummary:query"),
      ),
    );

  return {
    upsert,
    getById,
    listByProjectId,
    deleteById,
    refreshShellSummary,
  } satisfies ProjectionThreadRepositoryShape;
});

export const ProjectionThreadRepositoryLive = Layer.effect(
  ProjectionThreadRepository,
  makeProjectionThreadRepository,
);
