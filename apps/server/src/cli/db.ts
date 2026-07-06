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
import {
  makeSqlitePersistenceLive,
  REBUILD_SENTINEL_PROJECTOR,
} from "../persistence/Layers/Sqlite.ts";
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

// Sentinel row in projection_state: server startup refuses if this exists
// (AssertNoInterruptedRebuildLive in persistence/Layers/Sqlite.ts).

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

  // Truncate all projection tables in dependency order, then write the rebuild
  // sentinel INSIDE the same transaction. projection_state is itself truncated,
  // so the sentinel must be inserted after the deletes — a crash before commit
  // rolls everything back; a crash after commit leaves the sentinel for the
  // startup guard (assertNoInterruptedRebuild) to refuse on.
  yield* sql
    .withTransaction(
      Effect.forEach(
        PROJECTION_TABLES,
        (table) => sql`DELETE FROM ${sql(table)}`.pipe(Effect.orDie),
        { concurrency: 1 },
      ).pipe(
        Effect.andThen(
          sql`
            INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
            VALUES (${REBUILD_SENTINEL_PROJECTOR}, 0, datetime('now'))
          `,
        ),
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

// ── Per-table content fingerprint ─────────────────────────────────────────────

/**
 * Key columns chosen per table: columns whose corruption matters (state,
 * ids, json payloads). Not every column — audit timestamps (created_at) are
 * stable; we focus on mutable state and identity.
 *
 * Determinism: group_concat order is unspecified in SQLite unless the input
 * rows are already sorted. We feed a sorted subquery so the concat is stable
 * across both DBs.
 *
 * ponytail: group_concat fingerprint — cheap, no crypto dep, human-readable on diff.
 * Ceiling: hash collision theoretically possible; use sha256 per row if that matters.
 */
/** @internal exported for testing */
export const TABLE_FINGERPRINT_QUERIES: Record<string, string> = {
  // project_id is the PK; title+workspace_root+deleted_at detect rename/delete corruption.
  projection_projects: `
    SELECT group_concat(project_id || '|' || title || '|' || workspace_root || '|' || coalesce(deleted_at,''), char(10))
    FROM (SELECT project_id, title, workspace_root, deleted_at FROM projection_projects ORDER BY project_id)
  `,
  // thread_id PK; project_id+title+deleted_at+archived_at are the mutable state that matters.
  projection_threads: `
    SELECT group_concat(thread_id || '|' || project_id || '|' || title || '|' || coalesce(deleted_at,'') || '|' || coalesce(archived_at,''), char(10))
    FROM (SELECT thread_id, project_id, title, deleted_at, archived_at FROM projection_threads ORDER BY thread_id)
  `,
  // message_id PK; role+text are the corruption-prone fields (text is the actual content).
  projection_thread_messages: `
    SELECT group_concat(message_id || '|' || thread_id || '|' || role || '|' || text, char(10))
    FROM (SELECT message_id, thread_id, role, text FROM projection_thread_messages ORDER BY message_id)
  `,
  // activity_id PK; kind+payload_json capture what each activity says.
  projection_thread_activities: `
    SELECT group_concat(activity_id || '|' || thread_id || '|' || kind || '|' || payload_json, char(10))
    FROM (SELECT activity_id, thread_id, kind, payload_json FROM projection_thread_activities ORDER BY activity_id)
  `,
  // plan_id PK; plan_markdown is the mutable value a bad migration could corrupt.
  projection_thread_proposed_plans: `
    SELECT group_concat(plan_id || '|' || thread_id || '|' || plan_markdown, char(10))
    FROM (SELECT plan_id, thread_id, plan_markdown FROM projection_thread_proposed_plans ORDER BY plan_id)
  `,
  // plan_id PK; content_json is the visual plan body.
  projection_thread_visual_plans: `
    SELECT group_concat(plan_id || '|' || thread_id || '|' || content_json, char(10))
    FROM (SELECT plan_id, thread_id, content_json FROM projection_thread_visual_plans ORDER BY plan_id)
  `,
  // thread_id PK (one session row per thread); status+provider_session_id+last_error are the mutable state.
  projection_thread_sessions: `
    SELECT group_concat(thread_id || '|' || status || '|' || coalesce(provider_session_id,'') || '|' || coalesce(last_error,''), char(10))
    FROM (SELECT thread_id, status, provider_session_id, last_error FROM projection_thread_sessions ORDER BY thread_id)
  `,
  // row_id is AUTOINCREMENT PK; turn_id+state+checkpoint_status are the corruption-prone fields.
  projection_turns: `
    SELECT group_concat(thread_id || '|' || coalesce(turn_id,'') || '|' || state || '|' || coalesce(checkpoint_status,''), char(10))
    FROM (SELECT thread_id, turn_id, state, checkpoint_status FROM projection_turns ORDER BY row_id)
  `,
  // request_id PK; status+decision+resolved_at capture approval lifecycle.
  projection_pending_approvals: `
    SELECT group_concat(request_id || '|' || thread_id || '|' || status || '|' || coalesce(decision,'') || '|' || coalesce(resolved_at,''), char(10))
    FROM (SELECT request_id, thread_id, status, decision, resolved_at FROM projection_pending_approvals ORDER BY request_id)
  `,
};

// ── Verify mode logic ─────────────────────────────────────────────────────────

/**
 * Replay all events into a fresh :memory: DB and compare per-table row counts
 * AND a deterministic content fingerprint (group_concat of key columns, ordered
 * by primary key) against the live DB.
 *
 * Row count check runs first (fast fail). Content fingerprint catches value
 * corruption that preserves row counts — the motivating failure mode.
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

    yield* Console.log(`Replayed ${replayCount} events. Comparing projections...`);

    let allMatch = true;
    const verifyTables = PROJECTION_TABLES.filter((t) => t !== "projection_state");

    for (const table of verifyTables) {
      // Step 1: fast row-count check
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

      if (liveCount !== memCount) {
        allMatch = false;
        yield* Console.log(
          `  MISMATCH ${table}: live=${liveCount} memory=${memCount} (row count differs)`,
        );
        continue;
      }

      // Step 2: content fingerprint — catches value corruption with same row count
      const fingerprintSql = TABLE_FINGERPRINT_QUERIES[table];
      if (fingerprintSql === undefined) {
        // No fingerprint query defined; row count match is sufficient for this table.
        yield* Console.log(`  MATCH ${table}: count=${liveCount}`);
        continue;
      }

      const liveHash = yield* liveSql.unsafe<Record<string, unknown>>(fingerprintSql).pipe(
        Effect.map((rows) => (rows[0] ? Object.values(rows[0])[0] : null)),
        Effect.orElseSucceed(() => null),
      );

      const memHash = yield* memSql.unsafe<Record<string, unknown>>(fingerprintSql).pipe(
        Effect.map((rows) => (rows[0] ? Object.values(rows[0])[0] : null)),
        Effect.orElseSucceed(() => null),
      );

      if (liveHash !== memHash) {
        allMatch = false;
        yield* Console.log(
          `  MISMATCH ${table}: count=${liveCount} but content differs (corruption detected)`,
        );
      } else {
        yield* Console.log(`  MATCH ${table}: count=${liveCount}`);
      }
    }

    if (!allMatch) {
      yield* Console.error("\nVerify FAILED: projection mismatch detected.");
      // ponytail: die = unrecoverable CLI exit; typed fail not needed here
      return yield* Effect.die("Verify failed: projection mismatch");
    } else {
      yield* Console.log("\nVerify PASSED: all projection tables match (counts + content).");
    }
  }).pipe(Effect.provide(memLayer));
});

// ── Top-level db command ──────────────────────────────────────────────────────

export const dbCommand = Command.make("db").pipe(
  Command.withDescription("Database maintenance operations (archival, rebuild)."),
  Command.withSubcommands([archiveEventsCommand, rebuildProjectionsCommand]),
);
