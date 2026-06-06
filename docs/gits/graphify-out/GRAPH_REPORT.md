# Graph Report - docs/gits  (2026-06-03)

## Corpus Check
- Corpus is ~14,150 words - fits in a single context window. You may not need a graph.

## Summary
- 63 nodes · 106 edges · 7 communities
- Extraction: 91% EXTRACTED · 9% INFERRED · 0% AMBIGUOUS · INFERRED: 10 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Governance & Proposal Contracts|Governance & Proposal Contracts]]
- [[_COMMUNITY_Self-Improvement Optimizers & Telemetry|Self-Improvement Optimizers & Telemetry]]
- [[_COMMUNITY_MAPE-K Loop & Ungoverned-SI Contrast|MAPE-K Loop & Ungoverned-SI Contrast]]
- [[_COMMUNITY_Editable Orchestrator & Execution Substrate|Editable Orchestrator & Execution Substrate]]
- [[_COMMUNITY_GITS Shell & Skills Intelligence|GITS Shell & Skills Intelligence]]
- [[_COMMUNITY_Shared Memory Substrate|Shared Memory Substrate]]
- [[_COMMUNITY_MotokoHermes Identity & Policy|Motoko/Hermes Identity & Policy]]

## God Nodes (most connected - your core abstractions)
1. `orchestrator-config.json` - 14 edges
2. `Typed proposal cards (HermesProposalCard)` - 13 edges
3. `Motoko learning loop` - 10 edges
4. `DevOS Cockpit` - 9 edges
5. `Peer-Outcome Telemetry / Episode Ledger (peer-outcomes.jsonl)` - 8 edges
6. `Delamain peers` - 8 edges
7. `Shared Basic Memory store` - 7 edges
8. `Motoko (Hermes operator profile)` - 7 edges
9. `Automode dispatcher (AutomodeSupervisor)` - 6 edges
10. `orchestrator-config actionKind` - 5 edges

## Surprising Connections (you probably didn't know these)
- `Capacity-aware router (GitsCapacityMonitor)` --conceptually_related_to--> `orchestrator-config.json`  [INFERRED]
  docs/gits/HERMES.md → docs/gits/ORCHESTRATION_SELF_IMPROVEMENT_DESIGN.md
- `Maestro (arXiv:2509.04642)` --semantically_similar_to--> `Motoko learning loop`  [INFERRED] [semantically similar]
  docs/gits/ORCHESTRATION_PRIOR_ART.md → docs/gits/ORCHESTRATION_SELF_IMPROVEMENT_DESIGN.md
- `Ruflo / Claude-Flow` --anti_pattern_of--> `orchestrator-config.json`  [EXTRACTED]
  docs/gits/ORCHESTRATION_PRIOR_ART.md → docs/gits/ORCHESTRATION_SELF_IMPROVEMENT_DESIGN.md
- `DSPy` --borrow_from--> `orchestrator-config.json`  [EXTRACTED]
  docs/gits/ORCHESTRATION_PRIOR_ART.md → docs/gits/ORCHESTRATION_SELF_IMPROVEMENT_DESIGN.md
- `orchestrator-config.json` --reads/uses--> `packages/contracts/src/gits.ts`  [EXTRACTED]
  docs/gits/ORCHESTRATION_SELF_IMPROVEMENT_DESIGN.md → docs/gits/ARCHITECTURE.md

## Hyperedges (group relationships)
- **MAPE-K loop stages (Monitor/Analyze/Plan/Execute/Knowledge)** — orchestration_self_improvement_design_episode_ledger, orchestration_self_improvement_design_reflections, orchestration_self_improvement_design_proposal_cards, orchestration_self_improvement_design_orchestrator_config, orchestration_self_improvement_design_memory_store, orchestration_self_improvement_design_mape_k [INFERRED 0.85]
- **Ungoverned self-improvement cluster** — orchestration_prior_art_darwin_godel, orchestration_prior_art_sica, orchestration_prior_art_maestro, orchestration_prior_art_ruflo [INFERRED 0.85]
- **Governed non-self-improving orchestration cluster** — orchestration_prior_art_openhands, orchestration_prior_art_kilo_code, orchestration_prior_art_langgraph, orchestration_prior_art_humanlayer [INFERRED 0.85]

## Communities (7 total, 0 thin omitted)

