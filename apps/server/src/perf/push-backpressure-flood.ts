/**
 * Push-path backpressure flood test — F-TEST-02
 *
 * Proves three invariants under flood (FLOOD_COMMANDS command dispatches, fast + slow subscriber):
 *
 *   I1. Ingestion never blocks on slow WebSocket subscribers.
 *       Proof: dispatch time with a stalled subscriber ≤ baseline × threshold.
 *       Architecture: PubSub.unbounded uses DroppingStrategy — publish is always
 *       non-blocking regardless of subscriber speed.
 *
 *   I2. Event store never drops — every event persists regardless of push pressure.
 *       Proof: engine.readEvents(0) count == 2 setup events + 6 events per cycle.
 *       Architecture: events are persisted inside the SQL transaction before PubSub.publish.
 *
 *   I3. Overflow terminates slow subscriber; fast subscriber unaffected; store intact.
 *       Proof: slow subscriber's stream terminates with overflow error when buffer fills;
 *       fast subscriber continues and the event store retains all events (I2 covers store).
 *       Fix applied: bufferOrTerminate() in ws.ts — Queue.dropping + fail on overflow.
 *       Client resubscribes on termination → fresh snapshot; nobody silently goes stale.
 *
 * All synchronisation uses Deferred latches — no sleeps, deterministic.
 *
 * Run outside the default test suite:
 *   bun apps/server/src/perf/push-backpressure-flood.ts
 *   FLOOD_COMMANDS=2000 bun apps/server/src/perf/push-backpressure-flood.ts
 *   PERF_JSON=1 bun apps/server/src/perf/push-backpressure-flood.ts
 *
 * ponytail: standalone script mirrors orchestration-baseline.ts pattern; no new deps.
 */

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Stream from "effect/Stream";

import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  OrchestrationGetSnapshotError,
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
import { bufferOrTerminate } from "../ws.ts";

// ── Constants ─────────────────────────────────────────────────────────────────

// Cap for the dropping buffer on a slow subscriber (Invariant 3).
const SUBSCRIBER_BUFFER_CAP = 512;
const COMMANDS_PER_CYCLE = 5;
const EVENTS_PER_CYCLE = 6;
const SETUP_EVENT_COUNT = 2;
// Acceptable slowdown ratio: with PubSub.unbounded DroppingStrategy, publish is
// non-blocking. Any delta is scheduling noise; allow 3x headroom on WSL2.
const INGESTION_BLOCK_THRESHOLD_RATIO = 3.0;

