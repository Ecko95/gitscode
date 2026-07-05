# Plan 26 — GITS conversation tree: fork any thread from any message

Status: DRAFT 2026-07-05 — approved for execution by operator (frontier-orchestration,
engine=codex gpt-5.5 effort=high; Fable orchestrates/reviews/merges only).
Motivation: Pi's `/tree` (fork a conversation from any point in its history, original
preserved, optional summarize) — see plan 25 §7 "Session trees … Pi's one genuinely novel
feature". Verdict from 2026-07-05 recon: **not a Pi moat** — both engines ship the
primitive natively; GITS builds the tree on its own event store. No Pi, TOS-clean
(every model call stays inside its own harness).

## 1. Verified engine facts (2026-07-05 — do not re-derive)

- **Claude Code 2.1.201 / agent-sdk 0.3.154**: `--resume-session-at <message-uuid>` +
  `--fork-session` exist (SDK options `resumeSessionAt`, `forkSession`); binary resumes at
  `messages.findIndex(d => d.uuid === resumeSessionAt)` under a NEW session id. Control
  protocol also has `rewindFiles(user_message_uuid)` (deferred, §6).
- **Codex 0.142.5 app-server v2**: `thread/fork {threadId}` → new thread, source untouched;
  `thread/rollback {threadId, numTurns}` → drop N turns from the end ("does not revert
  local file changes"). Both ALREADY TYPED in
  `packages/effect-codex-app-server/src/_generated/schema.gen.ts` (`V2ThreadFork*`
  ~`:5666`, `V2ThreadRollback*`) — never called.
- **GITS today**: no fork/branch/rewind anywhere (UI or orchestration). But:
  - Full history is server-authoritative: `orchestration_events` + `projection_thread_messages`
    / `projection_turns` (migration `005_Projections.ts`).
  - `ClaudeAdapter.ts` already captures `resumeSessionAt` = lastAssistantUuid per assistant
    message (`:2088`) into the resume cursor (`:1147`, `:3064`) — never passed to the SDK
    (`:2999` passes only `resume`).
  - Codex resume = `thread/resume` by threadId (`CodexSessionRuntime.ts:446`); cursor is
    `{threadId}` only (`:67`).
  - Per-turn git checkpoints exist (`CheckpointReactor.ts`, `projection_turns.checkpoint_ref`) —
    ready-made workspace-restore material (deferred, §6).
  - One-shot text path exists for summarize mode: `apps/server/src/textGeneration/ClaudeTextGeneration.ts`.

## 2. Scope

**Outcome**: from any message in an existing GITS chat, the user can fork a NEW thread that
continues from exactly that point — source thread untouched, forked thread carries the
truncated history, per-engine native mechanics (Claude `resumeSessionAt`+`forkSession`;
Codex `thread/fork`+`thread/rollback`). Minimal tree affordances: "fork from here" on each
message, "forked from" chip on children, forks list on the parent. Optional summarize-mode
fork (fresh session seeded with a generated summary + custom prompt).

**Non-goals (v1)**: graph/tree visualization view; workspace/file-state restore on fork;
in-place rollback of an existing thread; tool-call-granularity anchors on Codex (turn
granularity only); Pi anything.

**Definition of done**: all slices merged to `gits`, CI green each
(Format/Lint/Typecheck/Test/Build), fork round-trip demonstrated on both engines.

## 3. Blast radius

- `packages/contracts` — new command + event + projection fields (data contract change;
  additive only, nullable columns).
- Event-sourcing invariants (plan 14/22): `thread.forked` must replay deterministically
  under **rebuild** AND **retention**. If source-thread events can be pruned, a fork event
  that references them cannot rematerialize the prefix → the event may need to carry the
  copied prefix (self-contained) or reference blobs. RECON Q2 decides; this is the highest-
  risk design point.
- `apps/server` provider layer — ClaudeAdapter queryOptions, CodexSessionRuntime RPC calls,
  ProviderCommandReactor cursor seeding. Existing resume paths must remain bit-identical
  when no fork is involved.
- `apps/web` — chat message row actions, store, thread navigation, composer prefill.
- Environment binding: forked thread inherits the source thread's environment/worktree →
  two live threads can share one worktree. v1 ships with this hazard documented (same as
  Pi's behavior); RECON Q7 verifies nothing crashes structurally.
- Security/privacy: fork copies conversation content between threads — same user, same
  project, same store; no new exposure. Summarize mode sends prefix text to the engine
  that already saw it.

## 4. Ponytail review (keep / change / drop)

- KEEP: fork-from-message on both engines; message list IS the picker (GUI advantage — no
  separate tree screen); PR-per-slice with CI gates.
- CHANGE: tree UI = chip + forks list, not a graph view (add when users ask); summarize
  mode rides LAST (slice 5), core fork must not depend on it.
- DROP: generic "branch manager" abstraction (one command handler suffices); codex
  tool-call anchors (turn granularity); fork-time file snapshots (checkpoints already
  exist for later use).

## 5. Slices (one PR each, base `gits`, sequential; peer = codex gpt-5.5 effort high)

| # | Slice | Deliverable | Acceptance (machine-checkable) |
|---|-------|-------------|-------------------------------|
| 0 | Recon | Answers to Q1–Q7 (report only, no PR) | Every question answered with file:line evidence |
| 1 | Contracts + event + migration + projector | `thread.fork` command contract; `thread.forked` event; `projection_threads.parent_thread_id`/`forked_from_message_id` migration; projector materializes forked thread + prefix copy | typecheck+tests green; rebuild-from-events test proves fork projection reconstructs; retention answer from Q2 encoded in event design |
| 2 | Server command + Claude wiring | `thread.fork` handler: new thread, provider anchor resolution, `thread.forked` emitted, fork cursor seeded; ClaudeAdapter passes `resumeSessionAt`+`forkSession` | integration test: fork mid-history → next turn runs under NEW session id with truncated context; non-fork resume path unchanged (existing tests) |
| 3 | Codex wiring | CodexSessionRuntime fork-cursor start → `thread/fork` → `thread/rollback {numTurns}` → new threadId persisted; client wrapper methods if bindings are types-only | runtime test with mocked app-server; numTurns mapping validated against Q3 evidence; non-fork resume unchanged |
| 4 | Web UI | Per-message "Fork from here" action → command → navigate to forked thread; composer prefilled with that point's user prompt; "forked from" chip + forks list | component tests; lint/typecheck; manual smoke path documented in PR body |
| 5 | Summarize mode | `mode:'summary'` + optional custom prompt: one-shot summary of prefix (ClaudeTextGeneration), forked thread starts a FRESH engine session seeded with it (engine-agnostic); UI mode picker (full/summary+prompt) | test for summary seeding path; full-copy default unchanged |

Dependencies: 1 → 2 → 3 → 4 → 5 strictly (contracts first; UI last before summarize).

## 6. Deferred (recorded, not built)

- Workspace restore on fork (Claude `rewindFiles` / codex checkpoint_ref reset; offer "fork
  into new worktree at that turn's checkpoint").
- Tree visualization view.
- In-place rollback (`thread/rollback` on the SAME thread) — tree fork covers the use case
  without history loss.

## 7. Recon questions (slice 0)

1. Q1: Is the Claude per-message uuid persisted per message anywhere (event payloads,
   projections)? If only latest-assistant-uuid exists in the cursor, what is the smallest
   change to anchor a fork at ANY earlier assistant message? (Check what `ClaudeAdapter.ts`
   emits per message and what the projector stores.)
2. Q2: Rebuild + retention semantics for a `thread.forked` event: can the projector copy
   the prefix from source events at replay time, or can retention prune them first? Decide:
   reference-based vs self-contained event payload. (Read `projector.ts`, plan 22 artifacts,
   retention code.)
3. Q3: Exact `numTurns` mapping for `thread/rollback`: what counts as a "turn" in the codex
   protocol vs `projection_turns` rows? Does `ThreadForkResponse` return the thread items
   (so the fork's turn count can be read directly)?
4. Q4: Web: which component renders message rows; how does thread navigation + composer
   prefill work; where do thread-level client commands live?
5. Q5: Does `packages/effect-codex-app-server` expose CALLABLE client methods for
   `thread/fork`/`thread/rollback`, or only generated schema types? What is the pattern for
   adding a method (mirror `thread/resume`)?
6. Q6: Confirm agent-sdk 0.3.154 `Options` type accepts `resumeSessionAt` + `forkSession`
   (name-exact) in the version pinned by bun.lock.
7. Q7: How are threads bound to environments/worktrees; does a second thread on the same
   environment work today (any hard assumption of 1 thread : 1 env)?

## 8. Orchestration protocol (state — updated at wave boundaries)

Engine: delamain codex peers (isolated worktrees, `start_ref origin/gits`, merge to `gits`
via PR). One peer at a time (auth single-flight, stacked merges). Every peer brief embeds
ponytail (level full) and paths-not-bodies. Fable: reviews every diff, one adversarial
question per risky assumption, merges only on green CI (Format/Lint/Typecheck/Test/Build;
stale-turbo → force tsgo). Escalation: 2 failed acceptance rounds → Fable re-scopes.

| Wave | Item | Status | Evidence |
|------|------|--------|----------|
| W0 | Plan 26 doc PR | in review | PR #97 |
| W0 | Slice 0 recon peer | DONE 2026-07-05 | peer e65d740f, report in §9 |
| W1 | Slice 1 PR | dispatched | peer brief per §9 decisions |
| W2 | Slice 2 PR | not started | — |
| W3 | Slice 3 PR | not started | — |
| W4 | Slice 4 PR | not started | — |
| W5 | Slice 5 PR | not started | — |

## 9. Recon results (slice 0, peer e65d740f, 2026-07-05) — binding decisions

Corrections to §1: `thread/rollback` is ALREADY called (revert-user-message feature:
`CodexSessionRuntime.ts:1377-1380`, exposed via `CodexAdapter.ts:1637-1658`,
`ProviderService.ts:982-1007`, UI `RevertUserMessageButton` in `MessagesTimeline.tsx:346-427`).
Only `thread/fork` has no call site. Fork = the non-destructive sibling of revert; mirror
its patterns end-to-end.

- **D1 (Q1)**: No per-message provider id exists anywhere (events, projections). Add optional
  `providerMessageId` to the message contracts + `projection_thread_messages.provider_message_id`;
  ClaudeAdapter emits `message.uuid` (captured at `:2083-2089`) per assistant message.
  LIMITATION: messages recorded before this feature can only fork from the latest cursor anchor.
- **D2 (Q2)**: Reference-only fork events are NOT retention-safe (archive moves deleted-thread
  events out of hot log: `OrchestrationEventStore.ts:383-393`; rebuild defaults hot-only:
  `cli/db.ts:151-158,216-240`). DECISION: copy-at-command-time — the fork handler re-emits
  the prefix as fresh standard message events into the NEW thread's stream (projector needs
  no new copy logic), plus a `thread.forked` metadata event (parentage only).
- **D3 (Q3)**: Codex turns ≠ projection_turns rows (interrupts/approvals/uncheckpointed).
  `thread/fork` response returns populated `thread.turns` (`schema.gen.ts:33550-33570`).
  numTurns = forkResponse.thread.turns.length − K (K = codex turn count retained at anchor,
  mapped via turn-id match against `projection_turns` first, checkpoint_turn_count fallback).
  GUARD: ambiguous mapping → typed failure, never mis-truncate. Rollback rejects <1
  (`CodexAdapter.ts:1637-1644`) — skip rollback when numTurns == 0.
- **D4 (Q4)**: UI seams: rows `MessagesTimeline.tsx:323-509` (mirror RevertUserMessageButton);
  commands via `api.orchestration.dispatchCommand` (`environmentApi.ts:56-58`, `ws.ts:730-751`);
  navigation `threadRoutes.ts:15-22` + `routes/_chat.$environmentId.$threadId.tsx:149-159`;
  composer prefill `composerDraftStore.ts:348-355` `setPrompt`.
- **D5 (Q5)**: `client.request("thread/fork", ...)` is callable+typed already
  (`client.ts:39-44,197-210`; `meta.gen.ts:175-180,256-260`). Add `forkThread` to
  `CodexSessionRuntimeShape`, parse via `parseThreadSnapshot`, expose through
  CodexAdapter/ProviderAdapter/ProviderService mirroring the rollback surface.
- **Q6 confirmed**: agent-sdk 0.3.154 `Options` has `forkSession?: boolean` (`sdk.d.ts:1426-1429`)
  and `resumeSessionAt?: string` (`sdk.d.ts:1693-1707`).
- **Q7 confirmed**: no structural 1-thread-per-environment coupling (server threads bind
  projectId/worktreePath by threadId; environment is a client scope). Shared-cwd concurrent
  sessions can race — documented v1 hazard (same as revert already has).
