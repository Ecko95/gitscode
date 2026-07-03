# Plan 21 — Worktree Graveyard (W2.1 Design)

**Status: PENDING OPERATOR APPROVAL**

Worktrees are created by `GitVcsDriverCore.createWorktree` (path:
`apps/server/src/vcs/GitVcsDriverCore.ts:2059`) but never removed. Thread
deletion (`ThreadDeletionReactor` lines 58–64) stops sessions and closes
terminals; the worktree stays on disk forever. This plan designs the
retirement lifecycle so every transition is observable and auditable via the
event store.

---

## State Machine

Three states. Every transition emits one event and one receipt.

```
active ──[trigger]──► retiring ──[receipt]──► buried
                                               │
                                [reaper sweep]─┘──► (git worktree removed; branch kept)
```

| State      | Meaning                                       |
| ---------- | --------------------------------------------- |
| `active`   | Worktree is on disk and linked to a thread    |
| `retiring` | Final diff being captured; removal pending    |
| `buried`   | Worktree removed from disk; branch preserved  |

### Transitions

**`active → retiring`**

- Trigger: `thread.deleted` event observed by `ThreadDeletionReactor`, OR
  inactivity sweep in `ProviderSessionReaper` (W2.2 adds this path).
- Emits: `worktree.retiring-started` (see schema section below).
- Receipt published: `WorktreeRetiringStartedReceipt` (used by W2.2 to
  sequence teardown).

**`retiring → buried`**

- Trigger: retirement handler completes — checkpoint captured, worktree
  removed via `GitVcsDriver.removeWorktree`.
- Emits: `worktree.buried`.
- Receipt published: `WorktreeBuriedReceipt`.

**Orphan adoption (no prior `active` state in event store)**

- Trigger: startup scan in W2.3 finds a worktree path on disk with no
  `worktree.retiring-started` or `worktree.buried` event.
- Emits: `worktree.adopted` (carries `orphanReason: "no-event-binding"`).
  Adoption counts as entering the `buried` age clock — no `active` state is
  synthesised.

---

## Proposed Contract Schemas

**PENDING OPERATOR APPROVAL** — add to `packages/contracts/src/orchestration.ts`.

```ts
// --- payload schemas ---

export const WorktreeRetiringStartedPayload = Schema.Struct({
  threadId: ThreadId,
  worktreePath: TrimmedNonEmptyString,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  trigger: Schema.Literals(["thread-deleted", "inactivity-reap"]),
  initiatedAt: IsoDateTime,
});
export type WorktreeRetiringStartedPayload =
  typeof WorktreeRetiringStartedPayload.Type;

export const WorktreeBuriedPayload = Schema.Struct({
  threadId: ThreadId,
  worktreePath: TrimmedNonEmptyString,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  finalCheckpointRef: Schema.NullOr(CheckpointRef), // null when capture failed
  buriedAt: IsoDateTime,
});
export type WorktreeBuriedPayload = typeof WorktreeBuriedPayload.Type;

export const WorktreeAdoptedPayload = Schema.Struct({
  worktreePath: TrimmedNonEmptyString,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  orphanReason: Schema.Literal("no-event-binding"),
  adoptedAt: IsoDateTime,
});
export type WorktreeAdoptedPayload = typeof WorktreeAdoptedPayload.Type;

// --- event type literals (add to OrchestrationEventType union) ---
// "worktree.retiring-started"
// "worktree.buried"
// "worktree.adopted"

// --- event structs (add to OrchestrationEvent union) ---
Schema.Struct({
  ...EventBaseFields,
  type: Schema.Literal("worktree.retiring-started"),
  payload: WorktreeRetiringStartedPayload,
}),
Schema.Struct({
  ...EventBaseFields,
  type: Schema.Literal("worktree.buried"),
  payload: WorktreeBuriedPayload,
}),
Schema.Struct({
  ...EventBaseFields,
  type: Schema.Literal("worktree.adopted"),
  payload: WorktreeAdoptedPayload,
}),
```

