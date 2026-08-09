# Cockpit Inbox and Quota-Aware Scheduling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make proposal approval queue and safely schedule work in one click, fail closed on unusable quota telemetry, and expose every work transition through a durable Cockpit Inbox.

**Architecture:** Add a schema-versioned atomic JSON Inbox keyed by proposal episode ID and record Inbox events at existing proposal, scheduler, and driver transition seams. Extend the existing scheduler with structured gate decisions and approval-authorized target-night scheduling; keep Automode goals authoritative for execution and route optional PWA/Telegram delivery from durable Inbox events.

**Tech Stack:** TypeScript, Effect, Effect Schema, React, TanStack Query, Vitest, existing WebSocket RPC, atomic JSON persistence, PWA push, and Hermes Telegram.

## Global Constraints

- Reuse proposal, Automode, scheduler, capacity monitor, push, Telegram, and deep-link components already present.
- Do not use notification delivery deduplication as the Inbox data model.
- Terminal Inbox items expire after 90 days; pinned and active items never expire.
- Missing, stale, errored, or over-threshold quota telemetry denies autonomous starts.
- Manual dispatch remains unchanged.
- Explicit or boot disarm clears approval-based automatic-arming authorization.
- No second scheduler, guessed quota reset, automatic merge, or new dependency.
- Run tests with `bun run test`, never `bun test`.
- Completion requires `bun fmt`, `bun lint`, and `bun typecheck`.

---

### Task 1: Shared Inbox and scheduler contracts

**Files:**

- Modify: `packages/contracts/src/gits.ts`
- Modify: `packages/contracts/src/rpc.ts`
- Modify: `packages/contracts/src/gits.test.ts`
- Modify: `packages/client-runtime/src/wsRpcClient.ts`

**Interfaces:**

- Produces `CockpitInboxState`, `CockpitInboxEvent`, `CockpitInboxItem`, list/filter/read/pin inputs, and RPC method names.
- Extends denied `GitsSchedulerGateResult` in the server service task with contract-backed category/retry metadata.
- Extends `AutomodeGoal` with nullable `planningNotes` and `planningBoundary` decoding defaults.

- [ ] **Step 1: Add failing schema tests**

Add tests that decode all nine Inbox states, reject unknown filters, default legacy goal planning fields to null, and derive unread from `readAt < updatedAt` in a small exported helper:

```ts
expect(decodeInboxItem({ ...baseItem, state: "waiting-quota-reset" }).state).toBe(
  "waiting-quota-reset",
);
expect(decodeGoal(baseLegacyGoal).planningNotes).toBeNull();
expect(isCockpitInboxItemUnread({ ...baseItem, readAt: null })).toBe(true);
```

- [ ] **Step 2: Verify RED**

Run: `bun run test packages/contracts/src/gits.test.ts`

Expected: FAIL because the Inbox schemas and legacy goal fields do not exist.

- [ ] **Step 3: Add minimal contracts and client methods**

Define the exact state/filter schemas and RPC inputs:

```ts
export const CockpitInboxState = Schema.Literals([
  "pending-review",
  "approved-queued",
  "waiting-quota-reset",
  "scheduled-tonight",
  "running",
  "attention-required",
  "completed",
  "rejected",
  "deferred",
]);
export const CockpitInboxFilter = Schema.Literals([
  "unread",
  "pending",
  "approved",
  "waiting",
  "completed",
]);
export const CockpitInboxListInput = Schema.Struct({
  filter: Schema.optional(CockpitInboxFilter),
});
export const CockpitInboxMarkReadInput = Schema.Struct({ id: TrimmedNonEmptyString });
export const CockpitInboxPinInput = Schema.Struct({
  id: TrimmedNonEmptyString,
  pinned: Schema.Boolean,
});
```

Add `gits.cockpit.inbox.list`, `.markRead`, `.markAllRead`, and `.pin` to `WS_METHODS`, and expose matching unary methods from `wsRpcClient`.

- [ ] **Step 4: Verify GREEN**

Run: `bun run test packages/contracts/src/gits.test.ts packages/client-runtime/src/wsRpcClient.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/gits.ts packages/contracts/src/rpc.ts packages/contracts/src/gits.test.ts packages/client-runtime/src/wsRpcClient.ts
git commit -m "feat(gits): add cockpit inbox contracts"
```

### Task 2: Durable Cockpit Inbox service

**Files:**

- Create: `apps/server/src/gits/Services/CockpitInbox.ts`
- Create: `apps/server/src/gits/Layers/CockpitInbox.ts`
- Create: `apps/server/src/gits/Layers/CockpitInbox.test.ts`
- Modify: `apps/server/src/server.ts`
- Modify: `apps/server/src/ws.ts`

