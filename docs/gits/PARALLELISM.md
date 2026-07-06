# GITS Parallelism Model

GITS has two parallelism modes:

1. **Separate workspaces**: multiple independent worktrees, usually one agent or peer per worktree.
2. **Shared workspace forks**: multiple orchestration threads rooted at the same worktree, used to branch conversation context from a point in a transcript.

The in-app [Agent Orchestration](../../apps/web/src/docs/orchestration.md) page summarizes the operator-facing Delamain, Hermes, and automode boundaries. This document is the deeper architecture companion for when to choose each mode and how the code actually ties threads, forks, worktrees, and peers together.

## Decision Table

| Use case                                                                            | Prefer                                                    | Why                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Independent feature work, bug fixes, or risky edits that may run in parallel        | Separate worktree / Delamain peer                         | Filesystem and branch state are isolated; Delamain peer records expose `worktreePath`, `branch`, status, PR URL, and integration state.                                                      |
| Fan-out across agents or models for the same repository task                        | Separate Delamain peers                                   | `spawnPeer` shells out to `delamain spawn --repo ... --prompt ...` with optional engine/model/start-ref/merge-branch arguments. Each peer is expected to report its own branch and worktree. |
| Autonomous queue execution                                                          | Automode dispatch to Delamain                             | Automode does not edit directly. It queues goals, checks policy, then spawns Delamain peers; the driver verifies and lands completed peer branches only when configured gates pass.          |
| Explore an alternate answer from a previous chat point while keeping the same files | Thread fork                                               | `thread.fork` creates a new thread with the source thread's `branch` and `worktreePath`, then seeds conversation context from the selected message.                                          |
| Continue one line of reasoning with shared state and shared terminal/file changes   | Same thread                                               | A normal turn continues the same provider session and current worktree. Use this when filesystem isolation would add noise.                                                                  |
| Preserve an archived/parked workspace                                               | Archive or keep another non-deleted thread referencing it | Worktree retirement skips a path when any other non-deleted thread still references that worktree.                                                                                           |

## Mode A: Separate Worktrees

Use separate worktrees when the work can diverge at the Git/filesystem layer. This is the right mode for independent branches, concurrent implementation attempts, destructive experiments, and fan-out where results will be compared through diffs, tests, or PRs.

GITS represents a thread's checkout with `branch` and `worktreePath` on `thread.created`. The decider copies those fields from the command into the thread-created event; projection and queries keep them on the thread record.

Delamain is the peer execution substrate for repo-writing parallelism. The GITS adapter calls fixed `delamain` commands rather than constructing arbitrary shell from the browser. A spawn becomes `delamain spawn --repo <repo> --prompt <prompt>` plus optional `--start-ref`, `--merge-branch`, `--target-branch`, `--engine`, `--model`, confinement, and egress flags. Returned peer records are normalized with `worktreePath`, `branch`, `baseBranch`, `mergeBranch`, `prUrl`, status, engine, model, and integration status.

Automode is built on the same substrate. It queues goals in server state, blocks dispatch on the kill switch, manual mode, peer limit, repo allowlist, model allowlist, budget cap, and approval requirements, then calls `DelamainAdapter.spawnPeer` with `confine: true`. The driver reconciles one running goal at a time, verifies completed peer worktrees against configured commands, lands the slice branch into the configured integration branch, and opens or watches a held PR. It halts on missing peers, waiting peers, failed statuses, missing verification commands, missing integration branch, or review failure.

This means "many workspaces" in GITS currently means multiple Delamain peers or manually created worktree-backed threads. It does not mean that a `thread.fork` creates a new checkout.

Sources: `apps/server/src/orchestration/decider.ts`, `apps/server/src/gits/Layers/DelamainCliAdapter.ts`, `apps/server/src/gits/Layers/AutomodeSupervisor.ts`, `apps/server/src/gits/Layers/AutomodeDriver.ts`, [ARCHITECTURE.md](./ARCHITECTURE.md).

## Mode B: Shared Workspace Forks

Use a fork when the operator wants another conversation branch from a specific transcript point while keeping the same repository checkout. This is context parallelism, not filesystem parallelism.

The `thread.fork` command creates a new thread after checking that the source thread exists and the target thread id is absent. The new `thread.created` event inherits the source thread's project, model selection, runtime mode, interaction mode, branch, and `worktreePath`. A `full` fork copies prefix message text into the new thread up to the selected assistant message, or before the selected user message. It deliberately does not copy turn state, checkpoints, or file state. A `summary` fork stores a generated summary message instead of copying the full prefix.

Provider seeding is best-effort and provider-specific. Full forks are currently supported for Claude-like and Codex-like provider labels. Codex forks build a Codex fork cursor from the source provider thread and turn projection. Claude-like forks resume from the source session and, when available, include a provider message id anchor. If the source provider binding or anchor cannot be resolved, the forked GITS thread still exists, but the provider context seeding failure is recorded as thread activity.

Because forks share the same `worktreePath`, they must be treated like multiple conversations over the same mutable files. They are useful for alternatives such as "try a smaller patch from here" or "explain the other design path", but simultaneous write-heavy turns on fork siblings can race through the same checkout.

Sources: `apps/server/src/orchestration/decider.ts`, `apps/server/src/orchestration/threadFork.ts`, `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`, `apps/server/src/orchestration/decider.fork.test.ts`.

## Worktree Lifetime

Thread deletion stops the provider session, closes terminals, and then asks the worktree graveyard retirement path to retire the thread's worktree if it has one. Retirement captures a final checkpoint ref, removes the git worktree, and emits `worktree.retiring-started` and `worktree.buried` events.

The fork-sharing rule is enforced before removal: `retireWorktree` asks `hasLiveThreadForWorktreePath(worktreePath, deletedThreadId)`. If any other non-deleted thread still references that path, retirement is skipped. Archived threads also block pruning because the live check is based on `deleted_at IS NULL`. This is the safety rule that makes shared-workspace forks viable: deleting one fork must not remove the checkout used by its siblings.

The graveyard reaper has the same bias. It treats `thread.deleted` as the signal that frees a worktree; archived-but-not-deleted threads block pruning. Orphan adoption and burial events exist for recovery and age-based cleanup, not for deciding that an active thread's checkout can be removed.

Sources: `apps/server/src/orchestration/Layers/ThreadDeletionReactor.ts`, `apps/server/src/vcs/WorktreeGraveyardRetirement.ts`, `apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts`, `apps/server/src/vcs/GraveyardReaper.ts`, `packages/contracts/src/orchestration.ts`.

## Operator Workflow

Start with the isolation question:

- If the task may change files independently, spawn or assign a separate worktree-backed worker. Use Delamain peers for supervised fan-out and automode for policy-gated queued work.
- If the task is mostly reasoning over the same checkout, stay in the current thread or fork the thread from the relevant message.
- If a fork turns into real implementation work that should not collide with its siblings, move that work to a separate worktree-backed peer before running long or write-heavy turns.

The practical mapping is:

- **Thread**: durable conversation and provider session state.
- **Worktree**: mutable repository checkout and branch state.
- **Fork**: another thread that starts from a source message and reuses the same worktree.
- **Delamain peer**: external worker in an isolated worktree, surfaced to GITS through typed RPC and normalized peer records.
- **Automode goal**: queued server-owned request that may spawn a Delamain peer after policy gates pass.

## Known Limits

GITS does not currently provide first-class fan-out-and-compare UI, automatic conflict resolution across peer outputs, or automatic conversion of a shared-workspace fork into a new worktree. Those are future product shapes, not current behavior in the code read for this document.
