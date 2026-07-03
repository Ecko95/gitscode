# GITS Harness Execution Plan — Final Audit Consolidation

**Date:** 2026-07-03
**Sources reconciled:** `docs/performance-optimization-plan.md` (perf tiers), `docs/audit-2026-07.md` (9-category audit), and the Fable harness engineering prompt (4 workstreams: orchestration perf, worktree lifecycle/Graveyard, security hardening, deployment topologies).
**Purpose:** one task-by-task plan, wave-ordered and file-scoped, so execution agents can be spun up in parallel without collisions. Operating model: Fable orchestrates, Sonnet agents execute (Codex selectable per task) — see §4.

---

## 1. Capability inventory — what GITS already has (verified 2026-07-03)

| Capability | State | Evidence |
|---|---|---|
| Event-sourced orchestration (decider → event store → projections → push) | Shipped, tested | `apps/server/src/orchestration/` (decider.ts, OrchestrationEngine, ProjectionPipeline) |
| Typed completion receipts (await, don't poll) | Shipped | `orchestration/Layers/RuntimeReceiptBus.ts` |
| Queue-backed reactors (command, checkpoint, thread-deletion, ingestion) | Shipped | `orchestration/Layers/*Reactor.ts` |
| Provider adapters: Codex, Claude (ACP), OpenCode (ACP), Cursor | Shipped | `provider/Layers/*Adapter.ts`, `provider/acp/AcpSessionRuntime.ts`, `packages/effect-acp` |
| Provider-neutral VcsDriver (plan 19 phase 1) | **Shipped** — Graveyard builds on this, not on raw git shell-outs | `apps/server/src/vcs/VcsDriver.ts`, `GitVcsDriver.ts`, `VcsDriverRegistry.ts`, `VcsProvisioningService.ts` |
| Worktree create/remove primitives | Shipped (create/remove only — no lifecycle) | `vcs/GitVcsDriverCore.ts:2059-2164` |
| Auth control plane (plan 18 direction) | **Substantially built, with tests** | `auth/Layers/`: ServerAuth, ServerAuthPolicy, AuthControlPlane, BootstrapCredentialService, SessionCredentialService, ServerSecretStore (all with `.test.ts`) |
| "Motoko" supervision (v1 = Automode family) | Shipped v1 | `gits/Layers/`: AutomodeSupervisor, AutomodeDriver (5s tick), AutomodeLanding, AutomodeReviewGate, AutomodeHeldPr, AutomodeUsageMeter, episode ledger (migration 032) |
| Delamain worker spawn | Shipped (CLI adapter) | `gits/Layers/DelamainCliAdapter.ts` |
| Capacity monitoring | Shipped | `gits/Layers/GitsCapacityMonitor.ts` |
| Crit review sidecar (on-demand, refcounted) | Shipped | `crit/crit-sidecar-manager.ts` |
| Visual-plan HTTP MCP (per-thread bearer token) | Shipped | `gits/mcp/VisualPlanMcpRegistry.ts` |
| Hermes/Cortex bridge (on-demand exec) | Shipped | `gits/Layers/HermesCliAdapter.ts` |
| Remote/tailnet stack | Shipped | `REMOTE.md`, `packages/tailscale`, `packages/ssh`, `.docs/remote-architecture.md` |
| Concurrency utilities for keyed work | Shipped, underused | `packages/shared/src/KeyedCoalescingWorker.ts`, `DrainableWorker.ts` |
| Observability hooks | Shipped | `packages/shared/src/observability.ts`, `docs/observability.md` |
| Native clients | Shipped | Electron desktop, Expo 56/RN 0.85 mobile (dev/preview/prod variants), web SPA |

## 2. Corrections to prior documents (ground-truth drift)

**Fable prompt is stale on:** `EnvironmentAuth.ts` (superseded by `auth/Layers/ServerAuth*`), `CodexHomeLayout.ts` (moved to `provider/Drivers/`), `.repos/` (absent — mirror `packages/effect-acp` style instead of reading `effect-smol/LLMS.md`), and it understates auth progress: plan 18 is partially implemented, so Workstream 3 starts with a **gap audit against `.plans/18-server-auth-model.md`**, not greenfield.

**audit-2026-07.md is corrected on:** (a) "auth trust boundary half-untested" — the `auth/Layers/` services all have colocated tests; the open question is *policy-surface coverage* (every HTTP route/WS upgrade/RPC method behind the policy engine), not missing unit tests; (b) audit Fix #1's "3-line worktree delete in ThreadDeletionReactor" is **superseded by the Graveyard design** — finished work is retired (checkpoint captured → branch preserved → worktree pruned after receipt), never destroyed immediately. Perf-plan task T2.1 is likewise folded into the Graveyard.

**Still fully valid:** all drift-guard, dependency, reconnect, migration-safety, Android, and testing findings; the perf plan's Tier 0/1 items and measured baselines.

## 3. Harness rules for every task (from the Fable prompt — binding)

1. `bun fmt` / `bun lint` / `bun typecheck` green before done. **Never `bun test` — always `bun run test`.**
2. Every state change through the decider/event store — no side channels, no direct projection writes.
3. New behavior tested by **awaiting receipts, never sleeps**; tests colocated (`*.test.ts` beside sources).
4. Effect idioms per `packages/effect-acp` / `packages/effect-codex-app-server`: service tag + layer + schema-backed tagged errors, scoped processes, explicit decode boundaries.
5. Fork discipline: additive layers/modules over invasive upstream edits; unavoidable upstream diffs stay minimal with `fork:` commit prefix.
6. `packages/contracts` stays schema-only; `@t3tools/shared` by subpath import only.
7. Safety lives in the harness, not prompts: worktree isolation, event-sourced audit, reaper policies, network auth. Never weaken it for an agent's convenience.
8. Approval gate: anything touching auth, persistence migrations, or the event schema gets a plan reviewed by the operator before execution.

---

## 4. Operating model — Fable plans, Sonnet executes

All W-tasks run through the `/fable-5-orchestration` skill. Two skills define the harness:

- **`/fable-5-orchestration`** — the dispatch loop. Every task batch is invoked through it (e.g. `/fable-5-orchestration W1.1 W1.2 W1.3 --engine sonnet`).
- **`/ponytail:ponytail` (level: full)** — the code-quality discipline, applied at two points: Fable runs it as the **pre-implementation critique gate** on every task brief (kill speculative scope before an agent burns tokens on it), and every **Claude/Sonnet execution agent runs under it** while implementing — first rung of the ladder that holds, stdlib/platform before new code, shortest working diff, deliberate shortcuts marked `ponytail:` with the ceiling named. Codex-engine agents can't invoke Claude skills, so their briefs embed the same rules inline (the brief template's invariants section carries them).

