# p2-DH-T7-s3 — batch WS frames per tick

Task: T7 · Lane: D/H (after s2) · Model: opus-4-8/high
Status: done

## Brief (Fable)

- **Goal:** coalesce per-event WS sends into one frame per subscriber per tick (~16–50 ms), on top of the s1 per-aggregate queues.
- **Read first:** s1/s2 diffs (merged); the ws send path for subscription events in `apps/server/src/ws.ts`; how the web client decodes event frames (`packages/client-runtime` ws transport) — batching must stay protocol-compatible (an array frame or repeated sends; choose what the client already tolerates).
- **Invariants:** ordering within a batch preserved; no added latency beyond one tick; empty ticks send nothing.
- **Acceptance:** burst test: N events in one tick → 1 frame (or documented client-compatible batching); client-runtime tests still green; guard green.
- **Verification (guard):** `bun x turbo run typecheck build --filter=t3` + `bun run --cwd apps/server test` + `bun run --cwd packages/client-runtime test`.

## Hand-back (execution agent)

- **Files read:** `apps/server/src/ws.ts`, `packages/client-runtime/src/wsTransport.ts`, `apps/server/src/ws.subscribeThread.test.ts`, effect@4.0.0-beta.73 `RpcServer.js`/`Stream.js`/`Channel.js` (chunk-per-frame + groupedWithin/flattenIterable semantics).
- **Files changed:** `apps/server/src/ws.ts`, `apps/server/src/ws.subscribeThread.test.ts`, this slice file.
- **Diff-stat:** ws.ts +32/-1, ws.subscribeThread.test.ts +40/-1.
- **Summary:** Added `coalescePerTick` (exported) = `Stream.groupedWithin(MAX_SAFE_INTEGER, WS_FRAME_BATCH_WINDOW=33ms)` + `Stream.flattenIterable`, and wrapped `subscribeThread`'s `bufferedLiveStream` with it (after `bufferOrTerminate`, so overflow still terminates first; before the snapshot's own frame — snapshot stays its own frame). Verified against the Effect RPC internals: `RpcServer.streamEffect` emits exactly one `"Chunk"` wire message per stream chunk via `Stream.runForEachArray`, and `groupedWithin`+`flattenIterable` re-emits each tick-window's events as a single chunk (empirically 5 fast events → 1 chunk, gap → new chunk). So N events in one ~33ms tick collapse to one WS frame, order preserved, idle windows emit nothing (aggregateWithin drops empty schedule steps). Client contract unchanged — the frame carries an array the RpcClient transparently re-emits element-by-element, so `wsTransport` / `threadDetailReducer` need no change.
- **ponytail shortcuts:** window fixed at 33ms (~30fps) with an upgrade-path comment; no size-based split (MAX_SAFE_INTEGER cap) since `WS_PUSH_SUBSCRIBER_BUFFER=512` already bounds a window.
- **Residual risks:** `subscribeShell` (one-per-client, not the N-tabs multiplier) was intentionally left un-batched per the brief's "on top of the s1 per-aggregate queues" scope — trivial follow-up (`coalescePerTick(bufferedLiveStream)`) if its frame rate ever matters.
- **Next steps:** none required for acceptance; end-gate behavioral verify.

## Guard result

Green. `bun x turbo run typecheck build --filter=t3` → 10/10 tasks successful (only pre-existing effect-lint suggestions, no errors). `bun run --cwd apps/server test` → 182 passed / 1 skipped file, 1586 passed / 4 skipped. `bun run --cwd packages/client-runtime test` → 22 files, 167 passed. New burst test `coalescePerTick (T7-s3 WS frame batching)` asserts a same-tick burst → 1 frame and a gap → 2nd frame.

## Merge

—

## Verify result (end gate)

—

## Decision (Fable)

—
