# Cockpit Inbox and Quota-Aware Scheduling Design

**Status:** Draft for operator review  
**Date:** 2026-08-09

## Objective

Make approving a Motoko proposal one meaningful operator action. Approval queues the edited proposal and enables and arms the existing scheduler for the current or next eligible London night. The scheduler remains the sole authority for whether implementation may start.

Replace transient delivery notifications with a durable Cockpit Inbox. Every operator-visible proposal and Automode transition is written to the Inbox first; PWA and Telegram are optional delivery channels for that durable event.

Autonomous starts fail closed when Codex five-hour or weekly quota telemetry is missing, stale, or above its configured threshold. A quota-blocked goal stays queued until fresh telemetry permits it. When a known reset applies, Motoko may refine the plan without starting implementation, and implementation remains deferred until after that reset.

## Existing Components Reused

- `HermesProposalCard` and `HermesAutomodeBridge` for proposal review and idempotent goal creation.
- `AutomodeSupervisor` and its persisted goals for execution truth.
- `GitsSlotScheduler` for arming, London windows, runtime runway, nightly limits, and quota gates.
- `GitsCapacityMonitor` and its existing five-hour and weekly windows, including `resetAt`.
- `AutomodeNotifications`, `PushNotificationService`, and `HermesTelegramNotifier` for optional delivery.
- Existing proposal and goal deep links in the Autopilot surface.
- Existing atomic JSON persistence used by other GITS services.

The Inbox does not replace proposal or Automode state. Proposals remain authoritative for review decisions, Automode goals remain authoritative for execution, and the Inbox is authoritative for the operator-visible event history, unread state, and pinning.

## Chosen Approach

Add one small persisted `CockpitInbox` service keyed by proposal episode ID. Existing proposal, bridge, scheduler, and driver transition points append idempotent Inbox events. The service atomically updates the item's current display state and timeline, then returns the event for optional PWA and Telegram delivery.

Two alternatives were rejected:

- Expanding `automode-notifications-state.json` would mix delivery deduplication with operator history and cannot represent unread, pinned, or live work state cleanly.
- Building a SQLite event projection would add a second event architecture for a bounded single-operator feature when the existing GITS services already use reliable atomic JSON stores.

## Inbox Data Model

The server persists schema-versioned state at `<stateDir>/gits/cockpit-inbox.json`.

Each item contains:

- `id`: the proposal episode ID, so proposal, goal, and completion events converge on one item;
- `proposalId` and nullable `goalId`;
- title and repository summary;
- current display state;
- `createdAt`, `updatedAt`, and nullable `terminalAt`;
- `readAt`, where an item is unread whenever `readAt` is null or older than `updatedAt`;
- `pinned`;
- current reason and deep link; and
- an ordered timeline of idempotent events.

Each timeline event contains a stable `eventKey`, timestamp, display state, reason, and deep link. Re-recording an existing key is a no-op. State changes use a new key and make the item unread again. The timeline records work and attention transitions, not channel delivery attempts.

Display states are:

- `pending-review`;
- `approved-queued`;
- `waiting-quota-reset`;
- `scheduled-tonight`;
- `running`;
- `attention-required`;
- `completed`;
- `rejected`; and
- `deferred`.

Only `completed`, `rejected`, and `deferred` are terminal. Terminal items are pruned 90 days after `terminalAt`. Pinned items are exempt, and non-terminal items are never pruned. Pruning runs on load and successful Inbox mutations; it needs no background job or new scheduler.

The list RPC supports the five requested filters without persisting redundant categories:

- **Unread:** unread items in any state.
- **Pending:** `pending-review`.
- **Approved:** `approved-queued`, `scheduled-tonight`, or `running`.
- **Waiting:** `waiting-quota-reset` or `attention-required`.
- **Completed:** `completed`, `rejected`, or `deferred`.

Mutation RPCs mark one item or all visible items read and toggle pinning. The server validates item IDs and owns all timestamps.

## Inbox-First Notifications

All existing operator-visible notification sites record an Inbox transition before attempting external delivery:

