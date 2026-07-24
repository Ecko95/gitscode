# Repository Profile Canonical Routing and Fallback Enforcement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Canonicalize Automode repository routing and require a server-validated, instance-specific acknowledgement before a first Work-to-Personal provider launch.

**Architecture:** Shared lexical path normalization supplies one canonical Automode goal root and normalized active-project matching. An optional acknowledgement travels from the public turn-start command into its domain event; the provider reactor validates it against server settings before starting a session and persists the existing fallback marker only after validation.

**Tech Stack:** TypeScript, Effect Schema/Effect, SQLite projection queries, React, Zustand, Vitest browser and node suites.

## Global Constraints

- Follow RED → GREEN → REFACTOR for each behavior; no production change before its failing test is observed.
- Use `rtk` for every shell command.
- Use `bun run test` through package scripts; never run `bun test`.
- Do not run the full test suite or `bun lint:mobile`.
- Preserve all existing provider pinning and routed-workflow safety behavior.
- Keep old command/event decoding compatible when the acknowledgement field is absent.

---

### Task 1: Canonical Automode Repository Routing

**Files:**
- Modify: `apps/server/src/gits/Layers/AutomodeSupervisor.test.ts`
- Modify: `apps/server/src/gits/Layers/AutomodeSupervisor.ts`
- Modify: `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.test.ts`
- Modify: `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts`
- Modify: `apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts`

**Interfaces:**
- Consumes: `normalizePath(value: string): string` from `@t3tools/shared/path`.
- Produces: canonical `AutomodeGoal.repo` values and canonical-equivalent `getActiveProjectByWorkspaceRoot(workspaceRoot)` matching.

- [ ] **Step 1: Write failing equivalent-path override tests**

Add one Personal override case and one Work override case whose goal and persisted project roots differ across trailing separators, slash styles, dot segments, and Windows case. Assert the canonical goal repo is persisted and passed to integration/spawn.

```ts
assert.equal(queued.goals[0]?.repo, "c:/work/repo");
assert.equal(spawnInput?.repo, "c:/work/repo");
assert.equal(spawnInput?.providerInstanceId, "codex_personal");
```

Add a projection-query test that persists `C:\\Work\\repo\\.\\` and looks it up as `c:/work/repo/`, expecting the active project.

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
rtk bun --filter t3 test -- src/gits/Layers/AutomodeSupervisor.test.ts src/orchestration/Layers/ProjectionSnapshotQuery.test.ts -t 'equivalent|canonical'
```

Expected: override tests route without the persisted override and/or projection lookup returns `Option.none()` because raw equality is still used.

- [ ] **Step 3: Implement minimal canonicalization**

Import `normalizePath` in Automode and store `repo: normalizePath(input.repo)` during enqueue. Normalize allowlist roots inside `repoAllowed` before containment checks. Reuse `listProjectRows`, filter active rows, and select the first row whose `normalizePath(row.workspaceRoot)` equals the normalized lookup. Update the service comment from “exact” to “canonical-equivalent”.

```ts
const normalizedRepo = normalizePath(repo);
return policy.allowedRepos.some((allowedRepo) => {
  const normalizedAllowed = normalizePath(allowedRepo);
  return normalizedRepo === normalizedAllowed ||
    normalizedRepo.startsWith(`${normalizedAllowed}/`);
});
```

- [ ] **Step 4: Run canonical routing tests and verify GREEN**

Run the Step 2 command and then the complete two affected files without `-t`.

---

### Task 2: Backward-Compatible Acknowledgement Contract Flow

**Files:**
- Modify: `packages/contracts/src/orchestration.test.ts`
- Modify: `packages/contracts/src/orchestration.ts`
- Modify: `apps/server/src/orchestration/decider.projectScripts.test.ts`
- Modify: `apps/server/src/orchestration/decider.ts`

**Interfaces:**
- Produces: optional `workPersonalFallbackAcknowledgedInstanceId?: ProviderInstanceId` on `ThreadTurnStartCommand`, `ClientThreadTurnStartCommand`, and `ThreadTurnStartRequestedPayload`.

- [ ] **Step 1: Write failing schema and decider tests**

Decode old command/event payloads without the field and assert success. Decode/decide a command with the field and assert the requested event preserves it exactly.

```ts
workPersonalFallbackAcknowledgedInstanceId: ProviderInstanceId.make("codex-personal")
```

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
rtk bun --filter '@t3tools/contracts' test -- src/orchestration.test.ts -t acknowledgement
rtk bun --filter t3 test -- src/orchestration/decider.projectScripts.test.ts -t acknowledgement
```

Expected: the new property is absent from decoded/decided output.

- [ ] **Step 3: Add the optional schemas and event copy**

Use `Schema.optional(ProviderInstanceId)` in both command schemas and the requested-event payload. In the decider, conditionally copy the property exactly as done for `modelSelection` and `titleSeed`.

- [ ] **Step 4: Run affected contract/decider files and verify GREEN**

Run both complete files without the name filter.

---

### Task 3: Enforce First Work-to-Personal Launch on the Server

