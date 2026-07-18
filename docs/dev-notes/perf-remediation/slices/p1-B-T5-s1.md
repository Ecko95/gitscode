# p1-B-T5-s1 — cap boot-hydrate activities (.slice(-500))

Task: T5 · Lane: B (after T4 slices) · Model: sonnet-4-6/medium
Status: pending

## Brief (Fable)

- **Goal:** fix the fork-only defect: boot hydrate caps messages at 2,000 but loads ALL activities. Add `.slice(-500)` at `ProjectionSnapshotQuery.ts:1622`, mirroring the messages cap at `:1619` and the incremental trim at `projector.ts:678`.
- **Read first:** `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts:1615-1625`; `projector.ts:670-685` (the 500 constant — reuse it, don't hardcode a second one); plan §T5.
- **Invariants:** hydrate ordering preserved (newest-N semantics identical to the incremental projector); nothing else in the function changes.
- **Acceptance:** one-line (plus constant import) diff; test: hydrate a thread with >500 activities → read model holds exactly the newest 500; guard green.
- **Verification (guard):** `bun x turbo run typecheck build --filter=t3` + `bun run --cwd apps/server test -- ProjectionSnapshotQuery`.

## Hand-back (execution agent)

_(files read · files changed · diff-stat · summary ≤1 para · ponytail shortcuts · residual risks · next steps)_

## Guard result

—

## Merge

—

## Verify result (end gate)

—

## Decision (Fable)

—
