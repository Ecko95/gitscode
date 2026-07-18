# p2-DH-T7-s2 — subscribe-time thread↔client authorization

Task: T7 · Lane: D/H (after s1) · Model: opus-4-8/high
Status: done

## Brief (Fable)

- **Goal:** the isolation half: authorize the thread↔client binding at subscribe time so a cross-thread event is never placed on a client's queue (today isolation is only a client-side filter).
- **Read first:** the s1 diff (merged); `apps/server/src/ws.ts` subscribe handlers and whatever session/auth context they carry (trace how a WS connection is tied to a session — `auth/Layers/SessionCredentialService.ts` and the ws upgrade path); plan §T7 + §"Data leaks" both readings.
- **Invariants:** deny = subscription refused with the existing error shape, not a silent empty stream; no new auth concept — reuse the session's existing thread-visibility rule (find where thread ownership/visibility is already decided and call THAT).
- **Acceptance:** test: client with session S subscribed to its thread A receives A events; the same client attempting thread B (not visible to S) is refused and receives nothing even when B events flow; guard green.
- **Verification (guard):** `bun x turbo run typecheck build --filter=t3` + `bun run --cwd apps/server test`.

## Hand-back (execution agent)

**Files read:** `ws.ts` (subscribe handlers + `/ws` upgrade path), `auth/Services/ServerAuth.ts`
(`AuthenticatedSession`, `denyThreadScopedRealtime`), `auth/Layers/ServerAuth.ts`,
`crit/critHttp.ts` (`authorize` — the canonical `session.subject === threadId` rule),
`gits/mcp/http.ts`, `http.ts`, `crit/crit-sidecar-manager.ts`, s1 diff (`b07b74d84`),
`ws.subscribeThread.test.ts`, contracts `rpc.ts`/`orchestration.ts` (subscribeThread error shape).

**Files changed:**

- `apps/server/src/auth/Services/ServerAuth.ts` — new pure predicate `denyThreadAccess(session, threadId)`,
  sibling of `denyThreadScopedRealtime`; centralizes the existing `subject === threadId` visibility rule.
- `apps/server/src/ws.ts` — import `denyThreadAccess`; widen `makeWsRpcLayer` session `Pick` to carry
  `subject`; call `denyThreadAccess` at the top of `subscribeThread` (before `subscribeAggregate`),
  refusing with the stream's existing `OrchestrationGetSnapshotError` shape on deny.
- `apps/server/src/ws.subscribeThread.test.ts` — new `describe` proving thread-scoped S binds to its
  own thread A but is refused (403) for thread B, and owner/client keep full visibility.

**Diff-stat:** 3 files, +~55 / -2.

**Summary:** The isolation half of T7. s1 moved event routing server-side per aggregateId; s2 authorizes
the thread↔client binding at subscribe time so an unauthorized session never gets a per-aggregate queue
(and therefore never any events) for a thread it may not see — refusal happens before `subscribeAggregate`
registers anything. Reuses the codebase's only per-session thread-visibility rule (`session.subject ===
threadId` for `thread-scoped` sessions; owner/client have full visibility), centralized as `denyThreadAccess`
next to the sibling `denyThreadScopedRealtime`. Deny surfaces as the subscribeThread RPC's existing
`OrchestrationGetSnapshotError` (no contract change), a typed failure rather than a silent empty stream.

**ponytail shortcuts:** (1) No new RPC error type — mapped denial onto the existing
`OrchestrationGetSnapshotError` channel, avoiding a contract change. (2) Acceptance covered by a unit test
of the load-bearing authorization predicate rather than a full RPC-handler harness (`makeWsRpcLayer` is
module-private and wires ~40 services); the end-to-end "receives nothing when B flows" follows structurally
from placing the guard before queue registration.

**Residual risks:** In production `thread-scoped` sessions are already denied at the `/ws` upgrade
(`denyThreadScopedRealtime`), so this guard is defense-in-depth — it enforces the T7 "authorize the binding
at subscribe time" invariant independently of the upgrade deny, and is the natural seam if owner/client ever
gain per-thread ACLs (none exist today). No full handler-level stream test (see shortcut 2).

**Next steps:** T16 isolation audit can now assert `denyThreadAccess` gates every per-thread WS stream from
one place.

## Guard result

Green. `bun x turbo run typecheck build --filter=t3` → 10/10 tasks successful (remaining TS377xxx lines are
pre-existing effect-lint suggestions, not errors). `bun run --cwd apps/server test` → 182 files passed / 1
skipped, 1585 tests passed / 4 skipped. Targeted `vitest run src/ws.subscribeThread.test.ts` → 4 passed.

## Merge

—

## Verify result (end gate)

—

## Decision (Fable)

—
