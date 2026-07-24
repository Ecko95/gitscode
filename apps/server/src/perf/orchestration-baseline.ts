/**
 * Orchestration hot-path baseline harness — W4.1
 *
 * Measures per-stage latency across the core orchestration pipeline:
 *   dispatch-enqueue → decider → event-store append (inside SQL tx) →
 *   projection apply → pubsub publish → dispatch returns (Deferred resolved)
 *
 * Provider CLI processes (codex/claude) are NOT involved; this exercises the
 * pure orchestration pipeline only.  Provider-process overhead is a separate
 * measurement concern.
 *
 * Run:
 *   bun apps/server/src/perf/orchestration-baseline.ts
 *
 * Optional env knobs:
 *   PERF_SESSIONS=10               # maximum concurrent virtual sessions (default: 10)
 *   PERF_DISPATCHES_PER_SESSION=50 # measured dispatches per session (default: 50)
 *   PERF_WARMUP=10                  # warm-up dispatches before measurement (default: 10)
 *   PERF_JSON=1                     # emit one machine-readable JSON document to stdout
 */

import * as Os from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as ManagedRuntime from "effect/ManagedRuntime";

import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";

import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { RepositoryIdentityResolverLive } from "../project/Layers/RepositoryIdentityResolver.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ServerConfig } from "../config.ts";

const print = (line: string) => process.stdout.write(`${line}\n`);

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))] ?? 0;
}

