import {
  SERVER_PROCESS_RESOURCE_HISTORY_MAX_BUCKET_MS,
  SERVER_PROCESS_RESOURCE_HISTORY_MAX_WINDOW_MS,
  SERVER_PROCESS_RESOURCE_HISTORY_MIN_BUCKET_MS,
  SERVER_PROCESS_RESOURCE_HISTORY_MIN_WINDOW_MS,
  type ServerProcessResourceHistoryBucket,
  type ServerProcessResourceHistoryInput,
  type ServerProcessResourceHistoryResult,
  type ServerProcessResourceHistorySummary,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  buildDescendantEntries,
  isDiagnosticsQueryProcess,
  type ProcessRow,
  readProcessRows,
} from "./ProcessDiagnostics.ts";

const SAMPLE_INTERVAL_MS = 5_000;
const RETENTION_MS = 60 * 60_000;
const MAX_RETAINED_SAMPLES = 20_000;

export interface ProcessResourceSample {
  readonly sampledAt: DateTime.Utc;
  readonly sampledAtMs: number;
  readonly processKey: string;
  readonly pid: number;
  readonly ppid: number;
  readonly command: string;
  readonly cpuPercent: number;
  readonly rssBytes: number;
  readonly depth: number;
  readonly isServerRoot: boolean;
}

interface MonitorState {
  readonly samples: ReadonlyArray<ProcessResourceSample>;
  readonly lastError: string | null;
}

export interface ProcessResourceMonitorShape {
  readonly readHistory: (
    input: ServerProcessResourceHistoryInput,
  ) => Effect.Effect<ServerProcessResourceHistoryResult>;
}

export class ProcessResourceMonitor extends Context.Service<
  ProcessResourceMonitor,
  ProcessResourceMonitorShape
>()("t3/diagnostics/ProcessResourceMonitor") {}

function dateTimeFromMillis(ms: number): DateTime.Utc {
  return DateTime.makeUnsafe(ms);
}

function sampleKey(row: Pick<ProcessRow, "pid" | "command">): string {
  return `${row.pid}:${row.command}`;
}

function findServerRootRow(rows: ReadonlyArray<ProcessRow>, serverPid: number): ProcessRow | null {
  return rows.find((row) => row.pid === serverPid) ?? null;
}

export function collectMonitoredSamples(input: {
  readonly rows: ReadonlyArray<ProcessRow>;
  readonly serverPid: number;
  readonly sampledAt: DateTime.Utc;
  readonly sampledAtMs: number;
}): ReadonlyArray<ProcessResourceSample> {
  const rows = input.rows.filter((row) => !isDiagnosticsQueryProcess(row, input.serverPid));
  const root = findServerRootRow(rows, input.serverPid);
  const descendants = buildDescendantEntries(rows, input.serverPid);
  const samples: ProcessResourceSample[] = [];

  if (root) {
    samples.push({
      sampledAt: input.sampledAt,
      sampledAtMs: input.sampledAtMs,
      processKey: sampleKey(root),
      pid: root.pid,
      ppid: root.ppid,
      command: root.command,
      cpuPercent: root.cpuPercent,
      rssBytes: root.rssBytes,
      depth: 0,
      isServerRoot: true,
    });
  }

  for (const process of descendants) {
    samples.push({
      sampledAt: input.sampledAt,
      sampledAtMs: input.sampledAtMs,
      processKey: sampleKey(process),
      pid: process.pid,
      ppid: process.ppid,
      command: process.command,
      cpuPercent: process.cpuPercent,
      rssBytes: process.rssBytes,
      depth: process.depth + 1,
      isServerRoot: false,
    });
  }

  return samples;
}

function trimSamples(
  samples: ReadonlyArray<ProcessResourceSample>,
  nowMs: number,
): ReadonlyArray<ProcessResourceSample> {
  const minSampledAtMs = nowMs - RETENTION_MS;
  const retained = samples.filter((sample) => sample.sampledAtMs >= minSampledAtMs);
  return retained.length <= MAX_RETAINED_SAMPLES
    ? retained
    : retained.slice(retained.length - MAX_RETAINED_SAMPLES);
}

