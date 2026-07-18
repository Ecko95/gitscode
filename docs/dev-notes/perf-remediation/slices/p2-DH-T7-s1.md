# p2-DH-T7-s1 — dispatcher fiber + per-aggregateId queues

Task: T7 · Lane: D/H (after T5c; Opus lead) · Model: opus-4-8/high
Status: pending

## Brief (Fable)

- **Goal:** replace the O(subscribers × events) fan-out: ONE dispatcher fiber consumes the global `eventPubSub` and routes each event into per-`aggregateId` subscriber queues. Subscribers register for an aggregateId; the per-subscriber post-delivery filter disappears.
- **Read first:** `apps/server/src/orchestration/Layers/OrchestrationEngine.ts:123` (`PubSub.unbounded`), `apps/server/src/ws.ts:1158-1170` (subscribeThread filter), `:540-556` (subscribeShell default case); existing tests + `apps/server/integration/OrchestrationEngineHarness.integration.ts`; plan §T7.
- **Invariants:** event ORDER per aggregateId preserved; no event loss during subscribe/unsubscribe races (drain semantics documented); shell subscribers that legitimately watch multiple threads keep working (they register per-aggregate or on a broadcast lane — decide and document); T6 patch already merged (clean publishes).
- **Acceptance:** dispatcher routes only to matching queues; new unit test: two subscribers on A and B, publish to A → B's queue stays empty; integration harness still green; guard green.
- **Verification (guard):** `bun x turbo run typecheck build --filter=t3` + `bun run --cwd apps/server test`.
- **Scope note:** this slice is routing ONLY — authz binding is s2, frame batching s3. Do not start them.

## Hand-back (execution agent)

_(files read · files changed · diff-stat · summary ≤1 para · ponytail shortcuts · residual risks · next steps)_

## Guard result

—

## Merge

—

## Verify result (end gate)

—

## Decision (Fable)

—
