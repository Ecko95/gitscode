# Pi Continuous Brain — Autonomy Spike (Design)

**Date:** 2026-07-12
**Branch:** `spike/pi-continuous-brain` (off `origin/gits`)
**Status:** Design — baseline measured + protocol hardened 2026-07-12; pending user review
**Type:** Throwaway comparison spike (Approach B, staged)

## Goal

Test the "true agent autonomy" thesis (single never-ending session + observational
memory, per the *True Agent Autonomy* video) against the existing **heartbeat**
autonomy system (off-hours slot scheduler + Motoko-as-brain driver, PR #145 / the
autonomous toggle). Answer one question cheaply before committing to any production
integration:

> Does a single never-ending Pi session, driving real delamain peers, stay coherent
> and land useful work over a long horizon — better or worse than the heartbeat model?

This is a **spike**, not production. Code lives under `spikes/pi-continuous-brain/`
and is expected to be deleted or rewritten once the question is answered.

## Baseline measurement (2026-07-12)

Measured before building anything, from real logs (peer-codex-home rollouts, delamain
state + archive, all Claude project transcripts), window 2026-05-12 → 2026-07-10,
priced at notional API rates (both sides actually run on subscriptions — the *ratio*
is the signal, not the dollars):

| Side | Volume | Notional $ | Share |
|---|---|---|---|
| Peers (349 codex sessions, gpt-5.4/5.5) | 1.11B input (95% cached), 6.5M output | ~$268 | 12–18% |
| Supervisor, delamain-driving Claude sessions (36) | 1.29B cache-read, 35M cache-write, 5.0M output | ~$1,262 | 82% |
| Supervisor, all Claude sessions (89) | 1.92B cache-read, 7.9M output | ~$1,962 | 88% |

- **Supervision dominates spend (82–88%)** — the efficiency question is legitimate,
  not settled in heartbeat's favor a priori. Caveat: supervisor sessions also do
  design/coding, so $1,262 is an *upper bound* on supervision-attributable cost.
- **Cache reads are 2/3 of supervisor cost** (1.29B tokens ≈ $647). That is the
  long-context loop tax — exactly the component Pi's ownable compaction targets.
  This *strengthens* the Phase 2 hypothesis.
- **Slices:** 187 peer branches pushed; delamain records merge-shas for only 2
  (merges happen out-of-band via PRs), so **"pushed" is the slice proxy**.
  Per pushed slice: peer ≈ $1.43, supervisor ≤ $6.75 (upper bound).
- **Output volume is symmetric** (~5M tokens each side); the cost gap is entirely
  Claude per-token pricing × cache-read volume.
- **The heartbeat control arm has no production history** — Motoko/hermes has never
  run (empty sessions dir; first proposal card is a provider-config error) and the
  automode episode ledger is empty. The spike's control arm produces the first real
  heartbeat-supervisor cost number; the manual baseline above is the ceiling both
  arms must beat.

**Headline metric for the whole spike: supervisor tokens (and notional $) per rc0
slice landed.** Manual baseline ceiling: ≤$6.75/slice.

## Why Pi (given the peer-kill)

Pi was killed as a *peer* engine on 2026-07-04 (`.plans/25-pi-engine-delamain.md`) —
its codex provider is OAuth-only with no billing win over plain `codex exec`. That
verdict does **not** apply to the *brain*. The brain needs exactly Pi's unique wins,
already documented in that same assessment:

- **Own the compaction algorithm** → required for observational memory (Phase 2).
- **Own the toolset** + `registerTool` for structured WAITING → the autonomy loop.

Prior art: `@mariozechner/pi-coding-agent` (~8.4k lines, SDK/in-process).

## Staged plan (Approach B — decouple the two variables)

The video confounds two variables: *never resets* AND *observational memory*. This
spike separates them.

- **Phase 1 — continuous loop only.** Pi brain with Pi's **default** compaction (no
  observational memory), delegating to delamain peers, vs the heartbeat control on
  the same goal. Answers the load-bearing cheap question: *does the never-ending
  session even hold together driving real peers?*
- **Phase 2 — gated.** Only if Phase 1 holds: port observational memory as a Pi
  compaction extension and re-measure. Detailed design deferred (see §Phase 2).

## Architecture (Phase 1)

