# Cockpit Proposal Notifications and Approval Design

**Status:** Approved  
**Date:** 2026-08-08

## Objective

Complete the path from Motoko finding useful work to an operator-approved Automode run. Motoko may propose:

- continuing useful work discovered in past GITS threads; or
- improvements inferred from repeated patterns in configured repositories.

The operator receives independently configurable GITS/PWA and Telegram notifications, opens the exact proposal in the cockpit, edits its proposal and execution values, then approves, defers, or rejects it. Approval queues the edited proposal for the guarded Automode schedule; it does not bypass policy, verification, or held-PR review.

## Existing Components Reused

- `HermesProposalCard` and the Hermes proposal JSON store.
- `HermesAutomodeBridge` for approved proposal to Automode goal conversion.
- `GitsSlotScheduler` and `AutomodeDriver` for scheduled execution.
- `PushNotificationService` and the existing service worker for PWA delivery.
- `HermesTelegramNotifier` for Telegram delivery.
- `MotokoPanel` proposal cards and `AutopilotPanel` policy/status controls.

No second proposal store, notification framework, or scheduler is introduced.

## Notification Preferences

Automode policy gains two independent booleans:

- `gitsNotificationsEnabled`, decoding default `true`.
- `telegramNotificationsEnabled`, decoding default `false`.

Both may be enabled. Existing `telegramDigestEnabled` is replaced or migrated to the Telegram preference so one setting controls proposal and Automode attention delivery consistently.

The Autopilot panel exposes both toggles. PWA delivery still requires browser permission, an installed/eligible PWA, and configured VAPID keys. The toggle controls server delivery; it cannot grant browser permission.

## Notification Events

The server sends transition-based notifications for:

- a newly persisted Motoko proposal, including proposals from thread continuation and repository-pattern inspection;
- an approved proposal being queued for scheduled execution;
- a goal entering `blocked`, `waiting`, or `failed`;
- the Automode driver becoming halted; and
- a held PR becoming available.

Notifications are deduplicated by stable event key and persisted so server restarts and periodic ticks do not resend old transitions. Delivery failures remain non-fatal and do not alter proposal or Automode state.

Each PWA notification links to:

```text
/gits?panel=autopilot&proposal=<proposal-id>
```

Automode notifications without a proposal ID link to the relevant Autopilot section.

## Cockpit Review Flow

Opening a proposal link selects the Autopilot panel, opens the proposal review surface, and focuses the requested card. The card supports:

- title;
- execution prompt;
- repository;
- model;
- proposed run time;
- runtime limit;
- verification commands; and
- integration branch.

Title and prompt are the primary fields. Execution settings are collapsed under **Advanced**. Repository and model choices remain constrained by Automode policy. Invalid values are rejected at the server trust boundary.

Actions:

- **Approve:** atomically saves edits, marks the proposal approved, and queues one Automode goal carrying the proposal episode ID and execution overrides.
- **Defer:** saves edits and leaves the proposal out of the queue.
- **Reject:** records rejection and never queues work.

Repeated approval is idempotent for a live goal with the same episode ID.

## Scheduling Semantics

The proposed run time is a not-before value, not a second scheduler. A queued goal becomes eligible only when both conditions hold:

1. its not-before time has passed; and
2. the existing slot scheduler, arming state, capacity limits, policy gates, and kill switch allow dispatch.

Manual dispatch remains explicit and unchanged. Approval never means immediate merge; the existing verification, integration-branch, and held-PR safeguards remain mandatory.

## Proposal Sources

The first end-to-end slice supports the existing repository inspection sweep and adds a continuation sweep over persisted thread summaries. Both sources produce the same `HermesProposalCard` shape and enter the same review flow. Continuation proposals must name the source thread and explain why work remains; pattern proposals must cite repository evidence. Raw historical transcripts are not copied into notifications.

## Testing

One focused test per non-trivial seam:

- schema defaults and preference updates;
- proposal edit/decision validation and idempotent enqueue;
- notification transition selection and persisted deduplication;
- independent PWA/Telegram routing;
- deep-link parsing and proposal focus;
- not-before scheduling gate; and
- one server integration test proving proposal creation → notification → edited approval → queued goal.

Repository completion requires `bun fmt`, `bun lint`, and `bun typecheck`, plus focused `bun run test` suites. `bun test` is not used.

## Out of Scope

- automatic merging;
- a second scheduling engine;
- notification inbox persistence beyond proposal/Automode state;
- editing arbitrary Automode policy from a proposal;
- pushing full prompts or sensitive repository evidence into notification bodies.
