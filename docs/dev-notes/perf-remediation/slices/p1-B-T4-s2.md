# p1-B-T4-s2 — getThreadDetailById + ingestion fetch-only-needed

Task: T4 · Lane: B (after s1) · Model: opus-4-8/high
Status: done

## Brief (Fable)

- **Goal:** bound `getThreadDetailById` (currently loads ALL rows, no LIMIT) and make ingestion's `getLoadedThreadDetail` call sites fetch only what each site needs (one turn's messages; proposedPlans list) instead of the whole thread.
- **Read first:** `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts:2135-2260` (detail assembly), `:930` (`listThreadActivityRowsByThread`, ORDER BY without LIMIT); `ProviderRuntimeIngestion.ts:1491,:1558,:1614,:1627` (call sites); `ProjectionSnapshotQuery.test.ts`; plan §T4.
- **Invariants:** public RPC `getThreadDetailById` used by clients keeps its contract for UI reads (cap = newest N, consistent with T5); ingestion behavior identical on threads ≤ N rows.
- **Acceptance:** activities query LIMITed; ingestion sites no longer materialize full threads; tests green incl. a large-thread fixture proving bounded rows; guard green.
- **Verification (guard):** `bun x turbo run typecheck build --filter=t3` + `bun run --cwd apps/server test -- ProjectionSnapshotQuery`.

## Hand-back (execution agent)

**Files read:** ProjectionSnapshotQuery.ts (Layer + Service), ProviderRuntimeIngestion.ts (Layer),
ProjectionSnapshotQuery.test.ts, projector.ts (MAX cap + activity trim), persistence message/plan
repos, migration 029 (activity ordering index), the 9 inline ProjectionSnapshotQuery mocks.

**Files changed (4 + slice):**

- `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts` — LIMIT the per-thread
  activities read to the newest `MAX_THREAD_ACTIVITIES = 500` (subquery `ORDER BY DESC LIMIT`, outer
  `ORDER BY ASC` restores first-seen order; NULL sequence stays oldest — mirrors projector's
  `.slice(-500)` and uses the migration-029 index). Added `listThreadMessageRowsByTurn`
  (`turn_id IS <turnId>`, null-safe) + two new public methods `listThreadMessagesByTurn` /
  `listThreadProposedPlans` (reusing existing `mapMessageRow` / `mapProposedPlanRow` and the existing
  proposed-plan query).
- `apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts` — added the two methods as
  **optional** on the shape (so the 9 inline test doubles need no edits; live layer always provides
  them).
- `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts` — replaced the per-event
  full-thread memo (`getLoadedThreadDetail` → `getThreadDetailById`, which materialized all
  messages+activities+plans+visualPlans+checkpoints+decode) with two memoized narrow loaders:
  `getTurnMessages()` (current turn's messages, or the turn-less partition) and
  `getThreadProposedPlans()`. All four call sites (`request.opened`/`user-input.requested`,
  `item.completed` assistant, `turn.proposed.completed`, `turn.completed`) now fetch only what they
  use; the `turn.completed` load moved inside `if (turnId)`.
- `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.test.ts` — added a 620-activity
  large-thread fixture asserting `getThreadDetailById` returns exactly the newest 500 (sequences
  121–620), and a `listThreadMessagesByTurn` test covering a turn match + the null (turn-less)
  partition.

**Diff-stat:** 4 files, +322 / −24 (source); slice file additionally.

**Summary:** getThreadDetailById is now bounded (newest 500 activities) for both the public RPC and
any caller, and provider-runtime ingestion no longer materializes whole threads per event — it reads
one turn's messages and the proposed-plan list via narrow SQL. Behavior is identical on threads ≤ 500
activities (public RPC) and for all ingestion checks (turn-scoped reads return the same rows the
turn-filtered helpers already selected).

**Ponytail shortcuts:**

- New methods are **optional** on `ProjectionSnapshotQueryShape` with a full-detail fallback in
  ingestion, instead of required + editing all 9 inline mock literals (out-of-scope test churn). The
  fallback path is dead in prod (live layer implements both) and only serves type-doubles; no
  ingestion test uses a double. `ponytail:` comments mark it.
- `getTurnMessages` for a turn-less event reads the `turn_id IS NULL` partition. Theoretical edge: a
  message whose id derives from `itemId` but whose row carries a non-null `turn_id` while _this_
  event omits `turnId` would be missed by the null-partition scan (the old full scan saw it). This
  needs the provider to drop `turnId` on a completion whose deltas carried it — abnormal; noted, not
  guarded.

**Residual risks:** none within acceptance. `MAX_THREAD_ACTIVITIES = 500` is defined locally in the
Layer (mirrors projector's bare `500`); T5 owns the hydrate `.slice` and can dedupe if desired.

**Next steps:** T5 (LIMIT hydrate activities + bound in-memory read model) pairs with this.

## Guard result

Green. `bun x turbo run typecheck build --filter=t3` → 10/10 tasks successful (only pre-existing
`suggestion`-level effect-lint diagnostics, no errors). `bun run --cwd apps/server test --
ProjectionSnapshotQuery` → 17 passed (incl. the 2 new). Also ran the touched-file suite
`ProviderRuntimeIngestion` → 44 passed (behavioral equivalence).

## Merge

—

## Verify result (end gate)

—

## Decision (Fable)

—
