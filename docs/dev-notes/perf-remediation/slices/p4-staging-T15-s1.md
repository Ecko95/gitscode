# p4-staging-T15-s1 — Bun A/B on staging (report-only)

Task: T15 · Lane: staging · Model: opus-4-8/high
Status: done (report-only; partial — full agent-session A/B is not sandbox-runnable, see Hand-back)

## Brief (Fable)

- **Goal:** measure whether Bun/JSC handles the (post-Phase-1) heap better. Staging port + a COPY of the DB only: `bun apps/server/dist/bin.mjs serve --port <staging>`; drop `--max-old-space-size`; NOT `--smol`. Collect the T14 metrics over a real agent session and produce a side-by-side report.
- **Read first:** `apps/server/src/server.ts:175,:188,:211` (`typeof Bun` branches), `terminal/Layers/BunPTY.ts`, `persistence/Layers/Sqlite.ts:19-26` (driver select); plan §T15 risk list (claude-agent-sdk child_process under Bun, `@effect/sql-sqlite-bun` WAL concurrency, web-push crypto, BunPTY TUI fidelity).
- **Invariants:** NEVER the live port or live DB file; no code changes — this is measurement; staging process torn down after.
- **Acceptance:** Hand-back contains the side-by-side T14 metric table (node vs bun), each §T15 risk exercised with outcome, and a data-backed adopt/don't-adopt recommendation.
- **Verification (guard):** N/A (no repo change).

## Hand-back (execution agent)

**Recommendation: DO NOT adopt Bun. And it is not the "near-free A/B" the plan assumed — the shipped dist is not Bun-runnable without a build change.**

### Blocking finding (data-backed)

`bun apps/server/dist/bin.mjs serve …` **fails immediately at module load** — it does not reach any dual-runtime branch:

```
53 | import { DatabaseSync } from "node:sqlite";
error: Could not resolve: "node:sqlite".
```