1. The proposal sweep records `pending-review` after the proposal is durably persisted.
2. Approval records `approved-queued`, then `scheduled-tonight` when the goal is armed for its resolved eligible night.
3. Scheduler quota decisions record `waiting-quota-reset` only when the meaningful wait reason or reset changes.
4. Driver transitions record `running`, `attention-required`, and `completed`.
5. Reject and defer record their terminal states.

The existing notification dispatcher consumes the newly recorded Inbox event. PWA and Telegram preferences remain independent. Delivery failure is logged and retained by the existing per-channel deduplication behavior but never rolls back the Inbox or execution state. Notification bodies stay concise and exclude full prompts and repository evidence.

Stable Inbox event keys replace hand-built delivery keys as the source for channel deduplication. This prevents periodic driver and scheduler ticks from creating duplicate Inbox or external notifications.

## One-Click Approval and Arming

The proposal review RPC remains the single Approve action. It performs these idempotent steps:

1. Validate the edited repository, model, runtime, verification commands, and integration branch against Automode policy.
2. Persist the approval and enqueue exactly one goal for the proposal episode.
3. Atomically enable the existing scheduler, authorize automatic arming for approved queued work, and target the first autonomy night on or after the goal's `notBefore`.
4. Record the Inbox approval transition and, when that target is the current autonomy night, the scheduled-night transition.

The scheduler gains one `scheduleApprovedGoal` operation so enabling, approval-based automatic-arming authorization, and the target night are one persisted scheduler update. The target-night helper reuses the existing London slot calendar rather than adding another schedule. Existing explicit enable, arm, and disarm controls remain available.

Approval-based authorization stays active while approved work remains queued. If a quota reset moves the goal beyond the currently targeted night, the driver may retarget the arm to the first eligible night on or after that reset. Explicit operator disarm and boot disarm both clear this authorization, so the driver cannot undo a safety decision. A later proposal approval creates a new authorization.

This is not a transaction across the proposal, goal, scheduler, and Inbox JSON files. Each step is durable and idempotent instead. If a later step fails, the RPC reports the failure, records `attention-required` when possible, and a repeated Approve retries missing work without duplicating the goal. A queued goal never starts merely because approval partially succeeded; all existing scheduler and Automode gates still apply.

A server restart keeps the existing fail-safe behavior that disarms an active or future night and clears automatic-arming authorization. The Inbox records the resulting `attention-required` event, and the operator may re-arm explicitly. Approval after the restart also authorizes arming again through the normal one-click path.

## Structured Scheduler Decisions

The scheduler's denied result gains structured metadata instead of requiring callers to parse human-readable reasons:

- category: `schedule`, `quota`, or `policy`;
- human-readable reason; and
- nullable `retryAt`.

Existing checks remain in their current order: enabled/armed state, London slot, nightly goal cap, concurrency envelope, runtime cap, slot runway, and quota. Manual dispatch remains explicit and unchanged.

The driver uses the category to project Inbox state:

- quota denial becomes `waiting-quota-reset`;
- an eligible armed goal before its slot becomes `scheduled-tonight`;
- policy or unrecoverable execution failures become `attention-required`.

Human-readable scheduler text remains available in the current scheduler snapshot.

## Fail-Closed Quota Semantics

Both Codex windows are required for an autonomous start:

- five-hour usage must be below `CAPACITY_MAX_USED_PERCENT_5H`;
- weekly usage must be below `weeklyMaxUsedPercent`; and
- each window must include a numeric usage value and a future `resetAt`.

A window is missing when it is absent or lacks either value. It is stale when `resetAt` is at or before the gate's current time. Missing or stale telemetry denies the start with quota category and no guessed retry time. Capacity monitor errors also deny the start. The driver leaves the goal queued, records one Inbox wait event, and rechecks through its existing tick and 60-second capacity memo.

