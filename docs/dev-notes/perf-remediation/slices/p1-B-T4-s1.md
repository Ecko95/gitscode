# p1-B-T4-s1 — refreshThreadShellSummary → SQL aggregates

Task: T4 · Lane: B (lead: Opus) · Model: opus-4-8/high
Status: pending

## Brief (Fable)

- **Goal:** replace the full-thread materialization in `refreshThreadShellSummary` (loads ALL messages+activities+plans+pendingApprovals per event) with `COUNT(*)`/`MAX(created_at)`-style SQL aggregates.
- **Read first:** `apps/server/src/orchestration/Layers/ProjectionPipeline.ts:541-584` (+ call sites `:744,:760,:776,:814`), `ProjectionSnapshotQuery.ts` list functions it calls, `ProjectionPipeline.test.ts`; plan §T4.
- **Invariants:** summary row shape unchanged (downstream WS consumers read it); pending-user-input count must match old semantics exactly (indexed query over the two relevant activity kinds); projection rebuild (`t3 db rebuild-projections`) must produce identical summaries.
- **Acceptance:** no `listByThreadId` full loads remain in the refresh path; `ProjectionPipeline.test.ts` green (extend with an equivalence test old-vs-new on a seeded thread); guard green.
- **Verification (guard):** `bun x turbo run typecheck build --filter=t3` + `bun run --cwd apps/server test -- ProjectionPipeline`.

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
