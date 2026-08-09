# Cockpit proposal notifications handoff — 2026-08-09

## Workspace state

- Repository: `/srv/gits/repos/gitscode/.worktrees/cockpit-proposal-notifications`
- Branch: `feat/cockpit-proposal-notifications`
- Feature commit: `2683dd07b feat(gits): add cockpit proposal notifications`
- Design: `docs/superpowers/specs/2026-08-08-cockpit-proposal-notifications-design.md`
- Implementation plan: `docs/superpowers/plans/2026-08-08-cockpit-proposal-notifications.md`

## Completed

- Motoko proposals can originate from repository inspection or unfinished persisted threads.
- New proposal, queued, waiting, blocked, failed, halted, landed, and held-PR transitions route through independently configurable GITS/PWA and Telegram channels.
- Notification delivery reuses the existing PWA push service, uses stable event keys, and persists deduplication state.
- Proposal notification links open the Autopilot review surface and focus the requested proposal.
- The review surface edits title, prompt, repository, model, not-before time, runtime limit, verification commands, and integration branch.
- Approve validates repository/model policy, saves edits, and queues one episode-deduplicated Automode goal. Defer and reject do not queue work.
- Approved goals retain the existing scheduler, quota, runtime, concurrency, verification, integration-branch, and held-PR safeguards.
- A proposal with `notBefore` in the future stays queued. Per-goal runtime, verification, and integration settings flow into dispatch.
- A completion review was performed; its important findings were addressed before commit.

## Verification evidence

- `bun fmt` — passed.
- `bun lint` — passed with existing repository warnings and zero errors.
- `bun typecheck` — all 14 workspaces passed.
- Contracts: 250 tests passed.
- GITS web suites: 74 tests passed.
- GITS/server affected suites: 467 tests passed after the final expectation update.
- Final `apps/server/src/server.test.ts`: 96 tests passed.

## Operational requirements

- PWA delivery still requires configured VAPID keys, browser notification permission, and an eligible/installed PWA.
- Telegram delivery still requires its existing notifier configuration.
- The Cockpit toggles control server delivery; they cannot grant browser permission.

## Newly approved follow-up direction

The operator wants approval reduced to one meaningful click:

1. **Approve** should queue the proposal and automatically enable/arm the current or next eligible night.
2. The scheduler should continue enforcing allowed repo/model, runtime, concurrency, night-window, five-hour, and weekly quota gates.
3. Missing or stale quota telemetry must **wait and notify**, replacing the scheduler's current fail-open behavior.
4. Insufficient quota should leave the goal queued until the relevant five-hour or weekly reset. If execution does not fit safely, Motoko should produce/refine the plan without starting implementation, then schedule implementation after reset.
5. Add a durable Cockpit Inbox as the source of truth. PWA and Telegram become optional delivery channels for Inbox events.
6. Inbox items show live work state: pending review, approved/queued, waiting for quota/reset, scheduled tonight, running, attention required, completed, rejected, or deferred.
7. Each item retains its notification timeline, unread state, timestamps, reason, and deep link to the proposal or Automode goal. Filters: Unread, Pending, Approved, Waiting, Completed.

## Important current-code facts for the follow-up

- `GitsSlotScheduler.capacityDecision` already reads both `5h` and `weekly` windows.
- Current thresholds are `CAPACITY_MAX_USED_PERCENT_5H` and `weeklyMaxUsedPercent` (default 80%).
- Missing capacity telemetry currently returns an informational note and allows execution. Change this to a denied decision with reset-aware notification.
- The capacity windows already expose `resetAt`; use the limiting window's reset rather than creating another clock or scheduler.
- Approval currently queues reliably, but automatic scheduler enable/arm is not yet part of approval.
- There is no durable unified Inbox yet. Do not treat push-delivery deduplication storage as the Inbox data model.

## Next-session process

The follow-up is still in brainstorming. Architecture/data flow was approved, but the written spec and implementation plan have not been created. Continue the brainstorming workflow, settle retention (the recommendation was 90 days with pinning), write and commit a focused spec, obtain operator review, then produce the implementation plan before editing code.
