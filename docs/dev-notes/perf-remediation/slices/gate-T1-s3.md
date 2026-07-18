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

## Guard result

—

## Merge

—

## Verify result (end gate)

—

## Decision (Fable)

—
