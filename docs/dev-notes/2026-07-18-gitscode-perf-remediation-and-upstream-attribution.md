# gitscode server — performance & isolation remediation plan

**Target:** run 3–4 concurrent Codex/Claude Code tasks at full capacity with no stalls, no
runaway memory, no cross-task data leakage.
**Status:** diagnosis complete (live-measured + 3 Fable code audits). This file defines the
fix work as discrete tasks for a future Fable+Opus agent workflow. **No code has been changed yet.**

---

## 1. Diagnosis (measured, not guessed)

Live process `apps/server/dist/bin.mjs serve` (PID observed ~28 h uptime), Node v24.18,
`--max-old-space-size=4096`, systemd user unit `gits-cockpit.service`.

| Symptom                 | Measured                                                                                           | Root cause                                                                                                                                                                       |
| ----------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Freezes**             | Event loop bursts to 100–118% every ~5–10 s, 1–6 s each; 60% of CPU samples under `CheckImmediate` | Effect fiber-work volume from the activity-append CQRS pipeline on **synchronous** SQLite + full-thread reloads; a 5 s full-DB snapshot tick                                     |
| **~2.1 GB RSS**         | Steady 2.05–2.18 GB sawtooth, 538 MB swapped, GC (concurrent-mark + scavenge) hot on V8 workers    | **Churn**, not working set — true resident data is a few hundred MB. A 5 s loop materializes the whole 254 MB DB as JS objects; payloads bloated ~30× by untruncated tool output |
| **Constant reconnects** | `Failed to publish disconnected-session auth update` — **45/h and rising**, 154/24 h               | **Bug in effect@4.0.0-beta.73** `MutableList.take` corrupts a PubSub poller list on disconnect → publish crashes. Amplified by freeze→disconnect→resubscribe stampede            |

**The box is healthy** (8 cores, 15 GB RAM, load ~1.5, 11 GB free). This is entirely
application design, so **the answer to "Bun/Rust/optimize?" is: optimize in place.** Bun runs
the same Effect scheduler (won't touch the storm) but is a near-free A/B since dual-runtime is
already wired in (`server.ts:179-225`, `BunPTY.ts`); Rust is a non-starter (~95k LOC of Effect +
JS-only agent SDKs `@anthropic-ai/claude-agent-sdk`, `@opencode-ai/sdk`, `node-pty`). See T15.

### Root causes, deduplicated across the three audits

1. **Untruncated payloads** — `tool.completed`/`tool.updated` embed raw `data` (82 MB total, up
   to 1.2 MB each). The single amplifier under every other cost. → T1
2. **`context-window.updated` flood** — 8,606 gauge events logged as history. → T2
3. **5 s full-DB snapshot** — `AutomodeDriver` tick calls `getSnapshot()` (10 full-table scans +
   full schema decode) _before_ the kill-switch check, every 5 s, even when automode is off. → T3
4. **Full-thread reloads** — `refreshThreadShellSummary` / `getThreadDetailById` load ALL
   activities (no LIMIT; worst thread 8,596 rows / 20.7 MB) per event and per subscriber. → T4, T5
5. **Reconnect defect** — effect beta `MutableList.take` returns `undefined` instead of `Empty`
   → crashes publishes on disconnect. → T6
6. **WS fan-out** — one global unbounded `eventPubSub`; every `subscribeThread`/`subscribeShell`
   client receives every domain event and filters _after_ delivery. Perf **and isolation** issue. → T7, T8
7. **Reconnect amplifier** — buffer overflow terminates the stream → full resubscribe + snapshot. → T9
8. **Secondary churn** — terminal scrollback re-split per pty chunk + 128 inactive sessions (T10),
   `input_json_delta` O(n²) re-parse (T11), `GitsCapacityMonitor` 12 MB sync tail reads (T12).

### "Data leaks" — both readings covered

- **Resource leaks / unbounded growth:** T1, T3, T4, T5, T10 (bound every unbounded buffer/read model).
- **Cross-task data isolation:** T7 is the key one — today every WS subscriber's fiber _sees_
  every thread's events before a client-side filter drops them; routing server-side per
  `aggregateId` guarantees a subscriber only ever receives events for threads it owns. T1 also
  cuts sensitive tool output at rest in the event store. Plus an isolation audit: T16.

---

## 1a. Upstream attribution — Sonnet 5 vs `pingdotgg/t3code` `main` (compared today)

> **Correction (2026-07-18, git-verified against real upstream `5ca32661`; confirmed by a 5-agent
> verify pass).** The original "source-level copy, zero shared commits, cannot `git merge`/`rebase`"
> premise below is **refuted**. This **IS a genuine git fork**: root commit **`f194c966`**
> (2026-02-07) is a real _shared ancestor_ of both sides (`git merge-base --is-ancestor` succeeds
> against HEAD and upstream), and history is common all the way to the merge-base **`b3e8c033`**
> ("T3 Code Mobile [WIP] (#2013)", 2026-05-29) — **~1,480 shared commits** from root to that point.
> The two lines diverged only after 2026-05-29: fork **+479**, upstream **+497**
> (`git rev-list --left-right --count refs/upstream/t3code-main...HEAD`).
>
> A `git merge`/`rebase`/cherry-pick **is** mechanically possible (a real merge-base exists;
> `git merge-tree` runs to completion). But a _wholesale_ merge is impractical: the dry-run conflicts
> in **~240 files** (64 in server subsystems), drowned in upstream's pnpm+Vite migration, a ~40-commit
> error-restructuring wave, and directory renames. **Correct framing: fixes are ported file-by-file /
> cherry-picked _by choice_, not because merge is technically blocked.** Upstream `main` is now
> **`5ca32661`** (2026-07-17, **v0.0.29-nightly**), past the `0.0.28` compared below. Version
> divergence **confirmed exactly**: fork `t3@0.0.24` / `effect@beta.73` / `bun.lock` vs upstream
> `t3@0.0.28` / `effect@beta.78` / `pnpm-lock.yaml`. Concrete port targets → **§1b**.

**[SUPERSEDED — see correction above]** ~~This fork is a _source-level_ copy, not a git fork — its
history starts fresh (`f194c966`, 2026-02-07) with **zero shared commits** with `pingdotgg/t3code`.
You cannot `git merge`/`rebase` upstream; fixes port file-by-file.~~ Divergence (versions
**confirmed** — see correction): fork `t3@0.0.24` / `effect@beta.73` / bun vs upstream `t3@0.0.28` /
`effect@beta.78` / pnpm. `gits/ delamain/ crit/ voice/ push/ rtk/ browser-preview/ provider-auth/
perf/` are fork-only; `cloud/ mcp/ relay/ preview/` are upstream-only (the fork is behind there
too).

> ✅ **Rows below re-verified 2026-07-18 against real upstream `5ca32661`** (5-agent pass, byte-level
> diffs). All classifications **hold**, with two refinements folded in: **T5** is split (part
> fork-only), and **T9**'s "readEvents unused" is corrected (it _is_ wired into a replay RPC, just
> not the live-subscription resume path). Evidence quoted per task in the workflow journal.

