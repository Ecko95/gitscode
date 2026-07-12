# TODO

## Live browser supervision — 2026-07-12

- [x] Add thread-isolated `gsd-browser` MCP sessions for Codex, Claude, and Cursor.
- [x] Add authenticated same-origin HTTP/WebSocket preview relay for local and Tailnet access.
- [x] Add responsive chat preview UI with pause, resume, step, abort, takeover, and release controls.
- [x] Add an editable URL bar that navigates the chat session's supervised browser.
- [x] Instruct every provider to verify local dev-server URLs and use the supervised browser session.
- [x] Reset the URL bar to the active chat terminal's deterministic localhost port.
- [x] Add a per-chat Browser mode that sends composer text directly to `gsd-browser`.
- [x] Add a Browser Supervision action that launches `npm run dev` in a chat-scoped terminal.
- [x] Discover the launched localhost listener automatically and expose browser console output.
- [x] Recreate the Browser dev terminal in the active session project/worktree before launch.
- [x] Add header, `/browser`, and configurable `browser.toggle` command surfaces.
- [x] Stop the isolated browser daemon when its chat is archived.
- [ ] Add OpenCode dynamic MCP registration once its shared server exposes per-session MCP configuration.

Current status: implementation complete and verified with focused tests, formatting, lint, typecheck, and a live `gsd-browser` cold-start smoke.

Notes: `gsd-browser` is optional. Missing binaries or browsers surface as a recoverable panel error and do not block normal chat sessions.

## Session log — 2026-07-12 (full system audit remediation planned)

- [x] Convert `docs/audits/2026-07-11-full-system-audit.md` into an ordered remediation plan
- [ ] Browser stabilization: deterministic bootstrap, WebGL fixture, keyboard readiness, request-order latch
- [ ] Socket expiry, scoped provider streams, bounded queues, and assistant projection coalescing
- [ ] Bundle split, Android text buffer benchmark, dependency remediation, dead-code CI report, benchmark history

Plan: `docs/superpowers/plans/2026-07-12-full-system-audit-remediation.md`. Start Task 1 and Task 2 independently; Task 3 precedes Tasks 4–5. Android changes wait for SDK/emulator tooling and dead-file deletion waits for reference/owner confirmation.

## Session log — 2026-07-11 (full system audit in progress)

Branch `audit/full-system-2026-07-11`, rebased onto `origin/gits` at `5ca9d3a7b`.

- [x] Create a clean audit branch from the current integration tip
- [x] Capture formatting, lint, typecheck, build, and full-test baselines
- [x] Audit server, web, desktop/mobile, security, reliability, and complexity surfaces
- [x] Fix confirmed auto-fixable findings with focused regression checks
- [x] Run repeatable performance benchmarks and document the environment
- [x] Publish the full audit, benchmark results, residual risks, and improvement backlog

Fixed so far: F-SEC-01 dependency advisories, F-DATA-01 destructive worktree reaping,
F-PERF-01 diagnostics amplification, F-DATA-02 desktop registry overwrite, F-SEC-02 iOS
transport policy, F-SEC-03 auth-access disclosure, F-DATA-03 cross-environment errors,
F-REL-01 subscription cleanup, F-SEC-04 active-session revocation, F-SEC-05 private
attachment caching, F-REL-02 sequence-gap handling, F-REL-03 startup event ordering,
F-PERF-02 detail-cache disposal, F-PERF-03 terminal buffer disposal, F-TEST-01 benchmark
integrity, F-TEST-02 backpressure assertions, and F-DATA-04 serialized registry mutation.

Notes: benchmark runs must be isolated from parallel audit processes; use `bun run test`, never `bun test`.

## Session log — 2026-07-10 (A2A + hardening shipped to `gits`)

`origin/gits` @ `da97a62fe`. All work below is **merged into `gits`**; no open PRs.

