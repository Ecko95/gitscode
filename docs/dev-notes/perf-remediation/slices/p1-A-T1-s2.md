# p1-A-T1-s2 — cap activity payload `data` (item.completed)

Task: T1 · Lane: A (after p1-A-T1-s1) · Model: sonnet-4-6/medium
Status: pending

## Brief (Fable)

- **Goal:** apply the same 4 KB `data` cap (helper introduced in p1-A-T1-s1) to the `item.completed` site at `ProviderRuntimeIngestion.ts:656`.
- **Read first:** `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:645-665`; the s1 diff (already merged on the integration branch); its test.
- **Invariants:** reuse the s1 helper — no second implementation; the fork-only assistant_message/reasoning branch in this block stays untouched.
- **Acceptance:** `:656` passthrough uses the cap; test extended for the completed path; guard green.
- **Verification (guard):** `bun x turbo run typecheck build --filter=t3` + `bun run --cwd apps/server test -- ProviderRuntimeIngestion`.

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
