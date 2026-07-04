/**
 * Verify that TABLE_FINGERPRINT_QUERIES detects value corruption that
 * preserves row counts — the motivating failure mode (a bad migration
 * corrupting projection values without changing row counts).
 */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { TABLE_FINGERPRINT_QUERIES } from "./db.ts";

// ── helpers ───────────────────────────────────────────────────────────────────

const runWithMemoryDb = <A>(program: Effect.Effect<A, never, SqlClient.SqlClient>): Promise<A> =>
  Effect.runPromise(program.pipe(Effect.provide(NodeSqliteClient.layerMemory())));

/**
 * Seed minimal projection rows — runs all migrations first so columns match
 * the post-016 schema (model_selection_json, default_model_selection_json).
 */
const seedProjectionRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations().pipe(Effect.orDie);

  yield* sql`
		INSERT INTO projection_projects (project_id, title, workspace_root, default_model_selection_json, scripts_json, created_at, updated_at)
		VALUES ('proj-1', 'Test Project', '/workspace', NULL, '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
	`.pipe(Effect.orDie);

  yield* sql`
		INSERT INTO projection_threads (
			thread_id, project_id, title, model_selection_json, runtime_mode,
			interaction_mode, branch, worktree_path, latest_turn_id,
			created_at, updated_at, archived_at, deleted_at,
			latest_user_message_at, pending_approval_count, pending_user_input_count, has_actionable_proposed_plan
		)
		VALUES (
			'thread-1', 'proj-1', 'Test Thread', '{"instanceId":"codex","model":"gpt-5"}', 'full-access',
			'default', NULL, NULL, NULL,
			'2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL, NULL,
			NULL, 0, 0, 0
		)
	`.pipe(Effect.orDie);

  yield* sql`
		INSERT INTO projection_thread_messages (message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at)
		VALUES ('msg-1', 'thread-1', NULL, 'user', 'hello world', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
	`.pipe(Effect.orDie);
});

/**
 * Same seed but with a corrupted message text — same row count, different content.
 * Models the motivating failure: a bad migration corrupts VALUES without changing row counts.
 */
const seedCorruptedProjectionRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* seedProjectionRows;
  yield* sql`
		UPDATE projection_thread_messages SET text = 'CORRUPTED VALUE' WHERE message_id = 'msg-1'
	`.pipe(Effect.orDie);
});

const getFingerprintFor = (table: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const query = TABLE_FINGERPRINT_QUERIES[table];
    if (query === undefined) return null;
    const rows = yield* sql.unsafe<Record<string, unknown>>(query).pipe(Effect.orDie);
    return rows[0] ? Object.values(rows[0])[0] : null;
  });

// ── tests ─────────────────────────────────────────────────────────────────────

it("TABLE_FINGERPRINT_QUERIES is defined for all non-state projection tables", () => {
  const expected = [
    "projection_thread_activities",
    "projection_thread_messages",
    "projection_thread_proposed_plans",
    "projection_thread_visual_plans",
    "projection_thread_sessions",
    "projection_turns",
    "projection_pending_approvals",
    "projection_threads",
    "projection_projects",
  ];
  for (const table of expected) {
    assert.ok(
      table in TABLE_FINGERPRINT_QUERIES,
      `TABLE_FINGERPRINT_QUERIES must have an entry for ${table}`,
    );
  }
});

it("verify fingerprints match when data is identical", async () => {
  const liveHash = await runWithMemoryDb(
    seedProjectionRows.pipe(Effect.flatMap(() => getFingerprintFor("projection_thread_messages"))),
  );

  const rebuiltHash = await runWithMemoryDb(
    seedProjectionRows.pipe(Effect.flatMap(() => getFingerprintFor("projection_thread_messages"))),
  );

  assert.strictEqual(liveHash, rebuiltHash);
  assert.notEqual(liveHash, null); // rows exist and fingerprint is non-null
});

it("verify fingerprints differ when a projection value is corrupted (same row count)", async () => {
  // Corrupted "live" DB — wrong text value but same number of rows.
  const liveHash = await runWithMemoryDb(
    seedCorruptedProjectionRows.pipe(
      Effect.flatMap(() => getFingerprintFor("projection_thread_messages")),
    ),
  );

  // Clean "rebuilt" DB — text matches what events would produce.
  const rebuiltHash = await runWithMemoryDb(
    seedProjectionRows.pipe(Effect.flatMap(() => getFingerprintFor("projection_thread_messages"))),
  );

  // Row counts must be equal (corruption preserves count — that's the whole point).
  const liveCount = await runWithMemoryDb(
    seedCorruptedProjectionRows.pipe(
      Effect.flatMap(() =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const rows = yield* sql<{ readonly n: number }>`
						SELECT COUNT(*) AS n FROM projection_thread_messages
					`.pipe(Effect.orDie);
          return rows[0]?.n ?? 0;
        }),
      ),
    ),
  );
  const rebuiltCount = await runWithMemoryDb(
    seedProjectionRows.pipe(
      Effect.flatMap(() =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const rows = yield* sql<{ readonly n: number }>`
						SELECT COUNT(*) AS n FROM projection_thread_messages
					`.pipe(Effect.orDie);
          return rows[0]?.n ?? 0;
        }),
      ),
    ),
  );

  // Row-count-only check would MISS this — counts are equal.
  assert.strictEqual(
    liveCount,
    rebuiltCount,
    "row counts must be equal (corruption preserves count)",
  );

  // Content-hash check catches it — fingerprints must differ.
  assert.notEqual(liveHash, rebuiltHash, "fingerprints must differ when content is corrupted");
});

it("fingerprints are stable (deterministic) across two identical seedings", async () => {
  // Run the same seed twice independently; hashes must be bit-for-bit identical.
  const [h1, h2] = await Promise.all([
    runWithMemoryDb(
      seedProjectionRows.pipe(Effect.flatMap(() => getFingerprintFor("projection_projects"))),
    ),
    runWithMemoryDb(
      seedProjectionRows.pipe(Effect.flatMap(() => getFingerprintFor("projection_projects"))),
    ),
  ]);

  assert.notEqual(h1, null);
  assert.strictEqual(h1, h2);
});
