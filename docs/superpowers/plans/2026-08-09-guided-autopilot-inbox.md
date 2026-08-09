# Guided Inbox-First Autopilot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the configuration-heavy Autopilot cockpit with a guided Inbox-first proposal launch flow and add current-device Android PWA notification diagnostics.

**Architecture:** Keep the existing proposal bridge, durable Inbox, Automode Goal store, scheduler, and push sender as the deep execution module. Add one narrow Autopilot control operation, a three-step proposal launch sheet that submits the existing proposal decision contract, and a fixed authenticated push-test route that can target only an already registered subscription.

**Tech Stack:** TypeScript, React 19, TanStack Query, Effect 4, Effect Schema/RPC, Vitest, `@effect/vitest`, Web Push, service workers, Base UI controls, Bun workspaces.

## Global Constraints

- Keep proposal choices, especially model selection, but make Model the only prominent run choice.
- Put repository override, start time, runtime, verification commands, and integration branch under Advanced details.
- A PWA notification opens review; it never mutates proposal or queue state itself.
- Acceptance creates exactly one live Goal and reports queued state, not started state.
- Test notifications target only the requesting browser's registered endpoint and cannot create Proposals, Inbox Items, Goals, scheduler state, or production delivery keys.
- Pause blocks new proposals and future starts without killing running work; Emergency Stop also kills running autonomous work.
- Preserve isolated branches, verification, held-PR review, quota/runtime gates, boot disarm, and Inbox retention.
- Terminal Inbox items are pruned after 90 days; pinned items and active items are never pruned.
- Add no dependencies and no new persistence store.
- Never run `bun test`; use `bun run test`.
- Before completion, `bun fmt`, `bun lint`, and `bun typecheck` must pass.

---

## File Map

- `packages/contracts/src/gits.ts`: narrow Autopilot configure input/result schemas.
- `packages/contracts/src/push.ts`: fixed push-test request/result schemas.
- `packages/contracts/src/rpc.ts`: Autopilot configure RPC registration.
- `packages/contracts/src/gits.test.ts`, `packages/contracts/src/push.test.ts`: schema coverage.
- `packages/client-runtime/src/wsRpcClient.ts`: typed `automode.configure` client method.
- `apps/server/src/gits/Layers/AutopilotControl.ts`: fail-closed On/Pause/Emergency Stop orchestration.
- `apps/server/src/gits/Layers/AutopilotControl.test.ts`: control semantics.
- `apps/server/src/gits/Layers/HermesAutomodeBridge.ts`: acceptance recovery projection.
- `apps/server/src/gits/Layers/HermesAutomodeBridge.test.ts`: partial-failure and retry coverage.
- `apps/server/src/push/Services/PushNotificationService.ts`: targeted delivery interface.
- `apps/server/src/push/Layers/PushNotificationService.ts`: registered-endpoint delivery.
- `apps/server/src/push/Layers/PushNotificationService.test.ts`: targeting and failure results.
- `apps/server/src/push/http.ts`: authenticated fixed test route.
- `apps/server/src/push/http.test.ts`: route security and payload coverage.
- `apps/server/src/server.ts`: push-test route registration.
- `apps/server/src/ws.ts`: Autopilot configure and stop handler wiring.
- `apps/server/src/server.test.ts`: RPC/route registration smoke coverage.
- `apps/web/src/lib/webPush.ts`: current-subscription diagnostics and test request helpers.
- `apps/web/src/lib/webPush.test.ts`: prerequisite and request behavior.
- `apps/web/src/service-worker.ts`: keep notification click routing generic and test it.
- `apps/web/src/components/settings/SettingsPanels.tsx`: PWA diagnostics UI.
- `apps/web/src/components/settings/SettingsPanels.browser.tsx`: diagnostics interaction coverage.
- `apps/web/src/components/gits/cockpit/proposal-launch/proposalLaunch.logic.ts`: launch defaults, model options, validation, edits.
- `apps/web/src/components/gits/cockpit/proposal-launch/proposalLaunch.logic.test.ts`: pure launch logic.
- `apps/web/src/components/gits/cockpit/ProposalLaunchSheet.tsx`: three-step real/test launch sheet.
- `apps/web/src/components/gits/cockpit/ProposalLaunchSheet.browser.tsx`: guided interaction coverage.
- `apps/web/src/components/gits/cockpit/AutopilotPanel.tsx`: simplified status/Inbox/queue surface.
- `apps/web/src/components/gits/cockpit/AutopilotPanel.browser.tsx`: reduced-surface coverage.
- `apps/web/src/components/gits/GitsCockpit.tsx`: remove obsolete form state/mutations and refresh all acceptance projections.
- `apps/web/src/components/gits/cockpit/autopilot/autopilot.logic.ts`: delete obsolete global policy-form logic.
- `apps/web/src/components/gits/cockpit/autopilot/autopilot.logic.test.ts`: delete obsolete tests.