When one or both fresh windows are over threshold, the scheduler returns the reset after which every currently blocking window could have cleared. This is the latest `resetAt` among the blocking windows. The driver persists that value as the goal's `notBefore`, keeps the goal queued, records it in the Inbox reason and timeline, and retargets approval-authorized arming to the first eligible night after that boundary. At or after `notBefore`, the scheduler reads fresh telemetry and applies every gate again; a reset never implies automatic permission.

No new quota clock, timer, or scheduler is introduced.

## Plan-Only Work While Waiting

When a queued implementation is deferred to a known quota reset or cannot fit the remaining safe night runway, the driver may request one plan refinement from Motoko for that wait episode. The request is explicitly observe-only: no Delamain peer, worktree, repository write, shell execution, or implementation attempt is allowed.

The refinement is deduplicated by goal ID plus retry boundary. Its concise result is stored on the queued goal and added to the Inbox timeline, then included in the later implementation prompt. A new refinement is allowed only if the blocking reset changes or the operator edits the proposal again.

Plan refinement failure is non-fatal. The original reviewed prompt remains intact, the goal stays queued, and implementation is still retried only after all scheduler gates pass. Missing or stale telemetry has no trustworthy reset boundary, so it waits for fresh data rather than repeatedly spending Motoko capacity.

## Cockpit UX

The Autopilot surface gains an Inbox section backed only by the Inbox RPC. It shows filter counts, unread emphasis, current state, latest timestamp, reason, and repository. Opening an item marks it read and shows its timeline. Pinning is available from the item without opening it.

The item's deep link opens the existing proposal review for pending, rejected, or deferred proposal items and the existing Automode goal surface once a goal exists. No second proposal editor or execution dashboard is introduced.

Approve remains one button. A successful response communicates both outcomes: queued and armed for the resolved night. Quota waits show the known reset time; unknown or stale telemetry says fresh quota telemetry is required rather than presenting a guessed time.

## Error Handling and Recovery

- Inbox persistence failure is surfaced for direct operator mutations and approval. External delivery is not attempted for an event that was not durably recorded.
- External channel failure never changes Inbox or Automode state.
- Duplicate transition calls are harmless because Inbox event keys and proposal episode goal creation are idempotent.
- Corrupt Inbox JSON logs a warning, preserves the unreadable file, and rejects Inbox writes rather than silently replacing operator history. The Cockpit reports the Inbox as unavailable until the operator repairs or removes the corrupt file.
- Quota read failures deny autonomous starts and produce one deduplicated wait event.
- Scheduler arming failure leaves an already-created goal queued and records attention when possible; retrying approval completes the missing steps.
- Existing kill switch, allowed repository/model checks, concurrency limit, runtime cap, verification floor, integration branch, held-PR review, and boot disarm behavior remain mandatory.

## Testing

Use one focused test at each non-trivial seam:

- Inbox schema compatibility, event idempotency, unread transitions, pinning, filters, and 90-day pruning;
- Inbox-first routing with independent PWA and Telegram delivery and non-fatal channel failure;
- approval queues one goal and atomically enables/arms the resolved night, including safe retry after a partial failure;
- missing, stale, monitor-error, five-hour-limited, weekly-limited, and dual-window quota decisions;
- limiting reset selection and queued-goal `notBefore` persistence;
- one plan-only refinement per wait boundary and no implementation dispatch while denied;
- Inbox projection for scheduled, running, attention, completion, reject, and defer transitions; and
- one server integration path from proposal creation through approval, arming, quota wait, reset recheck, and dispatch eligibility.

Repository completion requires focused `bun run test` suites plus `bun fmt`, `bun lint`, and `bun typecheck`. `bun test` is not used.

## Out of Scope

- Replacing proposal or Automode persistence with the Inbox.
- A second execution scheduler or quota timer.
- Predicting token consumption or inventing a synthetic reset when telemetry is missing.
- Browser permission management or guaranteed PWA/Telegram delivery.
- Automatic merge or bypassing held-PR review.
- Cross-device per-user read state; the current cockpit is a single-operator system.
- Arbitrary Inbox search, bulk deletion, labels, or retention configuration.
