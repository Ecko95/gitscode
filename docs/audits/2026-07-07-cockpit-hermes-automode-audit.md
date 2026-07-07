# Cockpit + Hermes/Motoko Automode Audit — 2026-07-07

Worktree `gitscode-3b` at `origin/gits` tip `3fa47b0b8` (#130). Read-only audit; no product code changed.

**TL;DR — the crux resolved:** HERMES.md is **accurate, not stale**. Motoko output really is handoff-only: `HermesCliAdapter` contains zero calls to `spawnPeer`/`runAuto`/`enqueueGoal` (grep exits 1), and drafts terminate as returned objects (`HermesCliAdapter.ts:1900-1960`). BUT a **fully autonomous execute→verify→land→held-PR loop already exists on the Automode side** (`AutomodeDriver` ticks every 5s, live-wired in `server.ts:308-321`) — it is just fed exclusively by the manual `gits.automode.goals.enqueue` RPC (`ws.ts:1656`, its only caller). The operator's mental model and the doc both feel true because they describe different modules. Missing pieces: (1) a ~one-function approve→enqueue bridge in `ws.ts`, and (2) a plans-complete detector, which exists **nowhere** in code and is a genuinely new feature. Integration PLAN.md stopped short of dispatch **on purpose** (PLAN.md Slice 6 L298, PR 3 "should still stop short of automatic dispatch", L409).

---

## B. Automode audit (leading with the crux)

### B1. End-to-end trace

**Chain A — Motoko/Hermes proposal pipeline. Real; hard-stops at draft.**

1. RPC entry `gits.hermes.chat` / `.proposals.*` / `.schedules.run` — `packages/contracts/src/rpc.ts:247-260`, wired `apps/server/src/ws.ts:1692-1762+`.
2. `classifyHermesChatAction()` (`apps/server/src/gits/Layers/HermesCliAdapter.ts:655-677`) regex-classifies operator text; "spawn|peer|delamain|worktree|parallel" → `"worktree-spawn"` (L667-668). The chat prompt hard-forbids execution (`HermesCliAdapter.ts:702`): *"Do not edit files, spawn peers, merge, admin-merge, force-push, delete files, or run destructive shell commands."*
3. Approval gate: `hermesProposalRequiresApproval` / `hermesDirectExecutionBlocked` (`HermesCliAdapter.ts:639-645`) — both are `actionKind !== "read-only"`. On approve, the card is stamped (`HermesCliAdapter.ts:1807-1810`): *"Approved for handoff only. Hermes cannot execute write, integrate, or destructive actions directly."*
4. `draftFromProposal` (`HermesCliAdapter.ts:1900-1960`) builds a `delamain-peer` / `open-gsd` / `verification` draft object and **returns it to the cockpit**. Not persisted, not enqueued, not spawned. Handler `ws.ts:1759-1762` just relays it.
5. **Chain stops here.** `HermesCliAdapter.ts` has zero calls to `spawnPeer`, `runAuto`, `initProject`, `enqueueGoal`, `dispatchGoal`. The Hermes adapter holds `DelamainAdapter`/`OpenGsdAdapter`/`AutomodeSupervisor` handles only for read-only context assembly (`makeWriteProjectContext`, `HermesCliAdapter.ts:1830-1862`).
6. **"Plans complete" trigger: does not exist.** Repo-wide grep for plans-complete concepts hits only the unrelated provider-runtime plan-step enums (`packages/contracts/src/providerRuntime.ts:75`). `GitsPlanningScanner` (`apps/server/src/gits/Services/GitsPlanningScanner.ts:17-21`) is read-only cockpit snapshot data. `OpenGsdCliAdapter.runAuto` runs only on the manual `gits.openGsd.auto` RPC (`ws.ts:1628-1629`).

**Chain B — Automode goal → peer → review → land → held PR. Real and fully autonomous once policy-armed; fed only by manual RPC.**

1. `gits.automode.goals.enqueue` (`rpc.ts:242`) → `automodeSupervisor.enqueueGoal` (`ws.ts:1653-1656`). Only entry point.
2. `AutomodeDriver` background fiber, 5s tick (`GITS_AUTOMODE_DRIVER_TICK_MS`, `apps/server/src/gits/Layers/AutomodeDriver.ts:17-21, 262-276`; wired live `apps/server/src/server.ts:308-321`). Master gate (`AutomodeDriver.ts:50-53`):
   ```ts
   // Only act in autonomous mode with the kill switch off.
   if (snapshot.policy.mode !== "autonomous" || snapshot.policy.killSwitchEnabled) {
     return;
   }
   ```
3. Dispatch: oldest queued goal (`AutomodeDriver.ts:198, 251`) → `supervisor.dispatchGoal` → policy cascade (`AutomodeSupervisor.ts:532-542`: kill switch / mode / `maxActivePeers` / repo allowlist / model allowlist / budget), approval gate `goalNeedsApproval` (`AutomodeSupervisor.ts:219-229`). Passing → real spawn via `delamainAdapter.spawnPeer({... confine: true, yolo: true, egress: "host"})` (`AutomodeSupervisor.ts:601-616`) → `delamain spawn --repo … --confine --yolo` (`DelamainCliAdapter.ts:290-303, 347-348`).
4. Reconcile: on peer done, fail-closed if `integrationBranch === null` (`AutomodeDriver.ts:96-100`) or empty `verificationCommands` (`AutomodeDriver.ts:102-106`); run `GitsReviewPipeline.review` (`AutomodeDriver.ts:115-130`) then `decide_automode_gate` (`Layers/AutomodeReviewGate.ts:14-27`): mechanical fail or verdict `fail` → halt; `uncertain` → land flagged.
5. `AutomodeLanding`: fast-forward-only push of slice tip to integration branch (`Layers/AutomodeLanding.ts:29-83`, commands `AutomodeLandingCommands.ts:38-50`); non-FF → rejected → driver halt (`AutomodeDriver.ts:147-152`).
6. Episode ledger: `record_episode` after landing (`AutomodeDriver.ts:158-181`); table from `persistence/Migrations/032_AutomodeEpisodeLedger.ts:7-32`.
7. `AutomodeHeldPr`: queue drained + ≥1 landed slice → one held PR to `gits`, idempotent by head lookup (`Layers/AutomodeHeldPr.ts:20-58`); body says held for review, not auto-merged (`AutomodeDriver.ts:220-226`); driver then polls `detect_merge` until a **human** merges (`AutomodeDriver.ts:241-248`). No auto-merge anywhere.

### B2. Verdict on question 1

**Partially.** The autonomous executor loop (dispatch → confined-yolo peer → verify gate → FF land → held PR → human merge) exists, is live, and is well-tested — for goals already in the queue, once the operator sets `mode:"autonomous"`, `killSwitchEnabled:false`, `requireApprovalForPeerSpawn:false`, `integrationBranch`, and `verificationCommands`. The autonomous *plans-done → Motoko assigns peers* trigger does **not** exist: Motoko terminates at a returned draft; goals enter only via manual RPC. Two nuances: the loop's "review" is the mechanical+semantic verifier gate, not a reviewer peer; and "plan" is never a peer role — goals arrive pre-planned as prompts.

### B3. Doc drift

| HERMES.md claim | Verdict |
|---|---|
| L94 non-read-only proposals "remain handoff-only until the operator converts them" | **Code matches** (`HermesCliAdapter.ts:643-645`, `1900-1960`) |
| L120 spawn-shaped chat → `worktree-spawn`, approval-gated, handoff-only | **Code matches** (`HermesCliAdapter.ts:667-668` + gates above) |
| L136 "GITS does not spawn Delamain peers or run Open GSD automatically from Motoko approval" | **Code matches exactly** (zero spawn/runAuto/enqueue calls in the adapter) |
| L77-84 policy block (observe/propose, no YOLO, writes via Delamain) | **Code matches** (`policySnapshot()` `HermesCliAdapter.ts:711-724`; YOLO stripped, test `HermesCliAdapter.test.ts:70`) |
| — | **One real gap: HERMES.md undersells Automode.** It never mentions that a fully autonomous dispatch→verify→land→held-PR driver exists behind `AutomodePolicy`. Not a contradiction (different module), but it is exactly why "should be automatic" and "handoff-only" both feel true. Doc improvement, not a defect. |
| ANALYSIS.md L141 (connect approved cards to Automode) / PLAN.md Slice 6 L298 + L409 | **Aspirational by design** — the plan explicitly stopped short of automatic dispatch; code stopped where the plan said to stop. |

### B4. Smallest autonomy change (question 2)

The bridge is ~one policy flag + one hook in the approve handler; no new service or layer:

1. `packages/contracts/src/gits.ts`: add `autoEnqueueApprovedProposals: Schema.Boolean` (default `false` via `withDecodingDefault`, same pattern as `heldPrUrl` at ~L699) to `AutomodePolicy` (~L638) and `AutomodePolicyUpdateInput` (~L709).
2. `apps/server/src/ws.ts` (`gitsHermesDecideProposal` handler, ~L1727): after a successful `decision === "approve"`, if `policy.autoEnqueueApprovedProposals && policy.mode === "autonomous"`, call the already-in-scope `hermesAdapter.draftFromProposal` then `automodeSupervisor.enqueueGoal({title, prompt: draft.prompt, repo: draft.repo})` for `kind === "delamain-peer"` drafts with `status === "draft"` (blocked drafts stay blocked). Both services are already injected in ws.ts (`ws.ts:1656`, `1762`). The 5s driver picks the goal up with no further change.
3. Do **not** auto-seed `verificationCommands` — let the fail-closed halt at `AutomodeDriver.ts:102-106` force deliberate per-repo configuration.
4. Guard the hook on prior proposal status (approve→approve is a state no-op but would re-fire a naive hook) and require a non-empty `allowedRepos` (empty = allow-all, `AutomodeSupervisor.ts:201-204`).

Safety rails already live: kill switch + manual default (`AutomodeSupervisor.ts:174-190`, default `mode:"manual"`, `killSwitchEnabled:true`); USD budget fail-closed when telemetry absent (`AutomodeSupervisor.ts:256-272`, `Layers/AutomodeUsageMeter.ts:62-128`); `maxActivePeers` / repo / model allowlists (`AutomodeSupervisor.ts:201-217, 536-537`); `maxRuntimeMinutes` SIGTERM (`AutomodeSupervisor.ts:376-415`); review gate; idempotent held PR + human merge; episode ledger; Delamain worktree confinement.

The full operator vision — *plans complete → auto-enqueue next phase* — needs a scanner-driven enqueuer watching Open GSD/`.planning` state. Nothing like it exists; that is a new feature, not a small diff.

### B5. Safety review of the would-be autonomous path

- **No auto-merge risk** — FF-push to integration branch; held PR needs a human (`AutomodeDriver.ts:220-248`).
- **Budget gate is soft/blind**: `maxBudgetUsd` defaults `null` = no cap (`AutomodeSupervisor.ts:182`), and the meter reads only GITS-provider threads (`AutomodeUsageMeter.ts:84-100`) — **Delamain peer (Codex/Cursor CLI) spend is invisible**, so even a configured budget does not cap peer cost. Real gap.
- **Runtime limit lost on restart**: `scheduleRuntimeLimit` is an in-memory `forkDetach` sleep (`AutomodeSupervisor.ts:385, 412`); server restart orphans the timer while the peer runs on.
- **Prompt-regex approval gates are bypassable**: `INTEGRATION_PATTERN`/`DESTRUCTIVE_PATTERN` (`AutomodeSupervisor.ts:54-55`) inspect prompt text only; rephrased prompts skip the extra approval (same class of gap as `classifyHermesChatAction`).
- **`allowedRepos` empty = allow all** (`AutomodeSupervisor.ts:201-204`) — combined with an auto-enqueue bridge, any approved `projectDir` dispatches.
- **Peers run `yolo:true, egress:"host"`** (`AutomodeSupervisor.ts:613-615`): confined worktree but full host egress — under auto-enqueue, Hermes-authored prompts become an influence path to a network-capable executor.
- **Halt/resume is livelock-safe, not runaway**: driver halts on every anomaly (vanish `AutomodeDriver.ts:70-73`, fail 81-84, waiting 87-90, non-FF 148-151, failed dispatch 253-255); `resumeDriver` (`AutomodeSupervisor.ts:714-725`) doesn't re-examine the stuck goal, so a broken goal re-halts each tick.
- **Idempotency**: held PR creation idempotent (`AutomodeHeldPr.ts:22-26`); episode ids embed goalId+timestamp — duplicate episodes possible on retry, ledger failure deliberately non-halting (`AutomodeDriver.ts:174-181`).

### B6. Server surface vs cockpit (question 3)

Server RPC surface (`packages/contracts/src/rpc.ts:229-260`): `gits.delamain.peers.{list,status,log,spawn,kill,reply,wait,integrate}`; `gits.openGsd.{status,init,auto}`; `gits.automode.{snapshot,policy.update,goals.enqueue|approve|reject|dispatch}`; `gits.capacity.snapshot`; `gits.hermes.{status,config,check,setupCodexOAuth,acp.start,sessions.list,logs.tail,proposals.{list,inspectGits,decide,draft},chat,context.write,schedules.run}`. **Emitted push events: none** — no `gits.automode.*`/`gits.hermes.*` events exist in contracts or ws.ts.

Cockpit wiring: **in sync on methods, behind on observability.** The UI drives the whole surface (polls `automode.getSnapshot` at 5s, `hermes.listProposals` at 10s, `delamain.listPeers` at 5s; all mutations wired, `GitsCockpit.tsx:4285-4772`). But it has **no view of** the episode ledger, held-PR state (`heldPrUrl`/`heldPrNumber`/`runMerged` are in `AutomodeSnapshot` per `automode-held-pr-fields`, never rendered — grep of the file finds no `heldPr`/`episode`), or `driverHalted` — a halted autonomous run is indistinguishable from an idle one at the UI. Since the server emits no events, everything is poll-granularity; a driver-halt push notification is the missing piece on both sides.

---

## A. Cockpit audit — `apps/web/src/components/gits/GitsCockpit.tsx` (5,411 lines)

### A1. Structure and top extractions

Layout: formatters/atoms (1–776), panels in file order — BuildProvenance/Usage (778–1016), Overview (1018–1259), ResourceVisibility (1261–1380), PeerFleet (1382–1655), Motoko constants+composer+panel (1657–2784), DevCommand (2786–2951), OpenGsd (2953–3138), Skills (3140–3438), McpServers (3440–3742), Automode (3744–4107), Project/Content (4109–4232), then the `GitsCockpit()` orchestrator (4234–5411) holding 24 `useState`, 16 queries (11 RPC `useQuery` + 5 fetch-based), 22 `useMutation`, 5 effects.

Extractions, in value order:
1. **`useGitsCockpitQueries()`** (4285–4505) — all 16 queries share the env-scoped-key + poll pattern; one place to fix the env-scoping inconsistency (A2.7).
2. **`AutomodeSection`** — panel 3744–4107 + 13 mirrored `useState` (4260–4277) + 6 mutations (4705–4772) + sync effect (5005–5030). The 28-prop drilling exists only because form state lives in the parent.
3. **`MotokoSection`** — 1689–2784 + transcript/chat state + 9 hermes mutations (4506–4630); ~1,400 lines, only `selectedProjectRoot`/`projects` cross the boundary.
4. **`useDevCommandSessions(projectRoot)`** — `reduceDevCommandEvent` (2143–2211) + `handleDevStart/Stop` (4773–4899) + detach ref + cleanup effect; the only stateful stream logic and where the real bugs live (A2.1/A2.2).
5. **`FleetSection`** — `PeerFleetPanel` (1386–1655) + peer state/mutations (4631–4673, effect 4987).

`SkillsPanel`/`McpServersPanel` are already self-contained — zero-risk mechanical moves.

### A2. Correctness / state findings (severity order)

1. **BUG — Stop targets the wrong terminal thread after project switch.** `handleDevStop` recomputes `threadId` from current `selectedProjectRoot` (`GitsCockpit.tsx:4863`) while `handleDevStart` captured it at start time (4783). Start dev under project A, switch to B, Stop → close hits `gits-dev:<B>`; A's process keeps running while the UI marks it closed (4877–4892). Fix: store `threadId` in `DevCommandSessionState` at start.
2. **BUG (same root) — session map + attach subscriptions survive project switches.** `devSessionStateByCommandId` keyed by `command.id` only, never reset on root change (4278–4284); cleanup only on unmount (5032–5039). Stale "running" rows persist; cross-project output bleed if command ids repeat. Fix: reset map + detach all on `selectedProjectRoot` change.
3. **BUG — Dev tab loads forever with no project selected.** Disabled query stays `status:"pending"` (`enabled: selectedProjectRoot.trim().length > 0`, 4404–4416) but the panel renders `isPending || isFetching` as loading (5335 → 2848–2850). Fix: `loading={devCommandsQuery.isFetching}` or gate on root.
4. **HAZARD — automode policy form clobbered by the 5s poll.** Effect at 5005–5023 re-seeds all 11 form fields whenever `automodeQuery.data?.policy` identity changes (reconnect changes the query key at 4334–4341; any server-side change too), silently discarding in-progress edits. Fix: seed only when pristine (dirty flag, cleared on save).
5. **HAZARD — kill-switch UI can contradict itself.** Header pill reads `snapshot.policy.killSwitchEnabled` (3877–3881); Arm/Kill button reads local optimistic state (3894–3902, set at 5228–5231) with no `onError` rollback (4733–4739). Fix: derive button from snapshot, or roll back on error.
6. **HAZARD — peer selection reset on reconnect blips.** Effect 4987–4992 re-picks first peer whenever `delamainQuery.data` is briefly `undefined` (fresh cache entry from key including `connectionState`/`authState`, 4310–4317); same pattern for `selectedProjectRoot` at 4994–5003. Fix: bail when `data === undefined`.
7. **HAZARD — four tabs ignore the selected environment.** `buildInfoQuery`/`skillsQuery`/`mcpQuery`/`usageQuery` fetch `/api/gits/*` from the web origin (4432–4491) while everything else routes through `readEnvironmentClient()`; with a remote env selected these tabs silently show local-host data. Fix: label "local host" or route through the env API.
8. **MINOR BUG — "last result" panels show fixed precedence, not recency.** `gsdAutoMutation.data ?? gsdInitMutation.data` (4928) and the hermes triple (4949–4950): run Auto then Init → stale Auto output stays displayed (3109). Fix: single `lastResult` state written in `onSuccess`.
9. **SMELL — peer-log errors swallowed** (4499–4505 → 1643–1645, renders "No log output"). **SMELL — redundant selection-sync effects in Skills/MCP panels** (3187–3200, 3480–3495) duplicate the render-time fallback.

Checked and clean: mutation closures (TanStack latest-fn semantics + null-gated buttons), per-key response ordering, unmount cleanup for terminal attaches, composer ref pattern, transcript id collisions.

### A3. A11y

1. **Tablist without keyboard semantics** (738–772): `role="tablist"/"tab"` with no roving tabindex, no arrow keys, no `aria-controls`, no `role="tabpanel"`. Either drop the roles or finish the contract.
2. **Zero `aria-live` in the file**: Motoko replies (2400–2494), dev terminal (2940–2942), peer log (1643–1645), error banners (2336–2340, 3906–3910) all appear silently. `aria-live="polite"` on transcript + banners; `role="status"` on terminal status line.
3. **Motoko transcript never auto-scrolls** (2379) — new replies land below the fold for everyone. Scroll-to-bottom effect on `transcript.length`.
4. **Star rating lacks state semantics** (3346–3364): no `aria-pressed`, no current-value announcement.
5. **Autoplay looping avatar video** (2100–2109): decorative but labeled, no `prefers-reduced-motion` escape.

Positive: no click-only divs; icon buttons labeled; forms labeled; destructive actions confirm.

### A4. Perf

1. **Whole-cockpit re-render every poll tick, by construction**: 3 queries at 5s + 2 at 10s + 6 at 30–60s in one component; `isRefreshing` ORs every query's `isFetching` (5066–5081) → ≥2 full renders of the 5,000-line tree per tick, no `memo` anywhere. Dominant cost; also the argument for extractions 1–3. Incremental fix: drop `isFetching` from the header spinner and memoize per-tab panels.
2. Inline handler props everywhere (5131–5405) — would defeat future `memo`; fix during extraction.
3. Unmemoized overview aggregation (1039–1077) — only worth fixing after (1).
4. Silent `slice()` caps (transcript 80 at 2401, proposals 80 at 2675, skills/MCP 160 at 3289/3580; peers uncapped at 1490) — add "+N more" rows.
5. Non-unique string keys (2697 `key={item}`, 2367 `key={warning}`) — duplicate evidence strings mis-reconcile.

---

## C. Prioritised findings

Severity: 🔴 fix now · 🟠 fix soon · 🟡 improvement · 📄 doc drift. B = bug, I = improvement.

| # | Finding | Type | Sev | Smallest fix | Files |
|---|---------|------|-----|--------------|-------|
| 1 | Dev-terminal Stop closes the wrong thread after project switch; process keeps running | B | 🔴 | Store `threadId` in session state at start; use it in stop | `GitsCockpit.tsx:4783,4863` |
| 2 | Dev session map + attach subs survive project switches (stale/bleeding rows) | B | 🔴 | Reset map + detach on `selectedProjectRoot` change | `GitsCockpit.tsx:4278-4284,5032-5039` |
| 3 | Automode budget meter blind to Delamain peer spend; `maxBudgetUsd` null = uncapped | B (safety) | 🔴 | Require non-null budget before autonomous mode arms; document meter scope | `AutomodeSupervisor.ts:182,256-272`, `AutomodeUsageMeter.ts:84-100` |
| 4 | Dev tab loads forever when no project selected | B | 🟠 | `loading={devCommandsQuery.isFetching}` | `GitsCockpit.tsx:4404-4416,5335,2848-2850` |
| 5 | Policy form silently clobbered by 5s poll | B | 🟠 | Dirty flag; seed only when pristine | `GitsCockpit.tsx:5005-5023` |
| 6 | Kill-switch pill vs button can contradict (no error rollback) | B | 🟠 | Derive button from snapshot | `GitsCockpit.tsx:3877-3902,5228-5231,4733-4739` |
| 7 | Peer/project selection reset on reconnect blips | B | 🟠 | Bail when query `data === undefined` | `GitsCockpit.tsx:4987-5003` |
| 8 | `maxRuntimeMinutes` timer lost on server restart | B (safety) | 🟠 | Persist deadline; re-arm on supervisor boot (state already persists across restart) | `AutomodeSupervisor.ts:376-415` |
| 9 | `allowedRepos` empty = allow-all is a footgun for any future auto-enqueue | B (safety) | 🟠 | Require non-empty allowlist in autonomous mode | `AutomodeSupervisor.ts:201-204` |
| 10 | Cockpit blind to `driverHalted`, held-PR state, episode ledger | I | 🟠 | Render existing snapshot fields (`heldPrUrl`, `runMerged`, halt state) in Automode tab | `GitsCockpit.tsx` Automode panel; fields already in `AutomodeSnapshot` |
| 11 | Skills/MCP/Usage/Build tabs ignore selected environment | B | 🟠 | Label "local host" or route via env API | `GitsCockpit.tsx:4432-4491` |
| 12 | No live regions; tablist ARIA contract broken; transcript no auto-scroll | I (a11y) | 🟠 | `aria-live` on transcript+banners; roving tabindex or drop roles; scroll effect | `GitsCockpit.tsx:738-772,2379,2400-2494` |
| 13 | Whole-tree re-render per 5s poll; spinner ORs all `isFetching` | I (perf) | 🟠 | Memoize per-tab panels; narrow spinner | `GitsCockpit.tsx:5066-5081` |
| 14 | Prompt-regex approval/destructive gates bypassable by phrasing | I (safety) | 🟡 | Accept as heuristic; note in docs; don't rely on for auto-enqueue | `AutomodeSupervisor.ts:54-55`, `HermesCliAdapter.ts:655-677` |
| 15 | "Last result" panels show fixed precedence, not recency | B | 🟡 | Single `lastResult` set in `onSuccess` | `GitsCockpit.tsx:4928,4949-4950` |
| 16 | Peer-log query errors swallowed | B | 🟡 | Pass `logQuery.error` into existing error chain | `GitsCockpit.tsx:4499-4505,1643-1645` |
| 17 | Silent list truncation (80/160 caps, no indicator) | I | 🟡 | "+N more" row | `GitsCockpit.tsx:2401,2675,3289,3580` |
| 18 | Non-unique string React keys | B | 🟡 | `key={id}:{index}` | `GitsCockpit.tsx:2697,2367` |
| 19 | Monolith: extract queries hook, Automode/Motoko/Fleet slices, dev-session hook | I | 🟡 | Per §A1, in that order | `GitsCockpit.tsx` |
| 20 | HERMES.md never mentions the autonomous Automode driver | 📄 | 🟡 | Add an "Automode relationship" paragraph; doc is otherwise accurate | `docs/gits/HERMES.md` |
| 21 | Operator mental model ("Motoko auto-assigns peers") vs reality | 📄 | — | Not a defect: deliberately unbuilt per PLAN.md Slice 6 L298/L409; see §B4 for the bridge | `docs/gits/HERMES_MOTOKO_INTEGRATION_PLAN.md` |

Doc-drift vs real defect: #20/#21 are doc items; #3/#8/#9/#14 are latent safety gaps that only bite when autonomous mode is armed; everything else is a live UI defect or improvement.

---

## D. Actual verification output (run 2026-07-07 in this worktree)

**Tests** — `vitest run` on the 9 Automode/Hermes/Delamain suites in `apps/server/src/gits/Layers/` (note: tests live in `Layers/`, not `Services/`):

```
Test Files  9 passed (9)
     Tests  66 passed (66)
  Duration  7.97s
```

AutomodeDriver 15 ✓ · AutomodeSupervisor 18 ✓ · HermesCliAdapter 12 ✓ · DelamainCliAdapter 4 ✓ · AutomodeUsageMeter 2 ✓ · AutomodeHeldPr 5 ✓ · AutomodeLanding 3 ✓ · AutomodeLandingCommands 2 ✓ · AutomodeReviewGate 5 ✓. All pass, including "spawns through Delamain when autonomous policy passes", "autonomous dispatch requests a confined --yolo peer", "opens a held PR when the queue drains", "polls the held PR and marks the run merged".

**Typecheck** — `tsgo --noEmit`: after `bun install` (worktree node_modules were stale, missing `web-push`/`vite-plugin-pwa`/`@xterm/*` from PR #129), **apps/server: 0 errors** (Effect LSP suggestions only), **apps/web: 0 errors**.

**Lint** — `oxlint` over `GitsCockpit.tsx`, `delamainPeers.ts`, `gits/Services`, `gits/Layers`, `packages/contracts/src`: **15 warnings, 0 errors**. Notables: `GitsCockpit.tsx:3479` useMemo dep `servers` changes every render; `GitsCockpit.tsx:5034,5037` ref `.current` read in effect cleanup (finding A2.2's neighborhood); `AutomodeSupervisor.ts:21,23` unused type imports; `AutomodeDriver.ts:30` `reverse()` mutates (harmless — array is spread-copied first).

**Transitions with NO test** (from reading describe/it blocks):
- waiting-approval → approved → **driver re-dispatch** end-to-end (approval tested only at supervisor level, `AutomodeSupervisor.test.ts:134`)
- driver halt on `integrationBranch === null` at done-time (`AutomodeDriver.ts:96-100`) and null-worktree/branch arms (108-113) — only empty-`verificationCommands` is covered (`AutomodeDriver.test.ts:394`)
- runtime-limit SIGTERM path (`AutomodeSupervisor.ts:376-415`)
- `rejectGoal` transition (no test names a reject flow)
- driver halt on held-PR open rejected (`AutomodeDriver.ts:227-231`)
- verifier pipeline **error** (throw, not verdict-fail) mapping (`AutomodeDriver.ts:122-129`)
- `DESTRUCTIVE_PATTERN`/`INTEGRATION_PATTERN` gate branches individually (`AutomodeSupervisor.ts:226-227`)
- Hermes proposal/draft → automode goal: untested because the bridge doesn't exist; needs day-one coverage if §B4 ships
