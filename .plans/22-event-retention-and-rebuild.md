# Plan 22 — Event Retention + Projection Rebuild (W4.5 Design)

**Status: PENDING OPERATOR APPROVAL** — involves a persistence migration and a
cold-rebuild command that truncates projection tables. Do not implement until
approved.

---

## Problem

Two P0/P1 audit findings:

1. `orchestration_events` grows forever. No archival, no pruning. On a busy
   instance this is unbounded disk growth with no operational knob to slow it.

2. Projections are computed once (bootstrap replay) and then incrementally
   applied live. There is no way to verify correctness or recover from silent
   read-model corruption caused by a bad migration backfill or a projector bug.
   One corrupt migration = undetectable drift, no recovery path short of
   deleting the DB.

---

## Constraint: Graveyard Event History (Plan 21 / W2.x)

Plan 21 (worktree graveyard, approved on `docs/plan-graveyard-design`) adds
three event types to the store:

- `worktree.retiring-started` (keyed to `threadId`, `worktreePath`)
- `worktree.buried` (keyed to `threadId`, `worktreePath`)
- `worktree.adopted` (no `threadId` — orphan adoption path)

The graveyard reaper (W2.3) and the adoption scanner (W2.3) read these events
to resume interrupted retirements and to detect orphans. **Retention must
never archive graveyard events for a worktree path that does not yet have a
`worktree.buried` event** — that would silently make a retiring worktree
invisible to the recovery path on next startup, breaking Plan 21's crash
recovery guarantee.

`worktree.adopted` events carry no `threadId`; they must not be treated as
thread-scoped and are therefore exempt from thread-based retention by
definition.

---

## 1. Retention Design

### 1.1 What "closed thread" means

A thread is closed when **both** of the following are true in the projection:

- `projection_threads.deleted_at IS NOT NULL` — the thread has received a
  `thread.deleted` event and the `threads` projector has applied it.
- No in-flight `worktree.retiring-started` without a matching
  `worktree.buried` event exists for that `thread_id` in
  `orchestration_events`.

Evidence from the projector:

- `applyThreadsProjection` sets `deletedAt` on receipt of `thread.deleted`
  (line 688 of `ProjectionPipeline.ts`).
- The reaper (`ProviderSessionReaper`) and `ThreadDeletionReactor` are the
  only callers that trigger `thread.deleted`, after which no further
  thread-scoped commands are legal (enforced by command invariants).
- "Open" threads (`deleted_at IS NULL`) and "archived" threads
  (`archived_at IS NOT NULL AND deleted_at IS NULL`) are **never** candidates
  for retention — archived is a user-visible dormant state, not a terminal
  one.

Projects are not thread-scoped. A project may outlive all its threads.
Project events (`project.created`, `project.meta-updated`, `project.deleted`)
are **not archived under this plan** — there are few of them and they carry
no bulk.

### 1.2 Archive mechanism: separate table (`orchestration_events_archive`)

**Chosen: separate table in the same SQLite database.**

Rationale vs. export files:

- Export files (NDJSON) require a file-management layer, rotation logic, and
  a separate reader for rebuild-from-archive. The rebuild CLI would need to
  merge two sources (archive files + live table), complicating the replay
  path.
- The archive table is schema-compatible with `orchestration_events`
  (identical columns, same indexes useful for rebuild), queryable via SQL,
  and trivially included in a full `VACUUM` or `sqlite3 .dump` backup.
- SQLite `INSERT INTO ... SELECT` + `DELETE` is transactional; no partial
  archive state is possible.
- Recovery is: connect to the DB, query both tables. No file I/O layer.

The archive table holds the **same row shape** as `orchestration_events` so
the rebuild command can `UNION ALL` both tables ordered by `sequence` without
column mapping.

### 1.3 Knob: `GITS_EVENT_RETENTION_DAYS`

**Default: 90 days.**

Justification: a thread that has been deleted for 90 days has no live
references in any projection. The worktree graveyard's `buried` predicate
is satisfied before deletion fires (the reaper buries before the deletion
event is emitted). 90 days gives operators 3 months to notice a rebuild need
before events are out of reach. Instances with high event volume can lower
this; long-running research/audit installations can raise it.

