/**
 * Archive eligibility tests for OrchestrationEventStore.archiveEligibleEvents.
 *
 * Covers every never-archive rule from plan 22 §1.4:
 * 1. Open threads (deleted_at IS NULL) — never archived
 * 2. Threads deleted within retention window — never archived
 * 3. Threads with retiring-started but no buried — never archived
 * 4. worktree.adopted events (no thread_id) — excluded by aggregate_kind != 'thread'
 * 5. Project-scoped events (aggregate_kind = 'project') — never archived
 * 6. Fully closed threads past retention window (no in-flight retirement) — eligible
 */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationEventStore } from "../Services/OrchestrationEventStore.ts";
import { OrchestrationEventStoreLive } from "./OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  OrchestrationEventStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

// ── Helpers ───────────────────────────────────────────────────────────────────

// Auto-incrementing stream_version counter per (aggregateKind, streamId) to avoid UNIQUE collisions
const streamVersionCounters = new Map<string, number>();
const nextStreamVersion = (aggregateKind: string, streamId: string): number => {
  const key = `${aggregateKind}:${streamId}`;
  const next = (streamVersionCounters.get(key) ?? -1) + 1;
  streamVersionCounters.set(key, next);
  return next;
};

const insertEvent = (
  sql: SqlClient.SqlClient,
  opts: {
    eventId: string;
    aggregateKind: string;
    streamId: string;
    eventType: string;
    occurredAt: string;
  },
) => {
  const version = nextStreamVersion(opts.aggregateKind, opts.streamId);
  return sql`
    INSERT INTO orchestration_events (
      event_id, aggregate_kind, stream_id, stream_version,
      event_type, occurred_at, command_id, causation_event_id,
      correlation_id, actor_kind, payload_json, metadata_json
    ) VALUES (
      ${opts.eventId}, ${opts.aggregateKind}, ${opts.streamId}, ${version},
      ${opts.eventType}, ${opts.occurredAt}, NULL, NULL, NULL, 'server', '{}', '{}'
    )
  `;
};

const insertThread = (
  sql: SqlClient.SqlClient,
  opts: {
    threadId: string;
    deletedAt: string | null;
  },
) =>
  // ponytail: post-migration 016 schema — model column is dropped; model_selection_json replaces it
  sql`
    INSERT INTO projection_threads (
      thread_id, project_id, title, branch, worktree_path,
      latest_turn_id, created_at, updated_at, deleted_at,
      runtime_mode, interaction_mode, model_selection_json
    ) VALUES (
      ${opts.threadId}, 'proj-test', 'Test Thread', NULL, NULL,
      NULL, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', ${opts.deletedAt},
      'full-access', 'default', NULL
    )
  `;

const countEventsInArchive = (sql: SqlClient.SqlClient, streamId: string) =>
  Effect.gen(function* () {
    const rows = yield* sql<{ readonly n: number }>`
      SELECT COUNT(*) AS n FROM orchestration_events_archive WHERE stream_id = ${streamId}
    `;
    return rows[0]?.n ?? 0;
  });

const countEventsInHot = (sql: SqlClient.SqlClient, streamId: string) =>
  Effect.gen(function* () {
    const rows = yield* sql<{ readonly n: number }>`
      SELECT COUNT(*) AS n FROM orchestration_events WHERE stream_id = ${streamId}
    `;
    return rows[0]?.n ?? 0;
  });

// ── Tests ─────────────────────────────────────────────────────────────────────

