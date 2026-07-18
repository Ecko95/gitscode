# Perf-remediation orchestration — handoff ledger

**Run:** T1–T16 from `docs/dev-notes/2026-07-18-gitscode-perf-remediation-and-upstream-attribution.md`
**Integration branch:** `feat/perf-remediation` (off `origin/gits` @ `d01e1840f`)
**Orchestrator:** Fable 5 @ high (frontier-orchestration pattern). Execution: Opus 4.8 @ high (complex), Sonnet 4.6 @ medium (default), Haiku 4.5 @ low (mechanical).
**State protocol:** this file is the single ledger; one file per slice under `slices/`. Updated at wave boundaries, not continuously. After any compaction/resume, re-ground from this file.

## Scope / definition of done

Remove the freezes, RSS churn (~2.1 GB → <1 GB), reconnect crashes (45/h → 0), and cross-task
isolation gaps on `gits-cockpit.service`, per T1–T16. Done = end acceptance gate green: full CI
suite + projection/integration tests + `t3 db rebuild-projections` on a DB copy, then one
controlled live redeploy with every task's live Verify assertion passing (acceptance matrix below).

**Non-goals:** Rust rewrite; Bun migration as a "fix" (T15 is a measured A/B only); upstream
ports from §1b (separate effort); any change to `cloud/ mcp/ relay/` subsystems.

## Operator decisions (recorded 2026-07-18)

1. **Verify:** behavioral verification only at the end; per-slice guard is `turbo run typecheck build --filter=t3` only.
2. **Scope:** full autonomous run across Phases 0–4 (no mid-run approval gate).
3. **Live host:** workflow may drive `gits-cockpit.service` for live assertions. Consent checkpoint retained for the T13 systemd edit + first production restart.

## Model-effort policy

| Tier                   | Model/effort      | Assignment                                                                    |
| ---------------------- | ----------------- | ----------------------------------------------------------------------------- |
| Orchestrator/validator | fable-5/high      | briefs, keep-change-drop review, merges, acceptance matrix. Never implements. |
| Complex/architectural  | opus-4-8/high     | T3 T4 T7 T9 T14 T15 T16; lane lead for B and D/H                              |
| Default implementer    | sonnet-4-6/medium | T1 T2 T5 T6 T8 T10 T11 T13                                                    |
| Mechanical             | haiku-4-5/low     | T12                                                                           |

Escalation: 2 failed acceptances on a slice → Fable re-scopes (smaller slice or model↑). Agents never improvise around the brief.

## Blast radius (assumptions to verify during run)

- **Highest risk:** T7 rewires core event delivery (`OrchestrationEngine.eventPubSub` → per-`aggregateId` routing). Every WS consumer (thread, shell, provider status) is downstream. Single-writer Opus lead; T5c→T7→T9→T8 sequence.
- **Data contracts:** T9a adds `afterSequence` to `packages/contracts` — client-runtime consumers must tolerate the optional field (assumption: additive = safe; verify in typecheck of dependent packages).
- **T1 changes at-rest event payloads** — `t3 db rebuild-projections` required afterward; UI must render from `summary`/`detail` only (assumption from plan; validator re-checks web usages of `data`).
- **T3/T12** touch fork-only `gits/` — no upstream coupling.
- **T6** patches a vendored dependency — verify patch applies at install (bun patch mechanism) in the guard.

## Ponytail review (pre-dispatch critique — decided)

