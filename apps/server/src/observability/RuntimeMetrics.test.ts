import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Metric from "effect/Metric";

import {
  accumulateWindow,
  newRuntimeWindow,
  recordRuntimeSample,
  wsReconnectErrorsTotal,
} from "./RuntimeMetrics.ts";

const findSnapshot = (snapshots: ReadonlyArray<Metric.Metric.Snapshot>, id: string) =>
  snapshots.find((snapshot) => snapshot.id === id);

describe("recordRuntimeSample", () => {
  it.effect("registers and records loop delay, RSS, and GC gauges/timer", () =>
    Effect.gen(function* () {
      yield* recordRuntimeSample({
        eldP99Nanos: 2_000_000, // 2ms -> 0.002s
        rssBytes: 123_456_789,
        gcDurationsMs: [1.5, 4.5],
      });

      const snapshots = yield* Metric.snapshot;

      const eld = findSnapshot(snapshots, "t3_runtime_event_loop_delay_p99_seconds");
      assert.equal(eld?.type === "Gauge" ? eld.state.value : undefined, 0.002);

      const rss = findSnapshot(snapshots, "t3_runtime_rss_bytes");
      assert.equal(rss?.type === "Gauge" ? rss.state.value : undefined, 123_456_789);

      const gc = findSnapshot(snapshots, "t3_runtime_gc_duration");
      assert.equal(gc?.type === "Histogram" ? gc.state.count : -1, 2);
      // timer histogram records milliseconds; 1.5ms + 4.5ms = 6ms
      assert.equal(gc?.type === "Histogram" ? gc.state.sum : -1, 6);
    }),
  );

  it.effect("increments the WS reconnect-error counter", () =>
    Effect.gen(function* () {
      yield* Metric.update(wsReconnectErrorsTotal, 1);
      yield* Metric.update(wsReconnectErrorsTotal, 1);

      const snapshots = yield* Metric.snapshot;
      const counter = findSnapshot(snapshots, "t3_ws_reconnect_errors_total");
      assert.equal(counter?.type === "Counter" ? counter.state.count : -1, 2);
    }),
  );
});

describe("accumulateWindow", () => {
  it("emits a summary with aggregated window values after 6 samples", () => {
    let window = newRuntimeWindow();
    const eldNanos = [2e8, 5e8, 3e8, 1e8, 4e8, 2e8]; // seconds: 0.2 .. max 0.5
    const gcMs = [1, 2, 0, 3, 0, 4]; // total 10ms
    const rss = [100, 110, 120, 130, 140, 150]; // latest wins -> 150
    const wsTotals = [0, 0, 1, 1, 2, 3]; // cumulative; window delta = 3

    let summary: NonNullable<ReturnType<typeof accumulateWindow>["summary"]> | undefined;
    for (let i = 0; i < 6; i++) {
      const result = accumulateWindow(window, {
        eldP99Nanos: eldNanos[i]!,
        rssBytes: rss[i]!,
        gcDurationsMs: [gcMs[i]!],
        wsReconnectTotal: wsTotals[i]!,
      });
      window = result.window;
      // Only the final (6th) sample closes the window.
      assert.equal(result.summary === undefined, i < 5);
      if (result.summary) summary = result.summary;
    }

    assert.ok(summary);
    assert.equal(summary.eldP99MaxSeconds, 0.5);
    assert.equal(summary.rssBytes, 150);
    assert.equal(summary.gcTotalMs, 10);
    assert.equal(summary.wsReconnectCount, 3);
    // Window rolled over with a fresh baseline at the current counter value.
    assert.equal(window.sampleCount, 0);
    assert.equal(window.wsBaseline, 3);
  });

  it("emits a WARN when a sample's ELD p99 exceeds 1s, and none below it", () => {
    const under = accumulateWindow(newRuntimeWindow(), {
      eldP99Nanos: 9e8, // 0.9s
      rssBytes: 1,
      gcDurationsMs: [],
      wsReconnectTotal: 0,
    });
    assert.equal(under.warn, undefined);

    const over = accumulateWindow(newRuntimeWindow(), {
      eldP99Nanos: 1.5e9, // 1.5s
      rssBytes: 1,
      gcDurationsMs: [],
      wsReconnectTotal: 0,
    });
    assert.equal(over.warn?.eldP99Seconds, 1.5);
  });
});
