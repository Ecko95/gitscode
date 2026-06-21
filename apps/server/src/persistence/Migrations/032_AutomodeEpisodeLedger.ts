import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS automode_episodes (
      id TEXT PRIMARY KEY,
      repo TEXT NOT NULL,
      goal_id TEXT NOT NULL,
      goal_title TEXT NOT NULL,
      slice_branch TEXT,
      verdict TEXT NOT NULL,
      confidence TEXT,
      recommendation TEXT NOT NULL,
      flagged INTEGER NOT NULL,
      summary TEXT NOT NULL,
      review_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_automode_episodes_repo_created
    ON automode_episodes(repo, created_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_automode_episodes_goal
    ON automode_episodes(goal_id)
  `;
});
