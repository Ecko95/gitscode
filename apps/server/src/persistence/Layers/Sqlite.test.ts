import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(SqlitePersistenceMemory);

layer("Sqlite pragmas", (it) => {
  it.effect(
    "applies busy_timeout, wal_autocheckpoint, and synchronous pragmas on connection open",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        const [busyRow] = yield* sql<{ readonly timeout: number }>`PRAGMA busy_timeout`;
        assert.equal(busyRow?.timeout, 30000);

        const [checkpointRow] = yield* sql<{
          readonly wal_autocheckpoint: number;
        }>`PRAGMA wal_autocheckpoint`;
        assert.equal(checkpointRow?.wal_autocheckpoint, 1000);

        const [syncRow] = yield* sql<{ readonly synchronous: number }>`PRAGMA synchronous`;
        // NORMAL = 1
        assert.equal(syncRow?.synchronous, 1);
      }),
  );
});
