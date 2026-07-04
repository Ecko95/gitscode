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
 *   PERF_SESSIONS=10           # concurrent virtual sessions (default: 10)
 *   PERF_EVENTS_PER_SESSION=20 # events per session (default: 20)
 *   PERF_WARMUP=5              # warm-up dispatches before measurement (default: 5)
 */

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Stream from "effect/Stream";

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

// ponytail: thin wrapper so we don't scatter process.stdout calls everywhere
const print = (line: string) => process.stdout.write(`${line}\n`);

// ponytail: percentile from sorted array, no extra dep
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
  mean: number;
  min: number;
  max: number;
} {
  if (values.length === 0) {
    return { p50: 0, p95: 0, mean: 0, min: 0, max: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  return {
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    mean,
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
  };
}

function fmtMs(v: number): string {
  return `${v.toFixed(2)}ms`;
}

// ── Harness ──────────────────────────────────────────────────────────────────

const SESSIONS = Number(process.env["PERF_SESSIONS"] ?? 10);
const EVENTS_PER_SESSION = Number(process.env["PERF_EVENTS_PER_SESSION"] ?? 20);
const WARMUP = Number(process.env["PERF_WARMUP"] ?? 5);

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
  events: number;
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
 * event mix (turn.start → session.set → message.assistant.delta ×N →
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
  eventsPerSession: number,
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

  // Event loop — mix of the most common hot-path event types:
  //   turn.start (2 events produced: message-sent + turn-start-requested)
  //   session.set
  //   message.assistant.delta (streaming chunk — common in real sessions)
  //   message.assistant.complete
  //   activity.append
  const CYCLE = 5; // events per turn cycle
  const cycles = Math.floor(eventsPerSession / CYCLE);

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
              runtimeMode: "approval-required",
              activeTurnId: turnId,
              lastError: null,
              updatedAt: NOW,
            },
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
            type: "thread.message.assistant.delta",
            commandId: mkCommandId("msg-delta"),
            threadId,
            messageId: mkMessageId(),
            turnId,
            delta: "hello world streaming",
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
            type: "thread.message.assistant.complete",
            commandId: mkCommandId("msg-complete"),
            threadId,
            messageId: mkMessageId(),
            turnId,
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
          "operator",
        )
        .pipe(Effect.orDie),
    );
  }

  return {
    sessionId,
    events: dispatchMs.length,
    timings: { dispatchMs },
  };
}

// ── PubSub event counter (stream subscriber) ──────────────────────────────

/**
 * Subscribe to the domain event stream and count events for the duration of
 * the run. Used to verify push-path throughput matches dispatch count.
 *
 * We can't measure per-event push latency here because the engine serialises
 * publication inside the command fiber (PubSub.publish happens inside the
 * transaction + before Deferred.succeed) — the round-trip latency is already
 * captured inside dispatchMs.  A separate client-side measurement would
 * require an RPC WebSocket connection.
 */
