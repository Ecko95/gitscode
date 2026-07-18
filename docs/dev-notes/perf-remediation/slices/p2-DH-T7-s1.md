# p2-DH-T7-s1 — dispatcher fiber + per-aggregateId queues

Task: T7 · Lane: D/H (after T5c; Opus lead) · Model: opus-4-8/high
Status: done — guard green

## Brief (Fable)

- **Goal:** replace the O(subscribers × events) fan-out: ONE dispatcher fiber consumes the global `eventPubSub` and routes each event into per-`aggregateId` subscriber queues. Subscribers register for an aggregateId; the per-subscriber post-delivery filter disappears.
- **Read first:** `apps/server/src/orchestration/Layers/OrchestrationEngine.ts:123` (`PubSub.unbounded`), `apps/server/src/ws.ts:1158-1170` (subscribeThread filter), `:540-556` (subscribeShell default case); existing tests + `apps/server/integration/OrchestrationEngineHarness.integration.ts`; plan §T7.
- **Invariants:** event ORDER per aggregateId preserved; no event loss during subscribe/unsubscribe races (drain semantics documented); shell subscribers that legitimately watch multiple threads keep working (they register per-aggregate or on a broadcast lane — decide and document); T6 patch already merged (clean publishes).
- **Acceptance:** dispatcher routes only to matching queues; new unit test: two subscribers on A and B, publish to A → B's queue stays empty; integration harness still green; guard green.
- **Verification (guard):** `bun x turbo run typecheck build --filter=t3` + `bun run --cwd apps/server test`.
- **Scope note:** this slice is routing ONLY — authz binding is s2, frame batching s3. Do not start them.

## Hand-back (execution agent)

**Files read:** `OrchestrationEngine.ts` (Layer + Service), `ws.ts` (subscribeThread/subscribeShell),
`OrchestrationEngineHarness.integration.ts`, `OrchestrationEngine.test.ts`, all engine-mock test
sites, plan §T7 + ORCHESTRATION.md.

**Files changed (10):**

- `apps/server/src/orchestration/Services/OrchestrationEngine.ts` — new `subscribeAggregate(aggregateId)` method on the shape (returns a scoped `Queue.Dequeue<OrchestrationEvent>`).
- `apps/server/src/orchestration/Layers/OrchestrationEngine.ts` — per-`aggregateId` routing registry (`Map<string, Set<Queue>>`), `routeEvent`, `subscribeAggregate` impl (register-before-snapshot + scope finalizer deregister/shutdown), and one dispatcher fiber draining `eventPubSub` via `Stream.fromSubscription` → `routeEvent`.
- `apps/server/src/ws.ts` — `subscribeThread` now registers a per-aggregate queue and consumes `Stream.fromQueue`; the `aggregateKind==="thread" && aggregateId===threadId` post-delivery filter is gone (routing guarantees it). Sequence-dedup + `isThreadDetailEvent` filters retained. `bufferOrTerminate` wrapping unchanged.
- 6 test mock sites (`satisfies`/`Layer.succeed`/`.of` full-shape mocks) + 1 new unit test in `OrchestrationEngine.test.ts`.

**Summary:** Replaced the O(subscribers × events) thread fan-out. One dispatcher fiber consumes the
global PubSub and routes each event only to queues registered under its `aggregateId`; thread
subscribers register per-aggregate and no longer filter every event post-delivery. Broadcast
consumers (all reactors, `subscribeShell`) intentionally stay on the existing `subscribeDomainEvents`
lane — they legitimately need every event; only `subscribeThread` (the multiplying, per-thread-tab
subscriber) moved to per-aggregate routing, which is where the fan-out cost lived.

**Ponytail shortcuts:** (1) plain `Map`/`Set` registry with no lock — single JS thread + cooperative
Effect scheduling means route reads and register/finalizer mutations never interleave mid-op; marked
inline. (2) Per-subscriber queues are `Queue.unbounded`; the WS side keeps `bufferOrTerminate` for
backpressure/termination, and its drain fiber empties the engine queue at non-I/O speed so it can't
grow unboundedly. (3) `Queue.offer` to a shut-down queue returns `false` (no failure), so
subscribe/unsubscribe races drop the stray offer with no live-subscriber event loss — documented.

**Residual risks:** none for routing correctness (guard + new test cover it). Behavioral end-gate
still owns live verification. s2 (authz binding) and s3 (frame batching) not started, per scope note.

**Next steps:** s2 binds authz to the aggregate registration; s3 adds frame batching on the routed queues.

## Guard result

GREEN. `bun x turbo run typecheck build --filter=t3` → 10/10 tasks successful. `bun run --cwd
apps/server test` → 182 files passed / 1 skipped, 1583 tests passed / 4 skipped. New unit test
"routes live events only to the matching aggregateId queue (T7)" passes: two subscribers on threads
A and B, dispatch to A → A's queue receives `thread.created`, B's queue polls empty.

## Merge

—

## Verify result (end gate)

—

## Decision (Fable)

—