---

### Task 1: Add Narrow Contracts and Client Method

**Files:**
- Modify: `packages/contracts/src/gits.ts`
- Modify: `packages/contracts/src/push.ts`
- Modify: `packages/contracts/src/rpc.ts`
- Modify: `packages/contracts/src/gits.test.ts`
- Create: `packages/contracts/src/push.test.ts`
- Modify: `packages/client-runtime/src/wsRpcClient.ts`

**Interfaces:**
- Produces: `AutopilotConfigureInput`, `AutopilotControlSnapshot`, `WebPushTestKind`, `WebPushTestInput`, `WebPushTestResult`, and `WsGitsAutomodeConfigureRpc`.
- Produces client call: `client.gits.automode.configure(input)`.

- [ ] **Step 1: Write failing contract tests**

Add schema assertions equivalent to:

```ts
const configure = Schema.decodeUnknownSync(AutopilotConfigureInput);
expect(configure({ enabled: true, repositories: ["/srv/repo"] })).toEqual({
  enabled: true,
  repositories: ["/srv/repo"],
});
expect(() => configure({ enabled: true, repositories: [] })).not.toThrow();

const pushTest = Schema.decodeUnknownSync(WebPushTestInput);
expect(pushTest({ endpoint: "https://push.example/device", kind: "proposal" })).toEqual({
  endpoint: "https://push.example/device",
  kind: "proposal",
});
expect(() => pushTest({ endpoint: "https://push.example/device", kind: "custom" })).toThrow();
```

- [ ] **Step 2: Run the tests and verify they fail on missing exports**

Run: `bun run test packages/contracts/src/gits.test.ts packages/contracts/src/push.test.ts`

Expected: FAIL because the new schemas do not exist.

- [ ] **Step 3: Add the schemas and RPC**

Use these exact public shapes:

```ts
export const AutopilotConfigureInput = Schema.Struct({
  enabled: Schema.Boolean,
  repositories: Schema.Array(PathString),
});

export const AutopilotControlSnapshot = Schema.Struct({
  automode: AutomodeSnapshot,
  scheduler: GitsSchedulerSnapshot,
});

export const WebPushTestKind = Schema.Literals(["delivery", "proposal"]);
export const WebPushTestInput = Schema.Struct({
  endpoint: PushEndpoint,
  kind: WebPushTestKind,
});
export const WebPushTestResult = Schema.Struct({
  accepted: Schema.Literal(true),
  url: TrimmedNonEmptyString,
});
```

Register `gits.automode.configure` with `AutopilotConfigureInput`, `AutopilotControlSnapshot`, and `AutomodeSupervisorError`; export it in `WsRpcSchema`. Add the corresponding client type and implementation beside `updatePolicy`.

- [ ] **Step 4: Run focused tests and typecheck the touched packages**

