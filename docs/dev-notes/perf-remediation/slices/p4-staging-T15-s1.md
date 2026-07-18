# p4-staging-T15-s1 — Bun A/B on staging (report-only)

Task: T15 · Lane: staging · Model: opus-4-8/high
Status: pending

## Brief (Fable)

- **Goal:** measure whether Bun/JSC handles the (post-Phase-1) heap better. Staging port + a COPY of the DB only: `bun apps/server/dist/bin.mjs serve --port <staging>`; drop `--max-old-space-size`; NOT `--smol`. Collect the T14 metrics over a real agent session and produce a side-by-side report.
- **Read first:** `apps/server/src/server.ts:175,:188,:211` (`typeof Bun` branches), `terminal/Layers/BunPTY.ts`, `persistence/Layers/Sqlite.ts:19-26` (driver select); plan §T15 risk list (claude-agent-sdk child_process under Bun, `@effect/sql-sqlite-bun` WAL concurrency, web-push crypto, BunPTY TUI fidelity).
- **Invariants:** NEVER the live port or live DB file; no code changes — this is measurement; staging process torn down after.
- **Acceptance:** Hand-back contains the side-by-side T14 metric table (node vs bun), each §T15 risk exercised with outcome, and a data-backed adopt/don't-adopt recommendation.
- **Verification (guard):** N/A (no repo change).

## Hand-back (execution agent)

_(metrics table · risk outcomes · recommendation)_

## Guard result

—

## Merge

—

## Verify result (end gate)

—

## Decision (Fable)

—
