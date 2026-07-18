# p4-audit-T16-s1 — concurrent-task isolation audit (report-only)

Task: T16 · Lane: audit · Model: opus-4-8/high
Status: done

## Brief (Fable)

- **Goal:** REPORT-ONLY audit confirming 3–4 concurrent Codex/Claude tasks cannot see each other's data, post-T7/T9: (a) per-thread authorization holds for every WS stream (thread, shell, provider events); (b) worktree isolation — investigate the recurring `worktree.burial.remove-failed` WARNs and whether one task's worktree/env/secrets are reachable by another; (c) tool-output payloads (post-T1) and provider NDJSON logs don't co-mingle secrets across sessions.
- **Read first:** merged T7/T9 diffs; `apps/server/src/vcs/WorktreeGraveyardRetirement.ts`; `provider/Layers/EventNdjsonLogger.ts`; `orchestration/decider.worktree-ownership.test.ts`; plan §T16.
- **Invariants:** read-only — any fix it identifies becomes a NEW slice proposal in Hand-back, not an edit.
- **Acceptance:** a written isolation matrix (stream × thread → allowed/denied, with the test or evidence per row) + gap list with severity; one new vitest per matrix row that lacks coverage (tests are the single allowed code addition).
- **Verification (guard):** `bun x turbo run typecheck build --filter=t3` + new tests green.

## Hand-back (execution agent)

### Model recap

This is a **single-operator cockpit** — the 3–4 concurrent Codex/Claude tasks all belong to one
authenticated user. So "isolation" here is **not** cross-user authz; it is: (i) events for thread A
must never be **delivered onto** a subscriber of thread B (no co-mingling on the WS bus), (ii) one
task's worktree must never be **removed** while another live thread references it, and (iii) tool
output / provider logs must not **co-mingle secrets** across thread files. Two session roles have
full thread visibility by design (`owner`, `client`); the only confined role is `thread-scoped`
(crit sidecar, subject-bound to one threadId), which is **denied the WS surface entirely**
(`denyThreadScopedRealtime` at both ws-token mint and `/ws` upgrade — `auth/Layers/ServerAuth.ts:333,389`).

### Isolation matrix (stream × relationship → verdict + evidence)

| #   | Stream                                                 | Relationship                                                             | Verdict                                                             | Evidence                                                                                                                                                                            |
| --- | ------------------------------------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | subscribeThread (live domain events)                   | subscriber of thread A ← thread B event                                  | **denied** (never queued)                                           | `OrchestrationEngine.test.ts:577` "routes live events only to the matching aggregateId queue (T7)" — dispatcher routes per `aggregateId`; queueB provably empty for threadA's event |
| 2   | subscribeThread (bind authz)                           | `thread-scoped` session → any other thread                               | **denied 403**                                                      | `denyThreadAccess` (`ServerAuth.ts:66`) checked before queue register (`ws.ts:1253`); `ws.subscribeThread.test.ts:114`                                                              |
| 3   | subscribeThread (bind authz)                           | `owner`/`client` → any thread                                            | **allowed** (by design)                                             | `ws.subscribeThread.test.ts:127`                                                                                                                                                    |
| 4   | subscribeShell (global thread-list snapshot + upserts) | `thread-scoped` session opening the stream                               | **denied** (cannot open `/ws` at all)                               | `denyThreadScopedRealtime` (`ServerAuth.ts:45`); `ServerAuth.test.ts:200` (token mint 403) + `:226` (upgrade 403)                                                                   |
| 5   | subscribeShell                                         | `owner`/`client`                                                         | **allowed** — list is global by design (no per-thread routing)      | design + row 4 (only confined role is fenced off)                                                                                                                                   |
| 6   | provider NDJSON log (per-thread file)                  | thread A record vs thread B record                                       | **separated** (distinct `<segment>.log` files)                      | `resolveThreadSegment` (`EventNdjsonLogger.ts:102`); `EventNdjsonLogger.test.ts:32`                                                                                                 |
| 7   | provider NDJSON log (payload)                          | secret in a serialized event                                             | **redacted** before write                                           | `redactSecrets` (`EventNdjsonLogger.ts:63`) applied in `toLogMessage:135`; `EventNdjsonLogger.test.ts:213+` (Bearer / sk-ant / sk- / ghp*/ghs*/github*pat*)                         |
| 8   | worktree retirement                                    | thread A retires while fork thread B lives on the **same** worktree path | **skipped** (not removed)                                           | `hasLiveThreadForWorktreePath` guard (`WorktreeGraveyardRetirement.ts:76`); `WorktreeGraveyardRetirement.test.ts:176`                                                               |
| 9   | worktree retirement                                    | liveness check **errors**                                                | **skipped** (fail-safe: never remove on doubt)                      | Step-0 catch → `Effect.as(true)` (`WorktreeGraveyardRetirement.ts:79-85`); **NEW test** `WorktreeGraveyardRetirement.test.ts` "skips retirement when the live-thread check errors"  |
| 10  | worktree retirement                                    | `git worktree remove` fails                                              | no `buried` event; owner's worktree left in place (recovery marker) | `WorktreeGraveyardRetirement.ts:156`; `WorktreeGraveyardRetirement.test.ts:168`                                                                                                     |

