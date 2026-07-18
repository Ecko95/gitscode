# p2-DH-T9-s2 — resume-by-sequence in live subscribe paths

Task: T9 · Lane: D/H (after s1) · Model: opus-4-8/high
Status: pending

## Brief (Fable)

- **Goal:** break the reconnect amplifier: wire `OrchestrationEngine.readEvents(afterSequence, …)` into `subscribeThread`/`subscribeShell` so a resuming client replays only the delta instead of a full snapshot, and replace `bufferOrTerminate`'s terminate-on-overflow with resume semantics (`Queue.unbounded` per upstream, now safe because T7 routing bounds what each queue receives).
- **Read first:** `apps/server/src/ws.ts:192` (`WS_PUSH_SUBSCRIBER_BUFFER=512`), `:220-243` (`bufferOrTerminate`), `:244` (`readThreadDetailSnapshot`), `:1055-1059` (existing `replayEvents` RPC using `readEvents` — the pattern to reuse); `OrchestrationEngine.ts:391` (`readEvents`); upstream `git show refs/upstream/t3code-main:apps/server/src/ws.ts` (~`:1160-1236`) for the resume shape; T7 diffs (merged); plan §T9.
- **Invariants:** first-subscribe (no `afterSequence`) behavior unchanged; replay ordering strictly by sequence with no gap between replay end and live stream start (the upstream `c14a5ca49` "dropped events during initial snapshot" fix is exactly this seam — get it right); rate-limit resubscribe snapshots.
- **Acceptance:** test: subscribe → receive events → disconnect at sequence k → resubscribe with `afterSequence=k` → receive exactly k+1…n with no gap/duplicate; overflow no longer terminates the stream; guard green.
- **Verification (guard):** `bun x turbo run typecheck build --filter=t3` + `bun run --cwd apps/server test`.

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
