# Phase 1 spec — slot scheduler + arming + episode ID (off-hours autonomy) — POST-REVIEW v2

Design of record: docs/brainstorms/off-hours-autonomy.md (decisions 1, 6, 7, 8, 11, 20, 23 + 2026-07-13 addendum + phase amendments).
Worktree: /home/joshua/dev/projects/gitscode-autonomy-phase1 (branch feat/autonomy-phase1-scheduler off origin/gits @ 105a0e70a).
Repo idiom: Effect-TS 4 beta (4.0.0-beta.73), Services/Layers split, contracts in packages/contracts/src (gits.ts + rpc.ts), JSON-file state via writeFileStringAtomically, vitest via @effect/vitest (it.effect), Layer.mock deps in tests. MATCH THE FILE YOU EDIT for naming/style (repo mixes camelCase methods + snake_case helpers).
NOTE: PR #159 (open, unmerged) reworks the Motoko chat sections of GitsCockpit.tsx — keep cockpit changes tightly scoped to AutomodePanel to minimize future conflicts.

## Verified substrate facts (from code inspection + adversarial review — do not re-derive)

- Policy: packages/contracts/src/gits.ts:690-716. No "armed" field; running today = mode==="autonomous" && !killSwitchEnabled (AutomodeDriver.ts:52). Defaults AutomodeSupervisor.ts:195-214 (maxActivePeers:1, maxRuntimeMinutes:60).
- Supervisor state: JSON {stateDir}/gits/automode-state.json, PersistedAutomodeState (Layers/AutomodeSupervisor.ts:59-76) EMBEDS AutomodeGoalSchema — any new required goal field MUST carry a schema-level decoding default or the whole state file fails decode and silently resets to locked defaults (loadAutomodeState :182-191). Ref + Semaphore(1) commitState. reArmOnBoot (:139-149) re-arms kill switch + clears approvals on EVERY boot.
- Driver: Layer.effect fiber Effect.forever(sleep(GITS_AUTOMODE_DRIVER_TICK_MS default 5000)->tickOnce()).forkScoped (Layers/AutomodeDriver.ts:280-294); tickOnce exposed for tests (driver tests step it directly; ticks never overlap — single sequential fiber). tickOnce: reconcile running -> halted? return -> held-PR lifecycle -> oldestQueued -> supervisor.dispatchGoal(:269). Goal START = spawnPeer inside dispatchGoal (Layers/AutomodeSupervisor.ts:736-759).
- Verify commands: NO hardcoded set; policy.verificationCommands (GitsVerifyCommand {label, cmd: string[], timeoutSeconds?}, gits.ts:683-688) passed at AutomodeDriver.ts:135; empty -> halt (:115). Jail: GitsConfinedVerifyAdapter + GITS_CONFINE_BIN + bwrap H0, default timeout 600s.
- Runtime-limit bug: enforceRuntimeLimit (Layers/AutomodeSupervisor.ts:474-504) forkDetach'd; after sleep killPeer runs UNCONDITIONALLY (:483); only the status write is guarded (:494). completeGoal/failGoal dropDeadline (persisted map only) — fiber never stopped. Boot re-arms timers from persisted runtimeDeadlines (:508-520).
- resumeDriver exists (Layers/AutomodeSupervisor.ts:872-883) — NO RPC. Existing automode RPCs: snapshot, policy.update, goals.enqueue/approve/reject/dispatch (rpc.ts:257-262, ws.ts:1675-1719).
- RPC add-a-method = 5 layers (worked example gitsAutomodeUpdatePolicy): (1) WS_METHODS const rpc.ts:258; (2) Rpc.make rpc.ts:717-721; (3) WsRpcGroup entry rpc.ts:~1026; (4) ws.ts handler in WsRpcGroup.of({...}) at ws.ts:873+ (services resolved ~:328) wrapped in observeRpcEffect; (5) client wrapper packages/client-runtime/src/wsRpcClient.ts automode namespace :419-432 + interface :174.
- Boot composition: server.ts GitsLayerLive (:335-361); AutomodeDriverLayerLive built :313-326 with Layer.provide(AutomodeSupervisorLayerLive, DelamainCliAdapterLive, ...). New scheduler layer registers here.
- Time: NO timezone/cron code anywhere; epoch-ms + ISO UTC only. TestClock idiom exists (SessionCredentialService.test.ts) but driver tests prefer direct tickOnce stepping.
- Env idiom: inline process.env parse + default IIFE (AutomodeDriver.ts:18-22).
- Capacity: GitsCapacityMonitor.getSnapshot() -> GitsCapacitySnapshot {codex: {windows: GitsUsageWindow[]}, ...} (gits.ts:859-908). codex windows sorted asc by windowMinutes: label "5h" then "weekly"; usedPercent = integer 0-100, NULLABLE; status may be "unavailable" (empty windows). NO cache — parses ~/.codex/sessions tails per call. No threshold helper exists.
- Push: PushNotificationService.sendToAll({title, body, tag, url}) -> Effect<void> (never fails) — push/Services/PushNotificationService.ts:19. Directly callable; the scheduler layer can depend on it.
- Proposals: HermesProposalCard (gits.ts:1193-1215) persisted in flat JSON gits-proposals.json under hermesHome. Minted in makeProposal (id hermes-<uuid>, HermesCliAdapter.ts:~1204). Store reads go through hand-rolled lenient normalizeProposal (:1010-1083) — NOT Schema decode; legacy backfill belongs THERE. decideProposal :2055-2094. Bridge decideProposalWithAutomodeBridge (HermesAutomodeBridge.ts:19-59) is the WS handler for gitsHermesDecideProposal (ws.ts:1790-1795); arms iff approve && autoEnqueueApprovedProposals && mode==="autonomous"; it ALREADY fetches proposals for the priorStatus lookup (:35-39) — capture the whole card there for episodeId; enqueues only {title, prompt, repo} today (:46) — proposal→goal identity severed at this exact line.
- summarizeProposal (HermesCliAdapter.ts:1110-1120): title = first non-empty line of raw hermes stdout (strips leading #); zero filtering of "⚠️ Reached maximum iterations (N)" chrome. Shared by both proposal-creation paths (:1878, :2012) — fix once here.
- Episode ledger: sqlite automode_episodes (Migrations/032). Single writer AutomodeDriver.ts:177-199 post-land, row id ep-<goalId>-<ISO>, failures swallowed. Migrations: manual two-place registration (Migrations.ts imports :16-50 + migrationEntries :62-98), MUST be contiguous (assertMigrationIntegrity), latest = 035 → new = 036.
- Held PR: run-scoped, opened after queue drains (AutomodeDriver.ts:229-251), body lists landed slice titles; episode rows written BEFORE the PR opens.
- Cockpit: apps/web/src/components/gits/GitsCockpit.tsx; AutomodePanel :3911; kill-switch Arm/Kill button :4045-4053; driver-halted banner :4066-4073 (text-only, no Resume); mutations block :4935-4981 (useMutation + automodeQuery.refetch()); snapshot query :4536.
- WS test harness: server.test.ts:1377-1408; automode RPC driving example :4496-4548; goal fixture defaultAutomodeGoal server.test.ts:225; proposal fixture defaultHermesProposal server.test.ts:406; bridge fixture HermesAutomodeBridge.test.ts:96; contracts fixtures packages/contracts/src/gits.test.ts.
- CI required check runs: bun run fmt:check / lint / typecheck / test / (apps/web) test:browser / build:desktop.
- VPS (vps-eu): bwrap installed + GITS_CONFINE_BIN drop-in applied + service restarted (DONE by hand — this PR only records it in hosting scripts).

## Deliverable 1 — GitsSlotScheduler (new Service + Layer under apps/server/src/gits)

NO background fiber: pure state + clock service pulled by the driver tick and RPC reads. getSnapshot/checkStartAllowed derive EFFECTIVE arming from persisted arming + clock (pure derivation; expiry is never written back outside arm/disarm/boot — the cockpit polls snapshot, so derived expiry keeps it truthful without writes). Boot-disarm happens at layer init.

Persisted state ({stateDir}/gits/automode-scheduler-state.json; versioned schema, withDecodingDefault forward-compat, atomic write, Ref + Semaphore(1) — mirror the supervisor):
- config: { enabled: boolean (default false), maxGoalsPerNight: int >=1 (default 3), weeklyMaxUsedPercent: int 1-100 (default 80) }
- arming: { status: "disarmed" | "armed", nightKey: string | null ("YYYY-MM-DD" London date of the autonomy day), armedAt: ISO | null, disarmedReason: string | null }
- nightLog: array of { nightKey, goalId, episodeId, startedAt } (append per recorded start; prune entries older than ~14 nights on write)
- lastGateDecision: { at: ISO, allowed: boolean, reason: string | null } | null — persist ONLY when the decision reason changes; live value in the Ref.
- lastEvent: string | null

London time helper (pure, pinned shape — the ONLY tz code in the phase):
- new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hourCycle: "h23", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(epochMs) -> { dateKey: "YYYY-MM-DD", minutesOfDay, isWeekend }. hourCycle "h23" explicitly (hour12:false can yield "24" on some ICU builds).
- nextNightKey = london(epochMs + 86_400_000).dateKey (DST-safe).
- Slot boundaries + remaining time computed in wall-clock minutes: slotRemainingMs = (endMinutes - nowMinutes) * 60_000. ponytail comment: ±1h exactly two nights/year (DST transitions inside 00:00-05:00); autumn denies more (safe), spring overestimates runway bounded by the runtime-cap kill.

Slot model:
- Default slots (decision 6): daily [00:00,05:00) and [05:00,10:00); Sat/Sun additionally [10:00,15:00).
- Env override GITS_SCHEDULER_SLOTS_JSON: validated array of {days: "all"|"weekend", start: "HH:MM", end: "HH:MM"} (start<end, same-day windows). Invalid -> log warning, use defaults. (e2e + ops calibration knob.)
- Autonomy day (nightKey) = London date D; its slots run 00:00-10:00 of D (+10:00-15:00 when D is Sat/Sun). DOCUMENTED CHOICE (operator sign-off in PR body): a weekend arm covers 00:00-15:00 of D under ONE maxGoalsPerNight cap.
- armTonight semantics: if now is before the end of D's last slot, arm covers the remainder of D; else arm covers D+1 (the 22:00 evening arm lands on D+1).
- Armed state auto-expires (derived) once D's last slot ends.

Service API:
- getSnapshot() -> { config, arming (effective), currentSlot: {start: "HH:MM", end: "HH:MM"} | null, slotRemainingMs: number | null, goalsStartedTonight: number, lastGateDecision, lastEvent, checkedAt }
- setConfig({enabled?, maxGoalsPerNight?, weeklyMaxUsedPercent?}) — validated
- arm() — errors if config.enabled === false ("Enable the scheduler before arming."); idempotent for same nightKey
- disarm(reason?) — never touches the running goal (decision 7: slots gate STARTS only)
- checkStartAllowed({expectedRuntimeMinutes: number | null, maxActivePeers: number}) -> {allowed: true} | {allowed: false, reason: string}
- recordGoalStart({goalId, episodeId})

checkStartAllowed order (first reason wins):
1. config.enabled === false -> ALLOWED (bypass; preserves today's interactive behavior). Records nothing.
2. effective arming !== armed for current nightKey -> deny "Not armed for tonight" / "Armed night ended".
3. now outside every slot -> deny "Outside slot window (next slot HH:MM)".
4. goalsStartedTonight >= config.maxGoalsPerNight -> deny "Night goal cap reached (N)". (decision 11)
5. Envelope (decision 11): maxActivePeers > 1 -> deny "Autonomy envelope requires maxActivePeers=1 (policy has N)". expectedRuntimeMinutes null -> deny "No runtime cap configured" (fail closed). expectedRuntimeMinutes > 90 -> deny "Runtime cap exceeds the night envelope (~90m)" (const NIGHT_MAX_RUNTIME_MINUTES = 90, ponytail comment).
6. Runway (decision 7): expectedRuntimeMinutes > remaining slot minutes -> deny "Insufficient slot runway".
7. Capacity (decision 20), via a ~60s-TTL memo (Ref {at, snapshot}; ponytail comment naming TTL) over GitsCapacityMonitor.getSnapshot():
   - codex "5h" window usedPercent != null && >= 50 -> deny "Codex 5h window at N%" (const CAPACITY_MAX_USED_PERCENT_5H = 50).
   - codex "weekly" window usedPercent != null && >= config.weeklyMaxUsedPercent -> deny "Codex weekly window at N% (reserve M%)" (decision 20's weekly interactive reserve, sized top-down).
   - Missing telemetry (unavailable/null) -> ALLOW; reason strings must distinguish "capacity unknown (no telemetry)" from "capacity monitor error" (logWarning on the error branch). Fail-open rationale: post-idle-evening night starts structurally lack rate_limits; goal-count + runtime caps bound the burn.

Boot invariant (decision 8): at layer init, if persisted arming.status === "armed" -> force {status:"disarmed", disarmedReason:"Server restarted mid-night — re-arm required."}, lastEvent same, Effect.logWarning, AND one web-push via PushNotificationService.sendToAll({title:"GITS autonomy disarmed", body:"Server restarted mid-night — re-arm required.", tag:"gits-scheduler-boot", url:"/gits"}) (decision 3 ratifies web-push day-one; sendToAll is infallible).

Driver integration (Layers/AutomodeDriver.ts tickOnce): after oldestQueued finds a goal, BEFORE supervisor.dispatchGoal: checkStartAllowed({expectedRuntimeMinutes: policy.maxRuntimeMinutes, maxActivePeers: policy.maxActivePeers}). Deny -> return (goal stays queued; NOT a halt; no per-tick log spam). Allow -> dispatchGoal; if result.peer !== null -> scheduler.recordGoalStart({goalId, episodeId: goal.episodeId}). Manual RPC dispatch stays ungated (human-driven). ACCEPTED RESIDUAL (PR body): checkStartAllowed->dispatch->recordGoalStart is not atomic with a concurrent disarm RPC — a disarm landing mid-dispatch lets exactly one goal start (consistent with decision 7).
Layer wiring: GitsSlotSchedulerLayerLive provided to AutomodeDriverLayerLive and merged into GitsLayerLive (server.ts:335-361); ws.ts resolves the service for handlers; scheduler layer depends on ServerConfig, FileSystem, Path, GitsCapacityMonitor, PushNotificationService.

## Deliverable 2 — RPC + cockpit surface

New WS RPCs (5-layer pattern; payload/success/error schemas in gits.ts):
- gits.automode.scheduler.snapshot -> GitsSchedulerSnapshot
- gits.automode.scheduler.setConfig {enabled?, maxGoalsPerNight?, weeklyMaxUsedPercent?} -> GitsSchedulerSnapshot
- gits.automode.scheduler.arm {} -> GitsSchedulerSnapshot
- gits.automode.scheduler.disarm {reason?} -> GitsSchedulerSnapshot
- gits.automode.driver.resume {} -> AutomodeSnapshot (wires EXISTING supervisor.resumeDriver — no new logic)
Error type: GitsSlotSchedulerError (TaggedError, mirror AutomodeSupervisorError).
Cockpit (GitsCockpit.tsx, AutomodePanel ONLY — PR #159 reworks other sections of this file): (a) scheduler status card — enabled toggle, armed/nightKey, current slot + remaining, goals-tonight vs cap, last gate decision, Arm/Disarm buttons; include hint copy when enabled ("scheduler gates autonomous starts — disable for supervised daytime runs, or dispatch manually"); (b) Resume-driver button on the existing halted banner (:4066-4073). Follow the existing useMutation + refetch shape.

## Deliverable 3 — Episode ID (decision 23; pinned into the phase-1 schema)

Format epi-<uuid> (crypto randomUUID). Threading:
- HermesProposalCard gains episodeId: string (required in domain type). Mint in makeProposal. Legacy store backfill = ONE LINE inside normalizeProposal's return literal (HermesCliAdapter.ts:1051-1082): episodeId from record.episodeId ?? `epi-legacy-${id}`. Do NOT add any Schema decode to the proposals store path (it is deliberately lenient).
- AutomodeGoal gains episodeId: string via schema-level backfill so old automode-state.json still decodes: episodeId: Schema.String.pipe(Schema.withDecodingDefault(Effect.sync(() => `epi-legacy-${randomUUID()}`))) in gits.ts (CRITICAL: without the decoding default, PersistedAutomodeState decode fails and silently WIPES all persisted automode state on first boot — the reviewer-confirmed blocker). AutomodeEnqueueGoalInput gains optional episodeId; enqueueGoal (AutomodeSupervisor.ts:~560) mints epi-<uuid> when absent.
- Bridge: the existing priorStatus lookup (HermesAutomodeBridge.ts:35-39) captures the whole proposal card; pass its episodeId into enqueueGoal at :46. Zero extra reads. Update HermesAutomodeBridge.test.ts:96 fixture.
- Peer threading: prepend "Episode: <episodeId>" line to the spawned peer prompt at dispatch (delamain repo untouched; traceability via prompt, v1).
- Ledger: migration 036 adds episode_id TEXT column (nullable for old rows) + index idx_automode_episodes_episode(episode_id); AutomodeEpisode schema gains episodeId (nullable); driver record_episode passes running.episodeId. Do NOT repurpose the id PK (reject→approve on one proposal can produce two goals sharing an episodeId; PK upsert would overwrite history). Row id stays ep-<goalId>-<ISO>. NOTE sqlite: ALTER TABLE ADD COLUMN in migration 036 (matching the repo's plain-SQL idiom).
- Held PR: body lists "- <title> (episode <episodeId>)" per completed goal (textual thread; per-goal PRs are phase 4).
- Other fixture updates: server.test.ts:225 (defaultAutomodeGoal), server.test.ts:406 (defaultHermesProposal), packages/contracts/src/gits.test.ts decode fixtures. Web constructs no AutomodeGoal/HermesProposalCard literals.

## Deliverable 4 — verify floor widening (phase-0 prereq; the #154 lesson)

- AUTOMODE_VERIFY_FLOOR: GitsVerifyCommand[] const in the driver module: fmt=["bun","run","fmt:check"], lint=["bun","run","lint"], typecheck=["bun","run","typecheck"], test=["bun","run","test"] (timeoutSeconds 900), build=["bun","run","build"] (timeoutSeconds 900). gitscode-specific until the phase-3 registry owns per-repo floors — ponytail comment says exactly that.
- NO env escape hatch (cut per review): the merge rule below already lets policy override any floor entry by label via the existing updatePolicy RPC — no deploy needed if `bun run build` proves jail-hostile.
- Driver merges floor ∪ policy.verificationCommands by label (policy entry wins on collision) before reviewPipeline.review. The halt-on-empty check (AutomodeDriver.ts:115) applies to the MERGED set.
- Residual gap documented in PR body: CI also runs Browser Test and build:desktop; the jail floor uses `bun run build` and omits browser tests (no Playwright browsers in the jail).

## Deliverable 5 — remaining phase-0 debt

(a) summarizeProposal (HermesCliAdapter.ts:1110-1120): extend the existing .filter to also reject hermes chrome — lines starting with status glyphs (⚠️, ℹ️, ✓, ✗) and /reached maximum iterations/i. Existing fallback title covers the all-filtered case.
(b) resumeDriver RPC — Deliverable 2.
(c) enforceRuntimeLimit: after the sleep, re-read state; proceed with killPeer + status write ONLY IF the goal is still status==="running" with the same peerId AND runtimeDeadlines[goalId] === this deadline; otherwise exit silently (no killPeer, no lastEvent). (Review-confirmed sound: deadline-equality handles re-dispatch-after-fail; boot re-arm unaffected; residual read->kill window can only SIGTERM an already-terminal peer.)
(d) AUTOMODE_BASE_REF (Services/AutomodeLanding.ts:7): process.env.GITS_AUTOMODE_BASE_REF?.trim() || "gits"; consumers unchanged; ponytail comment that the phase-3 registry supersedes.
(e) Hosting scripts record the VPS fixes: provision-autonomy-host.sh installs bubblewrap alongside its other packages; install-gits-user-service.sh unit gains Environment=GITS_CONFINE_BIN=<worktree>/scripts/gits-confine.sh (served worktree contains the script; mirrors the vps-eu drop-in).

## Tests (colocated .test.ts, it.effect + Layer.mock; direct stepping over TestClock where possible)

- London helper + slot math (pure fns): weekday night slots, weekend day slot, boundary instants (00:00/05:00/10:00/15:00), one GMT winter + one BST summer date, midnight hourCycle h23 sanity, nightKey selection around midnight and around last-slot end, slots-JSON override (valid + invalid->defaults).
- Arming: arm/disarm/expiry (derived); arm-while-disabled errors; arm idempotence; boot-load forced disarm with reason + web-push sendToAll called (mock).
- Gate: every deny reason in order (incl. envelope maxActivePeers>1, runtime>90, weekly reserve); allow path; enabled=false bypass; capacity fail-open on unavailable/null vs monitor-error (distinct reasons); 5h deny at >=50.
- Driver: scheduler deny -> no dispatch, goal stays queued, no halt; allow -> dispatch + recordGoalStart with goal's episodeId; verify-floor merge reaches reviewPipeline (assert merged commands + label-collision override + empty-merged halt).
- Episode ID: enqueue mints; bridge forwards proposal's episodeId; normalizeProposal backfill; AutomodeGoal decoding default (decode a legacy JSON goal WITHOUT episodeId succeeds); ledger row carries episode_id; held PR body contains episode ids.
- summarizeProposal: warning-first-line -> real title; all-chrome output -> fallback.
- enforceRuntimeLimit: goal completed before deadline -> NO killPeer + no lastEvent.
- Migration 036 via AllMigrations fixture conventions.

## E2E (headless; per gits-headless-verify-harness + review amendment)

node apps/server/src/bin.ts serve, isolated T3CODE_HOME, throwaway project dir (no .planning), GITS_AUTOMODE_DRIVER_TICK_MS small; WS-RPC via `auth session issue --token-only` -> POST /api/auth/ws-token -> ws?wsToken=… (mint per connection, 5-min TTL).
1. setConfig{enabled:true} + arm -> snapshot armed with correct nightKey.
2. Slot edge: boot with GITS_SCHEDULER_SLOTS_JSON NOT covering now; arm policy (autonomous, killswitch off, runtime cap <=90, maxActivePeers 1, allowlist, integrationBranch) + approve goal + arm scheduler -> goal STAYS queued, gate decision "Outside slot window". Then boot with slots covering now and RE-APPLY via RPC (killSwitchEnabled:false + approveGoal + scheduler.arm — reArmOnBoot clears all three on every boot) -> dispatch attempt observed (delamain spawn fails in test env -> driver halt whose reason proves the gate opened).
3. reArmOnBoot: arm scheduler, kill server, boot -> snapshot disarmed with "Server restarted mid-night" reason.

## Discipline

- Branch feat/autonomy-phase1-scheduler; PR base gits; gh always --repo Ecko95/gitscode.
- oxfmt on changed paths only (never repo-wide); typecheck with fresh package-local tsgo (turbo caches stale).
- Conventional commits. Known CI flake: wsTransport resubscribe (client-runtime) -> rerun once.
- Do NOT touch ~/dev/projects/delamain. No Telegram (phase 2). No repo registry (phase 3). No per-goal PR change (phase 4).
- PR-body residuals to list: weekend single-cap choice; disarm-vs-dispatch one-goal race; verify-floor browser-test/build:desktop gap; boot-disarm notify = web-push now, Telegram phase 2; capacity fail-open rationale.
