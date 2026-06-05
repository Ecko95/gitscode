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
### Re-sequenced after `/grill-me` (2026-06-06) — see `docs/brainstorms/self-improving-orchestration.md` + DESIGN §"Revision 2"
Pain = green-but-wrong PRs (quality) + cost/babysitting. Codex-only peers; avoid Claude Agent SDK; Motoko = persona+conductor; memory descoped to a SQLite ledger; cost = codex rate-limits (reserve 20% weekly); target surface = GITS Android PWA + web push.
- [ ] **1. Verifier-critic (top priority):** acceptance-criteria-per-slice plumbing + fresh read-only **codex** verifier after the H0 gate → triage `pass`/`fail`/`uncertain` → auto-merge vs hold-for-review (`gpt-5.4-mini`/high → `gpt-5.5` when uncertain)
- [ ] 2. Episode ledger (SQLite, `@effect/sql-sqlite-bun`, indexed+WAL) + reflections; codex 5h/weekly usage visibility in cockpit + 80%-weekly auto-spawn throttle
- [ ] 3. Peer-question auto-answerer (derivable+non-scope-changing+reversible → auto; else one-tap escalate; notified-passive; logged)
- [ ] 4. Reflection → codex model-tier routing + prompt tuning, as operator-gated cards
- [ ] 5. Fully-agentic toggle (= `AutomodePolicy.mode` autonomous), guardrails intact
- [ ] (parallel) GITS PWA + web push (manifest, service worker, push backend) — replaces Telegram for held-PR/escalation notifications
- [ ] (deferred) earlier design's editable 3-tier OrchestratorConfig + canary executor — fold in *after* the verifier/ledger prove value; memory shared-store + MCP-proxy DROPPED (descope)
