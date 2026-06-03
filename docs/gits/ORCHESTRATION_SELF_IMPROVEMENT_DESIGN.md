# GITS Self-Improving Orchestration Design

Date: 2026-06-03
Status: DESIGN (research-backed; grounded in real `gitscode` code paths)
Research: `gits-orchestration-research` workflow (9 agents — Augment Code, mem0, self-improving multi-agent patterns, Claude SDK accelerators, + 2 codebase maps + adversarial verification). Citations in the Research Appendix.

## Goal

A **Delamain-editable orchestrator** with explicit options and self-improvement, where **Motoko (Hermes)** can (1) read and propose edits to the orchestration configuration, (2) learn from its interactions with Delamain (peer outcomes), and (3) draw on persistent memory of how the operator works — so peer coordination gets measurably better over time, while the existing safety posture is unchanged:

> **Motoko proposes · the operator approves · Delamain executes in isolated worktrees · Open GSD owns phase truth.**

No agent ever silently changes behavior. Every improvement flows through a typed proposal card → explicit human approval → a **versioned, reversible** configuration change.

## The shape the research converged on (MAPE-K, human-gated)

All four research streams converged on one safe pattern, and adversarial verification held it up: **improve agents by editing externalized artifacts (config / prompts / skills) through reflection over real outcome telemetry, and gate every change behind explicit human approval.** This is the autonomic-computing **MAPE-K** loop with the human placed at *Analyze* and *Execute* — the same posture Augment ships (Memory Review + Learning Flywheel) and BerriAI's propose-then-approve config edits use.

```
            ┌──────── (K) Knowledge: memory store + append-only config archive + decision log ────────┐
            │                                                                                          │
  (M) Monitor ─────────▶ (A) Analyze ─────────▶ (P) Plan ─────────▶ (E) Execute ──────────────────────┘
  peer-outcomes.jsonl    Motoko reflects        proposal card        operator approves →
  per terminal peer      over memory →          actionKind=          Delamain writes config-v{n+1}
  (status, cost, gates)  confidence-scored      'orchestrator-config' (only if regression gate passes;
                         reflections            + configDiff           rollback always available)
        ▲                                                                     │
        └─────────────────── next peer runs under new config; effect is measured ───────────────────┘
```

Explicitly **out of scope**: autonomous self-rewrite (Darwin-Gödel / SICA). We adopt only their *safe subset* — an append-only versioned archive with lineage and one-click rollback — and replace the "foundation-model-proposes-and-applies" step with "Motoko proposes a card the operator approves."

## Where We Are Today

| Layer | Role | Editable? | Learns? |
|---|---|---|---|
| **Delamain peers** (`delamain-peers` MCP) | Execution substrate: codex/cursor peers in isolated worktrees, one slice each; `integrate_peer` opens an auto-merge PR. State in `~/.delamain/state.json`. | Per-spawn options | No |
| **delamain-autopilot** (`scripts/supervisor.py`) | Cron supervisor over a TSV roadmap; halt-on-failure; forbidden-touch + lint/tsc/test/build gates; patch-id merge detection. | `config.json` per roadmap | No — *"opinionated, not configurable."* |
| **Automode** (`AutomodeSupervisor.ts`) | Server-owned typed dispatcher: `AutomodePolicy` (kill switch, allowlists, budget, runtime, approval gates) + goal queue; **hardcoded** regex intent classification. | `AutomodePolicy` via RPC | No |
| **Motoko / Hermes** (`HermesCliAdapter.ts`) | Observe/propose-only strategist: typed proposal cards → approve/reject/defer → execution drafts; scheduled proposal generators; capacity-aware routing hints. | n/a | No memory; no outcome feedback |

### The three gaps the goal names (confirmed against code)

1. **No editable orchestrator.** Classification (`classifyHermesChatAction`, `Layers/HermesCliAdapter.ts:566–591`), risk mapping (`actionRisk`, `:670–681`), executor mapping (`recommendedExecutor`, `:683–691`), and the policy snapshot (`policySnapshot`, `:626–639`) are **hardcoded**. `HermesSafeConfig.approvalMode` **is** read and acted on — `=== "off"` gates `hermes doctor`/check to a failed health status with a warning (`:1290`, `:1363–1379`) — but **only `'off'` is branched; `'smart'` is currently treated identically to `'manual'`** (see Review Correction R1). Options exist but are scattered across per-spawn args, the Python `config.json`, and `AutomodePolicy` — none versioned together, none readable as one contract.
2. **No peer-outcome telemetry.** `AutomodeSupervisor.dispatchGoal` (method at `:481`; spawn+record block `:562–601`) spawns a peer and records `peerId`, but the peer's terminal status, duration, and verification result are never captured — and **per-peer cost does not exist** in the codebase (the usage meter keys cost by orchestration *thread*, not peer; see R2). The `HermesProposalCard` ends at `decisionReason`/`decidedAt` (`gits.ts:1005–1027`) — there is no link from proposal → draft → peer → outcome.
3. **No memory / learning loop.** A `memory-review` schedule kind exists (`HermesScheduleKind`, `gits.ts:1088–1096`) but there is no memory store and no consolidation/scoring of operator working-style or peer outcomes.

## Target Architecture

Five additions, each grounded in a real extension point, mapped onto MAPE-K.

### A. Editable Orchestrator Config — `gits/orchestrator-config.json` (Execute surface)

A single **versioned, schema-validated** file at `config.stateDir/gits/orchestrator-config.json` (sibling to the existing `automode-state.json` written at `AutomodeSupervisor.ts:298`), read at runtime by Delamain/Automode/Motoko. This is the literal *"Delamain editable orchestrator with options"* deliverable: plain, diffable, VCS-trackable JSON, mirroring Augment's `.augment-guidelines`/Rules pattern.

It holds the things that are hardcoded today, defaulting to current values when absent (so first-run behavior is identical):

The config is **partitioned into three trust tiers** (red-team round 1 redrew this from two — see §Hardening): a **tuning** tier the loop may auto-apply within ceilings; a **sensitive** tier that *governs the approval gate or peer execution* (classifier/risk/executor overrides, peer prompts) — operator-only, or trusted-provenance + a monotonicity invariant + a distinct hard confirmation; and a **guardrail** tier only the operator edits. A poisoned proposal can neither widen a sandbox, weaken `forbiddenPaths`, *nor* downgrade an action's risk / reclassify a destructive action / inject prompt prose — those are structurally outside what the loop can auto-apply.