| Tasks                            | Classification                                                                                                                                                                                                                                                                                                                               | Action                                                                                                                                                                                                                                                                                                                              |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **T1, T2, T4, T7, T8, T10, T11** | **upstream-shared** ✅ — byte-identical in t3code `5ca32661` (verified; no upstream fix exists — still fork work)                                                                                                                                                                                                                            | fix locally **and** worth upstreaming as PRs (not fork damage)                                                                                                                                                                                                                                                                      |
| **T5** _(split)_                 | **mixed** ✅ — module-level unbounded read model + missing `deleted_at` filter are **upstream-shared**; the activities-uncapped-while-messages-capped defect (`ProjectionSnapshotQuery.ts:1619-1622`) is **fork-only** (introduced by fork commits)                                                                                          | fix both locally; upstream-PR only the shared half                                                                                                                                                                                                                                                                                  |
| **T3, T12**                      | **fork-specific** ✅ — whole `gits/` automode + capacity monitor absent upstream (verified `git ls-tree`)                                                                                                                                                                                                                                    | your GITS code — fix locally only                                                                                                                                                                                                                                                                                                   |
| **T9**                           | fork-only `bufferOrTerminate` 512-cap; **upstream ships the fix** (`482d56233`+`c14a5ca49`)                                                                                                                                                                                                                                                  | **port** upstream's `afterSequence`+`readEvents` resume. Correction: `OrchestrationEngine.readEvents` exists **and is** wired into the `replayEvents` RPC (`ws.ts:1190`) — just **not** into the `subscribeThread`/`subscribeShell` live paths (still full-resnapshot). Fork contracts have **no** `afterSequence` field yet. → §1b |
| **T6**                           | **dependency bug** ✅ — `MutableList.take/filter/remove` byte-identical in beta.73 **and** beta.78 (verified; upstream's `effect@beta.78.patch` touches only `McpServer`, not `MutableList` — bump won't fix). Note: fork's `effect@beta.73.patch` currently patches only `RpcClient`, so the `MutableList.take` hunk **still needs adding** | patch effect locally + report to the Effect project                                                                                                                                                                                                                                                                                 |

**Takeaway:** the freezes/RSS (T1/T2/T4/T5) and the fan-out+isolation gap (T7/T8) are **upstream
t3code's existing design**, not something the fork broke — upstream still has them today. Only
**T3 and T12** (GITS automode + capacity monitor) are perf risk this fork introduced. Heavy usage
on this box (28 h, ~30k activities, 4 GB heap cap) multiplies severity but is not the root cause.

