# TODO

## Small things

- [ ] Submitting new messages should scroll to bottom
- [ ] Only show last 10 threads for a given project
- [ ] Thread archiving
- [ ] New projects should go on top
- [ ] Projects should be sorted by latest thread update

## Bigger things

- [ ] Queueing messages

## Self-improving orchestration (design: `docs/gits/ORCHESTRATION_SELF_IMPROVEMENT_DESIGN.md`)

- [x] Map current orchestration (Delamain / autopilot / Automode / Motoko)
- [x] Research: Augment Code (Intent + Cosmos), mem0, self-improving patterns, Claude SDK accelerators
- [x] Research: shared OSS multi-agent memory → **Basic Memory** primary, **Graphiti** upgrade
- [x] Design decided: config above AutomodePolicy; smart=rank+auto-defer; shared memory via one HTTP MCP server
- [x] Code-review + prior-art + context graph (`docs/gits/graphify-out/`): validated (empty-quadrant); 42 review + 22 red-team findings → hardened (D1–D7, R1–R9, H0–H9)
- [x] H0 spike + impl: `scripts/gits-confine.sh` (verify/peer) + `scripts/confined-verify.sh`; 14/14 checks (`docs/gits/H0_CONFINEMENT.md`)
  - [x] H0a: wired into autopilot `supervisor.py` (`run_gate`/`confine_script`, backward-compatible, validated) + GITS-side `GitsVerificationGate` adapter (server-wired, 4/4 tests)
  - [ ] H0b: confine peer spawn (`--profile peer --cred …`, drop `--yolo`/`--force-trust`) via delamain
    - **REFRAME** (autonomous-toggle design, `docs/brainstorms/autonomous-toggle.md` Q7/Q8): for the **trusted assigned repo** (the v1 target), **KEEP `--yolo`** — the bubblewrap jail (worktree-only + single cred, every other secret invisible) is what makes yolo safe. The "drop `--yolo`/`--force-trust`" wording applies only to **untrusted** repos. So v1's H0b = **confine the spawn (route `delamain spawn`'s child through `gits-confine.sh --profile peer`) rather than dropping yolo**. H0b is now a v1 prerequisite (see item 5 above).
  - [ ] H0c: peer egress allowlist — install `passt`/`pasta` (absent), then `--egress proxy=` enforcing model-API+memory-proxy only

### Re-sequenced after `/grill-me` (2026-06-06) — see `docs/brainstorms/self-improving-orchestration.md` + DESIGN §"Revision 2"

Pain = green-but-wrong PRs (quality) + cost/babysitting. Codex-only peers; avoid Claude Agent SDK; Motoko = persona+conductor; memory descoped to a SQLite ledger; cost = codex rate-limits (reserve 20% weekly); target surface = GITS Android PWA + web push.