### Community 0 - "Governance & Proposal Contracts"
Cohesion: 0.19
Nodes (13): packages/contracts/src/gits.ts, EvoAgentX + HITLManager, HumanLayer, LangGraph, memory-write actionKind, orchestrator-config actionKind, approvalMode=smart bandit ranker, Augment Cosmos (+5 more)

### Community 1 - "Self-Improvement Optimizers & Telemetry"
Cohesion: 0.22
Nodes (10): AgentEvolver, DSPy, GEPA, Maestro (arXiv:2509.04642), OpenHands / OpenDevin, Microsoft Trace (OptoPrime), delamain-autopilot (supervisor.py), Peer-Outcome Telemetry / Episode Ledger (peer-outcomes.jsonl) (+2 more)

### Community 2 - "MAPE-K Loop & Ungoverned-SI Contrast"
Cohesion: 0.36
Nodes (9): Automation order (observable->control->automation), Darwin-Godel Machine (arXiv:2505.22954), Ruflo / Claude-Flow, SICA (arXiv:2504.15228), Augment Learning Flywheel, MAPE-K loop, Motoko learning loop, Reflections (confidence-scored heuristics) (+1 more)

### Community 3 - "Editable Orchestrator & Execution Substrate"
Cohesion: 0.31
Nodes (9): GITS empty-quadrant composition, Kilo Code, MetaGPT, Automode dispatcher (AutomodeSupervisor), AutomodePolicy, Claude Agent SDK (TypeScript), Delamain peers, memorix (+1 more)

### Community 4 - "GITS Shell & Skills Intelligence"
Cohesion: 0.36
Nodes (9): DevOS Cockpit, T3 Code shell, skill-creator self-improvement engine, Claude canUseTool command rewriting, RTK output gateway, HERMES improvement loop/queue, GitsSkillInventory / Skills Intelligence, build-info provenance (/api/gits/build-info) (+1 more)

### Community 5 - "Shared Memory Substrate"
Cohesion: 0.29
Nodes (8): agentmemory, Four-axis memory scoping, Graphiti (temporal-KG upgrade), Letta / MemGPT, mem0, MemoryStore service, Native Claude memory tool (Motoko private scratch), Shared Basic Memory store

### Community 6 - "Motoko/Hermes Identity & Policy"
Cohesion: 0.4
Nodes (5): ACP (Agent/Client Protocol), Capacity-aware router (GitsCapacityMonitor), Motoko (Hermes operator profile), Observe/propose-only policy, Hermes runtime

## Knowledge Gaps
- **15 isolated node(s):** `approvalMode=smart bandit ranker`, `Graphiti (temporal-KG upgrade)`, `Letta / MemGPT`, `agentmemory`, `Augment Cosmos` (+10 more)
  These have ≤1 connection - possible missing edges or undocumented components.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `orchestrator-config.json` connect `Editable Orchestrator & Execution Substrate` to `Governance & Proposal Contracts`, `Self-Improvement Optimizers & Telemetry`, `MAPE-K Loop & Ungoverned-SI Contrast`, `Motoko/Hermes Identity & Policy`?**
  _High betweenness centrality (0.270) - this node is a cross-community bridge._
- **Why does `Typed proposal cards (HermesProposalCard)` connect `Governance & Proposal Contracts` to `Self-Improvement Optimizers & Telemetry`, `MAPE-K Loop & Ungoverned-SI Contrast`, `GITS Shell & Skills Intelligence`, `Motoko/Hermes Identity & Policy`?**
  _High betweenness centrality (0.255) - this node is a cross-community bridge._
- **Why does `Delamain peers` connect `Editable Orchestrator & Execution Substrate` to `Governance & Proposal Contracts`, `Self-Improvement Optimizers & Telemetry`, `GITS Shell & Skills Intelligence`, `Motoko/Hermes Identity & Policy`?**
  _High betweenness centrality (0.225) - this node is a cross-community bridge._
- **Are the 2 inferred relationships involving `Motoko learning loop` (e.g. with `Maestro (arXiv:2509.04642)` and `Motoko (Hermes operator profile)`) actually correct?**
  _`Motoko learning loop` has 2 INFERRED edges - model-reasoned connections that need verification._
- **What connects `approvalMode=smart bandit ranker`, `Graphiti (temporal-KG upgrade)`, `Letta / MemGPT` to the rest of the system?**
  _15 weakly-connected nodes found - possible documentation gaps or missing edges._