Run: `bun run test packages/contracts/src/gits.test.ts packages/contracts/src/push.test.ts && bun run build:contracts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/gits.ts packages/contracts/src/push.ts packages/contracts/src/rpc.ts packages/contracts/src/gits.test.ts packages/contracts/src/push.test.ts packages/client-runtime/src/wsRpcClient.ts
git commit -m "feat: add guided autopilot contracts"
```

### Task 2: Add Fail-Closed Autopilot Controls

**Files:**
- Create: `apps/server/src/gits/Layers/AutopilotControl.ts`
- Create: `apps/server/src/gits/Layers/AutopilotControl.test.ts`
- Modify: `apps/server/src/ws.ts`
- Modify: `apps/server/src/server.test.ts`

**Interfaces:**
- Consumes: `AutopilotConfigureInput`, `AutopilotControlSnapshot`.
- Produces: `configureAutopilot(dependencies, input)` and `emergencyStopAutopilot(dependencies)`.

- [ ] **Step 1: Write failing control tests**

Cover these observable calls:

```ts
expect(onCalls).toEqual([
  ["scheduler.setConfig", { enabled: true }],
  ["supervisor.updatePolicy", {
    mode: "autonomous",
    killSwitchEnabled: false,
    maxActivePeers: 1,
    allowedRepos: [repo],
    proposalRepos: [repo],
    nightlyProposalSweep: true,
    sweepRequiresConfirmation: true,
    autoEnqueueApprovedProposals: true,
    gitsNotificationsEnabled: true,
  }],
]);

expect(pauseCalls).toEqual([
  ["scheduler.disarm", { reason: "Autopilot paused." }],
  ["supervisor.updatePolicy", {
    mode: "manual",
    allowedRepos: [repo],
    proposalRepos: [repo],
    nightlyProposalSweep: false,
  }],
]);
```

Also assert empty repositories reject enabling, a scheduler-enable failure never switches policy to autonomous, Pause disarms before updating policy, and Emergency Stop disarms before calling `stopAll`. These orderings ensure a later failure still denies future starts.

- [ ] **Step 2: Run the test and verify it fails**

Run: `bun run test apps/server/src/gits/Layers/AutopilotControl.test.ts`

Expected: FAIL because `AutopilotControl.ts` does not exist.

- [ ] **Step 3: Implement the two orchestration functions**

Keep the seam dependency-based and small:

```ts
export function configureAutopilot(
  dependencies: {
    supervisor: Pick<AutomodeSupervisorShape, "updatePolicy">;
    scheduler: Pick<GitsSlotSchedulerShape, "setConfig" | "disarm">;
  },
  input: AutopilotConfigureInput,
): Effect.Effect<AutopilotControlSnapshot, AutomodeSupervisorError>;

export function emergencyStopAutopilot(
  dependencies: {
    supervisor: Pick<AutomodeSupervisorShape, "stopAll">;
    scheduler: Pick<GitsSlotSchedulerShape, "disarm">;
  },
): Effect.Effect<AutomodeStopAllResult, AutomodeSupervisorError>;
```

Map scheduler errors into `AutomodeSupervisorError`. Do not arm on On; accepted work remains the authorization point through `scheduleApprovedGoal`.

- [ ] **Step 4: Wire RPC handlers**

Add `WS_METHODS.gitsAutomodeConfigure` to `ws.ts` using `configureAutopilot`. Replace the current stop-all handler effect with `emergencyStopAutopilot` so the existing UI and Telegram-compatible result remain unchanged.

- [ ] **Step 5: Run focused tests**

Run: `bun run test apps/server/src/gits/Layers/AutopilotControl.test.ts apps/server/src/server.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/gits/Layers/AutopilotControl.ts apps/server/src/gits/Layers/AutopilotControl.test.ts apps/server/src/ws.ts apps/server/src/server.test.ts
git commit -m "feat: add simple autopilot controls"
```

### Task 3: Make Acceptance Recovery Visible and Idempotent

**Files:**
- Modify: `apps/server/src/gits/Layers/HermesAutomodeBridge.ts`
- Modify: `apps/server/src/gits/Layers/HermesAutomodeBridge.test.ts`