```ts
// packages/contracts/src/gits.ts — new
export const OrchestratorEngine = Schema.Literals(["codex", "cursor"]); // actionable only — no "unknown" (R4)

export const OrchestratorRoutingRule = Schema.Struct({
  id: TrimmedNonEmptyString,               // stable id = the structured-patch target (D6)
  match: Schema.Struct({
    repoGlob: Schema.NullOr(TrimmedNonEmptyString),
    sliceType: Schema.NullOr(Schema.Literals(["feature", "refactor", "ui", "infra", "docs", "fix", "spike"])),
    riskAtMost: Schema.NullOr(HermesProposalRisk),
  }),
  engine: OrchestratorEngine,
  model: TrimmedNonEmptyString,            // gpt-5.4 | gpt-5.5 | sonnet | composer-2-fast | ...
  rationale: SummaryString,
  weight: NonNegativeNumber,               // learned preference weight (see D)
});

// ── TUNING TIER — loop may auto-apply WITHIN guardrail ceilings; canary-measured ──
export const OrchestratorTuning = Schema.Struct({
  routingRules: Schema.Array(OrchestratorRoutingRule),       // engine + model (model from guardrails.modelAllowlist), weights only
  effortScaling: Schema.Struct({
    maxParallelPeers: NonNegativeInt,                        // clamped to guardrails.maxParallelPeersCeiling (H6/DoS)
    singlePeerSliceTypes: Schema.Array(TrimmedNonEmptyString),
  }),
  verificationSuiteRefs: Schema.Array(TrimmedNonEmptyString), // ADD-only vs guardrails.requiredVerificationSuiteRefs; cannot drop a required ref (H4)
  retryPolicy: Schema.Struct({ maxAutoRetries: NonNegativeInt }), // clamped to guardrails.maxAutoRetriesCeiling
});

// ── SENSITIVE TIER — governs the approval gate / peer execution. NOT loop-auto-appliable:
//    operator-only, OR (trusted GITS-authoritative provenance) + monotonicity invariant +
//    distinct high-friction confirmation (H1/H2). ──
export const OrchestratorSensitive = Schema.Struct({
  classifierOverrides: Schema.Array(Schema.Struct({ pattern: TrimmedNonEmptyString, actionKind: HermesProposalActionKind })),
  riskOverrides: Schema.Array(Schema.Struct({ actionKind: HermesProposalActionKind, risk: HermesProposalRisk })),
  executorOverrides: Schema.Array(Schema.Struct({ actionKind: HermesProposalActionKind, executor: HermesProposalExecutor })),
  peerPromptFragmentIds: Schema.Array(TrimmedNonEmptyString), // pick from guardrails.peerPromptAllowlist; the loop NEVER writes prompt prose (H2)
});

// ── GUARDRAIL TIER — operator-only; the loop may RECOMMEND but NEVER auto-apply (D1) ──
export const OrchestratorGuardrails = Schema.Struct({
  sandboxDefault: Schema.Literals(["read-only", "workspace-write", "danger-full-access"]),
  forbiddenPaths: Schema.Array(TrimmedNonEmptyString),       // single source of truth; rendered to autopilot config (D4)
  haltOnFirstFailure: Schema.Boolean,
  modelAllowlist: Schema.Array(TrimmedNonEmptyString),       // routingRules may only pick from this
  requiredVerificationSuiteRefs: Schema.Array(TrimmedNonEmptyString), // minimum gate; loop may only ADD (H4)
  maxParallelPeersCeiling: NonNegativeInt,                   // and maxAutoRetriesCeiling, etc. (H6)
  trustedRepoAllowlist: Schema.Array(PathString),            // only these repos' outcomes can clear a canary (H5)
  peerPromptAllowlist: Schema.Array(Schema.Struct({ id: TrimmedNonEmptyString, engine: OrchestratorEngine, fragment: SummaryString })),
  approvalFloors: Schema.Struct({                            // monotonicity floors the validator HARD-enforces (H1)
    integrateMinRisk: HermesProposalRisk,                    // no override may go below
    destructiveMinRisk: HermesProposalRisk,
    integrateExecutor: HermesProposalExecutor,               // pinned (e.g. "operator")
  }),
  // kill-switch / allowlist / budget remain in AutomodePolicy, not here
});

export const OrchestratorConfig = Schema.Struct({
  version: NonNegativeInt,
  revisionReason: Schema.NullOr(SummaryString),
  revisedBy: Schema.Literals(["operator", "motoko-proposal"]),
  sourceCardId: Schema.NullOr(TrimmedNonEmptyString),
  sourceReflectionIds: Schema.Array(TrimmedNonEmptyString), // AUTHORITATIVE provenance (R8)
  tuning: OrchestratorTuning,        // loop-auto-appliable within ceilings
  sensitive: OrchestratorSensitive,  // operator-only OR trusted-provenance + monotonic + hard-confirm
  guardrails: OrchestratorGuardrails,// operator-only
  updatedAt: IsoDateTime,
});
```

**Validator universal rule (H1).** Independent of tier, the config-validator **rejects any patch whose net effect reduces approval coverage** — lowers an actionKind's risk below its `approvalFloors`, reclassifies an `integrate`/`destructive-shell` trigger toward `read-only`, points an integrate/destructive executor away from `operator`, or removes a required verification suite. `requiresApproval` is computed from the **original** built-in classification, never the override-adjusted one. Guardrail equality is checked by **canonical deep-equal** on the parsed object (not byte-substring — defeats JSON-reserialization aliasing).

Note: `approvalMode` is **not** in this config — it is an existing `HermesSafeConfig` field that is already read and acted on (R1); the smart-ranking concern is handled separately in D, not by repurposing it here. **`AutomodePolicy` stays separate** (kill switch / allowlist / budget) as the runtime safety authority in `automode-state.json` — out of this config entirely, so a bad config edit can never disable the kill switch.

**Versioning & rollback.** Every approved edit writes an immutable `config-v{n}.json` to an append-only archive with lineage (`sourceCardId` + `sourceReflectionIds`); the active file is the highest version; rollback restores any prior version. This is the safe subset of Darwin-Gödel/SICA's archive.

### B. Peer-Outcome Telemetry — `gits/peer-outcomes.jsonl` (Monitor)

The missing learning signal. A background `monitorPeerOutcome(goalId, peerId)` Effect, spawned from `AutomodeSupervisor.dispatchGoal` (`:562–601`) and any Delamain integrate path, polls `DelamainAdapter.getPeerStatus` until a **terminal** status, then appends **one** record:

```ts
export const OrchestrationOutcome = Schema.Literals([
  "merged", "pr-open", "verification-failed", "forbidden-touch",
  "peer-failed", "halted", "killed", "abandoned", "waiting-timeout",
]);

export const PeerOutcome = Schema.Struct({
  peerId: TrimmedNonEmptyString,
  cardId: Schema.NullOr(TrimmedNonEmptyString),     // links proposal → draft → peer
  goalId: Schema.NullOr(TrimmedNonEmptyString),
  configVersion: NonNegativeInt,                    // which config produced it → A/B over versions
  repo: PathString, engine: DelamainEngine, model: Schema.NullOr(TrimmedNonEmptyString),
  sliceType: Schema.NullOr(TrimmedNonEmptyString),
  outcome: OrchestrationOutcome,
  reason: Schema.NullOr(SummaryString),
  waitingRoundTrips: NonNegativeInt,                // how many times the peer needed help
  verificationResult: Schema.Array(Schema.Struct({ label: TrimmedNonEmptyString, passed: Schema.Boolean })),
  forbiddenTouchViolation: Schema.Boolean,
  durationMs: Schema.NullOr(NonNegativeInt),
  costUsd: Schema.NullOr(NonNegativeNumber),
  startedAt: IsoDateTime, finishedAt: Schema.NullOr(IsoDateTime),
});
```

Sources: terminal status + `integrationStatus`/`prUrl` from `DelamainPeer`; verification + forbidden-touch from the **delamain-autopilot gates reused as the empirical fitness function**; `durationMs` **derived** (`finishedAt − startedAt`); `waitingRoundTrips` from `send_peer_reply` count. **`costUsd` is NOT currently sourceable per-peer** — the usage meter keys cost by orchestration *thread*, not peer (correction R2); leave it null or scope the peer-cost-attribution work explicitly. **Must handle every terminal status** — `done`, `completed`, `failed`, `frozen`, `killed`, `halted` (note both `done` *and* `completed`, correction R3); biasing toward successes would corrupt learning (see Risks).

### C. Operator Memory — `MemoryStore` service (Knowledge / Analyze)