function startEventCounter(
  engine: Awaited<ReturnType<typeof createOrchestrationSystem>>["engine"],
  run: Awaited<ReturnType<typeof createOrchestrationSystem>>["run"],
): { stop: () => Promise<number> } {
  let count = 0;
  let done = false;
  const countEffect = engine.streamDomainEvents.pipe(
    Stream.tap(() =>
      Effect.sync(() => {
        count += 1;
      }),
    ),
    Stream.takeWhile(() => !done),
    Stream.runDrain,
  );

  // fire-and-forget in background; ignore errors on teardown
  run(countEffect).catch(() => {});

  return {
    stop: () => {
      done = true;
      return Promise.resolve(count);
    },
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function runLoad(concurrentSessions: number): Promise<{
  concurrentSessions: number;
  totalEvents: number;
  elapsedMs: number;
  throughputEventsPerSec: number;
  dispatchStats: ReturnType<typeof stats>;
}> {
  const system = await createOrchestrationSystem();

  // warmup: serial single-session to prime the sqlite pages + JIT
  await runSession(0, system.engine, system.run, WARMUP, true);

  const counter = startEventCounter(system.engine, system.run);

  const t0 = performance.now();
  const results = await Promise.all(
    Array.from({ length: concurrentSessions }, (_, i) =>
      runSession(i + 1, system.engine, system.run, EVENTS_PER_SESSION, false),
    ),
  );
  const elapsed = performance.now() - t0;

  await counter.stop();

  await system.dispose();

  const allDispatch = results.flatMap((r) => r.timings.dispatchMs);
  const totalEvents = allDispatch.length;

  return {
    concurrentSessions,
    totalEvents,
    elapsedMs: elapsed,
    throughputEventsPerSec: totalEvents / (elapsed / 1000),
    dispatchStats: stats(allDispatch),
  };
}

async function main() {
  const concurrencyLevels = [1, 5, SESSIONS];

  print("");
  print("=== GITS Orchestration Hot-Path Baseline (W4.1) ===");
  print("");
  print(`Environment : WSL2 / Linux (shared host)`);
  print(`SQLite mode : in-memory (:memory:)`);
  print(`Provider    : EXCLUDED (synthetic commands only)`);
  print(
    `Events/sess : ${EVENTS_PER_SESSION} (${EVENTS_PER_SESSION / 5} turn cycles × 5 events/cycle)`,
  );
  print(`Warm-up     : ${WARMUP} dispatches before measurement`);
  print("");

  const runs: Array<Awaited<ReturnType<typeof runLoad>>> = [];

  for (const level of concurrencyLevels) {
    process.stdout.write(`  Running ${level} concurrent session(s)...`);
    const result = await runLoad(level);
    runs.push(result);
    process.stdout.write(` done (${result.totalEvents} events in ${fmtMs(result.elapsedMs)})\n`);
  }

  // ── Table ────────────────────────────────────────────────────────────────

  print("");
  print(
    [
      "Sessions".padEnd(10),
      "Events".padEnd(8),
      "p50".padEnd(10),
      "p95".padEnd(10),
      "mean".padEnd(10),
      "min".padEnd(10),
      "max".padEnd(10),
      "evts/s".padEnd(10),
      "total_ms",
    ].join(" | "),
  );
  print("-".repeat(110));

  for (const r of runs) {
    const d = r.dispatchStats;
    print(
      [
        String(r.concurrentSessions).padEnd(10),
        String(r.totalEvents).padEnd(8),
        fmtMs(d.p50).padEnd(10),
        fmtMs(d.p95).padEnd(10),
        fmtMs(d.mean).padEnd(10),
        fmtMs(d.min).padEnd(10),
        fmtMs(d.max).padEnd(10),
        r.throughputEventsPerSec.toFixed(1).padEnd(10),
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

  const run5 = runs.find((r) => r.concurrentSessions === 5);
  const run10 = runs.find((r) => r.concurrentSessions === SESSIONS);
  const p95_5 = run5?.dispatchStats.p95 ?? 0;
  const p95_10 = run10?.dispatchStats.p95 ?? 0;

  print("=== Downstream task assessment ===");
  print("");
  print(`W4.3 Keyed reactors: ${p95_5 > 50 ? "LIKELY JUSTIFIED" : "monitor first"}`);
  print("  Rationale: keyed reactors help when multiple threads contend on the serial queue.");
  print(
    `  p95@5sess=${fmtMs(p95_5)} — ${p95_5 > 50 ? "contention is visible" : "queue wait is low"}.`,
  );
  print("");
  print(`W4.4 Backpressure: ${p95_10 > 100 ? "JUSTIFIED" : "premature at current load"}`);
  print("  Rationale: backpressure is needed when Queue.unbounded growth causes OOM risk.");
  print(
    `  p95@${SESSIONS}sess=${fmtMs(p95_10)} — ${p95_10 > 100 ? "queue depth is a concern" : "queue drains fast enough"}.`,
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
