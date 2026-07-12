# Autonomy Efficiency: Supervision Cost Baseline & Architecture Comparison

This doc records the efficiency baseline of the current supervision model — what it
actually costs Claude to drive delamain peers today — and the protocol for comparing
that model against a candidate replacement architecture (continuous brain) before any
production commitment is made. It exists so the "is Pi worth it" question is answered
with measured numbers instead of vibes, and so a future re-run of the comparison has a
reproducible baseline to beat.

## The two architectures

### Heartbeat (design of record)

Slot-scheduled automode, per PR #145 and `docs/brainstorms/off-hours-autonomy.md`
(ratified 2026-07-12). A scheduler wakes during idle windows (nightly 00:00–10:00,
weekend 10:00–15:00 Europe/London), runs an approved queue of concrete briefs through
the existing fail-closed `AutomodeSupervisor`/`AutomodeDriver`, and goes back to
sleep. State lives externally in the automode episode ledger and per-repo registry —
the brain (Motoko/Hermes) is invoked only to ideate proposal cards and at slot
boundaries. It pays for reasoning only at ticks, not continuously.

### Continuous brain (spike candidate)

A single never-ending Pi session (`@mariozechner/pi-coding-agent`) that never resets:
an autonomy-loop extension re-injects "continue" at turn end instead of exiting, and
state lives in living context rather than an external ledger. The brain reasons,
spawns/polls/integrates delamain peers directly, and — in Phase 2 — owns its own
compaction algorithm to build observational memory instead of relying on default
context truncation. See
`docs/superpowers/specs/2026-07-12-pi-continuous-brain-spike-design.md` for the full
design.

### Comparison

| | Heartbeat | Continuous brain |
|---|---|---|
| Session lifetime | Slot-scheduled, wakes/sleeps | Never-ending |
| State | External (episode ledger, registry) | Living context (+ Phase 2 observational memory) |
| Brain cost model | Pays only at ticks | Pays continuously, incl. idle-wait risk |
| Compaction | N/A (stateless between ticks) | Default (Ph1) → ownable (Ph2) |
| Production status | Designed, unbuilt (no run history) | Spike, throwaway (`spikes/pi-continuous-brain/`) |
| Structural cost floor | Cannot lose on cost | Must win on quality-per-dollar to justify the delta |

## Baseline methodology (2026-07-12)

Measured before building anything, so the comparison has a real number to beat rather
than an assumption.

- **Data sources:** peer-codex-home codex rollout logs (including legacy
  `~/.codex-peers` worktree cwds — peer sessions live in two homes, see below),
  delamain `state.json` + `state.archive.json`, and all `~/.claude/projects`
  transcripts.
- **Window:** 2026-05-12 → 2026-07-10.
- **Pricing:** notional API-rate pricing on both sides. Both peers and supervisor
  actually run on subscriptions, not metered API keys — the dollar figures are not
  real spend. The *ratio* between sides is the signal, not the absolute dollars.
- **Supervision attribution:** delamain-driving Claude sessions are identified by
  matching `tool_use` lines, not a substring search — see pitfalls below.
