# Plan 23 — Actor Identity in the Command Envelope (W5.3)

**Status: PENDING OPERATOR APPROVAL**

**Workstream:** W5 — Security hardening  
**Predecessor context:**
- `.plans/18-server-auth-model.md` — auth surfaces and session/role model
- `docs/plan18-gap-audit-2026-07.md` — W5.1 audit (three uncovered surfaces, non-loopback startup gap)
- `.plans/21-worktree-graveyard.md` — worktree commands added to `InternalOrchestrationCommand`
- `.plans/22-event-retention-and-rebuild.md` — W4.x (downstream reads actor_kind from store)

---

## Background

Every orchestration command reaches `OrchestrationEngine.dispatch()` through one of several call sites. Today the engine does not know — and does not record — **who** issued a command: a human via the UI (operator), the automode supervisor (supervisor), or a delamain worker agent session (delamain). The `commandInvariants` module enforces state machine constraints but has no concept of actor authorization. W5.4 (audit-trail verification) depends on actor identity being trustworthy in the event store before it can verify causation chains.

---

## 1. What Already Exists vs What Is Missing

### What exists (actor_kind in storage)

Migration 001 (`apps/server/src/persistence/Migrations/001_OrchestrationEvents.ts`) already creates `actor_kind TEXT NOT NULL` on `orchestration_events`. The column is populated by `inferActorKind()` in `apps/server/src/persistence/Layers/OrchestrationEventStore.ts:71–91` using a heuristic over `commandId` prefix and metadata fields:

```ts
// Current heuristic — inferred at persist time, not stamped at dispatch time
function inferActorKind(event): "client" | "server" | "provider" {
  if (event.commandId?.startsWith("provider:")) return "provider";
  if (event.commandId?.startsWith("server:"))   return "server";
  if (event.metadata.providerTurnId !== undefined || ...) return "provider";
  if (event.commandId === null)                  return "server";
  return "client";
}
```

The schema in `packages/contracts/src/orchestration.ts:863` exposes this as:

```ts
export const OrchestrationActorKind = Schema.Literals(["client", "server", "provider"]);
```

### What is missing

1. **The three values are wrong for this use-case.** `client/server/provider` describes transport/origin, not intent. The deny-matrix needs `operator/supervisor/delamain` to enforce authorization policy.
2. **Actor identity is not in the command envelope.** `CommandEnvelope` (`OrchestrationEngine.ts:54–58`) carries only `command | result | startedAtMs`. There is no actor attached at dispatch time; `inferActorKind` reverse-engineers it from the persisted event's `commandId` prefix.
3. **Stamping is post-hoc inference, not authoritative.** Nothing prevents a future call site from using a `commandId` that hashes to the wrong actor bucket. The commandId prefix convention (`server:`, `provider:`) is undocumented and unenforced by type.
4. **`commandInvariants.ts` has no actor parameter.** Every invariant function takes `readModel + command`. None receives actor context, so authorization checks cannot be added there without a signature change.
5. **No denial receipt.** When a command is rejected by invariants today, `OrchestrationCommandInvariantError` is returned but no event is emitted and no receipt is stored. Denials based on actor identity need to be observable for W5.4.

---

## 2. Proposed Envelope Schema Change

**PENDING OPERATOR APPROVAL — do not apply without sign-off.**

The fix is to stamp actor identity at dispatch time (server-side), not infer it at persist time.

### 2a. New actor kind literals

```ts
// packages/contracts/src/orchestration.ts
// Replace the existing OrchestrationActorKind:
export const OrchestrationActorKind = Schema.Literals([
  "client",   // ponytail: keep for backward compat with pre-actor events on replay
  "server",   // internal server-originated commands (provider reactor, engine internals)
  "provider", // provider adapter ingestion
  "operator", // human via UI (WS RPC path)
  "supervisor", // automode supervisor dispatch
  "delamain",  // delamain worker-agent session via crit HTTP path
]);
```

