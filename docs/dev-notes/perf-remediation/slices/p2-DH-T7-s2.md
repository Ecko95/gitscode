# p2-DH-T7-s2 — subscribe-time thread↔client authorization

Task: T7 · Lane: D/H (after s1) · Model: opus-4-8/high
Status: pending

## Brief (Fable)

- **Goal:** the isolation half: authorize the thread↔client binding at subscribe time so a cross-thread event is never placed on a client's queue (today isolation is only a client-side filter).
- **Read first:** the s1 diff (merged); `apps/server/src/ws.ts` subscribe handlers and whatever session/auth context they carry (trace how a WS connection is tied to a session — `auth/Layers/SessionCredentialService.ts` and the ws upgrade path); plan §T7 + §"Data leaks" both readings.
- **Invariants:** deny = subscription refused with the existing error shape, not a silent empty stream; no new auth concept — reuse the session's existing thread-visibility rule (find where thread ownership/visibility is already decided and call THAT).
- **Acceptance:** test: client with session S subscribed to its thread A receives A events; the same client attempting thread B (not visible to S) is refused and receives nothing even when B events flow; guard green.
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