- **Slice proxy:** delamain records merge-shas for only 2 of 187 pushed peer
  branches (merges happen out-of-band via PRs, invisible to delamain's own state), so
  **"pushed" stands in for "landed slice."**

## Baseline results

| Side | Volume | Notional $ | Share |
|---|---|---|---|
| Peers (349 codex sessions, gpt-5.4/5.5) | 1.11B input (95% cached), 6.5M output | ~$268 | 12–18% |
| Supervisor, delamain-driving Claude sessions (36) | 1.29B cache-read, 35M cache-write, 5.0M output | ~$1,262 | 82% |
| Supervisor, all Claude sessions (89) | 1.92B cache-read, 7.9M output | ~$1,962 | 88% |

- **Supervision dominates spend (82–88%)** of the measured window. $1,262 is an
  *upper bound* on supervision-attributable cost — supervisor sessions also do
  design/coding work, not pure supervision.
- **Per pushed slice:** peer ≈ $1.43, supervisor ≤ $6.75 (upper bound, same caveat).
- **Output volume is symmetric** — roughly 5M tokens on each side. The entire cost
  gap is Claude per-token pricing applied to cache-read volume, not a difference in
  work produced.
- **Cache reads are ~2/3 of supervisor cost** (1.29B tokens ≈ $647) — the
  long-context loop tax of re-reading accumulated context every turn.
- **The heartbeat arm has no production cost history.** Motoko/hermes has never run
  (empty sessions dir; first proposal card is a provider-config error) and the
  automode episode ledger is empty. This baseline is a manual-supervision ceiling,
  not a heartbeat number — the spike's control arm will produce the first real one.

## What the numbers mean

Supervision, not peer execution, is where the money goes — so the efficiency question
this spike asks is real, not settled in heartbeat's favor a priori. The dominant cost
component (cache reads, the long-context loop tax) is exactly what Pi's ownable
compaction targets in Phase 2, which strengthens rather than undercuts the case for
building it. At the same time, the heartbeat architecture structurally cannot lose on
cost — it pays only at scheduled ticks and keeps no standing context to re-read — so a
continuous brain can only justify itself by winning on quality-per-dollar, not on raw
spend. The headline metric for the whole spike is therefore **supervisor tokens (and
notional $) per rc0 slice landed**, with the manual baseline ceiling — ≤$6.75/slice —
as the number both arms must beat.

## Comparison protocol summary

Both arms run the same `GOAL.md` under a fixed budget. Four invariants make the
result interpretable rather than an artifact of protocol drift:

1. **Arm-invariant scoring** — both arms' slices are graded by the same verifier
   pipeline (rc0/rc2), not by different gates for control vs. treatment.
2. **Approval parity** — both arms run auto-approve, kill-switch only, for the
   spike's duration. Today's system is human-gated; measuring a 24h unattended run
   against a gated one would compare autonomy *policy*, not brain *architecture*.
3. **Metered brain provider** — the codex OAuth path bills in rate-limit windows,
   not dollars, so a "$ ceiling per arm" isn't enforceable on it. The brain runs on a
   metered key for clean cost numbers; peers stay on codex OAuth in both arms
   (identical, cancels out).
4. **Phase 1 is a smoke test, not a verdict** — one 24h run per arm at n=1 goal. A
   single flaky peer can decide it; findings are directional.

What each phase can answer: **Phase 1 runs Pi's default compaction**, so it tests
only whether the never-ending loop survives driving real peers and what the cost
delta is — it does *not* test whether Pi's context management is better. Only
**Phase 2's observational memory** tests the context-management claim. Expect Phase 1
treatment cost to exceed the control; that delta is the price tag Phase 2 has to
justify.

## Reproducing the baseline

The measurement is a ~150-line log-crunching script: it reads peer rollout
`token_count` events, dedupes Claude JSONL usage fields by message id, and applies
per-model API pricing. Known silent pitfalls, found the hard way:

- **Peer sessions live in two homes.** `~/.delamain/peer-codex-home/sessions` holds
  current peers; legacy `~/.codex-peers` worktree cwds hold older ones. Scanning only
  one home undercounts.
- **Substring-matching `"delamain"` over-matches.** MCP tool names appear in every
  system-reminder, so a naive substring search flags nearly every session as
  delamain-driving. Match `tool_use` lines specifically instead.
- **`prUrl` is always null in delamain state** — it is not a usable signal for
  merge/landing status; that's why "pushed" is the slice proxy instead.

## Related documents

- `docs/brainstorms/off-hours-autonomy.md` — heartbeat design of record (PR #145).
- `docs/superpowers/specs/2026-07-12-pi-continuous-brain-spike-design.md` — the
  continuous-brain spike this baseline was measured for.
- `docs/brainstorms/autonomous-toggle.md` — the v1 single-repo autonomy loop that
  the heartbeat design extends.
- `docs/gits/HERMES.md` — the Motoko/Hermes integration the heartbeat brain runs on.
