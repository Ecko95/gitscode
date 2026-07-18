# p1-A-T1-s2 — cap activity payload `data` (item.completed)

Task: T1 · Lane: A (after p1-A-T1-s1) · Model: sonnet-4-6/medium
Status: done

## Brief (Fable)

- **Goal:** apply the same 4 KB `data` cap (helper introduced in p1-A-T1-s1) to the `item.completed` site at `ProviderRuntimeIngestion.ts:656`.
- **Read first:** `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:645-665`; the s1 diff (already merged on the integration branch); its test.
- **Invariants:** reuse the s1 helper — no second implementation; the fork-only assistant_message/reasoning branch in this block stays untouched.
- **Acceptance:** `:656` passthrough uses the cap; test extended for the completed path; guard green.
- **Verification (guard):** `bun x turbo run typecheck build --filter=t3` + `bun run --cwd apps/server test -- ProviderRuntimeIngestion`.

## Hand-back (execution agent)

Files read: ProviderRuntimeIngestion.ts (lines 645-685), ProviderRuntimeIngestion.test.ts (lines 3188-3270).
Files changed: ProviderRuntimeIngestion.ts (1 line: add `truncateData` call at line 663 of `item.completed` site), ProviderRuntimeIngestion.test.ts (84 lines: new test mirroring s1 pattern for `item.completed`).
Diff-stat: 2 files changed, 84 insertions(+), 1 deletion(-).
Summary: Applied the s1 `truncateData` helper to the `item.completed` `data` passthrough at line 663; no new helper introduced. Test follows the exact pattern of the s1 test covering both pass-through and >4 KB truncation paths.
Ponytail shortcuts: none — one-word fix and copy-adapted test.
Residual risks: none identified.
Next steps: s3 (if any further sites exist) or end-gate verification.

## Guard result

typecheck + build: 10/10 tasks successful. Tests: 43/43 passed (ProviderRuntimeIngestion). Green.

## Merge

Committed as part of feat(orchestration): cap item.completed data at 4 KB [p1-A-T1-s2].

## Verify result (end gate)

—

## Decision (Fable)

—
