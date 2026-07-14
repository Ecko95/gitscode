# Hermes Telegram Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the six allowlisted Telegram autonomy controls and Phase 2 notifications by reusing the configured Hermes GITS Telegram channel.

**Architecture:** Gits owns a minimal `HermesTelegramNotifier` Effect service that executes the existing Hermes `send` subcommand with a fixed Telegram target. A loopback-only, relay-token-protected HTTP route parses exactly six text commands and calls existing automode/scheduler services; Hermes remains the Telegram poll owner and relays requests to that route.

**Tech Stack:** TypeScript, Effect, Effect HTTP router, Effect Schema, Vitest, existing Hermes CLI.

## Global Constraints

- Reuse `hermes send --to telegram --quiet`; do not add a Telegram package, bot token, poller, or second chat identity.
- The command route accepts only `APPROVE <goal-id>`, `REJECT <goal-id>`, `DEFER <goal-id>`, `ARM`, `SKIP <goal-id>`, and `STOP`.
- Commands never update policy/configuration except `STOP`, which only enables the existing kill switch.
- The route is loopback-only and requires the exact `GITS_HERMES_TELEGRAM_RELAY_TOKEN` bearer token.
- `STOP` persists the kill switch before attempting every active peer termination.
- Run `bun fmt`, `bun lint`, and `bun typecheck`; run tests with `bun run test`.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `apps/server/src/gits/Services/HermesTelegramNotifier.ts` | Small outbound notification service contract. |
| `apps/server/src/gits/Layers/HermesTelegramNotifier.ts` | Fixed-argv `hermes send` implementation. |
| `apps/server/src/gits/Layers/HermesTelegramNotifier.test.ts` | No-network argv and error handling tests. |
| `apps/server/src/gits/HermesTelegramCommand.ts` | Pure strict command parser and dispatch function. |
| `apps/server/src/gits/HermesTelegramCommand.test.ts` | Every allowed and malformed command test. |
| `apps/server/src/gits/http.ts` | Guarded relay route. |
| `apps/server/src/gits/http.test.ts` | Route token, loopback, and service-wiring tests. |
| `apps/server/src/config.ts` | Relay-token runtime configuration. |
| `apps/server/src/server.ts` | Provide notifier and route dependencies. |
| `apps/server/src/gits/Services/AutomodeTelegramDigest.ts` | Persisted once-per-London-day digest/report scheduling service. |
| `apps/server/src/gits/Layers/AutomodeTelegramDigest.ts` | Render and send the 22:00 digest and 10:00 morning report. |
| `apps/server/src/gits/Layers/AutomodeTelegramDigest.test.ts` | Clock-driven digest/report and restart-deduplication tests. |
| `apps/server/src/gits/Layers/AutomodeDriver.ts` | Emit halt and held-PR notifications without changing outcomes. |
| `apps/server/src/gits/Layers/HermesCliAdapter.ts` | Emit the Codex auth-chain-death alert. |
| `profiles/motoko-gits/SOUL.md` | Hermes relay instruction for the six exact commands. |
| `docs/gits/HERMES.md` | Deployment instructions for the relay token and behaviour. |

## Task 1: Outbound Hermes notifier

**Files:**

- Create: `apps/server/src/gits/Services/HermesTelegramNotifier.ts`
- Create: `apps/server/src/gits/Layers/HermesTelegramNotifier.ts`
- Test: `apps/server/src/gits/Layers/HermesTelegramNotifier.test.ts`

**Interfaces:**

- Produces `HermesTelegramNotifier.notify({ subject, text }): Effect<void, HermesTelegramNotifierError>`.
- Uses the existing `GITS_HERMES_HOME` resolution from `HermesCliAdapter.ts`.

- [ ] **Step 1: Write the failing notifier tests.** Assert the process runner receives exactly:

  ```ts
  ["send", "--to", "telegram", "--quiet", "--subject", "GITS", "hello"]
  ```

  Assert a non-zero exit becomes `HermesTelegramNotifierError` and no network client is constructed.

- [ ] **Step 2: Run the focused test.**

  ```bash
  cd apps/server && bun run test -- src/gits/Layers/HermesTelegramNotifier.test.ts
  ```

  Expected: fail because the service does not exist.

- [ ] **Step 3: Implement the smallest service.** Use `execFile` with a 30-second timeout, `makeHermesEnv(resolveHermesHome().hermesHome)`, and the fixed `send` argv; never accept a platform or binary argument from a caller.

- [ ] **Step 4: Re-run the focused test.** Expected: pass.

- [ ] **Step 5: Commit.**

  ```bash
  /usr/bin/git add apps/server/src/gits/Services/HermesTelegramNotifier.ts apps/server/src/gits/Layers/HermesTelegramNotifier.ts apps/server/src/gits/Layers/HermesTelegramNotifier.test.ts
  /usr/bin/git commit -m "feat(gits): reuse Hermes Telegram sender"
  ```

