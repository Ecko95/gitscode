# TODO

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
  - [ ] H0c: peer egress allowlist — install `passt`/`pasta` (absent), then `--egress proxy=` enforcing model-API+memory-proxy only
- [ ] Phase 0: peer-outcome telemetry (`peer-outcomes.jsonl` + `monitorPeerOutcome`, reuse `waitForPeer`) + decision log
- [ ] Phase 1: `OrchestratorConfig` 3-tier contract (tuning/sensitive/guardrail) + versioned service (read path)
- [ ] Phase 2: GITS-mediated memory proxy (auth+provenance) over Basic Memory + `MemoryStore` + deterministic consolidation
- [ ] Phase 3: `orchestrator-config` structured-patch cards → `OrchestratorConfigExecutor` (validator + canary + auto-rollback)
