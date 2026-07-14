import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import {
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type AutomodeEpisodeLedgerRepositoryError,
} from "../Errors.ts";
import {
  AutomodeEpisode,
  AutomodeEpisodeLedger,
  type AutomodeEpisodeLedgerShape,
} from "../Services/AutomodeEpisodeLedger.ts";

// DB-row mapping: `review` stored as JSON TEXT (parsed to an object on read),
// `flagged` stored as 0/1 INTEGER (number at the row boundary; converted to/from
// boolean explicitly since this codebase has no Schema.transform precedent).
const AutomodeEpisodeDbRowSchema = AutomodeEpisode.mapFields(
  Struct.assign({
    review: Schema.fromJsonString(Schema.Unknown),
    flagged: Schema.Number,
  }),
);
type AutomodeEpisodeDbRow = typeof AutomodeEpisodeDbRowSchema.Type;

const decodeEpisode = Schema.decodeUnknownEffect(AutomodeEpisode);

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): AutomodeEpisodeLedgerRepositoryError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makeAutomodeEpisodeLedger = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insertEpisodeRow = SqlSchema.void({
    Request: AutomodeEpisodeDbRowSchema,
    execute: (row) =>
      sql`
        INSERT INTO automode_episodes (
          id,
          episode_id,
          repo,
          goal_id,
          goal_title,
          slice_branch,
          verdict,
          confidence,
          recommendation,
          flagged,
          summary,
          review_json,
          created_at
        )
        VALUES (
          ${row.id},
          ${row.episodeId},
          ${row.repo},
          ${row.goalId},
          ${row.goalTitle},
          ${row.sliceBranch},
          ${row.verdict},
          ${row.confidence},
          ${row.recommendation},
          ${row.flagged},
          ${row.summary},
          ${row.review},
          ${row.createdAt}
        )
        ON CONFLICT (id) DO UPDATE SET
          episode_id = excluded.episode_id,
          repo = excluded.repo,
          goal_id = excluded.goal_id,
          goal_title = excluded.goal_title,
          slice_branch = excluded.slice_branch,
          verdict = excluded.verdict,
          confidence = excluded.confidence,
          recommendation = excluded.recommendation,
          flagged = excluded.flagged,
          summary = excluded.summary,
          review_json = excluded.review_json,
          created_at = excluded.created_at
      `,
  });

  const listAllRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: AutomodeEpisodeDbRowSchema,
    execute: () =>
      sql`
        SELECT
          id,
          episode_id AS "episodeId",
          repo,
          goal_id AS "goalId",
          goal_title AS "goalTitle",
          slice_branch AS "sliceBranch",
          verdict,
          confidence,
          recommendation,
          flagged,
          summary,
          review_json AS "review",
          created_at AS "createdAt"
        FROM automode_episodes
        ORDER BY created_at DESC, id DESC
      `,
  });

  const listByRepoRows = SqlSchema.findAll({
    Request: Schema.Struct({ repo: Schema.String }),
    Result: AutomodeEpisodeDbRowSchema,
    execute: ({ repo }) =>
      sql`
        SELECT
          id,
          episode_id AS "episodeId",
          repo,
          goal_id AS "goalId",
          goal_title AS "goalTitle",
          slice_branch AS "sliceBranch",
          verdict,
          confidence,
          recommendation,
          flagged,
          summary,
          review_json AS "review",
          created_at AS "createdAt"
        FROM automode_episodes
        WHERE repo = ${repo}
        ORDER BY created_at DESC, id DESC
      `,
  });

  const decodeRow = (row: AutomodeEpisodeDbRow) =>
    decodeEpisode({ ...row, flagged: row.flagged !== 0 }).pipe(
      Effect.mapError(toPersistenceDecodeError("AutomodeEpisodeLedger.list_episodes:rowToEpisode")),
    );

  const record_episode: AutomodeEpisodeLedgerShape["record_episode"] = (episode) =>
    insertEpisodeRow({ ...episode, flagged: episode.flagged ? 1 : 0 }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AutomodeEpisodeLedger.record_episode:query",
          "AutomodeEpisodeLedger.record_episode:encodeRequest",
        ),
      ),
    );

  const list_episodes: AutomodeEpisodeLedgerShape["list_episodes"] = (input) =>
    (input.repo === undefined ? listAllRows(undefined) : listByRepoRows({ repo: input.repo })).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AutomodeEpisodeLedger.list_episodes:query",
          "AutomodeEpisodeLedger.list_episodes:decodeRows",
        ),
      ),
      Effect.flatMap((rows) => Effect.forEach(rows, decodeRow, { concurrency: "unbounded" })),
      Effect.map((episodes) =>
        input.limit === undefined ? episodes : episodes.slice(0, input.limit),
      ),
    );

  return { record_episode, list_episodes } satisfies AutomodeEpisodeLedgerShape;
});

export const AutomodeEpisodeLedgerLive = Layer.effect(
  AutomodeEpisodeLedger,
  makeAutomodeEpisodeLedger,
);