**Interfaces:**
- Consumes: existing `decideProposalWithAutomodeBridge` dependencies.
- Produces: the same external result with a new recovery invariant: approval failure records `attention-required` when the Proposal is known.

- [ ] **Step 1: Add failing partial-failure tests**

Add scenarios for enqueue failure and scheduler failure. Assert the Inbox record includes:

```ts
expect(events.at(-1)).toMatchObject({
  proposalId: proposal.id,
  episodeId: proposal.episodeId,
  goalId: null,
  eventKey: `proposal:${proposal.id}:acceptance-failed`,
  state: "attention-required",
  reason: expect.stringContaining("Retry"),
});
```

For scheduler failure after Goal creation, expect `goalId` to be populated. Retry the same approval and assert only one live Goal exists and the final Inbox state is `approved-queued` or `scheduled-tonight`.

- [ ] **Step 2: Run the bridge test and verify failure**

Run: `bun run test apps/server/src/gits/Layers/HermesAutomodeBridge.test.ts`

Expected: FAIL because failure is not projected to the Inbox.

- [ ] **Step 3: Implement one best-effort recovery projection**

Track the known Proposal and current Goal inside the existing bridge operation. On an approval-path error, call `dependencies.inbox.record` with stable key `proposal:<id>:acceptance-failed`, state `attention-required`, the Goal ID when known, and the existing proposal deep link. Ignore only failure of this compensating Inbox write, then rethrow the original `HermesAdapterError`.

Do not alter the successful ordering, episode deduplication, or decision contract.

- [ ] **Step 4: Run the bridge and Inbox suites**

Run: `bun run test apps/server/src/gits/Layers/HermesAutomodeBridge.test.ts apps/server/src/gits/Layers/CockpitInbox.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/gits/Layers/HermesAutomodeBridge.ts apps/server/src/gits/Layers/HermesAutomodeBridge.test.ts
git commit -m "fix: make proposal launch retries visible"
```

### Task 4: Add Current-Device Push Tests

**Files:**
- Modify: `apps/server/src/push/Services/PushNotificationService.ts`
- Modify: `apps/server/src/push/Layers/PushNotificationService.ts`
- Modify: `apps/server/src/push/Layers/PushNotificationService.test.ts`
- Modify: `apps/server/src/push/http.ts`
- Create: `apps/server/src/push/http.test.ts`
- Modify: `apps/server/src/server.ts`

**Interfaces:**
- Produces: `sendToEndpoint(endpoint, payload): Effect<"sent" | "disabled" | "not-found" | "failed">`.
- Produces: authenticated `POST /api/push/test` accepting only `WebPushTestInput`.

- [ ] **Step 1: Write failing targeted-send tests**

Create two registered subscriptions, call `sendToEndpoint` for one, and assert only that endpoint is sent. Cover disabled VAPID, missing endpoint, sender failure, and expired-subscription deletion.

```ts
const result = yield* service.sendToEndpoint(active.endpoint, payload);
assert.strictEqual(result, "sent");
assert.deepStrictEqual(sentEndpoints, [active.endpoint]);
```

- [ ] **Step 2: Run the push service test and verify failure**

Run: `bun run test apps/server/src/push/Layers/PushNotificationService.test.ts`

Expected: FAIL because `sendToEndpoint` is absent.

- [ ] **Step 3: Implement targeted delivery by reusing the existing sender**

List registered subscriptions, find an exact endpoint match, serialize the provided typed payload, and call `WebPushSender.send` once. Delete 404/410 endpoints. Return a closed result union instead of accepting caller-provided fallback behavior.

- [ ] **Step 4: Write and implement route tests**

The route builds fixed payload content only. It creates the tag server-side with `crypto.randomUUID()` so repeated Android tests remain visible without accepting caller text:

