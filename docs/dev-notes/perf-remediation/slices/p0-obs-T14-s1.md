# p0-obs-T14-s1 — measurement harness in observability/

Task: T14 · Lane: obs · Model: opus-4-8/high
Status: done

## Brief (Fable)

- **Goal:** wire `perf_hooks.monitorEventLoopDelay` (+ RSS, GC via `PerformanceObserver`) into the existing `apps/server/src/observability/` tree as a metrics layer; expose p99 loop delay, RSS, GC time, and WS reconnect-error rate as periodically logged/OTLP metrics.
- **Read first:** `apps/server/src/observability/Metrics.ts` (+test), `Layers/Observability.ts`, `docs/observability.md`; plan §T14. Follow the existing Effect Metric patterns exactly.
- **Invariants:** no behavior change to any serving path; sampling must be cheap (histogram reset ≤1/10 s); no new dependency; no inspector/port 9229.
- **Acceptance:** new metrics registered following the `Metrics.ts` house pattern; unit test in the co-located `*.test.ts` style asserting metrics register and record; `turbo run typecheck build --filter=t3` green.
- **Verification (guard):** `bun x turbo run typecheck build --filter=t3`.

## Hand-back (execution agent)

**Files read:** `observability/Metrics.ts` (+test), `Layers/Observability.ts`, `docs/observability.md`, `vcs/GraveyardReaper.ts` (daemon-layer pattern), plan §T14, effect `Metric`/`Layer`/`Schedule` d.ts.

**Files changed:**

- `apps/server/src/observability/RuntimeMetrics.ts` (new) — metric defs + sampling layer
- `apps/server/src/observability/RuntimeMetrics.test.ts` (new) — co-located unit test
- `apps/server/src/observability/Layers/Observability.ts` — merge `RuntimeMetricsLive` into `ObservabilityLive`

**Diff-stat:** 3 files, +166/−1.

**Summary:** Added a `perf_hooks`-based measurement harness following the `Metrics.ts` house pattern. `RuntimeMetrics.ts` registers four `t3_*` metrics — `t3_runtime_event_loop_delay_p99_seconds` (gauge), `t3_runtime_rss_bytes` (gauge), `t3_runtime_gc_duration` (timer/histogram, ms), `t3_ws_reconnect_errors_total` (counter). `RuntimeMetricsLive` (a `Layer.effectDiscard`) enables `monitorEventLoopDelay` + a `PerformanceObserver("gc")`, then forks one scoped fiber that every 10s reads the histogram p99, resets it, reads RSS, and drains queued GC durations into the metrics; a scope finalizer disables the histogram/observer. Wired into `ObservabilityLive` so it exports over the existing OTLP path. Pure `recordRuntimeSample` extracted for a timer-free unit test.

**Ponytail shortcuts:** 10s sample interval + 20ms ELD resolution hard-coded (`ponytail:` comment names the env-knob upgrade). GC observer callback pushes plain numbers into an array drained by the sample loop — keeps Effect out of the callback, no queue machinery.

**Residual risks:** `t3_ws_reconnect_errors_total` is registered + exported but nothing increments it yet — the transport reconnect path (client `wsTransport`, out of this slice's scoped files) must call `Metric.update(wsReconnectErrorsTotal, 1)` on a failed reconnect. Sampling fiber runs in-process; only exported when `otlpMetricsUrl` is configured (matches existing metrics behavior).

**Next steps:** wire `wsReconnectErrorsTotal` into the reconnect-error path; capture the T14 baseline numbers over a real agent session.

## Guard result

`bun x turbo run typecheck build --filter=t3` → green (10/10 tasks; only pre-existing effect lint _suggestions_ on unrelated files, none on the new files). Co-located `RuntimeMetrics.test.ts` → 2/2 passing (asserts all four metrics register and record).

## Merge

—

## Verify result (end gate)

—

## Decision (Fable)

—
