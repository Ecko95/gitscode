# p2-DH-T7-s3 — batch WS frames per tick

Task: T7 · Lane: D/H (after s2) · Model: opus-4-8/high
Status: pending

## Brief (Fable)

- **Goal:** coalesce per-event WS sends into one frame per subscriber per tick (~16–50 ms), on top of the s1 per-aggregate queues.
- **Read first:** s1/s2 diffs (merged); the ws send path for subscription events in `apps/server/src/ws.ts`; how the web client decodes event frames (`packages/client-runtime` ws transport) — batching must stay protocol-compatible (an array frame or repeated sends; choose what the client already tolerates).
- **Invariants:** ordering within a batch preserved; no added latency beyond one tick; empty ticks send nothing.
- **Acceptance:** burst test: N events in one tick → 1 frame (or documented client-compatible batching); client-runtime tests still green; guard green.
- **Verification (guard):** `bun x turbo run typecheck build --filter=t3` + `bun run --cwd apps/server test` + `bun run --cwd packages/client-runtime test`.

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
