/**
 * All-migrations chain fixture test (001 → latest).
 *
 * Intent: guard the ENTIRE migration chain's future integrity.
 * This test MUST fail on data loss or chain breakage.
 * It MUST NOT fail on additive schema evolution (new columns, new tables, new indexes).
 *
 * Assertions are on invariants:
 *   - correct number of migrations ran
 *   - key tables and columns exist post-chain
 *   - seeded rows survived with the transformations migrations promise
 *
 * Per-migration retro tests remain required for future data-mutating migrations
 * (review checklist) — those are NOT this test's scope.
 *
 * Domains seeded (representative, high blast-radius):
 *   1. orchestration_events — event log with legacy model/modelOptions payloads
 *   2. projection_projects  — project rows with legacy default_model
 *   3. projection_threads   — thread rows with legacy model column
 *   4. auth_sessions        — auth domain rows (seeded after migration 020)
 */

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { migrationEntries, runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("AllMigrations.fixture", (it) => {
  it.effect("runs 001→latest, seeds 4 domains, asserts chain integrity and data invariants", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      // ── Phase 1: seed at migration 015 ─────────────────────────────────────
      // Tables exist: orchestration_events, projection_projects, projection_threads.
      // At this point threads still have the legacy `model TEXT` column (not yet
      // canonicalized by 016). Events still carry modelOptions as an object.
      {
        yield* runMigrations({ toMigrationInclusive: 15 });

        yield* sql`
					INSERT INTO projection_projects (
						project_id, title, workspace_root, default_model, scripts_json,
						created_at, updated_at, deleted_at
					) VALUES
						('proj-a', 'Alpha', '/tmp/alpha', 'claude-sonnet-4-6', '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL),
						('proj-b', 'Beta',  '/tmp/beta',  'gpt-5.4',          '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL),
						('proj-c', 'Gamma', '/tmp/gamma', NULL,               '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL)
				`;

        yield* sql`
					INSERT INTO projection_threads (
						thread_id, project_id, title, model, branch, worktree_path,
						latest_turn_id, created_at, updated_at, deleted_at,
						runtime_mode, interaction_mode
					) VALUES
						('t-claude', 'proj-a', 'Claude thread', 'claude-sonnet-4-6', NULL, NULL, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL, 'full-access', 'default'),
						('t-codex',  'proj-b', 'Codex thread',  'gpt-5.4',          NULL, NULL, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL, 'full-access', 'default')
				`;

        yield* sql`
          INSERT INTO projection_thread_sessions (
            thread_id,
            status,
            provider_name,
            provider_session_id,
            provider_thread_id,
            runtime_mode,
            active_turn_id,
            last_error,
            updated_at
          ) VALUES (
            't-codex',
            'ready',
            'codex',
            'legacy-session',
            'legacy-thread',
            'full-access',
            NULL,
            NULL,
            '2026-01-01T00:00:00.000Z'
          )
        `;

        // orchestration event with legacy modelOptions object shape (pre-016)
        yield* sql`
					INSERT INTO orchestration_events (
						event_id, aggregate_kind, stream_id, stream_version, event_type,
						occurred_at, command_id, causation_event_id, correlation_id,
						actor_kind, payload_json, metadata_json
					) VALUES (
						'evt-thread-created', 'thread', 'stream-t1', 1, 'thread.created',
						'2026-01-01T00:00:00.000Z', 'cmd-1', NULL, 'corr-1', 'user',
						'{"threadId":"t-claude","projectId":"proj-a","title":"Claude thread","model":"claude-sonnet-4-6","modelOptions":{"claudeAgent":{"effort":"max"}},"runtimeMode":"full-access","interactionMode":"default","branch":null,"worktreePath":null,"createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"}',
						'{}'
					)
				`;
      }

      // ── Phase 2: run to 020 to get auth tables, then seed auth domain ──────
      {
        yield* runMigrations({ toMigrationInclusive: 20 });

        yield* sql`
					INSERT INTO auth_sessions (
						session_id, subject, role, method, issued_at, expires_at, revoked_at
					) VALUES
						('sess-1', 'user-abc', 'user', 'pairing', '2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z', NULL),
						('sess-2', 'user-xyz', 'admin', 'pairing', '2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z')
				`;
      }

      // ── Phase 3: run to latest (migration 033) ─────────────────────────────
      const executed = yield* runMigrations();

      // ── Assertion 1: all migrations ran ────────────────────────────────────
      // migrationEntries is the source of truth; runMigrations returns only what
      // was executed in this call, so we query the tracking table instead.
      const allRan = yield* sql<{ readonly count: number }>`
				SELECT COUNT(*) AS count FROM effect_sql_migrations
			`;
      assert.strictEqual(
        allRan[0]!.count,
        migrationEntries.length,
        `Expected ${migrationEntries.length} migrations tracked, got ${allRan[0]!.count}`,
      );

      // ── Assertion 2: key tables exist ──────────────────────────────────────
      const tables = yield* sql<{ readonly name: string }>`
				SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name
			`;
      const tableNames = new Set(tables.map((r) => r.name));

      for (const expected of [
        "orchestration_events",
        "orchestration_command_receipts",
        "projection_projects",
        "projection_threads",
        "projection_thread_sessions",
        "projection_thread_messages",
        "projection_thread_activities",
        "projection_turns",
        "projection_pending_approvals",
        "projection_thread_proposed_plans",
        "provider_session_runtime",
        "auth_pairing_links",
        "auth_sessions",
        "projection_thread_visual_plans",
        "automode_episodes",
        "orchestration_events_archive",
        "web_push_subscriptions",
        "effect_sql_migrations",
      ]) {
        assert.ok(tableNames.has(expected), `Table ${expected} missing after full migration chain`);
      }

      // ── Assertion 3: key post-chain columns exist ──────────────────────────
      // projection_threads: model_selection_json (added by 016), archived_at (017),
      //   latest_user_message_at (023), fork parentage (034)
      const threadCols = yield* sql<{
        readonly name: string;
      }>`PRAGMA table_info(projection_threads)`;
      const threadColNames = new Set(threadCols.map((c) => c.name));
      for (const col of [
        "model_selection_json",
        "archived_at",
        "latest_user_message_at",
        "parent_thread_id",
        "forked_from_message_id",
      ]) {
        assert.ok(threadColNames.has(col), `projection_threads.${col} missing`);
      }

      const messageCols = yield* sql<{
        readonly name: string;
      }>`PRAGMA table_info(projection_thread_messages)`;
      const messageColNames = new Set(messageCols.map((c) => c.name));
      assert.ok(
        messageColNames.has("provider_message_id"),
        "projection_thread_messages.provider_message_id missing",
      );

      // automode_episodes: episode_id (added by 036)
      const episodeCols = yield* sql<{
        readonly name: string;
      }>`PRAGMA table_info(automode_episodes)`;
      const episodeColNames = new Set(episodeCols.map((c) => c.name));
      assert.ok(episodeColNames.has("episode_id"), "automode_episodes.episode_id missing");

      // projection_projects: default_model_selection_json (016), repository profile override (037)
      const projCols = yield* sql<{
        readonly name: string;
      }>`PRAGMA table_info(projection_projects)`;
      const projColNames = new Set(projCols.map((c) => c.name));
      assert.ok(
        projColNames.has("default_model_selection_json"),
        "projection_projects.default_model_selection_json missing",
      );
      assert.ok(
        projColNames.has("repository_profile_override"),
        "projection_projects.repository_profile_override missing",
      );

      // auth_sessions: client_label, client_device_type (added by 021), last_connected_at (022)
      const sessionCols = yield* sql<{ readonly name: string }>`PRAGMA table_info(auth_sessions)`;
      const sessionColNames = new Set(sessionCols.map((c) => c.name));
      for (const col of ["client_label", "client_device_type", "last_connected_at"]) {
        assert.ok(sessionColNames.has(col), `auth_sessions.${col} missing`);
      }

      // projection_thread_sessions: provider routing columns (added by 028 and 038)
      const threadSessionCols = yield* sql<{
        readonly name: string;
      }>`PRAGMA table_info(projection_thread_sessions)`;
      const threadSessionColNames = new Set(threadSessionCols.map((c) => c.name));
      assert.ok(
        threadSessionColNames.has("provider_instance_id"),
        "projection_thread_sessions.provider_instance_id missing",
      );
      assert.ok(
        threadSessionColNames.has("work_personal_fallback_instance_id"),
        "projection_thread_sessions.work_personal_fallback_instance_id missing",
      );
      const legacySessionRows = yield* sql<{
        readonly workPersonalFallbackInstanceId: string | null;
      }>`
        SELECT work_personal_fallback_instance_id AS "workPersonalFallbackInstanceId"
        FROM projection_thread_sessions
        WHERE thread_id = 't-codex'
      `;
      assert.deepStrictEqual(legacySessionRows, [{ workPersonalFallbackInstanceId: null }]);

      // ── Assertion 4: seeded project rows survived + model selection canonicalized ──
      // Migration 016 converts default_model → default_model_selection_json
      // Migration 026 reshapes options from object to array (no options here, so shape unchanged)
      const projects = yield* sql<{
        readonly projectId: string;
        readonly defaultModelSelection: string | null;
        readonly repositoryProfileOverride: string | null;
      }>`
				SELECT project_id AS "projectId",
          default_model_selection_json AS "defaultModelSelection",
          repository_profile_override AS "repositoryProfileOverride"
				FROM projection_projects
				ORDER BY project_id
			`;

      // All 3 seeded rows must still exist
      assert.strictEqual(projects.length, 3, "Expected 3 seeded project rows");

      const projA = projects.find((p) => p.projectId === "proj-a")!;
      assert.ok(projA, "proj-a missing");
      assert.strictEqual(projA.repositoryProfileOverride, null);
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      assert.deepStrictEqual(JSON.parse(projA.defaultModelSelection!), {
        provider: "claudeAgent",
        model: "claude-sonnet-4-6",
      });

      const projB = projects.find((p) => p.projectId === "proj-b")!;
      assert.ok(projB, "proj-b missing");
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      assert.deepStrictEqual(JSON.parse(projB.defaultModelSelection!), {
        provider: "codex",
        model: "gpt-5.4",
      });

      const projC = projects.find((p) => p.projectId === "proj-c")!;
      assert.ok(projC, "proj-c missing");
      assert.strictEqual(projC.defaultModelSelection, null);

      // ── Assertion 5: seeded thread rows survived + model selection canonicalized ──
      const threads = yield* sql<{
        readonly threadId: string;
        readonly modelSelection: string | null;
      }>`
				SELECT thread_id AS "threadId", model_selection_json AS "modelSelection"
				FROM projection_threads
				ORDER BY thread_id
			`;

      assert.strictEqual(threads.length, 2, "Expected 2 seeded thread rows");

      const tClaude = threads.find((t) => t.threadId === "t-claude")!;
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      assert.deepStrictEqual(JSON.parse(tClaude.modelSelection!), {
        provider: "claudeAgent",
        model: "claude-sonnet-4-6",
      });

      const tCodex = threads.find((t) => t.threadId === "t-codex")!;
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      assert.deepStrictEqual(JSON.parse(tCodex.modelSelection!), {
        provider: "codex",
        model: "gpt-5.4",
      });

      // ── Assertion 6: seeded event survived + migrated to modelSelection shape ──
      const events = yield* sql<{
        readonly eventId: string;
        readonly payloadJson: string;
      }>`
				SELECT event_id AS "eventId", payload_json AS "payloadJson"
				FROM orchestration_events
				ORDER BY sequence
			`;

      assert.strictEqual(events.length, 1, "Expected 1 seeded orchestration event");
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const evtPayload = JSON.parse(events[0]!.payloadJson) as Record<string, unknown>;
      assert.strictEqual(evtPayload["threadId"], "t-claude", "event threadId survived");
      // Migration 016 must have rewritten modelOptions → modelSelection
      assert.ok(
        "modelSelection" in evtPayload,
        "modelSelection missing in event payload after migration 016",
      );
      assert.ok(
        !("model" in evtPayload),
        "legacy model field should be absent after migration 016",
      );

      // ── Assertion 7: seeded auth sessions survived ─────────────────────────
      const sessions = yield* sql<{
        readonly sessionId: string;
        readonly subject: string;
        readonly revokedAt: string | null;
      }>`
				SELECT session_id AS "sessionId", subject, revoked_at AS "revokedAt"
				FROM auth_sessions
				ORDER BY session_id
			`;

      assert.strictEqual(sessions.length, 2, "Expected 2 seeded auth sessions");
      assert.strictEqual(sessions[0]!.subject, "user-abc");
      assert.strictEqual(sessions[0]!.revokedAt, null);
      assert.strictEqual(sessions[1]!.revokedAt, "2026-06-01T00:00:00.000Z");

      // ── Assertion 8: executed return value is non-empty on incremental run ──
      // (The last runMigrations() ran from 021→033 — must have applied migrations)
      assert.ok(
        executed.length > 0,
        "Final runMigrations() should have applied migrations 021→032",
      );
    }),
  );
});
