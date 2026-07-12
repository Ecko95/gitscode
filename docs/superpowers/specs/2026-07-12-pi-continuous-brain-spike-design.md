# Pi Continuous Brain — Autonomy Spike (Design)

**Date:** 2026-07-12
**Branch:** `spike/pi-continuous-brain` (off `origin/gits`)
**Status:** Design — pending user review
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
  **Open item (verify during planning):** if Pi can act as an **MCP client**, point
  it at the existing `delamain-peers` MCP server and the bridge is ~zero glue;
  otherwise thin CLI shells over the `delamain` binary. Either way there is **no
  forked sub-agent extension** — delamain already *is* the interactive-sub-agent
  layer (the video's 3rd extension is replaced by this bridge).
- **`ping_human` tool** — Telegram escape hatch, reusing the existing bot channel.
- **Restriction knob** ("quadriplegic mode" from the video) — default for the spike:
  disable *write/edit* on the brain so it must delegate code, keep read/inspect.
  Tunable full-quadriplegic ↔ off (the video found both extremes flawed).
- **Control arm** — the existing off-hours autopilot / `AutomodeDriver` (PR #145)
  pointed at the **same goal, same peers, same held-PR pipeline**. Near-zero new
  code: the control is "run what already exists."

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
first). Scorecard is mostly **objective because the gits semantic verifier already
grades quality** (rc0 = useful work landed, rc2 = held):

| Metric | Source |
|---|---|
| Slices landed / held-PRs passing verifier (rc0) | gits episode ledger + verifier gate |
| Cost (brain $ + peer $ + memory $) | codex / OpenRouter logs |
| Coherence / on-task | sampled qualitative + (Ph2) observation accuracy |
| Horizon to derail | operator log |

The verifier rc0/rc2 signal means "useful work landed" is measured automatically, not
hand-graded — this is the scorecard backbone.

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
- `GOAL.md` — the shared task (candidate: "research, build, continuously improve a
  persistent agent harness" — recursive self-improvement, scoped to verifiable slices)
- `README.md` — protocol, how to run, kill-switch

**Runnable check that proves the spike ran:** `score.ts` emitting the comparison table.

## Open items to resolve during planning

1. Can Pi act as an MCP client to `delamain-peers`? (Decides bridge cost.)
2. `GOAL.md` phrasing — scoped enough that verifier gate can grade landed slices.
3. Budget ceiling per arm ($ and/or hours).
4. Where the brain runs (VPS systemd-run scope vs local Docker) for the spike.
