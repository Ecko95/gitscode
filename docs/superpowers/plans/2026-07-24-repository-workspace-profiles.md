# Repository Workspace Profiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Separate Personal and Work repositories in the sidebar and route new repository-scoped Codex, Cursor, Claude, and Delamain work through configured provider instances without changing the personal GITS control-plane identity.

**Architecture:** Add repository-profile values and routing settings to the shared contracts, persist only a nullable project override, and put path classification/account lookup in one pure shared resolver. Existing provider instances remain the account boundary and existing sessions remain pinned. The web uses the resolver for filtering, draft defaults, labels, and warnings; Delamain receives the already-resolved provider environment only when a new repository worker is launched. Hermes keeps its independent, personal OAuth chain.

**Tech Stack:** Effect Schema, TypeScript, React, Zustand, SQLite migrations, Vitest, Bun/Turbo.

## Global Constraints

- [x] Keep existing settings and projects backward compatible: defaults are Personal, with no routing mappings.
- [x] Never infer account identity from an email address; route only by stable provider-instance ID.
- [x] Never switch a running session or worker after launch.
- [x] Never silently use a Personal Codex or Cursor instance for a Work repository.
- [x] Keep Hermes/Motoko control-plane authentication independent and personal.
- [x] Add no dependencies and no speculative quota accounting.
- [x] Use `rtk` for every shell command and `apply_patch` for edits.
- [x] Run `bun run test`, never `bun test`.

---

## Task 1: Add profile contracts and the shared resolver

**Files:**

- Modify: `packages/contracts/src/settings.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/shared/src/path.ts`
- Modify: `packages/shared/src/path.test.ts`
- Modify: `packages/shared/package.json`
- Create: `packages/shared/src/repositoryProfiles.ts`
- Create: `packages/shared/src/repositoryProfiles.test.ts`

- [x] Write failing resolver tests covering Personal default, Work-root containment, textual-prefix rejection, slash normalization, Windows case handling, manual override precedence, missing routes, Work Codex/Cursor routing, Work Claude-to-personal routing, and control-plane Personal Codex routing.
- [x] Run `rtk bun run test packages/shared/src/repositoryProfiles.test.ts` and confirm the new tests fail for the missing module.
- [x] Define `RepositoryProfile`, client-selected profile, server work roots, and per-profile driver-to-instance mappings with decoding defaults.
- [x] Add the smallest portable path normalizer/containment helper needed by the resolver and export the resolver through an explicit shared-package subpath.
- [x] Implement pure `resolveRepositoryProfile` and `resolveRepositoryProviderInstance` functions; a missing mapping returns `null`, never a fallback.
- [x] Run the focused shared tests and `rtk bun typecheck --filter=@t3tools/shared --filter=@t3tools/contracts`.
- [x] Commit: `feat: add repository profile routing contracts`.

## Task 2: Persist project-level profile overrides

**Files:**

- Modify: `packages/contracts/src/orchestration.ts`
- Modify: `apps/server/src/orchestration/decider.ts`
- Modify: `apps/server/src/orchestration/projector.ts`
- Modify: `apps/server/src/orchestration/Layers/ProjectionPipeline.ts`
- Modify: `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts`
- Modify: `apps/server/src/persistence/Services/ProjectionProjects.ts`
- Modify: `apps/server/src/persistence/Layers/ProjectionProjects.ts`
- Create: `apps/server/src/persistence/Migrations/037_RepositoryProfileOverride.ts`
- Modify: `apps/server/src/persistence/Migrations.ts`
- Modify tests beside the touched decider, projector, projection pipeline/query, and migrations.

- [x] Write failing tests proving `project.meta.update` can set, change, and clear a profile override and that snapshots preserve it.
- [x] Run those focused tests and confirm the missing field/migration failures.
- [x] Add nullable `repositoryProfileOverride` to project commands, events, projections, and SQL reads/writes.
- [x] Add migration 037 with a nullable text column; existing rows decode as automatic classification.
- [x] Ensure repository identity refresh and unrelated metadata updates preserve the override.
- [x] Run focused server tests and typecheck.
- [x] Commit: `feat: persist repository profile overrides`.

## Task 3: Add profile routing settings

**Files:**

- Modify: `apps/web/src/components/settings/SettingsPanels.tsx`
- Modify: `apps/web/src/components/settings/SettingsPanels.logic.ts`
- Modify: `apps/web/src/components/settings/SettingsPanels.logic.test.ts`
- Modify: `apps/web/src/hooks/useSettings.ts` only if its explicit key split requires it.

- [x] Write failing logic tests for parsing work roots and updating a single driver mapping without dropping other profile mappings.
- [x] Add a compact “Repository profiles” section to Provider settings: newline-separated Work roots plus Personal/Work instance selectors for Codex, Cursor, and Claude.
- [x] Use existing provider rows and stable instance IDs for options; label the independent Hermes Codex OAuth chain as the Personal control-plane account.
- [x] Surface missing/disabled mapped instances inline; do not invent quota state.
- [x] Run focused settings tests and typecheck.
- [x] Commit: `feat: configure repository profile accounts`.

## Task 4: Filter the sidebar and edit project overrides

**Files:**

