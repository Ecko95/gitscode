# p2-DH-T8-s1 — debounce thread-upserted shell frames

Task: T8 · Lane: D/H (last in sequence) · Model: sonnet-4-6/medium
Status: done

## Brief (Fable)

- **Goal:** stop one sync SQL + WS frame per thread event per shell subscriber: coalesce `thread-upserted` per `threadId` (~200 ms), reusing the `PROVIDER_STATUS_DEBOUNCE_MS` pattern.
- **Read first:** `apps/server/src/ws.ts:180` (`PROVIDER_STATUS_DEBOUNCE_MS`) and its use at `:2054` (the pattern); the (post-T7) subscribeShell handler; plan §T8.
- **Invariants:** last-write-wins per threadId; UI shell list still coherent within ~200 ms; built on top of the T7/T9 code as merged (read those diffs first).
- **Acceptance:** burst of upserts on one thread → 1 `getThreadShellById` + 1 frame per debounce window (test); guard green.
- **Verification (guard):** `bun x turbo run typecheck build --filter=t3` + `bun run --cwd apps/server test`.

## Hand-back (execution agent)

**Files read:** `apps/server/src/ws.ts`, `apps/server/src/ws.subscribeThread.test.ts`, `apps/server/src/server.test.ts`, `tsconfig.base.json`, Effect internals (`Stream.js`, `PubSub.js`, `Channel.js`, `Clock.d.ts`).

**Files changed:** `apps/server/src/ws.ts`, `apps/server/src/ws.subscribeThread.test.ts`.

**Diff-stat:** +50 lines in ws.ts (export `debounceShellThreadEvents`, wired into both live paths of subscribeShell); +70 lines in ws.subscribeThread.test.ts (two new tests).

**Summary:** Added `debounceShellThreadEvents`, a throttle (first-wins) filter on the domain event stream that suppresses `thread`-aggregate events for a given `threadId` within a `PROVIDER_STATUS_DEBOUNCE_MS` (200 ms) window, using `performance.now()` as a monotonic clock inside a synchronous `Stream.filter` predicate. Non-thread events pass through unchanged. The function is applied to the domain event stream in both the resume and snapshot paths of `subscribeShell`, upstream of `toShellStream`/`getThreadShellById`.

**Ponytail shortcuts:** Throttle (first-wins) instead of per-key debounce; `performance.now()` instead of Effect Clock (avoids `filterEffect` + async scheduling that caused `aggregateWithin`/PubSub subscription hang); mutable `Map` instead of `Ref` (scope is local to the stream pipeline, not shared).

**Residual risks:** `aggregateWithin` + `Stream.fromSubscription(PubSub.Subscription)` remains incompatible in effect@4.0.0-beta.73 — any future attempt to use `groupedWithin` in this code path will re-introduce the 60 s hang. Throttle drops intermediary events; if last-write fidelity under back-pressure is ever required, a per-key fiber-based debounce using `Queue` per threadId would be needed.

## Guard result

`bun x turbo run typecheck build --filter=t3`: 10/10 tasks successful, no errors.
`bun run --cwd apps/server test`: 182 files passed, 1589 tests passed, 4 skipped (0 failed).

## Merge

—

## Verify result (end gate)

—

## Decision (Fable)

—
