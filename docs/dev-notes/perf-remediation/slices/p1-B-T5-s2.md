# p1-B-T5-s2 — LIMIT listThreadActivityRowsByThread

Task: T5 · Lane: B (after s1) · Model: sonnet-4-6/medium
Status: done

## Brief (Fable)

- **Goal:** add a LIMIT (newest N, default 500) to `listThreadActivityRowsByThread` so no caller can materialize an unbounded thread; align with T4-s2's use.
- **Read first:** `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts:930-952`; every caller (`git grep -n listThreadActivityRowsByThread apps/server`); plan §T5.
- **Invariants:** callers that legitimately need more take an explicit `limit` param — no silent behavior change for the UI lazy-load path (confirm how the web app pages older activities before capping the RPC it uses; if it relies on full load, cap server-side but keep an explicit paged path).
- **Acceptance:** SQL carries LIMIT; call-site audit table in Hand-back (caller → limit chosen → why); tests green; guard green.
- **Verification (guard):** `bun x turbo run typecheck build --filter=t3` + `bun run --cwd apps/server test -- ProjectionSnapshotQuery`.

## Hand-back (execution agent)

**Files read:** `ProjectionSnapshotQuery.ts` (lines 930–1000, 2215–2240), `ProjectionSnapshotQuery.test.ts` (line 2113+), task context §T5.

**Files changed:** none — the LIMIT was already added to `listThreadActivityRowsByThread` by the prior lane slice p1-B-T4-s2 (commit `79677c2b1`).

**Diff-stat:** 0 files changed (no-op; work already landed).

**Summary:** `listThreadActivityRowsByThread` (line 963) already carries the
`MAX_THREAD_ACTIVITIES = 500` subquery LIMIT via the `AND activity_id IN (SELECT … ORDER BY sequence DESC, created_at DESC, activity_id DESC LIMIT 500)` guard added in T4-s2. There is exactly one caller in the codebase and it is already bounded. The web app does not page historical activities — incremental activities arrive via `thread.activity.append` WS push events, so cap-at-500 at load time is safe with no paged fallback needed.

**Call-site audit:**

| Caller                | File:line                         | Limit applied                                | Why                                                                                                   |
| --------------------- | --------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `getThreadDetailById` | `ProjectionSnapshotQuery.ts:2227` | 500 (MAX_THREAD_ACTIVITIES) via SQL subquery | Only load site; UI receives subsequent activities via WS push — no full-reload pagination path exists |

**Ponytail shortcuts:** none.

**Residual risks:** threads older than 500 activities will silently drop the oldest N at cold-start/reconnect. Accepted trade-off documented in T4-s2; if a "load older" UX is ever needed, add a keyset-paginated RPC at that time.

## Guard result

`bun x turbo run typecheck build --filter=t3`: 10/10 tasks successful (2 cached).
`bun run --cwd apps/server test -- ProjectionSnapshotQuery`: 18/18 tests passed.

## Merge

Slice file only (no source edits). Commit: included in this slice's commit.

## Verify result (end gate)

—

## Decision (Fable)

—
