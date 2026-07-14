# Hermes Telegram Phase 2 Design

## Goal

Let the existing GITS/Motoko/Hermes Telegram channel receive concise autonomy updates and issue the six ratified phone controls without adding a Telegram client, bot token, poller, or second chat identity to Gits.

## Decision

Gits reuses the installed Hermes gateway. Outbound delivery invokes the existing `hermes send --to telegram --quiet` command under `GITS_HERMES_HOME`. Inbound Telegram messages remain owned by Hermes; its GITS profile relays only fixed control commands to a localhost-only Gits endpoint. Gits—not Hermes or the language model—parses, authorizes, and executes the command.

## Scope

Phase 2 delivers these commands:

| Telegram command | Gits operation | Required argument | Result |
| --- | --- | --- | --- |
| `APPROVE <goal-id>` | `AutomodeSupervisor.approveGoal` | goal ID | Queued goal becomes approved. |
| `REJECT <goal-id>` | `AutomodeSupervisor.rejectGoal` | goal ID | Goal is rejected. |
| `DEFER <goal-id>` | `AutomodeSupervisor.rejectGoal` | goal ID | Goal is rejected with the fixed reason `Deferred by operator.`; resurfacing is a later ideation feature. |
| `ARM` | `GitsSlotScheduler.arm` | none | Arms the already-configured scheduler. |
| `SKIP <goal-id>` | `AutomodeSupervisor.rejectGoal` | goal ID | Goal is rejected with the fixed reason `Skipped by operator.` |
| `STOP` | `AutomodeSupervisor.updatePolicy` plus `DelamainAdapter.killPeer` | none | Enables the kill switch before terminating every running automode peer, then reports the result. |

Telegram cannot alter the scheduler configuration, policy, budget, repo allowlist, model allowlist, verification commands, or integration branch. `ARM` respects the existing scheduler-enabled check. A command is idempotent where the underlying operation already is; repeated `STOP` remains safe and returns the current halted state.

## Architecture

`HermesTelegramNotifier` is a small Gits Effect service backed by the already configured `hermes` binary. Its one operation accepts rendered, non-secret text and runs the fixed argument prefix `send --to telegram --quiet`; it never reads Telegram credentials.

The server exposes one loopback-only `POST /api/gits/hermes-telegram/command` route. It accepts `{ command: string }`, requires an exact bearer token from `GITS_HERMES_TELEGRAM_RELAY_TOKEN`, rejects non-loopback requests, and maps the six exact command forms to the existing supervisor/scheduler/Delamain services. No generic RPC method name or arbitrary JSON payload crosses this boundary. The response is plain, bounded status text for Hermes to send back into the same Telegram conversation.

The GITS Hermes profile gains a short command relay instruction: recognize only the six uppercase command forms, POST the original command to the loopback route with the relay token, and return the route’s text verbatim. Ordinary Telegram chat stays Hermes chat; malformed or unsupported commands receive the fixed help text and cause no Gits action.

The server emits notifications through the notifier for: a driver halt, a held PR opened, a terminal peer failure, the 22:00 digest, the 10:00 morning report, and Codex auth-chain death. Delivery failure is logged and does not change automode state; the control command’s state transition succeeds independently of the acknowledgment notification.

## Security and failure handling

- Hermes remains the sole Telegram credential holder and long-poll owner.
- The relay token is separate from server session credentials, supplied only to the local Hermes gateway and Gits server service; it is never returned by an RPC, HTTP response, status screen, log line, or notification.
- The route rejects missing/incorrect tokens, remote callers, non-string bodies, unsupported verbs, missing goal IDs, and extra command arguments before touching state.
- `STOP` is fail-closed: persist the kill switch first; then attempt peer termination individually and report failures without re-enabling execution.
- The notifier has a bounded command timeout and treats nonzero `hermes send` exit status as a typed delivery failure.

## Testing

Unit-test exact command parsing and every allowed/rejected form. Route tests prove token and loopback enforcement, prove unsupported inputs cannot reach services, and assert each command calls only its declared existing service operation. Notifier tests assert the exact Hermes argv and verify delivery failure is non-mutating. A focused driver integration test proves a halt produces a notification attempt without changing the halt outcome.

## Deployment

Set one high-entropy `GITS_HERMES_TELEGRAM_RELAY_TOKEN` in both the Gits server service environment and the Hermes gateway’s managed environment. Keep `GITS_HERMES_HOME` pointed at the existing profile, where Telegram is already configured. No bot token, chat ID, npm package, database migration, web UI, or external listener is added.

## Non-goals

Message buttons, free-form natural-language control, proposal resurfacing, changing configuration from Telegram, multi-repo routing, web push, and the cockpit episode review surface are outside Phase 2.