**Interfaces:**

- Consumes the Task 1 contracts.
- Produces `record(input)`, `list(input)`, `markRead(id)`, `markAllRead(filter)`, and `setPinned(id, pinned)`.
- `record` returns `{ item, event, created }`; duplicate event keys return `created: false`.

- [ ] **Step 1: Write failing persistence tests**

Cover event-key idempotency, a new event making an item unread, filter membership, read/pin mutations, 90-day pruning, pinned exemption, active exemption, restart loading, and corrupt-file write refusal:

```ts
yield * inbox.record(pendingEvent);
yield * inbox.record(pendingEvent);
assert.equal((yield * inbox.list({})).items[0]?.timeline.length, 1);
assert.equal((yield * inbox.setPinned("epi-1", true)).pinned, true);
```

- [ ] **Step 2: Verify RED**

Run: `bun run test apps/server/src/gits/Layers/CockpitInbox.test.ts`

Expected: FAIL because the service does not exist.

- [ ] **Step 3: Implement the atomic store and RPC wiring**

Use `Ref`, one `Semaphore`, `writeFileStringAtomically`, and `<stateDir>/gits/cockpit-inbox.json`. Prune only terminal, unpinned items whose `terminalAt` is older than 90 days. Keep unread derived:

```ts
export const isCockpitInboxItemUnread = (item: CockpitInboxItem) =>
  item.readAt === null || Date.parse(item.readAt) < Date.parse(item.updatedAt);
```

Decode failure must retain a load error in the service and reject writes instead of replacing the file. Wire all four RPCs in `ws.ts` and provide the live layer from `server.ts`.

- [ ] **Step 4: Verify GREEN**

Run: `bun run test apps/server/src/gits/Layers/CockpitInbox.test.ts apps/server/src/server.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/gits/Services/CockpitInbox.ts apps/server/src/gits/Layers/CockpitInbox.ts apps/server/src/gits/Layers/CockpitInbox.test.ts apps/server/src/server.ts apps/server/src/ws.ts
git commit -m "feat(gits): persist cockpit inbox events"
```

### Task 3: Fail-closed structured quota gates

**Files:**

- Modify: `apps/server/src/gits/Services/GitsSlotScheduler.ts`
- Modify: `apps/server/src/gits/Layers/GitsSlotScheduler.ts`
- Modify: `apps/server/src/gits/Layers/GitsSlotScheduler.test.ts`
- Modify: `packages/contracts/src/gits.ts`

**Interfaces:**

- Produces denied gate results shaped as `{ allowed: false, category, reason, retryAt }`.
- Produces `scheduleApprovedGoal({ eligibleAt })` and persists approval-based automatic-arming authorization.

- [ ] **Step 1: Replace fail-open tests with failing fail-closed cases**

Add cases for absent windows, null usage, null reset, expired reset, monitor error, five-hour threshold, weekly threshold, both thresholds choosing the later reset, future target night, and explicit/boot disarm clearing automatic authorization:

```ts
assert.deepEqual(result, {
  allowed: false,
  category: "quota",
  reason: "Codex quota telemetry is missing or stale",
  retryAt: null,
});
```

- [ ] **Step 2: Verify RED**

Run: `bun run test apps/server/src/gits/Layers/GitsSlotScheduler.test.ts`

Expected: FAIL on the current fail-open results and absent scheduling operation.

- [ ] **Step 3: Implement minimal structured decisions**

Require both windows to have numeric `usedPercent` and `resetAt > now`. Return the latest reset among all over-threshold windows. Add scheduler state `automaticArmingAuthorized` with a decoding default of false. `scheduleApprovedGoal` sets it true, enables config, and selects the first autonomy night on or after `eligibleAt`; explicit and boot disarm set it false.

- [ ] **Step 4: Verify GREEN**

Run: `bun run test apps/server/src/gits/Layers/GitsSlotScheduler.test.ts packages/contracts/src/gits.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/gits/Services/GitsSlotScheduler.ts apps/server/src/gits/Layers/GitsSlotScheduler.ts apps/server/src/gits/Layers/GitsSlotScheduler.test.ts packages/contracts/src/gits.ts
git commit -m "feat(gits): fail closed on stale quota telemetry"
```

### Task 4: Inbox-first notification routing

**Files:**

- Modify: `apps/server/src/gits/Layers/AutomodeNotifications.ts`
- Modify: `apps/server/src/gits/Layers/AutomodeNotifications.test.ts`
- Modify: `apps/server/src/gits/Layers/AutomodeProposalSweep.ts`
- Modify: `apps/server/src/gits/Layers/AutomodeProposalSweep.test.ts`

**Interfaces:**