---

## 1b. Upstream port targets — what to pull from `t3code` (Fable xhigh survey, 2026-07-18)

Surveyed all **497** upstream commits `b3e8c033..5ca32661` (2026-05-29 → 2026-07-17); 162 touch
fork-relevant subsystems, 42 touch `ws.ts`. ~⅓ is pure churn (pnpm+Vite migration, a ~40-commit
`[codex] Structure errors` wave, namespace-import refactors) — **skip all of it**.

**Strategy:** selective `git cherry-pick`/`git format-patch` is now viable (real merge-base) and
**preferred** for the fixes below; a wholesale merge is not (240-file conflict set). ⚠️ Cherry-pick
windows are **closing** — each upstream refactor wave renames the files these patches target, so
port the high-value ones soon.

### High priority

| Port                                 | Upstream                   | Overlaps    | Why                                                                                                                                                                                                                                                                                 |
| ------------------------------------ | -------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **T9 resume path**                   | `482d56233` + `c14a5ca49`  | **T9**      | Exactly what T9 prescribes: `subscribeThread`/`subscribeShell` resume via `input.afterSequence` → `readEvents(afterSequence, …)` + `Queue.unbounded`. Fork still has `bufferOrTerminate` 512-cap (`ws.ts:213,226,1234,1302`) and **no** `afterSequence` in contracts. Port-adapted. |
| **Claude SDK 0.3.x system messages** | `e1ce9f850` (+`75257d64e`) | T2-adjacent | Fork runs `@anthropic-ai/claude-agent-sdk ^0.3.154`; its system-message switch lacks all three new cases → every such message hits `emitRuntimeWarning` (`ClaudeAdapter.ts:2396`) = warning flood. Direct port.                                                                     |
| **Sonnet 5 + Fable 5 models**        | `9d66b104f` + `de58ec8e2`  | —           | Fork catalog tops out at `opus-4-8`/`sonnet-4-6`/`haiku-4-5`. ~43-line catalog+contracts diff, immediate value on a box running Claude tasks.                                                                                                                                       |

### Medium priority (port unless noted)

- **`c49d424e3`** normalize protocol-relative remote host as `https` — fork has the byte-identical
  pre-fix expr at `packages/shared/src/remote.ts:15`; **directly relevant to the current
  `feat/remote-localhost-access` branch**.
- **`300f7fd11` + `a74dfd4f3`** drop `shell:true` for ssh/tunnel/tailscale spawns — **downgraded
  (reconciled vs `origin/gits`)**: the fork already spawns shell-less on Linux
  (`shell: process.platform === "win32"` in `packages/ssh/src/command.ts:183`,
  `ProcessDiagnostics.ts:283`, `ServerEnvironmentLabel.ts:62`), so this is cosmetic cleanup here,
  **not** injection-surface hardening. The only true `shell: true` is `process/externalLauncher.ts:244,251`
  (+ desktop). Low value.
- **`f5849f7d7`** redacted stdout on failed ssh commands — overlaps the fork's in-flight
  `redactSecrets.ts` work.
- **`24f9c2a08`** cross-instance MCP OAuth locks for concurrent Codex shadow homes — the plan's whole
  target is 3–4 concurrent tasks, which is exactly what races OAuth (**T16**).
- **`ae39bacf0`** handle non-resumable pending-user-input — fork has the pre-fix single-string match
  (`ProviderCommandReactor.ts:281`) → codex-variant errors leave phantom pending state / stuck approvals.
- **`31ca9e553`** skip undecodable provider-runtime rows when listing sessions — one stale row from an
  older build currently disables every session-enumerating consumer (real availability bug for an
  in-place-upgraded long-lived server). Fork file is `persistence/Layers/ProviderSessionRuntime.ts`
  (`list:168-183` fails the whole list on one `ParseError`); upstream path is `persistence/` — **port
  needs path adaptation**.
- **`eb733c10f` + `4e3f2f04d`** `CLAUDE_CONFIG_DIR` per-instance config isolation + cwd probe (**T16**);
  **`bcd640bf4`** ACP assistant-ID collisions after restart; **`4abf8b46c`** ignore stale shell-reducer
  events (2-line guard); **`57f6bf7ed`** turn-fold projection guard (port-adapted).
- **`a04c09a19`** HttpApi for Environment APIs + standardized authn/authz — **investigate**: the
  `feat/remote-localhost-access` branch is reworking exactly this surface; coordinate rather than port blind.

### Low priority

