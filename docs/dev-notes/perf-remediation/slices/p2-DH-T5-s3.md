# p2-DH-T5-s3 — exclude deleted threads from command model

Task: T5c · Lane: D/H (first in sequence T5c→T7→T9→T8) · Model: sonnet-4-6/medium
Status: pending

## Brief (Fable)

- **Goal:** `listThreadRows` selects `deleted_at` but never filters it, so soft-deleted threads live in the permanent command read model. Exclude `deleted_at IS NOT NULL` rows from the boot hydrate/command model.
- **Read first:** `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts:387-415` (`listThreadRows`) and the sibling `listActiveThreadRows:417+` (the pattern to mirror); `OrchestrationEngine.ts:120,:383` (the read model it feeds); plan §T5.
- **Invariants:** commands targeting a deleted thread must fail the same way they do today (not a new error shape); UI thread-list behavior unchanged (it uses a different query — verify and note in Hand-back).
- **Acceptance:** hydrate excludes deleted threads (test with a seeded deleted row); no other caller of `listThreadRows` regresses (call-site audit in Hand-back); guard green.
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