function summarizeProcesses(
  samples: ReadonlyArray<ProcessResourceSample>,
): ReadonlyArray<ServerProcessResourceHistorySummary> {
  const groups = new Map<string, ProcessResourceSample[]>();
  for (const sample of samples) {
    const processSamples = groups.get(sample.processKey) ?? [];
    processSamples.push(sample);
    groups.set(sample.processKey, processSamples);
  }

  return [...groups.entries()]
    .map(([processKey, processSamples]) => {
      const sorted = processSamples.toSorted((left, right) => left.sampledAtMs - right.sampledAtMs);
      const first = sorted[0]!;
      const latest = sorted[sorted.length - 1]!;
      const cpuPercentTotal = sorted.reduce((total, sample) => total + sample.cpuPercent, 0);
      const maxCpuPercent = Math.max(...sorted.map((sample) => sample.cpuPercent));
      const maxRssBytes = Math.max(...sorted.map((sample) => sample.rssBytes));
      const cpuSecondsApprox = sorted.reduce(
        (total, sample) => total + (sample.cpuPercent / 100) * (SAMPLE_INTERVAL_MS / 1_000),
        0,
      );

      return {
        processKey,
        pid: latest.pid,
        ppid: latest.ppid,
        command: latest.command,
        depth: latest.depth,
        isServerRoot: latest.isServerRoot,
        firstSeenAt: first.sampledAt,
        lastSeenAt: latest.sampledAt,
        currentCpuPercent: latest.cpuPercent,
        avgCpuPercent: cpuPercentTotal / sorted.length,
        maxCpuPercent,
        cpuSecondsApprox,
        currentRssBytes: latest.rssBytes,
        maxRssBytes,
        sampleCount: sorted.length,
      } satisfies ServerProcessResourceHistorySummary;
    })
    .toSorted((left, right) => right.cpuSecondsApprox - left.cpuSecondsApprox);
}

function clampDurationMs(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) {
    return value === Number.POSITIVE_INFINITY ? maximum : minimum;
  }
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}

interface ProcessResourceReadTotals {
  cpuPercent: number;
  rssBytes: number;
  processCount: number;
}

interface ProcessResourceBucketAccumulator {
  readonly startedAtMs: number;
  readonly endedAtMs: number;
  readonly readTotalsBySampledAt: Map<number, ProcessResourceReadTotals>;
}

function buildBuckets(input: {
  readonly samples: ReadonlyArray<ProcessResourceSample>;
  readonly nowMs: number;
  readonly windowMs: number;
  readonly bucketMs: number;
}): ReadonlyArray<ServerProcessResourceHistoryBucket> {
  const windowStartMs = input.nowMs - input.windowMs;
  const bucketCount = Math.ceil(input.windowMs / input.bucketMs);
  const accumulators: ProcessResourceBucketAccumulator[] = Array.from(
    { length: bucketCount },
    (_, index) => {
      const startedAtMs = windowStartMs + index * input.bucketMs;
      return {
        startedAtMs,
        endedAtMs: Math.min(input.nowMs, startedAtMs + input.bucketMs),
        readTotalsBySampledAt: new Map(),
      };
    },
  );

  for (const sample of input.samples) {
    if (sample.sampledAtMs < windowStartMs || sample.sampledAtMs > input.nowMs) {
      continue;
    }

    const bucketIndex =
      sample.sampledAtMs === input.nowMs
        ? bucketCount - 1
        : Math.floor((sample.sampledAtMs - windowStartMs) / input.bucketMs);
    const bucket = accumulators[bucketIndex];
    if (!bucket) {
      continue;
    }

    const current = bucket.readTotalsBySampledAt.get(sample.sampledAtMs);
    if (current) {
      current.cpuPercent += sample.cpuPercent;
      current.rssBytes += sample.rssBytes;
      current.processCount += 1;
    } else {
      bucket.readTotalsBySampledAt.set(sample.sampledAtMs, {
        cpuPercent: sample.cpuPercent,
        rssBytes: sample.rssBytes,
        processCount: 1,
      });
    }
  }

  return accumulators.map((bucket) => {
    let cpuPercentTotal = 0;
    let maxCpuPercent = 0;
    let maxRssBytes = 0;
    let maxProcessCount = 0;
    for (const totals of bucket.readTotalsBySampledAt.values()) {
      cpuPercentTotal += totals.cpuPercent;
      maxCpuPercent = Math.max(maxCpuPercent, totals.cpuPercent);
      maxRssBytes = Math.max(maxRssBytes, totals.rssBytes);
      maxProcessCount = Math.max(maxProcessCount, totals.processCount);
    }

    return {
      startedAt: dateTimeFromMillis(bucket.startedAtMs),
      endedAt: dateTimeFromMillis(bucket.endedAtMs),
      avgCpuPercent:
        bucket.readTotalsBySampledAt.size === 0
          ? 0
          : cpuPercentTotal / bucket.readTotalsBySampledAt.size,
      maxCpuPercent,
      maxRssBytes,
      maxProcessCount,
    };
  });
}

