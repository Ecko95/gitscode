# p2-DH-T9-s1 — afterSequence in contracts

Task: T9 · Lane: D/H (after T7 slices) · Model: opus-4-8/high
Status: pending

## Brief (Fable)

- **Goal:** add the optional `afterSequence` input field to the thread/shell subscription contracts in `packages/contracts` (port of upstream's resume-by-sequence input; upstream ref commits `482d56233`+`c14a5ca49` — consult via `git show` for shape, then adapt, don't copy blind).
- **Read first:** `packages/contracts/src/` subscription input schemas (`git grep -n subscribeThread packages/contracts`), upstream shape: `git show refs/upstream/t3code-main:packages/contracts/src/orchestration.ts` (~`:463,:476`); plan §T9 + §1b.
- **Invariants:** field OPTIONAL — absent = today's full-snapshot behavior; no breaking change to existing clients (typecheck of apps/web + packages/client-runtime must stay green, they compile against contracts).
- **Acceptance:** contracts expose `afterSequence?`; `bun x turbo run typecheck build` green across dependents (not just t3); guard green.
- **Verification (guard):** `bun x turbo run typecheck build` (full — contracts fan out).

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