```ts
const TEST_PAYLOADS = {
  delivery: {
    title: "GITS notification test",
    body: "Android PWA delivery is working. Tap to confirm.",
    url: "/gits?panel=autopilot&notificationTest=delivery",
  },
  proposal: {
    title: "Test proposal ready",
    body: "Tap to test the guided proposal launch.",
    url: "/gits?panel=autopilot&notificationTest=proposal",
  },
} satisfies Record<WebPushTestKind, Omit<PushNotificationPayload, "tag">>;

const payload = {
  ...TEST_PAYLOADS[input.kind],
  tag: `gits:test:${input.kind}:${crypto.randomUUID()}`,
};
```

Require owner authentication with the same helper as subscription routes. Return 200 plus `{ accepted: true, url }` only for `sent`; map disabled to 503, not-found to 404, and failed to 502. Tests must prove thread-scoped auth is rejected and request bodies cannot provide title/body/url.

- [ ] **Step 5: Register the route and run tests**

Run: `bun run test apps/server/src/push/Layers/PushNotificationService.test.ts apps/server/src/push/http.test.ts apps/server/src/server.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/push apps/server/src/server.ts
git commit -m "feat: add targeted PWA notification tests"
```

### Task 5: Build Guided Launch Logic Test-First

**Files:**
- Create: `apps/web/src/components/gits/cockpit/proposal-launch/proposalLaunch.logic.ts`
- Create: `apps/web/src/components/gits/cockpit/proposal-launch/proposalLaunch.logic.test.ts`

**Interfaces:**
- Produces: `LaunchStep`, `ProposalLaunchForm`, `launchModelOptions`, `initialProposalLaunchForm`, `validateProposalLaunchForm`, `proposalLaunchEdits`, and `TEST_PROPOSAL`.

- [ ] **Step 1: Write failing pure tests**

Cover proposal/default model precedence, allowed-model filtering, fallback to the three `CODEX_MODEL_TIERS`, invalid runtime, missing repository, ISO conversion for `notBefore`, structured verification rows, and deterministic test fixture behavior.

```ts
expect(initialProposalLaunchForm(proposal, policy).model).toBe(proposal.model);
expect(launchModelOptions({ ...policy, allowedModels: [] }).map((item) => item.value)).toEqual([
  CODEX_MODEL_TIERS.light,
  CODEX_MODEL_TIERS.medium,
  CODEX_MODEL_TIERS.high,
]);
expect(validateProposalLaunchForm({ ...form, runtime: "-1" })).toMatchObject({
  ok: false,
  field: "runtime",
});
```

- [ ] **Step 2: Run and verify failure**

Run: `bun run test apps/web/src/components/gits/cockpit/proposal-launch/proposalLaunch.logic.test.ts`

Expected: FAIL because the module is absent.

- [ ] **Step 3: Implement minimal pure logic**

Use the existing `CODEX_MODEL_TIERS`, `HermesProposalCard`, `AutomodePolicy`, `GitsVerifyCommand`, and `MotokoProposalEdits` types. Model options are policy `allowedModels` when non-empty; otherwise use the three tier slugs. Include the Proposal model when valid and not duplicated. Do not add free-text custom models.

Represent verification commands as `ReadonlyArray<GitsVerifyCommand>` and edit them with rows in the UI; never serialize them to editable JSON.

- [ ] **Step 4: Run tests**

Run: `bun run test apps/web/src/components/gits/cockpit/proposal-launch/proposalLaunch.logic.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/gits/cockpit/proposal-launch
git commit -m "feat: add guided proposal launch logic"
```

### Task 6: Build the Three-Step Launch Sheet

**Files:**
- Create: `apps/web/src/components/gits/cockpit/ProposalLaunchSheet.tsx`
- Create: `apps/web/src/components/gits/cockpit/ProposalLaunchSheet.browser.tsx`
- Modify: `apps/web/src/components/gits/GitsCockpit.tsx`

