# GITS Agent Performance — Dev Notes

**Date:** 2026-07-18
**Author:** analysis run via Claude Code (Opus 4.8) + Fable audit subagent
**Scope:** Local Codex CLI session logs for two repos — `ai-sprite-studio` and `gitscode` — covering 2026-07-13 .. 2026-07-17.
**Purpose:** Understand token spend, session performance, and compaction behaviour of the Codex agent fleet, and derive orchestration/compaction design implications for the `delamain` project (pi → codex control plane).

---

## 1. Data source & method

Codex CLI writes one **rollout** file per session under:

```
~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl
```

97 rollout files total; **87 in scope** (matching `cwd` or `git.repository_url` for the two target repos). The rest were `delamain` smoke tests and are excluded.

Each line is a JSON object. Event types used:

| `type` | Payload of interest |
|---|---|
| `session_meta` | `cwd`, `git.{branch,repository_url,commit_hash}`, `thread_source`, `agent_nickname`, `id`, `session_id` |
| `event_msg` → `token_count` | `info.total_token_usage.{total_tokens,input_tokens,cached_input_tokens,output_tokens,reasoning_output_tokens}`, `rate_limits` |
| `response_item` | model turns (shell/apply_patch/function calls) — counted as "turns" |
| `compacted` | one per automatic context compaction |
| `turn_context` | model + effort per turn |

### Critical dedup caveat

`total_token_usage` is **cumulative within a thread lineage**, and Codex **forks** a thread on every compaction/continuation, writing a new rollout file that *replays the parent's cumulative counts*. Naively summing `total_tokens` across files triple-counts the long threads (e.g. main session `019f6fd1` appears in ~10 files each reporting ~130–148M).

Normalisation applied:

- **Main threads:** grouped by logical `session_id`; take the **max** cumulative usage across forks (a fork is a replay, not new spend).
- **Subagents** (`thread_source == "subagent"`): keyed by their own rollout `id`. A subagent carries the *parent's* `session_id`, but its token spend is **independent real work**, so it must be counted separately, not collapsed into the parent.

All figures below use this normalisation unless stated otherwise.

### Provenance note on model names

The rollouts tag `model_provider: "openai"` but **do not record** the `gpt-5.6 / sol / terra` labels. Those are the operator's naming:

- **gitscode = "Sol"**, gpt-5.6 @ max effort — ended ~476 commits ahead of upstream.
- **ai-sprite-studio = "Terra"**, gpt-5.6 @ max effort — ended ~20 changes ahead of upstream.

The session *structure* is consistent with that labelling (ai-sprite = heavy subagent fan-out; gitscode = long main-thread builds), but the mapping is operator-asserted, not proven from metadata.

---

## 2. Token spend

Two ways to read "tokens spent" — they point in **opposite directions**, so both are reported.

| Metric | ai-sprite (Terra) | gitscode (Sol) | Higher |
|---|---:|---:|:--|
| **Output tokens** | 1,643,285 | 1,387,371 | **Terra** |
| **Reasoning tokens** | 1,072,059 | 526,840 | **Terra (~2×)** |
| **Generated total (output + reasoning)** | **2,715,344** | 1,914,211 | **Terra +42%** |
| Raw total processed (incl. cache) | 363.8M | 557.0M | Sol |
| Cached-read (context replay) | 352.5M (98%) | 538.4M (97%) | Sol |
| Wall time (sum of lineages) | 24.4h | **100.0h** | Sol (~4×) |
| Turns (response items) | 12,297 | 15,132 | Sol |
| Session shape | 2 main + **24 subagents** | 18 main + 32 subagents | — |

### Interpretation

- **By model work generated** (output + reasoning — the tokens the model actually produced at max effort): **Terra burned more**, decisively. Its *reasoning* burn is ~2× Sol's. This matches the operator's felt experience.
- **By raw tokens processed**: Sol is higher (557M vs 364M) — but this is ~97% **cached context reads**, not generation. Sol simply ran ~4× longer wall-clock (individual threads of 23h and 34h) and re-read the same context repeatedly through many compactions.

### Efficiency per shipped change

Against the operator's change counts:

| Repo | Ahead of upstream | Output tokens | Output / change |
|---|---:|---:|---:|
| gitscode (Sol) | ~476 commits | 1.39M | **~2.9K / commit** |
| ai-sprite (Terra) | ~20 changes | 1.64M | **~82K / change (~28×)** |

Terra didn't just spend more in total — it spent **~28× more per unit of shipped change**. The structural reason is the session shape: ai-sprite fanned out a large **review/analysis swarm** (24 subagents: Tesla, James, Hypatia, Harvey, Hilbert on `review_05_sprite_engine_security`, etc.) which is reasoning-dense but commits little. gitscode was mostly long steady-build main threads producing many small commits cheaply.

