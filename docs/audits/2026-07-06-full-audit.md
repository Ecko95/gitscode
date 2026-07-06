# Full system audit — 2026-07-06

Four parallel audits (server correctness, web UI + UX, security, Conductor research).
Every finding below was verified against code by the auditing agent; file:line references
are as of branch `audit/fixes-2026-07-06` (base `gits`, 1dbaca5b9).

## Fixed in this branch

| # | Severity | Fix |
|---|----------|-----|
| S1 | HIGH | Deleting a forked thread destroyed the shared worktree of the surviving thread. `retireWorktree` now skips when any other live thread references the path (`hasLiveThreadForWorktreePath(path, excludeThreadId)`), fail-safe skip on query error. |
| S2 | HIGH | Interrupted `t3 db rebuild-projections` left silently corrupt projections: sentinel was truncated with `projection_state` and startup never checked it. Sentinel now written inside the truncate transaction; `AssertNoInterruptedRebuildLive` refuses server boot while it exists. |
| S3 | HIGH | `GITS_REAL_GIT` resolved to `<firstPathDir>/git` without an existence check → all confined-agent git calls exited 127 on common PATHs. Walk now checks existence. |
| S4 | HIGH | Server terminates slow-subscriber streams at 512 buffered events expecting resubscribe, but shared client-runtime passed no `onEnd` → mobile thread view and shell state froze permanently. Both now resubscribe with capped exponential backoff (1s→30s). |
| S5 | HIGH | Snapshot/live overlap double-appended streaming deltas in shared client-runtime (web had the guard, mobile didn't). Added snapshot-sequence floor to `threadDetailState`. |

## Server — open findings (ranked)

| # | Sev | Where | Defect |
|---|-----|-------|--------|
| S6 | HIGH/MED | `ProjectionPipeline.ts:1467` | Attachment files deleted on disk inside the uncommitted command transaction — rollback resurrects the thread but attachments are gone. Move fs side effects post-commit. |
| S7 | MED | `commandInvariants.ts:22` | No layer rejects commands against deleted threads (`findThreadById` ignores `deletedAt`) — `thread.turn.start`/`thread.fork` accepted on deleted threads whose worktree is already removed. |
| S8 | MED | `cli/db.ts:52` | `BEGIN EXCLUSIVE` "server not running" guard is unsound under WAL — an idle running server passes; CLI truncates under a live server. |
| S9 | MED | `orchestration/http.ts:69` | HTTP dispatch bypasses `startup.enqueueCommand` — commands during the startup window persist events with zero reactor subscribers (provider side effects dropped). |
| S10 | MED | `OrchestrationEngine.ts:213,145` | `command.denied` double-published (append+publish, then reconcile republishes from pre-append sequence). |
| S11 | MED | `ProjectionPipeline.ts:1048` | Failed turn with no assistant output stays `running` forever (nothing completes the turn row when provider errors before any text). |
| S12 | MED | `ws.ts:1753,1784,1795,1332` | Unbounded per-subscriber buffering on terminal/git-action streams (`Stream.callback` default capacity = ∞); raw PTY output can grow RSS unboundedly. |
| S13 | MED | `ws.ts:1027` | `subscribeThread` reads detail then sequence non-atomically in the loss-inducing order — event committed between reads is stamped "in snapshot" but missing from it. |
| S14 | MED | `GitShimManager.ts:155` | `allocate` fails open (`{vars:{}}`) on shim-write failure — git confinement silently dropped, warning-only. |
| S15 | MED | `CheckpointReactor.ts:690` | Checkpoint revert non-atomic across fs/provider/projection; failure mid-sequence leaves durable divergence. |
| S16 | LOW/MED | `ProviderCommandReactor.ts:1430` | Full-fork cursor seeding failures are log-only — fork starts with zero provider context while UI shows copied messages. |
| S17 | LOW/MED | `ProjectionSnapshotQuery.ts:1546` | Command read model hydrates `checkpoints: []`/`activities: []` after restart (same drift class as #104); revert right after restart computes retention with empty `retainedTurnIds`. |
| S18 | LOW | `gits/http.ts:20`, `orchestration/http.ts:30` | `/api/gits/*` doesn't reject thread-scoped sidecar tokens; orchestration HTTP returns 500 instead of 401 on auth failure. |
| S19 | LOW | `crit-sidecar-manager.ts:180/388` | Concurrent reuser during failed cold start gets a permanently-dead handle. |
| S20 | LOW | `wsTransport.ts:143`, `atomicWrite.ts:22`, `providerMaintenanceRunner.ts:89`, `ProjectionSnapshotQuery.ts:468` | `onResubscribe` cross-talk between subscriptions sharing an RPC tag; atomic write without fsync; SIGTERM-only kill of hung update children; hydrated message ordering can differ from event order on timestamp ties (shifts fork prefixes). |

Weakest-tested critical areas: (1) WS push pipeline end-to-end (overflow → resubscribe, snapshot/live overlap, detail/sequence race); (2) rebuild/retention + engine failure recovery; (3) ThreadDeletionReactor → retirement pipeline incl. shared-worktree fork case.

## Web — open bugs (ranked)

| # | Sev | Where | Defect |
|---|-----|-------|--------|
| W1 | HIGH | `orchestrationRecovery.ts` (dead code), `runtime/service.ts:395` | Live stream has no gap defense; the recovery coordinator built for it is imported by nothing. Dropped delta silently corrupts message until next snapshot. |
| W2 | HIGH | `runtime/service.ts:419` | `onEnd` resubscribes synchronously, no delay/cap — permanent server rejection = tight infinite loop. |
| W3 | HIGH | `ChatView.tsx:3314,866` | Cross-thread composer bleed: failed send in thread A injects prompt/images into thread B's composer (single shared refs). |
| W4 | HIGH | `ChatView.tsx:873,1819,2685` | Optimistic messages not thread-scoped; thread switch shows them in wrong thread and can drop an in-flight message + revoke its blob URLs. |
| W5 | HIGH | `ComposerPromptEditor.tsx:1721,78` | Shared Lexical history across threads — Ctrl+Z in B restores A's text into B's draft. No `CLEAR_HISTORY_COMMAND` on switch. |
| W6 | HIGH | `ChatComposer.tsx:1766`, `ChatView.tsx:3050` | Enter sends into a running turn (button correctly refuses); on rejection the message can vanish. This is where message queueing belongs. |
| W7 | HIGH | `useSettings.ts:114,83` | Settings write before hydration overwrites persisted blob with defaults+patch; late hydration reverts UI. |
| W8–W19 | MED | see agent report | Shell/detail dual-writer stale overwrite (store.ts:625/757); projection-version gate can permanently freeze UI after server sequence regression (service.ts:1306); fork success reported as failure + prefill wiped (ChatView.tsx:2953); active thread invisible in sidebar beyond preview window & keyboard traversal dies (`getVisibleThreadsForProject` exists unused — Sidebar.logic.ts:414); stale thread URL → permanent blank screen (route :267); "Commit & push" offered while behind upstream (GitActionsControl.logic.ts:204); Escape in settings commits half-typed input + navigates back; mic leak + wrong-thread transcript (useVoiceTranscription.ts:170); draft persistence dies silently on localStorage quota (storage.ts:46); `@`/`$` tokens hijack Enter with no Escape dismiss; stale diffTurnId silently shows wrong turn's diff; first-load-offline shows eternal "connecting". |
| W-low | LOW | see agent report | Diff collapse state wiped on toggles; `sendInFlightRef` shared across threads; orphaned fork chip → dead route; passive-listener `preventDefault` no-op; toast/timer leaks; optimistic ordering depends on client clock; bare-key user bindings fire while typing; a11y: fork/copy buttons unreachable on touch, near-invisible empty states, no `role="alert"` on error banner; KEYBINDINGS.md drifted from `packages/shared/src/keybindings.ts`. |

## Security (all low — posture is solid)

Nothing exploitable found: auth before RPC construction, CSPRNG+HMAC+DB-backed revocable tokens, arg-array git with `--` guards, traversal blocked everywhere, PR #22 thread-scoping enforced at every claimed surface, gitleaks report empty, CORS wildcard inert (no credentials header). Actionable:

1. **Peer egress is advisory-only** (`gits-confine.sh:95`) — `HTTP(S)_PROXY` env + shared netns can be bypassed; never treat `--egress proxy=` as containment until pasta/nftables (H0c already in TODO). Default `off` is correct.
2. **Verify profile binds all of `/etc` ro** (`gits-confine.sh:69`) — narrow to `passwd`, `ssl`, `resolv.conf`; verify output returns to caller, so a hostile repo can cat `/etc/*` into it.
3. No seccomp/rlimits on confinement profiles — a verify job can fork-bomb the host; consider `systemd-run --scope -p MemoryMax= -p TasksMax=` at the call site.
4. Paired `client` role ≈ full agent-execution rights (dispatches as actor "operator") — intended, but document that a pairing token grants code execution.
5. `GET /api/project-favicon?cwd=` lets any authenticated session probe/read icon-named files in arbitrary dirs — constrain `cwd` to registered project roots.
6. Windows-only: `shell: true` terminal launch interpolates cwd (`externalLauncher.ts:239`).

## UX / QoL recommendations (grounded in code)

TODO.md status corrections: scroll-on-submit mostly shipped (3 call sites remain: ChatView.tsx:2487, 3364, 3500); thread-preview-count shipped (default 6, `contracts/settings.ts:40`); project sorting already default — the real complaint is "updated" = last *user* message, so finished agent turns don't bump threads (fix in `threadSort.ts:51`); archiving is ~80% built but undiscoverable (no context-menu entry, no sidebar entry point); queueing has no groundwork but slots into `composerDraftStore` + the W6 fix.

Top 10 QoL: (1) stale-data dimming while disconnected (`WebSocketConnectionSurface.tsx:478` returns bare children); (2) message queueing; (3) fix sidebar "updated" semantics; (4) diff file-tree nav — `turnDiffTree.ts` already builds it, DiffPanel never uses it + j/k keys; (5) draft-pencil indicators on thread rows; (6) "interrupt & fork/send" one-step; (7) archive in context menus; (8) loading skeleton on thread route; (9) Esc-to-interrupt, focus-composer, Esc dismisses mention popover, mod+/ cheat sheet; (10) commit-message preview before quick commit&push.

Top GUI features: (1) **notifications** — biggest gap, zero Notification/`document.title` badge code anywhere; data already on `SidebarThreadSummary.hasPendingApprovals`; ship title badge → web push (PWA roadmap) → Electron; (2) comment-on-diff-line → composer prefill; (3) fleet status rollup header (running/waiting/failed across all agents); (4) cost/usage surface (TODO already plans codex 5h/weekly visibility); (5) fork tree viz (sidebar glyph+indent minimum; forks menu needs timestamps/status); (6) per-file diff actions (discard file, persist collapse/split mode); (7) offline send queue; (8) up-arrow recall of last message; (9) rebase/merge action for diverged state (currently a dead end); (10) auth-loss explanation toast before teleporting to /pair.

## Conductor (conductor.build) — ideas worth stealing

State: macOS-only, free (seed-funded, YC S24, $22M Series A 2026), Claude Code/Codex/Cursor/OpenCode, ~weekly releases. Matt Palmer leads DevRel (ex-Replit).

Most stealable for GITS: (1) **per-turn checkpoints via private git refs** — auto-commit before every user message incl. linter/generator changes, one-click revert of turn+chat (GITS has checkpoints per turn already; the private-ref + capture-everything angle is the delta); (2) **Checks tab** — one "am I mergeable" pane (git status, CI, PR threads, todos) that soft-gates merge — natural fit with the verifier-critic pipeline; (3) **contextual next-action buttons** tied to lifecycle stage (open PR → respond → fix checks → merge); (4) **line-level diff comments that round-trip to agent instructions and sync GitHub review-thread state**; (5) layered TOML settings (repo-committed team defaults > user > local gitignored); (6) per-workspace `CONDUCTOR_PORT`-style port injection for parallel dev servers; (7) archive-not-delete with full-history restore (GITS archiving nearly there); (8) explicit two-mode parallelism model (multi-workspace vs multi-agent-one-workspace) as documented mental model. Their pain points to avoid: no sandboxing (GITS is ahead), OAuth over-scoping, .env not copied into new worktrees, no OS notifications.
