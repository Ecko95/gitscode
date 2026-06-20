# Self-Improving Orchestration — Brainstorm

> Status: **complete** · Last updated: 2026-06-07
> Design of record: `docs/gits/ORCHESTRATION_SELF_IMPROVEMENT_DESIGN.md` + `ORCHESTRATION_PRIOR_ART.md` + `H0_CONFINEMENT.md` (branch `feat/gits-h0-confinement-spike`). **This grilling materially revises that design — see Key decisions; the design-of-record docs need updating to match.**
> **Item #5 (the fully-agentic toggle) is now designed in detail** in `docs/brainstorms/autonomous-toggle.md` ([[autonomous-toggle]]) — a follow-on grill that pins the v1 scope for a single repo (`gitscode` self-hosting) and reframes Motoko from "conductor" into the full autonomous-orchestrator brain. Read it for the build sequence behind #5; the notes below are the parent context it grew out of.

## Summary

The original design (editable 3-tier orchestrator config + MAPE-K loop + shared multi-agent memory + H0 confinement) was research-correct but **over-built for the operator's actual pain**. The real driver is **(b) peers producing green-but-wrong PRs** and **(c) cost + babysitting** — not "re-deciding/not-learning". That reorients the whole thing toward two levers: a **semantic verifier-critic** that triages green PRs against per-slice acceptance criteria (so the operator only reviews the flagged subset), and a **peer-question auto-answerer**. Motoko becomes a **persona + active conductor** (deterministic-by-default, with a fully-agentic toggle) running **codex-only** peers, with consequential decisions still human-gated. The elaborate shared memory is **descoped** to a server-owned SQLite episode ledger + reflections (one-way prompt injection). Cost is governed by **codex rate limits** (reserve 20% weekly), not dollars. Target surface: **GITS as an installable Android PWA with web push** (Telegram is the stopgap). Constraints: **avoid the Claude Agent SDK**; solo operator.

## Key decisions

1. **Core pain = quality (green-but-wrong PRs) + cost/babysitting.** Everything is justified only insofar as it serves these.
2. **#1 lever — semantic verifier-critic.** A _fresh_ codex agent (never the implementer; runs read-only after the H0 confined gate) judges each green PR against the slice's acceptance criteria + an adversarial "what did it miss" pass, emitting `pass`/`fail`/`uncertain`. **Triage, never block the chain.**
3. **Verifier → merge:** confident-pass **auto-merges**; flagged (uncertain/fail) PRs are **held from auto-merge for review**; the chain advances on **independent** slices (most of the flow), so dependent waits are rare. Operator reviews only the held subset.
4. **Acceptance-criteria-per-slice** is the verifier's source of truth — a per-slice artifact (`<state-dir>/slices/<slice_id>.md` or a `handoffs.tsv` reference) authored at planning time (`/grill-me`, GSD `.planning`), embedded in the peer prompt AND read by the verifier (same bar). Fallback: derive from the slice prompt + flag lower confidence. _(Net-new slice-format field.)_
5. **Runtime constraints:** **avoid the Claude Agent SDK** (so the "Claude SDK supervisor" + "native Claude memory tool" are out — brain is OpenAI/codex-aligned). **Peers are always codex**; auto-routing selects among **codex model-tiers**; **cursor is operator-manual-only** (more expensive) and the **learning loop must never auto-route to it**.
6. **Motoko = persona + active conductor.** She drives the mechanical flow (spawn codex peers → run verifier → auto-answer common questions → triage → advance), but **consequential decisions stay human-gated** (orchestrator-config self-edits, merging flagged PRs, destructive actions, low-confidence auto-answers). **Hybrid (deterministic + agentic escalation) is the default**; a **fully-agentic toggle** = autonomous mode. **Guardrails hold in both modes** — the toggle raises _conducting_ autonomy only, never relaxes the consequential gates.
   - **REFRAME (autonomous-toggle grill, [[autonomous-toggle]]):** in autonomous mode Motoko is no longer "just" a conductor over a hand-authored plan — she is the **full autonomous-orchestrator BRAIN**. The loop is `intent → Motoko judges context-sufficiency → (enough: draft slice plan + per-slice acceptance criteria → dispatch confined peers) | (not enough: grill-me Q&A → write the brainstorm/spec context → dispatch)`. Sufficiency bar = "can Motoko draft a complete slice plan + criteria from the available context?"; gaps become the grill questions (interactive cockpit + async-Telegram fallback). Planning, context-judgment and grilling are one unified activity, and the plan's criteria are the verifier's input. The "fully-agentic toggle" of the original wording thus also grants **planning + dispatch**, not only conducting autonomy.
   - **Dispatch without breaking the SOUL:** Motoko still only **proposes**; `mode:"autonomous"` makes the policy **auto-approve her proposals within the envelope**, turning each approved proposal into an `AutomodeSupervisor` goal the `AutomodeDriver` dispatches. This merges the two previously-parallel "pending work" representations (Hermes proposal cards ↔ automode goals) into one pipeline. The envelope preserves "Motoko never executes/lands": peers write **in a bubblewrap jail**, output is a **held PR to `gits`** (autoMerge OFF for v1), the operator merges. A small **standing-approval clause** is added to `SOUL.md` — no rewrite. So the toggle still **never relaxes the consequential gates** (merge-to-`gits`, destructive, scope-changing answers stay human); it only converts the per-proposal human tap into a standing approval to _route_ within the held-PR envelope.
