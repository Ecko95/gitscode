/**
 * db — Database maintenance CLI commands.
 *
 * t3 db archive-events       — move eligible closed-thread events to archive table
 * t3 db rebuild-projections  — cold-rebuild all projection tables from event stream
 *
 * Both commands require the server to be stopped. A BEGIN EXCLUSIVE attempt is made
 * and the command refuses to run if the lock cannot be acquired.
 */
import { DatabaseSync } from "node:sqlite";

import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as References from "effect/References";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { Command, Flag, GlobalFlag } from "effect/unstable/cli";

import { ServerConfig, type ServerConfigShape } from "../config.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionPipeline } from "../orchestration/Services/ProjectionPipeline.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../persistence/Services/OrchestrationEventStore.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { WorkspacePathsLive } from "../workspace/Layers/WorkspacePaths.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";

// ── Shared flags ──────────────────────────────────────────────────────────────

const dbCommandFlags = {
  baseDir: projectLocationFlags.baseDir,
  db: Flag.string("db").pipe(
    Flag.withDescription("Override the database path (default: resolved from base-dir)."),
    Flag.optional,
  ),
} as const;

// ── Server-running guard ──────────────────────────────────────────────────────

/**
 * Attempt BEGIN EXCLUSIVE; ROLLBACK on the target DB.
 * Dies (not fails) if the server is holding a WAL write lock — CLI can't recover.
 *
 * ponytail: zero new infrastructure — SQLite exclusive lock is the cheapest
 * "is a writer present?" probe available.
 */
const assertServerNotRunning = (dbPath: string): Effect.Effect<void> =>
  Effect.sync(() => {
    // DB may not exist yet (first run) — skip the lock check in that case.
    try {
      const db = new DatabaseSync(dbPath);
      try {
        db.exec("BEGIN EXCLUSIVE; ROLLBACK;");
      } finally {
        db.close();
      }
    } catch (err) {
      const msg =
        `Cannot acquire exclusive lock on '${dbPath}'.\n` +
        `The GITS server appears to be running — stop it before running db maintenance.\n` +
        `Detail: ${String(err)}`;
      throw new Error(msg);
    }
  });

// ── Rebuild sentinel + table list ─────────────────────────────────────────────

// Sentinel row in projection_state: server startup refuses if this exists.
const REBUILD_SENTINEL_PROJECTOR = "__rebuild__";

// Child tables before parent tables to respect future FK constraints.
// AutomodeEpisodeLedger is NOT a projection table — excluded per plan 22.
const PROJECTION_TABLES = [
  "projection_thread_activities",
  "projection_thread_messages",
  "projection_thread_proposed_plans",
  "projection_thread_visual_plans",
  "projection_thread_sessions",
  "projection_turns",
  "projection_pending_approvals",
  "projection_threads",
  "projection_projects",
  "projection_state",
] as const;

// ── archive-events command ────────────────────────────────────────────────────

const DEFAULT_RETENTION_DAYS = 90;

const archiveEventsCommand = Command.make("archive-events", {
  ...dbCommandFlags,
}).pipe(
  Command.withDescription(
    "Move events for fully-closed threads past the retention window to orchestration_events_archive.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveCliAuthConfig(flags, logLevel);
      const dbPath = Option.getOrElse(flags.db, () => config.dbPath);

      const rawDays = parseInt(
        process.env["GITS_EVENT_RETENTION_DAYS"] ?? `${DEFAULT_RETENTION_DAYS}`,
        10,
      );
      const retentionDays =
        Number.isFinite(rawDays) && rawDays >= 0 ? rawDays : DEFAULT_RETENTION_DAYS;

      if (retentionDays === 0) {
        yield* Console.log("GITS_EVENT_RETENTION_DAYS=0 — archival disabled, nothing to do.");
        return;
      }

      yield* assertServerNotRunning(dbPath);

      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true });

      const persistenceLayer = makeSqlitePersistenceLive(dbPath);
      const eventStoreLayer = OrchestrationEventStoreLive.pipe(Layer.provide(persistenceLayer));

      const configLayer = Layer.mergeAll(
        Layer.succeed(ServerConfig, config),
        Layer.succeed(References.MinimumLogLevel, config.logLevel),
        WorkspacePathsLive,
      );
      const archivedCount = yield* Effect.gen(function* () {
        const store = yield* OrchestrationEventStore;
        return yield* store.archiveEligibleEvents(retentionDays);
      }).pipe(Effect.provide(Layer.provideMerge(eventStoreLayer, configLayer)));

      if (archivedCount === 0) {
        yield* Console.log(`No events eligible for archival (retention: ${retentionDays} days).`);
      } else {
        yield* Console.log(
          `Archived ${archivedCount} event(s) (retention: ${retentionDays} days).`,
        );
      }
    }),
  ),
);