**Interfaces:**
- Consumes: Task 5 launch logic and existing `onDecision(proposal, decision, edits)` callback.
- Produces: `ProposalLaunchSheet` supporting real Proposal IDs and `testMode="proposal"`.
- Produces callback: `onDecision(...): Promise<AutomodeGoal | null>` so the sheet can render the actual queued Goal.

- [ ] **Step 1: Write failing browser interactions**

Render the sheet with a proposed card and assert:

1. Step 1 shows outcome/scope/evidence and Continue.
2. Step 2 shows a model `<Select>` with the recommendation selected.
3. Advanced details are initially closed and reveal structured controls.
4. Step 3 summarizes model/repo/runtime, calls approval exactly once, and displays the returned Goal as queued.
5. Later and Reject call their existing decisions without creating a Goal client call.
6. Test mode is visibly marked, ends with **Complete Test**, and never invokes `onDecision`.

- [ ] **Step 2: Run browser test and verify failure**

Run: `cd apps/web && bun run test:browser -- src/components/gits/cockpit/ProposalLaunchSheet.browser.tsx`

Expected: FAIL because the sheet is absent.

- [ ] **Step 3: Implement the focused sheet**

Use existing `Sheet`, `Select`, `Input`, `Button`, and status primitives. Keep one local form seeded when Proposal ID changes. Render explicit progress text `1 of 3`, `2 of 3`, `3 of 3`. Use **Accept & Queue**, never “dispatch,” for the real final action. Await `onDecision`; on success show the returned Goal title and status before allowing the sheet to close.

For `testMode="proposal"`, use `TEST_PROPOSAL`, show a persistent **Test notification** pill, and make completion local-only.

- [ ] **Step 4: Refresh all projections after decisions**

In `GitsCockpit.tsx`, remove the redundant client-side `draftFromProposal` call after approval: the server bridge already drafts and queues. After `decideProposal`, fetch the Automode snapshot, match its live Goal by `decided.episodeId`, and return that Goal from `mutateAsync`. The mutation success must also refetch proposals, Hermes status, scheduler snapshot, and invalidate the Cockpit Inbox query prefix. This makes queue success visible without a second decision/draft call.

- [ ] **Step 5: Run browser and relevant pure tests**

Run: `cd apps/web && bun run test:browser -- src/components/gits/cockpit/ProposalLaunchSheet.browser.tsx`

Run: `bun run test apps/web/src/components/gits/cockpit/proposal-launch/proposalLaunch.logic.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/gits/cockpit/ProposalLaunchSheet.tsx apps/web/src/components/gits/cockpit/ProposalLaunchSheet.browser.tsx apps/web/src/components/gits/GitsCockpit.tsx
git commit -m "feat: add guided proposal launch sheet"
```

### Task 7: Replace the Autopilot Policy Dashboard

**Files:**
- Rewrite: `apps/web/src/components/gits/cockpit/AutopilotPanel.tsx`
- Create: `apps/web/src/components/gits/cockpit/AutopilotPanel.browser.tsx`
- Modify: `apps/web/src/components/gits/GitsCockpit.tsx`
- Delete: `apps/web/src/components/gits/cockpit/autopilot/autopilot.logic.ts`
- Delete: `apps/web/src/components/gits/cockpit/autopilot/autopilot.logic.test.ts`

**Interfaces:**
- Consumes: `automode.configure`, `ProposalLaunchSheet`, `InboxSection`, existing `stopAll`.
- Produces: compact Autopilot operator surface.

- [ ] **Step 1: Write failing reduced-surface browser tests**

Assert the panel contains On/Paused, watched repositories, Inbox, queue summary, and Emergency Stop. Assert it does not contain “Automation switchboard,” “Policy,” “Max budget,” “Verification commands JSON,” “Scheduler arm,” “Manual goal,” or raw mode choices.

Assert enabling with zero watched repositories shows a validation message. Assert Pause calls:

```ts
client.automode.configure({
  enabled: false,
  repositories: snapshot.policy.proposalRepos,
});
```