Roles:

- **Fable 5 (orchestrator)** does everything high-level: recon, scoping, blast-radius drafts, task briefs, ponytail critique gates, adversarial review of results, audits, keep/change/drop and merge decisions, and the plan-gate conversation with the operator. Fable never implements unless the operator explicitly asks.
- **Execution agents** implement. Engine is selectable per dispatch (`--engine sonnet|codex`); **current default: Sonnet**, max **6 concurrent** agents, each with one bounded W-task, `isolation: worktree` whenever tasks mutate files in parallel, ponytail-full active.
- **Per-task flow:** Fable brief (goal, read-first files, invariants incl. ponytail rules, machine-checkable acceptance, verification commands) → Fable ponytail critique of its own brief → agent implements lazily → agent reports files read/changed, tests run, residual risks, `ponytail:` shortcuts taken → Fable adversarial review → PR. Anything touching auth, migrations, or the event schema additionally round-trips through the operator before execution (§3 rule 8).
- **Escalation:** an agent blocked or failing acceptance twice on the same task returns it to Fable for re-scoping — agents never improvise around the brief.
- The 6-agent cap sub-divides the spin-up map in §6: Wave 1's nine parallel-safe tasks run as 6 + 3, lanes A–D each hold at most one in-flight event-schema task.

## 5. Task-by-task plan

