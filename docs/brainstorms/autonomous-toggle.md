# Autonomous Toggle (1 repo) — Brainstorm

> Status: **complete** · Last updated: 2026-06-07
> Parent: `docs/brainstorms/self-improving-orchestration.md` (this is **item #5** of that roadmap's build sequence — the "fully-agentic toggle"). Design-of-record: `docs/gits/ORCHESTRATION_SELF_IMPROVEMENT_DESIGN.md`.

## v1 scope (RATIFIED — quick reference)

**Target: `gitscode` self-hosting** (Motoko reads `self-improving-orchestration.md` + this doc as seed context, drives gitscode's own roadmap). Scoping = `AutomodePolicy.allowedRepos = ["<gitscode>"]`.

**v1 = the full Motoko loop, ONE project, sequential:**

1. Hermes configured + SOUL standing-approval clause → Motoko gains dispatch (proposal→goal).
2. Context-gate: Motoko drafts the slice plan from context; gaps → grill (interactive cockpit + async-Telegram); writes brainstorm/spec + per-slice criteria.
3. Server-side `AutomodeDriver` fiber, **sequential**, walks the goal queue for one repo.
4. **Confined-yolo peers via modified `delamain` (H0b)** → held PR → `gits` (autoMerge OFF) → halt-on-hold/fail → hard-stop kill → manual resume.
5. Verifier-critic = gate **and** per-peer summary → **per-project ledger** (Motoko reads ledger, not transcripts; rehydrates on reset).
6. Tiered peer-question auto-answer: type-gate (derivable+reversible+non-scope-changing → auto) + difficulty-ladder (mini → `gpt-5.5`) + operator terminal backstop.
7. Telegram notifications via the existing GITS/Motoko/Hermes bot channel.
8. Per-project session state keying (multi-session-ready, even though v1 runs one project).

**Deferred (north-star / fast-follow):** 2–4 concurrent projects · codex-weekly 80% cost throttle · full H0c egress allowlist · autoMerge-ON · L3 autonomous decomposition · reflection→routing tuning · dedicated summarizer · PWA/web-push.

## Summary

Goal: ship the **autonomous toggle for a single repo** where **Motoko (Hermes) is the conducting brain**. The operator states an intent; Motoko judges whether it understands well enough to build it. **If yes → it dispatches confined Delamain peers. If no → it conducts a grill-me Q&A to extract + write down the missing context, then dispatches.** The mechanical execution substrate (server-side `AutomodeDriver`, confined-yolo peers, held PR → `gits`, sequential, poll-observe, halt/kill/resume) is **Motoko's execution arm**, not a standalone loop.

**Core reality check:** today's code withholds this from Motoko — Motoko/Hermes is read-only (`listPeers` only), the SOUL says `observe-propose-only`, and the Hermes home was unconfigured. So **v1's central job is to grant Motoko dispatch + grill + context-judgment capability** (net-new Hermes work), on top of the execution substrate. Consistency with the SOUL is preserved by the envelope: Motoko **dispatches**, peers do the writes **in a jail**, output is a **held PR to `gits`** that the operator merges — Motoko never _lands_ changes. The autonomous-mode policy is the standing "approval to route."

Flow:

```
intent → Motoko: enough context to build?
              ├── YES → plan slices → dispatch confined Delamain peers → held PR → gits
              └── NO  → grill-me Q&A → write context (brainstorm/spec + per-slice criteria) → dispatch
```

## Current state (verified from code, 2026-06-07)

- **`AutomodeMode` enum already includes `"autonomous"`** — `packages/contracts/src/gits.ts:543`. The value exists but is nearly inert.
- **`AutomodeSupervisor` is a request-driven service, not a loop.** Methods: `getSnapshot`, `updatePolicy`, `enqueueGoal`, `approveGoal`, `rejectGoal`, `dispatchGoal` (`apps/server/src/gits/Layers/AutomodeSupervisor.ts`). No internal scheduler scans queued goals.
- **Spawn path works:** `dispatchGoal` → `delamainAdapter.spawnPeer({repo,prompt,name,model})` (line 562). One peer per dispatch.
- **`dispatchGoal` is called from exactly one place:** the WS RPC handler `apps/server/src/ws.ts:1325`. So today every spawn is operator-triggered.
- **Default policy is locked-down:** `mode:"manual"`, `killSwitchEnabled:true`, `maxActivePeers:1`, `requireApprovalForPeerSpawn:true`, `requireApprovalBeforeIntegrate:true`, `requireApprovalBeforeDestructiveAction:true` (lines 150–165).
- **Approval gate logic** (`goalNeedsApproval`, lines 193–203): in `supervised` mode OR if `requireApprovalForPeerSpawn` → always needs approval; integration/destructive prompt patterns gate independently of mode.
- **Runtime kill-timer exists** (`scheduleRuntimeLimit`) — after spawn, SIGTERMs the peer at `maxRuntimeMinutes`.
- **Two spawn paths, both human-triggered today:** (A) **gated** — `AutomodeSupervisor.dispatchGoal` → `spawnPeer` (passes 6-gate ladder + approval); (B) **raw, ungated** — WS RPC `gits.delamain.spawnPeer` (`ws.ts:1236`) bypasses _all_ automode gates/approval and spawns immediately. Both have only a cockpit-button caller; neither has an autonomous clock.
- **Goal lifecycle dead-ends at `running`:** the supervisor sets `running` on spawn and `blocked` on runtime-limit, but **no code transitions a goal to `completed`/`failed` based on peer outcome**. There is no peer-outcome observation — so even L2 "auto-advance" has nothing to advance _on_ today.
- **Three parallel representations of "pending work"**, none auto-routed to a spawn: (1) GSD phase **"Your Turn" cards** (read-only projection, `GitsPlanningScanner`, carry only a `sourcePath`); (2) Hermes/Motoko **proposal cards** (`observe-propose-only`); (3) AutomodeSupervisor **goals** (`queued`). Enqueue ≠ spawn.

### Motoko specifically (verified)

- Motoko is **not a running agent** — it's a versioned **persona** (`SOUL.md` + profile distribution) fed to the **Hermes Agent runtime** (Nous Research "Hermes Agent v0.15.1"), invoked as a child CLI via `HermesCliAdapter`. `skills/` + `cron/` dirs are still placeholder READMEs.
- **Motoko cannot spawn at all, by contract and by code:** `HermesAdapter` interface exposes no spawn/integrate/merge method; the injected `delamainAdapter` is used only for read-only `listPeers()` (`HermesCliAdapter.ts:1849`). Approving a proposal (`decideProposal`) only flips status to "handoff only" — it never calls `spawnPeer`. `config.yaml.example`: `execution: observe-propose-only`, `delamain_execution: approval_required`.
- **Hermes managed home (`~/.gits/hermes`) was unconfigured** as of 2026-06-02 (no `.env`/`config.yaml`, Codex OAuth not logged in) — live Motoko chat may hit the "setup-required" branch.

### Safety / blockers for unattended live use

- **Spawned peers are not yet confined** (H0 spike, `spikes/h0-confinement/SPIKE_FINDINGS.md:67`) — `delamain spawn` peers run unconfined; TODO items H0b/H0c (confine peer spawn + egress allowlist) are open.
- **Verifier-critic author side is un-wired** — nothing writes per-slice `<slice_id>.md`, so with `semantic_verify:true` every slice holds (parent roadmap #1, `TODO.md:36`).
- **Roadmap items 2–5 are unbuilt** — repo-wide grep for `OrchestratorConfig`/`MemoryStore`/`PeerOutcome` returns zero matches.

### Missing for "continue to plan & implement"

(a) an autonomous **driver loop** (no scheduler/cron/`forkDaemon`/`Schedule` anywhere); (b) a **planning/goal-generation** step (decompose roadmap → goals); (c) **observe-peer-result → re-plan** feedback (goal never leaves `running`); (d) **verifier-critic** integration (author-side criteria un-wired); (e) **confinement** of spawned peers for unattended use.

## Key decisions

1. **Execution model = L2 (advance through a slice plan), but planning is Motoko-conducted, not operator-hand-authored.** The toggle drives a slice list to completion (dispatch → observe → hold → next). The _plan_ is produced by **Motoko grilling the operator when context is insufficient** (human-in-loop decomposition), or read from existing context when sufficient — NOT autonomous/unsupervised decomposition (pure L3). So: L2 execution + interactive Motoko planning. _(Supersedes the earlier "operator hand-authors handoffs.tsv" framing — that's now just one way context can already be sufficient.)_

2. **Motoko (Hermes) is the conducting brain — REJECTS the "decouple Motoko" idea.** Flow: `intent → Motoko judges context-sufficiency → (enough: plan + dispatch confined peers) | (not enough: grill-me Q&A → write context → dispatch)`. v1's central net-new work is **granting Motoko dispatch + grill + context-judgment**, since today it's read-only/`observe-propose-only`/Hermes-unconfigured. SOUL stays intact via the envelope: Motoko **dispatches**, peers write **in a jail**, output is a **held PR to `gits`** the operator merges — Motoko never _lands_.

3. **Tiered peer-question auto-answerer (parent #3 + #4 + #10 converge).** When a confined peer asks a question, Motoko resolves it autonomously by **model-tier escalation**: first a **cheap mini model** (e.g. `gpt-5.x-mini`) answers _if it has enough context_; if it needs further clarification, escalate to a **`gpt-5.5` agent** to resolve. _(Open: final rung if even 5.5 can't answer — escalate to operator via Telegram? See open flags.)_ This supersedes Q4's "waiting → just Telegram the operator."

4. **Per-peer finish summaries + Motoko context hygiene + orchestration ledger.** Each Delamain peer returns a **compact summary** on finish (what was done, what issues arose) — Motoko reads summaries, **never full transcripts**, to protect its own context window. Motoko **keeps a record** of how the whole thing is assembled (the parent's SQLite **episode ledger**, #2). This is what lets Motoko orchestrate **multiple peers** and survive context resets.

5. **Delamain owns all git mechanics** — worktree, branch, slice→integration merge, PR. GITS/Motoko never reimplements version control (reinforces Q8 Option 1: delamain stays the peer manager). The higher _integration→`gits`_ boundary remains operator-gated (Q5 autoMerge OFF) unless revised.

6. **Concurrency = multi-PROJECT, not multi-peer-per-repo. CONFLICT RESOLVED.** "Simultaneous" means Motoko runs **multiple projects at once**, each its own **session scoped to its own repo** (e.g. meetmark + isomer-calc-engine), each running an **internally sequential** Delamain loop (one peer at a time, Q3 holds within a repo). Operator juggles **2–3 repos typically, 4 max**, usually focused on one. So there are **no intra-repo merge races/deadlocks** — concurrency is N independent per-project loops. New requirement: **per-project session isolation** (today `automode-state.json` is a single global file at `<stateDir>/gits/` — must become **per-repo/per-session keyed**) + a **cross-session project registry** Motoko tracks (which projects active, status, per-project integration branch + ledger + Telegram thread).
   - **v1 = ONE project/repo, sequential loop, but state keyed per-repo/session from day one** so adding the 2nd–4th project is additive instances, not a rewrite. (This is the real meaning of "parallel-ready architecture" here: _multi-session-ready_, not multi-peer.)

7. **Driver = a new server-side `AutomodeDriver` layer, reusing the autopilot's proven logic.** The autonomous toggle is `AutomodePolicy.mode = "autonomous"` driving a server-native loop fiber (Effect `Schedule`/`forkDaemon`) — NOT a Claude-Code-session-bound autopilot skill (that's the manual equivalent / prior art). The driver reuses the existing `AutomodeSupervisor` queue + gates + kill-switch + persistence, and ports the autopilot skills' hard-won mechanics (forbidden-path diff, verifier-critic, patch-id merge detection) rather than re-deriving them. New layer, not folded into `AutomodeSupervisor`.

## Q&A log

### Q1 — Where does v1 land on the autonomy ladder; does "continue to plan" mean generate or advance?

**Answer:** **L2 — advance through slices I already planned.** Not L3 (no autonomous slice generation in v1).
**Notes:** Recommendation accepted. Forces the design toward a closed _execution_ loop (observe→transition→next) over a fixed plan, deferring the _planning_ intelligence. The peer-outcome observation layer is net-new (goal status never leaves `running` today).

### Q2 — What runs the loop? (driver architecture)

**Answer:** **A — a new server-side `AutomodeDriver` layer, reusing autopilot logic.**
**Notes:** Server-native fiber (not CC-session-bound); the toggle is genuinely `AutomodePolicy.mode`. Reuses `AutomodeSupervisor` queue/gates; ports autopilot mechanics (forbidden-path diff, patch-id merge detection, verifier-critic). Separate layer from the supervisor for separation of concerns.

### Q3 — Canonical plan artifact + source of truth?

**Answer:** **Option 1 — goal queue is the spine; sequential for v1.**
**Notes:** `handoffs.tsv` (autopilot format: `slice_id · title · merge_branch · model · yolo · engine`) is the human-authored **import**; importing seeds ordered `AutomodeSupervisor` goals AND writes each slice's `slices/<id>.md` criteria (reusing the existing `GitsSliceCriteria` store at `<stateDir>/gits/slices/<sliceId>.md` — this closes the verifier author-side gap). Driver walks `queued` goals in order. **Strictly sequential**: slice N+1 starts only after slice N merges/holds — no dependency graph in v1 (defer `dependsOn`). Net-new: a slice `order` field on the goal model (queue is currently flat, `createdAt`-sorted).

### Q4 — How does the driver observe peer outcome and advance the goal?

**Answer:** **Poll tick** (Effect `Schedule.fixed`) over `listPeers`; **`waiting` peer → pause-and-notify via Telegram.**
**Notes:** Driver finds the peer by goal `peerId`, maps `PeerStatus`→goal transition: `pending`/`running`→wait; `waiting`→**pause chain + Telegram notify** (no auto-answerer in v1, parent #3); `done`/`completed`+pushed→review/merge gate; `failed`/`frozen`/`killed`/`halted`/`integrationStatus:failed`→`failed`+halt. Net-new: goal `running→completed/failed` transitions (enum has them, never set today). The `done+pushed → capture SHA → review → merge → patch-id detect` cascade ports from the autopilot.
**Notification surface = the existing GITS/Motoko/Hermes Telegram bot channel** (reuse the operator's existing bot token + chat_id — same channel Hermes/autopilot already uses), NOT a separate autopilot Telegram setup. ⚠️ **Net-new server plumbing:** there is currently **zero Telegram code in the server** (`grep -ri telegram apps/server` = nothing; only docs/confinement scripts reference it). v1 needs a small server-side `TelegramNotifier` adapter that reads bot creds from config and posts event/escalation messages. GITS PWA + web push remains the deferred parallel workstream (parent open flag).

### Q6 — Branch topology for chaining unmerged-but-passed slices

**Answer:** **Integration branch with a single held PR, targeting `gits` (not `main`).**
**Notes:** Each roadmap run owns a working branch `auto/<roadmap-id>` based off `origin/gits`. On verifier-pass, the driver lands the slice branch onto the integration branch (the **chain-advance mechanism**) and spawns the next slice from the integration tip (`startRef = integration`). At roadmap end, the driver opens **one held PR `auto/<roadmap-id> → gits`** + Telegram. `autoMergeOnVerifierPass` (OFF for v1) governs that final `integration→gits` boundary. So "held as a PR" = **one held `integration→gits` PR per run**, not N per-slice PRs. Targets `gits` (the tailnet-deployed branch) per the deploy-branch convention; `main` is never touched by the toggle. (Slices' `merge_branch` in `handoffs.tsv` = the integration branch.)

### Q7 — Safety envelope for unattended: confinement model

**Answer:** **`--yolo` (full in-repo autonomy, no approval prompts) BUT jailed to the assigned repo, sandcastle-style.** Cost throttle: _(pending explicit confirm — see Q8)_.
**Notes / reference:** [sandcastle](https://github.com/mattpocock/sandcastle) = container/microVM jail, repo worktree bind-mounted, agent non-root, **fully autonomous (no prompts)**, human review **after** commits land on a branch. Aligns with our held-PR-to-`gits` model (Q5/Q6).
**The mechanism already exists in-repo:** `scripts/gits-confine.sh --profile peer` (bubblewrap): worktree-only writes, binds **only** the single peer credential read-only (all other secrets — `~/.codex`, `~/.gits/hermes`, telegram, cursor token — invisible), `--egress off|host|proxy=`. Verified by H0 spike (14/14).
**⚠️ DIVERGENCE from written H0b plan:** `H0_CONFINEMENT.md:121-122` says "drop `--yolo`/`danger-full-access`" — but explicitly _"for untrusted repos."_ v1's target is a **trusted** repo (the operator's own, the assigned one), so the threat model is "agent goes off-rails outside the repo," which the bubblewrap jail already contains — NOT "hostile repo exfiltrates secrets." Therefore **keep `--yolo`; the jail (worktree + single-cred) is what makes it safe.** This reframes H0b: confine-the-spawn, but do **not** drop yolo for trusted repos.
**Repo-scoping** ("only the repo that's assigned") = bubblewrap `--worktree` (filesystem) + `AutomodePolicy.allowedRepos` (which repo may be assigned at all).
**Residual risk accepted for v1:** egress is unfiltered (`passt`/`pasta` absent → `--egress proxy=` advisory only). Acceptable for a trusted repo where the jail already hides every secret but the one model-API cred. Full H0c egress allowlist = fast-follow (install `passt`).

### Q8 — How the jail is applied to the peer; cost throttle in v1?

**Answer:** **Option 1 — modify `delamain` so `delamain spawn` launches its codex/cursor child through `gits-confine.sh --profile peer` (keeping `--yolo`). H0b is a v1 prerequisite. Codex-weekly 80% throttle is DEFERRED — NOT in v1.**
**Notes:** Modifying the `delamain` binary is in-scope. Option 1 preserves every reuse decision — delamain stays the peer manager (worktree/branch/PR/status), GITS keeps calling `delamainAdapter.spawnPeer`, and the `listPeers`-based poll-tick observation (Q4) keeps working. (Option 2, GITS-direct confined spawn, was rejected: it would force rebuilding delamain's peer lifecycle inside GITS.)
**Throttle deferred:** the codex-weekly 80% reserve (`GitsCapacityMonitor` → pause auto-spawn) is a later addition, not v1. ⚠️ **Accepted residual risk:** v1 ships with **no automatic cost guardrail**. The only things bounding spend in v1 are: `maxActivePeers = 1` (sequential, one peer at a time), the per-slice runtime SIGTERM (`scheduleRuntimeLimit`), halt-on-hold/fail (chain stops on first problem), and the manual kill switch. Operator watches codex usage by hand for v1.

### Q9 — Operator control surface (arm / kill / resume) + flip safety

**Answer:** **Hard-stop kill (SIGTERMs the in-flight peer); existing GITS WS auth is sufficient to flip — no extra arming step in v1.**
**Notes:** **Arm** = cockpit "Autonomous" control on the existing Automode tab → one `updatePolicy` setting `mode:"autonomous"`, `killSwitchEnabled:false`, `requireApprovalForPeerSpawn:false`. Server-side **preconditions** (fail closed if unmet): repo ∈ `allowedRepos`, roadmap loaded (queued goals exist), integration branch resolvable, **confined-delamain path present**. **Kill switch** = hard stop: stop scheduling + SIGTERM the in-flight peer (via existing `killPeer`). **Resume** = after a hold/fail/`waiting` pause, operator resolves then a "Resume" action clears the pause → driver continues next tick. **Flip safety:** rely on GITS's existing WS auth (pairing token / tailnet) for solo operator; `updatePolicy` not separately gated. Blast radius bounded by kill switch + held-PR-only (no auto-merge) + sequential + confinement.

### Q5 — Review/merge gate: does v1 merge on its own; hold/fail chain behavior?

**Answer:** **`autoMergeOnVerifierPass` = OFF for v1** (every verifier-pass slice held as a ready PR, never auto-merged to main); **halt-on-hold/fail confirmed.**
**Notes:** Gates = reuse `GitsReviewPipeline` as-is (mechanical forbidden-path/verification → semantic `GitsCodexVerifierAdapter` → triage). The toggle thus does autonomous **implementation into held PRs**, never autonomous merge-to-main, for v1. `autoMergeOnVerifierPass` is a policy flag that can flip ON later once the verifier earns trust. A **flagged hold (uncertain/fail)** or terminal peer failure **halts the chain** (pause + Telegram + manual resume) — the autopilot's halt-on-failure, chosen over the parent's "triage-never-block" because v1 is sequential (can't route around a dependent slice). ⚠️ **Tension to resolve (→ Q6):** with auto-merge OFF, a _passing_ slice is "held, not merged" — so we must distinguish **pass-but-unmerged (advance the chain)** from **flagged-hold/fail (halt)**, and decide how unmerged-but-passed slices chain (integration branch vs stacked branches) so v1 can actually "continue" rather than stop after slice 0.

### Q10 — Scoping, target repo, and Motoko's role (PIVOTED)

**Answer:** **Motoko is the conducting brain — NOT decoupled.** (Original recommendation to run a mechanical driver decoupled from Motoko was rejected.) Plus the vision layer: tiered peer-question auto-answer (mini → 5.5), per-peer compact summaries to protect Motoko's context, an orchestration ledger, Delamain owns git mechanics, and Motoko orchestrating multiple peers.
**Notes:** Target repo / `allowedRepos` scoping still pending explicit confirm (likely `gitscode` self-hosting). The sequential-vs-parallel conflict (Q3 vs vision) is open. This expands v1 well beyond the original "advance a pre-planned roadmap" — much of the parent roadmap (#1 verifier, #2 ledger, #3 auto-answerer, #4 routing, #5 toggle) now converges into this one design. **A v1-vs-north-star boundary must be drawn** (the topic is "ship v1 for 1 repo").

### Q14 — Per-peer summary mechanism (Motoko context hygiene)

**Answer:** **Verifier-critic output is the per-peer summary, stored in the ledger.** No separate summarizer agent in v1.
**Notes:** The verifier already runs read-only over the diff vs the slice's acceptance criteria and emits `pass`/`fail`/`uncertain` + reasoning + "what it missed" — that IS "what was done + what issues." Augment with the peer's one-line done-note + `prUrl` from the `DelamainPeer` record. Motoko's per-peer footprint = `{slice id/title, verdict + reasons, key misses, PR link}` → **ledger**. Motoko **queries the ledger** for history, never holds transcripts; **rehydrates from the ledger on context reset**. A dedicated summarizer is a later add only if verifier output proves thin.

### Q13 — Tiered peer-question auto-answer

**Answer:** **Type-gate + difficulty-ladder, operator as terminal backstop.**
**Notes:** **Type-gate (parent #7):** answer autonomously only when **derivable from context AND non-scope-changing AND reversible**; a **scope/preference/judgment/irreversible** question skips the models → straight to operator (Telegram, one-tap, park peer) — prevents the model guessing intent = green-but-wrong. **Difficulty-ladder (for derivable questions):** **mini model** → if low-confidence → **`gpt-5.5`** → if still unresolved → **operator**. **Answerer context bundle:** {peer's question + slice acceptance criteria + project plan/brainstorm doc + read-only repo/diff peek}; runs **read-only** (like the verifier, immune to prompt-injection from the diff). "Has enough context" = model self-reports it can answer from that bundle. Operator is the terminal rung for both "too hard" and "not my call." Every auto-answer logged (ledger) so overrides are learnable (parent #7).

### Q16 — Target repo + v1 boundary

**Answer:** **Confirmed `gitscode` self-hosting; v1 line ratified as written** (see "v1 scope (RATIFIED)" above). North-star deferred items accepted.
**Notes:** Self-hosting closes the loop — the seed context is the prior grill-me doc + this one; blast radius is the operator's own repo. No further trimming requested; v1 = full loop, one project, sequential.

### Q12 — Context-sufficiency bar + grill modality

**Answer:** **Recommended accepted.** Bar = **"can Motoko draft a complete slice plan + per-slice acceptance criteria from available context (intent + repo + existing brainstorm/spec docs)?"** — gaps it can't fill become the grill questions. Planning = context-judgment = grilling (one unified activity); the finished plan's criteria are the verifier's input. **Modality = both:** interactive in the cockpit chat when present; **async-Telegram** fallback when away (a gap discovered unattended **parks that project** + pings the bot channel; operator replies whenever). One-question-at-a-time discipline, every answer checkpointed to the project's brainstorm doc (this very workflow, run by Motoko).
**Notes:** Elegant unification — no separate "do I understand?" heuristic; understanding = "I could write the whole plan." Criteria-authoring (the verifier's un-wired author side) is produced as a byproduct of Motoko's planning/grilling.

### Q15 — Granting Motoko dispatch authority vs the SOUL contract

**Answer:** **Recommended accepted.** Motoko still **proposes**; in `mode:"autonomous"` the **policy auto-approves** its proposals _within the envelope_ (confined peer + held PR to `gits`, never a merge); the approved **proposal becomes an AutomodeSupervisor goal** the `AutomodeDriver` dispatches. SOUL preserved — add a small **standing-approval clause** for autonomous mode, no rewrite. "Motoko never executes/lands" is intact (peers write in a jail; held PR; operator merges).
**Notes:** Architectural win — **merges the two parallel "pending work" representations** (Hermes proposal cards ↔ automode goals) into one pipeline: `Motoko proposal → (autonomous policy auto-approve) → goal → driver → confined peer`. The standing approval replaces the per-item human tap; consequential gates (merge-to-`gits`, destructive, scope-changing answers) stay human. **Hard prerequisite:** Hermes home (`~/.gits/hermes`) must be configured — Motoko is the brain now.

## Open flags

**Resolved during this session:** sequential-vs-parallel (Q11) · peer-question escalation rung + answerer context (Q13) · Motoko dispatch authority (Q15) · v1 boundary + target repo (Q16) · merge boundary (Delamain does slice→integration git mechanics; the integration→`gits` merge is the operator-gated boundary, autoMerge OFF — reconciles Q5/Q6/Q8 with "rely on Delamain to merge").

**Genuine remaining unknowns (for the implementation-planning pass):**

- [ ] **Per-project session isolation (v1):** `automode-state.json` is a single global file today (`<stateDir>/gits/`) — re-key per-repo/session so 2–4 projects can run independently. Do in v1 even though v1 runs one project (avoids a later rewrite).
- [ ] **Cross-session project registry (defer-ish):** Motoko's view of all active project sessions (status, current slice, integration branch, ledger, Telegram thread). Needed once >1 project; design the shape in v1.
- [ ] **Ledger schema:** SQLite `@effect/sql-sqlite-bun` (indexed, WAL) — what events/summaries it stores (per-slice verdict, peer Q&A, halts), and the query API Motoko uses to rehydrate without context bloat.
- [ ] **Hermes configuration:** close the `~/.gits/hermes` setup blocker (`.env`/`config.yaml`, Codex OAuth) — hard v1 prerequisite now that Motoko is the brain.
- [ ] **SOUL autonomous-mode clause:** exact wording of the "standing-approval in autonomous mode, within the held-PR envelope" addition to `SOUL.md` + `config.yaml.example` (`execution`/`delamain_execution` keys).
- [ ] **delamain H0b change:** the actual `delamain spawn` modification to launch its codex/cursor child through `gits-confine.sh --profile peer` while keeping `--yolo`.
- [ ] **Peer-prompt template:** reuse the autopilot's `peer-prompt.template` with `{{ACCEPTANCE_CRITERIA}}` injection (the "same bar" as the verifier) — port into GITS.
- [ ] **Criteria fallback:** when Motoko dispatches without a grill (context already sufficient), are criteria _authored_ or _derived-and-flagged-lower-confidence_? (parent #4 fallback).
- [ ] **Persistence/restart/done:** driver resumes from `automode-state.json` on server restart; in-flight peer re-attaches via `listPeers`; roadmap-complete → open the held `integration→gits` PR + Telegram "done."
- [ ] **PWA + web push** (parent open flag): the eventual replacement for Telegram — separate workstream.
