import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("033_EventRetentionArchiveTable", (it) => {
  it.effect("creates orchestration_events_archive table with expected columns and indexes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 32 });
      yield* runMigrations({ toMigrationInclusive: 33 });

      // Table must exist
      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'orchestration_events_archive'
      `;
      assert.strictEqual(tables.length, 1, "orchestration_events_archive table not found");

      // Column names must match orchestration_events schema
      const cols = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(orchestration_events_archive)
      `;
      const colNames = new Set(cols.map((c) => c.name));
      for (const col of [
        "sequence",
        "event_id",
        "aggregate_kind",
        "stream_id",
        "stream_version",
        "event_type",
        "occurred_at",
        "command_id",
        "causation_event_id",
        "correlation_id",
        "actor_kind",
        "payload_json",
        "metadata_json",
      ]) {
        assert.ok(colNames.has(col), `orchestration_events_archive.${col} missing`);
      }

      // All three indexes must exist
      const indexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(orchestration_events_archive)
      `;
      const indexNames = new Set(indexes.map((i) => i.name));
      assert.ok(
        indexNames.has("idx_orch_events_archive_sequence"),
        "idx_orch_events_archive_sequence missing",
      );
      assert.ok(
        indexNames.has("idx_orch_events_archive_stream"),
        "idx_orch_events_archive_stream missing",
      );
      assert.ok(
        indexNames.has("idx_orch_events_archive_event_type"),
        "idx_orch_events_archive_event_type missing",
      );
    }),
  );
});