- [ ] **Step 2: Run browser test and verify failure**

Run: `cd apps/web && bun run test:browser -- src/components/gits/cockpit/AutopilotPanel.browser.tsx`

Expected: FAIL against the old dashboard.

- [ ] **Step 3: Rewrite the panel around the narrow interface**

Keep the existing environment-client helper, repository chip picker, Inbox, stop confirmation, and status primitives. Delete policy form state, quick-switchboard mutations, manual Goal composer, scheduler controls, goal filters, budget display, and overnight result table.

Derive On as `policy.mode === "autonomous" && !policy.killSwitchEnabled`. Show at most five non-terminal Goals in creation order with title, repository basename, and status. The queue display is read-only; Emergency Stop remains the only destructive panel action.

- [ ] **Step 4: Remove obsolete shell props and state**

Delete manual Goal title/repo/model/prompt state and enqueue/approve/reject/dispatch/scheduler arm mutations from `GitsCockpit.tsx`. Pass only snapshot, proposals, projects, focused Proposal ID, decision callback, and refresh callback.

- [ ] **Step 5: Run web tests**

Run: `cd apps/web && bun run test:browser -- src/components/gits/cockpit/AutopilotPanel.browser.tsx src/components/gits/cockpit/ProposalLaunchSheet.browser.tsx`

Run: `bun run test apps/web/src/components/gits/cockpit/inbox/inbox.logic.test.ts apps/web/src/components/gits/cockpit/proposal-launch/proposalLaunch.logic.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A apps/web/src/components/gits
git commit -m "feat: simplify autopilot around the inbox"
```

### Task 8: Add PWA Diagnostics UI and Test Routing

**Files:**
- Modify: `apps/web/src/lib/webPush.ts`
- Create: `apps/web/src/lib/webPush.test.ts`
- Modify: `apps/web/src/components/settings/SettingsPanels.tsx`
- Modify: `apps/web/src/components/settings/SettingsPanels.browser.tsx`
- Modify: `apps/web/src/components/gits/cockpit/AutopilotPanel.tsx`
- Modify: `apps/web/src/service-worker.ts`

**Interfaces:**
- Produces: `readWebPushDiagnostics()` and `sendWebPushTest(kind)`.
- Consumes: `POST /api/push/test` and `notificationTest` query values.

- [ ] **Step 1: Write failing helper tests**

Mock secure context, Notification permission, service worker readiness, PushManager subscription, and fetch. Assert diagnostics distinguish unsupported, permission denied, missing subscription, and ready. Assert the test request uses the normalized current endpoint and only the fixed kind.

```ts
await sendWebPushTest("proposal");
expect(fetch).toHaveBeenCalledWith(
  "/api/push/test",
  expect.objectContaining({
    method: "POST",
    credentials: "include",
    body: JSON.stringify({ endpoint, kind: "proposal" }),
  }),
);
```

- [ ] **Step 2: Run helper tests and verify failure**

Run: `bun run test apps/web/src/lib/webPush.test.ts`

Expected: FAIL because helpers do not exist.

- [ ] **Step 3: Export current-subscription normalization and diagnostics**

Reuse `canUseWebPush`, `navigator.serviceWorker.ready`, and `normalizeSubscription`. Do not register implicitly from a test button; diagnostics must tell the operator to enable Push to phone first.

- [ ] **Step 4: Add Settings diagnostics browser coverage and UI**

Add one compact section below **Push to phone** with five status rows and buttons **Send delivery test** and **Send proposal test**. Disable them unless permission, server VAPID, service worker, and subscription are ready. Show server acceptance as “Sent — tap the notification to confirm Android delivery,” not “Delivered.”

Run: `cd apps/web && bun run test:browser -- src/components/settings/SettingsPanels.browser.tsx`

Expected after implementation: PASS.

- [ ] **Step 5: Render test routes safely**