7. **#2 lever — peer-question auto-answerer.** Auto-answer only when derivable-from-context AND non-scope-changing AND low-risk/reversible; else escalate with a one-tap recommendation. **Notified-passive** by default (operator sees it, can intervene), → silent once trusted. Every auto-answer logged so the loop learns overrides.
8. **Memory descoped** to a **server-owned SQLite episode ledger + reflections + one-way prompt injection.** No peer-writable shared store → deletes the poisoning attack surface + the MCP-proxy/auth/egress apparatus. DB = existing **`@effect/sql-sqlite-bun`** (indexed tables, WAL); `sqlite-vec` is the semantic-recall upgrade. Supersedes Basic Memory / mem0 / native-Claude-memory for this use case.
9. **Cost = codex rate-limit-aware**, not a $ cap: gate on codex **5h + weekly** usage, **reserve 20% of weekly** (pause auto-spawn at 80%; in-flight finishes; manual override). 5h window = pacing. Source = existing `GitsCapacityMonitor`. **Supersedes `AutomodePolicy.maxBudgetUsd`** as the operative control.
10. **Verifier model tier:** `gpt-5.4-mini` (high reasoning) default → `gpt-5.5` only when repeatedly uncertain.
11. **Solo operator** — multi-operator scoping out of scope.
12. **Notification/review surface:** Telegram now (reuse autopilot event keys + one-tap); **target = GITS as an installable Android PWA with web push** for held-PR/escalation notifications; cockpit = full review/control surface (held-PR queue + verifier reasons + codex usage + Motoko persona).
13. **Build sequence:** (1) verifier-critic + acceptance-criteria plumbing → (2) episode ledger (SQLite) + codex 5h/weekly usage visibility & 80%-weekly throttle → (3) peer-question auto-answerer → (4) reflection→routing/prompt tuning as operator-gated cards → (5) fully-agentic toggle.

## Q&A log

### Q1 — What actually triggered "build a better orchestration system"?

**A:** (b) peers fail / produce low-quality PRs + (c) cost + babysitting. **Notes:** my "re-deciding/not-learning" bet was wrong as the primary driver; reorients toward gating/routing for quality + reducing human-time/spend; flags the tension that the design _adds_ approval gates (must net-reduce touchpoints).

### Q2 — Where does the babysitting/cost actually go?

**A:** Worst = reviewing wrong-green PRs; second = answering waiting peers (wants auto-answer of common ones); operator already plans up-front with `/grill-me`. **Notes:** yields the two levers; planning output should feed both peer prompts and the verifier; operator attention is the binding constraint (cost framing refined in Q9).

### Q3 — What does the verifier check against; block or triage?

**A:** Reference = acceptance-criteria-per-slice; behavior = **triage, never block.** **Notes:** fresh verifier (not implementer) avoids self-grading; verdict triages the operator's review.

### Q4 — Does the verdict gate auto-merge?