`7f1cb6103` (Cursor binary `cursor-agent` vs Grok's `agent`), `3201e00ad`/`d114e2772` (worktree
metadata during branch sync, T16), `804d44cfb` (ssh `fnm` support), `ae7e88b0e` (codex app-server
protocol/service-tiers — port-adapted; fork's `CodexDeveloperInstructions.ts` is heavily customized),
`49c1b6468` (multi-account GitHub/GitLab/Azure auth — **investigate**, fork restructured
`sourceControl/`).

### Skip

- **No upstream fix exists** for T1/T2/T4/T5/T7/T8/T10 — re-confirmed against `5ca32661`; these stay
  fork work (and are legitimate upstream-PR candidates afterward).
- **T6**: upstream never patched `MutableList` — bump won't help (see §1a).
- New upstream subsystems (`cloud/` T3 Connect, `mcp/` McpHttpServer, `relay/`) — the fork has its own
  equivalents (`browser-preview/`, `push/`, tailnet). Revisit `mcp/` only if HTTP-MCP is wanted.
- The pnpm+Vite migration and refactor waves — pure churn vs a bun-based fork.

---

## 2. Execution model for the workflow

- **Phases are gates.** Finish + verify a phase before the next; Phase 1 alone should remove most
  of the freezes and the RSS bloat, so measure before doing the harder architectural tasks.
- **Parallelism:** tasks in the same phase with **disjoint files** may run concurrently in
  separate worktrees (`isolation: worktree`). File-conflict groups that must serialize:
  - `ProviderRuntimeIngestion.ts` → **T1, T2** (same file; one agent, sequential edits).
  - `ProjectionSnapshotQuery.ts` / `ProjectionPipeline.ts` → **T4, T5** (coordinate).
  - `ws.ts` → **T7, T8, T9** (same file; sequence T7→T9→T8).
- **Agent split:** **Opus** for high-blast-radius / correctness-critical / architectural tasks
  (state, projections, event delivery, isolation). **Fable** for scoped, localized diffs with a
  clear before/after. Both are capable; the split is about failure cost, not skill.
- **Every task ends with its Verify step green** (defined per task; harness in T14). After T1,
  run `t3 db rebuild-projections` so the payload cap applies retroactively.
- **Do not** open the Node inspector or expose port 9229 on this tailnet-reachable host; use the
  SQL/log verifications below instead.

### Phase overview

| Phase | Goal                           | Tasks              | Gate                                                    |
| ----- | ------------------------------ | ------------------ | ------------------------------------------------------- |
| 0     | Instant relief, zero-risk      | T13, T14           | metrics captured; baseline recorded                     |
| 1     | Kill the churn (freezes + RSS) | T1, T2, T3, T4, T5 | RSS < 1 GB, no 5–10 s bursts, GC time down              |
| 2     | Fix reconnects + isolation     | T6, T7, T9, T8     | disconnect errors = 0, subscriber sees only own threads |
| 3     | Secondary churn                | T10, T11, T12      | no per-chunk / per-call spikes                          |
| 4     | Confirm & optionally Bun       | T15, T16           | before/after report; isolation audit clean              |

---

## 3. Tasks

> Format per task: **Goal · Evidence · Files · Change · Agent (why) · Effort · Risk · Depends · Verify**

> ✅ **Reconciled against `origin/gits` (the canonical fork), 2026-07-18 (Fable pass).** Every task's
> cited file exists on `gits` and every defect pattern is present. T1–T5, T10, T12, `OrchestrationEngine`,
> `patches/`, and `remote.ts` line numbers are **identical** on `gits` and HEAD — those hold exactly.
> **But the `ws.ts` and `ClaudeAdapter.ts` citations below are HEAD (`feat/remote-localhost-access`)-relative**
> — that branch adds +146/+55 lines, so on `gits` they shift down ~100–180 lines. If remediation
> branches from `gits`, use these corrected `gits` numbers:
>
> - **T3** — `getSnapshot()` is `AutomodeDriver.ts:136` (not `:135`); `TICK_INTERVAL_MS` is **already
>   env-overridable** via `GITS_AUTOMODE_DRIVER_TICK_MS` (default 5000) — a ready temporary mitigation knob.
> - **T6** — publish site `SessionCredentialService.ts:204` (block ~195–211); ws release `ws.ts:2195`
>   (`sessions.markDisconnected`).
> - **T7** — subscribeThread filter `ws.ts:1158-1170`; subscribeShell default case `ws.ts:540-556`.
> - **T8** — `PROVIDER_STATUS_DEBOUNCE_MS` `ws.ts:180`, use `:2054`.
> - **T9** — `WS_PUSH_SUBSCRIBER_BUFFER=512` `ws.ts:192`; `bufferOrTerminate` `:220-243`, uses
>   `:1103`(shell)/`:1171`(thread); `readThreadDetailSnapshot:244`; `readEvents` wired into the
>   `replayEvents` RPC at `ws.ts:1055-1059`.
> - **T10** — ws-side terminal frames start `ws.ts:1977`.
> - **T11** — `ClaudeAdapter.ts:1756-1763` (`tryParseJsonRecord(tool.partialInputJson + delta)`).
> - **§1b SDK subtypes** — fall through to `emitRuntimeWarning` at `ClaudeAdapter.ts:2344-2348`.
>
> **No §1b port target is already fixed on `gits`** (afterSequence absent, catalog stale, single-string
> match, no OAuth locks, protocol-relative expr intact — all verified pre-fix). The 2nd doc's §5 `?key=`
> redaction can't be closed on `gits` yet: `redactSecrets.ts` is untracked feature-branch work, not on `gits`.

### T1 — Truncate oversized activity payloads

- **Goal:** stop full tool output riding the event/read-model/WS path (the master amplifier).
- **Evidence:** `tool.completed` = 82.4 MB / 7,809 rows, max single 1.21 MB; `detail` is capped to
  180 chars but `data` is passed through raw.
- **Files:** `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:608` (`item.updated`),
  `:656` (`item.completed`); pattern ref `truncateDetail` `:165`. _(path is `orchestration/Layers/`,
  not `provider/Layers/` — corrected per upstream comparison; `truncateDetail` is applied to `detail` but never `data`.)_
- **Change:** cap `data` to a few KB (or drop it — UI renders `summary`+`detail`). Large output
  goes out-of-band (disk/on-demand fetch) if needed later.
- **Agent:** Fable (localized, clear diff).
- **Effort:** S · **Risk:** Low (UI unaffected) · **Depends:** —
- **Verify:** new `tool.completed` events < few KB (`SELECT MAX(LENGTH(payload)) FROM
orchestration_events WHERE event_type='thread.activity-appended' AND occurred_at > datetime('now','-2 minutes')`);
  run `t3 db rebuild-projections`; DB growth rate drops.

### T2 — Throttle `context-window.updated`

- **Goal:** drop ~28% of domain events that are a gauge, not a log.
- **Evidence:** 8,606 `context-window.updated` activities.
- **Files:** `ProviderRuntimeIngestion.ts` (`runtimeEventToActivities` mapping for
  `context-window.updated`).
- **Change:** coalesce to ≤1 per turn or 1 per 5 s per thread (keep latest value only).
- **Agent:** Fable · **Effort:** S · **Risk:** Low · **Depends:** T1 (same file — sequence after).
- **Verify:** event count for that kind drops ≥90%; context UI still updates within ~5 s.

### T3 — Stop the 5 s full-DB snapshot in AutomodeDriver

- **Goal:** eliminate the periodic 40–80 MB/s allocation spike (the sawtooth + a burst source).
- **Evidence:** `AutomodeDriver.ts:25` `TICK_INTERVAL_MS=5000` → `:135` `supervisor.getSnapshot()`
  **before** the mode/kill-switch check `:139` → `AutomodeSupervisor.ts:429-438` `readBudgetUsage`
  → `AutomodeUsageMeter.ts:69-76` → `ProjectionSnapshotQuery.getSnapshot()` `:1053-1137` (10 full
  `findAll` + `decodeReadModel`). Runs even with automode off.
- **⚠ Reconcile first:** the storm audit listed the AutomodeDriver _interval_ as fine; the memory
  audit found the _per-tick cost_. Both can hold. **First** confirm the tick actually calls
  `getSnapshot` every 5 s (add a temporary `Effect.logDebug` at `AutomodeDriver.ts:135`, watch for
  5 s cadence). If confirmed, apply the fix; if not, downgrade priority and lean on T4.
- **Files:** `apps/server/src/gits/Layers/AutomodeDriver.ts:135,139`;
  `apps/server/src/gits/Layers/AutomodeUsageMeter.ts:69-76`;
  `apps/server/src/gits/Layers/AutomodeSupervisor.ts:429-438`.
- **Change:** (a) hoist the mode/kill-switch check above `getSnapshot()` (reads `stateRef` only);
  (b) replace `readBudgetUsage`'s full snapshot with a SQL aggregate over
  `projection_thread_activities WHERE kind IN ('usage.cost.updated','context-window.updated')`,
  and/or memoize 60 s (reuse `GitsSlotScheduler.ts:40,454-459` memo pattern).
- **Agent:** Opus (touches automode control flow + budget accounting correctness).
- **Effort:** M · **Risk:** Med · **Depends:** — (independent of T1/T2)
- **Verify:** no 5 s cadence in the debug log; allocation rate + scavenge frequency drop; heap
  sawtooth flattens; budget numbers unchanged vs a pre-change snapshot.

### T4 — Replace per-event full-thread reloads with SQL aggregates

- **Goal:** remove the O(thread-size) reload at every turn/segment boundary (turn-boundary bursts).
- **Evidence:** `ProjectionPipeline.ts:541-584` `refreshThreadShellSummary` loads all
  messages+activities+plans per `activity-appended`/`message-sent`/`session-set`/`turn-diff`
  (`:744,:760,:776,:814`); `ProjectionSnapshotQuery.ts:2136-2260` `getThreadDetailById` loads ALL,
  no LIMIT; ingestion calls `getLoadedThreadDetail` at `ProviderRuntimeIngestion.ts:1491,1558,1614,1627`.
- **Change:** compute the summary counts via `COUNT(*)`/`MAX(created_at)` aggregates instead of
  materializing rows; in ingestion, fetch only what's needed (one turn's messages; proposedPlans
  list) rather than the whole thread. Pending-user-input count → indexed query over the two
  relevant activity kinds.
