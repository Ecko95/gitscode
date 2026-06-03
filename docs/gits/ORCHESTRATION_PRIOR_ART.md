# Orchestration Self-Improvement — Comparable Prior Art (GitHub)

Date: 2026-06-03
Method: Claude Opus research subagent, primary-sourced (repo READMEs/docs + papers).
Companion to `ORCHESTRATION_SELF_IMPROVEMENT_DESIGN.md`.

## Headline

No popular OSS repo combines all four axes GITS touches: **(1)** worktree-isolated parallel coding peers, **(2)** a self-improvement loop, **(3)** an editable/diffable orchestration-config artifact, **(4)** a human approval gate. The field splits cleanly into **"powerful but ungoverned self-improvement"** (DGM, SICA, Maestro, Ruflo) and **"governed but non-self-improving orchestration"** (OpenHands, Kilo Code, LangGraph, HumanLayer). **GITS sits in the empty quadrant between them — and that quadrant is defensible** (the research repos' own safety warnings are evidence the gap is real). GITS is sound and **novel in composition, not in any single component.**

## Closest prior art (top 3)

| Project | Axis | Validates | Challenges |
|---|---|---|---|
| **Maestro** (arXiv:2509.04642) | editable config + self-improvement | Jointly optimizing the **orchestrator graph + per-module config** against a fitness signal is a real winning direction (beats GEPA/MIPROv2); **reflective textual feedback from traces** is the efficient way to drive edits — exactly Motoko's job over the episode ledger. | Maestro **auto-applies**. GITS must justify that the human card + regression gate buys safety/trust worth more than the throughput auto-apply gets, and that external rules-based verification is a better fitness signal than mixed numeric+reflective. |
| **Darwin-Gödel Machine** (Sakana, arXiv:2505.22954) + **SICA** (arXiv:2504.15228) | self-improvement mechanism | Benchmark-as-fitness + append-only archive + iterative artifact edits genuinely raise capability (SWE-bench 20→50%). The loop's *engine* is sound. **Their own safety notes** ("may behave destructively") are GITS's strongest external justification for the gate. | Some gains come *from* unrestricted self-modification; restricting edits to a config layer above the safety policy may capture less upside. **Instrument the cost of the gate vs. an ungated baseline.** |
| **EvoAgentX HITLManager** + **HumanLayer** (~11k★) | governance | Pairing self-evolution with a human interceptor is already shipped (EvoAgentX); a popular dedicated approval primitive exists (HumanLayer). GITS's approval-required card is not exotic. | Both gate at the **action/tool-call** level. GITS gates at **config-version-promotion** (coarser + a regression suite as 2nd gate) — arguably better, but less battle-tested. Lean on HumanLayer async approval + LangGraph checkpoint/interrupt rather than reinventing. |

## Full landscape (≈15)

- **Ruflo / Claude-Flow** (ruvnet, ~57.7k★, MIT) — closest *surface* (swarm + shared memory + "self-learning"), opposite philosophy. "SONA self-improvement" is **RAG-of-past-trajectories dressed in neuroscience vocabulary** — no governed config change, no gate, config is CLI-scaffolded not diffable. The anti-pattern GITS's versioned/diffable/approved config is the antidote to.
- **OpenHands / OpenDevin** (~75.7k★, MIT) — strong executor substrate; **immutable event-stream architecture** (every action/observation an immutable event). No self-improvement / declarative routing / HITL in core. **Borrow the immutable event ledger.**
- **Kilo Code** (Cline/Roo lineage) — **GITS's substrate done in an IDE**: agent-per-**git-worktree** under `.kilo/worktrees/`, diff-vs-parent review panel, per-session terminals. No strategist / self-improvement. **Borrow the diff-vs-parent review panel; AGENTS.md as portable cross-tool memory.**
- **DSPy** (~34.8k★, MIT) — the *honest* "self-improving": offline compilation of prompts/demos against a user metric, inspectable artifact. **Borrow metric-as-first-class-input + inspectable/diffable artifact.**
- **GEPA** — reflective Pareto prompt evolution. **Borrow Pareto multi-objective fitness — keep pass-rate, cost, forbidden-touch as separate objectives, never one scalar.**
- **Microsoft Trace (OptoPrime)** — "AutoDiff for agents"; rich feedback (errors/NL/scores), not a scalar reward, drives edits. **Feed Motoko the full episode record, not just a status.**
- **EvoAgentX** (~3.1k★, MIT) — evolves workflow structure + prompts **with** a `HITLManager`/`HITLInterceptorAgent`. Rare two-pillar (evolve + gate) confirmation.
- **AgentEvolver** (modelscope, ~1.4k★) — training-time RL (weight updates) + **self-attribution/credit-assignment**. **Borrow the credit-assignment concept** (attribute an episode outcome to specific config choices) — not the RL.
- **MetaGPT** (~68k★) — SOP-as-orchestration, but code-baked + static. Validates *explicit process > model brilliance*; don't hard-code it (GITS's premise: a versioned evolvable artifact).
- **CrewAI / AutoGen(AG2, now maintenance-mode) / LangGraph** — general agent graphs, not coding-specialized, no worktree isolation, no self-improvement. **LangGraph checkpoint + interrupt-for-approval is the canonical HITL pattern; CrewAI's terse DSL is a model for keeping `orchestrator-config.json` human-authorable.**
- **Aider / Goose / SWE-agent** — single-agent executors (the *kind* of executor codex/cursor peers are). Goose's MCP-native declarative "recipes" reinforce config-as-artifact + one-HTTP-MCP-memory.

## Concrete borrows to fold into the design

1. **Immutable event-stream ledger (OpenHands)** — make the Episode Ledger append-only immutable events from day 1; don't bolt telemetry on later.
2. **Pareto / multi-objective fitness (GEPA)** — never collapse pass-rate + cost + forbidden-touch into one scalar; keep a Pareto front so a cheaper-but-slightly-worse config isn't auto-promoted on one number.
3. **Reflective-trace-prioritized edits (Maestro/Trace)** — Motoko targets *which* config knob a failure implicates from trace-level feedback, not blind config-space search. The difference between a useful proposal card and noise.
4. **Self-attribution / credit-assignment (AgentEvolver)** — attribute each episode's outcome to specific config decisions (engine/model/prompt) so cards cite the right cause.
5. **Diff-vs-parent review panel (Kilo Code)** — surface the *config* diff and the *peer* diff side-by-side in the cockpit; reuse for the integrate/PR step.
6. **HITL primitives (HumanLayer async approval + LangGraph interrupt/checkpoint)** — don't reinvent the approval UX.
7. **AGENTS.md as portable cross-tool memory convention** — complements the shared Basic Memory MCP store; readable by codex/cursor/claude natively.

## What the field gets wrong that GITS avoids

- "Self-improving" as marketing for RAG-of-trajectories with no governed change / falsifiable fitness (Ruflo).
- Autonomous application with no rollback (DGM/SICA/Maestro/AgentEvolver — their own safety notes flag it).
- LLM-judges-itself fitness (reward hacking) — GITS uses external rules-based verification.
- Coupling self-improvement to the safety layer — GITS keeps the editable config strictly **above** the kill-switch/allowlist/budget.

## Residual risks the prior art highlights

- **Gate may throttle the gains** DGM/Maestro show come from automation → **instrument the cost of the human gate vs an ungated baseline.**
- **Operational overhead** → mitigated by gating at config-version-promotion (coarse) not per-action (HumanLayer's per-call model).
