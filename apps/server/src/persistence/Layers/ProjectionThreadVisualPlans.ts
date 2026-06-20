import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { PlanComment, PlanContent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteProjectionThreadVisualPlansInput,
  ListProjectionThreadVisualPlansInput,
  ProjectionThreadVisualPlan,
  ProjectionThreadVisualPlanRepository,
  type ProjectionThreadVisualPlanRepositoryShape,
} from "../Services/ProjectionThreadVisualPlans.ts";

const ProjectionThreadVisualPlanDbRowSchema = ProjectionThreadVisualPlan.mapFields(
  Struct.assign({
    content: Schema.fromJsonString(PlanContent),
    comments: Schema.fromJsonString(Schema.Array(PlanComment)),
  }),
);

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown) =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makeProjectionThreadVisualPlanRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionThreadVisualPlanRow = SqlSchema.void({
    Request: ProjectionThreadVisualPlan,
    execute: (row) => sql`
      INSERT INTO projection_thread_visual_plans (
        plan_id,
        thread_id,
        turn_id,
        content_json,
        comments_json,
        created_at,
        updated_at
      )
      VALUES (
        ${row.planId},
        ${row.threadId},
        ${row.turnId},
        ${JSON.stringify(row.content)},
        ${JSON.stringify(row.comments)},
        ${row.createdAt},
        ${row.updatedAt}
      )
      ON CONFLICT (plan_id)
      DO UPDATE SET
        thread_id = excluded.thread_id,
        turn_id = excluded.turn_id,
        content_json = excluded.content_json,
        comments_json = excluded.comments_json,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `,
  });

  const listProjectionThreadVisualPlanRows = SqlSchema.findAll({
    Request: ListProjectionThreadVisualPlansInput,
    Result: ProjectionThreadVisualPlanDbRowSchema,
    execute: ({ threadId }) => sql`
      SELECT
        plan_id AS "planId",
        thread_id AS "threadId",
        turn_id AS "turnId",
        content_json AS "content",
        comments_json AS "comments",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM projection_thread_visual_plans
      WHERE thread_id = ${threadId}
      ORDER BY created_at ASC, plan_id ASC
    `,
  });

  const deleteProjectionThreadVisualPlanRows = SqlSchema.void({
    Request: DeleteProjectionThreadVisualPlansInput,
    execute: ({ threadId }) => sql`
      DELETE FROM projection_thread_visual_plans
      WHERE thread_id = ${threadId}
    `,
  });

  const upsert: ProjectionThreadVisualPlanRepositoryShape["upsert"] = (row) =>
    upsertProjectionThreadVisualPlanRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadVisualPlanRepository.upsert:query")),
    );

  const listByThreadId: ProjectionThreadVisualPlanRepositoryShape["listByThreadId"] = (input) =>
    listProjectionThreadVisualPlanRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionThreadVisualPlanRepository.listByThreadId:query",
          "ProjectionThreadVisualPlanRepository.listByThreadId:decode",
        ),
      ),
    );

  const deleteByThreadId: ProjectionThreadVisualPlanRepositoryShape["deleteByThreadId"] = (input) =>
    deleteProjectionThreadVisualPlanRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadVisualPlanRepository.deleteByThreadId:query"),
      ),
    );

  return {
    upsert,
    listByThreadId,
    deleteByThreadId,
  } satisfies ProjectionThreadVisualPlanRepositoryShape;
});

export const ProjectionThreadVisualPlanRepositoryLive = Layer.effect(
  ProjectionThreadVisualPlanRepository,
  makeProjectionThreadVisualPlanRepository,
);
