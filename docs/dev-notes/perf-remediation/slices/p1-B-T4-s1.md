# p1-B-T4-s1 — refreshThreadShellSummary → SQL aggregates

Task: T4 · Lane: B (lead: Opus) · Model: opus-4-8/high
Status: done

## Brief (Fable)

- **Goal:** replace the full-thread materialization in `refreshThreadShellSummary` (loads ALL messages+activities+plans+pendingApprovals per event) with `COUNT(*)`/`MAX(created_at)`-style SQL aggregates.
- **Read first:** `apps/server/src/orchestration/Layers/ProjectionPipeline.ts:541-584` (+ call sites `:744,:760,:776,:814`), `ProjectionSnapshotQuery.ts` list functions it calls, `ProjectionPipeline.test.ts`; plan §T4.
- **Invariants:** summary row shape unchanged (downstream WS consumers read it); pending-user-input count must match old semantics exactly (indexed query over the two relevant activity kinds); projection rebuild (`t3 db rebuild-projections`) must produce identical summaries.
- **Acceptance:** no `listByThreadId` full loads remain in the refresh path; `ProjectionPipeline.test.ts` green (extend with an equivalence test old-vs-new on a seeded thread); guard green.
- **Verification (guard):** `bun x turbo run typecheck build --filter=t3` + `bun run --cwd apps/server test -- ProjectionPipeline`.

## Hand-back (execution agent)

- **Files read:** `ProjectionPipeline.ts` (refresh path + derive helpers + callers), `ProjectionSnapshotQuery` refs, `ProjectionPipeline.test.ts`, `ProjectionThreads`/`ProjectionThreadMessages`/`ProjectionThreadActivities`/`ProjectionThreadProposedPlans` (Services + Layers), migration `024_BackfillProjectionThreadShellSummary.ts`, contracts `orchestration.ts`, `ProviderRuntimeIngestion.ts`, `decider.ts`.
- **Files changed:** `apps/server/src/persistence/Services/ProjectionThreads.ts`, `apps/server/src/persistence/Layers/ProjectionThreads.ts`, `apps/server/src/orchestration/Layers/ProjectionPipeline.ts`, `apps/server/src/orchestration/Layers/ProjectionPipeline.test.ts`.
- **Diff-stat:** 4 files, +543 / −42 (test +398, pipeline +21/−42, threads layer +112, threads service +12).
- **Summary:** Replaced the full-thread materialization in `refreshThreadShellSummary` (four `listByThreadId` loads of every message/activity/plan/approval per event) with a single per-thread SQL `UPDATE` — new `ProjectionThreadRepository.refreshShellSummary` — computing `latestUserMessageAt` (`MAX`), `pendingApprovalCount`/`pendingUserInputCount` (`COUNT` over indexed/filtered rows), and `hasActionableProposedPlan` (top-1 correlated selects). The aggregate SQL is the migration-024 backfill logic scoped to one thread, so rebuild and backfill stay identical. The pending-user-input aggregate was tightened vs migration 024 so it matches `derivePendingUserInputCountFromActivities` exactly (only state-changing activities — requested/resolved/stale-or-unknown-failed — participate in the per-requestId latest-state partition; non-stale failures are excluded, matching the JS "ignore" branch). The two derive helpers are retained (now `export`ed) as the equivalence-test oracle. Summary row shape unchanged.
- **Ponytail shortcuts:** Reused migration-024 SQL rather than writing four separate aggregate repo methods (single `UPDATE`, no `getById`/upsert round-trip). Kept `derivePendingUserInputCountFromActivities`/`deriveHasActionableProposedPlan` as the test oracle instead of hand-computing expected constants.
- **Residual risks:** JSON `requestId` equality assumes string values (matches prior derive + migration 024). The SQL detail match uses `LIKE '%…%'` == JS `.includes()` (no `%`/`_` in the literals, so equivalent). No behavioral verification beyond the guard/acceptance per instructions.
- **Next steps:** none.

## Guard result

Green. `bun x turbo run typecheck build --filter=t3` → 10/10 tasks successful (exit 0). `bun run --cwd apps/server test -- ProjectionPipeline` → 23/23 tests passed (exit 0), including the new old-vs-new equivalence test.

## Merge

—

## Verify result (end gate)

—

## Decision (Fable)

—
