# gate-T1-s3 — rebuild projections (end-gate ops)

Task: T1c · Lane: gate (runs during end acceptance gate) · Model: ops (validator-driven)
Status: pending

## Brief (Fable)

- **Goal:** apply the T1 payload cap retroactively: run `t3 db rebuild-projections` — first against a COPY of the live DB in isolation (acceptance-gate step), then on the live host during the single controlled redeploy window (server stopped; the CLI enforces the pidfile check).
- **Read first:** `apps/server/src/cli/db.ts` (+ `db.test.ts`, `db.verify.test.ts`); plan §T1 verify.
- **Invariants:** live run only inside the redeploy window; DB copy runs first and must succeed; keep the pre-rebuild DB file until the end gate passes (rollback path).
- **Acceptance:** rebuild completes on the copy; post-rebuild SQL: `SELECT MAX(LENGTH(payload)) FROM orchestration_events WHERE event_type='thread.activity-appended' AND occurred_at > <cap-merge-time>` under the cap; projection row counts sane vs pre-rebuild.
- **Verification:** the SQL above + `db.verify` test suite against the rebuilt copy.

## Hand-back (validator)

_(copy-run result · live-run result · SQL evidence)_

### Isolated copy-run (acceptance gate) — PASS

**No live-host mutation.** Live DB `/home/ops/.t3/userdata/state.sqlite` (297.6 MB, WAL
active, server running — `server.pid` present) was snapshotted read-only via the
`node:sqlite` online-backup API (`backup(new DatabaseSync(src,{readOnly:true}), copy)`)
into a scratch temp dir. `sqlite3` CLI is not installed on this host, so `.backup` was
unavailable; the online-backup API gives an equivalent consistent snapshot (WAL merged).
The rebuild ran with `--base-dir <temp>` so the CLI's pidfile guard checked the empty
temp `stateDir`, never the live `server.pid`; the live host was never opened for write.

- **Acceptance gate checks (this worktree):** `fmt:check` FAIL (13 pre-existing
  formatting-only files, unrelated to T1 — see gate report) · `lint` PASS (0 errors) ·
  `turbo typecheck` PASS (14/14) · `test` PASS (1594 passed / 4 skipped, 22/22 tasks) ·
  `build` PASS (18/18).

- **`t3 db rebuild-projections` on copy:** exit 0 — "Rebuild complete. 44451 events
  replayed." Rebuild sentinel (`__rebuild_in_progress__`) cleared on success (0 rows).

- **Projection row counts (pre → post rebuild), all sane / identical (deterministic replay):**
  `projection_thread_activities` 35756→35756 · `_messages` 2935→2935 ·
  `_proposed_plans` 7→7 · `_visual_plans` 0→0 · `_sessions` 34→34 · `_turns` 368→368 ·
  `_pending_approvals` 39→39 · `_threads` 34→34 · `_projects` 28→28 · `_state` 10→10.

- **Post-rebuild SQL (acceptance check).** Actual column is `payload_json` (doc wrote
  `payload` loosely); event_type is `thread.activity-appended`; cap-merge time =
  `2026-07-18T10:55:30+01:00` (commit `f6f939777`, later of the two T1 cap commits):

  ```sql
  SELECT MAX(LENGTH(payload_json)), COUNT(*) FROM orchestration_events
  WHERE event_type='thread.activity-appended' AND occurred_at > '2026-07-18T10:55:30+01:00';
  -- → MAX = NULL, COUNT = 0   (under cap, vacuously)
  ```

  0 in-window rows: the newest `thread.activity-appended` in the snapshot is
  `2026-07-18T09:15:32Z` — before the cap-merge instant (`09:55:30Z`). The live host is
  still the pre-cap build, so it wrote no post-cap activity events; this SQL only becomes
  load-bearing after the live redeploy writes new capped activity events. Check passes
  (no over-cap rows).

- **Rebuild replays existing events verbatim — no retroactive shrink.** Raw
  `orchestration_events` and rebuilt `projection_thread_activities` both still show
  `MAX(LENGTH(payload_json)) = ~1.21 MB` (historical pre-cap rows). The T1 cap is a
  write-time ingestion guard (`truncateData` in `ProviderRuntimeIngestion.ts`), not part
  of the projection pipeline, so rebuild does not truncate history. The cap takes effect
  only for events the redeployed capped server writes going forward; rebuild's role here
  is projection-table regeneration + verification, not shrinking existing payloads.

- **`t3 db rebuild-projections --verify` on the rebuilt copy:** PASS — "Verify PASSED:
  all projection tables match (counts + content)." 44451 events replayed into `:memory:`;
  all 9 verified tables MATCH on both row count and content fingerprint.

### Live host redeploy-window run — PENDING

Deferred to the single controlled redeploy window (server stopped; CLI pidfile guard
enforced). Keep the pre-rebuild live DB until the end gate passes (rollback path).

## Guard result

—

## Merge

—

## Verify result (end gate)

—

## Decision (Fable)

—