`0` = disabled (no archival runs). Any value < 0 is treated as 0.

### 1.4 What is NEVER archived

The following events must never be moved to the archive table regardless of
thread closed status or age:

| Exclusion | Reason |
|-----------|--------|
| Events whose `thread_id` has no `worktree.buried` event but has a `worktree.retiring-started` event | Graveyard crash-recovery depends on these |
| `worktree.adopted` events | No `thread_id`; not thread-scoped; graveyard orphan scanner needs them |
| Events on threads where `projection_threads.deleted_at IS NULL` | Thread still open or only archived |
| Events on threads deleted within the past `GITS_EVENT_RETENTION_DAYS` days | Cooling-off period |
| Project-scoped events (`aggregate_kind = 'project'`) | Low volume; no audit benefit from archiving |

Concretely, the archival SELECT criterion is:

```sql
-- Eligible stream_ids (thread_ids) for archival:
SELECT e.stream_id
FROM orchestration_events e
INNER JOIN projection_threads t ON t.thread_id = e.stream_id
WHERE t.deleted_at IS NOT NULL
  AND t.deleted_at < datetime('now', '-' || :retention_days || ' days')
  AND e.aggregate_kind = 'thread'
  AND NOT EXISTS (
    SELECT 1 FROM orchestration_events g
    WHERE g.stream_id = e.stream_id
      AND g.event_type = 'worktree.retiring-started'
      AND NOT EXISTS (
        SELECT 1 FROM orchestration_events b
        WHERE b.stream_id = g.stream_id
          AND b.event_type = 'worktree.buried'
      )
  )
GROUP BY e.stream_id
```

All events for qualifying stream_ids are then moved atomically:

```sql
BEGIN;
INSERT INTO orchestration_events_archive SELECT * FROM orchestration_events
  WHERE stream_id IN (<qualifying_stream_ids>);
DELETE FROM orchestration_events
  WHERE stream_id IN (<qualifying_stream_ids>);
COMMIT;
```

### 1.5 When archival runs

Archival is **manual / operator-triggered** via the CLI (see section 2.2).
No background scheduler is introduced in this plan (cut — see section 6).
Operators may call it from a cron job at the OS level if desired.

---

## 2. Rebuild Design

### 2.1 CLI invocation shape

The rebuild command rides the existing Effect CLI mechanism (`bin.ts` →
`Command.make` → `Command.withSubcommands`), following the same pattern as
`projectCommand` in `cli/project.ts`. A new top-level `db` subcommand groups
DB maintenance operations:

```
t3 db rebuild-projections [--verify] [--db <path>]
t3 db archive-events [--db <path>]
```

`t3 db rebuild-projections`
: Cold-rebuild: truncates all projection tables, resets `projection_state`,
  then replays all events from `orchestration_events` + `orchestration_events_archive`
  (UNION ALL, ordered by sequence ascending) through the existing
  `ProjectionPipeline` projectors.

`t3 db rebuild-projections --verify`
: Verify mode: replays to a temp set of in-memory tables (or a copy DB),
  then diffs row counts + a hash of key columns against the live projections.
  Reports divergence; does not write to the live DB.

`t3 db archive-events`
: Runs the archival step described in 1.4. Prints count of events moved.

Both commands require the server to be **stopped** before running. The
command must detect a running server lock (check `wal` file or a PID lock
file) and refuse to run if the server is live. This is the same constraint
as SQLite WAL-mode hot backup — we simply fail fast with a clear message
rather than implement online rebuild (cut — section 6).

`--db <path>` overrides the default database path from `ServerConfig`.

### 2.2 Cold-rebuild procedure