```
┌─ Pi brain (never-ends) ──────────────────┐
│  @mariozechner/pi-coding-agent           │
│  codex provider · HOME=peer-pi-home      │      spawn/status/integrate/reply
│  ext: autonomy-loop                      │ ───────────────────────────►  delamain peer
│  tools: delamain_* · ping_human          │      (confined codex, worktree-isolated)
└──────────────────────────────────────────┘                                    │
                                                                held PR → gits verifier gate
                                                                (rc0 land / rc2 hold)
```

### Components

- **Pi brain** — one standalone Pi session, codex model (config knob; video used GLM
  for cost). Auth-isolated `HOME=~/.delamain/peer-pi-home`. Runs **confined** on the
  VPS (systemd-run scope + `MemoryMax`, or Docker) — it is `--yolo`.
- **autonomy-loop extension** (~50 lines) — intercept turn-end, re-inject "you are
  autonomous, continue," never exit. `/goal` command persists the goal at the top of
  context. Port/rebuild of the video's trivial extension. **Phase-1 core.**
- **delamain bridge** — Pi tools `delamain_spawn / _status / _integrate / _reply`.
  **Phase-1 blocker (resolve first in planning):** if Pi can act as an **MCP
  client**, point it at the existing `delamain-peers` MCP server and the bridge is
  ~zero glue — and `wait_for_peer` / `spawn_peer_and_wait` also solves the waiting
  problem below. Otherwise thin CLI shells over the `delamain` binary **plus an
  explicit blocking-wait tool**. Either way there is **no forked sub-agent
  extension** — delamain already *is* the interactive-sub-agent layer (the video's
  3rd extension is replaced by this bridge).
- **Waiting mechanism (required, not optional)** — peers take 60–90 min; a brain
  that idle-spins "continue" turns while waiting burns tokens and floods its own
  context with status noise, poisoning the very compaction this spike evaluates.
  The autonomy-loop must block on a peer-wait tool (MCP `wait_for_peer`, or a CLI
  poll-with-timeout wrapper), not re-inject turns on a timer.
- **`ping_human` tool** — Telegram escape hatch, reusing the existing bot channel.
- **Restriction knob** ("quadriplegic mode" from the video) — default for the spike:
  disable *write/edit* on the brain so it must delegate code, keep read/inspect.
  Tunable full-quadriplegic ↔ off (the video found both extremes flawed).
- **Control arm** — **current automode as-built** (`AutomodeDriver` + supervisor,
  cockpit-armed, gitscode-scoped), pointed at the same goal, same peers. Note: PR
  #145's slot scheduler/Telegram arming is a *design doc*, phases unbuilt — the
  control is what exists today, which also constrains the spike goal to gitscode.
  Near-zero new code, but two protocol requirements below (approval parity,
  arm-invariant scoring) do need thin glue.

## Data flow (Phase 1)

`/goal → brain reasons → delamain_spawn(brief) → confined codex peer (worktree) →
poll delamain_status → done+pushed → held PR → gits verifier gate (rc0 land / rc2
hold) → result observed back into brain context (naive compaction) → autonomy-loop
re-injects → continue`.

## Error handling & safety

- **Peer fails / verifier holds (rc2)** → brain decides retry / reframe / skip
  (mirrors manual steering); `ping_human` backstop.
- **Brain derails ("sicko mode")** → operator STOP kill-switch (existing hard-stop) +
  hard budget cap that auto-halts the brain.
- **Cost runaway** → `$` ceiling per arm (the video hit ~$50/day); brain halts at cap.
- **Auth race** → brain concurrency 1 (single session anyway); peers keep their own
  codex home (`peer-codex-home`).
- **Sandbox** → brain runs confined (systemd-run/Docker); peers already bwrap-confined
  (worktree-only, single cred).

## Comparison protocol & metrics

Both arms run the **same `GOAL.md`** for a **fixed budget** (24h or `$X`, whichever
first). Four protocol invariants make the comparison interpretable:

1. **Arm-invariant scoring.** Both arms' slices are graded by the *same* verifier
   pipeline. The control gets rc0/rc2 from the automode path; the treatment brain
   bypasses automode, so the spike must invoke the same gate explicitly per slice
   (repo CLI `verify.ts`, or a thin automode-gate call). If the arms are graded by
   different pipelines, the scorecard is fiction.