function stats(values: number[]): {
  p50: number;
  p95: number;
  p99: number;
  mean: number;
  min: number;
  max: number;
  coefficientOfVariation: number;
} {
  if (values.length === 0) {
    return {
      p50: 0,
      p95: 0,
      p99: 0,
      mean: 0,
      min: 0,
      max: 0,
      coefficientOfVariation: 0,
    };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  const standardDeviation = Math.sqrt(variance);
  return {
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    mean,
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
    coefficientOfVariation: mean === 0 ? 0 : standardDeviation / mean,
  };
}

function fmtMs(v: number): string {
  return `${v.toFixed(2)}ms`;
}

function fmtPercent(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

// ── Harness ──────────────────────────────────────────────────────────────────

const DISPATCHES_PER_CYCLE = 5;

function readIntegerKnob(input: {
  readonly name: string;
  readonly defaultValue: number;
  readonly minimum: number;
  readonly multipleOf?: number;
}): number {
  const raw = process.env[input.name];
  const value = raw === undefined ? input.defaultValue : Number(raw);
  const multipleIsValid = input.multipleOf === undefined || value % input.multipleOf === 0;
  if (!Number.isSafeInteger(value) || value < input.minimum || !multipleIsValid) {
    const multipleRequirement =
      input.multipleOf === undefined ? "" : ` and divisible by ${input.multipleOf}`;
    throw new Error(
      `${input.name} must be a safe integer >= ${input.minimum}${multipleRequirement}; received ${JSON.stringify(raw)}.`,
    );
  }
  return value;
}

function readJsonOutput(): boolean {
  const raw = process.env["PERF_JSON"];
  if (raw === undefined || raw === "0") {
    return false;
  }
  if (raw === "1") {
    return true;
  }
  throw new Error(`PERF_JSON must be 0 or 1; received ${JSON.stringify(raw)}.`);
}

if (process.env["PERF_EVENTS_PER_SESSION"] !== undefined) {
  throw new Error(
    "PERF_EVENTS_PER_SESSION was renamed to PERF_DISPATCHES_PER_SESSION because the harness counts command dispatches, not emitted domain events.",
  );
}

const SESSIONS = readIntegerKnob({
  name: "PERF_SESSIONS",
  defaultValue: 10,
  minimum: 1,
});
const DISPATCHES_PER_SESSION = readIntegerKnob({
  name: "PERF_DISPATCHES_PER_SESSION",
  defaultValue: 50,
  minimum: DISPATCHES_PER_CYCLE,
  multipleOf: DISPATCHES_PER_CYCLE,
});
const WARMUP = readIntegerKnob({
  name: "PERF_WARMUP",
  defaultValue: 10,
  minimum: 0,
  multipleOf: DISPATCHES_PER_CYCLE,
});
const JSON_OUTPUT = readJsonOutput();

if (JSON_OUTPUT) {
  // Effect's default logger is active while the benchmark layer is being built.
  // Keep those startup diagnostics on stderr so stdout remains one JSON document.
  globalThis.console.log = globalThis.console.error;
}

interface HostInfo {
  readonly label: string;
  readonly platform: NodeJS.Platform;
  readonly release: string;
  readonly architecture: string;
  readonly logicalCpuCount: number;
  readonly isWsl: boolean;
  readonly wslDistribution?: string;
}

function getHostInfo(): HostInfo {
  const wslDistribution = process.env["WSL_DISTRO_NAME"];
  const platform = process.platform;
  const release = Os.release();
  const isWsl =
    wslDistribution !== undefined ||
    process.env["WSL_INTEROP"] !== undefined ||
    release.toLowerCase().includes("microsoft");
  const architecture = Os.arch();
  const logicalCpuCount = Os.cpus().length;
  const environment = isWsl ? `WSL${wslDistribution ? ` (${wslDistribution})` : ""}` : Os.type();
  return {
    label: `${environment} ${release} / ${architecture} / ${logicalCpuCount} logical CPUs`,
    platform,
    release,
    architecture,
    logicalCpuCount,
    isWsl,
    ...(wslDistribution ? { wslDistribution } : {}),
  };
}

function getConcurrencyLevels(maxConcurrentSessions: number): ReadonlyArray<number> {
  return [...new Set([1, Math.min(5, maxConcurrentSessions), maxConcurrentSessions])].toSorted(
    (left, right) => left - right,
  );
}

// ponytail: monotonic counter replaces Math.random()+Date.now() — avoids both
// the Effect globalRandom + globalDate lint rules in this non-Effect script context.
let _seq = 0;
const nextId = () => {
  _seq += 1;
  return _seq.toString(36).padStart(6, "0");
};

interface StageTimings {
  // Wall-clock duration of engine.dispatch() — covers queue-wait + decider +
  // SQL-tx + projection + pubsub + deferred-resolve.  This is the only
  // measurement a caller sees and is the end-to-end hot-path number.
  dispatchMs: number[];
}

interface SessionResult {
  sessionId: string;
  dispatches: number;
  timings: StageTimings;
}

async function createOrchestrationSystem() {
  const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-perf-baseline-",
  });
  const orchestrationLayer = Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
    ),
    OrchestrationProjectionSnapshotQueryLive,
  ).pipe(
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolverLive),
    Layer.provide(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfigLayer),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(
      Logger.layer(
        [Logger.consolePretty({ stderr: JSON_OUTPUT, colors: JSON_OUTPUT ? false : "auto" })],
        { mergeWithExisting: false },
      ),
    ),
  );
  const runtime = ManagedRuntime.make(orchestrationLayer);
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  return {
    engine,
    run: <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect),
    dispose: () => runtime.dispose(),
  };
}

const NOW = "2026-01-01T00:00:00.000Z";

function mkProjectId(n: string) {
  return ProjectId.make(`proj-${n}`);
}
function mkThreadId(n: string) {
  return ThreadId.make(`thread-${n}`);
}
function mkCommandId(tag: string) {
  return CommandId.make(`cmd-${tag}-${nextId()}`);
}
function mkEventId() {
  return EventId.make(`evt-${nextId()}`);
}
function mkMessageId() {
  return MessageId.make(`msg-${nextId()}`);
}
function mkTurnId() {
  return TurnId.make(`turn-${nextId()}`);
}

const DEFAULT_MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
};

/**
 * Run a synthetic session: create project + thread, then dispatch a realistic
 * command mix (turn.start → session.set → message.assistant.delta ×N →
 * message.assistant.complete → activity.append) in a loop.
 *
 * Returns per-dispatch timings so the caller can compute per-stage stats.
 *
 * NOTE: the engine queue is serial (single command fiber).  Concurrent callers
 * share the queue — this is intentional and reflects production behaviour.
 */
