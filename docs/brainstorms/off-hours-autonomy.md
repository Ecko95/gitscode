# Off-Hours Autonomy (multi-repo, slot-scheduled) — Brainstorm

> Status: **ratified** · Last updated: 2026-07-13 (addendum: all-codex consolidation, review surface, auth lifecycle)
> Parents: `docs/brainstorms/autonomous-toggle.md` (v1 loop, single repo) and `docs/brainstorms/self-improving-orchestration.md`.
> This doc extends the ratified v1 loop with: a clock (slot scheduler), multi-repo execution, and phone-first approval. Produced by a full grill interview 2026-07-12.

## Problem

The operator's supervision windows are narrow (17:00–20:00, 22:00–00:00 Europe/London). The hours 00:00–10:00 nightly and 10:00–15:00 on weekends are structurally idle — no supervision possible, machine capacity unused, provider rate windows recovering. Meanwhile Motoko can already generate proposal cards and automode can already execute approved work fail-closed. What is missing is the connective tissue: ideas surfaced to the operator's phone in the evening, one-tap informed consent, and a scheduler that runs the approved queue during the idle slots so review-ready held PRs are waiting by morning.

## Operator rhythm (design input)

| Window      | Weekday     | Weekend     | Role                           |
| ----------- | ----------- | ----------- | ------------------------------ |
| 00:00–05:00 | idle        | idle        | autonomy slot 1                |
| 05:00–10:00 | idle        | idle        | autonomy slot 2                |
| 10:00–15:00 | human       | idle        | autonomy slot 3 (Sat/Sun only) |
| 17:00–20:00 | supervision | supervision | human work                     |
| 22:00–00:00 | supervision | supervision | digest review + arming         |

All times Europe/London — the VPS must pin this TZ explicitly.

## Decision ledger (ratified 2026-07-12)