1. Validate: server not running (lock check). Fail hard if running.
2. Begin a single SQLite transaction.
3. Truncate projection tables in dependency order (child before parent to
   avoid FK issues if FKs are ever added):

   ```sql
   DELETE FROM projection_thread_activities;
   DELETE FROM projection_thread_messages;
   DELETE FROM projection_thread_proposed_plans;
   DELETE FROM projection_thread_visual_plans;
   DELETE FROM projection_thread_sessions;
   DELETE FROM projection_turns;
   DELETE FROM projection_pending_approvals;
   DELETE FROM projection_threads;
   DELETE FROM projection_projects;
   DELETE FROM projection_state;
   -- AutomodeEpisodeLedger is NOT a projection; do not truncate it.
   -- ProjectionCheckpoints is a view over projection_turns; not a separate table.
   ```

4. Commit the truncation transaction.
5. Open a streaming cursor over events:

   ```sql
   SELECT * FROM orchestration_events
   UNION ALL
   SELECT * FROM orchestration_events_archive
   ORDER BY sequence ASC
   ```

6. Feed events one by one through the `ProjectionPipeline` projectors using
   the existing `projectEvent` path (same code as live ingestion). Each event
   is committed per-projector inside `sql.withTransaction` as the pipeline
   already does — no transaction spanning the full replay.
7. On decode failure: **fail hard and loud**. Print the failing event's
   `sequence`, `event_type`, and raw `payload_json`. Do not skip. Exit
   non-zero. This is the primary motivation: decode failures surface the
   exact event that is incompatible with the current schema.
8. On SQL failure: same — fail hard, print context.
9. On success: print `Rebuild complete. N events replayed.`

### 2.3 Verify mode (drift detection)

Verify mode is the "lazy" implementation — it runs the rebuild against a
second in-memory (`:memory:`) SQLite connection, then compares row counts
and CRC of a key-column set per table against the live DB:

1. Open a `:memory:` DB, run `MigrationsLive` against it.
2. Replay all events through the in-memory projectors (same pipeline code,
   different SQL connection).
3. For each projection table, compare:
   - Row count
   - `SUM(CRC32(primary_key_columns || updated_at))` or equivalent (SQLite
     has no native CRC; use `COUNT(*) + GROUP_CONCAT(pk ORDER BY pk)` hash
     as a proxy — ponytail: cheap enough for human-readable diff, not a
     security hash)
4. Report per-table MATCH / MISMATCH with counts. Exit non-zero on any
   mismatch.
5. This is offline-only (server must be stopped) so the live DB is stable
   during the compare.

### 2.4 Expected runtime

From W4.1 baseline: ~55 events/s end-to-end at 10 concurrent sessions in
in-memory SQLite on WSL2. Cold rebuild is serial replay — no queue
contention, no command decider, no receipt check — so throughput should be
higher (2–4×). Rough estimate: **100–200 events/s on disk SQLite**.

A database with 100k events (heavy usage, ~1 year): 500s–1000s (8–17 min).

With 90-day retention default, `orchestration_events` on a typical GITS
instance should stay under 50k events in the hot table; rebuild of just the
hot table would be 4–8 min. The archive table does not need to be replayed
for a live rebuild — only the hot table events from the last 90 days plus
any non-archived project events. Operator can choose to include archive
events with a `--include-archive` flag (off by default, so normal rebuild
is fast).

---

## 3. Migration

**PENDING OPERATOR APPROVAL — number assigned by the orchestrator at
implementation time (next available after 032; do not claim 033 until
in-flight PRs are merged and the number confirmed).**

```sql
-- Migration NNN_EventRetentionArchiveTable
-- Creates the archive table with identical schema to orchestration_events.
-- No data movement at migration time — archival is manual/CLI-triggered.

CREATE TABLE IF NOT EXISTS orchestration_events_archive (
  sequence           INTEGER NOT NULL,    -- preserved original sequence, NOT AUTOINCREMENT
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
);

-- Index for rebuild streaming (ORDER BY sequence ASC in UNION ALL)
CREATE INDEX IF NOT EXISTS idx_orch_events_archive_sequence
  ON orchestration_events_archive(sequence ASC);

-- Index for per-stream queries (graveyard recovery scanning the archive)
CREATE INDEX IF NOT EXISTS idx_orch_events_archive_stream
  ON orchestration_events_archive(aggregate_kind, stream_id, sequence ASC);

-- Index for event_type queries (graveyard burial predicate scan)
CREATE INDEX IF NOT EXISTS idx_orch_events_archive_event_type
  ON orchestration_events_archive(event_type, stream_id);
```