**Receipt schemas** — add to
`apps/server/src/orchestration/Services/RuntimeReceiptBus.ts` and the
`OrchestrationRuntimeReceipt` union:

```ts
export const WorktreeRetiringStartedReceipt = Schema.Struct({
  type: Schema.Literal("worktree.retiring.started"),
  threadId: ThreadId,
  worktreePath: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});

export const WorktreeBuriedReceipt = Schema.Struct({
  type: Schema.Literal("worktree.buried"),
  threadId: ThreadId,
  worktreePath: TrimmedNonEmptyString,
  finalCheckpointRef: Schema.NullOr(CheckpointRef),
  createdAt: IsoDateTime,
});
```

Aggregate kind for graveyard events: `"worktree"`. `aggregateId` is the
`worktreePath` (unique per repo+branch combination under `worktreesDir`).
`threadId` travels in the payload so projectors can correlate without
joining.

**NOTE — aggregate kind extension**: `OrchestrationAggregateKind` is currently
`Schema.Literals(["project", "thread"])`. Adding `"worktree"` is a non-breaking
addition to the literals union but requires a migration guard for old event
replays that do not carry this kind. Operator must approve before schema is
applied.

---

## Integration Map (W2.2 – W2.6 contact points)

### W2.2 — Retirement path

Files touched:

- `apps/server/src/orchestration/Layers/ThreadDeletionReactor.ts` — extend
  `processThreadDeleted` to call the retirement handler after session stop
  and terminal close. The handler: dispatch `worktree.retiring-started` →
  capture final checkpoint → `git worktree remove` → dispatch
  `worktree.buried`. The reactor already owns the `thread.deleted` fan-out;
  no new reactor needed.
- `apps/server/src/provider/Layers/ProviderSessionReaper.ts` — after
  `providerService.stopSession` succeeds for a thread that has a non-null
  `worktreePath`, enqueue the same retirement handler. The reaper's sweep
  loop already iterates sessions; retirement is a tail step after stop.
- `apps/server/src/checkpointing/*` — reuse `captureAndDispatchCheckpoint`
  in `CheckpointReactor.ts` (lines 218–313) for the "capture final diff"
  step. The retirement handler must run inside the same Effect scope and
  await the `checkpoint.diff.finalized` receipt from `RuntimeReceiptBus`
  before proceeding to `removeWorktree`. **Contradiction flagged**: the
  existing `captureAndDispatchCheckpoint` signature requires an active
  `turnId` and `thread.messages` snapshot. A retiring worktree may have no
  active turn. A lighter alternative: call `checkpointStore.captureCheckpoint`
  directly (a raw git ref capture, no orchestration dispatch) and store the
  ref in `WorktreeBuriedPayload.finalCheckpointRef`. This avoids coupling to
  the turn-diff machinery. W2.2 must choose one of these paths; this design
  recommends the lighter `checkpointStore.captureCheckpoint` call.

### W2.3 — Orphan adoption

Files touched:

- New service `apps/server/src/vcs/Services/GraveyardOrphanAdopter.ts`
  (single file, started once at boot). It must not be a duplicate of
  `ProviderSessionReaper`; it is a one-shot startup scan, not a periodic
  sweep.
- On startup: enumerate disk paths under `worktreesDir` via `FileSystem`
  (already a dependency in `GitVcsDriverCore`). For each path, query the
  event store projection to check for a `worktree.buried` or
  `worktree.retiring-started` event with matching `worktreePath`. If none,
  dispatch `worktree.adopted` and enter the burial age clock (treat
  `adoptedAt` as `buriedAt` for reaper purposes).
- Does not call `git worktree remove` immediately — adoption puts the orphan
  into the reaper's care. The reaper (W2.4) prunes it when it ages past the
  knob.

### W2.4 — Graveyard reaper

Files touched:

