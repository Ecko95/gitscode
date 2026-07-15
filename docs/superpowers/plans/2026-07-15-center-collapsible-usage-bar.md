# Centered Collapsible Usage Bar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Center and collapse the composer usage display and make Codex `/status` and `/usage` execute reliably.

**Architecture:** Keep presentation state inside `ComposerUsageBars`, persisting one boolean with native `localStorage`. Route account commands from the provider already selected in the composer, the same source used to advertise them, and surface unsupported use through the existing toast system.

**Tech Stack:** React, TypeScript, Tailwind CSS, Vitest, native Web Storage.

## Global Constraints

- Add no dependency or speculative abstraction.
- Storage failures fall back to expanded mode without affecting chat.
- Run `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test` before completion.

---

### Task 1: Center and collapse the usage panel

**Files:**

- Modify: `apps/web/src/components/chat/ComposerUsageBars.tsx`
- Test: `apps/web/src/components/chat/ComposerUsageBars.test.tsx`

**Interfaces:**

- Consumes: existing `ComposerUsageBars` props.
- Produces: the same component API with persisted expanded/collapsed rendering.

- [ ] Add a failing component test requiring `mx-auto`, an accessible far-right collapse button, and a collapsed `Usage` strip.
- [ ] Run `bun run test apps/web/src/components/chat/ComposerUsageBars.test.tsx` and confirm the new assertions fail.
- [ ] Add the minimum React state, guarded `localStorage`, centered progress classes, and chevron button.
- [ ] Re-run the focused test and confirm it passes.

### Task 2: Route Codex account commands from composer state

**Files:**

- Modify: `apps/web/src/components/ChatView.tsx`
- Modify: `apps/web/src/composer-logic.ts`
- Test: `apps/web/src/composer-logic.test.ts`

**Interfaces:**

- Consumes: `ctxSelectedProvider` returned by `composerRef.current.getSendContext()`.
- Produces: `resolveCodexAccountCommand(command, provider)` returning `"status" | "usage" | null`.

- [ ] Add a failing unit test proving account commands resolve for composer-selected Codex even when no active-provider snapshot is involved, and reject Claude.
- [ ] Run `bun run test apps/web/src/composer-logic.test.ts` and confirm the helper is missing.
- [ ] Implement the pure resolver and use it in `ChatView.onSend`; unsupported account commands use the existing warning toast and clear the draft.
- [ ] Re-run both focused tests and confirm they pass.

### Task 3: Verify and ship

**Files:**

- No production files beyond Tasks 1 and 2.

**Interfaces:**

- Produces: a mergeable PR and hosted deployment at the merge commit.

- [ ] Run `bun fmt`, `bun lint`, `bun typecheck`, and `PATH=/usr/bin:/bin:/home/ops/.bun/bin bun run test`.
- [ ] Commit, push, open a PR to `gits`, wait for CI, and merge with no conflicts.
- [ ] Run `scripts/gits-hosting/deploy-subject28-gits.sh` with the live repo/worktree paths, then verify service state and build metadata match the merge commit.
