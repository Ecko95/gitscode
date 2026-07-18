# Phase 1 kickoff — off-hours autonomy (written 2026-07-13, after phase 0 closed)

Phase 0 is **done and live**: Motoko runs autonomously on the netcup RS 2000 G12
VPS, healthy on-host, with the full phase-0 fix set merged to `gits`
(`c72f10203`). Its first production cycle ran end-to-end (proposal → approve →
bridge → confined delamain peer → verify floor → land → held PR) and shipped a
real, tested fix as PR #154. Phase-0 hardening merged tonight: #152 (auth
lifecycle, all-codex pins, dispatch-branch contract, jail bun bind), #154
(Motoko's own `runSchedule` fix), #156 (held-PR robustness).

The prompt below is the phase-1 handoff. Paste it into a fresh session (it is
self-contained; the `[[…]]` links resolve against this machine's memory). It
scopes phase 1 to the scheduler + arming lifecycle + episode-ID schema and
leaves the Telegram bot to phase 2, matching the build-phase split in
`docs/brainstorms/off-hours-autonomy.md`.

---

```
Create a new workspace and work on this with ultracode. Continue the off-hours
autonomy arc: phase 0 is DONE and closed (Motoko is live and healthy on the
netcup RS 2000 G12 VPS; gits tip has the full phase-0 fix set). Build PHASE 1:
the slot scheduler + arming state.

Read these first (they are the design of record and the phase-0 record):
- ~/dev/projects/gitscode/docs/brainstorms/off-hours-autonomy.md — the whole
  decision ledger. Phase 1 is bound by decisions 1, 6, 7, 8, 11, 20, and 23,
  plus the "Build phases" and the 2026-07-13 phase amendments.
- ~/dev/projects/gitscode/docs/sessions/2026-07-13-phase1-kickoff.md — this doc.
- Memory: [[motoko-first-run-2026-07-13]] (what phase 0 shipped + the two
  prereqs + the follow-up debt), [[off-hours-autonomy-design]] (build phases),
  [[orchestration-sweep-2026-07]] (steal anything-llm's scheduler shape),
  [[gits-headless-verify-harness]] (how to boot GITS headless + drive it via
  WS-RPC; the exit-test driver at apps/server/motoko-exit-driver.ts is untracked
  but reusable as a phase-1 arm/scheduler test harness).

Phase 0 substrate already merged and live (do NOT rebuild): Motoko proposal
cards + decideProposal, HermesAutomodeBridge (armed enqueue), AutomodeSupervisor
/ AutomodeDriver (dispatch gate -> confined delamain peer -> verify floor ->
land -> held PR), the decision-21 auth lifecycle, all-codex pins, the dispatch-
branch contract, and held-PR robustness. What does NOT exist yet and is phase 1:
any clock/scheduler, the arming lifecycle, and the episode-ID schema.

PHASE 1 deliverables (in-process in the GITS server — decision 1, no external
cron):
1. Slot scheduler: nightly 00:00–10:00 (two 5h slots) + Sat/Sun 10:00–15:00,
   TZ Europe/London (decision 6). Slots gate goal STARTS, not finishes: a
   running goal completes under its own runtime cap; no goal starts if its
   expected runtime exceeds the remaining slot (decision 7).
2. Arming state machine + lifecycle: nightly explicit arm/disarm; no arm = dark
   night. reArmOnBoot invariant is untouched — a VPS restart mid-night halts
   everything, notifies, and waits (decision 8). Arming is cockpit/RPC-driven in
   phase 1; the Telegram surface that drives it is phase 2 — do NOT build the
   bot.
3. Episode ID from day one (decision 23): a single episode ID threaded through
   proposal cards, briefs, delamain peer records, verifier verdicts, and PRs.
   Pin it into the scheduler schema now — it is explicitly not retrofittable.
4. Capacity-based pause (decision 20): scheduler pauses new goal starts when
   the codex 5h-window utilization crosses ~50% (GitsCapacityMonitor already
   meters both windows — verify and wire, don't rebuild).
5. Resource envelope enforcement (decision 11): sequential (maxActivePeers 1),
   ≤3 goals/night, ~90-min runtime cap per goal, capacity check before each
   start.

Fold in FIRST (phase-0 prereqs for autonomy to actually run a real night):
- Ensure the VPS gits-cockpit systemd service env sets
  GITS_CONFINE_BIN=/srv/gits/repos/gitscode/scripts/gits-confine.sh and that
  bwrap is installed — the automode verify jail needs both.
- Widen the automode verify floor beyond `bun run test` to match the repo's
  required CI (Format/Lint/Typecheck/Build) so a peer can't pass autonomy's gate
  yet produce a PR that fails merge CI (this bit the exit test on #154).
Also address the smaller phase-0 debt from [[motoko-first-run-2026-07-13]] where
it's cheap: proposal titles inherit hermes' "max iterations" warning line;
no resumeDriver RPC (driver halt is terminal); uncancelled runtime-deadline
timer fires on completed goals; AUTOMODE_BASE_REF="gits" hardcode breaks the
multi-repo pilots.

Discipline (unchanged from phase 0): non-peer code changes go through fable
subagents with a spec-review + quality-review loop (Workflow orchestration).
Branch off origin/gits, PR base gits; wait for CI (Format needs oxfmt; the
wsTransport resubscribe test is a known flake — rerun once before digging).
gh always --repo Ecko95/gitscode (the default-repo gotcha resolves to
joshuaduffill/t3code). oxfmt on changed paths only, never repo-wide writes;
fresh package-local tsgo (turbo caches go stale). Verify end-to-end with a
headless GITS boot + the WS-RPC driver, not just unit tests.

CAUTION: ~/dev/projects/delamain stays on a2a-state-race-lock (plus unpushed
local main) — never touch it; the live delamain binary builds from
~/dev/projects/delamain-main (fetch -> checkout --detach origin/main -> npm ci
-> npm run build). delamain sweep only ever --dry-run first. The Pi spike is
cancelled — never open a PR for spike/pi-continuous-brain.

Do NOT start phase 2 (Telegram bot) or beyond — stop when the scheduler + arming
lifecycle + episode-ID schema are shipped and proven end-to-end (arm a slot,
watch a goal start/skip on the slot edge, confirm reArmOnBoot on a simulated
restart). Report with PR links and test counts.
```
