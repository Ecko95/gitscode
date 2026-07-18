# p1-A-T2-s1 — coalesce `context-window.updated` activities

Task: T2 · Lane: A (after T1 slices) · Model: sonnet-4-6/medium
Status: pending

## Brief (Fable)

- **Goal:** stop logging every `thread.token-usage.updated` as a persisted activity: coalesce to ≤1 `context-window.updated` per thread per 5 s (keep latest value only).
- **Read first:** `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:552-570` (the 1:1 mapping via `buildContextWindowActivityPayload`, def ~`:212-218`); plan §T2.
- **Invariants:** the latest usage value must still reach the UI within ~5 s; no schema change; other activity kinds untouched.
- **Acceptance:** per-thread timestamp/value gate so ≥90% of rapid-fire updates produce no activity row; unit test: 10 updates in 1 s → 1 activity, value = last; guard green.
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