// ── rebuild-projections command ───────────────────────────────────────────────

const rebuildProjectionsCommand = Command.make("rebuild-projections", {
  ...dbCommandFlags,
  includeArchive: Flag.boolean("include-archive").pipe(
    Flag.withDescription(
      "Include orchestration_events_archive in the rebuild (slower, full history). Default: hot table only.",
    ),
    Flag.optional,
  ),
  verify: Flag.boolean("verify").pipe(
    Flag.withDescription(
      "Verify mode: replay to an in-memory DB and compare row counts. Read-only.",
    ),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription(
    "Cold-rebuild all projection tables by replaying the event stream. Server must be stopped.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveCliAuthConfig(flags, logLevel);
      const dbPath = Option.getOrElse(flags.db, () => config.dbPath);
      const includeArchive = Option.getOrElse(flags.includeArchive, () => false);
      const verify = Option.getOrElse(flags.verify, () => false);

      yield* assertServerNotRunning(dbPath);

      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true });

      const persistenceLayer = makeSqlitePersistenceLive(dbPath);
      const configLayer = Layer.mergeAll(
        Layer.succeed(ServerConfig, config),
        Layer.succeed(References.MinimumLogLevel, config.logLevel),
        WorkspacePathsLive,
      );
      const eventStoreLayer = OrchestrationEventStoreLive.pipe(
        Layer.provideMerge(persistenceLayer),
        Layer.provideMerge(configLayer),
      );
      const pipelineLayer = OrchestrationProjectionPipelineLive.pipe(
        Layer.provideMerge(eventStoreLayer),
      );
      // fullLayer provides pipeline + persistence for runRebuild/runVerify
      const fullLayer = Layer.provideMerge(pipelineLayer, persistenceLayer);

      if (verify) {
        yield* runVerify(config, includeArchive).pipe(Effect.provide(fullLayer));
        return;
      }

      yield* runRebuild(includeArchive).pipe(Effect.provide(fullLayer));
    }),
  ),
);

// ── Cold rebuild logic ────────────────────────────────────────────────────────

const runRebuild = Effect.fn("runRebuild")(function* (includeArchive: boolean) {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* OrchestrationEventStore;
  const pipeline = yield* OrchestrationProjectionPipeline;

  yield* Console.log("Starting cold projection rebuild...");

  // Write rebuild sentinel so server startup refuses to start if interrupted.
  yield* sql`
    INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
    VALUES (${REBUILD_SENTINEL_PROJECTOR}, 0, datetime('now'))
    ON CONFLICT (projector) DO UPDATE SET
      last_applied_sequence = excluded.last_applied_sequence,
      updated_at = excluded.updated_at
  `.pipe(Effect.orDie);

  // Truncate all projection tables in dependency order.
  yield* sql
    .withTransaction(
      Effect.forEach(
        PROJECTION_TABLES,
        (table) => sql`DELETE FROM ${sql(table)}`.pipe(Effect.orDie),
        { concurrency: 1 },
      ),
    )
    .pipe(Effect.orDie);

  yield* Console.log("Projection tables truncated. Replaying events...");

  const eventStream = includeArchive ? store.readAllWithArchive() : store.readAll();

  let replayCount = 0;
  yield* Stream.runForEach(eventStream, (event) =>
    pipeline.projectEvent(event).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          replayCount += 1;
        }),
      ),
      // ponytail: die on projection failure — CLI can't recover; message in console
      Effect.tapError((err) =>
        Console.error(
          [
            `REBUILD FAILED at sequence=${event.sequence}`,
            `event_type: ${event.type}`,
            `error: ${String(err)}`,
            "",
            "The event at this sequence is not compatible with the current schema.",
            "This means the read model may be corrupted. Do not start the server.",
            "Contact the operator to resolve the schema incompatibility before retrying.",
          ].join("\n"),
        ),
      ),
      Effect.orDie,
    ),
  );

  // Clear sentinel on success.
  yield* sql`DELETE FROM projection_state WHERE projector = ${REBUILD_SENTINEL_PROJECTOR}`.pipe(
    Effect.orDie,
  );

  yield* Console.log(`Rebuild complete. ${replayCount} events replayed.`);
});