`client`, `server`, `provider` are kept so pre-actor events (sequence < migration cutoff) decode without error. New events will use `operator`, `supervisor`, or `delamain`.

### 2b. CommandEnvelope gets actor

```ts
// apps/server/src/orchestration/Layers/OrchestrationEngine.ts
interface CommandEnvelope {
  command: OrchestrationCommand;
  actorKind: OrchestrationActorKind; // NEW — stamped by dispatch() caller, not inferred
  result: Deferred.Deferred<{ sequence: number }, OrchestrationDispatchError>;
  startedAtMs: number;
}
```

### 2c. Engine.dispatch() signature

```ts
// apps/server/src/orchestration/Services/OrchestrationEngine.ts
interface OrchestrationEngineShape {
  dispatch(
    command: OrchestrationCommand,
    actor: OrchestrationActorKind, // NEW
  ): Effect.Effect<DispatchResult, OrchestrationDispatchError>;
}
```

### 2d. EventStore uses envelope actor, not inferred

In `OrchestrationEventStore.ts`, replace the `inferActorKind(event)` call with the actor passed from the envelope. The `inferActorKind` function can remain as a fallback for replay of pre-actor events that have `commandId === null` or a legacy prefix.

---

## 3. Stamping Map — Every Dispatch Entry Point

The central invariant: **actor kind is always stamped server-side by the call site that owns the dispatch**. The client never supplies an actor value; `ClientOrchestrationCommand` has no `actor` field.