**Every matrix row now carries a test or byte-level evidence.** Row 9 was the only row without
coverage → the single allowed code addition (one vitest) closes it.

### Gap list (severity — each becomes a NEW slice proposal, not an edit here)

- **[LOW / resource-leak, not isolation-leak] `worktree.burial.remove-failed` WARN.** The recurring
  WARN (`WorktreeGraveyardRetirement.ts:149`) fires when `git worktree remove` throws (typically
  `force:false` + a dirty/locked worktree). It leaves the **owning** thread's worktree on disk — it
  does **not** make that worktree reachable by another task, so it is not a cross-task isolation
  breach; it is a disk/cleanup leak. Fix belongs in a Phase-3-style slice: either retry with a
  reasoned `force` after confirming no live thread (reuse the row-8/row-9 guard), or emit a
  `worktree.burial.deferred` marker a reaper retries. **Proposed slice:** `pN-vcs-Txx` "reap
  remove-failed worktrees on a bounded retry".
- **[LOW / defense-in-depth] subscribeShell has no per-thread authorization of its own.** Isolation
  for the shell stream rests entirely on row 4 (thread-scoped fenced off at `/ws`). That holds today,
  but the shell snapshot is a global thread list with no second gate — if a future role is added that
  can open `/ws` yet should be thread-confined, the shell stream would leak the full thread list. Not
  a live bug (no such role exists). **Proposed slice (only if a new confined role lands):** add a
  `denyThreadScopedRealtime`-style filter to `getShellSnapshot`.
- **[INFO] Provider NDJSON redaction is a string-scan allowlist of known key shapes.** `redactSecrets`
  covers Bearer/sk-ant/sk-/GitHub/`"token"`-style fields (`EventNdjsonLogger.ts:49-61`, self-flagged
  `ponytail:`). A novel credential shape in a deeply-nested field could slip through. This is the
  documented ceiling, not a regression; no action unless a new secret shape is observed in logs.

### Files read (evidence sources — no edits except the test file)

- `apps/server/src/ws.ts` (subscribeThread/subscribeShell auth + routing, `:1151-1280`)
- `apps/server/src/auth/Services/ServerAuth.ts` (`denyThreadAccess`, `denyThreadScopedRealtime`)
- `apps/server/src/auth/Layers/ServerAuth.ts` (`:330-394` token mint + `/ws` upgrade denial)
- `apps/server/src/orchestration/Layers/OrchestrationEngine.ts` + `.test.ts` (per-aggregate routing)
- `apps/server/src/vcs/WorktreeGraveyardRetirement.ts` + `.test.ts`
- `apps/server/src/provider/Layers/EventNdjsonLogger.ts` + `.test.ts`
- `apps/server/src/orchestration/decider.worktree-ownership.test.ts`
- T7/T9 merged diffs (`de07b4c9a`, `b07b74d84`, `741ccbaca`, `57b94b297`)

### Tests added (single allowed code addition)

`apps/server/src/vcs/WorktreeGraveyardRetirement.test.ts` — one new case for matrix row 9:
"skips retirement when the live-thread check errors (fail-safe: never remove on doubt)". Extended the
existing mock harness (`makeProjectionLayer` + `runRetirement`) with a `failLiveCheck` flag so the
projection query can fail; asserts no dispatch and no receipt (removal never runs). File count 8→9
tests, all green.

## Guard result

`bun x turbo run typecheck build --filter=t3` → **10 tasks successful, 10 total** (green). The
`TS377xxx` lines are pre-existing effect-lint _suggestions_ (not errors) and are unrelated to this
change. `vitest run WorktreeGraveyardRetirement.test.ts` → **9 passed (9)**.

## Merge

—

## Verify result (end gate)

—

## Decision (Fable)

—
