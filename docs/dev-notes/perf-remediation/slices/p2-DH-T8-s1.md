# p2-DH-T8-s1 — debounce thread-upserted shell frames

Task: T8 · Lane: D/H (last in sequence) · Model: sonnet-4-6/medium
Status: pending

## Brief (Fable)

- **Goal:** stop one sync SQL + WS frame per thread event per shell subscriber: coalesce `thread-upserted` per `threadId` (~200 ms), reusing the `PROVIDER_STATUS_DEBOUNCE_MS` pattern.
- **Read first:** `apps/server/src/ws.ts:180` (`PROVIDER_STATUS_DEBOUNCE_MS`) and its use at `:2054` (the pattern); the (post-T7) subscribeShell handler; plan §T8.
- **Invariants:** last-write-wins per threadId; UI shell list still coherent within ~200 ms; built on top of the T7/T9 code as merged (read those diffs first).
- **Acceptance:** burst of upserts on one thread → 1 `getThreadShellById` + 1 frame per debounce window (test); guard green.
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