**Files:**
- Modify: `apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts`
- Modify: `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`

**Interfaces:**
- Consumes: optional event `workPersonalFallbackAcknowledgedInstanceId` and existing `OrchestrationSession.workPersonalFallbackInstanceId`.
- Produces: validated route result `{ workPersonalFallbackInstanceId: ProviderInstanceId | null }` before `providerService.startSession`.

- [ ] **Step 1: Write failing reactor tests**

Add focused tests for:

- direct/older-client Personal fallback with no acknowledgement: actionable failure and zero provider starts;
- wrong-instance acknowledgement: failure and zero provider starts;
- exact Personal acknowledgement: one provider start and persisted fallback marker;
- configured Work instance: one provider start without acknowledgement and null marker;
- missing Work mapping plus exact configured Personal acknowledgement: one provider start and persisted marker;
- other mismatched instance: failure and zero provider starts;
- same-instance active session plus durable marker: subsequent turn succeeds without acknowledgement and does not restart.

- [ ] **Step 2: Run focused reactor tests and verify RED**

Run:

```bash
rtk bun --filter t3 test -- src/orchestration/Layers/ProviderCommandReactor.test.ts -t 'fallback acknowledgement|configured Work|durable marker'
```

Expected: unacknowledged/wrong/mismatched cases start a provider, and valid acknowledgement is not yet available to validation.

- [ ] **Step 3: Implement the server validation gate**

Thread the acknowledgement from `processTurnStartRequested` through `buildSendTurnRequestForThread` into `ensureSessionForThread`. Before any `startSession`, resolve effective project profile and Work/Personal mappings for Codex/Cursor. Return null marker for a configured Work instance; return the selected instance marker only for an exact configured Personal acknowledgement; reject missing/wrong acknowledgement and unrelated instances with `ProviderAdapterRequestError`. Preserve the durable marker bypass only when active session instance and marker both equal the selected instance.

```ts
if (selectedInstanceId === personalInstanceId) {
  if (acknowledgedInstanceId !== selectedInstanceId) {
    return yield* new ProviderAdapterRequestError({
      provider: driver,
      method: "thread.turn.start",
      detail: "Confirm the configured Personal account before starting this Work session.",
    });
  }
  return selectedInstanceId;
}
```

- [ ] **Step 4: Run the focused tests and full reactor file to verify GREEN**

Run the Step 2 command, then the complete reactor test file.

---

### Task 4: Send Acknowledgement Only After Chat Confirmation

**Files:**
- Modify: `apps/web/src/components/ChatView.browser.tsx`
- Modify: `apps/web/src/components/ChatView.tsx`

**Interfaces:**
- Consumes: existing `accountRoute.requiresWorkPersonalConfirmation` and instance-specific ephemeral confirmation state.
- Produces: optional `workPersonalFallbackAcknowledgedInstanceId` on the first `thread.turn.start` dispatch only after confirmation.

- [ ] **Step 1: Write failing browser tests**

Extend the successful Work-to-Personal launch test to assert the exact selected instance is present on the turn-start request. Keep/extend cancellation coverage to assert no turn-start request exists and the full draft remains unchanged.

- [ ] **Step 2: Run browser tests and verify RED**

Run:

```bash
rtk bun --filter '@t3tools/web' test:browser -- src/components/ChatView.browser.tsx -t 'Personal-account launch confirmation|Work-to-Personal acknowledgement'
```

Expected: successful launch request lacks the acknowledgement property; cancellation remains green.

- [ ] **Step 3: Add the conditional dispatch property**

Track a local boolean/instance value through the confirmation branch so the same callback invocation can include the acknowledgement immediately after confirmation. Include it only for the first message when the confirmed instance equals the selected instance.

```ts
...(acknowledgedFallbackInstanceId
  ? { workPersonalFallbackAcknowledgedInstanceId: acknowledgedFallbackInstanceId }
  : {})
```

- [ ] **Step 4: Run the focused browser tests and Chat logic tests to verify GREEN**

Run the Step 2 command and `src/components/ChatView.logic.test.ts`.

---

### Task 5: Consolidated Verification, Report, and Commit

**Files:**
- Modify: `.superpowers/sdd/final-fix-report.md` (ignored working report)

- [ ] **Step 1: Run focused affected suites**

Run complete affected contracts, Automode, projection query, decider, reactor, Chat browser, Chat logic, and store files. Do not run the full suite.

- [ ] **Step 2: Run mandatory gates**

```bash
rtk bun fmt
rtk bun lint
rtk bun typecheck
rtk git diff --check
```

Expected: all exit zero; lint may report the repository’s existing warnings but no errors.

- [ ] **Step 3: Self-review the production diff**

Verify provider start is unreachable before route validation, old payloads decode, canonical goal roots flow to every downstream operation, and no native mobile file changed.

- [ ] **Step 4: Commit and append the report**

Stage the verified changes, run `rtk git diff --cached --check`, commit with a focused message, and append the final SHA plus RED/GREEN and verification evidence to `.superpowers/sdd/final-fix-report.md`.
