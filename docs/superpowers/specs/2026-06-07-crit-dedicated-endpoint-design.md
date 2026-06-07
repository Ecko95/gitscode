# Crit dedicated thread-scoped endpoints — design

**Date:** 2026-06-07
**Branch:** `feat/crit-pr-review-integration` (PR #22 → base `gits`)
**Status:** Approved, ready for planning

## Problem

The crit sidecar's per-sidecar bearer token is currently minted with `role:"owner"`
(`crit-sidecar-manager.ts`, 2h TTL, revoked on teardown). It must be `owner` because the
wrapper CLI calls the broad, owner-gated orchestration endpoints:

- `POST /api/orchestration/dispatch` — accepts **any** `ClientOrchestrationCommand`, gated by
  `authenticateOwnerSession` (`apps/server/src/orchestration/http.ts`).
- `GET /api/orchestration/snapshot` — the full read model, same owner gate.

A leaked sidecar token therefore grants full owner control over the loopback API. The role model
is only `"owner" | "client"`, so a role swap alone gives no real scoping — **the endpoint is the
broad capability**. The fix is to add narrow, thread-scoped endpoints the wrapper uses instead, and
mint the token with the least privilege those endpoints require.

## Key constraint discovered during design

The handoff's recommended design assumed `POST /api/crit/turn` could synchronously return the new
`{ turnId }`. The code shows otherwise:

- `OrchestrationEngineService.dispatch` returns only `{ sequence }`.
- A `thread.turn.start` command emits `thread.message-sent` + `thread.turn-start-requested`; the
  **turnId is generated asynchronously** by the provider runtime (`ProviderCommandReactor` →
  provider stream ingestion), well after the dispatch returns.
- The read model's `latestTurn` carries `turnId`/`state`/`assistantMessageId` but has **no field
  linking a turn back to its originating user message**. The only correlation key available is
  "a turn that was not present before this dispatch."

So turnId cannot be returned synchronously, and turn correlation must be baseline-based regardless.
The chosen design (Option A) keeps that baseline server-side and exposes it as an opaque token.

## Authorization model

- **Token minting** (`crit-sidecar-manager.ts`): change
  `issueSession({ role: "owner", … })` →
  `issueSession({ role: "client", subject: input.threadId, … })`.
  Keep the existing 2h TTL and the revoke-on-teardown scope finalizer unchanged. Replace the stale
  "still owner for v1" NOTE comment with one describing the subject-bound least-privilege token.
- **Authorization rule** on the new endpoints: authenticate via
  `ServerAuth.authenticateHttpRequest`, then require `session.subject === threadId` (threadId taken
  from the request body for POST, query string for GET). Mismatch → **403**.
- We deliberately do **not** gate on role — the subject binding *is* the capability. threadIds are
  unguessable UUIDs and ordinary client sessions carry `subject = "cli-issued-session"` (or a
  pairing subject), never a threadId, so `subject === threadId` is a strong, narrow capability.
- The client-role token automatically fails the existing `role !== "owner"` gate on
  `/api/orchestration/*`, so the broad endpoints remain unreachable by the sidecar token. This is
  asserted by a test.

`AuthControlPlane.issueSession` already honors `subject` and `role`
(`apps/server/src/auth/Layers/AuthControlPlane.ts:109`), and `authenticateHttpRequest` populates
`session.subject` from the verified token (`apps/server/src/auth/Layers/ServerAuth.ts:81`), so no
auth-core changes are required.

## Endpoints

New file `apps/server/src/crit/critHttp.ts`, mirroring the route/auth/error patterns in
`apps/server/src/orchestration/http.ts`.

### `POST /api/crit/turn` — body `{ threadId, text }`

1. Authenticate; require `session.subject === threadId`, else 403.
2. `ProjectionSnapshotQuery.getThreadDetailById(threadId)`; if `None` → 404.
3. Capture `priorTurnId = thread.latestTurn?.turnId ?? null`.
4. Build a `thread.turn.start` command **server-side**: the given `threadId` and `text`, a freshly
   generated `commandId` and message `messageId`, `role:"user"`, empty `attachments`,
   `runtimeMode:"full-access"`, `interactionMode:"default"`, `createdAt` now.
5. Normalize (`normalizeDispatchCommand`) and dispatch via `OrchestrationEngineService.dispatch`.
6. Return `{ priorTurnId }` (`string | null`), status 200.

The endpoint is generic: it starts a turn with caller-supplied text on the caller's own thread. It
has no crit-specific knowledge — review-comment formatting stays in the wrapper.

### `GET /api/crit/turn-status?threadId=…&priorTurnId=…` (priorTurnId optional)

1. Authenticate; require `session.subject === threadId`, else 403.
2. `getThreadDetailById(threadId)`; if `None` → 404.
3. Compute the response via a pure `compute_turn_status(thread, priorTurnId)`:
   - no `latestTurn`, OR `latestTurn.turnId === priorTurnId`, OR `state === "running"`
     → `{ state: "pending", assistantMessageId: null, reply: null }`
   - `state === "completed"`: locate the message whose `id === assistantMessageId`; if absent (not
     projected yet) → `pending`; else
     `{ state: "completed", assistantMessageId, reply: <message.text> }`
   - `state === "error"` → `{ state: "error", assistantMessageId: null, reply: null }`
   - `state === "interrupted"` (or any other terminal) →
     `{ state: "interrupted", assistantMessageId: null, reply: null }`

`compute_turn_status` is the load-bearing race logic, kept pure and unit-tested directly.

## Wrapper changes (`apps/server/src/crit/crit-agent-cli.ts`)

- **Remove:** `read_snapshot`, the `Snapshot`/`SnapshotThread` interfaces, `find_thread`, and all
  baseline/stale-turn logic (it becomes server-side and unnecessary here).
- **Keep:** `parse_crit_payload` and the review-comment-block formatting (crit stdin → message text
  stays in the wrapper via `build_review_comment_block`).
- **New `run_crit_agent` flow:**
  1. `comment = parse_crit_payload(stdin)`; format the `<review_comment>` block text.
  2. `POST /api/crit/turn { threadId, text }` → `{ priorTurnId }`.
  3. Poll `GET /api/crit/turn-status?threadId&priorTurnId` every `pollMs` until the deadline:
     `pending` → continue; `completed` → return `reply`; `error` → return the error ack;
     `interrupted`/other terminal → break.
  4. On timeout return the existing "Sent to GITS — still working" ack.
- Keep the
  `// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalDate:off globalTimers:off`
  header — it remains a standalone non-Effect CLI.

## Contracts (`packages/contracts/src/crit.ts`)

Add schemas for server-side `HttpServerRequest.schemaBodyJson` validation and typed tests:

- `CritTurnRequest` — `{ threadId, text }`
- `CritTurnResponse` — `{ priorTurnId: string | null }`
- `CritTurnStatusResponse` — `{ state: "pending" | "completed" | "error" | "interrupted",
  assistantMessageId: string | null, reply: string | null }`

The wrapper is standalone fetch-based and does not import contracts; these are for the server and
its tests.

## Registration & error handling

- Register both route layers in `apps/server/src/server.ts` alongside the orchestration routes
  (the two registration sites near lines 103 and 381).
- Error mapping mirrors `respondToOrchestrationHttpError` via a `CritHttpError` tag:
  401 unauthenticated (from `authenticateHttpRequest`), 403 subject mismatch, 400 invalid body,
  404 unknown thread, 500 projection failure.

## Testing (TDD)

- **Pure `compute_turn_status`:** every branch — pending (no turn / turnId equals prior / running /
  completed-but-message-unprojected), completed→reply, error, interrupted.
- **Routes (`critHttp.test.ts`):**
  - a `subject`-bound token reaches only its own thread;
  - **a token for thread A is rejected (403) for thread B** — the core security property, made
    load-bearing;
  - missing/invalid token → 401;
  - **a client-role token is rejected (403) on `/api/orchestration/dispatch`** — owner endpoints
    stay unreachable.
- **Wrapper (`crit-agent-cli.test.ts`):** mock the two new endpoints; assert POST-then-poll returns
  the completed reply; a `pending → completed` transition is handled; the timeout path returns the
  ack.

## Out of scope (still deferred)

Real crit CLI flags (Task 0b), `agent_cmd` stdin format (Task 0c), per-platform binary bundling
(Phase 7), and live E2E (Phase 8) remain PENDING per `docs/crit-integration-notes.md`. This change
is verified entirely through the new endpoints' own server tests plus the wrapper unit tests; it is
not exercised against a live crit binary.

## Files touched

- New: `apps/server/src/crit/critHttp.ts`, `apps/server/src/crit/critHttp.test.ts`
- `apps/server/src/crit/crit-sidecar-manager.ts` — token role/subject + NOTE comment
- `apps/server/src/crit/crit-agent-cli.ts` (+ `.test.ts`) — repoint and simplify
- `apps/server/src/server.ts` — register the two route layers
- `packages/contracts/src/crit.ts` (+ `crit.test.ts`) — request/response schemas

## Security review

This change adds new authenticated HTTP surface. A mandatory security review (via
`security-reviewer` and/or `superpowers:requesting-code-review`) must confirm the
`subject === threadId` check is airtight before merge — a bug here is worse than the current
loopback owner token.