- Consumes `CockpitInbox.record` and its durable event key.
- External delivery runs only after a durable event exists; duplicate records may retry a previously failed channel without adding timeline entries.

- [ ] **Step 1: Write failing inbox-first routing tests**

Assert proposal persistence precedes Inbox recording, Inbox failure prevents push/Telegram, successful channel keys deduplicate, and failed channels remain retryable.

- [ ] **Step 2: Verify RED**

Run: `bun run test apps/server/src/gits/Layers/AutomodeNotifications.test.ts apps/server/src/gits/Layers/AutomodeProposalSweep.test.ts`

Expected: FAIL because notification sites bypass the Inbox.

- [ ] **Step 3: Route proposal notifications through Inbox events**

Keep `AutomodeNotifications` as the channel dispatcher. Use the Inbox event key as its key and call it only after `record`. Do not copy prompt/evidence into channel bodies.

- [ ] **Step 4: Verify GREEN**

Run the same command; expected PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/gits/Layers/AutomodeNotifications.ts apps/server/src/gits/Layers/AutomodeNotifications.test.ts apps/server/src/gits/Layers/AutomodeProposalSweep.ts apps/server/src/gits/Layers/AutomodeProposalSweep.test.ts
git commit -m "feat(gits): route proposal alerts through inbox"
```

### Task 5: One-click approval, queueing, and arming

**Files:**

- Modify: `apps/server/src/gits/Layers/HermesAutomodeBridge.ts`
- Modify: `apps/server/src/gits/Layers/HermesAutomodeBridge.test.ts`
- Modify: `apps/server/src/ws.ts`
- Modify: `apps/web/src/components/gits/GitsCockpit.tsx`

**Interfaces:**

- Consumes `GitsSlotScheduler.scheduleApprovedGoal` and `CockpitInbox.record`.
- Approval remains idempotent by episode and retries queue/arm/Inbox work after partial failure.

- [ ] **Step 1: Write failing bridge tests**

Cover one goal, enabled scheduler, resolved target night, approval/scheduled Inbox events, future `notBefore`, and retry after scheduler or Inbox failure without duplicate goals.

- [ ] **Step 2: Verify RED**

Run: `bun run test apps/server/src/gits/Layers/HermesAutomodeBridge.test.ts`

Expected: FAIL because approval does not schedule or record Inbox state.

- [ ] **Step 3: Extend the bridge with durable idempotent steps**

Pass scheduler and Inbox dependencies into `decideProposalWithAutomodeBridge`. After enqueue/dedup, call:

```ts
yield * scheduler.scheduleApprovedGoal({ eligibleAt: decided.notBefore });
yield * inbox.record(approvedEvent);
```

Record `scheduled-tonight` only when the target equals the current autonomy night. Preserve validation and all existing execution safeguards.

- [ ] **Step 4: Verify GREEN**

Run: `bun run test apps/server/src/gits/Layers/HermesAutomodeBridge.test.ts apps/server/src/server.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/gits/Layers/HermesAutomodeBridge.ts apps/server/src/gits/Layers/HermesAutomodeBridge.test.ts apps/server/src/ws.ts apps/web/src/components/gits/GitsCockpit.tsx
git commit -m "feat(gits): arm approved proposals in one click"
```

### Task 6: Quota waiting, plan refinement, and driver projections

**Files:**

- Modify: `apps/server/src/gits/Services/HermesAdapter.ts`
- Modify: `apps/server/src/gits/Layers/HermesCliAdapter.ts`
- Modify: `apps/server/src/gits/Layers/HermesCliAdapter.test.ts`
- Modify: `apps/server/src/gits/Services/AutomodeSupervisor.ts`
- Modify: `apps/server/src/gits/Layers/AutomodeSupervisor.ts`
- Modify: `apps/server/src/gits/Layers/AutomodeDriver.ts`
- Modify: `apps/server/src/gits/Layers/AutomodeDriver.test.ts`

**Interfaces:**

- Produces observe-only `refinePlan({ title, prompt, repo })` on `HermesAdapter`.
- Produces `deferGoal({ goalId, notBefore, planningNotes, planningBoundary })` on `AutomodeSupervisor`.
- Driver records waiting/running/attention/completed events and retargets only while automatic arming remains authorized.

- [ ] **Step 1: Write failing adapter, supervisor, and driver tests**

Prove one plan refinement per `(goalId, retryAt)`, no Delamain dispatch while denied, later reset persistence, fresh-gate recheck, safe continuation after plan failure, and deduplicated Inbox transitions for every requested live state.

- [ ] **Step 2: Verify RED**

Run: `bun run test apps/server/src/gits/Layers/HermesCliAdapter.test.ts apps/server/src/gits/Layers/AutomodeSupervisor.test.ts apps/server/src/gits/Layers/AutomodeDriver.test.ts`

Expected: FAIL because refinement/defer operations and Inbox projections are absent.

- [ ] **Step 3: Implement the observe-only refinement and wait flow**

Invoke Hermes chat with a fixed prompt that forbids worktrees, writes, shell, and implementation. On quota denial with `retryAt`, persist `notBefore`, plan fields, and retarget the approved night. On missing/stale data, record the wait without plan refinement. On insufficient runway, refine once using a boundary derived from the next eligible slot. Plan failure leaves the original prompt and queue intact.

- [ ] **Step 4: Verify GREEN**

Run the same command; expected PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/gits/Services/HermesAdapter.ts apps/server/src/gits/Layers/HermesCliAdapter.ts apps/server/src/gits/Layers/HermesCliAdapter.test.ts apps/server/src/gits/Services/AutomodeSupervisor.ts apps/server/src/gits/Layers/AutomodeSupervisor.ts apps/server/src/gits/Layers/AutomodeDriver.ts apps/server/src/gits/Layers/AutomodeDriver.test.ts
git commit -m "feat(gits): defer automode work to quota resets"
```