Waves order execution; tasks within a wave are parallel-safe (disjoint files). `dep:` marks hard dependencies. Effort: XS ≤1h, S ≤half-day, M ≤2 days.

### Wave 0 — Operator actions (no PRs, do first)

| ID | Task | Effort |
|---|---|---|
| W0.1 | Scope global MCP servers out of `~/.claude.json` + `~/.codex/config.toml` (keep delamain-peers); ~2.5GB RAM back | XS |
| W0.2 | Prune `~/.delamain/worktrees` (86GB) + `git worktree prune` in source repos | XS |
| W0.3 | Fix `.wslconfig` (`[wsl2]` header active: memory, processors, autoMemoryReclaim, sparseVhd); verify repos/worktrees never under `/mnt/c` | XS |
| W0.4 | **Branch protection on `gits`: require the `quality` job.** Prerequisite for spinning multiple peers | XS |
| W0.5 | Prune `~/.claude/skills` (77) to an active profile | XS |

### Wave 1 — Drift guards & micro-fixes (all parallel-safe, one peer each)

| ID | Task | Files | Effort |
|---|---|---|---|
| W1.1 | Dependency coherence: add 9 missing catalog→overrides, unify react (→19.2.6) + claude-agent-sdk (→^0.3.154), pin node-pty exact | root `package.json`, `apps/mobile/package.json`, `scripts/package.json` | S |
| W1.2 | Migration duplicate/non-contiguous number boot guard (hard fail) | `persistence/` migration loader | S |
| W1.3 | oxlint rule: ban `@t3tools/shared` barrel imports (enforce `AGENTS.md:32`) | `oxlint-plugin-t3code` | XS |
| W1.4 | `build` dependsOn `typecheck` in `turbo.json:42-46` | `turbo.json` | XS |
| W1.5 | SQLite pragmas: `busy_timeout=30000`, `wal_autocheckpoint=1000`, `synchronous=NORMAL` | `persistence/Layers/Sqlite.ts:35` | XS |
| W1.6 | Surface Codex `thread/resume` failure (WARN + session-receipt marker, no silent fresh session) | `provider/Layers/CodexSessionRuntime.ts:476-490` | XS |
| W1.7 | `fork:` Android cleartext gated to dev variant + http: warning banner | `apps/mobile/plugins/withAndroidCleartextTraffic.cjs` | XS |
| W1.8 | systemd unit: `MemoryMax=` + `--max-old-space-size` params | `scripts/gits-hosting/install-wsl-user-service.sh:67-86` | XS |
| W1.9 | Ponytail cuts (−142 lines: adapter Shape markers, unused runtimeLayer exports) | `provider/Services/*`, `orchestration/runtimeLayer.ts` | S |

> Cut (ponytail audit of this plan): env gates for ProcessResourceMonitor / SessionReaper / Hermes stub — measured idle cost is one `ps` per 5s + one DB query per 5min + zero; flags nobody would flip. The one interval with real O(worktrees) cost is fixed structurally by W4.6.

### Wave 2 — Graveyard (Workstream 2; serialized spine W2.1→W2.2, then parallel)