- [~] **1. Verifier-critic (top priority):** acceptance-criteria-per-slice plumbing + fresh read-only **codex** verifier after the H0 gate → triage `pass`/`fail`/`uncertain` → auto-merge vs hold-for-review (`gpt-5.4-mini`/high → `gpt-5.5` when uncertain)
  - [x] Contracts + parser/store: `packages/contracts/src/gits.ts` (GitsSliceCriteria/Verify\*), `GitsSliceCriteria.ts` (`parseSliceCriteria`/`renderSliceCriteria`) + `GitsSliceCriteriaStore` (PR #2)
  - [x] Verifier-critic adapter: `GitsCodexVerifierAdapter.ts` — fresh read-only codex (`~/.codex`, prompt via stdin, `--skip-git-repo-check`); `recommend()` triage; escalate 5.4-mini→5.5 (PR #1/#4, live-smoked)
  - [x] Review pipeline (mechanical gate → semantic verifier → triage): `GitsReviewPipeline.ts` (PR #3); launch-layer leak fixed in `server.ts` so `bin.ts` typechecks
  - [x] Autopilot wiring (read side): `apps/server/src/gits/bin/verify.ts` CLI (PR #5) + skill `supervisor.py` Gate 3 (`semantic_verify_script`/`run_semantic_verify`), live integration-smoked
  - [ ] **Author side (open — needs decision):** nothing writes per-slice `<slice_id>.md`, so with `semantic_verify:true` every slice holds. Wire criteria authoring (handoffs → `slice_criteria_dir`) + inject `{{ACCEPTANCE_CRITERIA}}` into peer prompt (the design's "same bar"); and make a hold _not_ freeze the whole chain (design = "triage, never block; advance on independent slices"). See brainstorm Open flag Q11.
- [ ] 2. Episode ledger (SQLite, `@effect/sql-sqlite-bun`, indexed+WAL) + reflections; codex 5h/weekly usage visibility in cockpit + 80%-weekly auto-spawn throttle
- [ ] 3. Peer-question auto-answerer (derivable+non-scope-changing+reversible → auto; else one-tap escalate; notified-passive; logged)
- [ ] 4. Reflection → codex model-tier routing + prompt tuning, as operator-gated cards
- [ ] **5. Fully-agentic toggle (= `AutomodePolicy.mode` autonomous), guardrails intact** — designed in detail: `docs/brainstorms/autonomous-toggle.md`. v1 = the full Motoko loop, **one repo** (`gitscode` self-hosting via `AutomodePolicy.allowedRepos`), **sequential**:
  - [ ] **Hermes config (prerequisite):** configure the managed home `~/.gits/hermes` (`.env`/`config.yaml`, Codex OAuth) — hard v1 blocker now that Motoko is the brain (today unconfigured → "setup-required" branch)
  - [ ] **Motoko dispatch via standing-approval (proposal→goal):** add the SOUL standing-approval clause + `config.yaml.example` `execution`/`delamain_execution` keys so `mode:"autonomous"` auto-approves Motoko's proposals _within the held-PR envelope_; wire approved proposal → `AutomodeSupervisor` goal (merges Hermes proposal-cards ↔ automode-goals into one pipeline). Motoko still never lands.
  - [ ] **Context-gate + grill (planning = criteria authoring):** Motoko drafts the slice plan + per-slice acceptance criteria from context; gaps it can't fill → grill-me Q&A (interactive cockpit + async-Telegram fallback parks the project + pings the bot) → writes brainstorm/spec + `slices/<id>.md` criteria (closes the verifier author-side gap of #1)
  - [ ] **Server-side `AutomodeDriver` (new layer):** Effect `Schedule`/`forkDaemon` fiber, **sequential** within a repo, reuses `AutomodeSupervisor` queue/gates/kill-switch/persistence; ports autopilot mechanics (forbidden-path diff, patch-id merge detection). Poll-tick `listPeers` → map `PeerStatus` → goal transitions (net-new `running→completed/failed`)
  - [ ] **Confined-yolo peer via modified `delamain` (H0b prerequisite):** modify `delamain spawn` to launch its codex/cursor child through `scripts/gits-confine.sh --profile peer` (worktree-only + single cred, all other secrets invisible) **keeping `--yolo`** — the jail is what makes yolo safe (see H0b note above). Egress unfiltered = accepted v1 residual risk (trusted repo); `--egress` allowlist (H0c) deferred.
  - [ ] **Held PR → `gits` (autoMerge OFF) + halt/kill/resume:** one integration branch `auto/<roadmap-id>` off `origin/gits`; verifier-pass slices land onto it (chain-advance); roadmap end → one held PR `auto/<roadmap-id> → gits` + Telegram. `autoMergeOnVerifierPass` OFF. Halt-on-hold/fail (pause + Telegram + manual resume), hard-stop kill (SIGTERM in-flight peer via `killPeer`). `main` never touched.
  - [ ] **Verifier-as-summary → per-project SQLite ledger:** reuse the #1 verifier output (`pass`/`fail`/`uncertain` + reasons + "what it missed") AS the per-peer summary (+ done-note + `prUrl`); store `{slice id/title, verdict + reasons, key misses, PR link}` in the per-project episode ledger (#2). Motoko reads the **ledger, never transcripts**; rehydrates from it on context reset.
  - [ ] **Tiered peer-question auto-answer:** type-gate (derivable + non-scope-changing + reversible → auto; scope/preference/judgment/irreversible → operator) + difficulty-ladder (mini model → `gpt-5.5`) with the **operator as terminal backstop** via the existing GITS/Motoko/Hermes Telegram bot channel. Answerer runs read-only over {question + criteria + plan doc + diff peek}; every auto-answer logged to the ledger.
  - [ ] **Per-project session-state keying:** re-key `automode-state.json` (today a single global file at `<stateDir>/gits/`) per-repo/session so 2–4 projects can run independently later — do in v1 (one project) to avoid a rewrite. Cross-session project registry: design the shape now, build when >1 project.
  - [ ] _Server plumbing note:_ there is **zero Telegram code in the server today** — v1 needs a small `TelegramNotifier` adapter (bot token + chat_id from config) for event/escalation posts.
  - **Deferred (north-star):** 2–4 concurrent projects · codex-weekly 80% cost throttle (#2) · H0c egress allowlist · autoMerge-ON · L3 autonomous decomposition · dedicated summarizer · PWA/web-push.
- [ ] (parallel) GITS PWA + web push (manifest, service worker, push backend) — replaces Telegram for held-PR/escalation notifications
- [ ] (deferred) earlier design's editable 3-tier OrchestratorConfig + canary executor — fold in _after_ the verifier/ledger prove value; memory shared-store + MCP-proxy DROPPED (descope)
