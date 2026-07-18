# p1-B-T4-s2 — getThreadDetailById + ingestion fetch-only-needed

Task: T4 · Lane: B (after s1) · Model: opus-4-8/high
Status: pending

## Brief (Fable)

- **Goal:** bound `getThreadDetailById` (currently loads ALL rows, no LIMIT) and make ingestion's `getLoadedThreadDetail` call sites fetch only what each site needs (one turn's messages; proposedPlans list) instead of the whole thread.
- **Read first:** `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts:2135-2260` (detail assembly), `:930` (`listThreadActivityRowsByThread`, ORDER BY without LIMIT); `ProviderRuntimeIngestion.ts:1491,:1558,:1614,:1627` (call sites); `ProjectionSnapshotQuery.test.ts`; plan §T4.
- **Invariants:** public RPC `getThreadDetailById` used by clients keeps its contract for UI reads (cap = newest N, consistent with T5); ingestion behavior identical on threads ≤ N rows.
- **Acceptance:** activities query LIMITed; ingestion sites no longer materialize full threads; tests green incl. a large-thread fixture proving bounded rows; guard green.
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