- **Agent:** Opus (projection correctness; deep pipeline).
- **Effort:** M–L · **Risk:** Med · **Depends:** benefits from T1/T5 (smaller n).
- **Verify:** add a temp log of `activityRows.length` + elapsed ms in the reload path — should
  disappear/shrink to sub-ms; `orchestrationCommandDuration` metric (`OrchestrationEngine.ts:323-339`)
  per `commandType` drops; freeze windows gone at turn boundaries.

### T5 — LIMIT the activities query + bound the in-memory read model

- **Goal:** cap the permanent command read model and every activities load.
- **Evidence:** `OrchestrationEngine.ts:120,383` module-level `commandReadModel` kept for process
  life; boot hydrate `ProjectionSnapshotQuery.ts:1619-1624` caps messages at 2,000 but puts **all**
  activities in (`:1622`, no `.slice`), and `listThreadRows` has no `deleted_at` filter. Incremental
  projector trims to 500 (`projector.ts:678`) only for threads that get new activity.
- **Change:** add `.slice(-500)` at `ProjectionSnapshotQuery.ts:1622` (mirror the messages cap one
  line above); LIMIT `listThreadActivityRowsByThread` to newest N; exclude `deleted_at IS NOT NULL`
  threads from the command model.
- **Agent:** Fable (contained; mirrors an existing pattern).
- **Effort:** S · **Risk:** Low–Med (confirm UI lazy-loads older activities) · **Depends:** pairs with T4.
- **Verify:** read-model resident bytes drop (heap snapshot / RSS after boot); faster startup.

