# p2-DH-T9-s2 — resume-by-sequence in live subscribe paths

Task: T9 · Lane: D/H (after s1) · Model: opus-4-8/high
Status: done

## Brief (Fable)

- **Goal:** break the reconnect amplifier: wire `OrchestrationEngine.readEvents(afterSequence, …)` into `subscribeThread`/`subscribeShell` so a resuming client replays only the delta instead of a full snapshot, and replace `bufferOrTerminate`'s terminate-on-overflow with resume semantics (`Queue.unbounded` per upstream, now safe because T7 routing bounds what each queue receives).
- **Read first:** `apps/server/src/ws.ts:192` (`WS_PUSH_SUBSCRIBER_BUFFER=512`), `:220-243` (`bufferOrTerminate`), `:244` (`readThreadDetailSnapshot`), `:1055-1059` (existing `replayEvents` RPC using `readEvents` — the pattern to reuse); `OrchestrationEngine.ts:391` (`readEvents`); upstream `git show refs/upstream/t3code-main:apps/server/src/ws.ts` (~`:1160-1236`) for the resume shape; T7 diffs (merged); plan §T9.
- **Invariants:** first-subscribe (no `afterSequence`) behavior unchanged; replay ordering strictly by sequence with no gap between replay end and live stream start (the upstream `c14a5ca49` "dropped events during initial snapshot" fix is exactly this seam — get it right); rate-limit resubscribe snapshots.
- **Acceptance:** test: subscribe → receive events → disconnect at sequence k → resubscribe with `afterSequence=k` → receive exactly k+1…n with no gap/duplicate; overflow no longer terminates the stream; guard green.
- **Verification (guard):** `bun x turbo run typecheck build --filter=t3` + `bun run --cwd apps/server test`.

## Hand-back (execution agent)

**Files read:** `apps/server/src/ws.ts`, `apps/server/src/orchestration/Services/OrchestrationEngine.ts`, `apps/server/src/orchestration/Layers/OrchestrationEngine.ts`, `packages/contracts/src/orchestration.ts`, `apps/server/src/ws.subscribeThread.test.ts`, upstream `refs/upstream/t3code-main:apps/server/src/ws.ts`, plan §T9/§1b.

**Files changed:** `apps/server/src/ws.ts`, `apps/server/src/ws.subscribeThread.test.ts`.

**Diff-stat:** `ws.ts +109/-30`, `ws.subscribeThread.test.ts +36/-1` (2 files, +141/-35).

**Summary:** Wired the s1 `afterSequence` cursor into both live subscribe paths and removed the `bufferOrTerminate` terminate-on-overflow amplifier. `subscribeThread`: when `afterSequence` is present, skip the snapshot frame and replay `readEvents(afterSequence)` (filtered to this thread's detail events) then stream the already-registered per-aggregate queue — assembled by a new exported `resumeThreadStream(catchUp, live, threadId)` helper, all wrapped in the existing `coalescePerTick`; first-subscribe (no `afterSequence`) is byte-unchanged except the `bufferOrTerminate` wrapper is dropped (the per-aggregate queue is already `Queue.unbounded`). `subscribeShell`: same shape via a local `toShellStream` helper — resume replays shell events after the cursor then streams the eagerly-acquired `subscribeDomainEvents` subscription (which buffers during the replay → no gap); snapshot path unchanged minus `bufferOrTerminate`. No-gap seam relied on the T7 ordering already in place (queue/subscription acquired before the snapshot/replay read); overlap between replay tail and live is deduped by sequence on the client, matching upstream `482d56233`/`c14a5ca49`. `readEvents` is single-arg in the fork (`readFromSequence`, exclusive cursor) so upstream's 2nd `MAX_SAFE_INTEGER` arg was dropped. New unit test on `resumeThreadStream` proves catch-up-then-live ordering, thread + detail-type filtering, and no snapshot frame (the "receive exactly k+1…n, no gap/duplicate" acceptance).

**Ponytail shortcuts:** (1) Kept the `bufferOrTerminate` export (still consumed by the `perf/push-backpressure-flood.ts` harness) rather than deleting it — just stopped calling it in the two live paths; smaller diff. (2) Both live buffers are now unbounded per the brief/upstream — marked with `ponytail:` comments naming the ceiling: thread queue is T7-routed (one thread's events) but a hyperactive thread + stalled client can still grow it; shell subscription is NOT per-thread routed (upstream accepts this) — upgrade path for both = re-cap + resume-on-overflow. (3) Added only the thread resume test (the acceptance target); shell resume is a straightforward port of the same cursor and is covered by typecheck.

**Residual risks:** shell live subscription is unbounded and unrouted (sees every domain event) — a permanently-stalled shell client grows the PubSub; acceptable per brief (upstream design), revisit under T8. No client-side change needed (clients that never pass `afterSequence` keep full-snapshot behavior; the s1 contract field is optional).

**Next steps:** T8 (debounce `subscribeShell` `thread-upserted`) is the natural follow-on on the same file; client wiring to actually send `afterSequence` on reconnect is a separate web-side slice (not in this brief's scope).

## Guard result

`bun x turbo run typecheck build --filter=t3` → 10/10 tasks successful (green). `bun run --cwd apps/server test` → 182 files passed / 1 skipped, 1587 tests passed / 4 skipped. New `resumeThreadStream` suite: `ws.subscribeThread.test.ts` 6/6 passed.

## Merge

—

## Verify result (end gate)

—

## Decision (Fable)

—