- Keep: lane file-locks; per-slice files as durable hand-backs; end-verify + compile guard; Opus single-writer D/H.
- Change: T11 Haiku→Sonnet (correctness-sensitive); no middle coordinator tier (≤4 lanes); T15/T16 are report-only.
- Drop: no slice-schema DSL, no status DB — Markdown + this ledger.
- Flagged risk: end-only behavioral verify concentrates risk at the final redeploy (operator's explicit tradeoff).

## Decisions log

| When       | Decision                                                                      | Why                                                                |
| ---------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 2026-07-18 | PR #170 squash-merged into `gits` (`d01e1840f`)                               | plan docs canonical before implementation                          |
| 2026-07-18 | Integration worktree `.worktrees/perf-remediation` on `feat/perf-remediation` | isolate from live server working tree                              |
| 2026-07-18 | T9c (Queue.unbounded + rate-limit) folded into slice p2-DH-T9-s2              | same hunk as the resume rewrite; separate slice = artificial churn |
| 2026-07-18 | All 26 slice briefs authored under `slices/`                                  | Fable-authored, paths-not-bodies, machine-checkable acceptance     |

## Slice table

Status: `pending → dispatched → implemented → guard-green → merged → verified` (or `failed` / `re-scoped`).

| Slice             | Task | Lane    | Model/effort | Status | Guard       | Merged @                                 | Verify |
| ----------------- | ---- | ------- | ------------ | ------ | ----------- | ---------------------------------------- | ------ |
| p0-ops-T13-s1     | T13  | ops     | sonnet/med   | merged | guard-green | 35ccb87c2                                | —      |
| p0-obs-T14-s1     | T14  | obs     | opus/high    | merged | guard-green | 0ed738ab8                                | —      |
| p0-obs-T14-s2     | T14  | live    | opus/high    | merged | report-done | f861bfa3893e5f919d08cbe627413897ac698afc | —      |
| p1-A-T1-s1        | T1   | A       | sonnet/med   | merged | guard-green | d0f9653ab                                | —      |
| p1-C1-T3-s1       | T3   | C1      | opus/high    | merged | guard-green | 0867fc1                                  | —      |
| p1-A-T1-s2        | T1   | A       | sonnet/med   | merged | guard-green | f6f939777                                | —      |
| p1-C1-T3-s2       | T3   | C1      | opus/high    | merged | guard-green | e8189c6e2ae662e43f44e89a61da31dbcc16b01f | —      |
| p1-B-T4-s1        | T4   | B       | opus/high    | merged | guard-green | 046424fb6a79c2aab6b6533b5c32e812e543adb5 | —      |
| p1-A-T2-s1        | T2   | A       | sonnet/med   | merged | guard-green | b502d929e                                | —      |
| p1-B-T4-s2        | T4   | B       | opus/high    | merged | guard-green | 79677c2b160f6daab84fc853e4ada09da601d2bc | —      |
| p1-B-T5-s1        | T5   | B       | sonnet/med   | merged | guard-green | b59f2a7e7                                | —      |
| p1-B-T5-s2        | T5   | B       | sonnet/med   | merged | guard-green | 5dbcc3f3b                                | —      |
| p2-E-T6-s1        | T6   | E       | sonnet/med   | merged | guard-green | b52b7aa0c                                | —      |
| p2-DH-T5-s3       | T5c  | D/H     | sonnet/med   | merged | guard-green | ab77a872e                                | —      |
| p2-DH-T7-s1       | T7   | D/H     | opus/high    | merged | guard-green | b07b74d84                                | —      |
| p2-DH-T7-s2       | T7   | D/H     | opus/high    | merged | guard-green | de07b4c9ad8e23ec7eff3e9e19ed9f4638b6fc7a | —      |
| p2-DH-T7-s3       | T7   | D/H     | opus/high    | merged | guard-green | 57b94b297e0cdd53c659005db7c54cfacbc0c38c | —      |
| p2-DH-T9-s1       | T9   | D/H     | opus/high    | merged | guard-green | d53339c4e38078119386fe2912448d83acb6216f | —      |
| p2-DH-T9-s2       | T9   | D/H     | opus/high    | merged | guard-green | 741ccbaca7c4fa0c0f40735f92b22fb1b178d541 | —      |
| p2-DH-T8-s1       | T8   | D/H     | sonnet/med   | merged | guard-green | ae906a4bb                                | —      |
| p3-C2-T12-s1      | T12  | C2      | haiku/low    | merged | guard-green | 80203ade1                                | —      |
| p3-G-T11-s1       | T11  | G       | sonnet/med   | merged | guard-green | d062fd471                                | —      |
| p3-F-T10-s1       | T10  | F       | sonnet/med   | merged | guard-green | 080113eb4                                | —      |
| p3-F-T10-s2       | T10  | F       | sonnet/med   | merged | guard-green | dd7c3462a                                | —      |
| p4-staging-T15-s1 | T15  | staging | opus/high    | merged | report-done | a52ccea19329b0abd63c8bb6d7478853b0cb05f1 | —      |
| p4-audit-T16-s1   | T16  | audit   | opus/high    | merged | guard-green | 36388527483eb3de60387944ae412c487ce7971c | —      |

## Acceptance matrix (filled at end gate)

| Task | Verify assertion                                                     | Result |
| ---- | -------------------------------------------------------------------- | ------ |
| T1   | new `tool.completed` payloads < few KB (SQL max LENGTH)              | —      |
| T2   | `context-window.updated` count −≥90%; UI updates ≤5 s                | —      |
| T3   | no 5 s snapshot cadence; sawtooth flattens; budget numbers unchanged | —      |
| T4   | reload path sub-ms; no turn-boundary freezes                         | —      |
| T5   | read-model bytes drop; faster boot                                   | —      |
| T6   | `Failed to publish` = 0 over 10 min under reconnects                 | —      |
| T7   | subscriber only ever sees its own `aggregateId` (test)               | —      |
| T8   | frame+query count under burst drops; UI coherent                     | —      |
| T9   | burst recovery without snapshot stampede                             | —      |
| T10  | no CPU/GC spike on fast build output                                 | —      |
| T11  | large tool-call args no longer quadratic                             | —      |
| T12  | `getSnapshot` no loop-blocking spike                                 | —      |
| T13  | scavenge rate down; swap cleared post-restart                        | —      |
| T14  | baseline captured pre-change; deltas reported                        | —      |
| T15  | side-by-side T14 metrics report                                      | —      |
| T16  | isolation matrix with a test per row                                 | —      |

## Open risks

- T7 blast radius (see above) — may need finer slicing mid-run.
- End-only behavioral verify → late surfacing of logic regressions (operator tradeoff).
- One live redeploy at the end gate; T13 consent checkpoint pending.

## Isolated gate results + validator verdict (2026-07-18, Fable)

**Gate (isolated):** fmt ✅ (after `0fb3d1ab5` — slice-touched sources oxfmt'd) · lint ✅ 0 errors · typecheck ✅ 14/14 · vitest ✅ 1,594 passed/4 skipped · build ✅ 18/18 · rebuild-projections on 297.6 MB live-DB copy ✅ (44,451 events replayed, all 9 tables MATCH count+content; live host never opened for write).

**Validator keep/change/drop:** all 26 hand-backs **KEEP**. Zero failed slices, zero escalations.
Notable: T5-s2 correctly deduped against T4-s2 instead of double-implementing; T7-s2 authz is
defense-in-depth (thread-scoped already denied at `/ws` upgrade) — accepted as the T7 invariant seam.

**Corrections to plan assumptions (from gate evidence):**

1. **T1 retroactive cap: the plan's premise was wrong.** `rebuild-projections` replays events
   verbatim — the cap is a write-time ingestion guard, so historical rows keep their ~1.21 MB
   payloads. **Decision: accept forward-only capping.** The freeze/RSS win comes from not
   _materializing_ history (T4/T5) and not writing new bloat (T1/T2), not from shrinking rows at
   rest. Optional follow-up slice (not scheduled): event-store migration truncating historical
   `payload_json`.
2. **T15 premise wrong:** the dist is not Bun-runnable (`node:sqlite` static import) — the A/B is
   not "near-free". Report: keep Node; revisit only if post-Phase-1 metrics still disappoint.

**Follow-up slices proposed (LOW, unscheduled):** worktree remove-failed reaper (T16 gap);
subscribeShell per-thread authz defense-in-depth (T16 gap); event-store history truncation (above).

**Pending: live gate (operator consent required)** — T13 systemd apply + restart, one controlled
redeploy of `gits-cockpit.service`, live assertions vs the captured T14 baseline, live
`rebuild-projections` inside the stopped-server window (rollback: pre-rebuild DB retained).

## Live gate — executed 2026-07-18 14:54 BST

- PR #171 merged into `gits` (`418d19763`); runtime worktree `/srv/gits/runtime/gits-hosted` built at that SHA (18/18 tasks; patched effect applied).
- **T13 applied:** `gc-tuning.conf` drop-in (pre-existing, loaded) took effect on restart — process runs `--max-semi-space-size=64`. DB backed up to `backup-pre-perf-remediation-20260718-1454/` (rollback path).
- **Decision:** live `rebuild-projections` **skipped** — no projection schema changed; rebuild determinism proven on the copy; retroactive shrink is a non-goal. gate-T1-s3 live part closed as N/A.
- Window: ~10 s downtime. Post-start: active, HTTP 200 in 8.6 ms, NRestarts=0, new code confirmed in dist (`subscribeAggregate`, `truncateData`), **RSS 238 MB** (pre-stop 1.82 GB; baseline 1.84 GB / HWM 2.75 GB), 0 publish crashes.
- **Soak watch armed** (regressions + 45-min audit trigger); final audit vs the T14 baseline runs after operator load-test.

## Post-deploy verification audit (2026-07-18, Fable)

Audit window: deploy 14:54 BST → 16:43 BST. System was idle until 15:46; a synthetic-but-real load
phase then ran 15:46–16:42 BST: **14 waves × 4 concurrent agent turns (56 turns total)** driven
through the production WS-RPC path (`/ws`, bearer→ws-token auth, `dispatchCommand` +
`subscribeThread`), each turn a real `claudeAgent`/claude-opus-4-8 provider session streaming a
~1200-word reply. Driver: `driveload.mjs` (scratchpad; connection scaffold mirrors
`apps/server/phase1-e2e-driver.ts`). No worktree bootstrap, threads deleted after each wave.
Instrumentation: `/proc` RSS sampler (5-min cadence), 1 s HTTP latency probe (4,241 samples),
journalctl, read-only SQL (`mode=ro`).

### Acceptance matrix

| #   | Assertion                                              | Result              | Evidence                                                                                                                                                                                                                                                                                                                                                              |
| --- | ------------------------------------------------------ | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Integrity: node flags, dist markers, NRestarts, commit | **PASS**            | cmdline has `--max-old-space-size=4096 --max-semi-space-size=64`; `subscribeAggregate` ×3 + `truncateData` ×3 in `dist/bin.mjs`; NRestarts=0 (still 0 at 16:43); runtime HEAD `418d19763`                                                                                                                                                                             |
| 2   | RSS <1 GB after ≥1 h, non-monotonic                    | **PASS**            | 16 samples 15:27–16:42: sawtooth 266→480 MB (drops to ~320 MB between waves), VmHWM pinned 716 MB the whole window, VmSwap 0. Baseline: 1.84 GiB RSS / 2.75 GiB HWM / 475 MiB swap                                                                                                                                                                                    |
| 3   | `Failed to publish` == 0 since deploy                  | **PASS**            | 0 matches 14:54–16:43 incl. full load phase (baseline 34/h). Zero WARN/ERROR besides known `worktree.burial.remove-failed` (T16, 5-min reaper cadence)                                                                                                                                                                                                                |
| 4   | Reconnect popups (see verdict below)                   | **PASS w/ 1 gap**   | (a) 0 WS drops across 56 concurrent subscriptions; (b) latency p50 1.6 ms / p99 5.6 ms / max 137 ms, 0 samples >1 s; (c) `bufferOrTerminate` has **zero call sites** — overflow-terminate unreachable on subscribeThread/subscribeShell; (d) **FAIL**: client never sends `afterSequence` (see gap)                                                                   |
| 5   | `context-window.updated` −≥90%; payloads ≤~4 KB        | **PASS w/ caveat**  | 56 cw.updated events for 56 turns (exactly 1/turn, gated); busiest minute 4 vs 231/60 s baseline (−98%). `thread.activity-appended` max 1,134 B; `tool.completed` bloat absent. Caveat: 56 rows >4 KB are all `thread.message-sent` (max 8,924 B) — genuine assistant message text from the ~1200-word test prompts, scales with reply length; not the T1 bloat class |
| 6   | No multi-second event-loop bursts                      | **PASS (by proxy)** | T14 metrics are dark in prod (see gap 2), so measured externally: 4,241 1 s-interval HTTP probes through the load window, max 137 ms, zero >1 s. Baseline symptom was 100–118% ELU bursts every 5–10 s                                                                                                                                                                |

### Reconnect-popup verdict: **fixed** (mechanism-level), with one unfinished limb

Causal chain (client, traced in `apps/web` + `packages/client-runtime` + effect RpcClient):
popup ⇐ `uiState=="reconnecting"` ⇐ WS close/error **or heartbeat timeout** ⇐ client pings every
5 s and tears down the socket after one missed pong (~5 s of server unresponsiveness). So the popup
fires iff the server event loop stalls ≳5 s, the server kills the socket, or the network drops.

Post-deploy, under 4-way concurrent provider streaming: worst server response 137 ms (36× under the
5 s kill threshold), 0 socket terminations, 0 publish crashes, and the old forced-disconnect path
(`bufferOrTerminate` 512-cap overflow → terminate) is dead code — `subscribeThread`/`subscribeShell`
now use unbounded per-aggregate queues (T7/T9). Every load-bearing trigger of the popup is gone.

**Gap (4d): resume-by-sequence is server-only.** `afterSequence` catch-up replay is implemented and
contract-typed in `ws.ts` (subscribeThread :1278-1295, subscribeShell :1179-1194), but no web/client
call site ever populates it — `subscribeThread({threadId})`, `subscribeShell({})` hardcoded
(`environments/runtime/service.ts:407`, `threadDetailState.ts:314`, `wsRpcClient.ts:562`). Every
reconnect still takes the full-snapshot path. This does not cause popups; it makes recovery after
one heavier than designed. Client comments still describe the removed overflow-terminate behaviour
(stale docs in `environmentConnection.ts:171`, `threadDetailState.ts:302`).

### Observability gap (T14): RuntimeMetrics deployed but dark

`RuntimeMetricsLive` samples ELD p99 / RSS / GC every 10 s into Effect gauges, but the only sink is
OTLP and `otlpMetricsUrl` is unset in this deployment — no endpoint, no per-sample logs. Item 6
above is therefore probe-based, not T14-based. The BEFORE baseline had the same blindness (noted in
p0-obs-T14-s2), so nothing regressed — but the ELU-burst claim can never be re-verified from prod
telemetry until a sink is configured.

### Leak suspicion: none

RSS is a clean load-correlated sawtooth (rises ~150 MB during a wave, falls back between waves);
HWM never moved after startup; swap stayed 0. No monotonic component over 75 min. Global event
`sequence` and per-aggregate `stream_version` advance continuously across the deploy boundary with
no gaps (44,470 → 45,594).

### Verdict: **KEEP**

Deploy is sound; every headline symptom (freeze bursts, RSS churn, publish crashes, forced
disconnects) is absent under sustained concurrent provider load. No restart, no rollback.

### Proposed repair slices (not implemented — operator approval required)

1. **client-afterSequence-resume** (MEDIUM): populate `afterSequence` in `subscribeThread`/
   `subscribeShell` from the client's last-seen sequence so reconnects use the T9 delta-replay path.
   Files: `apps/web/src/environments/runtime/service.ts`, `packages/client-runtime/src/
threadDetailState.ts`, `packages/client-runtime/src/wsRpcClient.ts` (+ delete stale overflow
   comments in `environmentConnection.ts`/`threadDetailState.ts`). Acceptance: reconnect after
   induced drop replays only events > last sequence (no full snapshot in the WS frame log); UI state
   coherent after resume.
2. **t14-metrics-sink** (LOW): configure `otlpMetricsUrl` (or add a fallback per-sample log/pull
   endpoint) so `t3_runtime_event_loop_delay_p99_seconds` is actually observable in prod.
   Acceptance: ELD p99 retrievable for any 10 s window; alert path documented in this ledger.
3. Known/unscheduled items unchanged: worktree reaper leak (T16 — the 5-min
   `worktree.burial.remove-failed` WARN for thread `502fc036` is this), 2 LOW T16 items,
   history-truncation slice.

## Redeploy 2 — 2026-07-18 22:17 BST (fixes + GITS redesign)

Deployed `0822fddd0` (gits): T14 metrics sink (#173), client afterSequence resume (#174), GITS
chat redesign slices 1+2 (#175–#179: OLED/cyan theme, mascot typing indicator, settings toggles,
subagent switcher fix, git-status tab, usage panel + `usage.modelBreakdown` RPC). #169 was
admin-merged in error mid-cascade and reverted before deploy (`0822fddd0` is the revert; re-merge
by reverting it). Combined state validated locally in lieu of CI (operator-approved): turbo 14/14,
browser 182/182 (172/172 post-revert equivalent). DB backup: `backup-pre-redesign-20260718-2215/`.
Post-start: HTTP 200 in 5.4 ms, NRestarts=0, RSS 352 MB, swap 0, `runtime.metrics.window` emitting
(first window: ELD p99 max 36 ms, 0 ws reconnects), one live agent turn verified end-to-end.
Pending operator drop-in: `apps/web/public/gits-mascot-loop.gif` (sprite fallback active).

## Redeploy 3 — 2026-07-18 22:22 BST (#169 re-landed)

Operator requested #169 (remote localhost access) back in: `d9209e464` = revert-of-revert of
`0822fddd0`; tree verified identical to the fully validated `86d7df1f5` state (+docs). Deployed with
DB backup `backup-pre-169-20260718-2222/`. Post-start: HTTP 200 in 5 ms, NRestarts=0, RSS settled
376 MB after a 735 MB boot spike, first `runtime.metrics.window`: ELD p99 max 53 ms, 0 ws
reconnects. Both `provider.auth.*` and `usage.modelBreakdown` RPC markers live in dist.

## Redeploy 4 — 2026-07-18 23:0x BST (app-wide OLED)

`f7571d255` (#180): GITS token layer lifted to `:root[data-gits-theme]` (whole app incl. portals),
JetBrains Mono self-hosted, `gits-mascot-loop.gif` shipped (7-frame repair of the capped design-API
transfer; full original is a drop-in at `apps/web/dist/gits-mascot-loop.gif`, no rebuild needed).
Validated 6/6 turbo + 182/182 browser. Post-start: HTTP 200 in 1.8 ms, GIF served 200 (171,486 B),
NRestarts=0, 0 errors.