- New service `apps/server/src/vcs/Services/GraveyardReaper.ts` — periodic
  sweep (same `Schedule.spaced` pattern as `ProviderSessionReaper`). Reads
  all `worktree.buried` and `worktree.adopted` events from the projection.
  For each entry where `now - buriedAt > GITS_GRAVEYARD_MAX_AGE_MS`: call
  `GitVcsDriver.removeWorktree`. No event emitted on prune (the
  `worktree.buried` event already documents the burial; silent disk reclaim
  is sufficient). Branch is never deleted.
- Does not duplicate the session-stop logic in `ProviderSessionReaper`.

### W2.5 — Worktree ownership

Files touched:

- `packages/contracts/src/orchestration.ts` — add
  `worktree.owner-recorded` event (payload: `threadId`, `worktreePath`,
  `branch`, `projectId`, `recordedAt`) emitted by the server immediately
  after a successful `git worktree add` in `ThreadDeletionReactor` or the
  existing bootstrap path. This event is the event-store binding that W2.3
  checks for.
- `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts` or the
  bootstrap handler — emit `worktree.owner-recorded` after worktree creation
  succeeds.

### W2.6 — Driver-level guardrails

Files touched:

- `apps/server/src/vcs/GitVcsDriverCore.ts` — wrap the driver instance with
  a session-scoped guard that stores `allowedRoot` (the worktree path) on
  construction, and rejects any path argument that does not resolve to a
  descendant of `allowedRoot`. Also rejects force-push to `main`/`master`
  without an explicit supervisor flag. Existing `executeGit` calls pass `cwd`
  and path args; the guard intercepts at the VcsDriver interface level
  (`VcsDriver.ts:55`) via a wrapping adapter — does not duplicate the core.
- `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts` — for
  merge/integration operations, route through a supervisor command rather
  than calling the driver directly.

---

## Orphan Adoption Semantics (W2.3 Detail)

Detection query: for each `path` found under `worktreesDir`, check the
projection snapshot for any event with `payload.worktreePath === path`. If
the only match is a `worktree.owner-recorded` event and no
`worktree.retiring-started` exists, the worktree is considered leaked
(process crash between creation and first use, or pre-W2.5 worktree with no
ownership record). These are also adopted.

Never silently delete: adoption always emits `worktree.adopted` before any
state change so the operator can see what was found.

---

## Retention Knob and Reaper Semantics (W2.4 Detail)

```
GITS_GRAVEYARD_MAX_AGE_MS   default: 604_800_000   (7 days)
```

Single env-var knob, read at service construction. Branches are always
preserved regardless of this value.

Sweep semantics:

1. Project all `worktree.buried` + `worktree.adopted` events from the
   projection (in-memory read model, no extra DB query).
2. For each entry: if `now - buriedAt (or adoptedAt) > knob` AND the path
   still exists on disk, call `removeWorktree({ cwd: repoRoot, path, force: false })`.
3. Log `graveyard.reaper.pruned` at info level; log
   `graveyard.reaper.prune-failed` at warning and continue (no receipt emitted
   on prune failure — the sweep will retry next interval).
4. Default sweep interval: 1 hour (hard-coded, not a knob — YAGNI).

---

## Failure Modes

### Crash mid-retirement (`retiring` state recovery)

If the process crashes after `worktree.retiring-started` is emitted but
before `worktree.buried`:

- On next startup W2.3 orphan adopter sees the path on disk, finds a
  `worktree.retiring-started` event but no `worktree.buried` event →
  dispatches `worktree.adopted` (recovery path).
- The reaper then handles it normally.
- No retry of the checkpoint capture (lost turn state; the raw `captureCheckpoint`
  call in the retirement path must be idempotent — git stash ref create is
  idempotent).

### Checkpoint capture failure

- Call `checkpointStore.captureCheckpoint` fails (e.g. corrupt repo, disk
  full).
- Emit `worktree.buried` with `finalCheckpointRef: null` — worktree removal
  still proceeds. Do not block burial on checkpoint failure.