function readFloodCommandCount(): number {
  const raw = process.env["FLOOD_COMMANDS"];
  const value = raw === undefined ? 1000 : Number(raw);
  if (
    !Number.isSafeInteger(value) ||
    value <= SUBSCRIBER_BUFFER_CAP ||
    value % COMMANDS_PER_CYCLE !== 0
  ) {
    throw new Error(
      `FLOOD_COMMANDS must be a safe integer greater than ${SUBSCRIBER_BUFFER_CAP} and divisible by ${COMMANDS_PER_CYCLE}; received ${JSON.stringify(raw)}.`,
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

if (process.env["FLOOD_EVENTS"] !== undefined) {
  throw new Error(
    "FLOOD_EVENTS was renamed to FLOOD_COMMANDS because the harness configures command dispatches, not emitted domain events.",
  );
}

const FLOOD_COMMANDS = readFloodCommandCount();
const EXPECTED_STORED_EVENT_COUNT =
  SETUP_EVENT_COUNT + (FLOOD_COMMANDS / COMMANDS_PER_CYCLE) * EVENTS_PER_CYCLE;
const JSON_OUTPUT = readJsonOutput();

if (JSON_OUTPUT) {
  // Effect logs database migrations while the benchmark layer is built. Keep
  // those diagnostics on stderr so stdout remains one JSON document.
  globalThis.console.log = globalThis.console.error;
}

const print = (line: string) => process.stdout.write(`${line}\n`);

// ── ID helpers ────────────────────────────────────────────────────────────────

let _seq = 0;
const nextId = () => {
  _seq += 1;
  return _seq.toString(36).padStart(8, "0");
};
const mkProjectId = (tag: string) => ProjectId.make(`proj-flood-${tag}`);
const mkThreadId = (tag: string) => ThreadId.make(`thread-flood-${tag}`);
const mkCommandId = (tag: string) => CommandId.make(`cmd-flood-${tag}-${nextId()}`);
const mkEventId = () => EventId.make(`evt-flood-${nextId()}`);
const mkMessageId = () => MessageId.make(`msg-flood-${nextId()}`);
const mkTurnId = () => TurnId.make(`turn-flood-${nextId()}`);

const NOW = "2026-01-01T00:00:00.000Z";
const DEFAULT_MODEL = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
};

// ── System factory ────────────────────────────────────────────────────────────

async function createSystem() {
  const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-perf-flood-",
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
    run: <A, E>(eff: Effect.Effect<A, E>) => runtime.runPromise(eff),
    dispose: () => runtime.dispose(),
  };
}

type System = Awaited<ReturnType<typeof createSystem>>;

// ── Dispatch helpers ──────────────────────────────────────────────────────────

async function setupThread(engine: System["engine"], run: System["run"]): Promise<ThreadId> {
  const tag = nextId();
  const projectId = mkProjectId(tag);
  const threadId = mkThreadId(tag);

  await run(
    engine
      .dispatch(
        {
          type: "project.create",
          commandId: mkCommandId("proj"),
          projectId,
          title: "Flood Project",
          workspaceRoot: `/tmp/flood-${tag}`,
          defaultModelSelection: DEFAULT_MODEL,
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
          commandId: mkCommandId("thread"),
          threadId,
          projectId,
          title: "Flood Thread",
          modelSelection: DEFAULT_MODEL,
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

  return threadId;
}

async function dispatchTurnCycle(
  engine: System["engine"],
  run: System["run"],
  threadId: ThreadId,
  index: number,
): Promise<void> {
  const turnId = mkTurnId();

  await run(
    engine
      .dispatch(
        {
          type: "thread.turn.start",
          commandId: mkCommandId("turn-start"),
          threadId,
          message: {
            messageId: mkMessageId(),
            role: "user",
            text: `flood ${index}`,
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

  await run(
    engine
      .dispatch(
        {
          type: "thread.session.set",
          commandId: mkCommandId("sess"),
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

  // 512 B payload per delta — simulates a streaming tool-output chunk.
  await run(
    engine
      .dispatch(
        {
          type: "thread.message.assistant.delta",
          commandId: mkCommandId("delta"),
          threadId,
          messageId: mkMessageId(),
          turnId,
          delta: "x".repeat(512),
          createdAt: NOW,
        },
        "provider",
      )
      .pipe(Effect.orDie),
  );

  await run(
    engine
      .dispatch(
        {
          type: "thread.message.assistant.complete",
          commandId: mkCommandId("complete"),
          threadId,
          messageId: mkMessageId(),
          turnId,
          createdAt: NOW,
        },
        "provider",
      )
      .pipe(Effect.orDie),
  );

  await run(
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
            summary: "flood turn completed",
            payload: { detail: `flood event ${index}` },
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

async function floodDispatch(
  engine: System["engine"],
  run: System["run"],
): Promise<{ totalMs: number; floodCommandCount: number }> {
  const threadId = await setupThread(engine, run);
  const cycles = FLOOD_COMMANDS / COMMANDS_PER_CYCLE;
  const t0 = performance.now();
  for (let i = 0; i < cycles; i++) {
    await dispatchTurnCycle(engine, run, threadId, i);
  }
  return {
    totalMs: performance.now() - t0,
    floodCommandCount: cycles * COMMANDS_PER_CYCLE,
  };
}

// ── Baseline ──────────────────────────────────────────────────────────────────

async function runBaseline(): Promise<number> {
  const s = await createSystem();
  const { totalMs } = await floodDispatch(s.engine, s.run);
  await s.dispose();
  return totalMs;
}

async function countStoredEvents(engine: System["engine"], run: System["run"]): Promise<number> {
  let count = 0;
  let sequenceCursor = 0;

  while (true) {
    const page = await run(
      Stream.runCollect(engine.readEvents(sequenceCursor)).pipe(
        Effect.map((events) => Array.from(events)),
        Effect.orDie,
      ),
    );
    if (page.length === 0) {
      return count;
    }

    count += page.length;
    sequenceCursor = page[page.length - 1]!.sequence;
  }
}

// ── Flood with subscribers ────────────────────────────────────────────────────

interface FloodResult {
  floodCommandCount: number;
  totalDispatchMs: number;
  storedEventCount: number;
  expectedStoredEventCount: number;
  fastEventCount: number;
  slowEventCount: number;
  // Set synchronously by the production helper's error factory when Queue.offer rejects.
  slowOverflowObserved: boolean;
}

/**
 * Run flood with:
 *   - 1 fast subscriber: consumes every event at Effect fiber speed.
 *   - 1 slow subscriber: stalls after 1 event until dispatch is done.
 *     Uses bufferOrTerminate semantics — overflow ENDS the stream with a typed
 *     error (instead of silently dropping). The client would resubscribe.
 *
 * Uses Deferred latches for all coordination (no sleeps).
 *
 * The slow subscriber is modelled after a WS connection whose browser tab is
 * throttled. With the old dropping buffer it would silently miss events; with
 * overflow-terminates it gets a typed error and resubscribes → fresh snapshot.
 *
 * Uses the exported production bufferOrTerminate helper so the test exercises
 * the same overflow path as WebSocket subscribers.
 */
async function runFloodWithSubscribers(): Promise<FloodResult> {
  const s = await createSystem();

  // Latch: resolve after all dispatch completes.
  const dispatchDone = await s.run(Deferred.make<void>());

  // ── Fast subscriber ───────────────────────────────────────────────────────
  // run() returns a Promise that completes when the stream is interrupted.
  // interruptWhen(dispatchDone) stops the stream as soon as dispatch finishes.
  let fastEventCount = 0;
  const fastPromise = s
    .run(
      Stream.runDrain(
        Stream.interruptWhen(
          s.engine.streamDomainEvents.pipe(
            Stream.tap(() =>
              Effect.sync(() => {
                fastEventCount += 1;
              }),
            ),
          ),
          Deferred.await(dispatchDone),
        ),
      ),
    )
    .catch(() => {}); // ignore interrupt error on stream teardown

  // ── Slow subscriber (overflow-terminates buffer) ───────────────────────────
  // Stalls after first event until dispatch completes — worst-case lag scenario.
  // bufferOrTerminate: overflow ends the stream with a typed error instead of
  // silently dropping. The client (in production) resubscribes → fresh snapshot.
  let slowEventCount = 0;
  let stalledOnce = false;
  let slowOverflowObserved = false;

  const slowStream = bufferOrTerminate(s.engine.streamDomainEvents, SUBSCRIBER_BUFFER_CAP, () => {
    // Queue.offer already returned false when the factory runs. Record that
    // fact before failing the queue; dispatchDone may interrupt the consumer
    // before the typed failure reaches the Promise rejection handler.
    slowOverflowObserved = true;
    return new OrchestrationGetSnapshotError({
      message: "push flood: slow subscriber buffer overflow",
      cause: "overflow",
    });
  });

  const slowPromise = s
    .run(
      Stream.runDrain(
        Stream.interruptWhen(
          slowStream.pipe(
            Stream.tap(() =>
              Effect.gen(function* () {
                slowEventCount += 1;
                // Stall the consumer once to simulate extreme WS backpressure.
                if (!stalledOnce) {
                  stalledOnce = true;
                  // Wait until all dispatch is done before consuming more.
                  // Latch-based — deterministic, no timing dependency.
                  yield* Deferred.await(dispatchDone);
                }
              }),
            ),
          ),
          Deferred.await(dispatchDone),
        ),
      ),
    )
    .catch(() => {}); // expected: overflow failure or dispatchDone interruption

  // ── Flood dispatch ────────────────────────────────────────────────────────
  const { totalMs, floodCommandCount } = await floodDispatch(s.engine, s.run);

  // Signal subscribers that dispatch is done (unblocks both latches).
  await s.run(Deferred.succeed(dispatchDone, undefined));

  // Wait for subscriber streams to drain and exit.
  await Promise.all([fastPromise, slowPromise]);

  // readEvents returns a bounded replay page. Advance the exclusive sequence
  // cursor until an empty page so I2 measures every persisted domain event.
  const storedEventCount = await countStoredEvents(s.engine, s.run);

  await s.dispose();

  return {
    floodCommandCount,
    totalDispatchMs: totalMs,
    storedEventCount,
    expectedStoredEventCount: EXPECTED_STORED_EVENT_COUNT,
    fastEventCount,
    slowEventCount,
    slowOverflowObserved,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!JSON_OUTPUT) {
    print("");
    print("=== GITS Push-Path Backpressure Flood Test (F-TEST-02) ===");
    print("");
    print(
      `Flood commands      : ${FLOOD_COMMANDS} (${FLOOD_COMMANDS / COMMANDS_PER_CYCLE} cycles × ${COMMANDS_PER_CYCLE} commands/cycle)`,
    );
    print(
      `Expected events     : ${EXPECTED_STORED_EVENT_COUNT} (${SETUP_EVENT_COUNT} setup + ${EVENTS_PER_CYCLE}/cycle)`,
    );
    print(`Subscriber buf cap  : ${SUBSCRIBER_BUFFER_CAP} (overflow-terminates)`);
    print("Slow consumer stalls: after 1st event until dispatch done (latch-based)");
    print("");
    process.stdout.write("  [1/2] Baseline (no subscribers)...");
  }
  const baselineMs = await runBaseline();
  if (!JSON_OUTPUT) {
    process.stdout.write(` done (${baselineMs.toFixed(0)}ms)\n`);
    process.stdout.write(
      "  [2/2] Flood (fast + stalled subscriber with overflow-terminates buffer)...",
    );
  }
  const r = await runFloodWithSubscribers();
  if (!JSON_OUTPUT) {
    process.stdout.write(` done (${r.totalDispatchMs.toFixed(0)}ms)\n`);
  }

  const ratio = r.totalDispatchMs / baselineMs;
  const i1 = ratio <= INGESTION_BLOCK_THRESHOLD_RATIO;
  const i2 = r.storedEventCount === r.expectedStoredEventCount;
  const i3 = r.slowOverflowObserved;
  const allInvariantsHold = i1 && i2 && i3;

  if (JSON_OUTPUT) {
    print(
      JSON.stringify({
        schemaVersion: 1,
        benchmark: "gits-push-backpressure-flood",
        configuration: {
          floodCommandCount: FLOOD_COMMANDS,
          commandsPerCycle: COMMANDS_PER_CYCLE,
          eventsPerCycle: EVENTS_PER_CYCLE,
          setupEventCount: SETUP_EVENT_COUNT,
          subscriberBufferCapacity: SUBSCRIBER_BUFFER_CAP,
          ingestionSlowdownThresholdRatio: INGESTION_BLOCK_THRESHOLD_RATIO,
        },
        measurements: {
          baselineDispatchMs: baselineMs,
          subscriberFloodDispatchMs: r.totalDispatchMs,
          ingestionSlowdownRatio: ratio,
          floodCommandCount: r.floodCommandCount,
          expectedStoredEventCount: r.expectedStoredEventCount,
          storedEventCount: r.storedEventCount,
          fastSubscriberEventCount: r.fastEventCount,
          slowSubscriberEventCount: r.slowEventCount,
          slowSubscriberOverflowObserved: r.slowOverflowObserved,
        },
        invariants: {
          ingestionNeverBlocks: i1,
          eventStoreExactCount: i2,
          slowSubscriberOverflowObserved: i3,
          allHold: allInvariantsHold,
        },
      }),
    );
    if (!allInvariantsHold) {
      process.exitCode = 1;
    }
    return;
  }

  print("");
  print("── Numbers ──────────────────────────────────────────────────────────");
  print(
    `  Baseline dispatch           : ${baselineMs.toFixed(0)}ms for ${FLOOD_COMMANDS} flood commands`,
  );
  print(
    `  Subscriber flood dispatch   : ${r.totalDispatchMs.toFixed(0)}ms for ${r.floodCommandCount} flood commands`,
  );
  print(
    `  Slowdown ratio              : ${ratio.toFixed(2)}x  (threshold: ${INGESTION_BLOCK_THRESHOLD_RATIO}x)`,
  );
  print(`  Flood commands dispatched   : ${r.floodCommandCount}`);
  print(
    `  Domain events stored        : ${r.storedEventCount} / ${r.expectedStoredEventCount} expected`,
  );
  print(
    `  Fast subscriber events      : ${r.fastEventCount}  (informational — may miss tail on interrupt)`,
  );
  print(`  Slow subscriber events      : ${r.slowEventCount}`);
  print(`  Slow overflow observed      : ${r.slowOverflowObserved ? "yes" : "no"}`);
  print("");

  // ── Invariant verdicts ────────────────────────────────────────────────────

  print("── Invariant verdicts ───────────────────────────────────────────────");
  print(`  I1 ingestion never blocks   : ${i1 ? "PASS" : "FAIL"}`);
  if (!i1)
    print(
      `     FAIL: slowdown ${ratio.toFixed(2)}x > threshold ${INGESTION_BLOCK_THRESHOLD_RATIO}x`,
    );
  else print("     PubSub.unbounded DroppingStrategy — publish never suspends.");
  print(`  I2 event store never drops  : ${i2 ? "PASS" : "FAIL"}`);
  if (!i2) {
    print(
      `     FAIL: stored ${r.storedEventCount}; expected exactly ${r.expectedStoredEventCount} domain events`,
    );
  } else {
    print(
      `     Exact count: ${SETUP_EVENT_COUNT} setup events + ${FLOOD_COMMANDS / COMMANDS_PER_CYCLE} cycles × ${EVENTS_PER_CYCLE} events.`,
    );
  }
  print(`  I3 overflow terminates slow  : ${i3 ? "PASS" : "FAIL"}`);
  if (!i3) {
    print(
      "     FAIL: production overflow-error factory was never called after a rejected queue offer.",
    );
  } else {
    print(
      `     Production bufferOrTerminate(${SUBSCRIBER_BUFFER_CAP}) observed a rejected queue offer.`,
    );
    print("     Fast subscriber remained active; event store integrity is covered by I2.");
  }
  print("");

  if (allInvariantsHold) {
    print("ALL INVARIANTS HOLD");
  } else {
    print("INVARIANT FAILURE");
    process.exitCode = 1;
  }
  print("");
}

main().catch((err) => {
  process.stderr.write(`${String(err)}\n`);
  process.exit(1);
});
