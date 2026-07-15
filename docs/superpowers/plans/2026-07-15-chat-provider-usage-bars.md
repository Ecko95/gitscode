# Chat Provider Usage Bars Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the selected Codex or Claude account's 5-hour and weekly usage immediately above the chat composer.

**Architecture:** Reuse `GET /api/gits/usage` and `UsageSummary`; add one shared fetch helper, one pure provider/window selector, and one presentational composer component. `ChatView` owns the existing TanStack query and enables it only for Codex or Claude.

**Tech Stack:** TypeScript, React, TanStack Query, Effect Schema contracts, Vitest.

## Global Constraints

- No backend, persistence, dependency, or provider-runtime changes.
- Poll every 60 seconds only for Codex or Claude chats.
- Show `Usage unavailable` rather than estimating missing provider limits.
- Place the panel above suggestions and queued messages.
- `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test` must pass.

---

### Task 1: Shared usage selection and request

**Files:**
- Create: `apps/web/src/lib/providerUsage.ts`
- Test: `apps/web/src/lib/providerUsage.test.ts`
- Modify: `apps/web/src/components/gits/GitsCockpit.tsx`

**Interfaces:**
- Produces: `readUsageSummary(): Promise<UsageSummary>`.
- Produces: `usageProviderForDriver(driver): UsageProvider | null`.
- Produces: `selectProviderUsageWindows(summary, provider): { fiveHour; weekly }`.

- [ ] **Step 1: Write failing selector tests**

Cover Codex/Claude driver mapping, provider isolation, exact `300`/`10080` minute selection, missing windows, and display clamping through `clampUsagePercent`.

- [ ] **Step 2: Verify failure**

Run: `bun run --cwd apps/web test lib/providerUsage.test.ts`
Expected: FAIL because `providerUsage.ts` does not exist.

- [ ] **Step 3: Implement the minimal helpers**

Use the existing `UsageSummary` and `UsageWindowSummary` contracts. Fetch `/api/gits/usage`, throw on non-2xx, filter by provider/window minutes, and clamp with `Math.min(100, Math.max(0, value))`.

- [ ] **Step 4: Reuse the request in Gits cockpit**

Replace its inline usage `fetch` with `queryFn: readUsageSummary`; do not change cockpit behavior.

- [ ] **Step 5: Verify and commit**

Run: `bun run --cwd apps/web test lib/providerUsage.test.ts`
Expected: PASS.

Commit: `feat(web): normalize provider usage windows`

### Task 2: Composer usage panel

**Files:**
- Create: `apps/web/src/components/chat/ComposerUsageBars.tsx`
- Test: `apps/web/src/components/chat/ComposerUsageBars.test.tsx`
- Modify: `apps/web/src/components/ChatView.tsx`

**Interfaces:**
- Consumes: `readUsageSummary`, `usageProviderForDriver`, and `selectProviderUsageWindows` from Task 1.
- Produces: `ComposerUsageBars({ provider, windows, unavailable })`.

- [ ] **Step 1: Write the failing component test**

Render two available rows and assert accessible `progressbar` names, percentages, and reset copy. Render partial/missing input and assert `Usage unavailable` only for absent rows.

- [ ] **Step 2: Verify failure**

Run: `bun run --cwd apps/web test components/chat/ComposerUsageBars.test.tsx`
Expected: FAIL because the component does not exist.

- [ ] **Step 3: Implement the compact component**

Render `5h` and `Weekly` rows with native `<progress max={100}>`, provider-aware accessible labels, rounded percentages, and localized reset timestamps. Keep it presentational and return `null` only when the driver is unsupported.

- [ ] **Step 4: Wire the query into ChatView**

Derive the usage provider from `activeProviderStatus?.driver`, query with key `["gits", "usage"]`, `enabled: usageProvider !== null`, `refetchInterval: 60_000`, and `retry: false`. Render `ComposerUsageBars` immediately before `ComposerSuggestions`; request errors pass the unavailable state without a toast.

- [ ] **Step 5: Run focused and repository checks**

Run:

```bash
bun run --cwd apps/web test lib/providerUsage.test.ts components/chat/ComposerUsageBars.test.tsx
bun fmt
bun lint
bun typecheck
PATH=/usr/bin:/bin:/home/ops/.bun/bin GITS_REAL_GIT=/usr/bin/git bun run test
```

Expected: all commands PASS.

- [ ] **Step 6: Commit**

Commit: `feat(web): show provider usage above composer`
