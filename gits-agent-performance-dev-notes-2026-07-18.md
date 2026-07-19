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

| `type`                      | Payload of interest                                                                                                           |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `session_meta`              | `cwd`, `git.{branch,repository_url,commit_hash}`, `thread_source`, `agent_nickname`, `id`, `session_id`                       |
| `event_msg` → `token_count` | `info.total_token_usage.{total_tokens,input_tokens,cached_input_tokens,output_tokens,reasoning_output_tokens}`, `rate_limits` |
| `response_item`             | model turns (shell/apply_patch/function calls) — counted as "turns"                                                           |
| `compacted`                 | one per automatic context compaction                                                                                          |
| `turn_context`              | model + effort per turn                                                                                                       |

### Critical dedup caveat

`total_token_usage` is **cumulative within a thread lineage**, and Codex **forks** a thread on every compaction/continuation, writing a new rollout file that _replays the parent's cumulative counts_. Naively summing `total_tokens` across files triple-counts the long threads (e.g. main session `019f6fd1` appears in ~10 files each reporting ~130–148M).

Normalisation applied:

- **Main threads:** grouped by logical `session_id`; take the **max** cumulative usage across forks (a fork is a replay, not new spend).
- **Subagents** (`thread_source == "subagent"`): keyed by their own rollout `id`. A subagent carries the _parent's_ `session_id`, but its token spend is **independent real work**, so it must be counted separately, not collapsed into the parent.

All figures below use this normalisation unless stated otherwise.

### Provenance note on model names

The rollouts tag `model_provider: "openai"` but **do not record** the `gpt-5.6 / sol / terra` labels. Those are the operator's naming:

- **gitscode = "Sol"**, gpt-5.6 @ max effort — ended ~476 commits ahead of upstream.
- **ai-sprite-studio = "Terra"**, gpt-5.6 @ max effort — ended ~20 changes ahead of upstream.

The session _structure_ is consistent with that labelling (ai-sprite = heavy subagent fan-out; gitscode = long main-thread builds), but the mapping is operator-asserted, not proven from metadata.

---

## 2. Token spend

Two ways to read "tokens spent" — they point in **opposite directions**, so both are reported.

| Metric                                   |         ai-sprite (Terra) |         gitscode (Sol) | Higher          |
| ---------------------------------------- | ------------------------: | ---------------------: | :-------------- |
| **Output tokens**                        |                 1,643,285 |              1,387,371 | **Terra**       |
| **Reasoning tokens**                     |                 1,072,059 |                526,840 | **Terra (~2×)** |
| **Generated total (output + reasoning)** |             **2,715,344** |              1,914,211 | **Terra +42%**  |
| Raw total processed (incl. cache)        |                    363.8M |                 557.0M | Sol             |
| Cached-read (context replay)             |              352.5M (98%) |           538.4M (97%) | Sol             |
| Wall time (sum of lineages)              |                     24.4h |             **100.0h** | Sol (~4×)       |
| Turns (response items)                   |                    12,297 |                 15,132 | Sol             |
| Session shape                            | 2 main + **24 subagents** | 18 main + 32 subagents | —               |

### Interpretation

- **By model work generated** (output + reasoning — the tokens the model actually produced at max effort): **Terra burned more**, decisively. Its _reasoning_ burn is ~2× Sol's. This matches the operator's felt experience.
- **By raw tokens processed**: Sol is higher (557M vs 364M) — but this is ~97% **cached context reads**, not generation. Sol simply ran ~4× longer wall-clock (individual threads of 23h and 34h) and re-read the same context repeatedly through many compactions.

### Efficiency per shipped change

Against the operator's change counts:

| Repo              | Ahead of upstream | Output tokens |          Output / change |
| ----------------- | ----------------: | ------------: | -----------------------: |
| gitscode (Sol)    |      ~476 commits |         1.39M |       **~2.9K / commit** |
| ai-sprite (Terra) |       ~20 changes |         1.64M | **~82K / change (~28×)** |

Terra didn't just spend more in total — it spent **~28× more per unit of shipped change**. The structural reason is the session shape: ai-sprite fanned out a large **review/analysis swarm** (24 subagents: Tesla, James, Hypatia, Harvey, Hilbert on `review_05_sprite_engine_security`, etc.) which is reasoning-dense but commits little. gitscode was mostly long steady-build main threads producing many small commits cheaply.

### Heaviest individual sessions

**ai-sprite-studio (top subagents by generated work):**