## Task 2: Strict command parser and existing-service dispatcher

**Files:**

- Create: `apps/server/src/gits/HermesTelegramCommand.ts`
- Test: `apps/server/src/gits/HermesTelegramCommand.test.ts`

**Interfaces:**

- Consumes `AutomodeSupervisor`, `GitsSlotScheduler`, and `DelamainAdapter`.
- Produces `parseHermesTelegramCommand(text)` and `dispatchHermesTelegramCommand(command)` returning bounded response text.

- [ ] **Step 1: Write failing parser/dispatcher tests.** Cover all six forms plus lowercase verbs, trailing arguments, missing goal IDs, unknown verbs, and an empty command. Assert `DEFER` and `SKIP` call `rejectGoal` with their fixed reason, and `STOP` calls `updatePolicy({ killSwitchEnabled: true })` before any `killPeer` call.

- [ ] **Step 2: Run the focused test.**

  ```bash
  cd apps/server && bun run test -- src/gits/HermesTelegramCommand.test.ts
  ```

  Expected: fail because the parser does not exist.

- [ ] **Step 3: Implement exact whitespace-normalized matching.** Return a tagged union, not an unbounded command object. For `STOP`, read the snapshot after enabling the kill switch, call `killPeer({ peerId })` for each goal with a peer ID and a running/pending status, collect failures into the bounded response, and never turn the kill switch off.

- [ ] **Step 4: Re-run the focused test.** Expected: pass.

- [ ] **Step 5: Commit.**

  ```bash
  /usr/bin/git add apps/server/src/gits/HermesTelegramCommand.ts apps/server/src/gits/HermesTelegramCommand.test.ts
  /usr/bin/git commit -m "feat(gits): add guarded Hermes Telegram controls"
  ```

## Task 3: Loopback relay route

**Files:**

- Modify: `apps/server/src/config.ts`
- Modify: `apps/server/src/gits/http.ts`
- Modify: `apps/server/src/gits/http.test.ts`
- Modify: `apps/server/src/server.ts`

**Interfaces:**

- Consumes `config.hermesTelegramRelayToken` and the Task 2 dispatcher.
- Produces `POST /api/gits/hermes-telegram/command` with `{ command: string }` and `{ text: string }` JSON responses.

- [ ] **Step 1: Write failing route tests.** Assert 403 for non-loopback hosts, 401 for missing/wrong bearer tokens, 400 for malformed JSON, and 200 for a valid relay command. Assert the valid route reaches only the expected Task 2 service operation.

- [ ] **Step 2: Run the focused route test.**

  ```bash
  cd apps/server && bun run test -- src/gits/http.test.ts
  ```

  Expected: fail because the relay route is absent.

- [ ] **Step 3: Add configuration and route.** Resolve `GITS_HERMES_TELEGRAM_RELAY_TOKEN`; when it is absent, make the route return 503 without parsing commands. Compare the authorization header with `timingSafeEqual` only after equal-length validation. Reuse `isLoopbackHostname` and `HttpRouter.add`.

- [ ] **Step 4: Re-run the focused route test.** Expected: pass.

- [ ] **Step 5: Commit.**

  ```bash
  /usr/bin/git add apps/server/src/config.ts apps/server/src/gits/http.ts apps/server/src/gits/http.test.ts apps/server/src/server.ts
  /usr/bin/git commit -m "feat(gits): add Hermes Telegram relay route"
  ```

## Task 4: Persisted digest, morning report, and chain-death alert

**Files:**

- Create: `apps/server/src/gits/Services/AutomodeTelegramDigest.ts`
- Create: `apps/server/src/gits/Layers/AutomodeTelegramDigest.ts`
- Test: `apps/server/src/gits/Layers/AutomodeTelegramDigest.test.ts`
- Modify: `apps/server/src/gits/Layers/HermesCliAdapter.ts`
- Modify: `apps/server/src/server.ts`

**Interfaces:**

- Consumes the Task 1 notifier, `AutomodeSupervisor.getSnapshot`, `GitsSlotScheduler.getSnapshot`, `AutomodeEpisodeLedger.list_episodes`, and `Clock`.
- Produces `AutomodeTelegramDigest.tick(): Effect<void>` and persists the last successful London date for each report in its own state file under `config.stateDir/gits`.

- [ ] **Step 1: Write failing digest tests.** Set a London test clock at 22:00 and 10:00. Assert each rendered message is delivered once per London date, a send failure is retried on the following tick, and a fresh layer reading the state file does not duplicate a successfully delivered report. Assert the digest includes at most five queued/proposed goal titles and the report includes held PR URL, terminal outcomes, and scheduler goal count.