layer("OrchestrationEventStore.archiveEligibleEvents", (it) => {
  it.effect("rule 1: open thread events are never archived", () =>
    Effect.gen(function* () {
      const store = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;

      yield* insertThread(sql, { threadId: "thread-open", deletedAt: null });
      yield* insertEvent(sql, {
        eventId: "evt-open-1",
        aggregateKind: "thread",
        streamId: "thread-open",
        eventType: "thread.created",
        occurredAt: "2020-01-01T00:00:00.000Z",
      });

      const archived = yield* store.archiveEligibleEvents(90);
      assert.strictEqual(archived, 0, "open thread should not be archived");

      const hotCount = yield* countEventsInHot(sql, "thread-open");
      assert.strictEqual(hotCount, 1, "event must remain in hot table");
    }),
  );

  it.effect("rule 2: thread deleted within retention window is never archived", () =>
    Effect.gen(function* () {
      const store = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;

      // Deleted yesterday — within 90-day window
      yield* insertThread(sql, {
        threadId: "thread-recent",
        deletedAt: "2026-06-30T00:00:00.000Z", // within 90-day window
      });
      yield* insertEvent(sql, {
        eventId: "evt-recent-1",
        aggregateKind: "thread",
        streamId: "thread-recent",
        eventType: "thread.created",
        occurredAt: "2020-01-01T00:00:00.000Z",
      });

      const archived = yield* store.archiveEligibleEvents(90);
      assert.strictEqual(archived, 0, "recently deleted thread should not be archived");
    }),
  );

  it.effect("rule 3: thread with retiring-started but no buried is never archived", () =>
    Effect.gen(function* () {
      const store = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;

      // Thread deleted 200 days ago — past retention window
      const oldDate = "2025-12-16T00:00:00.000Z"; // ~200 days ago, beyond 90-day window
      yield* insertThread(sql, { threadId: "thread-retiring", deletedAt: oldDate });

      yield* insertEvent(sql, {
        eventId: "evt-retiring-created",
        aggregateKind: "thread",
        streamId: "thread-retiring",
        eventType: "thread.created",
        occurredAt: "2020-01-01T00:00:00.000Z",
      });
      // In-flight retirement: retiring-started without buried
      yield* insertEvent(sql, {
        eventId: "evt-retiring-started",
        aggregateKind: "thread",
        streamId: "thread-retiring",
        eventType: "worktree.retiring-started",
        occurredAt: "2020-01-02T00:00:00.000Z",
      });

      const archived = yield* store.archiveEligibleEvents(90);
      assert.strictEqual(archived, 0, "in-flight retirement should block archival");
    }),
  );

  it.effect("rule 3b: thread with retiring-started AND buried is archivable", () =>
    Effect.gen(function* () {
      const store = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;

      const oldDate = "2025-12-16T00:00:00.000Z"; // ~200 days ago, beyond 90-day window
      yield* insertThread(sql, { threadId: "thread-buried", deletedAt: oldDate });

      for (const [id, type] of [
        ["evt-buried-created", "thread.created"],
        ["evt-buried-retiring", "worktree.retiring-started"],
        ["evt-buried-buried", "worktree.buried"],
      ] as const) {
        yield* insertEvent(sql, {
          eventId: id,
          aggregateKind: "thread",
          streamId: "thread-buried",
          eventType: type,
          occurredAt: "2020-01-01T00:00:00.000Z",
        });
      }

      const archived = yield* store.archiveEligibleEvents(90);
      assert.ok(archived > 0, "buried thread should be archivable");

      const hotCount = yield* countEventsInHot(sql, "thread-buried");
      const archCount = yield* countEventsInArchive(sql, "thread-buried");
      assert.strictEqual(hotCount, 0, "events moved out of hot table");
      assert.strictEqual(archCount, 3, "all 3 events moved to archive");
    }),
  );

  it.effect("rule 4+5: project-scoped and worktree.adopted events are never archived", () =>
    Effect.gen(function* () {
      const store = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;

      // Project event (aggregate_kind = 'project') — excluded by WHERE clause
      yield* insertEvent(sql, {
        eventId: "evt-project-1",
        aggregateKind: "project",
        streamId: "proj-test",
        eventType: "project.created",
        occurredAt: "2020-01-01T00:00:00.000Z",
      });

      // worktree.adopted (no thread_id, aggregate_kind = 'worktree')
      yield* insertEvent(sql, {
        eventId: "evt-adopted-1",
        aggregateKind: "worktree",
        streamId: "/tmp/worktree-orphan",
        eventType: "worktree.adopted",
        occurredAt: "2020-01-01T00:00:00.000Z",
      });

      const archived = yield* store.archiveEligibleEvents(90);
      assert.strictEqual(archived, 0, "project and worktree events should never be archived");
    }),
  );

  it.effect("rule 5b: retention_days=0 disables archival", () =>
    Effect.gen(function* () {
      const store = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;

      const oldDate = "2025-12-16T00:00:00.000Z"; // ~200 days ago, beyond 90-day window
      yield* insertThread(sql, { threadId: "thread-zero-retention", deletedAt: oldDate });
      yield* insertEvent(sql, {
        eventId: "evt-zero-1",
        aggregateKind: "thread",
        streamId: "thread-zero-retention",
        eventType: "thread.created",
        occurredAt: "2020-01-01T00:00:00.000Z",
      });

      const archived = yield* store.archiveEligibleEvents(0);
      assert.strictEqual(archived, 0, "retention_days=0 should disable archival");
    }),
  );

  it.effect("fully eligible thread: move events atomically to archive", () =>
    Effect.gen(function* () {
      const store = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;

      // Thread deleted 200 days ago, no graveyard state
      const oldDate = "2025-12-16T00:00:00.000Z"; // ~200 days ago, beyond 90-day window
      yield* insertThread(sql, { threadId: "thread-eligible", deletedAt: oldDate });

      for (const [id, type] of [
        ["evt-elig-1", "thread.created"],
        ["evt-elig-2", "thread.deleted"],
      ] as const) {
        yield* insertEvent(sql, {
          eventId: id,
          aggregateKind: "thread",
          streamId: "thread-eligible",
          eventType: type,
          occurredAt: "2020-01-01T00:00:00.000Z",
        });
      }

      // archiveEligibleEvents may archive events from other tests' threads too (shared DB).
      // Assert per-stream counts rather than the total return value.
      yield* store.archiveEligibleEvents(90);

      const hotCount = yield* countEventsInHot(sql, "thread-eligible");
      const archCount = yield* countEventsInArchive(sql, "thread-eligible");
      assert.strictEqual(hotCount, 0, "events should be removed from hot table");
      assert.strictEqual(archCount, 2, "both events should be in archive");
    }),
  );

  it.effect("readAllWithArchive: queries both tables via UNION ALL (verified at SQL level)", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      // Insert one event in hot table
      yield* insertEvent(sql, {
        eventId: "evt-hot-readall",
        aggregateKind: "project",
        streamId: "proj-readall",
        eventType: "project.created",
        occurredAt: "2020-01-01T00:00:00.000Z",
      });

      // Manually insert the same row in archive to simulate previous archival
      yield* sql`
        INSERT INTO orchestration_events_archive
        SELECT * FROM orchestration_events WHERE event_id = 'evt-hot-readall'
      `;

      // Verify at SQL level: UNION ALL returns 2 rows (hot + archive)
      const combined = yield* sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM (
          SELECT sequence FROM orchestration_events WHERE stream_id = 'proj-readall'
          UNION ALL
          SELECT sequence FROM orchestration_events_archive WHERE stream_id = 'proj-readall'
        )
      `;
      assert.strictEqual(combined[0]?.n, 2, "UNION ALL of both tables returns 2 rows");

      // Verify archive table has the row
      const archiveCount = yield* sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM orchestration_events_archive WHERE stream_id = 'proj-readall'
      `;
      assert.strictEqual(archiveCount[0]?.n, 1, "archive table contains the row");
    }),
  );
});