### Heaviest individual sessions

**ai-sprite-studio (top subagents by generated work):**

| Session | Role | Total tok | Output | Reasoning | Wall | Turns |
|---|---|---:|---:|---:|---:|---:|
| 019f6fd1 | main (coordinator) | 148.3M | 275,487 | 143,807 | 699m | 4,202 |
| 019f7208 | James (sub) | 34.6M | 132,371 | 79,494 | 78m | 1,146 |
| 019f7176 | Erdos (sub) | 31.0M | 168,007 | 94,787 | 75m | 1,025 |
| 019f7118 | Hypatia (sub) | 21.9M | 129,957 | 72,945 | 50m | 794 |
| 019f71e8 | Harvey (sub) | 21.3M | 77,055 | 42,477 | 25m | 587 |
| 019f70db | Tesla (sub) | 21.2M | 157,945 | 90,855 | 63m | 766 |

**gitscode (top main threads):**

| Session | Total tok | Output | Reasoning | Wall | Turns |
|---|---:|---:|---:|---:|---:|
| 019f711a | 191.5M | 573,850 | 237,141 | 345m | 4,556 |
| 019f6569 | 113.1M | 128,130 | 22,844 | 433m | 2,282 |
| 019f66f8 | 62.0M | 185,869 | 94,380 | 1402m | 1,507 |
| 019f5da4 | 44.1M | 74,791 | 27,516 | 2065m | 1,098 |
| 019f5fe3 | 38.8M | 46,181 | 14,010 | 614m | 1,223 |

---

## 3. Compaction analysis

The operational worry was the number of compactions. The data shows compaction is **not a task-size problem at the leaves** — it is concentrated in the long-lived coordinator / main threads.

| Group | Files | Compactions | Files w/ compaction | Avg turns |
|---|---:|---:|---:|---:|
| gitscode **subagents** | 35 | **0** | 0 | 88 |
| ai-sprite **subagents** | 25 | 8 | 6 | 323 |
| gitscode **main / coordinator** | 20 | 26 | 6 | 737 |
| ai-sprite **main** | 11* | 48* | 10 | 506 |

\* The ai-sprite main "48 / 11 files" is **inflated by fork replay** — those 11 files are compaction-forks of the *same* logical session `019f6fd1`, each re-reporting its 5 compactions. The true figure is **~5 compactions on one coordinator lineage**, not 48.

### Top compacting sessions

| Repo | Kind | Compactions | Turns | Turns / compaction | Total tok |
|---|---|---:|---:|---:|---:|
| gitscode | main | 12 | 4,790 | ~399 | 201.3M |
| gitscode | main | 5 | 1,507 | ~301 | 62.0M |
| ai-sprite | main | 5 | 4,202 | ~840 | 148.3M |

### Key finding

**Where the work was already decomposed into subagents, compaction went to zero.** gitscode's 35 leaf tasks compacted **0 times** (avg 88 turns each — far under the ~258K-token context window). Decomposition already solved the leaf problem; "make the tasks smaller" targets the part that is already healthy.

Two *distinct* patterns produce the compactions actually observed — only one is a task-size issue:

1. **Monolithic worker** — gitscode `019f711a`: a single thread did the whole remote-localhost / secret-redaction feature inline — 4,790 turns, 12 compactions, ~400 turns between resets, 193M tokens. **This is the genuine "task too big" case,** and the correct fix is decomposition into subagents (exactly what delamain's fan-out provides).

2. **Coordinator overhead** — the ai-sprite main that spawned 25 subagents still compacted ~5× *despite* delegating, because it holds every subagent's returned output plus supervision chatter in its own context. **Smaller leaves do not move this** — the coordinator accumulates regardless of child size.

---

## 4. Implications for delamain orchestration (pi → codex)

The compaction lever is **not leaf task size** — it is **coordinator context lifetime and hand-back shape**. Concrete directions:

- **Structured hand-backs, not transcripts.** If the coordinator ingests each leaf's full log, N small leaves fill its window just as fast as one big task. Have leaves return a schema'd result (the `agent(prompt, {schema})` path already supports this) and keep raw logs on disk, out of the coordinator's window.
- **Keep coordinators short-lived.** The 12-compaction gitscode thread and the multi-hour mains compact because they *live* for hours. A coordinator that dispatches → collects summaries → exits will not hit the window. delamain's throwaway-worktree + `integrate:false` model already achieves this for children; the gap is the **parent**.
- **Don't let the coordinator also do heavy work inline.** That is what turned `019f711a` into a 193M-token monolith. Coordinators should coordinate; leaves should work.
- **Watch the reasoning-token cost of fan-out at max effort.** Terra's 24-subagent review swarm is what produced +42% generated tokens and ~2× the reasoning of Sol, at ~28× the per-change cost. Fan-out is the right tool for review/analysis breadth, but it is expensive; size the fleet to the task.

**Next investigation:** inspect how delamain's pi orchestration currently passes subagent results back to the parent — whether it threads full output or summaries into the coordinator's context. That is the single highest-leverage place to reduce coordinator compaction.

---

## 5. Security / anomaly audit (Fable, medium effort, read-only)

A narrow read-only sweep of the 87 in-scope rollouts. **Bottom line: nothing genuinely concerning** — no prompt injection, no real credentials leaked, no destructive or out-of-scope commands.

**Notable:**

- **[MEDIUM] Weekly Codex quota driven to 100% on 07-17.** 13 sessions — the ai-sprite subagent swarm plus the big gitscode session — show `used_percent: 100` on the weekly (10080-min) window, `plan_type: prolite`, `credits.balance: "0"`. `rate_limit_reached_type` stayed null (nothing hard-blocked), but the quota was fully consumed. **This is the direct consequence of Terra's burn** and explains any throttling felt afterward.

**Low / informational:**

- **[LOW]** gitscode `019f711a` — heaviest session on the box: 18MB rollout, 4,609 response items, 12 compactions, 193M cumulative tokens. Legitimate (remote-localhost / secret-redaction feature), just the single biggest quota consumer.
- **[LOW]** Pipe-to-shell + sudo in a gitscode session: `curl -fsSL …rtk…/install.sh | sh` and `sudo apt-get install -y gh` — operator's own RTK/gh tooling; flagged only because pipe-to-shell is inherently risky.
- **[LOW]** Localhost preview access key logged in plaintext: `curl 'http://localhost:63623/?key=1e012f21…'` — ephemeral, local-only, but now unredacted in the rollout file. (Ironic given those same sessions were building the redaction feature — worth having redaction scrub preview-key query params too.)
- **[INFO]** A few sessions (Russell subagent 019f614e; 019f66f8) end mid-turn; ~15 sessions contain `turn_aborted` events consistent with user interrupts. No crashes, no auth failures, no engine errors.

**Verified clean:**

- **Prompt injection:** clean. The one `exfiltrate` regex hit (019f711a) was the agent's *own* security analysis of cookie-exfiltration risk in dev-server previews — legitimate prose.
- **Secret exposure:** clean. All `Authorization: Bearer` matches are placeholders (`${token}`, `$OPENAI_API_KEY`). The `sk-ant-api03-…`, `ghp_…`, `github_pat_…` strings in 019f711a are fabricated test fixtures for the `redactSecrets` / `EventNdjsonLogger` tests. A 101-char `xoxb-` string (Boyle 019f719c) is a false positive — random bytes inside an encrypted reasoning blob.
- **Destructive commands:** clean. Both `rm -rf` hits target build/temp dirs (`build`, `*.egg-info`, `.tmp-gits-digest-persistence`). `git reset --hard` / `git branch -D` appear only as text inside a workflow doc that *prohibits* them. No force-push, no base64 decode pipes, no writes outside repos.
- **Scope:** clean. No out-of-scope workdirs. External network limited to api.github.com, pypi.org, raw.githubusercontent.com (setuptools source), an Excalidraw README link, and OAuth-discovery probes of `mcp.higgsfield.ai` — all consistent with the sprite-generation task.

---

## 6. Bottom line

1. **Terra (ai-sprite) out-burned Sol (gitscode) on generated tokens** (+42% overall, ~2× reasoning) and at ~28× the cost per shipped change — driven by a 24-subagent review swarm. Sol's larger *raw* token number is cache-read inflation from ~4× longer wall-clock, not more generation.
2. **Terra's swarm exhausted the weekly Codex quota** (100%, prolite, zero credits) on 07-17.
3. **Compaction is a coordinator problem, not a task-size problem.** Decomposed leaf tasks compacted 0 times; the compactions live in long-running coordinators and one monolithic worker. The delamain fix is coordinator context management (structured hand-backs, short-lived coordinators), not smaller leaf tasks.
4. **Security posture is clean.** One plaintext localhost preview key in a log is the only minor hygiene item; everything else is expected heavy agent development activity.

---

### Reproduction

Analysis scripts iterated over `~/.codex/sessions/**/*.jsonl` with `python3`, grouping by the normalisation in §1. Fable audit was a read-only subagent pass (`rg` + `python3` one-offs) over the same 87 files. No files were modified during analysis.
