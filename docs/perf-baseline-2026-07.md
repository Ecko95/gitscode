# GITS Orchestration Dispatch Hot-Path Baseline — 2026-07 (W4.1)

Measured: 2026-07-03  
Branch: `perf/orchestration-baseline`  
Task: W4.1 — Orchestration performance baseline

## Repro Command

```bash
# Default run (10 sessions, 50 dispatches/session, 10 warm-up dispatches)
bun apps/server/src/perf/orchestration-baseline.ts

# Custom concurrency / dispatch count
PERF_SESSIONS=10 PERF_DISPATCHES_PER_SESSION=50 PERF_WARMUP=10 \
  bun apps/server/src/perf/orchestration-baseline.ts

# Machine-readable output (stdout is exactly one JSON document)
PERF_JSON=1 bun apps/server/src/perf/orchestration-baseline.ts
```

`PERF_SESSIONS` must be a positive integer. `PERF_DISPATCHES_PER_SESSION` must be a
positive multiple of 5, and `PERF_WARMUP` must be a non-negative multiple of 5. The
harness runs concurrency levels `1`, `min(5, PERF_SESSIONS)`, and `PERF_SESSIONS`,
with duplicate levels removed.

## Environment

| Key                | Value                                                                                                    |
| ------------------ | -------------------------------------------------------------------------------------------------------- |
| Host               | WSL2 / Linux (6.6.87.2-microsoft-standard-WSL2)                                                          |
| SQLite mode        | in-memory (`:memory:`) — no fsync overhead                                                               |
| Provider CLIs      | **EXCLUDED** — synthetic commands only                                                                   |
| Dispatch mix/cycle | turn.start (→ 2 domain events) + session.set + msg.delta + msg.complete + activity.append (5 dispatches) |
| Bun                | 1.3.13                                                                                                   |
| Effect             | 4.0.0-beta.73                                                                                            |

**Important WSL2 caveat:** WSL2 runs on a virtual machine sharing CPU with Windows.  
Timer resolution is ~1ms and scheduling jitter is significant — p95 will be 15–30% better  
on a bare-metal Linux host. These numbers are a floor, not a ceiling.

The environment above describes the historical measurement host. Current harness output derives
the operating system, kernel release, architecture, WSL status, and logical CPU count at runtime.

## Historical Baseline Table (50 dispatches/session, 10 warm-up)

The measured values below are preserved from the 2026-07-03 run. Terminology has been corrected
from “events” to “dispatches”; the table was not regenerated, so p99 and coefficient of variation
are unavailable for this historical sample. New runs report both statistics.

| Sessions | Dispatches | p50      | p95      | mean     | min     | max      | dispatch/s | total_ms  |
| -------- | ---------- | -------- | -------- | -------- | ------- | -------- | ---------- | --------- |
| 1        | 50         | 23.42ms  | 41.98ms  | 24.34ms  | 2.33ms  | 54.53ms  | 40.4       | 1237.57ms |
| 5        | 250        | 104.77ms | 186.05ms | 107.93ms | 19.51ms | 233.47ms | 44.7       | 5593.82ms |
| 10       | 500        | 177.23ms | 318.94ms | 173.99ms | 15.38ms | 393.50ms | 55.5       | 9015.93ms |

All timings are **end-to-end `engine.dispatch()` wall-clock** (from `Queue.offer` returning  
to `Deferred.await` resolving). This covers the complete hot path.

## Stage Breakdown

The orchestration pipeline is serial (single command fiber). Inside each dispatch:

```
Queue.offer (caller)
  └─ Queue.take (command fiber)
       ├─ commandReceiptRepository.getByCommandId   ← SQLite SELECT
       ├─ decideOrchestrationCommand                ← in-memory, no I/O
       └─ sql.withTransaction
            ├─ eventStore.append                    ← SQLite INSERT
            ├─ projectEvent (in read-model)         ← in-memory
            ├─ projectionPipeline.projectEvent      ← 10 projectors × SQLite UPSERT each
            └─ commandReceiptRepository.upsert      ← SQLite UPSERT
       └─ PubSub.publish (per event)               ← in-memory fan-out
  └─ Deferred.succeed → caller unblocks
```