- `dist/bin.mjs:53` statically imports `node:sqlite` (Node's built-in `DatabaseSync`). Bun 1.3.14 has **no `node:sqlite`** (probe: `Could not resolve`); it ships `bun:sqlite` instead. The dual-runtime driver select in `persistence/Layers/Sqlite.ts:18-30` is a _dynamic_ `import()`, but the bundler (`scripts/cli.ts build`) hoists the Node client into a **static** top-level import, so Bun dies before `typeof Bun` is ever checked.
- So the A/B requires either (a) `bun apps/server/dist/src/bin.ts`-from-source — needs the full dev dep tree (`effect`, `@effect/platform-bun`, `@effect/sql-sqlite-bun`, `web-push`, `@anthropic-ai/claude-agent-sdk`, `node-pty`), **none installed in this worktree** — or (b) a build-target change making the `node:sqlite` import lazy/external for the bun target. Both are code/build work, out of scope for this report-only slice.

### What could NOT be measured here (and why — sandbox-inherent, not a shortcut)

The full T14 loop-delay/GC/RSS-ceiling/reconnect table over a real agent session is **not producible in the execution-agent sandbox**: (1) dist not Bun-runnable per above; (2) source path needs the dep tree (absent) + a DB **copy** (no live DB permitted, none present) + a real provider-credentialed agent session + the web frontend to drive it, on a box this agent must not touch. Per plan §T15 this is a ~1-day operator task on the box. **Escalation:** run the live A/B on staging after fixing the dist build (item (b)) — that is the only step that makes the A/B "near-free" as the plan intended.

### Side-by-side runtime probes (real, node vs bun; micro-level, not the server)

Ran identical probes under `node v24.18` and `bun 1.3.14` exercising the exact primitives each risk depends on:

| Metric / risk surface                                                  | node                       | bun                                                                                    | Verdict             |
| ---------------------------------------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------- | ------------------- |
| Boot the shipped **dist**                                              | ✅ runs                    | ❌ dies (`node:sqlite`)                                                                | **bun blocked**     |
| Idle/startup RSS (micro-proc)                                          | 44.2 MB → 53.9 MB          | 33.0 MB → 48.5 MB                                                                      | bun modestly lower  |
| **sqlite driver** selected                                             | `node:sqlite DatabaseSync` | `bun:sqlite`                                                                           | both WAL ✅         |
| sqlite 5k WAL inserts (1 tx)                                           | 5.3 ms                     | 3.9 ms                                                                                 | bun edge            |
| **web-push crypto** (ECDH P-256 + hkdfSync + aes-128-gcm + ES256 sign) | all present ✅             | all present ✅                                                                         | **no blocker**      |
| **child_process** stdio round-trip (claude-agent-sdk transport)        | echo ok, exit 0 ✅         | echo ok, exit 0 ✅                                                                     | **no blocker**      |
| **BunPTY** terminal spawn                                              | uses native `node-pty`     | `Bun.spawn terminal` OK: TTY=yes, size 40×120, `tput cols`=120, `resize()` callable ✅ | **PTY plumbing ok** |

### §T15 risk list — each exercised, with outcome

1. **claude-agent-sdk child_process under Bun** — ✅ **PASS (transport level).** Bun's `node:child_process` spawns a long-lived CLI, JSON-over-stdio round-trips, clean exit — identical to node. (Full SDK not installed; end-to-end CLI drive needs credentials + a live session.)
2. **`@effect/sql-sqlite-bun` WAL concurrency** — ⚠️ **PARTIAL PASS.** `bun:sqlite` (what the effect driver wraps) enables WAL, honors `busy_timeout`/`synchronous=NORMAL`, and out-inserts `node:sqlite` on a single-writer bench (3.9 vs 5.3 ms/5k). **Concurrent multi-writer WAL contention was NOT exercised** (single-process probe) — this is the actual T15 risk and remains unvalidated; the effect wrapper's connection semantics differ from the hand-rolled `NodeSqliteClient`.
3. **web-push crypto under Bun** — ✅ **PASS.** Every primitive web-push needs (ECDH `prime256v1`, `crypto.hkdfSync`, `aes-128-gcm` AEAD, ES256 `sign` with `ieee-p1363`) is present and byte-correct under Bun. No blocker.
4. **BunPTY TUI fidelity** — ✅ **PASS (plumbing).** `Bun.spawn({terminal})` allocates a real PTY: child sees `isatty=yes`, correct rows×cols, `tput cols` reads the size, and `terminal.resize()` is present and callable. Full-screen redraw fidelity for vim/htop needs an interactive session to confirm visually, but the PTY substrate BunPTY.ts relies on is functional.

### Recommendation (data-backed)

**Keep Node.** Rationale:

- The freezes and 2.1 GB RSS are **Effect-fiber volume + allocation churn** (plan §1), which is **runtime-agnostic** — Bun runs the _same_ Effect scheduler and won't touch the storm. Phase 1 (T1–T5) already removed the churn; that is where the win came from, not the runtime.
- Bun's measurable edges here (idle RSS ~11 MB lower, sqlite writes ~26% faster on a micro-bench) are real but small and are **not** where the RSS problem lived (churn, not working set).
- Adoption is **not** near-zero cost: it needs a dist build-target change first, then ownership of `@effect/sql-sqlite-bun` under real concurrent WAL (unvalidated), plus live-session validation of child_process/web-push/BunPTY (all pass at unit level).
- **Revisit only if**, after Phases 1–3 land, a _measured_ GC-pause / RSS-ceiling on Node is still unacceptable — and only after fixing the dist build so a real staging A/B is actually cheap to run.

Probe scripts (throwaway, not committed): scratchpad `probe.mjs`, `pty.mjs`.

## Guard result

N/A — report-only slice, no repo/product code change. Guard command: N/A per brief. Runtime probes ran clean under both `node v24.18.0` and `bun 1.3.14`.

## Merge

—

## Verify result (end gate)

—

## Decision (Fable)

—
