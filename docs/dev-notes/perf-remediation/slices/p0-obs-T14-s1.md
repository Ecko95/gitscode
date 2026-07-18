# p0-obs-T14-s1 — measurement harness in observability/

Task: T14 · Lane: obs · Model: opus-4-8/high
Status: pending

## Brief (Fable)

- **Goal:** wire `perf_hooks.monitorEventLoopDelay` (+ RSS, GC via `PerformanceObserver`) into the existing `apps/server/src/observability/` tree as a metrics layer; expose p99 loop delay, RSS, GC time, and WS reconnect-error rate as periodically logged/OTLP metrics.
- **Read first:** `apps/server/src/observability/Metrics.ts` (+test), `Layers/Observability.ts`, `docs/observability.md`; plan §T14. Follow the existing Effect Metric patterns exactly.
- **Invariants:** no behavior change to any serving path; sampling must be cheap (histogram reset ≤1/10 s); no new dependency; no inspector/port 9229.
- **Acceptance:** new metrics registered following the `Metrics.ts` house pattern; unit test in the co-located `*.test.ts` style asserting metrics register and record; `turbo run typecheck build --filter=t3` green.
- **Verification (guard):** `bun x turbo run typecheck build --filter=t3`.

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