### T6 — Fix the reconnect defect (effect `MutableList.take`)

- **Goal:** stop the 45/h publish crash on disconnect.
- **Evidence:** WS close interrupts a parked subscriber → `MutableList.remove` (`effect/dist/PubSub.js:939-942`)
  → `filter` rebuilds head as an empty-array chunk (`MutableList.js:731-749`) → next publish
  `strategyCompletePollersUnsafe` (`PubSub.js:2088-2105`) → `MutableList.take` reads `array[offset]`
  of `[]` = `undefined` (`MutableList.js:629-643`) → `Deferred.doneUnsafe(undefined)` reads `.effect`
  of undefined. Publish site: `SessionCredentialService.ts:188-211` invoked from `ws.ts:2337-2341`
  release, before the request scope closes the subscription.
- **Files:** `patches/effect@4.0.0-beta.73.patch` (repo already patches effect).
- **Change:** in `MutableList.take`, add as first line: `if (!self.head || self.length <= 0) return Empty;`.
  Report upstream to Effect.
- **⚠ Bumping `effect` will NOT fix this:** `MutableList.take`/`filter`/`remove` are byte-identical in
  beta.73 (your pin) and beta.78 (upstream's) — the patch is required either way. The 45/h _rate_ is
  fork-amplified by T9 (forced reconnects) and the fork-only `auth/Layers/SessionCredentialService.ts`
  disconnect-publish (no upstream equivalent) — so T9 also lowers how often this bug can even fire.
- **Agent:** Fable (exact fix known, single patch hunk).
- **Effort:** S · **Risk:** Low · **Depends:** —
- **Verify:** `journalctl --user -u gits-cockpit.service --since "10 min ago" | grep -c
'Failed to publish'` → 0 after redeploy under active reconnects.

### T7 — Server-side per-thread event routing (perf **+ isolation**)

- **Goal:** remove O(subscribers × events) fan-out **and** guarantee a subscriber only receives
  its own threads' events.
- **Evidence:** global unbounded `eventPubSub` `OrchestrationEngine.ts:123`; per-subscriber
  post-delivery filter `ws.ts:1275-1295` (`subscribeThread`) and `ws.ts:549-563` (`subscribeShell`).
- **Change:** one dispatcher fiber consumes `eventPubSub` and routes into per-thread (per-`aggregateId`)
  subscriber queues; filter **once** server-side, never per subscriber. Authorize the thread↔client
  binding at subscribe time so cross-thread events are never placed on a client's queue. Batch WS
  frames per tick.
- **Agent:** Opus (core event delivery + isolation correctness).
- **Effort:** L · **Risk:** Med–High · **Depends:** T6 (clean publishes first).
- **Verify:** instrument a subscriber to assert it only ever sees its subscribed `aggregateId`;
  CPU fan-out cost gone under N clients; add a test that a client subscribed to thread A never
  receives a thread B event.

### T8 — Debounce `subscribeShell` `thread-upserted` frames

- **Goal:** stop one sync SQL + WS frame per thread event per client.
- **Evidence:** `ws.ts:549-563` default case runs `getThreadShellById` (sync SQL + decode) per
  shell subscriber per event.
- **Change:** coalesce `thread-upserted` per `threadId` (~200 ms), reusing `PROVIDER_STATUS_DEBOUNCE_MS`
  pattern (`ws.ts:186,2199`).
- **Agent:** Fable · **Effort:** S · **Risk:** Low · **Depends:** T7 (same file — sequence last).
- **Verify:** WS frame + query count under burst drops sharply; UI still coherent.

### T9 — Break the reconnect amplifier

- **Goal:** stop overflow → terminate → full-resubscribe stampede.
- **Evidence:** `bufferOrTerminate` 512 cap terminates slow subscribers `ws.ts:188-198,226-248`;
  resubscribe re-runs `readThreadDetailSnapshot` `ws.ts:250-269`.
- **Upstream already fixed this (port, don't design):** upstream t3code uses `Queue.unbounded` (never
  terminates) plus an `input.afterSequence` param that replays only the delta via
  `orchestrationEngine.readEvents(afterSequence, …)` instead of a full snapshot (upstream `ws.ts:1160-1236`).
  Your fork's `bufferOrTerminate`/512-cap is fork-only, and the primitive you need —
  `OrchestrationEngine.readEvents` — **already exists in your tree but is never wired into `ws.ts`**
  (`orchestration/Layers/OrchestrationEngine.ts:391`). Port upstream's resume-by-sequence path.
- **Change:** on overflow, resume from last-delivered sequence via the event store instead of
  terminate→full snapshot; rate-limit resubscribe snapshots.
- **Agent:** Opus (delivery semantics) · **Effort:** M · **Risk:** Med · **Depends:** T7.
- **Verify:** induce a burst; clients recover without a snapshot stampede; no cascading freeze.

### T10 — Terminal history churn + inactive cap

- **Goal:** remove O(history) re-split per pty chunk and bound inactive scrollback.
- **Evidence:** `terminal/Layers/Manager.ts:1431-1442` + `capHistory` `:691-701` full concat +
  `split("\n")` per chunk; `:53,:57` `DEFAULT_HISTORY_LINE_LIMIT=5000`,
  `DEFAULT_MAX_RETAINED_INACTIVE_SESSIONS=128`; history persisted at `:1172`; full history in each
  output frame (`:1450`, `ws.ts:2157-2166`).
- **Change:** only `capHistory` when a running newline count exceeds the limit (not every chunk);
  send `history: null` on incremental output (clients already get `data`); drop inactive cap to ~16
  and clear `history` on session exit (reload from disk on reattach).
- **Agent:** Fable · **Effort:** S–M · **Risk:** Low · **Depends:** —
- **Verify:** fast build output no longer spikes CPU/GC; terminal-manager resident bytes drop.

### T11 — `input_json_delta` O(n²) guard

- **Goal:** avoid re-`JSON.parse` of the whole accumulated tool input per delta chunk.
- **Evidence:** `provider/Layers/ClaudeAdapter.ts:1814-1815`.
- **Change:** guard the parse (e.g. only attempt when the buffer plausibly closes — ends with `}`),
  or parse incrementally.
- **Agent:** Fable · **Effort:** S · **Risk:** Low · **Depends:** —
- **Verify:** a large tool-call argument no longer scales CPU quadratically.

### T12 — GitsCapacityMonitor tail reads

- **Goal:** stop synchronous multi-MB reads blocking the loop per `getSnapshot`.
- **Evidence:** `gits/Layers/GitsCapacityMonitor.ts:36` `DEFAULT_TAIL_BYTES=12MB`, sync reads
  `:319-332,398-436,:981`.
- **Change:** drop `DEFAULT_TAIL_BYTES` to ~256 KB (rate-limit data is at the tail); memoize at the
  monitor (not per caller).
- **Agent:** Fable · **Effort:** S · **Risk:** Low · **Depends:** —
- **Verify:** `getSnapshot` no longer produces a loop-blocking spike.

### T13 — GC/runtime tuning + clear stale swap _(Phase 0, ops)_

- **Goal:** cheap immediate relief while the code fixes land.
- **Change:** add `--max-semi-space-size=64` (try 128) to the server's Node args to cut scavenge
  frequency; after fixes land, restart `gits-cockpit.service` once to release the 538 MB stale swap.
  `vm.swappiness` is already 10 — leave it.
- **Where:** the systemd user unit for `gits-cockpit.service` (locate via
  `systemctl --user cat gits-cockpit.service`); edit `ExecStart`/`Environment`.
- **Agent:** Fable (drafts the unit diff) — **requires user consent to edit the unit + restart.**
- **Effort:** XS · **Risk:** Low · **Depends:** —
- **Verify:** scavenge rate down in a fresh profile; `free -h` shows swap cleared post-restart.
- **Note:** under Bun (T15) `--max-old-space-size`/`--max-semi-space-size` are V8 no-ops — drop them there.

### T14 — Measurement harness (before/after) _(Phase 0)_

- **Goal:** quantify each phase; prevent "felt faster" conclusions.
- **Change:** wire `perf_hooks.monitorEventLoopDelay` into the existing `observability/` tree;
  record p99 loop delay, RSS ceiling, GC time, and WS reconnect rate. Capture a baseline now.
- **Runtime confirmation queries (no inspector needed):**
  - `SELECT event_type, COUNT(*) FROM orchestration_events WHERE occurred_at > datetime('now','-60 seconds') GROUP BY 1 ORDER BY 2 DESC;` (expect `thread.activity-appended` to dominate + correlate with bursts)
  - disconnect-error rate: `journalctl --user -u gits-cockpit.service --since "1 hour ago" | grep -c 'Failed to publish'`
- **Agent:** Fable · **Effort:** S · **Risk:** none · **Depends:** — (do first)
- **Verify:** baseline numbers recorded; same script re-run after each phase.

### T15 — Bun A/B experiment _(optional, after Phase 1)_

- **Goal:** measure whether JSC's GC handles the (now smaller) heap better — near-zero switching
  cost since dual-runtime is already wired.
- **Evidence:** `server.ts:179-225` branches on `typeof Bun`; `terminal/Layers/BunPTY.ts` real PTY
  via `Bun.spawn` (bypasses node-pty); `persistence/Layers/Sqlite.ts:18-30` runtime-selects the
  sqlite driver.
- **Change:** on a staging port with a **copy** of the DB, run `bun apps/server/dist/bin.mjs serve
--port <staging>` (or `bun src/bin.ts`); drop `--max-old-space-size`; do **not** use `--smol`.
  Measure the T14 metrics over a real agent session.
- **Risks to test:** `@anthropic-ai/claude-agent-sdk` spawning the Claude CLI via Bun's
  child_process; `@effect/sql-sqlite-bun` vs the hand-rolled `NodeSqliteClient` under concurrent
  WAL writes; `web-push` crypto under Bun; `BunPTY` fidelity for full-screen TUIs (vim/htop).
- **Agent:** Fable · **Effort:** ~1 day · **Risk:** contained (staging) · **Depends:** T1–T4.
- **Verify:** side-by-side T14 metrics; adopt only if GC pauses / RSS clearly win. Switching = a
  launch-command change.

### T16 — Concurrent-task isolation audit _(Phase 4)_

- **Goal:** confirm the 3–4 concurrent Codex/Claude tasks cannot see each other's data.
- **Scope:** (a) verify T7's per-thread authorization holds for every WS stream (thread, shell,
  provider events); (b) audit worktree isolation — recurring `worktree.burial.remove-failed` WARNs
  suggest cleanup gaps; confirm one task's worktree/env/secrets aren't reachable by another;
  (c) confirm tool-output payloads (post-T1) and provider NDJSON logs don't co-mingle secrets
  across sessions.
- **Agent:** Opus (security/isolation reasoning).
- **Effort:** M · **Risk:** n/a (audit) · **Depends:** T7.
- **Verify:** a written isolation matrix (stream × thread → allowed) with a test per row; worktree
  cleanup warnings resolved.

---

## 4. Expected outcome

- **After Phase 1:** freezes largely gone (no 5–10 s bursts), RSS < ~1 GB, GC time down sharply —
  from three small diffs plus two aggregate rewrites. This is the bulk of the win.
- **After Phase 2:** reconnect errors at 0, and cross-task event isolation enforced server-side.
- **Phase 3–4:** remove the remaining spiky costs; decide Bun on data, not vibes.

**Do not rewrite in Rust. Do not "migrate to Bun" as a fix.** The cheapest path that removes the
freezes is a handful of TypeScript diffs, most of them one-liners — captured above.
