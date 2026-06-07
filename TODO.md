# TODO

## Small things

- [ ] Submitting new messages should scroll to bottom
- [ ] Only show last 10 threads for a given project
- [ ] Thread archiving
- [ ] New projects should go on top
- [ ] Projects should be sorted by latest thread update

## Bigger things

- [ ] Queueing messages

## Headless / remote-agent mode (plan: `PLAN.md`)

Headless control plane: run T3 Code on a GUI-less box and manage remote SSH agents from it.

- [x] Verified `t3 serve` as the canonical headless entrypoint (no browser, no Electron; prints connection string + owner pairing token + pairing URL + QR). Regression test: `apps/server/src/cli/config.test.ts` "forces noBrowser and disables auto-bootstrap for headless startup presentation".
- [x] `t3 remote {add,list,status,remove}` CLI group (`apps/server/src/cli/remote.ts`) reusing the existing `packages/ssh` engine (`launchOrReuseRemoteServer` / `issueRemotePairingToken` / `stopRemoteServer` / `waitForHttpReady`); registered in `bin.ts`.
- [x] Server-side saved-agent registry (`apps/server/src/remote/RemoteAgentRegistry.ts`) persisting `<base-dir>/userdata/remote-agents.json` via `atomicWrite`; contracts schemas `RemoteAgentRecord` / `RemoteAgentRegistryFile` + neutral `RemoteSshTarget` alias in `packages/contracts/src/remoteAccess.ts`.
- [x] Tests: `remote.test.ts` (CLI parsing + offline registry no-ops), `RemoteAgentRegistry.test.ts` (persistence round-trip). REMOTE.md documents Option 4.
- [ ] Deferred (see `PLAN.md` §Deferred): persistent local port-forward daemon for headless, interactive SSH password prompts, HTTP/WS + web-UI surface for remote-agent management, `AdvertisedEndpoint` unification.

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
- [~] **1. Verifier-critic (top priority):** acceptance-criteria-per-slice plumbing + fresh read-only **codex** verifier after the H0 gate → triage `pass`/`fail`/`uncertain` → auto-merge vs hold-for-review (`gpt-5.4-mini`/high → `gpt-5.5` when uncertain)
  - [x] Contracts + parser/store: `packages/contracts/src/gits.ts` (GitsSliceCriteria/Verify*), `GitsSliceCriteria.ts` (`parseSliceCriteria`/`renderSliceCriteria`) + `GitsSliceCriteriaStore` (PR #2)
  - [x] Verifier-critic adapter: `GitsCodexVerifierAdapter.ts` — fresh read-only codex (`~/.codex`, prompt via stdin, `--skip-git-repo-check`); `recommend()` triage; escalate 5.4-mini→5.5 (PR #1/#4, live-smoked)
  - [x] Review pipeline (mechanical gate → semantic verifier → triage): `GitsReviewPipeline.ts` (PR #3); launch-layer leak fixed in `server.ts` so `bin.ts` typechecks
  - [x] Autopilot wiring (read side): `apps/server/src/gits/bin/verify.ts` CLI (PR #5) + skill `supervisor.py` Gate 3 (`semantic_verify_script`/`run_semantic_verify`), live integration-smoked
  - [ ] **Author side (open — needs decision):** nothing writes per-slice `<slice_id>.md`, so with `semantic_verify:true` every slice holds. Wire criteria authoring (handoffs → `slice_criteria_dir`) + inject `{{ACCEPTANCE_CRITERIA}}` into peer prompt (the design's "same bar"); and make a hold *not* freeze the whole chain (design = "triage, never block; advance on independent slices"). See brainstorm Open flag Q11.
- [ ] 2. Episode ledger (SQLite, `@effect/sql-sqlite-bun`, indexed+WAL) + reflections; codex 5h/weekly usage visibility in cockpit + 80%-weekly auto-spawn throttle
- [ ] 3. Peer-question auto-answerer (derivable+non-scope-changing+reversible → auto; else one-tap escalate; notified-passive; logged)
- [ ] 4. Reflection → codex model-tier routing + prompt tuning, as operator-gated cards
- [ ] 5. Fully-agentic toggle (= `AutomodePolicy.mode` autonomous), guardrails intact
- [ ] (parallel) GITS PWA + web push (manifest, service worker, push backend) — replaces Telegram for held-PR/escalation notifications
- [ ] (deferred) earlier design's editable 3-tier OrchestratorConfig + canary executor — fold in *after* the verifier/ledger prove value; memory shared-store + MCP-proxy DROPPED (descope)