- Modify: `apps/web/src/components/Sidebar.tsx`
- Modify: `apps/web/src/components/Sidebar.logic.ts` if shared selection/filter logic belongs there.
- Modify: `apps/web/src/components/Sidebar.logic.test.ts`

- [x] Write failing logic tests for effective-profile filtering, including grouped projects, empty profiles, and explicit overrides.
- [x] Add an accessible Personal/Work segmented switch above Projects, backed by the local client setting and always visible.
- [x] Filter sidebar project rows by the effective profile while leaving active/running thread state untouched.
- [x] Add a project context-menu action with Automatic, Personal, and Work choices that sends `project.meta.update`.
- [x] Keep the control visually native to the existing sidebar: compact, quiet, keyboard-focusable, and responsive.
- [x] Run focused sidebar tests and typecheck.
- [x] Commit: `feat: separate personal and work repositories`.

## Task 5: Default interactive sessions to the routed account

**Files:**

- Modify: `apps/web/src/components/ChatView.tsx`
- Modify: `apps/web/src/components/ChatView.logic.ts`
- Modify: `apps/web/src/components/ChatView.logic.test.ts`
- Modify: `apps/web/src/components/chat/ChatComposer.tsx`
- Modify: `apps/web/src/components/chat/ProviderModelPicker.tsx`
- Modify: `apps/web/src/components/chat/ProviderModelPicker.browser.tsx`

- [x] Write failing logic/browser tests for a Work draft selecting the Work mapping, Personal defaulting to Personal, missing mappings requiring selection, visible instance labels, and a Work-to-Personal warning.
- [x] Resolve a draft's preferred instance from its project's effective profile and selected driver; preserve explicit user model changes and all existing-session selections.
- [x] Before the first launch of a Work Codex/Cursor session on a mapped Personal instance, require confirmation; cancellation leaves the draft intact.
- [x] Show a persistent warning badge for the mismatched session and include the provider instance display name in the picker trigger.
- [x] Confirm that settings changes after launch do not alter `activeSession.instanceId` or the thread model selection.
- [x] Run focused web tests and typecheck.
- [x] Commit: `feat: route interactive sessions by repository profile`.

## Task 6: Route new Delamain repository workers

**Files:**

- Modify: `packages/contracts/src/gits.ts`
- Modify: `apps/server/src/provider/ProviderDriver.ts`
- Modify: `apps/server/src/provider/Drivers/CodexDriver.ts`
- Modify: `apps/server/src/provider/Drivers/CursorDriver.ts`
- Modify: `apps/server/src/gits/Layers/DelamainCliAdapter.ts`
- Modify: `apps/server/src/gits/Layers/DelamainCliAdapter.test.ts`
- Modify: `apps/server/src/gits/Layers/AutomodeSupervisor.ts`
- Modify: `apps/server/src/gits/Layers/AutomodeSupervisor.test.ts`
- Modify: `apps/web/src/components/DelamainSidebar.tsx`
- Modify: `apps/web/src/components/DelamainSidebar.test.tsx`
- Modify: `apps/web/src/components/gits/GitsCockpit.tsx`

- [x] Write failing adapter tests proving routed launches receive only the selected instance's worker environment and reject missing or driver-mismatched instances; profile-routed workflows fail closed because Delamain cannot enforce identity per leaf.
- [x] Expose the already-materialized per-instance child-process environment internally from Codex and Cursor drivers; for Codex include the effective `CODEX_HOME`.
- [x] Add an optional resolved provider-instance ID to new Delamain launch inputs and use it only at launch; peer resume/status behavior stays unchanged.
- [x] Resolve automated peer launches from repository profile settings and block on a missing Work mapping instead of falling back.
- [x] Require the same Work-to-Personal confirmation for manual Delamain peer launches; keep Automode on configured mappings only and block routed workflows.
- [x] Add an invariant test that repository profiles never alter Hermes/Motoko's dedicated OAuth environment.
- [x] Run focused GITS tests and typecheck.
- [x] Commit: `feat: route repository workers by profile`.

## Task 7: Reconcile docs, review, and verify

**Files:**

- Modify: `docs/superpowers/specs/2026-07-24-repository-workspace-profiles-design.md`
- Modify: `docs/superpowers/plans/2026-07-24-repository-workspace-profiles.md`
- Modify only implementation files required by review findings.

- [x] Correct the design wording to reflect the existing dedicated Hermes OAuth chain: it is authenticated as Personal and is independent of provider-instance mappings.
- [x] Check every approved requirement against the implementation and mark all plan boxes accurately.
- [x] Scan changed files for placeholders with `rtk rg -n "TODO|FIXME|placeholder|not implemented" <changed-files>` and remove accidental incompleteness.
- [ ] Invoke `superpowers:requesting-code-review`, run the required reviewer, and fix all valid findings.
- [ ] Invoke `superpowers:verification-before-completion`.
- [ ] Run `rtk bun fmt`.
- [ ] Run `rtk bun lint`.
- [ ] Run `rtk bun typecheck`.
- [ ] Run `rtk bun run test`.
- [ ] Run `rtk git status --short`, inspect the final diff, and confirm no native mobile files changed (otherwise also run `rtk bun lint:mobile`).
- [ ] Commit any verification fixes and mark the goal complete only after every required check is green.