// ── Verify mode logic ─────────────────────────────────────────────────────────

/**
 * Replay all events into a fresh :memory: DB and compare per-table row counts
 * against the live DB. Reports MATCH/MISMATCH per table. Read-only.
 *
 * ponytail: row count comparison only — sufficient for human-readable drift detection.
 * Ceiling: identical row counts with different data won't be caught; upgrade to
 * per-row hash if needed.
 */
const runVerify = Effect.fn("runVerify")(function* (
  config: ServerConfigShape,
  includeArchive: boolean,
) {
  const liveSql = yield* SqlClient.SqlClient;
  const liveStore = yield* OrchestrationEventStore;

  yield* Console.log("Verify mode: collecting events from live DB...");

  const allEvents = yield* (
    includeArchive ? liveStore.readAllWithArchive() : liveStore.readAll()
  ).pipe(
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
  );

  yield* Console.log(`Collected ${allEvents.length} events. Replaying into :memory: DB...`);

  // Build in-memory layer with same migrations applied.
  const memSqlLayer = NodeSqliteClient.layerMemory();
  const memPipelineLayer = OrchestrationProjectionPipelineLive.pipe(
    Layer.provide(OrchestrationEventStoreLive),
  );
  const memLayer = Layer.mergeAll(memPipelineLayer, OrchestrationEventStoreLive).pipe(
    Layer.provide(memSqlLayer),
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ServerConfig, config),
        Layer.succeed(References.MinimumLogLevel, config.logLevel),
        WorkspacePathsLive,
      ),
    ),
  );

  yield* Effect.gen(function* () {
    const memPipeline = yield* OrchestrationProjectionPipeline;
    const memSql = yield* SqlClient.SqlClient;

    let replayCount = 0;
    for (const event of allEvents) {
      yield* memPipeline.projectEvent(event).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            replayCount += 1;
          }),
        ),
      );
    }

    yield* Console.log(`Replayed ${replayCount} events. Comparing row counts...`);

    let allMatch = true;
    for (const table of PROJECTION_TABLES.filter((t) => t !== "projection_state")) {
      const liveCount = yield* liveSql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM ${liveSql(table)}
      `.pipe(
        Effect.map((rows) => rows[0]?.n ?? 0),
        Effect.orElseSucceed(() => 0),
      );

      const memCount = yield* memSql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM ${memSql(table)}
      `.pipe(
        Effect.map((rows) => rows[0]?.n ?? 0),
        Effect.orElseSucceed(() => 0),
      );

      const status = liveCount === memCount ? "MATCH" : "MISMATCH";
      if (liveCount !== memCount) allMatch = false;

      yield* Console.log(`  ${status} ${table}: live=${liveCount} memory=${memCount}`);
    }

    if (!allMatch) {
      yield* Console.error("\nVerify FAILED: projection row count mismatch detected.");
      // ponytail: die = unrecoverable CLI exit; typed fail not needed here
      return yield* Effect.die("Verify failed: row count mismatch");
    } else {
      yield* Console.log("\nVerify PASSED: all projection table row counts match.");
    }
  }).pipe(Effect.provide(memLayer));
});

// ── Top-level db command ──────────────────────────────────────────────────────

export const dbCommand = Command.make("db").pipe(
  Command.withDescription("Database maintenance operations (archival, rebuild)."),
  Command.withSubcommands([archiveEventsCommand, rebuildProjectionsCommand]),
);
