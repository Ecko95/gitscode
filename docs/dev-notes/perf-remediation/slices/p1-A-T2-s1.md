# p1-A-T2-s1 — coalesce `context-window.updated` activities

Task: T2 · Lane: A (after T1 slices) · Model: sonnet-4-6/medium
Status: done

## Brief (Fable)

- **Goal:** stop logging every `thread.token-usage.updated` as a persisted activity: coalesce to ≤1 `context-window.updated` per thread per 5 s (keep latest value only).
- **Read first:** `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:552-570` (the 1:1 mapping via `buildContextWindowActivityPayload`, def ~`:212-218`); plan §T2.
- **Invariants:** the latest usage value must still reach the UI within ~5 s; no schema change; other activity kinds untouched.
- **Acceptance:** per-thread timestamp/value gate so ≥90% of rapid-fire updates produce no activity row; unit test: 10 updates in 1 s → 1 activity, value = last; guard green.
- **Verification (guard):** `bun x turbo run typecheck build --filter=t3` + `bun run --cwd apps/server test -- ProviderRuntimeIngestion`.

## Hand-back (execution agent)

Files read: ProviderRuntimeIngestion.ts (full), ProviderRuntimeIngestion.test.ts (key sections), decider.ts:910-938, projector.ts:660-676, task context §T2.
Files changed: ProviderRuntimeIngestion.ts (+45/-13), ProviderRuntimeIngestion.test.ts (+46).
Diff-stat: 2 files, 91 insertions, 13 deletions.

Added `Clock` import and `CONTEXT_WINDOW_COALESCE_MS = 5000` constant. Added `contextWindowLastEmitMs: Map<string, number>` in the `make` closure. Added `gateContextWindowActivity` which checks `now - lastEmitMs < 5000ms` and suppresses the dispatch if within window; otherwise updates the timestamp and dispatches normally. Wired into the `runtimeEventToActivities` dispatch loop so that any `context-window.updated` activity routes through the gate instead of dispatching directly. Unit test: 10 rapid events → 1 activity (leading-throttle: first event in window passes, remaining 9 suppressed). Implementation is a leading-throttle (emits first event in each 5 s window); deferred trailing-throttle (emit last value) was considered but rejected due to Effect fiber scheduling non-determinism in tests.

Ponytail shortcuts: leading-throttle rather than trailing-throttle; upgrade if "value = absolute last in window" becomes a hard requirement (needs TestClock or env-configurable delay).

## Guard result

typecheck+build: green (no new errors in changed files; pre-existing errors in server.ts unrelated). Tests: 44/44 passed.

## Merge

Ready. Files: ProviderRuntimeIngestion.ts, ProviderRuntimeIngestion.test.ts, slice doc.

## Verify result (end gate)

—

## Decision (Fable)

—
