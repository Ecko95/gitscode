# Cockpit Proposal Notifications and Approval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver Motoko proposals from repository inspection or unfinished past threads through independently configurable PWA/Telegram notifications into an editable, deep-linked cockpit review flow and the guarded Automode schedule.

**Architecture:** Extend the existing proposal and Automode schemas rather than adding another store. A small notification dispatcher routes stable transition keys through the existing push and Telegram services, while the proposal bridge atomically applies review edits and enqueues one goal with a not-before time consumed by the existing driver/scheduler gate.

**Tech Stack:** TypeScript, Effect, Effect Schema, React, TanStack Query, Vitest, existing Web Push service worker and Hermes Telegram CLI.

## Global Constraints

- Reuse `HermesProposalCard`, `HermesAutomodeBridge`, `GitsSlotScheduler`, `PushNotificationService`, and `HermesTelegramNotifier`.
- PWA and Telegram toggles are independent; defaults are PWA on and Telegram off.
- Approval never bypasses kill switch, arming, capacity, verification, integration-branch, or held-PR safeguards.
- Notification delivery failures are non-fatal and notification bodies exclude full prompts and sensitive evidence.
- Do not modify the user's existing browser-preview changes.
- Run `bun fmt`, `bun lint`, and `bun typecheck`; run tests with `bun run test`, never `bun test`.

---

### Task 1: Proposal execution data and notification preferences

**Files:**

- Modify: `packages/contracts/src/gits.ts`
- Modify: `packages/contracts/src/rpc.ts`
- Modify: `packages/contracts/src/automode-policy-fields.test.ts`
- Modify: `packages/contracts/src/gits.test.ts`
- Modify: `apps/server/src/gits/Layers/HermesCliAdapter.ts`
- Modify: `apps/server/src/gits/Layers/HermesCliAdapter.test.ts`

**Interfaces:**

- Produces policy fields `gitsNotificationsEnabled: boolean` and `telegramNotificationsEnabled: boolean`.
- Produces proposal fields `model`, `notBefore`, `maxRuntimeMinutes`, `verificationCommands`, `integrationBranch`, and `sourceThreadId`, all nullable/defaulted for legacy JSON records.
- Produces `HermesProposalReviewInput` for atomic edit plus approve/defer/reject.

- [ ] Write schema tests proving legacy policy defaults to `{ gitsNotificationsEnabled: true, telegramNotificationsEnabled: false }` and legacy proposals normalize every new field to `null` or `[]`.
- [ ] Run `bun run test packages/contracts/src/automode-policy-fields.test.ts packages/contracts/src/gits.test.ts` and confirm the new assertions fail because the fields are absent.
- [ ] Add the decoding defaults, review input schema, and RPC contract. Keep `telegramDigestEnabled` decoding for compatibility but derive/migrate its behavior into `telegramNotificationsEnabled`.
- [ ] Add adapter tests showing review edits are validated and persisted before the decision status changes.
- [ ] Run `bun run test packages/contracts/src/automode-policy-fields.test.ts packages/contracts/src/gits.test.ts apps/server/src/gits/Layers/HermesCliAdapter.test.ts` and confirm they pass.
- [ ] Commit with `git commit -m "feat(gits): add editable proposal execution settings"`.

### Task 2: Channel-routed transition notifications

**Files:**

- Create: `apps/server/src/gits/Services/AutomodeNotificationDispatcher.ts`
- Create: `apps/server/src/gits/Layers/AutomodeNotificationDispatcher.ts`
- Create: `apps/server/src/gits/Layers/AutomodeNotificationDispatcher.test.ts`
- Modify: `apps/server/src/gits/Layers/AutomodeProposalSweep.ts`
- Modify: `apps/server/src/gits/Layers/AutomodeDriver.ts`
- Modify: `apps/server/src/server.ts`

**Interfaces:**

- Produces `notify({ key, subject, text, url, policy }): Effect<void>`.
- Persists delivered channel keys in `<stateDir>/gits/automode-notifications-state.json`.
- Uses `/gits?panel=autopilot&proposal=<id>` for proposal events and `/gits?panel=autopilot&section=<name>` for Automode events.

- [ ] Write dispatcher tests proving PWA-only, Telegram-only, both, neither, persisted deduplication, and non-fatal channel failures.
- [ ] Run `bun run test apps/server/src/gits/Layers/AutomodeNotificationDispatcher.test.ts` and confirm failure because the dispatcher does not exist.
- [ ] Implement the dispatcher with `Ref`, `Semaphore`, atomic JSON persistence, `PushNotificationService.sendToAll`, and `HermesTelegramNotifier.notify`.
- [ ] Replace direct sweep Telegram calls with dispatcher calls for created/sent proposals and no-goal sweep attention.
- [ ] Add driver calls only at the existing transition points for queued approval, blocked/failed/waiting goals, driver halt, and held-PR creation. Stable keys include proposal/goal/PR identifiers.
- [ ] Run the dispatcher, sweep, and driver suites and confirm all pass.
- [ ] Commit with `git commit -m "feat(gits): route automode attention notifications"`.

### Task 3: Atomic edited approval and not-before scheduling

**Files:**