- [ ] **Step 2: Run the focused digest test.**

  ```bash
  cd apps/server && bun run test -- src/gits/Layers/AutomodeTelegramDigest.test.ts
  ```

  Expected: fail because the digest service does not exist.

- [ ] **Step 3: Implement the narrow persisted scheduler.** Store only `{ version: 1, lastDigestDate: string | null, lastMorningReportDate: string | null }` with the existing atomic JSON persistence pattern. Calculate London date/time using the Phase 1 scheduler helper; do not add a cron process. Call `tick()` from the existing driver tick and persist a date only after `notify` succeeds.

- [ ] **Step 4: Add the auth-chain alert.** When `codexChainPreflight` blocks a Hermes invocation because Codex credentials are expired or revoked, notify with the fixed re-login instruction already returned by the adapter. Bound repeats to one alert per process for the same reason so a blocked chat does not flood Telegram.

- [ ] **Step 5: Re-run the focused tests.**

  ```bash
  cd apps/server && bun run test -- src/gits/Layers/AutomodeTelegramDigest.test.ts src/gits/Layers/HermesCliAdapter.test.ts
  ```

  Expected: pass.

- [ ] **Step 6: Commit.**

  ```bash
  /usr/bin/git add apps/server/src/gits/Services/AutomodeTelegramDigest.ts apps/server/src/gits/Layers/AutomodeTelegramDigest.ts apps/server/src/gits/Layers/AutomodeTelegramDigest.test.ts apps/server/src/gits/Layers/HermesCliAdapter.ts apps/server/src/server.ts
  /usr/bin/git commit -m "feat(gits): send Hermes Telegram reports and auth alerts"
  ```

## Task 5: Driver notifications and Hermes profile documentation

**Files:**

- Modify: `apps/server/src/gits/Layers/AutomodeDriver.ts`
- Modify: `apps/server/src/gits/Layers/AutomodeDriver.test.ts`
- Modify: `profiles/motoko-gits/SOUL.md`
- Modify: `docs/gits/HERMES.md`

**Interfaces:**

- Consumes `HermesTelegramNotifier.notify` from Task 1.
- Preserves all existing driver results if notification delivery fails.

- [ ] **Step 1: Write a failing driver test.** Make the notifier fail during a scheduler-recording halt and assert the halt and queued goal assertions still pass while one notification attempt is observed.

- [ ] **Step 2: Run the focused driver test.**

  ```bash
  cd apps/server && GITS_REAL_GIT=/usr/bin/git bun run test -- src/gits/Layers/AutomodeDriver.test.ts
  ```

  Expected: fail because the notifier is not injected.

- [ ] **Step 3: Add non-blocking alerts.** Notify on driver halts and held-PR creation with title, goal ID, reason, and PR URL when present. Call the Task 4 digest service from the existing tick after the normal driver outcome; notification failure is logged and does not change the driver result.

- [ ] **Step 4: Add exact Hermes relay instructions.** The profile must recognize only the six command forms, call the local route with the bearer token, and return response text verbatim; malformed input returns the route's help message. Document the two service environment variables and that Hermes remains the sole Telegram long-poll owner.

- [ ] **Step 5: Re-run the focused test.** Expected: pass.

- [ ] **Step 6: Commit.**

  ```bash
  /usr/bin/git add apps/server/src/gits/Layers/AutomodeDriver.ts apps/server/src/gits/Layers/AutomodeDriver.test.ts profiles/motoko-gits/SOUL.md docs/gits/HERMES.md
  /usr/bin/git commit -m "feat(gits): notify Hermes Telegram for automode events"
  ```

## Task 6: Verify and hand off

**Files:** No production changes.

- [ ] **Step 1: Run Phase 2 tests.**

  ```bash
  cd apps/server && GITS_REAL_GIT=/usr/bin/git bun run test -- src/gits/Layers/HermesTelegramNotifier.test.ts src/gits/HermesTelegramCommand.test.ts src/gits/http.test.ts src/gits/Layers/AutomodeTelegramDigest.test.ts src/gits/Layers/HermesCliAdapter.test.ts src/gits/Layers/AutomodeDriver.test.ts
  ```

  Expected: all selected files pass.

- [ ] **Step 2: Run repository gates.**

  ```bash
  cd ../.. && bun fmt && bun lint && bun typecheck
  ```

  Expected: format, lint, and typecheck pass; report existing warning-only output separately.

- [ ] **Step 3: Inspect final scope.**

  ```bash
  /usr/bin/git diff --check origin/gits...HEAD
  /usr/bin/git status --short
  ```

  Expected: no whitespace errors and only Phase 2 changes.