| ID | Task | Depends | Files | Effort |
|---|---|---|---|---|
| W2.1 | **Design + contracts:** graveyard states (`active → retiring → buried`), orchestration events + receipts for every transition, one retention knob: `GITS_GRAVEYARD_MAX_AGE_MS` (default 7d); branches always kept (they're ~free). Operator approval required (event schema) | — | `packages/contracts`, `.plans/` note | M |
| W2.2 | Retirement path: on session reap / thread delete, capture final diff as checkpoint → await receipt → `git worktree remove` → branch preserved → emit graveyard event. Replaces naive delete; extends `ProviderSessionReaper` + `ThreadDeletionReactor` (never a new duplicate reaper) | W2.1 | `ThreadDeletionReactor.ts:58-64`, `ProviderSessionReaper.ts`, `vcs/` | M |
| W2.3 | Orphan adoption on startup: worktrees on disk with no event-store binding → adopted into graveyard, never silently deleted | W2.1 | `vcs/VcsProvisioningService.ts`, startup | S |
| W2.4 | Graveyard reaper: age-based prune of buried worktrees past the retention knob, receipts emitted | W2.2 | new layer beside ProviderSessionReaper | S |
| W2.5 | Record worktree ownership as orchestration events (layout already exists: `createWorktree` computes `worktreesDir/<repo>/<branch>`) | W2.1 | `vcs/GitVcsDriverCore.ts:2059-2080` | S |
| W2.6 | Driver-level guardrails: session-scoped VcsDriver refuses ops outside assigned worktree root, refuses force-push to protected branches, routes merge/integration to supervisor commands | W2.1 | `vcs/VcsDriver.ts`, `GitVcsDriver.ts` | M |

> Cut (ponytail audit): graveyard listing + resurrect RPC and the `resurrected` state — the preserved branch IS the listing (`git branch`), and resurrection IS the existing `createWorktree` on that branch. Revisit only if the manual flow proves painful in practice.

### Wave 3 — Reconnect resilience (Workstream: offline; parallel after design note)

| ID | Task | Files | Effort |
|---|---|---|---|
| W3.1 | Client: discard detail events ≤ `snapshotSequence`, refetch snapshot on resubscribe | `apps/web/src/store.ts:54-96` | S |
| W3.2 | Server: assert `live.sequence > snapshotSequence` on subscribe, log gaps | `apps/server/src/ws.ts:886-906` | S |
| W3.3 | Heartbeat timeout → `disconnected` phase (reconnect banner) | `apps/web/src/rpc/wsConnectionState.ts:171-176` | XS |
| W3.4 | 401 during reconnect → re-pair flow (no infinite retry) | `wsConnectionState.ts`, pairing flow | S |
| W3.5 | In-flight turn recovery: on reconnect, resume turn subscription / query outstanding turns so server-completed work surfaces. **Acceptance includes the integration test:** subscribe → kill socket mid-turn → reconnect → client state ≡ server projection (receipt-awaited, no sleeps) | `packages/client-runtime/src/wsTransport.ts:126-212` + server | M |

### Wave 4 — Orchestration performance (Workstream 1; **measure before optimizing**)

| ID | Task | Depends | Files | Effort |
|---|---|---|---|---|
| W4.1 | Profile hot path: per-stage timing (provider stdio → ingestion → decider → append → projection → push) via existing observability hooks; publish baseline numbers with 5–10 concurrent sessions | — | `packages/shared/src/observability.ts` consumers | M |
| W4.2 | Bound provider event queues (`Queue.bounded` + typed overflow) | — | `CodexSessionRuntime.ts:454`, adapters | S |
| W4.3 | Key reactors per-thread with `KeyedCoalescingWorker` **only where W4.1 shows serialization pain**; must preserve receipt semantics | W4.1 | reactor layers | M |
| W4.4 | Backpressure: flood test (huge diffs/verbose tools); UI pushes coalesce/truncate, ingestion never blocks, store never drops | W4.1 | ServerPushBus path | M |
| W4.5 | Event retention + projection rebuild command (archive closed-thread events > `GITS_EVENT_RETENTION_DAYS`, rebuild-from-events CLI; fixes no-rebuild-path P0). Operator approval (migration) | — | `OrchestrationEventStore.ts`, new migration | M |
| W4.6 | VCS poll coalescing per (`gitCommonDir`, remote) instead of per worktree | — | `VcsStatusBroadcaster.ts`, `GitVcsDriverCore.ts:51-55` | M |
| W4.7 | Cold-start check: replay time on a large event log; add periodic projection snapshots if replay dominates | W4.1 | ProjectionPipeline | M |

### Wave 5 — Security hardening (Workstream 3; W5.1 gates the rest)

| ID | Task | Depends | Files | Effort |
|---|---|---|---|---|
| W5.1 | **Plan-18 gap audit:** map every HTTP route, WS upgrade, and RPC method against `ServerAuthPolicy`; verify non-loopback bind without auth is a hard startup error (add if not); output = checklist of uncovered surfaces as follow-up tasks. Operator approval on changes | — | `auth/Layers/*`, `.plans/18-server-auth-model.md` | M |
| W5.2 | Secrets hygiene: audit `provider/Drivers/CodexHomeLayout.ts` + adapter env handling — Delamain sessions must not read each other's or the server's credentials; add redaction at ingestion boundary if provider events can carry token/env material (incl. `EventNdjsonLogger`) | — | provider Drivers/adapters, ingestion | M |
| W5.3 | Actor identity in command envelope (operator / supervisor / delamain), checked by `commandInvariants`; delamains deny-by-default for server-mutating commands (spawn, delete, config, auth). Operator approval (event schema) | W5.1 | `orchestration/commandInvariants.ts`, contracts | M |
| W5.4 | Audit-trail verification: every privileged action (session spawn, worktree op, auth change, endpoint change) emits an event; fix silent paths | W5.1 | orchestration | S |
| W5.5 | One all-migrations fixture test: run 001→latest against a seeded DB, assert final schema + key invariants (pattern: `016_CanonicalizeModelSelections.test.ts` generalized). Per-migration tests are required only for *future* data-mutating migrations, enforced by the review checklist — shipped migrations already ran on every live DB, so retro per-migration tests mostly re-prove the past | W1.2 | `persistence/Migrations/` | S |

### Wave 6 — Topologies & docs (Workstream 4)

| ID | Task | Files | Effort |
|---|---|---|---|
| W6.1 | Deploy script portability: skip Windows portproxy when `WSL_DISTRO_NAME` unset; native systemd + `tailscale serve` path for VPS; document both topologies in `REMOTE.md` style | `scripts/gits-hosting/*` | S |
| W6.2 | Recommended `.wslconfig` + localhost-forwarding vs `networkingMode=mirrored` guidance; repos-on-ext4 requirement documented | docs | XS |
| W6.3 | VPS scale profile: invert hosted defaults (short ticks, high MemoryMax) — pure config after W1.8 | deploy env | XS |

**Explicitly ignored (audit + ponytail pass):** service worker/offline cache, multi-worker orchestration engine redesign (W4.1 must justify anything beyond keyed reactors), localStorage→cookies on tailnet, changesets automation, P2 UX batch (draft debounce, IPv6, Expo splash), idle-service env gates (measured cost ≈ zero), graveyard resurrect RPC (manual `createWorktree` on the preserved branch covers it), multi-knob graveyard policy (one age knob), retroactive per-migration test batches (one all-migrations fixture test instead).

---

## 6. Peer spin-up map

Maximum safe initial parallelism (after Wave 0): **W1.1–W1.9 = up to 9 peers, zero file overlap.** Then:

- **Peer lane A (Graveyard spine):** W2.1 → W2.2 → {W2.3, W2.4} parallel; W2.5/W2.6 parallel after W2.1.
- **Peer lane B (Reconnect):** W3.1+W3.3 (web) ∥ W3.2 (server) → W3.4 → W3.5 (test included).
- **Peer lane C (Perf):** W4.1 first (sole owner of instrumentation), W4.2/W4.5/W4.6 parallel meanwhile; W4.3/W4.4/W4.7 only after W4.1's numbers.
- **Peer lane D (Security):** W5.1 first; W5.2 and W5.5 parallel anytime; W5.3/W5.4 after W5.1.
- Wave 6 anytime, one peer.

Collision rules: one peer per file cluster; `contracts` + event-schema changes serialize through lane A/D approvals; migrations serialize through W1.2's guard (contiguous numbering — coordinate next number via PR order).

## 7. Definition of done (every task) + reviewer checklist

Per task: fmt/lint/typecheck/`bun run test` green · receipts-not-sleeps tests · events+receipts for anything the operator/supervisor must observe · no new network exposure without auth · no secrets in logs or event store · summary noting rebase risk vs upstream (`fork:` prefix where upstream files changed).

Reviewers apply the full checklist in `docs/audit-2026-07.md` §"Review checklist for Codex peers", plus two harness-specific additions: **(a)** state changes only via decider commands (reject direct projection/DB writes), **(b)** worktree operations only via `VcsDriver` (reject ad-hoc `git` shell-outs in new code).