### Task 7: Cockpit Inbox UI

**Files:**

- Create: `apps/web/src/components/gits/cockpit/inbox/inbox.logic.ts`
- Create: `apps/web/src/components/gits/cockpit/inbox/inbox.logic.test.ts`
- Create: `apps/web/src/components/gits/cockpit/InboxSection.tsx`
- Modify: `apps/web/src/components/gits/GitsCockpit.tsx`
- Modify: `apps/web/src/components/gits/cockpit/AutopilotPanel.tsx`

**Interfaces:**

- Consumes Inbox list/read/pin RPCs.
- Produces the five filters, counts, current-state rows, timeline detail, unread behavior, pin action, and existing proposal/goal deep-link navigation.

- [ ] **Step 1: Write failing pure-logic tests**

Test filter labels/order, state tone/label mapping, timestamp ordering, unread derivation, and proposal-vs-goal deep-link choice.

- [ ] **Step 2: Verify RED**

Run: `bun run test apps/web/src/components/gits/cockpit/inbox/inbox.logic.test.ts`

Expected: FAIL because Inbox logic does not exist.

- [ ] **Step 3: Build the minimal accessible Inbox section**

Reuse cockpit primitives and buttons. Render filter buttons with counts, semantic unread text, item state/reason/time, a pin toggle with an accessible label, and an expandable ordered timeline. Opening marks read and navigates through the stored deep link; do not add another editor.

- [ ] **Step 4: Verify GREEN**

Run: `bun run test apps/web/src/components/gits/cockpit/inbox/inbox.logic.test.ts apps/web/src/components/gits/cockpit/autopilot/autopilot.logic.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/gits/cockpit/inbox apps/web/src/components/gits/cockpit/InboxSection.tsx apps/web/src/components/gits/GitsCockpit.tsx apps/web/src/components/gits/cockpit/AutopilotPanel.tsx
git commit -m "feat(web): add durable cockpit inbox"
```

### Task 8: Integration and repository verification

**Files:**

- Modify: `apps/server/src/server.test.ts`
- Modify: `apps/server/src/server.ts`
- Modify: `apps/server/src/ws.ts`
- Modify: `docs/gits/WEB_PUSH_PWA.md`

**Interfaces:**

- Verifies proposal creation → Inbox event → optional delivery → approval → one goal → automatic target night → quota wait → reset eligibility.

- [ ] **Step 1: Write the failing server integration test**

Use the existing server harness to assert durable Inbox events and one queued goal across the full path, including no dispatch on stale telemetry and `notBefore` equal to the limiting reset.

- [ ] **Step 2: Verify RED**

Run: `bun run test apps/server/src/server.test.ts`

Expected: FAIL only at missing final wiring.

- [ ] **Step 3: Complete composition and update operator docs**

Provide `CockpitInboxLive` to the driver and WS layers in `server.ts`, and pass the scheduler and Inbox services into the approval bridge in `ws.ts`. Document Inbox retention/pinning, channel prerequisites, one-click scheduling, fail-closed telemetry, known-reset waits, and boot/manual disarm behavior in `WEB_PUSH_PWA.md`.

- [ ] **Step 4: Run focused and repository checks**

Run all modified test files with `bun run test`, then:

```bash
bun fmt
bun lint
bun typecheck
git diff --check
```

Expected: every command exits 0; lint may report existing warnings but no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/server.test.ts apps/server/src/server.ts apps/server/src/ws.ts docs/gits/WEB_PUSH_PWA.md
git add -u
git commit -m "docs(gits): document cockpit inbox scheduling"
```