- Log `worktree.retirement.checkpoint-failed` at warning with the error
  detail.

### `git worktree remove` failure

- `removeWorktree` returns a `VcsError`.
- Log `worktree.burial.remove-failed` at warning.
- Do NOT emit `worktree.buried` — the burial event is only emitted on
  successful disk removal.
- The `worktree.retiring-started` event stays in the store; W2.3 treats the
  path as a resumable orphan on next startup (recovery path above).

---

## Deliberately Cut

The following are explicitly out of scope for this design and all downstream
W2.x tasks:

- **Graveyard listing RPC** — `git branch` is the listing. No extra endpoint.
- **Resurrect RPC** — creating a worktree on the preserved branch via the
  existing `createWorktree` is resurrection. No `resurrected` state.
- **`resurrected` event type** — YAGNI. If a buried thread's worktree is
  re-created, that is a new `worktree.owner-recorded` event on an existing
  branch; no lifecycle coupling needed.
- **Multi-knob policy** — one knob (`GITS_GRAVEYARD_MAX_AGE_MS`), branches
  always kept.
- **Graveyard UI** — out of scope for the W2.x series.
- **Non-git VCS driver graveyard** — `VcsDriver.capabilities.supportsWorktrees`
  must be `true`; skip silently for drivers that return `false`.

---

## Contradictions vs. Task Spec

1. **`captureAndDispatchCheckpoint` requires an active turn** — the spec says
   "capture final diff as checkpoint." The real function at
   `CheckpointReactor.ts:218` requires `turnId`, `thread.messages`, and an
   active turn count. A retiring worktree has no in-flight turn. The design
   resolves this by calling the lower-level `checkpointStore.captureCheckpoint`
   directly (a raw git ref). The diff is capturable via
   `checkpointStore.diffCheckpoints` between the last known checkpoint ref and
   HEAD, which is sufficient for audit purposes. W2.2 must implement this
   lighter path, not reuse `captureAndDispatchCheckpoint`.

2. **`aggregateKind` enum is closed** — `OrchestrationAggregateKind` only
   allows `"project"` and `"thread"`. Graveyard events need a `"worktree"`
   kind. This requires operator approval before the schema is widened; a
   replay migration guard may be needed for existing projectors that switch on
   `aggregateKind`.

3. **`VcsProvisioningService` does not expose `createWorktree`** — worktree
   creation is accessed directly through `GitVcsDriver` in the bootstrap path
   (not via `VcsProvisioningService`, which only exposes `initRepository`). W2.5
   ownership events must be emitted from whatever handler calls
   `GitVcsDriverCore.createWorktree` at line 2059.

---

## Files Read

- `.plans/README.md`, `.plans/20-version-control-phase-2-*.md` (style reference)
- `packages/contracts/src/orchestration.ts` (event/command/receipt schema conventions)
- `packages/contracts/src/baseSchemas.ts` (primitive brands)
- `packages/contracts/src/vcs.ts` (VcsDriverCapabilities)
- `apps/server/src/orchestration/Layers/ThreadDeletionReactor.ts` (W2.2 integration point, lines 58–64)
- `apps/server/src/orchestration/Layers/CheckpointReactor.ts` (checkpoint capture path, lines 218–313)
- `apps/server/src/orchestration/Services/RuntimeReceiptBus.ts` (receipt schema pattern)
- `apps/server/src/orchestration/Layers/RuntimeReceiptBus.ts`
- `apps/server/src/provider/Layers/ProviderSessionReaper.ts` (W2.2 integration point)
- `apps/server/src/vcs/GitVcsDriverCore.ts` (createWorktree lines 2059–2080, removeWorktree 2142–2164, worktreesDir line 641)
- `apps/server/src/vcs/VcsDriver.ts`
- `apps/server/src/vcs/VcsProvisioningService.ts`
- `apps/server/src/checkpointing/Utils.ts`