2. **Approval parity.** What exists today is human-gated (proposals wait for
   approval, arming is explicit). For the spike's duration both arms run
   auto-approve, kill-switch only — otherwise a 24h unattended run measures
   autonomy *policy*, not brain *architecture*.
3. **Metered brain provider.** The codex OAuth path bills in rate-limit windows,
   not dollars — a "$ ceiling per arm" is neither enforceable nor cleanly
   measurable on it. Run the brain on a metered key (OpenRouter GLM, as the video
   did) for clean cost numbers; peers stay on codex OAuth in both arms (identical,
   cancels out).
4. **Phase 1 is a smoke test, not a verdict.** One 24h run per arm at n=1 goal —
   a single flaky peer can decide it. Findings are directional; re-run before
   believing a close result.

| Metric | Source |
|---|---|
| **Supervisor tokens / notional $ per rc0 slice (HEADLINE)** | Pi session file vs GITS provider-thread costs; baseline ceiling ≤$6.75/slice |
| Slices landed / held-PRs passing verifier (rc0) | verifier gate (same pipeline both arms) + episode ledger |
| Cost (brain $ + peer $ + memory $) | OpenRouter logs (brain) / codex logs (peers) |
| Coherence / on-task | sampled qualitative + (Ph2) observation accuracy |
| Horizon to derail (incl. brain crash = derail event) | operator log |

The verifier rc0/rc2 signal means "useful work landed" is measured automatically,
not hand-graded. Note what each phase can actually answer: **Phase 1 runs Pi's
*default* compaction, so it does NOT test "Pi context management is better"** — it
answers "does the loop survive real peers, and at what cost delta." The context-
management claim is only tested by Phase 2's observational memory. Expect the
treatment to cost *more* per slice in Phase 1; that delta is the price tag Phase 2's
memory has to justify. Structurally the heartbeat cannot lose on cost (it pays only
at ticks; state lives in the ledger) — the continuous brain must win on
quality-per-dollar.

## Phase 2 (gated — observational memory)

Built only if Phase 1 holds. Port Memristor-style observational memory as a Pi
**compaction** extension: 10k-token chunks → observer sub-agents distill →
observation pool → at threshold, consolidate oldest observations into per-topic
markdown files (long-term memory), index at top of the compaction block
(short-term = observation pool; working = compaction tail). Re-run the comparison
protocol. Detailed design deferred until Phase 1 proves the loop survives real peers.

## Footprint (throwaway — `spikes/pi-continuous-brain/`)

- `extensions/autonomy-loop.ts` — never-finish-turn + `/goal`
- `extensions/delamain-tools.ts` — spawn/status/integrate/reply/ping_human (or MCP wiring)
- `run-treatment.sh` / `run-control.sh` — launch each arm on the goal
- `score.ts` — read episode ledger + verifier outcomes + cost logs → comparison table
- `GOAL.md` — the shared task. **Not** open-ended self-improvement ("research,
  build, continuously improve X" is unfalsifiable — when the brain wanders you can't
  tell whether continuous sessions derail or the goal was ungradeable, re-adding the
  confound this spike exists to remove). Use a boring goal with a known backlog:
  N items from the 2026-07-06 gitscode audit backlog / TODO.md, each independently
  verifiable, so derailment is attributable to the brain.
- `README.md` — protocol, how to run, kill-switch

**Runnable check that proves the spike ran:** `score.ts` emitting the comparison table.

## Open items to resolve during planning

1. Can Pi act as an MCP client to `delamain-peers`? (Decides bridge cost AND the
   waiting mechanism — Phase-1 blocker.)
2. `GOAL.md` item selection from the audit backlog — each item verifier-gradeable.
3. Budget ceiling per arm ($ and/or hours) — enforceable only with the metered
   brain provider (protocol invariant 3).
4. Where the brain runs (VPS systemd-run scope vs local Docker) for the spike.
5. Pi codex-provider OAuth refresh mid-session: a never-ending session is the worst
   case for the known `refresh_token_reused` hazard — verify refresh works during a
   long-lived session, and decide upfront that a brain crash/restart counts as a
   derailment event (context reset kills the thesis silently otherwise). Moot for
   the brain itself if it runs on the metered provider; still applies to peers'
   codex homes.
