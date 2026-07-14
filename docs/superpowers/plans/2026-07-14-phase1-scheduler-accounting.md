# Phase 1 Scheduler Accounting — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:test-driven-development` and `superpowers:verification-before-completion`. This is intentionally one narrowly scoped task; do not add scheduler APIs or change the disabled-scheduler bypass.

**Goal:** Ensure an autonomous Delamain peer cannot start unless its nightly scheduler slot has been durably recorded. A persistence error must leave the goal queued, halt the driver, and spawn no peer.

**Architecture:** Keep the existing `checkStartAllowed` gate. For non-bypassed gates, call the existing `recordGoalStart` immediately after the gate allows the goal and before `AutomodeSupervisor.dispatchGoal`. A dispatch failure keeps the recorded reservation, which is conservative and preserves the nightly cap under partial failures. The disabled-scheduler bypass remains unchanged.

**Files:**

| File | Change |
| --- | --- |
| `apps/server/src/gits/Layers/AutomodeDriver.test.ts` | Instrument the Delamain mock and extend the existing `recordGoalStart` failure test to prove `spawnPeer` was never called. |
| `apps/server/src/gits/Layers/AutomodeDriver.ts` | Move the existing scheduler recording and fail-closed halt before peer dispatch. |

## Task 1: Record the slot before dispatch

- [ ] **Step 1: Write the failing regression test.** Add an `onSpawnPeer` hook to the local Delamain test mock. In the existing scheduler-recording failure test, count calls and assert that the driver is halted, the goal remains queued, and the spawn count is zero.

  Run from `apps/server`:

  ```bash
  GITS_REAL_GIT=/usr/bin/git bun run test -- src/gits/Layers/AutomodeDriver.test.ts
  ```

  Expected before implementation: the new zero-spawn assertion fails because the current driver dispatches first.

- [ ] **Step 2: Apply the minimal driver reorder.** After an allowed, non-bypassed gate, call `scheduler.recordGoalStart`. If it fails, halt the driver with the existing reason and return. Only then call `supervisor.dispatchGoal`. Do not introduce a reserve/release API; an unsuccessful dispatch keeps the reservation deliberately so a persistence or process failure cannot exceed the cap.

- [ ] **Step 3: Verify the focused behavior.** Re-run the Step 1 command; it must pass. Then run the directly affected suites:

  ```bash
  GITS_REAL_GIT=/usr/bin/git bun run test -- src/gits/Layers/AutomodeDriver.test.ts src/gits/Layers/AutomodeSupervisor.test.ts src/gits/Layers/GitsSlotScheduler.test.ts
  ```

- [ ] **Step 4: Run repository gates.** Run `bun fmt --check` for the two changed files, then `bun lint` and `bun typecheck` from the repository root. If the whole-worktree formatter is blocked only by pre-existing user files, report that separately and leave those files untouched.

- [ ] **Step 5: Review the diff.** Confirm the bypass path remains dispatch-only, the recording failure path cannot reach `dispatchGoal`, and no unrelated Phase 1 or user-owned files changed.