When `notificationTest=delivery`, the Autopilot panel shows a success banner stating the notification click reached the PWA. When `notificationTest=proposal`, render `ProposalLaunchSheet` in test mode. Keep the service worker's generic same-origin focus/open logic; add a test or extracted pure URL assertion only if current browser coverage lacks it.

- [ ] **Step 6: Run all focused notification tests**

Run: `bun run test apps/web/src/lib/webPush.test.ts apps/server/src/push/Layers/PushNotificationService.test.ts apps/server/src/push/http.test.ts`

Run: `cd apps/web && bun run test:browser -- src/components/settings/SettingsPanels.browser.tsx src/components/gits/cockpit/ProposalLaunchSheet.browser.tsx src/components/gits/cockpit/AutopilotPanel.browser.tsx`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/lib/webPush.ts apps/web/src/lib/webPush.test.ts apps/web/src/components/settings/SettingsPanels.tsx apps/web/src/components/settings/SettingsPanels.browser.tsx apps/web/src/components/gits/cockpit/AutopilotPanel.tsx apps/web/src/service-worker.ts
git commit -m "feat: add Android PWA notification diagnostics"
```

### Task 9: Integration Audit, Verification, and Documentation

**Files:**
- Modify as failures require: files already listed above
- Modify: `docs/superpowers/specs/2026-08-09-guided-autopilot-inbox-design.md`

**Interfaces:**
- Verifies the complete Proposal → Inbox → PWA → guided Acceptance → Queue path and notification-test isolation.

- [ ] **Step 1: Run focused integration suites**

```bash
bun run test \
  packages/contracts/src/gits.test.ts \
  packages/contracts/src/push.test.ts \
  apps/server/src/gits/Layers/AutopilotControl.test.ts \
  apps/server/src/gits/Layers/HermesAutomodeBridge.test.ts \
  apps/server/src/gits/Layers/CockpitInbox.test.ts \
  apps/server/src/push/Layers/PushNotificationService.test.ts \
  apps/server/src/push/http.test.ts \
  apps/server/src/server.test.ts \
  apps/web/src/components/gits/cockpit/inbox/inbox.logic.test.ts \
  apps/web/src/components/gits/cockpit/proposal-launch/proposalLaunch.logic.test.ts \
  apps/web/src/lib/webPush.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run browser suites**

```bash
cd apps/web && bun run test:browser -- \
  src/components/gits/cockpit/ProposalLaunchSheet.browser.tsx \
  src/components/gits/cockpit/AutopilotPanel.browser.tsx \
  src/components/settings/SettingsPanels.browser.tsx
```

Expected: PASS.

- [ ] **Step 3: Run mandatory repository gates**

From the repository root:

```bash
bun fmt
bun lint
bun typecheck
```

Expected: all exit 0. Review `git status` after `bun fmt` and include only task-related formatting changes.

- [ ] **Step 4: Audit spec requirements against current evidence**

Confirm with code and tests that:

- the old policy dashboard and manual Goal composer are absent;
- Model is a dropdown in step 2;
- advanced settings are optional and structured;
- Inbox and PWA deep links open the same sheet;
- successful Acceptance creates one queued Goal and refreshes queue/Inbox/scheduler state;
- retry is idempotent and failure is visible;
- Pause and Emergency Stop match the spec;
- both test notifications target one registered endpoint; and
- proposal test completion cannot call a production mutation.

- [ ] **Step 5: Mark the design implemented and commit final cleanup**

Change the design status to `Implemented` only after every check passes.

```bash
git add -A
git commit -m "docs: mark guided autopilot implemented"
```

- [ ] **Step 6: Push, open PR, merge, deploy, and smoke test**

Push `feat/guided-autopilot-inbox`, open a PR into `gits`, wait for required checks, merge it, redeploy the hosted `gits` service, and verify the deployed build reports the merge commit. Smoke-test `/gits`, authenticated push configuration, the diagnostics request validation, and the guided Autopilot route. The operator performs the final physical Android receipt/tap check.