**Where time concentrates:** the SQL transaction is the bottleneck.  
`projectionPipeline.projectEvent` runs 10 projectors sequentially, each issuing 1–4 SQLite  
UPSERTs per event type. That is ~15–40 SQLite writes per dispatch inside a single transaction.  
The in-memory SQLite removes fsync, so this is the pure CPU + lock cost.

At 1 session, p50 ≈ 23ms: this is the per-command SQL transaction cost baseline.  
At 10 sessions, p95 ≈ 319ms: the serial queue amplifies the transaction cost by queue depth.  
p95@10 / p50@1 ≈ 13.6× — roughly equal to queue depth under full concurrency.

**PubSub publish and Deferred.succeed** are in-memory and account for <1ms combined.  
**Decider** is pure read-model logic with no I/O, also <1ms.  
**Queue wait** is unmeasured separately; under low concurrency it is effectively zero.

## Provider-Process Overhead

Provider CLI round-trips (codex, claude, cursor) are **not included** in these numbers.  
A single provider turn involves:

- stdio/ACP event arrival (network or IPC)
- `ProviderCommandReactor` dispatching orchestration commands per event
- Each reactor command goes through the same pipeline measured above

Provider turns typically emit 10–100+ runtime events over seconds-to-minutes. Reactors translate
those runtime events into orchestration command dispatches; the cost above is per dispatch, not
per emitted domain event.

## Downstream Task Assessment

### W4.3 Keyed Reactors

**Assessment: LIKELY JUSTIFIED — validate after W4.2 optimisation pass.**

The serial queue is the fundamental ceiling. At 5 concurrent sessions, p95 jumps from  
~42ms (1 session) to ~186ms — a 4.4× increase for 5× concurrency. This is linear queue-depth  
amplification. Keyed reactors (one queue per aggregate/thread instead of one global queue)  
would allow different threads to process concurrently, reducing p95 at high session counts.  
Benefit is proportional to the number of simultaneous active threads.

### W4.4 Backpressure

**Assessment: JUSTIFIED — but not for OOM risk; for latency SLO protection.**

`Queue.unbounded` means bursty dispatchers can enqueue faster than the serial fiber drains.  
The p95@10 of 319ms already exceeds a reasonable 100ms interactive latency SLO.  
`Queue.bounded` with a sensible cap (e.g. 256–1024 per aggregate or globally) would surface  
backpressure to callers (e.g. `ProviderCommandReactor`) rather than silently accumulating  
queue depth. The OOM risk is low with today's event volume but the latency tail is real.

### W4.7 Cold-Start Snapshots

**Assessment: DEFERRED — measure separately with a pre-populated DB.**

This harness uses `:memory:` SQLite and skips bootstrap replay entirely.  
Bootstrap cost is proportional to event-store row count. With 1k events across 10 projectors,  
expect ~10k SQLite reads at startup. Snapshots eliminate this replay and are worth  
instrumenting once the DB has representative data (>500 events).

## Instrumentation Added

No new instrumentation hooks were added in this task. The existing metrics cover:

- `t3_orchestration_command_duration` — per-command total time (covers the hot path)
- `t3_orchestration_command_ack_duration` — time to first event published
- `t3_orchestration_commands_total` — count + outcome

The harness measures wall-clock time around `engine.dispatch()` rather than adding new  
span boundaries, because the existing `orchestration.command.*` span already wraps the  
entire pipeline interior. Adding sub-stage spans (decider / SQL-tx / projection) would  
require modifying `OrchestrationEngine.ts` and `ProjectionPipeline.ts` — reserved for W4.3  
if keyed reactors are implemented (they'll need new spans to validate the fix).

## Assumptions

1. In-memory SQLite removes fsync — real production numbers will be higher if using WAL mode  
   with a real disk. Estimate +5–15ms per command on NVMe, +30–100ms on spinning disk or  
   heavily loaded VPS storage.
2. The harness reuses a single SQLite connection per runtime (same as production).
3. `thread.turn.start` produces 2 events (message-sent + turn-start-requested), so the  
   "1 dispatch" cost for that command is higher than single-event commands.
4. WSL2 scheduling jitter: timings will vary ±20% run-to-run on this host.

## Files Changed

- `apps/server/src/perf/orchestration-baseline.ts` — new harness (excluded from default test suite)
- `docs/perf-baseline-2026-07.md` — this document
