# p4-audit-T16-s1 — concurrent-task isolation audit (report-only)

Task: T16 · Lane: audit · Model: opus-4-8/high
Status: pending

## Brief (Fable)

- **Goal:** REPORT-ONLY audit confirming 3–4 concurrent Codex/Claude tasks cannot see each other's data, post-T7/T9: (a) per-thread authorization holds for every WS stream (thread, shell, provider events); (b) worktree isolation — investigate the recurring `worktree.burial.remove-failed` WARNs and whether one task's worktree/env/secrets are reachable by another; (c) tool-output payloads (post-T1) and provider NDJSON logs don't co-mingle secrets across sessions.
- **Read first:** merged T7/T9 diffs; `apps/server/src/vcs/WorktreeGraveyardRetirement.ts`; `provider/Layers/EventNdjsonLogger.ts`; `orchestration/decider.worktree-ownership.test.ts`; plan §T16.
- **Invariants:** read-only — any fix it identifies becomes a NEW slice proposal in Hand-back, not an edit.
- **Acceptance:** a written isolation matrix (stream × thread → allowed/denied, with the test or evidence per row) + gap list with severity; one new vitest per matrix row that lacks coverage (tests are the single allowed code addition).
- **Verification (guard):** `bun x turbo run typecheck build --filter=t3` + new tests green.

## Hand-back (execution agent)

_(isolation matrix · gaps · files read · tests added)_

## Guard result

—

## Merge

—

## Verify result (end gate)

—

## Decision (Fable)

—