export function aggregateProcessResourceHistory(input: {
  readonly samples: ReadonlyArray<ProcessResourceSample>;
  readonly readAt: DateTime.Utc;
  readonly readAtMs: number;
  readonly windowMs: number;
  readonly bucketMs: number;
  readonly lastError: string | null;
}): ServerProcessResourceHistoryResult {
  const windowMs = clampDurationMs(
    input.windowMs,
    SERVER_PROCESS_RESOURCE_HISTORY_MIN_WINDOW_MS,
    SERVER_PROCESS_RESOURCE_HISTORY_MAX_WINDOW_MS,
  );
  const bucketMs = Math.min(
    windowMs,
    clampDurationMs(
      input.bucketMs,
      SERVER_PROCESS_RESOURCE_HISTORY_MIN_BUCKET_MS,
      SERVER_PROCESS_RESOURCE_HISTORY_MAX_BUCKET_MS,
    ),
  );
  const minSampledAtMs = input.readAtMs - windowMs;
  const samples = input.samples.filter((sample) => sample.sampledAtMs >= minSampledAtMs);
  const topProcesses = summarizeProcesses(samples);
  const totalCpuSecondsApprox = samples.reduce(
    (total, sample) => total + (sample.cpuPercent / 100) * (SAMPLE_INTERVAL_MS / 1_000),
    0,
  );

  return {
    readAt: input.readAt,
    windowMs,
    bucketMs,
    sampleIntervalMs: SAMPLE_INTERVAL_MS,
    retainedSampleCount: input.samples.length,
    totalCpuSecondsApprox,
    buckets: buildBuckets({ samples, nowMs: input.readAtMs, windowMs, bucketMs }),
    topProcesses,
    error: input.lastError ? Option.some({ message: input.lastError }) : Option.none(),
  };
}

export const make = Effect.fn("makeProcessResourceMonitor")(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const state = yield* Ref.make<MonitorState>({ samples: [], lastError: null });

  const sampleOnce = Effect.gen(function* () {
    const sampledAt = yield* DateTime.now;
    const sampledAtMs = DateTime.toEpochMillis(sampledAt);
    const rows = yield* readProcessRows().pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
    const samples = collectMonitoredSamples({
      rows,
      serverPid: process.pid,
      sampledAt,
      sampledAtMs,
    });
    yield* Ref.update(state, (current) => ({
      samples: trimSamples([...current.samples, ...samples], sampledAtMs),
      lastError: null,
    }));
  }).pipe(
    Effect.catch((error: unknown) =>
      Ref.update(state, (current) => ({
        ...current,
        lastError: error instanceof Error ? error.message : "Failed to sample process resources.",
      })),
    ),
  );

  yield* Effect.forever(sampleOnce.pipe(Effect.andThen(Effect.sleep(SAMPLE_INTERVAL_MS)))).pipe(
    Effect.forkScoped,
  );

  const readHistory: ProcessResourceMonitorShape["readHistory"] = (input) =>
    Effect.gen(function* () {
      const readAt = yield* DateTime.now;
      const readAtMs = DateTime.toEpochMillis(readAt);
      const current = yield* Ref.get(state);
      return aggregateProcessResourceHistory({
        samples: current.samples,
        readAt,
        readAtMs,
        windowMs: input.windowMs,
        bucketMs: input.bucketMs,
        lastError: current.lastError,
      });
    });

  return ProcessResourceMonitor.of({ readHistory });
});

export const layer = Layer.effect(ProcessResourceMonitor, make());
