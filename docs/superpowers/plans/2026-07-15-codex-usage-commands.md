# Codex Usage Commands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add session-scoped `/status` and `/usage` controls for Codex, reset-credit redemption and expiry warnings, and correct the composer usage layout.

**Architecture:** Extend the existing typed provider/RPC path with two Codex account operations, then render the results in the existing chat/composer UI. Reuse the current web-push and in-app toast paths; persist only threshold-delivery keys needed for deduplication.

**Tech Stack:** TypeScript, Effect Schema/RPC, React, TanStack Query, Vitest, Tailwind CSS, Codex app-server v2.

## Global Constraints

- Codex account operations must be rejected for non-Codex sessions.
- Reset redemption always requires explicit user confirmation.
- Browser/system warnings fire once at 48 hours and once at 24 hours per credit, with an in-app fallback.
- No new dependency and no CLI terminal emulation.
- Run `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test` before completion.

---

### Task 1: Typed Codex account operations

**Files:**
- Modify: `packages/contracts/src/usage.ts`
- Modify: `packages/contracts/src/rpc.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `apps/server/src/provider/Services/ProviderService.ts`
- Modify: `apps/server/src/provider/Layers/ProviderService.ts`
- Modify: `apps/server/src/provider/Layers/CodexSessionRuntime.ts`
- Test: `packages/contracts/src/usage.test.ts`
- Test: `apps/server/src/provider/Layers/ProviderService.test.ts`

**Interfaces:**
- Produces: `CodexAccountUsage`, `CodexAccountUsageInput`, `CodexResetCreditConsumeInput`, and RPC methods `provider.codexAccountUsage` / `provider.consumeCodexResetCredit`.
- Consumes: Codex app-server `account/rateLimits/read` and `account/rateLimitResetCredit/consume`.

- [ ] Write failing schema and provider tests proving rate-limit windows and reset-credit timestamps are mapped, non-Codex sessions are rejected, and a consume call forwards the credit ID with a UUID idempotency key.
- [ ] Run `bun run test packages/contracts/src/usage.test.ts apps/server/src/provider/Layers/ProviderService.test.ts` and confirm the new APIs are absent.
- [ ] Add the minimal schemas and route both operations through the existing active Codex session client; validate the selected credit against the latest returned snapshot before consuming it.
- [ ] Run the same focused tests and confirm they pass.
- [ ] Commit with `git commit -m "feat(server): expose Codex account usage"`.

### Task 2: Composer commands and account panels

**Files:**
- Modify: `apps/web/src/composer-logic.ts`
- Modify: `apps/web/src/composer-logic.test.ts`
- Modify: `apps/web/src/components/chat/ChatComposer.tsx`
- Modify: `apps/web/src/components/ChatView.tsx`
- Create: `apps/web/src/components/chat/CodexUsageDialog.tsx`
- Test: `apps/web/src/components/chat/CodexUsageDialog.test.tsx`

**Interfaces:**
- Consumes: Task 1 RPC operations and account schemas.
- Produces: standalone commands `status | usage` and a dialog that renders usage windows, credits, expiry dates, unavailable/error states, and confirmed redemption.

- [ ] Write failing parser tests for `/status` and `/usage`, including rejection when extra message text is present.
- [ ] Write failing component tests that assert Codex-only visibility, expiry rendering, unavailable copy, confirmation before redemption, and query refresh after a `reset` outcome.
- [ ] Run the focused web tests and confirm they fail for missing behavior.
- [ ] Add the two Codex-only menu items, intercept standalone submission in `ChatView`, and implement one shared dialog with status/usage display modes.
- [ ] Use `api.dialogs.confirm` before the consume RPC; keep the dialog open and display failures or non-reset outcomes.
- [ ] Run the focused tests and confirm they pass.
- [ ] Commit with `git commit -m "feat(web): add Codex status and usage commands"`.

### Task 3: Reset expiry notifications

**Files:**
- Create: `apps/web/src/lib/codexResetWarnings.ts`
- Create: `apps/web/src/lib/codexResetWarnings.test.ts`
- Modify: `apps/web/src/hooks/useNotifications.ts`
- Modify: `apps/web/src/components/ChatView.tsx`

**Interfaces:**
- Consumes: Task 1 reset credits and existing notification subscription/toast facilities.
- Produces: `collectDueResetWarnings(credits, deliveredKeys, now)` returning due 48-hour/24-hour warnings and stable `<creditId>:<threshold>` keys.

- [ ] Write a failing table test covering outside-window, 48-hour, 24-hour, missing-expiry, expired, and previously-delivered cases.
- [ ] Run `bun run test apps/web/src/lib/codexResetWarnings.test.ts` and confirm the helper is missing.
- [ ] Implement the pure warning selector, persist delivered keys in local storage, and call the existing notification delivery path with in-app toast fallback when Codex usage refreshes.
- [ ] Run the focused test and confirm it passes.
- [ ] Commit with `git commit -m "feat(web): warn before Codex resets expire"`.

### Task 4: Composer-width layout and final verification

**Files:**
- Modify: `apps/web/src/components/chat/ComposerUsageBars.tsx`
- Modify: `apps/web/src/components/chat/ComposerUsageBars.test.tsx`
- Modify: `apps/web/src/components/ChatView.tsx`

**Interfaces:**
- Consumes: existing chat content/composer wrapper.
- Produces: composer and usage panel aligned to the chat content width, with progress tracks limited to 30%.

- [ ] Update the component test to require the outer panel to inherit the full composer width and the progress column to use 30% on non-narrow layouts.
- [ ] Run `bun run test apps/web/src/components/chat/ComposerUsageBars.test.tsx` and confirm the class assertion fails.
- [ ] Reuse the chat content wrapper for composer/usage width and change only the progress-track column sizing, retaining a responsive narrow-screen minimum.
- [ ] Run the focused test and confirm it passes.
- [ ] Run `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test`.
- [ ] Commit with `git commit -m "fix(web): align composer usage layout"`.
- [ ] Push `feat/codex-usage-commands`, open a PR into `gits`, and report its CI state.