- [x] **A2A peer messaging (#142)** — R3 surfacing + residuals (R#1 kill-switch guard / R#3 default `fromPeerId:"motoko"`) + R5 cross-provider context replay (per-thread watermark) + E2 (advance watermark only after `sendTurn` succeeds) + self-heal (clear stale `r5PeerId` on inbox failure) + cockpit kill-switch indicator. Consolidated in `docs/gits/A2A.md`.
- [x] **Flaky-poll test hardening (#143)** — `waitFor` busy-spin → real `setTimeout`, 2s→15s timeout (ProviderCommandReactor + ProviderSessionReaper + CursorAdapter); `VcsStatusBroadcaster` subscribe-before-publish race fixed deterministically.
- [x] **Semantic merge fix** — gits #139 made empty-allowlist = **deny**, which would block every repo-less Motoko peer-send. `evaluatePolicyGate` now skips repo/model/budget for `kind:"send"` (a message isn't a repo/cost op); kill-switch / manual-mode / destructive-content still gate. See `AutomodeSupervisor.ts` (`resourceScoped`).
- [x] Docs shipped: `docs/gits/openai-latest-model-integration-handoff.md` + this TODO's OpenAI section.
- Note: **#141** (codex `0.144` schema regen + `DEFAULT_MODEL = gpt-5.6-sol` + `max`/`ultra` effort labels) already in `gits` from the prior batch — see the OpenAI section below; the handoff doc still says `gpt-5.5`, reconcile when promoting the default.

### Worktrees (state as of 2026-07-10)

**Merged → safe to prune** (`git worktree remove <path>` + `git branch -D <branch>`):

| Worktree                                                  | Branch                             | Merged as        |
| --------------------------------------------------------- | ---------------------------------- | ---------------- |
| `gitscode` _(main — keep the worktree, on merged branch)_ | `a2a-r3-gits-surfacing`            | #142 (squash)    |
| `gitscode-harden-polls`                                   | `test/harden-flaky-poll-timeouts`  | #143 (squash)    |
| `gitscode-134-login-shell`                                | `feat/login-shell-env-propagation` | merged (0 ahead) |
| `gitscode-135-auto-mode`                                  | `feat/claude-auto-permission-mode` | merged (0 ahead) |
| `gitscode-automode-optin`                                 | `feat/automode-explicit-optin`     | #139 (0 ahead)   |
| `gitscode-codex-schema`                                   | `feat/codex-0144-schema-regen`     | #141 (0 ahead)   |

**Active — in progress, do NOT prune:**

| Worktree                        | Branch                          | Ahead/behind | Note                                                                                                                        |
| ------------------------------- | ------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `automated-browser-integration` | `automated-browser-integration` | 0 / 2        | in-progress work; branched off old `gits` tip, clean — `git -C … merge origin/gits` (or rebase) to refresh onto `da97a62fe` |

**Unmerged — decide keep/continue/drop** (all lack open PRs; counts = commits ahead / behind `gits`):

| Worktree                | Branch                     | Ahead/behind | Note                                                 |
| ----------------------- | -------------------------- | ------------ | ---------------------------------------------------- |
| `gitscode-headless`     | `feat/gits-headless`       | 6 / 287      | headless verify harness (very stale)                 |
| `gitscode-audit-events` | `feat/audit-events`        | 1 / 72       | audit-backlog spike (stale)                          |
| `gitscode-resume-cmd`   | `feat/copy-resume-command` | 1 / 65       | copy-resume-command (stale)                          |
| `gitscode-visual-plan`  | `feat/visual-plan`         | 1514 / 1823  | separate lineage (#30 track), not off current `gits` |
| `gitscode-3b`           | `gits`                     | 0 / 25       | spare `gits` checkout — just `git pull` to refresh   |

> To continue on `gits`: branch fresh off `origin/gits` (local `main` is orphaned), one issue = one worktree = one PR, PR base = `gits`, pass `--repo Ecko95/gitscode` on every `gh` call. Verify locally with forced `turbo run typecheck` + targeted `vitest` + repo-wide `oxfmt --check` before pushing (CI's Format step is repo-wide).

## OpenAI model integration (2026-07-10)

- [x] Document the `gpt-5.5` Codex app-server/schema update path in `docs/gits/openai-latest-model-integration-handoff.md`
- [ ] Update the pinned Codex app-server protocol, verify runtime `model/list`, then promote `gpt-5.5` to the Codex default

## Audit backlog (2026-07-06 — `docs/audits/2026-07-06-full-audit.md`)

- [x] 5 HIGH server bugs fixed (shared-worktree deletion, rebuild sentinel, git-shim PATH, stream-freeze resubscribe, snapshot/live double-append)
- [ ] Server MEDs: attachment delete inside txn (S6), commands on deleted threads (S7), rebuild WAL guard (S8), HTTP dispatch startup gate (S9), unbounded PTY stream buffers (S12)
- [ ] Web HIGH cluster: cross-thread bleed (composer/optimistic/undo, W3–W5), Enter-while-running (W6 → becomes queueing), settings hydration wipe (W7), dead recovery coordinator (W1)
- [ ] Security hardening: narrow `/etc` bind in verify profile; rlimits around confine call sites (egress = existing H0c)
- [ ] Notifications (title badge → web push → Electron) — biggest GUI gap
- [ ] Conductor-inspired: Checks pane on verifier pipeline, diff-line comments → agent, contextual next-action buttons

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
