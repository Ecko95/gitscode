import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS orchestration_events_archive (
      sequence           INTEGER NOT NULL,
      event_id           TEXT    NOT NULL UNIQUE,
      aggregate_kind     TEXT    NOT NULL,
      stream_id          TEXT    NOT NULL,
      stream_version     INTEGER NOT NULL,
      event_type         TEXT    NOT NULL,
      occurred_at        TEXT    NOT NULL,
      command_id         TEXT,
      causation_event_id TEXT,
      correlation_id     TEXT,
      actor_kind         TEXT    NOT NULL,
      payload_json       TEXT    NOT NULL,
      metadata_json      TEXT    NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_orch_events_archive_sequence
    ON orchestration_events_archive(sequence ASC)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_orch_events_archive_stream
    ON orchestration_events_archive(aggregate_kind, stream_id, sequence ASC)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_orch_events_archive_event_type
    ON orchestration_events_archive(event_type, stream_id)
  `;
});
