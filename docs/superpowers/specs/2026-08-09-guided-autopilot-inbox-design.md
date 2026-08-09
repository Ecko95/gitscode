# Guided Inbox-First Autopilot Design

**Status:** Draft for operator review
**Date:** 2026-08-09

## Objective

Redesign Autopilot around one understandable operator journey: receive a durable proposal in the Cockpit Inbox, open it from an Android PWA notification or the Inbox, validate the idea, choose a model from a dropdown, optionally adjust advanced proposal-specific settings, and accept it into the execution queue immediately.

Keep the useful execution choices, but remove the current raw global-policy workflow. The normal cockpit must not require the operator to understand Automode modes, allowlist duplication, scheduler arming, approval flags, verification JSON, or notification-channel internals before accepting a proposal.

Add notification diagnostics that send real Web Push notifications to the current device so Android PWA delivery and routing can be tested without creating production proposals or goals.

## Domain Model

The canonical terms are recorded in the repository `CONTEXT.md`.

- A **Proposal** is a reviewable idea, not executable work.
- A **Launch Configuration** contains proposal-specific run choices.
- **Acceptance** validates a Proposal and requests exactly one **Goal**.
- A Goal enters the **Queue** immediately but may start later when execution gates permit.
- An **Inbox Item** is the durable operator-facing projection of the Proposal and Goal lifecycle.
- A **Notification** is an optional delivery signal pointing to that Inbox Item.

These distinctions are load-bearing. The Inbox is not the Queue, accepting is not dispatching, and opening a notification is not acceptance.

## Existing Modules Reused

- `CockpitInbox` remains authoritative for unread state, pinning, retention, and the operator-visible timeline.
- `HermesProposalCard` remains authoritative for proposal content and editable launch inputs.
- `decideProposalWithAutomodeBridge` remains the deep module for decision, draft creation, idempotent Goal creation, scheduling, and Inbox projection.
- `AutomodeSupervisor` and its persisted Goals remain execution truth.
- `GitsSlotScheduler` remains the sole authority for whether queued work may start.
- `AutomodeNotifications`, `PushNotificationService`, and the existing service worker remain the Web Push delivery path.
- The existing server-side safety gates, isolated branches, verification floor, held-PR workflow, and boot disarm remain mandatory.

The redesign deepens the existing proposal-acceptance seam rather than adding a parallel execution path. Inbox, PWA, and cockpit callers all cross the same acceptance interface, giving one place for validation, idempotency, recovery, and tests.

## Chosen Interaction

Use a three-step guided launch sheet opened from either an Inbox Item or its PWA notification.

Two alternatives were rejected:

- Keeping one dense editable card retains the current cognitive load and makes required choices unclear.
- One-click acceptance with entirely hidden defaults is simple but removes the model choice and operator confidence the redesign must preserve.

The guided sheet keeps the common path short while placing rarely changed choices behind progressive disclosure.

### Step 1: Validate Idea

Show the Proposal's:

- title and plain-language outcome;
- repository;
- summary and scope;
- evidence and verification plan;
- risk and action kind; and
- any blocking reason.

The primary action is **Continue**. **Later** and **Reject** remain secondary actions. The operator does not edit execution settings on this step.

### Step 2: Choose Model

Show one prominent model dropdown. It is preselected from the Proposal's model when valid, otherwise from the server's current recommendation or default. Options come from the available, policy-supported model inventory; arbitrary model text is not accepted.

Each option shows a short useful label, such as provider/model and recommendation status. If the selected model becomes unavailable before acceptance, the launch is blocked with a clear message and refreshed choices.

An **Advanced details** disclosure contains the existing proposal-specific fields:

- repository override;
- start time (`notBefore`);
- runtime limit;
- verification commands; and
- integration branch.

Defaults come from the Proposal and current safe server policy. Advanced fields are validated with the existing proposal decision schemas and policy gates. The interface uses structured controls where the domain is enumerable; raw JSON is not shown in the common path. Verification commands use repeatable command rows, with label, argv, and optional timeout.

### Step 3: Review and Launch

Show a short plain-language summary:

- what will run;
- where it will run;
- selected model;
- when it becomes eligible;
- runtime limit;
- verification expectation; and
- that successful work ends in a held PR rather than an automatic merge.

The single primary action is **Accept & Queue**. The button remains disabled until required values are valid. While pending, it cannot be submitted again. Success shows the created Goal and its queue/schedule state, not a misleading claim that execution has started.

The sheet keeps the current step in its URL-backed focused state so a PWA deep link, refresh, or existing cockpit window resolves to the same Proposal. Unsaved field edits remain local to the sheet and are discarded when it closes.