- Modify: `apps/server/src/gits/Layers/HermesAutomodeBridge.ts`
- Modify: `apps/server/src/gits/Layers/HermesAutomodeBridge.test.ts`
- Modify: `apps/server/src/gits/Layers/AutomodeSupervisor.ts`
- Modify: `apps/server/src/gits/Layers/AutomodeSupervisor.test.ts`
- Modify: `apps/server/src/gits/Layers/AutomodeDriver.ts`
- Modify: `apps/server/src/gits/Layers/AutomodeDriver.test.ts`
- Modify: `apps/server/src/ws.ts`
- Modify: `packages/client-runtime/src/wsRpcClient.ts`

**Interfaces:**

- `reviewProposal(input: HermesProposalReviewInput)` persists edits and returns the decided card.
- `AutomodeGoal.notBefore` is nullable and legacy-defaulted.
- The bridge copies edited values into the goal and retains episode-ID idempotency.

- [ ] Write bridge tests proving edited title/prompt/repo/model/settings reach exactly one goal and re-approval does not duplicate it.
- [ ] Write a driver test proving a queued goal stays queued before `notBefore`, then dispatches after it while still passing through `GitsSlotScheduler.checkStartAllowed`.
- [ ] Run both focused suites and confirm the assertions fail for missing edit propagation/not-before behavior.
- [ ] Implement the review RPC, goal fields, bridge propagation, and the one-line driver eligibility filter before dispatch.
- [ ] Run bridge, supervisor, driver, WS, contract, and client-runtime suites and confirm they pass.
- [ ] Commit with `git commit -m "feat(gits): schedule edited approved proposals"`.

### Task 4: Deep-linked cockpit review

**Files:**

- Modify: `apps/web/src/components/gits/GitsCockpit.tsx`
- Modify: `apps/web/src/components/gits/cockpit/AutopilotPanel.tsx`
- Modify: `apps/web/src/components/gits/cockpit/MotokoPanel.tsx`
- Create: `apps/web/src/components/gits/cockpit/proposalReview.logic.ts`
- Create: `apps/web/src/components/gits/cockpit/proposalReview.logic.test.ts`
- Modify: `apps/web/src/components/gits/cockpit/autopilot/autopilot.logic.test.ts`

**Interfaces:**

- `parseProposalReviewTarget(search: string)` returns `{ panel, proposalId, section }` with invalid values ignored.
- Autopilot receives proposals and review mutation callbacks from `GitsCockpit`.

- [ ] Write logic tests for proposal/section deep links and editable form normalization.
- [ ] Run the focused web tests and confirm failure because parsing/form helpers are absent.
- [ ] Add independent GITS/PWA and Telegram policy toggles to Autopilot.
- [ ] Reuse the existing proposal card UI inside an Autopilot proposal review sheet; primary fields are title/prompt and Advanced contains repo/model/not-before/runtime/verification/integration.
- [ ] On load, parse the query, select Autopilot, open the sheet, focus the proposal, and remove only the consumed query parameters after the user closes it.
- [ ] Wire Approve, Defer, and Reject through the atomic review RPC and refresh proposal/Automode/scheduler queries.
- [ ] Run focused cockpit tests and the web test suite; confirm they pass.
- [ ] Commit with `git commit -m "feat(web): add deep-linked proposal review"`.

### Task 5: Past-thread continuation proposals

**Files:**

- Create: `apps/server/src/gits/Services/MotokoContinuationSource.ts`
- Create: `apps/server/src/gits/Layers/MotokoContinuationSource.ts`
- Create: `apps/server/src/gits/Layers/MotokoContinuationSource.test.ts`
- Modify: `apps/server/src/gits/Layers/AutomodeProposalSweep.ts`
- Modify: `apps/server/src/gits/Layers/AutomodeProposalSweep.test.ts`

**Interfaces:**

- `listCandidates()` returns bounded persisted thread summaries containing `threadId`, `projectPath`, `title`, and `summary`.
- The sweep passes candidates to `inspectGitsAndPropose`; created cards set `sourceThreadId` and cite unfinished evidence.

- [ ] Write tests proving only non-running threads with a project path and a non-empty persisted summary become candidates, capped to the five most recent per repository.
- [ ] Write a sweep test proving a continuation candidate creates the same actionable card/goal shape and notification deep link as a repository-pattern proposal.
- [ ] Run both focused suites and confirm the new expectations fail.
- [ ] Implement the read-only projection query and fold candidate summaries into the existing sequential sweep prompt. Do not copy raw transcripts.
- [ ] Run the continuation and sweep suites and confirm they pass.
- [ ] Commit with `git commit -m "feat(gits): propose unfinished thread continuations"`.

### Task 6: End-to-end verification and deployment readiness

**Files:**

- Modify: `apps/server/src/server.test.ts`
- Modify: `docs/gits/WEB_PUSH_PWA.md`

- [ ] Add one server integration test: create proposal → route PWA notification → review with edits → approve → observe one queued not-before goal.
- [ ] Run the test and confirm it fails before the final wiring is complete.
- [ ] Complete only the missing layer/RPC wiring required by that test, then rerun it to green.
- [ ] Run focused tests for every modified package with `bun run test`.
- [ ] Run `bun fmt`, `bun lint`, and `bun typecheck`; fix all failures and rerun until each exits 0.
- [ ] Update `docs/gits/WEB_PUSH_PWA.md` with VAPID requirements, both cockpit toggles, notification event types, and proposal deep-link behavior.
- [ ] Review `git diff --check`, verify unrelated browser-preview changes remain untouched, and commit with `git commit -m "docs(gits): document proposal notifications"`.