async function runSession(
  sessionIndex: number,
  engine: Awaited<ReturnType<typeof createOrchestrationSystem>>["engine"],
  run: Awaited<ReturnType<typeof createOrchestrationSystem>>["run"],
  dispatchesPerSession: number,
  warmup: boolean,
): Promise<SessionResult> {
  const sessionId = `s${sessionIndex}-${nextId()}`;
  const projectId = mkProjectId(sessionId);
  const threadId = mkThreadId(sessionId);
  const dispatchMs: number[] = [];

  // Wrap dispatch in orDie so errors surface as defects (timing still captured)
  const timed = async (eff: Effect.Effect<unknown, never>): Promise<void> => {
    const t0 = performance.now();
    await run(eff);
    const elapsed = performance.now() - t0;
    if (!warmup) {
      dispatchMs.push(elapsed);
    }
  };

  // Setup: create project + thread (not counted in measurement)
  await run(
    engine
      .dispatch(
        {
          type: "project.create",
          commandId: mkCommandId("proj-create"),
          projectId,
          title: `Perf Project ${sessionId}`,
          workspaceRoot: `/tmp/perf-${sessionId}`,
          defaultModelSelection: DEFAULT_MODEL_SELECTION,
          createdAt: NOW,
        },
        "operator",
      )
      .pipe(Effect.orDie),
  );

  await run(
    engine
      .dispatch(
        {
          type: "thread.create",
          commandId: mkCommandId("thread-create"),
          threadId,
          projectId,
          title: `Perf Thread ${sessionId}`,
          modelSelection: DEFAULT_MODEL_SELECTION,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt: NOW,
        },
        "operator",
      )
      .pipe(Effect.orDie),
  );

  // Dispatch loop — mix of the most common hot-path command types:
  //   turn.start (2 domain events produced: message-sent + turn-start-requested)
  //   session.set
  //   message.assistant.delta (streaming chunk — common in real sessions)
  //   message.assistant.complete
  //   activity.append
  const cycles = dispatchesPerSession / DISPATCHES_PER_CYCLE;

  for (let i = 0; i < cycles; i += 1) {
    const messageId = mkMessageId();
    const turnId = mkTurnId();

    await timed(
      engine
        .dispatch(
          {
            type: "thread.turn.start",
            commandId: mkCommandId("turn-start"),
            threadId,
            message: {
              messageId,
              role: "user",
              text: `perf test message ${i}`,
              attachments: [],
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "approval-required",
            createdAt: NOW,
          },
          "operator",
        )
        .pipe(Effect.orDie),
    );

    await timed(
      engine
        .dispatch(
          {
            type: "thread.session.set",
            commandId: mkCommandId("session-set"),
            threadId,
            session: {
              threadId,
              status: "running",
              providerName: "codex",
              providerInstanceId: ProviderInstanceId.make("codex"),
              workPersonalFallbackInstanceId: null,
              runtimeMode: "approval-required",
              activeTurnId: turnId,
              lastError: null,
              updatedAt: NOW,
            },
            createdAt: NOW,
          },
          "provider",
        )
        .pipe(Effect.orDie),
    );

    await timed(
      engine
        .dispatch(
          {
            type: "thread.message.assistant.delta",
            commandId: mkCommandId("msg-delta"),
            threadId,
            messageId: mkMessageId(),
            turnId,
            delta: "hello world streaming",
            createdAt: NOW,
          },
          "provider",
        )
        .pipe(Effect.orDie),
    );

    await timed(
      engine
        .dispatch(
          {
            type: "thread.message.assistant.complete",
            commandId: mkCommandId("msg-complete"),
            threadId,
            messageId: mkMessageId(),
            turnId,
            createdAt: NOW,
          },
          "provider",
        )
        .pipe(Effect.orDie),
    );

    await timed(
      engine
        .dispatch(
          {
            type: "thread.activity.append",
            commandId: mkCommandId("activity"),
            threadId,
            activity: {
              id: mkEventId(),
              tone: "info",
              kind: "provider.turn.completed",
              summary: "turn completed",
              payload: { detail: "perf baseline" },
              turnId,
              createdAt: NOW,
            },
            createdAt: NOW,
          },
          "provider",
        )
        .pipe(Effect.orDie),
    );
  }

  return {
    sessionId,
    dispatches: dispatchMs.length,
    timings: { dispatchMs },
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────

interface LoadResult {
  readonly concurrentSessions: number;
  readonly totalDispatches: number;
  readonly elapsedMs: number;
  readonly dispatchesPerSecond: number;
  readonly dispatchStats: ReturnType<typeof stats>;
}

interface BenchmarkReport {
  readonly schemaVersion: 1;
  readonly benchmark: "gits-orchestration-dispatch-hot-path";
  readonly environment: {
    readonly host: HostInfo;
    readonly sqliteMode: "in-memory";
    readonly providerProcessesIncluded: false;
    readonly bunVersion: string;
    readonly nodeVersion: string;
  };
  readonly configuration: {
    readonly maxConcurrentSessions: number;
    readonly concurrencyLevels: ReadonlyArray<number>;
    readonly dispatchesPerSession: number;
    readonly warmupDispatches: number;
    readonly dispatchesPerCycle: number;
  };
  readonly runs: ReadonlyArray<LoadResult>;
}

async function runLoad(concurrentSessions: number): Promise<LoadResult> {
  const system = await createOrchestrationSystem();
  try {
    // Warm-up is serial and excluded from the measured interval.
    await runSession(0, system.engine, system.run, WARMUP, true);

    const startedAt = performance.now();
    const results = await Promise.all(
      Array.from({ length: concurrentSessions }, (_, index) =>
        runSession(index + 1, system.engine, system.run, DISPATCHES_PER_SESSION, false),
      ),
    );
    const elapsedMs = performance.now() - startedAt;
    const allDispatches = results.flatMap((result) => result.timings.dispatchMs);
    const totalDispatches = allDispatches.length;

    return {
      concurrentSessions,
      totalDispatches,
      elapsedMs,
      dispatchesPerSecond: totalDispatches / (elapsedMs / 1_000),
      dispatchStats: stats(allDispatches),
    };
  } finally {
    await system.dispose();
  }
}

async function main() {
  const concurrencyLevels = getConcurrencyLevels(SESSIONS);
  const host = getHostInfo();

  if (!JSON_OUTPUT) {
    print("");
    print("=== GITS Orchestration Dispatch Hot-Path Baseline (W4.1) ===");
    print("");
    print(`Environment   : ${host.label}`);
    print("SQLite mode   : in-memory (:memory:)");
    print("Provider      : EXCLUDED (synthetic commands only)");
    print(
      `Dispatch/sess : ${DISPATCHES_PER_SESSION} (${DISPATCHES_PER_SESSION / DISPATCHES_PER_CYCLE} turn cycles × ${DISPATCHES_PER_CYCLE} dispatches/cycle)`,
    );
    print(`Warm-up       : ${WARMUP} dispatches before measurement`);
    print("");
  }

  const runs: LoadResult[] = [];

  for (const level of concurrencyLevels) {
    if (!JSON_OUTPUT) {
      process.stdout.write(`  Running ${level} concurrent session(s)...`);
    }
    const result = await runLoad(level);
    runs.push(result);
    if (!JSON_OUTPUT) {
      process.stdout.write(
        ` done (${result.totalDispatches} dispatches in ${fmtMs(result.elapsedMs)})\n`,
      );
    }
  }

  const report: BenchmarkReport = {
    schemaVersion: 1,
    benchmark: "gits-orchestration-dispatch-hot-path",
    environment: {
      host,
      sqliteMode: "in-memory",
      providerProcessesIncluded: false,
      bunVersion: process.versions.bun ?? "unknown",
      nodeVersion: process.versions.node,
    },
    configuration: {
      maxConcurrentSessions: SESSIONS,
      concurrencyLevels,
      dispatchesPerSession: DISPATCHES_PER_SESSION,
      warmupDispatches: WARMUP,
      dispatchesPerCycle: DISPATCHES_PER_CYCLE,
    },
    runs,
  };

  if (JSON_OUTPUT) {
    print(JSON.stringify(report));
    return;
  }

  // ── Table ────────────────────────────────────────────────────────────────

  print("");
  print(
    [
      "Sessions".padEnd(10),
      "Dispatches".padEnd(12),
      "p50".padEnd(10),
      "p95".padEnd(10),
      "p99".padEnd(10),
      "mean".padEnd(10),
      "min".padEnd(10),
      "max".padEnd(10),
      "cv".padEnd(8),
      "dispatch/s".padEnd(12),
      "total_ms",
    ].join(" | "),
  );
  print("-".repeat(145));

  for (const r of runs) {
    const d = r.dispatchStats;
    print(
      [
        String(r.concurrentSessions).padEnd(10),
        String(r.totalDispatches).padEnd(12),
        fmtMs(d.p50).padEnd(10),
        fmtMs(d.p95).padEnd(10),
        fmtMs(d.p99).padEnd(10),
        fmtMs(d.mean).padEnd(10),
        fmtMs(d.min).padEnd(10),
        fmtMs(d.max).padEnd(10),
        fmtPercent(d.coefficientOfVariation).padEnd(8),
        r.dispatchesPerSecond.toFixed(1).padEnd(12),
        fmtMs(r.elapsedMs),
      ].join(" | "),
    );
  }

  print("");
  print("Stage breakdown (all timings inside engine.dispatch() wall-clock):");
  print(
    "  enqueue → command fiber dequeue : queue wait  (unmeasured; typically <0.1ms at low load)",
  );
  print("  decider                         : in-memory read-model logic, no I/O");
  print("  eventStore.append               : SQLite INSERT inside transaction");
  print("  projectionPipeline.projectEvent : 10 projectors × SQLite UPSERT inside transaction");
  print("  commandReceiptRepository.upsert : SQLite UPSERT inside transaction");
  print("  PubSub.publish                  : in-memory fan-out (no I/O)");
  print("  Deferred.succeed                : resolves caller's await");
  print("");
  print("NOTE: the engine command fiber is single-threaded (serial queue).");
  print("At concurrent sessions >1, all sessions share one queue — dispatches serialise.");
  print("The p95 at high concurrency reflects queue-depth buildup, not per-command cost.");
  print("");

  // ── Downstream task assessment ────────────────────────────────────────────

  const keyedConcurrency = Math.min(5, SESSIONS);
  const keyedRun = runs.find((run) => run.concurrentSessions === keyedConcurrency);
  const maxRun = runs.find((run) => run.concurrentSessions === SESSIONS);
  const keyedP95 = keyedRun?.dispatchStats.p95 ?? 0;
  const maxP95 = maxRun?.dispatchStats.p95 ?? 0;

  print("=== Downstream task assessment ===");
  print("");
  print(`W4.3 Keyed reactors: ${keyedP95 > 50 ? "LIKELY JUSTIFIED" : "monitor first"}`);
  print("  Rationale: keyed reactors help when multiple threads contend on the serial queue.");
  print(
    `  p95@${keyedConcurrency}sess=${fmtMs(keyedP95)} — ${keyedP95 > 50 ? "contention is visible" : "queue wait is low"}.`,
  );
  print("");
  print(`W4.4 Backpressure: ${maxP95 > 100 ? "JUSTIFIED" : "premature at current load"}`);
  print("  Rationale: backpressure is needed when Queue.unbounded growth causes OOM risk.");
  print(
    `  p95@${SESSIONS}sess=${fmtMs(maxP95)} — ${maxP95 > 100 ? "queue depth is a concern" : "queue drains fast enough"}.`,
  );
  print("");
  print(`W4.7 Cold-start snapshots: assess bootstrap time separately`);
  print("  This harness uses :memory: SQLite and skips bootstrap replay.");
  print(
    "  Snapshot benefit is proportional to event-store size at startup — measure after DB has 1k+ events.",
  );
}

main().catch((err) => {
  process.stderr.write(`${String(err)}\n`);
  process.exit(1);
});
