# p1-B-T5-s2 — LIMIT listThreadActivityRowsByThread

Task: T5 · Lane: B (after s1) · Model: sonnet-4-6/medium
Status: pending

## Brief (Fable)

- **Goal:** add a LIMIT (newest N, default 500) to `listThreadActivityRowsByThread` so no caller can materialize an unbounded thread; align with T4-s2's use.
- **Read first:** `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts:930-952`; every caller (`git grep -n listThreadActivityRowsByThread apps/server`); plan §T5.
- **Invariants:** callers that legitimately need more take an explicit `limit` param — no silent behavior change for the UI lazy-load path (confirm how the web app pages older activities before capping the RPC it uses; if it relies on full load, cap server-side but keep an explicit paged path).
- **Acceptance:** SQL carries LIMIT; call-site audit table in Hand-back (caller → limit chosen → why); tests green; guard green.
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