Note: `sequence` in the archive table is not AUTOINCREMENT — it preserves
the original sequence values from the live table to maintain replay ordering
in `UNION ALL ORDER BY sequence ASC`.

The `effect_sql_migrations` tracking table records this migration; it will be
run once automatically by `MigrationsLive` on next server start after
deployment, zero downtime (SQLite DDL is fast, no rows touched).

---

## 4. Failure Modes

### 4.1 Rebuild interrupted mid-way

If the process is killed during step 5–6 (event replay):

- Projection tables are partially populated (some events applied, some not).
- `projection_state` rows reflect the last committed sequence per projector.
- On next cold-rebuild attempt: the operator must re-run `t3 db rebuild-projections`.
  The command will truncate again from scratch. Partial state is safe to re-truncate.
- If the server is started instead: the `bootstrap` path in `ProjectionPipeline`
  will resume from the last committed sequence, which may be in the middle of
  the rebuilt state — this is **not safe** after a failed rebuild because the
  truncated tables may be inconsistent. Document: always re-run rebuild if
  interrupted, do not start the server with partial projection state.

Mitigation: the cold-rebuild should write a `REBUILDING` sentinel row to
`projection_state` (e.g. `projector = '__rebuild__'`) at the start and
delete it on success. Server startup checks for this sentinel and refuses to
start, printing a clear error: "Projection rebuild was interrupted. Run
`t3 db rebuild-projections` to complete it."

### 4.2 Archive-then-crash

The archival is a single `BEGIN; INSERT … SELECT; DELETE; COMMIT;` transaction.
SQLite WAL mode guarantees that either both the insert and delete commit, or
neither does. A crash mid-transaction leaves the live table intact. No
partial archive state is possible.

### 4.3 Replay hits an event the current schema can't decode

This is the motivating corruption case. The event's `payload_json` is valid
JSON that the current `OrchestrationEvent` schema decoder rejects (e.g. a
field added in a later schema version that now has a tighter constraint, or
a field removed that is now required).

Behavior: the rebuild must **fail hard and loud**, not skip.

