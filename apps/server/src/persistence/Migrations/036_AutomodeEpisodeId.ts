import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

// Episode thread (decision 23): nullable for pre-episode rows. The `id` PK is NOT the
// episode id — reject→approve on one proposal can yield two goals sharing an episodeId.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE automode_episodes ADD COLUMN episode_id TEXT`;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_automode_episodes_episode
    ON automode_episodes(episode_id)
  `;
});