| #   | Decision                 | Choice                                                                                                                                                                                                                         |
| --- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Host                     | Inside the GITS server on the 24/7 Linux VPS (no external cron; in-process scheduler)                                                                                                                                          |
| 2   | V1 repos                 | `gitscode` + pilots `delamain`, `isomer-calc-engine`; registry schema per-repo from day one                                                                                                                                    |
| 3   | Channel                  | Telegram bot (long-polling, allowlisted chat ID) for digest/approval/arming **and** existing web-push, both from day one                                                                                                       |
| 4   | Idea inputs              | Structured sources only: per-repo `TODO.md` / `.planning/` / docs backlogs, recent git history, automode episode ledger, `GitsUsageReader` quantitative stats. Semantic transcript mining = v2                                 |
| 5   | Approval unit            | Concrete brief only — target repo, scoped task, verify plan, budget estimate, expected deliverable. Nothing vaguer may reach Telegram; Motoko finishes planning before it may ask                                              |
| 6   | Slots                    | Nightly 00:00–10:00 (two 5h slots) + Sat/Sun 10:00–15:00                                                                                                                                                                       |
| 7   | Slot edge                | Slots gate **starts**, not finishes: running goal completes under its own runtime cap; no goal starts if expected runtime exceeds remaining slot                                                                               |
| 8   | Arming                   | Nightly explicit arm: the 22:00 digest asks "N briefs queued — run tonight? [Arm] [Skip]". No tap = dark night. `reArmOnBoot` invariant untouched — a VPS restart mid-night halts everything, notifies, waits                  |
| 9   | Self-improvement track   | Ordinary proposals whose target repo is gitscode (incl. Motoko's own profile/skills). Same pipeline, no separate meta-loop                                                                                                     |
| 10  | Failure semantics        | Goal-level failure → quarantine (branch kept, verdict recorded, flagged in morning report), queue continues. Only systemic failures halt the night: delamain unreachable, repo corrupt, budget/capacity exhausted, kill switch |
| 11  | Resource envelope        | Sequential (`maxActivePeers: 1`), ≤3 goals/night, ~90 min runtime cap per goal, capacity check before each start (skip if Codex window utilization already high)                                                               |
| 12  | Phone-approvable classes | `worktree-spawn` briefs only. `repo-write`, `integrate`, `destructive-shell` cards remain cockpit-only                                                                                                                         |
| 13  | Verification floor       | Repo eligible only with a verify command set that includes a real test run, green on the base branch at slot start. Red baseline → repo skipped for the night (failures must be attributable)                                  |
| 14  | PR shape                 | One held PR **per goal**, targeting the repo's own default branch. Human-merge only, autoMerge OFF (unchanged invariant)                                                                                                       |
| 15  | Staleness                | Approved briefs expire after 7 days unrun (resurface for re-approval); cheap re-validation at goal start (referenced context must still exist) else quarantine. Stale held PRs flagged in digest; **no autonomous rebases**    |
| 16  | Bot capability ceiling   | Approve / Reject / Defer / Arm / Skip / STOP only. Policy and config (budget caps, goal caps, registry, allowlists, schedule) are immutable from Telegram — cockpit-only                                                       |
| 17  | Peer OS caps             | Peer spawns wrapped in `systemd-run --user --scope` with `MemoryMax` (~4G) and `CPUWeight` below the GITS server, so a runaway peer OOMs alone and the kill switch survives                                                    |

## Standing defaults

- Digest at 22:00 daily; morning report at 10:00 (landed PRs, verdicts, quarantined goals, capacity spent).
- Digest capped at ~5 cards; rejected/quarantined cards are remembered and not re-surfaced.
- Peers: codex engine, confined-yolo, spawned from latest `origin/<default>` (existing `spawnPeer` behavior).
- Per-repo registry is **server-owned** (userdata) — the scheduler runs headless and cannot depend on a connected client for the project list. Fields: path, base branch, verify commands, PR target. (Distinct from the shelved machine-registry backlog item.)
- `STOP` reply to the bot flips the kill switch and kills the running peer.

## Accepted gaps

- **Peer spend is not dollar-metered** (`docs/gits/HERMES.md` — Delamain/Codex-CLI spend invisible to `AutomodeUsageMeter`). V1 controls cost via goal count + runtime caps + capacity checks; real metering is v1.5.
- **Semantic transcript mining** (reading Claude/Codex session transcripts to infer pain points) is v2. V1 usage input is quantitative only.

## Build phases (each independently shippable)

0. **VPS provisioning** — repo clones (×3), delamain binary, codex/claude credentials, TZ pinned Europe/London, systemd lingering for user scopes. Pilots brought up to the verification floor.
1. **Slot scheduler + arming state** — in-process scheduler in the GITS server; nightly arm/disarm lifecycle honoring `reArmOnBoot`.
2. **Telegram bot** — long-polling, allowlisted, six verbs, config-immutable. Digest + morning report rendering. _Implementation note:_ the Hermes runtime may provide a native Telegram channel (`profiles/motoko-gits/config.yaml.example` → `notify_channel: telegram`); resolve build-vs-reuse at phase start.
3. **Repo registry + multi-repo automode** — per-repo verify commands, base branches, PR targets; `allowedRepos` driven from the registry.
4. **Driver changes** — one held PR per goal (open at goal completion, not queue drain); quarantine-and-continue; slot-runway start gate; systemd scope wrapping.
5. **Ideation run** — scheduled `inspectGitsAndPropose`-style pass over the structured sources + usage stats, emitting `worktree-spawn` briefs into the digest queue.

## Existing substrate (verified 2026-07-12)

Already built and reused as-is: Motoko proposal cards + `decideProposal` (`HermesCliAdapter`), approved-proposal→automode bridge (`HermesAutomodeBridge`, opt-in), fail-closed `AutomodeSupervisor`/`AutomodeDriver` (verifier gate → land → held PR), delamain worktree isolation (confined-yolo), web-push stack, `GitsUsageReader` (cross-project Claude/Codex usage), `AutomodeEpisodeLedger`. Not existing today (the gaps this design fills): any clock/scheduler, Telegram code, usage→ideas pipeline, per-repo execution config.

## Addendum (2026-07-13) — all-codex consolidation, review surface, auth lifecycle

Context for these decisions: headless Claude (`claude -p` / Agent SDK) is now billed outside the operator's subscription, so every autonomous token must come from the codex/OpenAI pool; Claude stays available for **human-driven** sessions only. Consequently the Pi continuous-brain spike is cancelled and Motoko/Hermes is the sole automation brain. Decisions 18–24 extend the ratified ledger.

| #   | Decision             | Choice                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 18  | Brain                | Motoko/Hermes on the GITS codex provider, exclusively. The Pi continuous-brain spike (`spike/pi-continuous-brain`) is **cancelled** — no PR will be opened; the branch is retained read-only for its baseline data (`AUTONOMY_EFFICIENCY.md`, spike spec). What transfers from the spike analysis: the ≤$6.75/slice supervisor-efficiency ceiling now applies to Motoko's own loop; window-reserve budgeting (19–20); review decorrelation (24); the codex auth lifecycle (21)                                                                                                                                                           |
| 19  | Provider split       | Autonomy is all-codex. Claude = human-driven sessions only (evening digest review, PR follow-ups via "send to chat") — never instantiated headlessly by automode, verifier, or Hermes threads. Phase 0 gains an audit for stray headless Claude-provider instantiations; each one found is pinned to codex or disabled                                                                                                                                                                                                                                                                                                                   |
| 20  | Budgeting            | The codex weekly reserve is sized from daytime need **down** ("never leave less than X% of the weekly window for interactive use"), not from slot length up. The scheduler pauses new goal starts when 5h-window utilization crosses ~50% (`GitsCapacityMonitor` meters both windows)                                                                                                                                                                                                                                                                                                                                                    |
| 21  | Codex auth lifecycle | One dedicated codex home per consumer (interactive, Hermes, delamain peers), single-writer refresh per token chain — the delamain `refresh_token_reused` lesson. Hermes re-reads auth at spawn time (no startup snapshot) and auto-refreshes expired access tokens (delegated to codex app-server if it already owns refresh for that home). Chain death (revocation, long-idle expiry, reuse race) is not automatable: Telegram alert + re-login via the Motoko-tab console (22). On the VPS every home is authenticated on-host; token chains are never copied between hosts                                                           |
| 22  | Motoko-tab console   | Cockpit terminal on the Motoko tab for interactive re-auth and VPS one-time logins. `destructive-shell` class ⇒ cockpit-only per decision 12, never phone-approvable                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 23  | Review surface       | New cockpit section listing autonomy episodes end-to-end (proposal → approval → slot/night → brief → peer → verifier verdict → PR → merge state) plus quarantined goals and per-night budget spent — the morning report, materialized. Read-only by design: **no merge button**. "Send to chat" opens the repo's project in a chat session with the operator's provider of choice and the PR context injected; merges and follow-ups happen there, human-driven. Requires an **episode ID** threaded through proposal cards, briefs, delamain peer records, verifier verdicts, and PRs — pinned into the phase-1 schema, not retrofitted |
| 24  | Review decorrelation | LLM review threads run a different gpt-5.x tier/effort than the authoring peer (e.g. peers gpt-5.5/high, review gpt-5.6-terra) with adversarial refute-style prompts. The deterministic verify floor (decision 13) remains the primary gate. Cursor engine is the optional cross-vendor lane if that subscription exists                                                                                                                                                                                                                                                                                                                 |

### Phase amendments (2026-07-13)

- **Phase 0 (amended)** — add: fix Hermes codex auth per decision 21 (dedicated home, spawn-time re-read, auto-refresh; the 2026-07-13 `missing access_token` failure is the provider-config error that has kept Motoko from ever completing a run) and prove **one full proposal cycle end-to-end** before anything else builds on it. Add: the decision-19 headless-Claude audit. Claude credentials drop out of the VPS provisioning list.
- **Phase 1 (amended)** — the episode ID (decision 23) is part of the scheduler schema from day one.
- **Phase 2 (amended)** — the bot adds the chain-death alert (decision 21).
- **Phase 6 (new) — autonomy review surface** — the decision-23 section, with Telegram digest/morning-report deep-links. Off the critical path: GitHub review is the fallback until it ships.
