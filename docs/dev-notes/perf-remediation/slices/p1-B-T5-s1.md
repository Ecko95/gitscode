# p1-B-T5-s1 — cap boot-hydrate activities (.slice(-500))

Task: T5 · Lane: B (after T4 slices) · Model: sonnet-4-6/medium
Status: done

## Brief (Fable)

- **Goal:** fix the fork-only defect: boot hydrate caps messages at 2,000 but loads ALL activities. Add `.slice(-500)` at `ProjectionSnapshotQuery.ts:1622`, mirroring the messages cap at `:1619` and the incremental trim at `projector.ts:678`.
- **Read first:** `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts:1615-1625`; `projector.ts:670-685` (the 500 constant — reuse it, don't hardcode a second one); plan §T5.
- **Invariants:** hydrate ordering preserved (newest-N semantics identical to the incremental projector); nothing else in the function changes.
- **Acceptance:** one-line (plus constant import) diff; test: hydrate a thread with >500 activities → read model holds exactly the newest 500; guard green.
- **Verification (guard):** `bun x turbo run typecheck build --filter=t3` + `bun run --cwd apps/server test -- ProjectionSnapshotQuery`.

## Hand-back (execution agent)

Files read: `ProjectionSnapshotQuery.ts` (lines 63-70, 1590-1670), `ProjectionSnapshotQuery.test.ts` (lines 1-60, 1506-1590). Files changed: `ProjectionSnapshotQuery.ts` (1 line), `ProjectionSnapshotQuery.test.ts` (+88 lines test). Diff-stat: 2 files changed, 89 insertions, 0 deletions. `MAX_THREAD_ACTIVITIES` was already defined at line 70; the only missing piece was `.slice(-MAX_THREAD_ACTIVITIES)` on the activities map lookup at the boot-hydrate assembly point (line 1669). Added a test seeding 505 activities then asserting `getCommandReadModel()` returns exactly 500 (newest, sequences 6–505). No shortcuts taken. No residual risks.

## Guard result

`bun x turbo run typecheck build --filter=t3`: 10/10 tasks successful (23.5 s). `bun run --cwd apps/server test -- ProjectionSnapshotQuery`: 18/18 tests passed (1.23 s). Green.

## Merge

Committed as `fix(orchestration): cap boot-hydrate activities to newest 500 [p1-B-T5-s1]`.

## Verify result (end gate)

—

## Decision (Fable)

—