## Simplified Autopilot Surface

The normal Autopilot surface contains only:

- **On / Paused** status and control;
- watched repositories;
- the Cockpit Inbox;
- a compact queue summary; and
- **Emergency Stop**.

The following controls leave the normal surface:

- manual/supervised/autonomous mode selection;
- manual Goal composer;
- max peer and budget fields;
- global model allowlist and arbitrary model text;
- peer-spawn, integrate, and destructive-action approval toggles;
- Motoko authority modes;
- scheduler enable, arm, disarm, nightly cap, and quota threshold controls;
- global verification-command JSON;
- global integration branch;
- duplicate GITS/Telegram notification toggles; and
- the separate goal-status filter toolbar.

This is removal from the operator Interface, not deletion of safety behavior. Legacy persisted policy remains decodable for compatibility. Internal defaults and existing gates continue to constrain every Goal.

### On, Pause, and Emergency Stop

**On** enables proposal discovery for watched repositories and permits queued Goals to start through the existing scheduler and safety gates. Watched repositories are the execution allowlist and proposal-discovery list; the operator does not maintain two lists.

**Pause** stops new proposal discovery and future Goal starts. It does not terminate a running Goal. Pausing also clears approval-based automatic arming so a restart or scheduler tick cannot silently undo the pause.

**Emergency Stop** uses the existing stop-all path: it prevents new starts, disarms scheduling, and terminates currently running autonomous work. Re-enabling Autopilot is always explicit.

One server operation owns each control transition so the web client does not coordinate several policy and scheduler RPCs. Internally, the implementation may reuse the current policy and scheduler stores, but partial failure must return a failed transition and leave future starts fail-closed.

## Inbox and PWA Flow

The normal path is:

1. Proposal creation is durably persisted by Hermes.
2. `CockpitInbox` records `pending-review`.
3. Optional PWA delivery is attempted with a deep link to the Proposal launch sheet.
4. The operator opens the notification or Inbox Item.
5. The guided sheet loads the Proposal and current model choices.
6. **Accept & Queue** submits one proposal decision with its Launch Configuration.
7. The server creates or repairs exactly one Goal for the Proposal episode.
8. The server records `approved-queued` and schedules the Goal.
9. The sheet displays the resulting queue state.

PWA delivery remains advisory. Notification failure never loses a Proposal because the Inbox transition is written first. Notification text stays concise and excludes full prompts, evidence, secrets, and repository contents.

The notification itself does not mutate proposal or execution state. Tapping it opens the focused review sheet, and the explicit **Accept & Queue** action performs Acceptance. This avoids accidental launches and works consistently on Android browsers that do not expose notification action buttons uniformly.

## Reliable Acceptance and Recovery

Acceptance is a durable, idempotent operation keyed by Proposal episode ID.

Its observable success condition is all of:

1. the Proposal decision and edited Launch Configuration are persisted;
2. exactly one live Goal exists for the episode;
3. the Inbox Item references that Goal and displays `approved-queued`; and
4. scheduling has processed the Goal's eligibility time.

The existing stores do not provide a cross-file transaction, so recovery uses ordered, replayable steps rather than pretending to be atomic.

- If decision persistence succeeds but Goal creation fails, record `attention-required` when possible. Retry resumes Goal creation.
- If Goal creation succeeds but Inbox or scheduling fails, retry finds the existing live Goal and repairs the missing projection or schedule. It never creates a second live Goal.
- If the final response is lost, a repeated tap returns the same effective result.
- Multiple devices accepting concurrently converge on one live Goal for the episode.
- Reject and Later never create a Goal.

The sheet remains open on failure, preserves entered choices, and shows one actionable error. An `attention-required` Inbox Item exposes **Retry launch** through the same guided sheet.

## Android PWA Notification Diagnostics

Settings → Notifications gains a compact **PWA diagnostics** section. It reports current-device prerequisites:

- secure context;
- notification permission;
- service worker readiness;
- active Web Push subscription; and
- server VAPID availability.

It provides two authenticated actions.

### Send Delivery Test

Send a real Web Push payload through the production server and push provider to the current browser subscription only. The request identifies the exact endpoint already registered by that browser. The server refuses an endpoint that is not in the authenticated installation's registered subscription set.

The notification uses a unique tag so repeated tests are visible and do not collide with production notification deduplication. Its deep link opens the diagnostics result view and confirms that the notification click route reached the PWA.

### Send Proposal Test

Send a proposal-shaped notification to the current subscription. Tapping it opens the real guided launch sheet in explicit test mode with deterministic fixture content.