A tagged `MemoryStore` Effect service (mirroring `HermesAdapter`/`DelamainAdapter`) with a Live layer and a test stub. **Three logical tiers** (Augment's Expert memory layers, adapted to a single operator):

- **(a) Raw episodes** — `peer_outcome` + `decision` entries; the append-mostly evidence base.
- **(b) Reflections** — confidence-scored heuristics *with trigger conditions* (e.g. *"cursor peers fail tsc on monorepo refactor slices (conf 0.8, n=6)"*; *"operator rejects integrate cards whose verificationPlan lacks a dry-run (conf 0.9, n=4)"*). Written only by the consolidation job; decayed over time. These — **not raw logs** — become the `evidence[]` Motoko cites in cards. (AgentCore: reflections beat replay.)
- **(c) Operator working-style** — explicit preferences that condition routing/risk; **pending until approved** (Augment Memory Review: approve/edit/discard before persist), preventing low-quality pile-up.

**Four-axis scoping** (the one durable mem0 idea that survived verification): every entry tagged `operatorId` (user) · `repoSlug` (app) · `engine|'motoko'` (agent) · `runId` (peer/goal id), with structured `metadata` (`kind`, `risk`, `actionKind`, `verificationResult`, `decision`, `cardId`, `confidence`, `ts`).

**Backend:** raw telemetry stays in `peer-outcomes.jsonl` (zero dependency, matches `automode-state.json` conventions). The shared reflections/operator-style store is the **operator-directed shared substrate** in section C′ (**Basic Memory**, decided). The native Claude memory tool is retained separately as **Motoko's private scratch** (its own reasoning), distinct from the shared cross-agent store — keep both, do not conflate. Semantic-recall upgrade path is **SQLite + sqlite-vec** co-located in the existing `@effect/sql-sqlite-bun` DB (the codebase uses **SQLite, not Postgres/pgvector**), or the Graphiti temporal path (C′). **Not mem0** (Open Decision 3 / appendix). **GITS owns consolidation + decay** (a periodic Effect job) — and because the chosen backend deliberately provides none, that ownership is clean rather than fighting a second engine.

### C′. Shared Multi-Agent Memory (operator-directed expansion)

The operator's decision reframes memory from "Motoko's private store" to a **shared substrate every agent can use** — Motoko, codex peers, cursor peers, and operator-side Claude — so a lesson learned by one agent benefits all. The design separates the **abstraction** (stable) from the **backend** (chosen by the *Shared Memory Research Appendix*).

Stable design frame (holds regardless of backend):

- **`MemoryStore` stays the server-side Effect abstraction** (section C). GITS-internal writes (peer outcomes, decisions, reflections) flow through it, so the kill-switch/budget policy still governs writes and secrets stay server-mediated.
- **The raw Basic Memory store is NOT exposed to peers.** It binds to localhost and is reachable only by the GITS server. Peers attach instead to a thin **GITS-mediated memory MCP** (a GITS-owned MCP server, seeded per-worktree via `.codex/config.toml`/`.cursor/mcp.json`/`.mcp.json`). This is the structural answer to D2: the trust boundary is code-enforced at the proxy, not an honor-system convention on a no-ACL store. (Net-new work: Delamain spawns peers via CLI today (`spawnArgs` in `DelamainCliAdapter`) with no MCP seeding; the per-worktree seed must be added. The transport from peers to the proxy is Streamable HTTP — stdio can't share a single proxy across peers.)
- **Write boundaries (D1).** The mediated proxy is the *only* writer to the backing store. On every peer write it (a) **stamps provenance** — writing principal (`peerId`/`engine`/`repo`/`runId`), (b) **confines the note to that peer's own `runId` namespace** (a peer cannot address `gits-shared` or another run), and (c) marks it **`trust: untrusted`** (tier a). The curated `gits-shared` tier (tier b reflections) is written **only** by the GITS consolidation job; operator-style memory (tier c) only via Memory Review. GITS-authoritative records (PeerOutcome, decisions, approved reflections) flow through `MemoryStore` server-side.
- **Poison containment (D1).** Untrusted peer notes are never promoted to a reflection without the consolidation job, and a reflection that would touch a **guardrail** field (sandbox, `forbiddenPaths`, allowlists) is structurally impossible to auto-apply (guardrails are operator-only, §A). Any card whose `sourceReflectionIds` trace to untrusted-only provenance is flagged **"low-trust provenance"** and the cockpit shows the lineage chain to the originating notes — the operator audits lineage, never confidence alone. The consolidation job also runs a cheap **anomaly check** that quarantines notes advocating privilege escalation (sandbox widening, guardrail weakening, allowlist additions) rather than distilling them.
- **Scoping (R9).** Start with `repoSlug` + `runId` + the shared tier (single operator today; `operatorId` is constant — add it when a second operator exists). The shared tier is the only globally-*readable* namespace; per-run namespaces are read-isolated through the proxy.
- **Backend must be:** OSS, self-hostable/local (secrets-never-leave-local), MCP-exposed (read+write), multi-agent-scoped, maintained. **Candidate substrate + MCP topology: see the Shared Memory Research Appendix** (`shared-memory-research` workflow — in progress).

This keeps the loop in D backend-agnostic: Motoko reads reflections (via `MemoryStore` or the MCP server) and the chosen backend is swappable without touching the proposal/approval machinery.

### D. Motoko Learning Loop → `orchestrator-config` cards (Analyze → Plan → Execute)

Motoko gains read access to telemetry + memory and a new approval-required proposal action kind that targets the config itself:

```ts
// additive — no breaking change to existing kinds
export const HermesProposalActionKind = Schema.Literals([
  "read-only", "worktree-spawn", "repo-write", "integrate", "destructive-shell",
  "orchestrator-config",   // NEW: versioned config patch (risk medium, executor delamain, requiresApproval)
  "memory-write",          // NEW: durable operator-memory item (Memory Review gate)
]);

// added to HermesProposalCard (optional → no migration):
// STRUCTURED patch, not free-text (D6): RFC-6902-style ops over JSON Pointers, with
// optimistic concurrency on the base version. Apply rejects if base != current.
export const OrchestratorConfigOp = Schema.Struct({
  op: Schema.Literals(["replace", "add", "remove"]),
  path: TrimmedNonEmptyString,                   // JSON Pointer, MUST be under /tuning (guardrails are operator-only, §A)
  value: Schema.NullOr(Schema.Unknown),
});
export const OrchestratorConfigPatch = Schema.Struct({
  baseVersion: NonNegativeInt,                   // must equal the active config.version or apply is rejected
  ops: Schema.Array(OrchestratorConfigOp),       // every path validated to start with "/tuning/"
  expectedEffect: SummaryString,
  measuredBy: SummaryString,                      // which PeerOutcome objective should move (Pareto, see D3)
});
// HermesProposalCard gains: configPatch: Schema.NullOr(OrchestratorConfigPatch), sourceReflectionIds: Schema.Array(...)
```

The closed loop (all paths real):

1. **Monitor** — peer terminates → `monitorPeerOutcome` appends a `PeerOutcome` (B) and calls `MemoryStore.recordPeerOutcome` (raw).
2. **Knowledge write** — `decideProposal` (`HermesCliAdapter.ts:1696`) calls `MemoryStore.recordDecision` on every approve/reject/defer (it already persists `decisionReason`/`decidedAt`).
3. **Analyze** — a periodic **deterministic** consolidation job (not an LLM `makeChat`, R7/D7) reads both streams, computes per-(repo,engine,sliceType) success/rework/cost aggregates, distils confidence-scored reflections **with trigger conditions**, applies time-decay, and stamps a `lastConsolidatedAt` watermark. An *optional, budgeted* LLM summarization step may add prose, but the numbers are mechanical. Reflections older than the watermark threshold are marked **stale** and the cockpit surfaces "knowledge tier stale" (D7). The anomaly check (§C′) quarantines escalation-advocating notes here.
4. **Plan** — Motoko emits a card with `actionKind:'orchestrator-config'`, a structured `configPatch` (ops under `/tuning` only), `sourceReflectionIds[]` (authoritative provenance, R8), a Pareto `measuredBy`, and a **provenance trust flag** if any cited reflection is untrusted-only. *Example: "Raise `routingRules[id=refactor].weight` for codex; cursor failed tsc 4/6 on refactor slices (conf 0.8, n=6)."* A patch that needs a guardrail change can only **recommend** it (operator edits §A guardrails by hand).
5. **Execute (human gate → separate gated executor, D5).** The card surfaces in the cockpit; `decideProposal` only **records** the decision (it stays approval-only / handoff-only — it is NOT wired to mutate state). On approve, a distinct **`OrchestratorConfigExecutor`** service: (i) re-checks `configPatch.baseVersion == active.version` (optimistic concurrency, D6); (ii) runs a **config validator** — schema-valid, all ops under `/tuning`, guardrail zone byte-identical, version monotonic, kill-switch/`AutomodePolicy` untouched (this replaces the meaningless lint/tsc/test/build "regression gate" for config, which has no diff to grade, D3); (iii) writes `config-v{n+1}` to the archive and marks it **canary**, not active-for-all. `draftFromProposal`/`draftKindFor` (`:1797–1807`) are unchanged (repo artifacts only). On reject/defer nothing applies; the reasoning becomes a future reflection (step 2).
6. **Canary → promote / auto-rollback (D3).** The canary version applies to the next *N* dispatches (or a fraction); the loop measures the Pareto objectives (`verification-pass`, `cost`, `forbidden-touch`, rework, time-to-merge) against the prior version's baseline. If no objective regresses past threshold, it promotes to active-for-all; otherwise it **auto-rolls back** to the prior version and records the failed experiment as a negative reflection. Real fitness is this downstream measurement, not an instant approval-time gate.

**Ranking, not autonomy (R1/Decision 4).** `HermesSafeConfig.approvalMode` is already read and acts on `'off'` (gates health) — it is **not** repurposed here. A separate lightweight preference scorer (a new field/flag, not an overload of `'smart'`) ranks/auto-defers low-confidence cards and surfaces "operator usually rejects this", **never auto-approves**. At single-operator volume it is ranking-only until enough labels accrue to calibrate (don't claim calibration early).

### E. Skills as the Editable Playbook + Self-Improvement Engine

The orchestration playbook and Motoko's procedures are encoded as **Agent Skills**, and **skill-creator** (Create/Eval/Improve/Benchmark) is the self-improvement engine for them, wired to the existing `GitsSkillInventory` / Skills Intelligence HERMES improvement queue (488 skills, 40 Hermes candidates today): Motoko proposes a skill edit → operator approves → skill-creator rewrites `SKILL.md` and reruns ≥3 evals before write-back. A **Voyager-style recipe library** of verified vertical-slice prompts/configs is admitted only after the verification gates pass.

## Build Accelerators (from the Claude SDK research)

- **Claude Agent SDK (TypeScript)** as the supervisor substrate inside `apps/server` — same engine as Claude Code, fits the Effect monorepo; exposes hooks/subagents/MCP/skills programmatically. Set `settingSources:['user','project']` so skills load; enforce tools via `allowedTools`+`canUseTool` (SKILL.md `allowed-tools` frontmatter is ignored under the SDK).
- **Hooks for governance + learning triggers:** `PreToolUse` (fail-closed, exit 2 / `permissionDecision:'deny'`) to enforce kill-switch/allowlist/destructive-shell block, layered over the Effect `AutomodeSupervisor`; `SubagentStop`/`PostToolUse` to capture peer outcomes; `SessionStart` to inject the orchestrator-config + project snapshot.
- **Native Claude memory tool** (custom `betaMemoryTool` backend under `~/.gits/motoko-memory`) for ZDR-eligible cross-session learning — primary memory choice.
- **delamain-peers MCP + git worktrees** remain the **only** execution substrate (SDK "skills" filtering is not a sandbox).
- **Effect Schema** in `packages/contracts/src/gits.ts` for the new `OrchestratorConfig` and the extended `HermesProposalCard`.

## Safety Invariants (extended by the D1–D7 resolutions)

- Motoko stays observe/propose-only. `orchestrator-config` and `memory-write` are approval-required.
- **Zone partition (D1):** the self-improvement loop may auto-apply only the **tuning** zone; the **guardrail** zone (sandbox default, `forbiddenPaths`, halt policy) and `AutomodePolicy` (kill switch / allowlist / budget) are operator-only. A patch with any op outside `/tuning` is rejected by the executor.
- **Mediated memory writes (D2):** peers never write the shared store directly; the GITS proxy stamps provenance, confines each note to its own `runId`, and marks it untrusted. Only the consolidation job writes the curated tier. "Isolation by convention" is replaced by a code-enforced boundary.
- **Lineage over confidence (D1):** every config version and card carries authoritative `sourceReflectionIds`; cards citing untrusted-only provenance are flagged, and the operator audits the lineage chain — confidence score alone never justifies a guardrail-adjacent change.
- Every behavior change is a **versioned, reversible** config revision with recorded reason, author, and lineage; promotion is **canary-gated** with auto-rollback (D3).
- **Fitness is external and downstream.** For *code* it is the real lint/tsc/test/build + forbidden-touch + patch-id gates; for *config* it is the config-validator (structural) + canary-measured PeerOutcome over future dispatches — never lint/tsc/test/build (which has no config diff to grade), and never Motoko grading its own proposals.
- Memory that would change automation is proposed before it is durable; raw observation is always allowed.
- Self-modifying autonomy is excluded; the FM-proposes step is always a card the operator approves, applied by a **separate gated executor** (not `decideProposal`, D5). **This includes Motoko's own prompt/SOUL and the peer/agent skills** — they are guardrail-class; the loop may not edit the agents *in* the loop (H9).
- **Execution confinement is a prerequisite, not an add-on (H0).** The entire trust model is void unless peers **and** the verification suite run under real OS-level confinement (container/namespace/seccomp/bubblewrap) whose only writable mount is the worktree, with secrets (`.env`, `auth.json`, `telegram.env`) absent from `HOME`/`PATH`, GITS state/skill-roots/memory on a different uid, installs run `--ignore-scripts`, and no `--yolo`/`danger-full-access`/`--force --trust` for any peer touching an untrusted repo. Without this, a hostile repo simply writes server state directly and the proxy/zones are moot.
- **Peer↔memory is an authenticated, scoped channel (H3):** a per-peer server-minted secret (injected outside the worktree, revoked at terminal) authenticates the proxy connection; scope is derived server-side from the secret, never from a tool argument; reads are confined to the peer's own `runId`+`repo`; operator working-style is never peer-readable.

## Phased Roadmap

Preserves the existing rule — **observable state first, control second, automation last.**

- **Phase 0 — Telemetry + audit (Monitor) + confinement spike (H0).** `monitorPeerOutcome` (reusing `waitForPeer`, R7) from `dispatchGoal`; `peer-outcomes.jsonl`; reuse autopilot gates for `verificationResult`; structured decision log from `decideProposal`; surface per-iteration metrics. *No behavior change.* **Gating prerequisite for everything downstream: a confinement spike** — peers + verification under OS-level isolation, secrets out of `HOME`/`PATH`, `--ignore-scripts`, no privilege-bypass on untrusted repos (H0). Nothing in Phases 2–3 (shared memory, loop auto-apply) ships until H0 holds.
- **Phase 1 — Editable config, read-only first (Execute surface).** `OrchestratorConfig` schema; `orchestrator-config.json` with defaults equal to today's hardcoded values; refactor `classifyHermesChatAction`/`actionRisk`/`recommendedExecutor`/`policySnapshot` to read it; append-only `config-v{n}.json` archive + rollback (operator-edited at first).
- **Phase 2 — Shared memory + reflection (Analyze).**
  - **2a:** stand up one local **Basic Memory** instance + HTTP MCP endpoint on the tailnet; implement `MemoryStore` Live over it with four-axis scoping + a test stub; wire `recordPeerOutcome`/`recordDecision`. (Keep the native Claude memory tool as Motoko's *private* scratch — two distinct stores.)
  - **2b:** stand up the **GITS-mediated memory proxy** (provenance-stamping, run-scoped, anomaly check); seed each peer's MCP config (`.codex/config.toml` / `.cursor/mcp.json` / `.mcp.json`) to point at the *proxy* (never the raw store, D2); pre-trust it for headless codex; keep the cursor tool surface under the ~40-tool cap.
  - **2c:** **deterministic** consolidation job distils reflections into the `gits-shared` tier + decay + `lastConsolidatedAt` watermark + staleness surfacing; Memory-Review approve/edit/discard for operator-style memories.
- **Phase 3 — Self-improving proposal loop (full MAPE-K close).** `orchestrator-config` actionKind + structured `configPatch` (ops under `/tuning` only) + authoritative `sourceReflectionIds`; Motoko emits config cards from reflections; the **`OrchestratorConfigExecutor`** (separate from `decideProposal`, D5) validates (config-validator + base-version, D3/D6), writes a **canary** version, then promotes/auto-rolls-back on measured PeerOutcome; standalone preference ranker (rank+auto-defer, never auto-approve; not an `approvalMode` overload). Guardrail-zone changes remain operator-only.
- **Phase 4 — Skill library + routing optimization (compounding, optional).** Voyager-style verified recipe library via skill-creator + `GitsSkillInventory`; learned `routingRules`; offline GEPA/DSPy prompt optimization whose output is itself a reviewed card; single-peer escape-hatch heuristic.

## Decisions (operator-confirmed 2026-06-03) + Open Items

1. **Config vs `AutomodePolicy` relationship** → **DECIDED: a new `orchestrator-config.json` ABOVE `AutomodePolicy`, internally split into three trust tiers** (tuning / sensitive / guardrail — see §A + §Hardening H1). The loop auto-applies only the tuning tier within guardrail ceilings; gate-governing and prompt fields are sensitive (operator-only or trusted+monotonic+hard-confirm); `AutomodePolicy` stays the separate kill-switch/budget authority. A bad config edit can neither disable the kill switch nor weaken the approval gate.
2. **How a config edit is applied** → **DECIDED (post-review): a separate, gated `OrchestratorConfigExecutor`** applies the change server-side after approval — `decideProposal` stays approval-only (D5). The executor checks optimistic concurrency + a **config validator** (not lint/tsc/test/build, which can't grade server state — D3), writes a **canary** version, then promotes or auto-rolls-back on measured PeerOutcome. Archive + rollback + lineage throughout. `draftFromProposal` (Delamain/repo path) is reserved for in-repo artifacts (skills, CLAUDE.md).
3. **Memory backend** → **RESOLVED (operator-directed shared substrate):** **Basic Memory** (basicmachines-co/basic-memory) as the primary shared store — the only surveyed system with a *verification-confirmed* "one store shared across codex + cursor + Claude Code, read+write" claim, fully local (Markdown + SQLite + local FastEmbed), native first-party HTTP MCP server, git-auditable. **Graphiti** is the named temporal-upgrade behind the same `MemoryStore` seam. mem0/Letta/Zep/Supermemory rejected (reasons in the appendix). Details: section **C′** + **Shared Memory Research Appendix**.
4. **`approvalMode='smart'` autonomy ceiling** → **DECIDED: rank + auto-DEFER low-confidence cards, never auto-approve.** Auto-approval reintroduces the silent-self-modification risk the whole design exists to avoid.

## Key Risks

- **Outcome attribution / biased signal** — must capture *every* terminal status (frozen/killed/timeout/halt), not just successes.
- **Self-evaluation plateau** — keep the fitness external (real gates), never Motoko-judges-Motoko.
- **Metric-gaming** — the fitness must include safety/forbidden-touch checks, not just pass rates (Darwin-Gödel warning).
- **Memory pile-up** — enforce pending→approve/edit/discard + decay from day one.
- **Config blast radius** — keep kill-switch authority out of the self-editable config; require the regression suite; one-click rollback.
- **Alert fatigue / cost** — gate scheduled frequency + fan-out behind manual-flow stability and the bandit confidence threshold; budget consolidation via existing Automode limits.
- **Provenance** — every archived config version must record who/which-evidence/lineage.

## Extension Points (real files)

| Addition | Attaches at |
|---|---|
| `OrchestratorConfig` + extended `HermesProposalCard` | `packages/contracts/src/gits.ts` (beside `AutomodePolicy`, `:975`) |
| Config service + versioned archive | new `apps/server/src/gits/{Services,Layers}/OrchestratorConfig.ts` (mirror `AutomodeSupervisor` load/persist at `:298`) |
| Read config instead of hardcoding | `classifyHermesChatAction:566`, `actionRisk:670`, `recommendedExecutor:683`, `policySnapshot:626` |
| Telemetry hook | `AutomodeSupervisor.dispatchGoal:562–601` + `DelamainAdapter.getPeerStatus` |
| Memory service | new `apps/server/src/gits/{Services,Layers}/MemoryStore.ts` |
| Decision → memory | `decideProposal:1696` |
| Consolidation / config cards | `runSchedule:1887` (`memory-review`), `draftFromProposal:1807` / `draftKindFor:1797` |
| Fitness gates | delamain-autopilot lint/tsc/test/build + forbidden-touch + patch-id |

---

## Prior-Art Validation, Borrows & Context Graph

Full comparison: `ORCHESTRATION_PRIOR_ART.md`. Interactive graph: `docs/gits/graphify-out/graph.html` (+ `GRAPH_REPORT.md`).

**Verdict:** the chosen method is **sound and novel in composition, not in any single component.** No popular OSS repo combines worktree-isolated peers + self-improvement + an editable config artifact + a human gate; the field splits into *ungoverned self-improvement* (Darwin-Gödel/SICA/Maestro/Ruflo) and *governed non-self-improvement* (OpenHands/Kilo/LangGraph/HumanLayer). GITS occupies the empty, defensible quadrant between them. The context graph's god node is `orchestrator-config.json`; its top cross-community bridges (Maestro ≈ Motoko loop; Ruflo = anti-pattern; DSPy = borrow) confirm the prior-art map.

**Borrows folded into the design:**
1. **Immutable append-only event ledger (OpenHands)** — the Episode Ledger (B) is immutable events from day 1.
2. **Pareto multi-objective fitness (GEPA)** — the fitness signal keeps `verification-pass`, `cost`, `forbidden-touch` as *separate* objectives; never collapse to one scalar (ties into R5/R6 below).
3. **Reflective-trace-prioritized edits (Maestro/Trace)** — Motoko targets *which* config knob a failure implicates from trace feedback, not blind search.
4. **Self-attribution / credit-assignment (AgentEvolver)** — episodes attribute outcome to specific config choices.
5. **Diff-vs-parent review panel (Kilo Code)** — cockpit shows config diff and peer diff side-by-side.
6. **HITL primitives (HumanLayer async approval + LangGraph interrupt/checkpoint)** — reuse for approval UX; GITS gates at the coarser config-version-promotion level.
7. **AGENTS.md cross-tool convention** — complements the shared Basic Memory MCP store as a portable, natively-readable memory surface.

**New risk from prior art:** the human gate may throttle the gains DGM/Maestro get from automation → **instrument the cost of the gate** (peer success / rework / approval-rate / time-to-merge) vs. an ungated baseline.

## Review Findings & Required Corrections (`/code-review` high, 2026-06-03)

A 7-angle recall review (42 candidates → verified) of this doc against the real code. Genuine design flaws to resolve before Phase 3, plus factual corrections.

> **STATUS — all items RESOLVED (2026-06-03)** in the revised sections above:
> **D1** (poisoning) → §A zone partition + §C′ mediated proxy/provenance/anomaly + lineage-over-confidence; **D2** (no ACL) → §C′ GITS-mediated proxy (raw store localhost-only); **D3** (false-assurance gate) → §D config-validator + canary/auto-rollback (Decision 2); **D4** (config duplication) → §A `verificationSuiteRefs` + `forbiddenPaths` single-source rendered to autopilot; **D5** (`decideProposal` execution) → §D separate `OrchestratorConfigExecutor`; **D6** (brittle exact-match) → §D structured `OrchestratorConfigPatch` (JSON Pointer + `baseVersion`); **D7** (consolidation liveness) → §D deterministic job + `lastConsolidatedAt` staleness. **R1** approvalMode (Gap 1 + §D), **R2** costUsd (§B), **R3** `completed` status (§B), **R4** engine enum (§A `OrchestratorEngine`), **R8** lineage authority (§A/§D), **R9** scoping (§C′) — all applied. **R5** (`HermesDraftKind` extension), **R6** (stale anchors), **R7** (reuse `waitForPeer` / deterministic consolidation) noted for implementation.

### Design flaws to resolve (blocking the self-improvement loop)

- **D1 🔴 CRITICAL — memory-poisoning chain.** Peers write **un-brokered** to shared memory (C′); the consolidation job distils tier-a notes into tier-b reflections; Motoko cites those as `evidence[]` in `orchestrator-config` cards. But **Memory Review only gates tier-c operator-style memories — not the routing/peer-outcome reflections that drive config cards.** A peer on a hostile repo can write a crafted note → high-confidence reflection → a card proposing `sandbox: danger-full-access` or dropping a `forbiddenPaths` entry → operator approves on the (poisoned) evidence trail. **Fix:** (a) treat all peer-written memory as untrusted, content-isolated, and **provenance-tagged by writing peer**; (b) put **tier-b reflections that touch routing/sandbox/forbiddenPaths behind an approval/anomaly gate too**, not just tier-c; (c) the most security-sensitive config fields (`sandbox`, `forbiddenPaths`, allowlists) should require operator review that *audits lineage to source notes*, never trust confidence alone; (d) consider server-mediated writes for peers rather than direct MCP writes to a no-ACL store.
- **D2 🟠 No per-tenant ACL on the shared MCP store.** "Only the consolidation job writes `gits-shared`" is an honor-system convention, unenforceable at the MCP layer — any peer pointed at the URL has full read+write to all scopes. **Fix:** front the store with a thin GITS-mediated write proxy (peers POST to a GITS endpoint that enforces scope + provenance), or run a per-scope endpoint; do not expose the raw shared-write surface to peers.
- **D3 🟠 The regression gate gives false assurance for *config* edits.** lint/tsc/test/build (the autopilot gates) run against a peer **worktree diff**; a config edit is **server state with no diff/compilable artifact**, so the gates pass trivially regardless of whether the change is good or harmful. **Fix:** the pre-write gate for config cards must be a *config-specific* validator (schema-validity, invariant checks — e.g. "kill-switch fields unchanged", "no sandbox widening without explicit high-risk approval", "forbiddenPaths not weakened") plus a **shadow/canary**: apply to the next *N* dispatches and measure PeerOutcome before promoting. Real fitness is downstream telemetry, not an instant gate — reframe accordingly.
- **D4 🟠 `verificationSuites`/`forbiddenPaths`/`retryPolicy` duplicate the autopilot `config.json`.** The autopilot `supervisor.py` keeps reading its own `config.json`, so Motoko's edits to `orchestrator-config.json` would be **ignored by the gate that actually runs**. **Fix:** single source of truth — either the autopilot reads these from the orchestrator-config (export/render), or orchestrator-config *references a suite by id* and does not redeclare it.
- **D5 🟠 `decideProposal` does not execute — and must not be made to.** Today it only flips status and marks non-read-only approvals "handoff-only" (`hermesDirectExecutionBlocked`). Wiring config-apply *into* `decideProposal` creates a brand-new auto-execute-on-approve path that violates the approval≠execution posture. **Fix:** add a **separate, explicitly-gated config executor** invoked after approval, not a reuse of `decideProposal`; resolve the three conflicting "who writes" statements (Decision 2 server-write vs `draftFromProposal` path vs "Delamain writes") to **one** model — recommend: server-side config executor, `draftFromProposal` unchanged for repo artifacts.
- **D6 🟠 Exact-match `originalSnippet` is brittle on regenerated JSON.** Config is `JSON.stringify(…, null, 2)` with mutating metadata; verbatim match drifts on whitespace/key-order/reformat (zero match) or collides for short snippets (multi-match). **Fix:** target a **structured path** (routing-rule `id` / JSON Pointer / RFC-6902 patch with optimistic `basePlaybookVersion`), not free text.
- **D7 🟠 Consolidation job has no liveness/staleness guard.** It runs on the best-effort `runSchedule` path (LLM call, env-gated). If it silently stops, reflections rot and cards cite stale evidence. **Fix:** staleness watermark on reflections; surface "knowledge tier stale" in the cockpit; make consolidation a **deterministic aggregation** pass (not a full LLM `makeChat` invocation — see R7) with a separate optional LLM summarization step.

### Factual corrections (apply when implementing)

- **R1** — `HermesSafeConfig.approvalMode` is **not unused**: `=== "off"` gates `hermes doctor`/check to failed + warning (`HermesCliAdapter.ts:1290`, `:1363–1379`); parsed at `:408–415`. Only `'smart'` lacks a distinct branch (treated as `'manual'`). Repurposing `'smart'` to bandit-auto-defer **silently changes behavior** for an operator who already set `mode: smart` (a documented, safe value) — so it needs an explicit migration/opt-in, or use a *new* field rather than overloading `'smart'`. (Corrected inline in Gap 1.)
- **R2** — **Per-peer `costUsd` is unsourceable today.** `AutomodeUsageMeter` keys cost by orchestration *thread* (`costByThread`), not peer; `DelamainPeer` has no cost field; there is no peer→thread link. Either scope the work to thread cost, or add peer-cost attribution explicitly (unscoped today — don't assume Phase 0 is "telemetry only"). `durationMs` must be derived (`finishedAt − startedAt`).
- **R3** — Terminal-status list must include **`completed`** (PeerStatus has both `done` *and* `completed`, `gits.ts:121–133`); omitting it drops successful terminations and biases the signal — the exact failure mode the doc warns about.
- **R4** — New schemas type `engine` as `DelamainEngine`, which includes **`"unknown"`**; constrain routing-rule/PeerOutcome engine to `codex | cursor` (a literal subset) so no non-actionable target is authored.
- **R5** — `draftKindFor`/`HermesDraftKind` only returns `delamain-peer | open-gsd | verification`; the `orchestrator-config`/`memory-write` path needs `HermesDraftKind` extended too, or it falls through to a `delamain-peer` draft.
- **R6** — Stale line/path anchors: `HermesProposalCard` `gits.ts:1005–1027` (not :975); `HermesScheduleKind` `:1088–1096` (not :1058); `AutomodePolicy` `:552`; `dispatchGoal` method at `:481`; automode persist via `persistAutomodeState` (`:106`/`:328`, atomic `writeFileStringAtomically`) not the path-join at `:298`; server adapters live under `apps/server/src/gits/Layers/`.
- **R7** — `monitorPeerOutcome` should **reuse `waitForPeer`** (already polls `getPeerStatus` to terminal) and/or the existing per-peer `scheduleRuntimeLimit` fiber, instead of forking a *second* 2s subprocess-spawning poll loop per peer; and consolidation should be deterministic aggregation, not an LLM `makeChat` per cycle (token blow-up).
- **R8** — Lineage is spread across three fields (`evidence[]` free-text, card `sourceReflectionIds[]`, `OrchestratorConfig.sourceReflectionIds`); make **`sourceReflectionIds[]` the authoritative provenance**, with `evidence[]` as human-readable rendering only.
- **R9 (simplification)** — Four-axis scoping + shared/private tiers is over-built at single-operator scale (`operatorId` is constant). Start with **`repoSlug` + `runId`** + the shared tier; add `operatorId` when a second operator exists. The bandit ranker (R/`smart`) also lacks signal at single-operator volume — keep it ranking-only and don't claim calibration early.

## Hardening (Red-Team Round 1, 2026-06-03)

A 4-angle adversarial red-team (24 attacks → 22 survived triage; 8 REAL, 14 PARTIAL) against the D1–D7 resolutions. Threat model: the attacker controls what a peer ingests (hostile repo README/comments/fixtures/task-prompt) but not the GITS server; the operator is busy and tends to trust the evidence trail. The survivors collapse into nine hardening requirements. **H0 and H3 are foundational — the rest assume them.**

- **H0 🔴 Confine execution (prerequisite).** Two REAL criticals: (a) peers run with host access (`cursor --force --trust`, codex `--yolo`/`danger-full-access`) so a peer can escape the worktree and write GITS state / skills / the memory store directly — bypassing the proxy and zones entirely; (b) the verification gate executes the **hostile repo's own npm/test scripts unsandboxed on the GITS host with secrets present** — that is remote code execution, not a scoping problem. **Fix:** run peers *and* verification under OS-level confinement (writable set = worktree only), secrets out of `HOME`/`PATH`, GITS state/skill-roots/memory on a different uid/mount, `--ignore-scripts` on installs, server-pinned verification argv (never repo `package.json` scripts), no privilege-bypass flags on untrusted repos. *Until H0 holds, the trust model does not.* **Feasibility confirmed** by `spikes/h0-confinement/` (bubblewrap; 10/10 threat+usability checks) — see its `SPIKE_FINDINGS.md` (key result: verification can run fully confined/net-off/secret-free, the high-value first step; peer execution needs minimal-cred binding + an egress allowlist).
- **H1 🔴 Gate-governing fields are not loop-auto-appliable.** `classifierOverrides`/`riskOverrides`/`executorOverrides` moved to the **sensitive tier** (operator-only or trusted-provenance + monotonic + hard-confirm). Validator universal rule: reject any patch that lowers risk below `approvalFloors`, reclassifies integrate/destructive toward read-only, or redirects their executor; compute `requiresApproval` from the **original** classification. New canary objective **approval-gate integrity** (fraction of integrate/destructive dispatches reaching the operator must not drop) so gate-weakening auto-rolls-back instead of auto-promoting.
- **H2 🔴 No loop-authored prompt prose.** `perEnginePeerPrompt` free text → replaced by `peerPromptFragmentIds` picking from an operator-curated frozen `peerPromptAllowlist`. A secret-reference/injection scanner runs over any prompt surface; the autopilot's hard-redaction policy applies to *all* peer-prompt paths; the proxy strips secret-looking content from peer status/PR text before it reaches the operator.
- **H3 🔴 Authenticated, server-derived memory scope.** Per-peer secret minted at spawn (outside the worktree, 0600/env, revoked at terminal); proxy derives `runId`/`repo`/`engine` from the secret, ignores tool-arg scope; reads confined to own `runId`+`repo`; operator working-style server-side only; read-side egress filter + alert on large shared-tier reads (closes scope-spoofing **and** read-side exfiltration).
- **H4 🟠 Fitness surface can't be shrunk or forged.** `requiredVerificationSuiteRefs` is a guardrail minimum the loop can only ADD to; canary treats shrinking verification coverage as a regression; canary objectives computed only over the `trustedRepoAllowlist` cohort with server-pinned suites (a single hostile repo's green outcomes can never promote a global config); outcomes whose verification resolved to repo-local scripts are "untrusted fitness" that alone can't clear a canary.
- **H5 🟠 Provenance-aware aggregation (anti-laundering).** Consolidation weights/quorums reflections by **distinct trusted source runs**, not note count; a routing-changing reflection must be corroborated by GITS-authoritative (unspoofable) PeerOutcome above a quorum; rate-limit notes per `runId`; aggregate-level anomaly detection (same-repo/same-tag burst, `n` spiking faster than real dispatch volume).
- **H6 🟠 Resource ceilings + escaped-defect objectives.** `maxParallelPeers`/`maxAutoRetries` clamped to guardrail ceilings (anti-DoS), retries bounded by `AutomodePolicy` budget at runtime; routing canary gains post-merge **escaped-defect / revert / incident** objectives (not just pre-merge pass-rate) so "route all high-risk work to the weakly-gated fast path" regresses the canary; routing higher-risk slices to a single-peer path is sensitive-tier.
- **H7 🟠 Atomic executor + immutable snapshots.** All applies serialize through one Effect `Semaphore` (mirror `AutomodeSupervisor.commitState`), version allocation is compare-and-swap inside the lock (concurrent same-`baseVersion` approves → exactly one promotion, one rejection); each dispatch **pins one immutable config snapshot + content hash** at spawn and stamps `PeerOutcome.configVersion` from that pin; promotion is a single atomic pointer swap (`{activeVersion, canaryVersion, cohort}` via `writeFileStringAtomically`) so no peer reads a half-applied config; one canary experiment in flight at a time; operator **re-confirms to PROMOTE**, not just to approve.
- **H8 🟠 Graded human gate + no rubber-stamping.** Provenance flags are graded and rare: an untrusted-only or gate-adjacent change is a **hard block** requiring a distinct, rate-limited, diff-highlighted two-step confirm (not the same banner as a weight tweak); re-emission of a previously-rejected/rolled-back semantic patch requires explicit acknowledgment of that history; the operator must view originating notes before any guardrail hand-edit; the exact **derived peer prompt is shown at approval time** (diffed against the template) so injection laundered into a spawn prompt is visible; recommendation-channel text that argues for guardrail relaxation is scanned and flagged like a note.
- **H9 🟠 Skills/prompts are guardrail-class.** The skill-creator self-improvement path is brought under the same regime (structural SKILL.md diff, field allowlist, anomaly scan, canary, versioned archive, lineage); Motoko's own SOUL/prompt and the delamain/peer skills are operator-only — the loop must not edit the agents in the loop.

**Residual risk / where this stops.** With H0–H9 the design moves from "honor-system isolation" to a code-enforced boundary with a defense-in-depth human gate. Remaining risk is irreducibly human (an operator who hard-confirms a visibly-harmful, well-disguised change) and operational (correct confinement + secret hygiene in implementation). Further red-team rounds would yield diminishing returns versus implementing H0–H9 and validating them with tests; the recommended next step is **Phase 0 (telemetry) plus a confinement spike (H0)** before any loop-auto-apply ships.

## Research Appendix (verified)

### Augment Code — `Intent` vs `Cosmos` (verification reliability: HIGH)

- **Naming corrected:** Intent and Cosmos are **distinct, coexisting** products — Intent (~Feb 2026) is the developer-facing multi-agent workspace; **Cosmos** (public preview May 4 2026) is the org-level agent OS that Intent sits within. **Intent was NOT renamed to Cosmos.**
- **Intent pipeline:** `Coordinator → Implementor → Verifier` over a shared **living spec** (every agent reads/writes it; edits propagate mid-session) with **3 human checkpoints** (spec review · task-decomposition review · final diff review). Each Implementor runs in its **own isolated git worktree/branch**, executing in parallel **waves** (3–12 tasks, 3–12 min each); the Coordinator reconciles at merge and Intent auto-opens a PR. → *This is exactly Delamain; adopt the living-spec + 3-checkpoint framing and effort-scaling per slice.*
- **Learning Flywheel:** `Execute → Coach → Distill → Improve` turns human corrections into **distilled heuristics with explicit trigger conditions** (durable artifacts, separate from weights), retrieved via recency+importance+relevance, two-tier (shared + private), with staged rollout + rollback. → *This is the exact shape of a Motoko reflection + `orchestrator-config` card.*
- **Memory Review:** auto-proposed memories became **human-reviewable/editable/discardable before save** after the fully-automatic version caused low-quality pile-up. → *Adopt pending→approve/edit/discard for operator-style memory.*
- **Counter-pressure:** Augment also ships a single-agent CLI (Auggie); a third-party reviewer argues coordination overhead isn't always worth it. → *Keep a single-peer escape-hatch for hotfix/single-file/exploratory slices.*
- Routing tiers (Intent, for reference): Coordinator = Sonnet 4.6/Gemini 3.1 Pro; well-scoped Implementor = Haiku 4.5; ambiguous = Sonnet 4.6; Verifier = GPT-5.2/5.4/Sonnet 4.6. SWE-bench Verified 65.4% (engineering blog, rigorously sourced).
- Sources: augmentcode.com/guides/intent-walkthrough-prompt-to-merge · /blog/cosmos-now-in-public-preview · /guides/agent-learning-flywheel · /guides/cosmos-experts · /blog/how-we-built-memory-review · docs.augmentcode.com/setup-augment/guidelines

### mem0 (verification reliability: MEDIUM — important correction)

- **The auto-consolidation value-prop is GONE in OSS.** OSS v3 / Node `ts-v3.0.0` (~Apr 16 2026) replaced the two-phase extraction+update pipeline (ADD/UPDATE/DELETE/NOOP) with **single-pass, ADD-only** extraction. The "memories self-consolidate / auto-dedup" selling point no longer holds for the SDK GITS would use. Source: docs.mem0.ai/migration/oss-v2-to-v3
- **Hosted graph memory is Pro-only and off-device**; operator working-style + repo topology are sensitive (conflicts with secrets-never-leave-local). Self-host server image still bundles Neo4j even though the OSS library dropped the graph store.
- **What survives as useful:** automatic fact extraction on `add()`, entity-linking + BM25 hybrid retrieval, and the **four-axis scoping** (user/agent/run/app) — which we adopt at the contract level regardless of backend.
- **Verdict:** the removal of OSS reconciliation weakens (not kills) the case for mem0 over plain pgvector. **Recommendation: do not architect around mem0; use native Claude memory tool / pgvector and implement consolidation+decay in Motoko.** Pricing for reference (confirmed): Growth $79/mo (200K mem / 20K retr), Pro $249/mo (500K / 50K), Enterprise = unlimited. Sources: mem0.ai/pricing · github.com/mem0ai/mem0-mcp · arxiv.org/html/2504.19413v1

### Self-improving multi-agent patterns (adopt list)

- **MAPE-K closed loop** (HIGH) — the spine of this design.
- **Orchestrator-worker + Supervisor (not Swarm)** (HIGH) — keeps every decision auditable; matches Automode + Delamain; tool-level guardrails map onto Automode allowlist/budget/kill-switch.
- **Evaluator-optimizer / actor-critic** (HIGH) — verification gate = external critic; Motoko optimizes the next proposal from real critique.
- **Episodic memory + reflection consolidation** (HIGH) — persist reflections, not replay.
- **Preference / contextual-bandit from approve/reject** (HIGH) — rank/pre-filter only, never auto-approve.
- **Voyager-style skill/recipe library** (HIGH) — admit only after gates pass.
- **DSPy/GEPA prompt optimization** (MEDIUM) — offline, output is a reviewed card.
- **Darwin-Gödel/SICA** (MEDIUM) — adopt only the archive + rollback + empirical-fitness subset; reject autonomous self-rewrite.
- Governance anchors: BerriAI propose-then-approve config edits (exact-match diff); Anthropic multi-agent research lessons (orchestrator-worker, ~15× token cost → budget carefully).

### Shared Multi-Agent Memory — OSS landscape (verification reliability: HIGH)

Lens: a memory substrate usable by **Motoko + codex/cursor/claude peers** simultaneously — cross-agent (ideally MCP), self-hostable/local, multi-agent-scoped, OSS, maintained. Ranked:

| # | System | Verdict | Why |
|---|---|---|---|
| **1** | **Basic Memory** (basicmachines-co/basic-memory, AGPL-3.0, v0.21.5 May 2026) | **PRIMARY** | Only system with **verification-confirmed** cross-tool shared store — vendor per-tool docs document one-click connect for **Codex CLI, Cursor, and Claude Code** against ONE store, writes in one tool immediately visible in others. Fully local: Markdown-on-disk + SQLite + local FastEmbed, **no mandatory LLM**, nothing leaves the box. **Native** first-party MCP server. Git-auditable Markdown = free provenance/reversibility. Its only gap — no auto consolidation/dedup/decay — is a **non-issue** because GITS already owns consolidation+decay (a dumb durable shareable store is exactly what we want). |
| **2** | **Graphiti** (getzep/graphiti, Apache-2.0, v0.29.1 May 2026) | **UPGRADE** (behind the same `MemoryStore` seam) | The right move *if/when* point-in-time/"what-changed-when" temporal recall of peer outcomes/routing becomes the dominant query. Temporal-KG with **automatic temporal invalidation/conflict-resolution**; first-class MCP. Not day-1: OSS core is **Python-only** (no in-process TS SDK — MCP/HTTP only; verified ~99.3% Python), MCP search scopes a **single `group_id` per call** (shared-tier + per-agent reads need a shim), + a graph DB + LLM + embedder per write. |
| **3** | **memorix** (AVIDS2/memorix, v1.0.9) | dark-horse — vet first | **TypeScript-native** (matches TS/Effect server), stdio+HTTP MCP for codex/cursor/claude, local SQLite, and a built-in **worktree-isolation** model mirroring Delamain. Held back by maturity/bus-factor (~500★, single-maintainer, no retrieval benchmark, coarse per-project scoping). Could leapfrog #1 on TS-fit if it sustains. |
| **4** | **agentmemory** (rohitg00/agentmemory, v0.9.x) | dark-horse — pre-1.0 | Closest by *intent*: purpose-built shared cross-coding-agent store, explicit codex+cursor+claude+Hermes client list, `AGENTMEMORY_AGENT_SCOPE=shared\|isolated`, TS/Node SDK, local with secret-stripping, **automatic 4-tier consolidation + Ebbinghaus decay**. Pre-1.0, single-maintainer, bespoke runtime. Revisit post-1.0. |
| 5 | **Mem0** self-hosted (Apache-2.0) | not day-1 | Already decided against (OD-3). OSS v3 = single-pass ADD-only (auto-consolidation gone); heavier stack (Postgres/pgvector + Neo4j + FastAPI) for little gain over a dumb store + GITS consolidation. |
| 6 | **Letta/MemGPT** (Apache-2.0) | not as substrate | Mature shared-block model, **but verification-confirmed Letta is an MCP host/client only — not a native MCP server.** Cross-tool sharing rides on a ~73★ single-maintainer third-party bridge — unnecessary risk for the substrate. |
| 7 | **Zep Cloud / Supermemory** | REFUTED | Cloud-only — violate secrets-never-leave-local. Zep self-host Community Edition deprecated (Apr 2025); Supermemory's MIT covers only SDKs/MCP-shim, engine proprietary, true self-host enterprise-only. |

**MCP topology (decided):** ONE Basic Memory MCP server over **Streamable HTTP** on the tailnet; all agents attach to the same URL; isolation is by project/scope arguments (MCP enforces no per-tenant ACL — application concern). **Shared tier** = a `gits-shared` project, globally *readable*, holding curated reflections + repo topology + operator working-style + routing learnings. **Isolated tiers** = per-repo project + per-`runId` namespace for peers' raw notes. **Write boundaries:** the GITS server writes authoritative records (PeerOutcome, decisions, approved reflections) **only** through `MemoryStore` (server-mediated); peers write low-trust own-scope notes directly via MCP; only the consolidation job writes `gits-shared`.

**Operational caveats (verified, must enforce):** Cursor has a **~40-tool hard cap across all MCP servers** (binding constraint — keep Basic Memory + delamain-peers tools under it). Codex has **approval-friction bugs** (`approval_policy='never'` still prompts for MCP tools) — pre-trust the memory server and verify auto-approval holds in the installed build before relying on unattended writes. OpenMemory MCP "sunset" claim is **unverified** and there's a **naming collision** (Mem0 OpenMemory vs CaviraOSS/OpenMemory) — avoid both ambiguities by targeting Basic Memory.

**Open spikes:** does Basic Memory's HTTP/REST API expose scoped search + frontmatter round-trip, or must `MemoryStore` read Markdown+SQLite directly (spike against v0.21.5)? Should the Markdown tree be its own auto-committed git repo (free versioned archive)? Define the Graphiti upgrade trigger metric. Consider a `memorix` head-to-head before committing, given its TS/Effect fit.

Sources: github.com/basicmachines-co/basic-memory + docs.basicmemory.com/integrations/{codex,cursor,claude-code} · github.com/getzep/graphiti · github.com/letta-ai/letta + docs.letta.com/guides/mcp/overview · github.com/AVIDS2/memorix · github.com/rohitg00/agentmemory · per-tool MCP docs (codex TOML `[mcp_servers]`, `claude mcp add`/.mcp.json, cursor `.cursor/mcp.json`).