**A:** **A** — confident-pass auto-merges; flagged held-for-review; chain advances on independent slices. **Notes:** catches wrong-greens pre-merge; operator reviews only the held subset; mostly-independent flow makes dependent waits rare.

### Q5 — Who runs the intelligence?

**A:** Unsure on runtime, but **(1) avoid Claude Agent SDK; (2) peers always codex.** **Notes:** Claude-SDK supervisor + native-Claude-memory out; routing → codex model-tiers; cursor manual-only, never auto-routed.

### Q5b — Motoko's role?

**A:** Mainly persona, but also **run delamain peers + orchestrate if needed.** **Notes:** persona + active conductor; mechanical flow delegated, consequential decisions human-gated; brain = deterministic conductor + scoped codex reasoning.

### Q6 — How agentic is the conductor?

**A:** **Hybrid default + fully-agentic toggle.** **Notes:** maps to `AutomodePolicy.mode` (supervised default / autonomous toggle); guardrails hold in both modes; default-deterministic for cost/predictability.

### Q7 — Auto-answer vs escalate boundary; silent vs notified?

**A:** Recommendation accepted (derivable + non-scope-changing + reversible → auto; else escalate one-tap; logged). **Notes:** notified-passive default → silent once trusted.

### Q8 — Keep shared memory or descope?

**A:** **Descope** to server-owned ledger + reflections + one-way injection; make storage performant. **Notes:** kills poisoning surface + MCP apparatus; DB = SQLite (`@effect/sql-sqlite-bun`), indexed + WAL; `sqlite-vec` later.

### Q9 — Real cost constraint?

**A:** **Codex rate-limit-aware** (5h + weekly), reserve 20% weekly; want cockpit codex-usage visibility like the delamain dashboard. **Notes:** pause auto-spawn at 80% weekly; 5h = pacing; reuse `GitsCapacityMonitor`; supersedes `maxBudgetUsd`.

### Q10 — Build sequence?

**A:** Approved as recommended (verifier → ledger+usage → auto-answerer → routing-tuning → toggle).

### Q11 — Acceptance-criteria home?

**A:** Yes — per-slice artifact authored at planning, shared by peer-prompt + verifier, derive-and-flag fallback. **Notes:** net-new autopilot slice-format field.

### Q12 — Notifications surface, solo, verifier tier?

**A:** Telegram now, but **want GITS as an installable Android PWA with web push**; solo operator; verifier `gpt-5.4-mini`/high → `gpt-5.5` when uncertain. **Notes:** nothing flagged wrong/missing — shared model reached.

## Open flags

- [x] ~~Cost ceiling~~ → RESOLVED (Q9): codex rate-limit-aware, 20% weekly reserve, not a $ cap.
- [x] ~~Build sequencing~~ → RESOLVED (Q10).
- [ ] **PWA + web push infra is net-new** (web app manifest, service worker, push subscription + a push backend) — a workstream parallel to the orchestration core; scope it separately.
- [ ] **Autopilot slice format** must gain the acceptance-criteria field/artifact (Q11) — touches `handoffs.tsv` + the peer-prompt template + (new) `<state-dir>/slices/`.
- [ ] **Verifier + agentic-escalation spend must count toward the 80% weekly codex reserve** (Q9 ⊗ Q2) — the quality machinery itself consumes codex; meter it.
- [x] ~~**Hermes/Motoko runtime deferred** — persona now, codex-aligned brain. Revisit only if its long-term-memory features are wanted later.~~ → **RESOLVED DIFFERENTLY** (autonomous-toggle grill, [[autonomous-toggle]]): not deferred — **Hermes IS the brain** for the autonomous toggle, and **configuring the managed home `~/.gits/hermes`** (`.env`/`config.yaml`, Codex OAuth) is now a **hard v1 prerequisite**, not an optional later add. (Long-term memory still lands as the SQLite episode ledger of #8/#2, which Motoko reads/rehydrates from — never raw transcripts.)
- [ ] **Design-of-record docs diverge** from this brainstorm (avoid-Claude-SDK, codex-only, cursor-manual, Motoko-conductor, memory descope→SQLite, codex-rate-limit cost, verifier-critic #1, PWA push) — update them (self-improvement step).