| Entry point | File:line | Stamped actor | Why it cannot be forged |
|---|---|---|---|
| WS RPC `orchestration.dispatchCommand` | `apps/server/src/ws.ts:744` | `"operator"` | All commands through this path arrive via an authenticated WebSocket session. The actor is hard-coded at the call site — the client supplies only `ClientOrchestrationCommand` (schema-validated union with no actor field). |
| Crit HTTP `POST /api/crit/turn` | `apps/server/src/crit/critHttp.ts:202` | `"delamain"` | This route is the delamain worker callback. It uses a thread-scoped bearer token issued by the crit credential system (plan 18 §crit). The route handler stamps `"delamain"` unconditionally — no client-supplied actor field exists on the request body. |
| `ProviderCommandReactor` internal dispatches | `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:224,263,624,671` | `"server"` | These run inside the server process with no client involvement. CommandIds are built with `serverCommandId(tag)` producing `server:<tag>:<uuid>`. Stamp `"server"` at call site. |
| `ProviderRuntimeIngestion` | `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:898,965,977,1053,…` | `"provider"` | Provider adapter dispatch. CommandIds built with `providerCommandId(event,tag)` producing `provider:<event>:<tag>:<uuid>`. Stamp `"provider"` at call site. |
| `WorktreeGraveyardRetirement` (`worktree.retire.start`, `worktree.bury`) | `apps/server/src/vcs/WorktreeGraveyardRetirement.ts:80,139` | `"server"` | Triggered by `ThreadDeletionReactor` or `ProviderSessionReaper` — both are internal server processes with no client path. |
| `gits/mcp/visualPlanWrite.ts` visual plan upsert | `apps/server/src/gits/mcp/visualPlanWrite.ts:83` | `"server"` | MCP tool call dispatched server-side through the visual plan registry. No client command field. |
| HTTP `POST /api/orchestration/dispatch` | `apps/server/src/orchestration/http.ts:68` | `"operator"` | Authenticated owner-session route. Same trust level as WS RPC operator path. |
| CLI (`cli/open.ts`, `cli/project.ts`) | `apps/server/src/cli/open.ts:79`, `cli/project.ts:183,231,269,309` | `"operator"` | Local CLI running as the desktop user. Semantically the same trust level as UI operator; stamp `"operator"`. |
| Automode `AutomodeSupervisor.dispatchGoal` | `apps/server/src/gits/Layers/AutomodeSupervisor.ts:601–616` | Does **not** directly call `engine.dispatch` — it calls `delamainAdapter.spawnPeer()`, which causes the agent to call back via the crit HTTP endpoint (already `"delamain"` above). | (no direct dispatch) |
| `AutomodeDriver` turn dispatch | `apps/server/src/gits/Layers/AutomodeDriver.ts:251` | `"supervisor"` | If automode ever dispatches `thread.turn.start` directly (rather than through a peer's crit callback), stamp `"supervisor"`. |

**Key finding:** The automode supervisor does not call `engine.dispatch()` directly today. It calls `delamainAdapter.spawnPeer()`, which causes the peer agent to callback via the crit HTTP endpoint. So the only actor that delamain sessions produce is `"delamain"` through the crit path. `"supervisor"` is reserved for any future direct supervisor dispatch.

---

## 4. Deny-by-Default Matrix

### Server-mutating operation set

Commands are server-mutating if they change durable state or control execution:

| Category | Commands |
|---|---|
| Session lifecycle | `thread.turn.start`, `thread.session.stop`, `thread.checkpoint.revert` |
| Thread structural | `thread.delete`, `thread.create` |
| Project structural | `project.create`, `project.delete`, `project.meta.update` |
| Config | `thread.meta.update` (model/branch), `thread.runtime-mode.set`, `thread.interaction-mode.set` |
| Worktree lifecycle | `worktree.retire.start`, `worktree.bury` (plan 21, W2.2) |

Non-mutating (read/respond): `thread.approval.respond`, `thread.user-input.respond`, `thread.archive`, `thread.unarchive`.

### Actor × command matrix

| Command group | `operator` | `supervisor` | `delamain` | `server` | `provider` |
|---|---|---|---|---|---|
| Session: `thread.turn.start` | ALLOW | ALLOW | **DENY** | n/a | n/a |
| Session: `thread.session.stop` | ALLOW | ALLOW | **DENY** | n/a | n/a |
| Session: `thread.checkpoint.revert` | ALLOW | **DENY** | **DENY** | n/a | n/a |
| Thread structural: `thread.create` | ALLOW | **DENY** | **DENY** | n/a | n/a |
| Thread structural: `thread.delete` | ALLOW | **DENY** | **DENY** | n/a | n/a |
| Project structural | ALLOW | **DENY** | **DENY** | n/a | n/a |
| Config: `thread.meta.update`, runtime/interaction mode | ALLOW | ALLOW | **DENY** | n/a | n/a |
| Respond: `thread.approval.respond`, `thread.user-input.respond` | ALLOW | **DENY** | ALLOW\* | n/a | n/a |
| Archive / unarchive | ALLOW | **DENY** | **DENY** | n/a | n/a |
| Worktree: `worktree.retire.start`, `worktree.bury` | **DENY** | **DENY** | **DENY** | ALLOW | n/a |
| Internal: all `InternalOrchestrationCommand` variants | **DENY** | **DENY** | **DENY** | ALLOW | ALLOW |

\* `thread.approval.respond` for `delamain`: a crit agent that receives a tool-use approval request from its provider session is allowed to respond. This is the intended control loop. Delamain cannot approve its own approvals — the approval request carries the `requestId` minted by the server; the server enforces that only the session owning the request can respond (existing invariant in `commandInvariants.ts`).

### Verdict on #68 worktree commands (`worktree.retire.start`, `worktree.bury`)

**Not currently dispatchable from any client-facing surface.**

`WorktreeRetireStartCommand` and `WorktreeBuryCommand` are members of `InternalOrchestrationCommand`, which is **not** included in `ClientOrchestrationCommand` or `DispatchableClientOrchestrationCommand`. The WS RPC `dispatchCommand` method validates against `ClientOrchestrationCommand` (enforced by the schema union at decode time). The crit HTTP endpoint accepts only `thread.turn.start` variants. No client path can reach these commands.

The only call sites that dispatch them are:
- `WorktreeGraveyardRetirement.ts:80` — `worktree.retire.start`
- `WorktreeGraveyardRetirement.ts:139` — `worktree.bury`

Both are internal server processes. After this plan, they receive actor `"server"`, which the deny matrix allows. **No exposure risk from #68.**

---

## 5. Enforcement Point — commandInvariants Extension

Actor authorization should be enforced in the engine's `processEnvelope` function, **before** the command reaches the decider, so it is impossible to bypass by calling `decideOrchestrationCommand` directly in tests without an actor.

```ts
// apps/server/src/orchestration/Layers/OrchestrationEngine.ts (inside processEnvelope)
// NEW: actor authorization guard — runs before decider
const authError = checkActorAuthorization(envelope.command, envelope.actorKind);
if (authError) {
  yield* Deferred.fail(envelope.result, authError);
  yield* emitDenialReceipt(envelope); // see §denial receipt below
  return;
}
```

The `checkActorAuthorization` function lives in `commandInvariants.ts` (co-located with existing invariant helpers) and returns `OrchestrationCommandInvariantError | null`. It is a pure switch over `(command.type, actorKind)` — no read model needed.

```ts
// commandInvariants.ts — PENDING OPERATOR APPROVAL
export function checkActorAuthorization(
  command: OrchestrationCommand,
  actor: OrchestrationActorKind,
): OrchestrationCommandInvariantError | null {
  // Internal commands: only server/provider
  if (isInternalCommand(command)) {
    if (actor === "server" || actor === "provider") return null;
    return invariantError(command.type, `Actor '${actor}' is not authorized to dispatch internal command '${command.type}'.`);
  }
  // Structural commands: only operator
  if (isStructuralCommand(command)) {
    if (actor === "operator" || actor === "server") return null;
    return invariantError(command.type, `Actor '${actor}' may not create, delete, or restructure projects/threads.`);
  }
  // Session-mutating: operator + supervisor
  if (isSessionMutatingCommand(command)) {
    if (actor === "operator" || actor === "supervisor" || actor === "server") return null;
    return invariantError(command.type, `Actor '${actor}' is not authorized for command '${command.type}'.`);
  }
  // Respond: operator + delamain
  if (isRespondCommand(command)) {
    if (actor === "operator" || actor === "delamain" || actor === "server") return null;
    return invariantError(command.type, `Actor '${actor}' is not authorized to respond on behalf of this thread.`);
  }
  // Default: operator only
  if (actor === "operator" || actor === "server") return null;
  return invariantError(command.type, `Actor '${actor}' is not authorized for command '${command.type}'.`);
}
```

Helper predicates (`isInternalCommand`, `isStructuralCommand`, etc.) are narrow type guards over `command.type` — no new abstractions.

### Denial receipt

A denial must be stored so W5.4 audit-trail verification can see it:

```ts
// NEW event type to add to OrchestrationEventType:
"command.denied"

// NEW payload:
export const CommandDeniedPayload = Schema.Struct({
  commandType: OrchestrationEventType, // the command that was denied
  commandId: CommandId,
  actorKind: OrchestrationActorKind,
  reason: TrimmedNonEmptyString,
  deniedAt: IsoDateTime,
});
```

The denial event uses `aggregateKind: "thread"` (or `"project"`) matching the command's target so it is replayable in stream order. If the command has no aggregate (malformed), emit against a `_system` aggregate.

Denial events are **observable** (emitted to the event pubsub) but **not projected** into the read model — they are audit-only.

---

## 6. Migration and Backward Compatibility

No schema migration is needed. `actor_kind` is already `TEXT NOT NULL` in migration 001. The column today holds `"client" | "server" | "provider"`. After this plan it will also hold `"operator" | "supervisor" | "delamain"`. The additional literals are additive; reads that only check `actor_kind = 'server'` continue to work correctly.

For replayed pre-actor events (those with sequence < the deployment sequence where this lands):
- `inferActorKind` continues to work for the legacy `client/server/provider` values
- The `OrchestrationActorKind` schema union expands to include all five values, so decode does not fail
- No migration script is needed: old rows keep their inferred value; new rows get the stamped value

**Compat rule:** Code that reads `actor_kind` must treat `"client"` as equivalent to `"operator"` for display and audit purposes. This mapping belongs in a single translation function, not scattered across readers.

---

## 7. Test Plan

All tests are unit-level — no new test frameworks.

1. **`commandInvariants.test.ts` — new `checkActorAuthorization` cases:**
   - `delamain` + `thread.delete` → DENY
   - `delamain` + `thread.turn.start` → DENY
   - `delamain` + `thread.approval.respond` → ALLOW
   - `supervisor` + `thread.checkpoint.revert` → DENY
   - `operator` + any client command → ALLOW
   - `server` + `worktree.bury` → ALLOW
   - `operator` + `worktree.bury` → DENY (internal command)

2. **`OrchestrationEngine` integration smoke — existing test suite** must still pass with actor param added. Existing tests supply `"operator"` as actor; no behavioral change.

3. **`OrchestrationEventStore.test.ts`** — one case confirming a dispatch with actor `"delamain"` persists `actor_kind = 'delamain'` and a case confirming a pre-actor row decodes without error with legacy `"client"` value.

4. **`command.denied` event** — one unit test in `decider.test.ts` (or new `engine-actor-authz.test.ts`) confirming a DENY produces the denial event and does not persist the denied command's business event.

---

## 8. Deliberately Cut

- **Per-user identity within the `operator` actor.** The system is single-tenant (plan 18 non-goal: no multi-user RBAC). All operator sessions are equivalent. Add when multi-user lands.
- **RBAC beyond the three actors.** Three actors cover all current dispatch paths. A full role system is not warranted by this scope.
- **Actor identity on the wire (client-supplied actor field).** Clients do not send an actor — the server stamps it. This is intentional: allowing clients to claim their own actor kind would be a privilege escalation vector.
- **Audit log UI.** `command.denied` events are in the event store; surfacing them in the thread activity feed is a separate product decision.
- **`"supervisor"` call site wiring.** The supervisor currently dispatches through `delamainAdapter.spawnPeer()`, not `engine.dispatch()`. The `"supervisor"` literal is reserved for future direct-dispatch paths. It does not need to be wired to any call site in this plan.

---

## Open Questions for the Operator

1. **`OrchestrationActorKind` expansion is a contracts change.** The contract package is shared with the web client. Does expanding the literal union require a coordinated client release, or is the client schema decode sufficiently lenient (e.g., does it treat unknown actor values gracefully)?

2. **`thread.approval.respond` from `delamain` — intended?** The deny matrix allows a crit agent to respond to its own tool-use approval requests. Is this the intended control loop, or should all approval responses require human (operator) confirmation?

3. **`command.denied` event type.** Adding `"command.denied"` to `OrchestrationEventType` extends the schema union. This is additive and backward-compatible, but any exhaustive switch on `OrchestrationEventType` in projectors or reactors will need a new case. Confirm this is acceptable before implementation.

4. **Automode `dispatchGoal` via WS.** `apps/server/src/ws.ts:1494` exposes `automodeSupervisor.dispatchGoal` as a WS RPC method. This ultimately results in a `delamainAdapter.spawnPeer()` call (not a direct engine dispatch), so the delamain agent's eventual commands come in via crit HTTP and are correctly stamped `"delamain"`. But if the supervisor ever adds a direct `engine.dispatch()` call, it must stamp `"supervisor"`. Should the supervisor's dispatch path be locked down by interface now?

5. **CLI actor level.** CLI dispatches (`cli/open.ts`, `cli/project.ts`) are stamped `"operator"` here. If the CLI will eventually support scripted/unattended runs that should be treated as `"supervisor"`, the call sites need a mode flag. Confirm CLI is always `"operator"` for now.
