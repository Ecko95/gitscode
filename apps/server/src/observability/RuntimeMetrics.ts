/**
 * Runtime measurement harness (perf plan T14).
 *
 * Samples Node runtime health into Effect Metrics so they surface via the same
 * OTLP export as every other `t3_*` metric:
 *
 *   - event-loop delay p99 (from `perf_hooks.monitorEventLoopDelay`)
 *   - resident set size (RSS ceiling proxy)
 *   - GC pause time (from a `PerformanceObserver` on "gc" entries)
 *   - WS reconnect-error count (incremented by the transport reconnect path)
 *
 * Sampling is cheap: one periodic fiber reads the histogram percentile, resets
 * it, reads RSS, and drains any GC durations the observer queued. The observer
 * callback only pushes plain numbers — no Effect runs inside it.
 */

import { PerformanceObserver, monitorEventLoopDelay } from "node:perf_hooks";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Schedule from "effect/Schedule";

// ponytail: 10s sample interval hard-coded — honours the "reset ≤1/10 s" invariant.
// Add an env knob only if ops needs finer/coarser sampling.
const SAMPLE_INTERVAL_MS = 10_000;

// Event-loop delay sampling resolution for the underlying libuv timer (ms).
const ELD_RESOLUTION_MS = 20;

export const eventLoopDelayP99 = Metric.gauge("t3_runtime_event_loop_delay_p99_seconds", {
  description: "p99 event loop delay over the last sampling window, in seconds.",
});

export const rssBytes = Metric.gauge("t3_runtime_rss_bytes", {
  description: "Resident set size of the server process, in bytes.",
});

export const gcDuration = Metric.timer("t3_runtime_gc_duration", {
  description: "Garbage-collection pause duration reported by PerformanceObserver.",
});

export const wsReconnectErrorsTotal = Metric.counter("t3_ws_reconnect_errors_total", {
  description: "Total websocket reconnect attempts that ended in error.",
});

/**
 * Record a single runtime sample into the metrics. Pure (given its inputs) so
 * it is exercised directly in tests without real timers or a live process.
 */
export const recordRuntimeSample = (input: {
  readonly eldP99Nanos: number;
  readonly rssBytes: number;
  readonly gcDurationsMs: ReadonlyArray<number>;
}) =>
  Effect.gen(function* () {
    yield* Metric.update(eventLoopDelayP99, input.eldP99Nanos / 1e9);
    yield* Metric.update(rssBytes, input.rssBytes);
    for (const ms of input.gcDurationsMs) {
      yield* Metric.update(gcDuration, Duration.millis(ms));
    }
  });

/**
 * Background layer: enables the event-loop-delay histogram and a GC observer,
 * then forks a scoped fiber that samples them on a fixed interval. Additive and
 * side-effect-free with respect to any serving path.
 */
export const RuntimeMetricsLive: Layer.Layer<never> = Layer.effectDiscard(
  Effect.gen(function* () {
    const eld = monitorEventLoopDelay({ resolution: ELD_RESOLUTION_MS });
    eld.enable();

    const pendingGc: number[] = [];
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        pendingGc.push(entry.duration);
      }
    });
    observer.observe({ entryTypes: ["gc"] });

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        eld.disable();
        observer.disconnect();
      }),
    );

    yield* Effect.forkScoped(
      Effect.gen(function* () {
        const gcDurationsMs = pendingGc.splice(0);
        yield* recordRuntimeSample({
          eldP99Nanos: eld.percentile(99),
          rssBytes: process.memoryUsage().rss,
          gcDurationsMs,
        });
        eld.reset();
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("runtime.metrics.sample-failed", { cause }),
        ),
        Effect.repeat(Schedule.spaced(Duration.millis(SAMPLE_INTERVAL_MS))),
      ),
    );

    yield* Effect.logInfo("runtime.metrics.started", { sampleIntervalMs: SAMPLE_INTERVAL_MS });
  }),
);
