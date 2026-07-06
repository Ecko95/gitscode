import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import { ServerConfig } from "../../config.ts";

type RuntimeSqliteLayerConfig = {
  readonly filename: string;
  readonly spanAttributes?: Record<string, unknown>;
};

type Loader = {
  layer: (config: RuntimeSqliteLayerConfig) => Layer.Layer<SqlClient.SqlClient>;
};
const defaultSqliteClientLoaders = {
  bun: () => import("@effect/sql-sqlite-bun/SqliteClient"),
  node: () => import("../NodeSqliteClient.ts"),
} satisfies Record<string, () => Promise<Loader>>;

const makeRuntimeSqliteLayer = Effect.fn("makeRuntimeSqliteLayer")(function* (
  config: RuntimeSqliteLayerConfig,
) {
  const runtime = process.versions.bun !== undefined ? "bun" : "node";
  const loader = defaultSqliteClientLoaders[runtime];
  const clientModule = yield* Effect.promise<Loader>(loader);
  return clientModule.layer(config);
}, Layer.unwrap);

const setup = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`PRAGMA journal_mode = WAL;`;
    yield* sql`PRAGMA foreign_keys = ON;`;
    // ponytail: fixed values — busy_timeout/wal_autocheckpoint/synchronous tuned for target concurrency (audit fix #10)
    yield* sql`PRAGMA busy_timeout = 30000;`;
    yield* sql`PRAGMA wal_autocheckpoint = 1000;`;
    yield* sql`PRAGMA synchronous = NORMAL;`;
    yield* runMigrations();
  }),
);

// Sentinel row written by `t3 db rebuild-projections` before replay and
// cleared on success. If present at server boot, a rebuild was interrupted
// and the projections are silently incomplete — refuse to start.
export const REBUILD_SENTINEL_PROJECTOR = "__rebuild__";

/** Server-only boot guard — NOT part of the shared setup layer, because the
 * rebuild CLI itself must be able to open the DB while the sentinel exists. */
export const AssertNoInterruptedRebuildLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ projector: string }>`
      SELECT projector FROM projection_state
      WHERE projector = ${REBUILD_SENTINEL_PROJECTOR}
      LIMIT 1
    `.pipe(
      // projection_state may not exist yet on a fresh DB — that's fine.
      Effect.orElseSucceed(() => []),
    );
    if (rows.length > 0) {
      return yield* Effect.die(
        new Error(
          "A projection rebuild was interrupted (rebuild sentinel present). " +
            "The read model is incomplete. Run `t3 db rebuild-projections` to completion before starting the server.",
        ),
      );
    }
  }),
);

export const makeSqlitePersistenceLive = Effect.fn("makeSqlitePersistenceLive")(function* (
  dbPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true });

  return Layer.provideMerge(
    setup,
    makeRuntimeSqliteLayer({
      filename: dbPath,
      spanAttributes: {
        "db.name": path.basename(dbPath),
        "service.name": "t3-server",
      },
    }),
  );
}, Layer.unwrap);

export const SqlitePersistenceMemory = Layer.provideMerge(
  setup,
  makeRuntimeSqliteLayer({ filename: ":memory:" }),
);

export const layerConfig = Layer.unwrap(
  Effect.map(Effect.service(ServerConfig), ({ dbPath }) => makeSqlitePersistenceLive(dbPath)),
);