Implementation: the projector's `apply` function receives an already-decoded
`OrchestrationEvent`. The decode step happens in `readFromSequence` (the
event store's streaming path). If decode fails, the stream emits an
`OrchestrationEventStoreError`. The rebuild must not use
`Effect.catch` to swallow this error — let it propagate to the CLI handler,
which prints:

```
REBUILD FAILED at sequence=<N>
event_type: <type>
payload_json: <raw JSON>
error: <decode error message>

The event at this sequence is not compatible with the current schema.
This means the read model may be corrupted. Do not start the server.
Contact the operator to resolve the schema incompatibility before retrying.
```

Exit code non-zero. The `__rebuild__` sentinel is not cleared, so the server
refuses to start until the operator resolves the issue.

### 4.4 Verify mode false negative

Verify mode uses in-memory SQLite which avoids disk I/O; it assumes the
schema in `:memory:` matches the live DB. If the live DB has a migration the
in-memory DB does not (or vice versa), the compare will fail noisily (schema
error), which is the correct behavior.

---

## 5. Integration with Migration Guard (PR #48) and Fixture Test (PR #60)

### Migration guard (PR #48)

PR #48 adds a guard that checks that the DB migration level matches the
running binary's expected migration count at startup. The new migration
(NNN_EventRetentionArchiveTable) must:

- Be registered in `migrationEntries` in `Migrations.ts` with the assigned
  ID.
- Be imported statically (`import MigrationNNN from "./Migrations/NNN_..."`)
  at the top of `Migrations.ts`.
- Increment the expected migration count in the guard by 1 (or however PR
  #48 tracks the expected count — the implementor must check the PR #48
  implementation detail before assigning the number).

### All-migrations fixture test (PR #60)

PR #60 adds a test that runs all migrations against a fresh in-memory DB and
asserts the resulting schema. The new migration must produce a passing schema
assertion. Since the migration adds one table and three indexes, the fixture
test must include assertions for `orchestration_events_archive` table
existence and column presence (same pattern as existing migration tests using
`runMigrations({ toMigrationInclusive: NNN })`).

The migration test file should be `NNN_EventRetentionArchiveTable.test.ts`
following the pattern of `019_ProjectionSnapshotLookupIndexes.test.ts`
(schema-only migration — no data to backfill, just verify the table exists
with the right columns).

---

## 6. Deliberately Cut

- **Background auto-archival**: a periodic background fiber that archives on
  a schedule. Cut — operators can cron `t3 db archive-events` at the OS
  level. One less moving part in the server process.
- **Online rebuild** (server running): requires either a read-lock protocol
  or a shadow DB. The complexity is not justified given the rarity of rebuild
  operations. Operators must stop the server.
- **Event compaction** (replace a sequence of events with a snapshot):
  the projectors are already incremental; compaction would save replay time
  but requires a projection-snapshot format and a new table. YAGNI — the
  100–200 events/s rebuild rate is acceptable.
- **Multi-knob retention** (per-event-type or per-aggregate-kind age limits):
  one knob. Thread-scoped events age out together when the thread is closed.
- **Per-projector selective rebuild**: rebuild either runs all projectors or
  none. A per-projector rebuild would require careful ordering (projectors
  have implicit dependencies via `refreshThreadShellSummary`). Cut.
- **Graveyard event archive exemption UI**: the exclusion logic is in SQL (see
  1.4). No configuration surface needed — the rule is structural, not
  configurable.

---

## Files Read

- `apps/server/src/persistence/Services/OrchestrationEventStore.ts`
- `apps/server/src/persistence/Migrations.ts`
- `apps/server/src/persistence/Migrations/001_OrchestrationEvents.ts`
- `apps/server/src/orchestration/Layers/ProjectionPipeline.ts`
- `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts`
- `apps/server/src/bin.ts`
- `apps/server/src/cli/server.ts`
- `apps/server/src/cli/project.ts`
- `.plans/21-worktree-graveyard.md` (via `git show origin/docs/plan-graveyard-design:...`)
- `docs/perf-baseline-2026-07.md` (via `git show origin/perf/orchestration-baseline:...`)
- `apps/server/src/persistence/Migrations/*.test.ts` (migration test pattern)

---

## Open Questions for the Operator

1. **Migration number**: is 033 free? Check whether any in-flight PRs (#48,
   #60, or plan 21 implementation) have claimed 033–035 before assigning.

2. **Graveyard burial predicate in archival SQL**: plan 21 has not been
   implemented yet. The retention exclusion SQL (section 1.4) references
   `worktree.retiring-started` and `worktree.buried` event types. If plan 21
   is not yet merged when this is implemented, the exclusion clause still
   works correctly (no such events exist → the NOT EXISTS always returns false →
   all eligible threads are archivable). The clause is safe to ship before
   plan 21. Confirm this is acceptable.

3. **Lock file strategy**: the server does not currently write a PID file.
   The rebuild command needs a reliable "is the server running?" check.
   Options: (a) check SQLite WAL lock via a `BEGIN EXCLUSIVE` attempt that
   fails immediately; (b) add a PID lock file in the data dir on server start.
   Option (a) is zero new infrastructure — recommend it, but operator should
   confirm.

4. **`--include-archive` default**: this plan defaults rebuild to hot-table
   only (faster). If the operator wants rebuild-from-archive to always be
   included (ensuring full correctness including aged-out data), flip the
   default. The plan is intentionally lazy on this.

5. **`AutomodeEpisodeLedger` rebuild scope**: the ledger is excluded from
   truncation (section 2.2). It is populated from automode episode events,
   not from the standard projectors. Confirm it does not need to be rebuilt
   as part of a projection rebuild. If it does, it needs its own replay path.
