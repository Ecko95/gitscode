# p2-E-T6-s1 — effect MutableList.take guard (reconnect crash)

Task: T6 · Lane: E (patches) · Model: sonnet-4-6/medium
Status: pending

## Brief (Fable)

- **Goal:** add the `MutableList.take` guard hunk to `patches/effect@4.0.0-beta.73.patch`: first line of `take` becomes `if (!self.head || self.length <= 0) return Empty;` — stopping the 45/h `Failed to publish` crash on disconnect.
- **Read first:** `patches/effect@4.0.0-beta.73.patch` (currently RpcClient-only), `node_modules/effect/dist/MutableList.js:629-643` (take), `:731-749` (filter); plan §T6 for the full crash chain; how bun applies `patchedDependencies` (root `package.json`).
- **Invariants:** existing RpcClient hunks unchanged; patch must apply cleanly on `bun install` (verify!); also patch the ESM variant if `dist` ships both (check `dist/esm` vs `dist/cjs` layout).
- **Acceptance:** `bun install` re-applies the patch without error; a regression test (unit-level: interrupt a parked PubSub subscriber, then publish — no throw) if feasible in the repo's test layout, else a scripted repro in Hand-back; guard green.
- **Verification (guard):** `bun install && bun x turbo run typecheck build --filter=t3`.
- **Also:** draft the upstream Effect issue text in Hand-back (report-only).

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
