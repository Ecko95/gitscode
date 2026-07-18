import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Metric from "effect/Metric";

import { recordRuntimeSample, wsReconnectErrorsTotal } from "./RuntimeMetrics.ts";

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