| Session  | Role               | Total tok |  Output | Reasoning | Wall | Turns |
| -------- | ------------------ | --------: | ------: | --------: | ---: | ----: |
| 019f6fd1 | main (coordinator) |    148.3M | 275,487 |   143,807 | 699m | 4,202 |
| 019f7208 | James (sub)        |     34.6M | 132,371 |    79,494 |  78m | 1,146 |
| 019f7176 | Erdos (sub)        |     31.0M | 168,007 |    94,787 |  75m | 1,025 |
| 019f7118 | Hypatia (sub)      |     21.9M | 129,957 |    72,945 |  50m |   794 |
| 019f71e8 | Harvey (sub)       |     21.3M |  77,055 |    42,477 |  25m |   587 |
| 019f70db | Tesla (sub)        |     21.2M | 157,945 |    90,855 |  63m |   766 |

**gitscode (top main threads):**

| Session  | Total tok |  Output | Reasoning |  Wall | Turns |
| -------- | --------: | ------: | --------: | ----: | ----: |
| 019f711a |    191.5M | 573,850 |   237,141 |  345m | 4,556 |
| 019f6569 |    113.1M | 128,130 |    22,844 |  433m | 2,282 |
| 019f66f8 |     62.0M | 185,869 |    94,380 | 1402m | 1,507 |
| 019f5da4 |     44.1M |  74,791 |    27,516 | 2065m | 1,098 |
| 019f5fe3 |     38.8M |  46,181 |    14,010 |  614m | 1,223 |

---

## 3. Compaction analysis

The operational worry was the number of compactions. The data shows compaction is **not a task-size problem at the leaves** — it is concentrated in the long-lived coordinator / main threads.

| Group                           | Files | Compactions | Files w/ compaction | Avg turns |
| ------------------------------- | ----: | ----------: | ------------------: | --------: |
| gitscode **subagents**          |    35 |       **0** |                   0 |        88 |
| ai-sprite **subagents**         |    25 |           8 |                   6 |       323 |
| gitscode **main / coordinator** |    20 |          26 |                   6 |       737 |
| ai-sprite **main**              |  11\* |        48\* |                  10 |       506 |

\* The ai-sprite main "48 / 11 files" is **inflated by fork replay** — those 11 files are compaction-forks of the _same_ logical session `019f6fd1`, each re-reporting its 5 compactions. The true figure is **~5 compactions on one coordinator lineage**, not 48.

### Top compacting sessions

| Repo      | Kind | Compactions | Turns | Turns / compaction | Total tok |
| --------- | ---- | ----------: | ----: | -----------------: | --------: |
| gitscode  | main |          12 | 4,790 |               ~399 |    201.3M |
| gitscode  | main |           5 | 1,507 |               ~301 |     62.0M |
| ai-sprite | main |           5 | 4,202 |               ~840 |    148.3M |

### Key finding

**Where the work was already decomposed into subagents, compaction went to zero.** gitscode's 35 leaf tasks compacted **0 times** (avg 88 turns each — far under the ~258K-token context window). Decomposition already solved the leaf problem; "make the tasks smaller" targets the part that is already healthy.

Two _distinct_ patterns produce the compactions actually observed — only one is a task-size issue:

1. **Monolithic worker** — gitscode `019f711a`: a single thread did the whole remote-localhost / secret-redaction feature inline — 4,790 turns, 12 compactions, ~400 turns between resets, 193M tokens. **This is the genuine "task too big" case,** and the correct fix is decomposition into subagents (exactly what delamain's fan-out provides).

2. **Coordinator overhead** — the ai-sprite main that spawned 25 subagents still compacted ~5× _despite_ delegating, because it holds every subagent's returned output plus supervision chatter in its own context. **Smaller leaves do not move this** — the coordinator accumulates regardless of child size.

---

## 4. Implications for delamain orchestration (pi → codex)

The compaction lever is **not leaf task size** — it is **coordinator context lifetime and hand-back shape**. Concrete directions:

- **Structured hand-backs, not transcripts.** If the coordinator ingests each leaf's full log, N small leaves fill its window just as fast as one big task. Have leaves return a schema'd result (the `agent(prompt, {schema})` path already supports this) and keep raw logs on disk, out of the coordinator's window.
- **Keep coordinators short-lived.** The 12-compaction gitscode thread and the multi-hour mains compact because they _live_ for hours. A coordinator that dispatches → collects summaries → exits will not hit the window. delamain's throwaway-worktree + `integrate:false` model already achieves this for children; the gap is the **parent**.
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

- **Prompt injection:** clean. The one `exfiltrate` regex hit (019f711a) was the agent's _own_ security analysis of cookie-exfiltration risk in dev-server previews — legitimate prose.
- **Secret exposure:** clean. All `Authorization: Bearer` matches are placeholders (`${token}`, `$OPENAI_API_KEY`). The `sk-ant-api03-…`, `ghp_…`, `github_pat_…` strings in 019f711a are fabricated test fixtures for the `redactSecrets` / `EventNdjsonLogger` tests. A 101-char `xoxb-` string (Boyle 019f719c) is a false positive — random bytes inside an encrypted reasoning blob.
- **Destructive commands:** clean. Both `rm -rf` hits target build/temp dirs (`build`, `*.egg-info`, `.tmp-gits-digest-persistence`). `git reset --hard` / `git branch -D` appear only as text inside a workflow doc that _prohibits_ them. No force-push, no base64 decode pipes, no writes outside repos.
- **Scope:** clean. No out-of-scope workdirs. External network limited to api.github.com, pypi.org, raw.githubusercontent.com (setuptools source), an Excalidraw README link, and OAuth-discovery probes of `mcp.higgsfield.ai` — all consistent with the sprite-generation task.

---

## 6. Bottom line

1. **Terra (ai-sprite) out-burned Sol (gitscode) on generated tokens** (+42% overall, ~2× reasoning) and at ~28× the cost per shipped change — driven by a 24-subagent review swarm. Sol's larger _raw_ token number is cache-read inflation from ~4× longer wall-clock, not more generation.
2. **Terra's swarm exhausted the weekly Codex quota** (100%, prolite, zero credits) on 07-17.
3. **Compaction is a coordinator problem, not a task-size problem.** Decomposed leaf tasks compacted 0 times; the compactions live in long-running coordinators and one monolithic worker. The delamain fix is coordinator context management (structured hand-backs, short-lived coordinators), not smaller leaf tasks.
4. **Security posture is clean.** One plaintext localhost preview key in a log is the only minor hygiene item; everything else is expected heavy agent development activity.

---

### Reproduction

Analysis scripts iterated over `~/.codex/sessions/**/*.jsonl` with `python3`, grouping by the normalisation in §1. Fable audit was a read-only subagent pass (`rg` + `python3` one-offs) over the same 87 files. No files were modified during analysis.

---

## 7. External research — how engineers solve the coordinator-context problem

Four parallel research agents (Sonnet) swept primary sources — vendor engineering blogs, framework docs, and arXiv — on context compaction, orchestrator context management, task-sizing/hand-off, and token/reasoning economics. Consolidated below. Measured/primary evidence is separated from vendor-asserted and blog-level claims throughout.

### 7.1 The problem is a named, documented anti-pattern

Our case — one coordinator spawns 20-30 sub-agents, holds every child's full output plus supervision chatter, and compacts 5-12× while isolated leaves compact 0× — is the textbook "orchestrator-accumulates-everything" failure. Independent framing: _"for a pipeline with 10 sub-agents generating 2,000 tokens each, the orchestrator accumulates 20,000+ tokens before it's even written its final synthesis."_ At 20-30 children that math is exactly why the coordinator hits 5-12 compactions. Sources: [Anthropic multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system), [Redis sub-agents](https://redis.io/blog/sub-agents-splitting-context-specialized-ai-agents/), [MindStudio agent-teams](https://www.mindstudio.ai/blog/claude-code-agent-teams-vs-sub-agents).

### 7.2 Fix #1 — Structured hand-back: pointer, not payload (highest leverage)

The load-bearing pattern across every serious system: sub-agents do expensive work in isolation but return a **bounded summary (~1,000-2,000 tokens), never their transcript**; large output persists to the filesystem and only a reference crosses back.

| System                 | Mechanism                                                                                                                                                            | Source                                                                                                                                                                                |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anthropic Research     | Subagents explore for tens of thousands of tokens, return ~1-2K-token summaries; full output written to filesystem, only refs relayed ("avoids a game of telephone") | [Anthropic context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)                                                                    |
| LangChain `deepagents` | Subagent final answer validated against a schema, delivered as a single `ToolMessage`; parent **structurally cannot** see intermediate steps                         | [LangChain subagents](https://docs.langchain.com/oss/python/deepagents/subagents)                                                                                                     |
| Codex CLI v2           | `wait_agent` returns only final-channel text + status metadata, not the subagent transcript; path-addressed agents (`/root/researcher/summarizer`)                   | [Codex CLI v2 orchestration](https://codex.danielvaughan.com/2026/04/11/codex-cli-multi-agent-orchestration-v2-complete-guide/) (secondary — cross-check against our harness version) |
| Claude Code            | Subagent full conversation stored in a sidechain file; only a summary returns to parent                                                                              | [Dive into Claude Code, arXiv:2604.14228](https://arxiv.org/html/2604.14228v1)                                                                                                        |

**Direct applicability:** delamain's throwaway worktrees (`integrate:false`) already _are_ the artifact store. The coordinator should hold `{worktree path, branch, commit SHA, diff-stat, one-paragraph summary, follow-ups}` — never the ingested diff/log. Make it structurally impossible for the parent to receive a raw child transcript and no prompting discipline is needed to keep it lean. This maps directly to the existing `agent(prompt, {schema})` path.

### 7.3 Fix #2 — The sharp counter-evidence: hand-backs are necessary but NOT sufficient

The task-sizing research actively hunted counter-evidence to our "it's the coordinator, not task size" conclusion and **refined it in an important way**:

- The coordinator's **own accumulated state** (plan, "findings so far", task list) grows unboundedly across many subagent calls _regardless of how clean each individual return is_. Structured hand-backs don't fix this — you must **actively prune the coordinator's own transcript** too. ([MindStudio codebase-analysis](https://www.mindstudio.ai/blog/sub-agents-codebase-analysis-context-limits))
- Therefore it is leaf **cardinality**, not leaf **size**, that drives coordinator growth. Every additional leaf is one more hand-back to ingest and retain. Our "leaves already don't compact, so leaf sizing is irrelevant" holds for _size_ but not for _count_ — 30 tiny leaves can still compact a coordinator.
- A controlled study found system performance "driven primarily by the capacity of the **Orchestrator** rather than the size of execution sub-agents" — orchestrator reasoning helped, subagent reasoning gave limited/negative benefit. Direct support for investing in the coordinator, not leaf granularity. ([arXiv:2601.11327](https://arxiv.org/abs/2601.11327))

**Net:** our conclusion is correct but sharpened — _fix the coordinator's return contract AND prune its own state AND bound leaf count per coordinator lifetime; leaf task size is not the lever._

### 7.4 Fix #3 — Hierarchical delegation to bound cardinality

Insert a middle layer: coordinator → 4-6 leads → leaves. The top coordinator only ever converses with a handful of leads, so its context growth is bounded per-level instead of linear in total leaf count. This is the structural answer to the cardinality problem in 7.3. Magentic-One's two-loop design adds a concrete trigger: maintain a **Task Ledger** + **Progress Ledger** and force a **hard state reset at plan boundaries** (each phase/milestone), keeping only the ledger — so compaction becomes rare rather than steady-state. Sources: [MindStudio teams-vs-subagents](https://www.mindstudio.ai/blog/claude-code-agent-teams-vs-sub-agents), [Magentic-One arXiv:2411.04468](https://arxiv.org/pdf/2411.04468).

### 7.5 "Short-lived coordinator" is compaction-by-respawn — hand off durable state

A caution surfaced repeatedly: respawning a fresh coordinator is _functionally_ compaction (you discard/summarize prior state at a process boundary). It avoids the auto-compact code path but not the underlying failure mode — **unless the state handed to the next coordinator is written out as durable structured artifacts, not a summarized transcript.** Measured risks of any summarize-and-drop boundary:

- Compaction raised standing-constraint violation from **0% → 30% (up to 59%)** across 7 models / 1,323 episodes; when a constraint survived the summary violation stayed 0%, when dropped it jumped to 38%. ([Governance Decay, arXiv:2606.22528](https://arxiv.org/abs/2606.22528))
- Compaction summaries can **fabricate "confirmed results"** from killed/timed-out processes (exit 143 output promoted to ground truth), propagating false state forward. ([Epistemic Failure, arXiv:2607.13071](https://arxiv.org/abs/2607.13071))
- Error grows **super-linearly in the number of compaction events** under irreversible summarization, while retrieval-backed memory stays flat. Our 5-12 compactions per coordinator sit squarely in the compounding regime. ([rate-distortion analysis, arXiv:2607.08032](https://arxiv.org/html/2607.08032))

**Implication:** whichever way we bound coordinator context (respawn or compact), checkpoint the plan + per-child status objects to disk as ground truth so the next context resumes from facts, not a chain of summaries — mirroring Anthropic's lead agent persisting its plan to memory at ~200K tokens.

### 7.6 Cost & reasoning-effort economics (the Terra burn, explained by the literature)

- **Multi-agent fan-out carries a ~15× token multiplier** over single chat (agents alone ~4×); token usage alone explains **80%** of eval-outcome variance — the quality is largely _bought_, not engineered. ([Anthropic](https://www.anthropic.com/engineering/multi-agent-research-system))
- **Code review is explicitly named a poor multi-agent fit by two independent vendors.** Anthropic lists "most coding work" as having few cleanly-parallelizable subtasks; Cognition's [Don't Build Multi-Agents](https://cognition.com/blog/dont-build-multi-agents) argues reviewers reasoning over the same diff without a shared trace duplicate work rather than divide it. Our 24-subagent _review_ fleet is the middle of that warning — consistent with the observed ~28× cost-per-shipped-change.
- **Don't run max effort uniformly.** OpenAI's own docs: `medium` is the balanced default; `high` for genuinely hard reasoning; `xhigh` **only when evals show a clear benefit**. Independent measurement: higher effort bought ~2-5 accuracy points for a 4-5× token increase; [OckBench (arXiv:2511.05722)](https://arxiv.org/abs/2511.05722) found models at equal accuracy differ up to **5.0× in token length** — most reasoning spend is verbosity, not correctness. Running the whole fleet at MAX plausibly explains a large share of Terra's ~2× reasoning gap. ([OpenAI reasoning docs](https://developers.openai.com/api/docs/guides/reasoning))
- **Cache is already near its ceiling** for us — 97-98% cache-read share means input reprocessing is _not_ the cost driver; generation + reasoning volume is. Don't spend effort re-optimizing caching. Note: compaction rewrites message history and **invalidates the cached prefix**, forcing a 1.25×-2.0× write on the next turn — frequent compaction trades smaller context for periodic cache-write spikes. ([Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching))
- **Add a hard per-run token/dollar budget with graceful early-exit.** A catalog of **63 budget-overrun incidents across 21 frameworks** directly matches our "exhausted a weekly quota" event; a cap converts a quota-draining run into a bounded partial result. For deeper optimization, [BAMAS (arXiv:2511.21572, AAAI 2026)](https://arxiv.org/abs/2511.21572) reports **up to 86% cost reduction at parity** via per-node model selection + topology pruning — the most rigorous cost-control result found. ([budget catalog arXiv:2606.04056](https://arxiv.org/abs/2606.04056))

### 7.7 Prioritised recommendations for delamain

1. **Enforce a structured return contract at the pi→codex boundary** so the parent can _only_ receive `{status, files, diff-stat, summary, follow-ups}` — never a child transcript. Highest leverage, protocol change not infra. (7.2)
2. **Prune the coordinator's own accumulated state** (plan / findings-so-far), independent of child returns — the gap that clean hand-backs alone don't close. (7.3)
3. **Track leaf _count_ per coordinator lifetime** as telemetry; if coordinator compaction correlates with invocation count rather than aggregate result size, that settles the size-vs-cardinality question and points at hierarchical delegation. (7.3, 7.4)
4. **Add a middle lead-layer** (coordinator → leads → leaves) once fan-out exceeds ~5-6, to bound coordinator cardinality; hard-reset at plan/phase boundaries keeping only a ledger. (7.4)
5. **On coordinator respawn, hand off durable structured artifacts, not a summarized transcript** — avoids the constraint-drop / fabricated-"confirmed" failure modes. (7.5)
6. **Mix reasoning effort per task difficulty** instead of fleet-wide MAX; reserve high/xhigh for the leaves whose evals show it pays (e.g. the security-bug finders), default the rest to medium. (7.6)
7. **Right-size the fan-out for review work** toward Anthropic's actual 3-5 (>10 only for the hardest), or restructure to Cognition's single-write-thread + read-only helpers; and add a hard per-run budget cap with graceful early-exit. (7.6)

### 7.8 Evidence-quality note

Strongest (independent/academic, arXiv-verifiable): OckBench token-spread, BAMAS cost reduction, Governance-Decay and Epistemic-Failure compaction studies, the rate-distortion super-linear result, the 63-incident budget catalog. Solid (vendor documenting its own production system, self-reported): Anthropic's 15× / 90.2% / 1-2K-token figures, OpenAI/Anthropic parameter docs, Claude Code / Codex / Cursor / Aider compaction mechanics. Directional only (single-vendor blog or aggregator, unverified methodology): the "3-5× cheaper agent-teams", "23× High-vs-Minimal", "40-60% coordination tax", and "29-38% redundant context" figures — usable as illustration, not citable as fact.