Test mode exercises:

- server dispatch;
- Android Web Push delivery;
- service-worker notification display;
- notification click and PWA focus/open behavior;
- deep-link routing;
- all three guided-sheet steps; and
- model-dropdown rendering.

Its final button is **Complete Test**, not **Accept & Queue**. Test mode never writes a Proposal, Inbox Item, Goal, scheduler state, or notification delivery key used by production. The UI displays a permanent **Test notification** marker so fixture content cannot be mistaken for real work.

The server reports only that the push provider accepted dispatch. The device confirms actual delivery by opening the notification. No false "delivered" claim is shown before that action.

The test endpoint is owner-authenticated, accepts only the current registered endpoint and a fixed test kind, and accepts no caller-controlled title, body, or URL. This prevents it from becoming an arbitrary push or phishing endpoint. The UI disables repeated submission while a request is pending; no new configurable throttling system is introduced.

## Data and Compatibility

No second Proposal, Goal, Queue, or Inbox persistence model is added.

The existing Proposal decision fields carry Launch Configuration. Existing Automode policy state remains readable. A migration normalizes duplicated watched/allowed repository lists into the watched-repository choice without discarding repositories already explicitly allowed.

The normal web client stops sending broad policy edits. Narrow server operations expose Autopilot state transitions and watched-repository updates. Existing broad RPCs may remain temporarily for stored-state compatibility and internal tests, but they are no longer part of the cockpit Interface and receive no new features.

Inbox retention remains unchanged:

- prune unpinned terminal items 90 days after `terminalAt`;
- never prune pinned items; and
- never prune active items.

## Error Handling

- Inbox persistence failure prevents external proposal notification delivery and is surfaced to the initiating operation.
- External push failure is logged and does not alter Proposal, Inbox, or Goal state.
- Missing or stale Proposal deep links show a recovery state with Inbox refresh, not an empty launch form.
- Model inventory failure leaves the recommended value unavailable and blocks Acceptance until choices can be loaded.
- Server policy validation errors are attached to the affected launch field when possible.
- Acceptance partial failures use `attention-required` and the idempotent retry path.
- Corrupt existing Inbox or Automode state preserves the current fail-closed behavior; the redesign does not silently reset operator history.
- Test-push failure identifies the failing stage: prerequisites, subscription registration, server dispatch, or device-open confirmation.
- Pause or Emergency Stop partial failure must deny future starts. The UI never reports On until the server returns the reconciled state.

## Testing

Use focused checks at the existing seams.

### Contracts and Server

- schemas for narrow Autopilot controls and fixed notification-test input;
- watched repositories mapping to proposal discovery and execution allowlisting;
- On, Pause, and Emergency Stop semantics, including fail-closed partial failure;
- acceptance with edited model and advanced settings;
- exactly one live Goal for duplicate and concurrent Acceptance;
- recovery after failure at decision, Goal, Inbox, and scheduling stages;
- Inbox-first notification ordering and non-fatal push failure;
- current-subscription-only test delivery;
- rejection of unregistered endpoints and arbitrary test payloads; and
- proof that notification tests cannot mutate Proposal, Inbox, Goal, or scheduler state.

### Web and Service Worker

- guided-sheet step order and validation;
- recommended model selection and unavailable-model recovery;
- advanced details progressive disclosure and structured verification rows;
- Accept & Queue pending, success, error, and retry states;
- Inbox and notification deep links resolving the same Proposal;
- Android diagnostics prerequisite states;
- delivery and proposal test requests using the current subscription;
- unmistakable test-mode rendering and non-production final action; and
- notification click focusing a matching window or opening the correct URL.

### Verification

Run focused `bun run test` suites. Never use `bun test`. Repository completion additionally requires:

- `bun fmt`;
- `bun lint`; and
- `bun typecheck`.

After deployment, verify authenticated push configuration, current-device subscription registration, both notification-test dispatch paths, deep-link routing, and the production proposal → Inbox → guided Acceptance → queued Goal path. Physical Android receipt remains an operator-observed check because the server can prove push-provider acceptance but not notification display by the device.

## Out of Scope

- Direct queue mutation from a notification action button.
- Guaranteed delivery while Android or the browser suppresses notifications.
- Automatic merge or bypassing the held-PR review.
- A new scheduler, queue, or event store.
- Arbitrary notification payload composition.
- Persisted notification-test history or analytics.
- Per-user Inbox state for a multi-user product.
- Removing expert policy schemas before compatibility data has migrated.
- Redesigning Motoko chat or unrelated cockpit panels.
