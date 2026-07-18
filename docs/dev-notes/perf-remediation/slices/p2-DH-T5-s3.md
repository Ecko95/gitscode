# p2-DH-T5-s3 — exclude deleted threads from command model

Task: T5c · Lane: D/H (first in sequence T5c→T7→T9→T8) · Model: sonnet-4-6/medium
Status: done

## Brief (Fable)

- **Goal:** `listThreadRows` selects `deleted_at` but never filters it, so soft-deleted threads live in the permanent command read model. Exclude `deleted_at IS NOT NULL` rows from the boot hydrate/command model.
- **Read first:** `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts:387-415` (`listThreadRows`) and the sibling `listActiveThreadRows:417+` (the pattern to mirror); `OrchestrationEngine.ts:120,:383` (the read model it feeds); plan §T5.
- **Invariants:** commands targeting a deleted thread must fail the same way they do today (not a new error shape); UI thread-list behavior unchanged (it uses a different query — verify and note in Hand-back).
- **Acceptance:** hydrate excludes deleted threads (test with a seeded deleted row); no other caller of `listThreadRows` regresses (call-site audit in Hand-back); guard green.
- **Verification (guard):** `bun x turbo run typecheck build --filter=t3` + `bun run --cwd apps/server test -- ProjectionSnapshotQuery`.

## Hand-back (execution agent)

Files read: `ProjectionSnapshotQuery.ts:396-424` (listThreadRows), `417-456` (listActiveThreadRows/listArchivedThreadRows for pattern reference), `1100-1200` (getSnapshot), `1396-1655` (getCommandReadModel). `ProjectionSnapshotQuery.test.ts:2293-2419` (existing deleted-tombstone test).

Files changed: `ProjectionSnapshotQuery.ts` (+1 line: `WHERE deleted_at IS NULL` in listThreadRows), `ProjectionSnapshotQuery.test.ts` (updated existing test title + assertions from "keeps tombstones" to "excludes deleted threads").

Diff-stat: 2 files, +5 −7.

Summary: Added `WHERE deleted_at IS NULL` to `listThreadRows` (mirroring listActiveThreadRows). Both `getCommandReadModel` and `getSnapshot` now exclude soft-deleted threads. The existing test "keeps deleted project and thread tombstones in the command read model" was asserting the wrong (buggy) behavior; updated it to assert `threads.length === 0` for deleted threads.

UI thread-list audit: The web UI uses `listActiveThreadRows` (filters `deleted_at IS NULL AND archived_at IS NULL`) and `listArchivedThreadRows` (filters `deleted_at IS NULL AND archived_at IS NOT NULL`) via `getShellSnapshot`. Neither call goes through `listThreadRows`. UI thread-list behavior is unchanged.

Call-site audit: `listThreadRows` is called only in `getSnapshot` (line 1112) and `getCommandReadModel` (line 1408). No other callers. Both now correctly exclude deleted threads.

Commands targeting a deleted thread will fail with "thread not found" (same as today since the thread won't be in the read model) — no new error shape.

Ponytail shortcuts: none; single-line SQL filter is the minimum fix.

Residual risks: `getSnapshot` now also excludes deleted threads from the full snapshot; the CLI `project.ts` caller gets this too. If any downstream consumer needed deleted threads via `getSnapshot` for tombstone-based reconciliation, it would need a separate query. No such consumer found in the codebase.

## Guard result

`bun x turbo run typecheck build --filter=t3`: 10 tasks successful. `bun run --cwd apps/server test -- ProjectionSnapshotQuery`: 18/18 passed.

## Merge

Commit staged to feat/perf-remediation with tag [p2-DH-T5-s3].

## Verify result (end gate)

—

## Decision (Fable)

—
