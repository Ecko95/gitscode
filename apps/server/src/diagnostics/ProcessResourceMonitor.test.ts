import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  aggregateProcessResourceHistory,
  collectMonitoredSamples,
  type ProcessResourceSample,
} from "./ProcessResourceMonitor.ts";

function makeSample(input: {
  readonly sampledAtMs: number;
  readonly processKey?: string;
  readonly pid?: number;
  readonly cpuPercent: number;
  readonly rssBytes: number;
}): ProcessResourceSample {
  return {
    sampledAt: DateTime.makeUnsafe(input.sampledAtMs),
    sampledAtMs: input.sampledAtMs,
    processKey: input.processKey ?? "100:t3 server",
    pid: input.pid ?? 100,
    ppid: 1,
    command: input.processKey ?? "t3 server",
    cpuPercent: input.cpuPercent,
    rssBytes: input.rssBytes,
    depth: 0,
    isServerRoot: true,
  };
}

describe("ProcessResourceMonitor", () => {
  it.effect("samples the server root process and descendants", () =>
    Effect.sync(() => {
      const sampledAt = DateTime.makeUnsafe("2026-05-05T10:00:00.000Z");
      const samples = collectMonitoredSamples({
        serverPid: 100,
        sampledAt,
        sampledAtMs: DateTime.toEpochMillis(sampledAt),
        rows: [
          {
            pid: 100,
            ppid: 1,
            pgid: 100,
            status: "S",
            cpuPercent: 2,
            rssBytes: 1_000,
            elapsed: "01:00",
            command: "t3 server",
          },
          {
            pid: 101,
            ppid: 100,
            pgid: 100,
            status: "S",
            cpuPercent: 10,
            rssBytes: 2_000,
            elapsed: "00:20",
            command: "codex app-server",
          },
          {
            pid: 102,
            ppid: 101,
            pgid: 100,
            status: "R",
            cpuPercent: 50,
            rssBytes: 3_000,
            elapsed: "00:05",
            command: "rg needle",
          },
          {
            pid: 200,
            ppid: 1,
            pgid: 200,
            status: "R",
            cpuPercent: 99,
            rssBytes: 9_000,
            elapsed: "00:05",
            command: "unrelated",
          },
        ],
      });

      expect(samples.map((sample) => sample.pid)).toEqual([100, 101, 102]);
      expect(samples.map((sample) => sample.depth)).toEqual([0, 1, 2]);
      expect(samples[0]?.isServerRoot).toBe(true);
      expect(samples[1]?.isServerRoot).toBe(false);
    }),
  );

  it.effect("rolls samples up by process and CPU time", () =>
    Effect.sync(() => {
      const firstAt = DateTime.makeUnsafe("2026-05-05T10:00:00.000Z");
      const secondAt = DateTime.makeUnsafe("2026-05-05T10:00:05.000Z");
      const samples = [
        ...collectMonitoredSamples({
          serverPid: 100,
          sampledAt: firstAt,
          sampledAtMs: DateTime.toEpochMillis(firstAt),
          rows: [
            {
              pid: 100,
              ppid: 1,
              pgid: 100,
              status: "S",
              cpuPercent: 10,
              rssBytes: 1_000,
              elapsed: "01:00",
              command: "t3 server",
            },
          ],
        }),
        ...collectMonitoredSamples({
          serverPid: 100,
          sampledAt: secondAt,
          sampledAtMs: DateTime.toEpochMillis(secondAt),
          rows: [
            {
              pid: 100,
              ppid: 1,
              pgid: 100,
              status: "S",
              cpuPercent: 30,
              rssBytes: 2_000,
              elapsed: "01:05",
              command: "t3 server",
            },
          ],
        }),
      ];

      const result = aggregateProcessResourceHistory({
        samples,
        readAt: secondAt,
        readAtMs: DateTime.toEpochMillis(secondAt),
        windowMs: 60_000,
        bucketMs: 10_000,
        lastError: null,
      });

      expect(Option.isNone(result.error)).toBe(true);
      expect(result.topProcesses).toHaveLength(1);
      expect(result.topProcesses[0]?.avgCpuPercent).toBe(20);
      expect(result.topProcesses[0]?.maxCpuPercent).toBe(30);
      expect(result.topProcesses[0]?.cpuSecondsApprox).toBe(2);
      expect(result.totalCpuSecondsApprox).toBe(2);
      expect(result.buckets.some((bucket) => bucket.maxCpuPercent === 30)).toBe(true);
    }),
  );

  it.effect("keeps a process grouped when elapsed time drifts between samples", () =>
    Effect.sync(() => {
      const firstAt = DateTime.makeUnsafe("2026-05-05T10:00:00.400Z");
      const secondAt = DateTime.makeUnsafe("2026-05-05T10:00:05.900Z");
      const samples = [
        ...collectMonitoredSamples({
          serverPid: 100,
          sampledAt: firstAt,
          sampledAtMs: DateTime.toEpochMillis(firstAt),
          rows: [
            {
              pid: 100,
              ppid: 1,
              pgid: 100,
              status: "S",
              cpuPercent: 1,
              rssBytes: 1_000,
              elapsed: "01:00",
              command: "t3 server",
            },
          ],
        }),
        ...collectMonitoredSamples({
          serverPid: 100,
          sampledAt: secondAt,
          sampledAtMs: DateTime.toEpochMillis(secondAt),
          rows: [
            {
              pid: 100,
              ppid: 1,
              pgid: 100,
              status: "S",
              cpuPercent: 2,
              rssBytes: 2_000,
              elapsed: "01:06",
              command: "t3 server",
            },
          ],
        }),
      ];

      const result = aggregateProcessResourceHistory({
        samples,
        readAt: secondAt,
        readAtMs: DateTime.toEpochMillis(secondAt),
        windowMs: 60_000,
        bucketMs: 10_000,
        lastError: null,
      });

      expect(result.topProcesses).toHaveLength(1);
      expect(result.topProcesses[0]?.isServerRoot).toBe(true);
      expect(result.topProcesses[0]?.sampleCount).toBe(2);
      expect(result.topProcesses[0]?.maxRssBytes).toBe(2_000);
    }),
  );

  it.effect("returns all process summaries in the selected window", () =>
    Effect.sync(() => {
      const sampledAt = DateTime.makeUnsafe("2026-05-05T10:00:00.000Z");
      const samples = collectMonitoredSamples({
        serverPid: 100,
        sampledAt,
        sampledAtMs: DateTime.toEpochMillis(sampledAt),
        rows: [
          {
            pid: 100,
            ppid: 1,
            pgid: 100,
            status: "S",
            cpuPercent: 1,
            rssBytes: 1_000,
            elapsed: "01:00",
            command: "t3 server",
          },
          ...Array.from({ length: 35 }, (_, index) => ({
            pid: 200 + index,
            ppid: index === 0 ? 100 : 199 + index,
            pgid: 100,
            status: "S",
            cpuPercent: 35 - index,
            rssBytes: 2_000 + index,
            elapsed: "00:10",
            command: `worker ${index}`,
          })),
        ],
      });

      const result = aggregateProcessResourceHistory({
        samples,
        readAt: sampledAt,
        readAtMs: DateTime.toEpochMillis(sampledAt),
        windowMs: 60_000,
        bucketMs: 10_000,
        lastError: null,
      });

      expect(result.topProcesses).toHaveLength(36);
      expect(result.topProcesses.some((process) => process.command === "worker 34")).toBe(true);
    }),
  );

  it.effect("clamps adversarial durations and returns at most 720 buckets", () =>
    Effect.sync(() => {
      const readAtMs = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-05-05T10:00:00.000Z"));
      const result = aggregateProcessResourceHistory({
        samples: [],
        readAt: DateTime.makeUnsafe(readAtMs),
        readAtMs,
        windowMs: 3_600_001,
        bucketMs: 4_999,
        lastError: null,
      });

      expect(result.windowMs).toBe(3_600_000);
      expect(result.bucketMs).toBe(5_000);
      expect(result.bucketMs).toBeLessThanOrEqual(result.windowMs);
      expect(result.buckets).toHaveLength(720);
    }),
  );

  it.effect("includes a sample exactly on the final window boundary", () =>
    Effect.sync(() => {
      const readAtMs = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-05-05T10:00:00.000Z"));
      const result = aggregateProcessResourceHistory({
        samples: [makeSample({ sampledAtMs: readAtMs, cpuPercent: 42, rssBytes: 4_200 })],
        readAt: DateTime.makeUnsafe(readAtMs),
        readAtMs,
        windowMs: 10_000,
        bucketMs: 5_000,
        lastError: null,
      });

      expect(result.buckets).toHaveLength(2);
      expect(result.buckets[1]).toMatchObject({
        avgCpuPercent: 42,
        maxCpuPercent: 42,
        maxRssBytes: 4_200,
        maxProcessCount: 1,
      });
    }),
  );

  it.effect("preserves per-read aggregation metrics across normal buckets", () =>
    Effect.sync(() => {
      const readAtMs = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-05-05T10:00:00.000Z"));
      const samples = [
        makeSample({
          sampledAtMs: readAtMs - 20_000,
          processKey: "100:t3 server",
          pid: 100,
          cpuPercent: 10,
          rssBytes: 100,
        }),
        makeSample({
          sampledAtMs: readAtMs - 20_000,
          processKey: "101:worker",
          pid: 101,
          cpuPercent: 20,
          rssBytes: 200,
        }),
        makeSample({
          sampledAtMs: readAtMs - 15_000,
          cpuPercent: 30,
          rssBytes: 150,
        }),
        makeSample({
          sampledAtMs: readAtMs - 10_000,
          cpuPercent: 40,
          rssBytes: 250,
        }),
        makeSample({ sampledAtMs: readAtMs, cpuPercent: 50, rssBytes: 300 }),
      ];

      const result = aggregateProcessResourceHistory({
        samples,
        readAt: DateTime.makeUnsafe(readAtMs),
        readAtMs,
        windowMs: 20_000,
        bucketMs: 10_000,
        lastError: null,
      });

      expect(result.buckets).toHaveLength(2);
      expect(result.buckets[0]).toMatchObject({
        avgCpuPercent: 30,
        maxCpuPercent: 30,
        maxRssBytes: 300,
        maxProcessCount: 2,
      });
      expect(result.buckets[1]).toMatchObject({
        avgCpuPercent: 45,
        maxCpuPercent: 50,
        maxRssBytes: 300,
        maxProcessCount: 1,
      });
    }),
  );
});
