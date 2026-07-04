# Session Retrospective — GITS Harness Orchestration Run (2026-07-03 → 04)

A candid postmortem of the ~15-hour orchestration session that executed the entire GITS
harness plan and follow-on work. Written for two purposes: to learn from the workflow, and to
turn what was learned into concrete upgrades for the `/frontier-orchestration` skill. Honest
about the misses, not just the wins — the misses are where the skill improvements live.

---

## 1. What this session was

One long-lived orchestrator (Fable) acting purely as a **brain** — scoping, briefing, review,
merge decisions, operator-gate conversations — dispatching **Sonnet execution agents** (max 6
concurrent, one bounded task each, isolated worktrees) to implement. The orchestrator never
wrote feature code; it wrote briefs, ran adversarial review on every result, and decided
keep/change/drop.

Scope delivered: `docs/harness-execution-plan.md` Waves 0–6 + lanes A–D (drift guards, worktree
graveyard, event retention + rebuild, actor identity, audit trail, reconnect resilience, perf
tier 1, security tier 1, hosting), then four operator-driven follow-ons (interactive Delamain
sidepanel, Delamain Codex peer-auth fix, git-command confinement shim design + implementation,
a live deploy + verify).

## 2. By the numbers

- **~50 PRs merged to `gits`**, every one through the required quality check (except the two
  end-of-session docs PRs, admin-merged as they cannot break the build).
- **4 numbered design plans** authored, operator-approved, then implemented (plans 21–24:
  graveyard, retention/rebuild, actor identity, git-shim).
- **~11 fix rounds** — PRs that failed review or CI and were re-scoped and re-dispatched.
- **~9 real defects caught by review** that green unit tests did not (see §4).
- **2 approval gates** to the operator honored mid-flight (event-schema + auth policy).
- **0 drift**: all ~22 parallel branches rebased onto the moving base with zero conflicts,
  because tasks were scoped to disjoint files.

## 3. The model that worked: Fable brain, Sonnet hands

The division held up under real load:

- **Orchestrator owns judgment.** Recon, blast-radius, brief-writing, the ponytail critique of
  its own briefs before spawning, adversarial review of every result, merge sequencing, and
  the operator-gate conversation. It never implemented.
- **Agents own execution.** One bounded outcome each, read-first file list, explicit
  invariants, machine-checkable acceptance, and a required report shape (files read/changed,
  tests, residual risks, shortcuts). Isolated worktrees so parallel edits never collide.
- **Escalation, not improvisation.** An agent blocked or failing twice returns the task to the
  orchestrator for re-scoping. This fired several times (W2.6b's architectural STOP, killed
  agents) and each time produced a better outcome than letting the agent thrash.

The single most valuable property: **the orchestrator reviewed the diff, not the report.**
Every fix round below came from reading the actual change, not trusting the agent's summary.

## 4. The review gate earned its keep

Green tests are necessary, not sufficient. Nine defects that passing unit suites did **not**
catch, surfaced by orchestrator review of the diff/design:

1. **Graveyard adoption (W2.3) — destructive.** "Adopt worktrees with only an owner-recorded
   event" would have tagged every _healthy, live_ worktree as an orphan and reaped it after 7
   days. Caught pre-merge; corrected to "bound = owner-recorded + live thread."
2. **Approval policy (W5.3) — security.** First cut let any `delamain` actor approve tool use —
   including a session approving its _own_ tool calls. Corrected to require an operator or
   supervisor credential role.
3. **Provider deny-bucket (W5.3 r3) — product-breaking.** The deny matrix had no `provider`
   bucket, so the entire ingestion pipeline (assistant messages, plans, diffs) was
   deny-by-default'd — a server that never shows an agent's reply. Green `tsc`, broken product.
4. **Rebuild verify (W4.5) — silent corruption.** `--verify` compared only row counts; a bad
   migration that corrupts _values_ preserves counts. Added per-table content fingerprints.
5. **Inactivity retirement (W2.2b) — wrong trigger.** Retired on session _absence_ (crash /
   manual stop), not _inactivity_ — would remove an active user's worktree after 5 minutes.
   Added a stale-activity guard.
6. **Reaper guard (W2.4) — half-built.** Only checked ownership events, missing the second
   layer that protects pre-ownership-era worktrees referenced by a live thread.
7. **Owner-recorded mis-aggregation (W2.2).** A command fell through to the wrong aggregate
   kind, silently defeating the whole binding check — found by a later agent's fresh eyes.
8. **Audit ground-truth (W1.9).** The audit's "~142 cuttable lines / adapter Shape markers" was
   wrong — those interfaces are consumed in type position across 8 files. Real cut: 3 exports.
9. **"Real bug" was a stale mock (W1.0).** The browser-test failure the audit flagged as a
   product bug was a test mock missing a new state field.

Takeaway for the skill: **an adversarial review-the-diff gate on every implementation is not
optional overhead — it is where correctness actually comes from.** Half of these were
destructive or product-breaking and all passed their tests.

## 5. What worked well — keep these

- **Numbered design → operator approval → implement** for anything touching auth, migrations,
  or the event schema. Plans 21–24 as `.plans/` docs, reviewed and revised _before_ a line of
  code. The graveyard design went through a revision round that closed audit-trail holes on
  paper, saving expensive rework.
- **Disjoint-file scoping + a concurrency cap.** Up to 6 agents on non-overlapping file
  clusters; contracts/migrations/event-schema serialized through single owners. Result: ~22
  branches, zero merge conflicts on rebase.
- **Lane-gate ordering.** Design/measure gates first (W4.1 perf baseline, W5.1 auth audit, the
  graveyard design) so downstream tasks built on evidence, not assumptions. W4.1's numbers
  _justified_ W4.4 and _deferred_ W4.3 — the measurement changed the plan.
- **A persistent, rtk-proofed CI monitor** that auto-merged a reviewed allowlist on green and
  shouted (not stalled) on red.
- **Ground-truth corrections folded back into the docs** (a dedicated PR) so the plan matched
  reality for the next reader.
- **Fix-round briefs that carried the exact known defect + known gotchas**, so the re-dispatched
  agent fixed rather than rediscovered.
- **Killed-agent WIP preservation** — committing an orphaned worktree's uncommitted work to a
  labeled WIP branch before deciding its fate.
- **Cross-session durability** — task ledger + memory + in-repo handoff docs, so a 15-hour
  session survived context compaction and a date boundary without losing the thread.

## 6. Friction & failures — fix these

- **The CI monitor silently stalled.** The RTK hook rewrites `gh pr checks --json` inside
  scripts and returns compact text, so the monitor saw "no data" for green PRs and merged
  nothing for a while. Root cause found late; cost real wall-clock. → Always `rtk proxy gh api`
  in scripted checks.
- **Agents ran `tsc`, not the repo's `tsgo` typecheck**, passed locally, and shipped
  Effect-diagnostic violations that only CI (or a killed agent, an hour in) caught. → The exact
  typecheck command must be in every brief.
- **Repo-wide `oxfmt --check .` missed** by several agents → CI red on one stray file. → Make
  repo-wide format a mandatory final gate in every brief.
- **`git stash` cross-contamination.** Agent worktrees share one `.git`; one agent's stash pop
  grabbed another's files. Caught, but a real hazard. → Ban stash in briefs.
- **Green on a pre-fix SHA merged as if green.** A monitor verdict fired for an old commit
  before the fix agent pushed. → Verify the verdict's SHA equals the PR HEAD before merging.
- **A Delamain agent ran in the user's _live_ working tree** (I forgot worktree isolation) and
  had to surgically preserve the operator's uncommitted WIP. Near-miss on user data. → Default
  every file-mutating agent to worktree isolation; never the user's live tree.
- **I passed an operator's repo/account assumption to an agent unverified** (delamain "under
  joshuaduffill" — actually `Ecko95/delamain`). The agent caught it. → Verify remotes/accounts
  before briefing, don't relay assumptions.
- **Long-running agents (90+ min) with no mid-flight signal.** Hard to tell thrash from
  progress. → Briefs should emit a checkpoint or the orchestrator should sample the transcript
  for liveness (tool-use cadence), not just wait.
- **Gotchas were added to briefs progressively** as each bit — the first agents didn't have the
  no-stash / tsgo / oxfmt rules that later ones did. → Bake the full invariant boilerplate into
  the skill from brief #1.

## 7. Concrete upgrades for `/frontier-orchestration`

Actionable changes to fold into the skill.

### 7a. A mandatory brief-invariant block (the biggest lever)

Every execution brief should auto-include a non-negotiable invariants section, so agents never
rediscover these and the orchestrator never forgets to add them:

- **No `git stash`** (shared `.git` across worktrees cross-contaminates); use `git diff <base>`.
- **Typecheck via the repo's real command** (here: `bunx turbo run typecheck --force` / tsgo,
  never plain `tsc`) — state it explicitly; note any custom diagnostics (Effect: no node
  `fs`/`path`, no `new Date()`).
- **Repo-wide format check as the final gate** (`oxfmt --check .`), format touched paths only,
  never repo-wide auto-format.
- **CI is the arbiter.** Do not report local test failures as blockers without checking they
  reproduce on the branch's CI; carry the known-flake ledger so agents don't chase ghosts.
- **Conventional commits, PR base, co-author trailer, `--repo <owner/name>` always** (default
  gh remote is untrustworthy).
- **Clean-baseline check at setup** (`git status --porcelain` empty, HEAD matches base) to
  detect a contaminated worktree before starting.

### 7b. A merge-loop contract for the orchestrator

- Poll CI with `rtk proxy gh api .../check-runs`, **never** `gh pr checks --json` in scripts.
- **SHA-gate every merge**: the green verdict's `head.sha` must equal the PR's current HEAD.
- Auto-merge only a **reviewed allowlist**; design/approval PRs and anything with a pending
  review stay out of the auto-merge set.
- Emit on every terminal state (success _and_ failure), never only success — silence must not
  read as green.

### 7c. Formalize the review gate

- **Review the diff, not the report.** Add an explicit orchestrator step: fetch the PR diff,
  check it against the brief's acceptance + the audit checklist, before any merge. §4 is the
  evidence this is load-bearing.
- **One adversarial question per risky assumption** in the agent's report; if the report omits
  the acceptance evidence the brief demanded, verify it yourself rather than assume.

### 7d. Task-shape patterns to name in the skill

- **Design-gate task**: for auth/migration/event-schema, deliverable is a numbered `.plans/`
  doc as a draft PR → operator approval → implementation task references it. Include a revision
  round if review finds holes.
- **Measure-gate task**: for perf/optimization, a baseline/measurement task runs first and its
  numbers gate (or defer) the downstream work. Don't optimize before measuring.
- **Investigation-first task with a STOP clause**: for uncertain scope, the brief authorizes
  "if reality contradicts the premise, STOP and report the finding" — the finding is a valid
  deliverable (W2.6b proved agent git ops bypass the VcsDriver entirely; that report was worth
  more than a forced implementation).
- **Fix-round brief**: carries the _exact_ known defect, the CI error verbatim, and the full
  gotcha block, so the agent fixes rather than re-derives. Never re-dispatch a vague "make it
  pass."
- **Killed/orphaned-work preservation**: commit a killed agent's uncommitted worktree to a
  labeled WIP branch before deciding to finish/shelve/drop — never let a prune lose it.

### 7e. Isolation and safety defaults

- **Worktree isolation on by default** for any file-mutating agent; explicitly never the
  operator's live checkout.
- **Verify remotes/accounts** before briefing; treat operator-supplied repo framing as a hint
  to confirm, not a fact.
- **Serialize** contracts/migrations/event-schema; **parallelize** disjoint files. Assign
  migration numbers centrally (the orchestrator owns the next number).

### 7f. Long-run ergonomics (dovetails with the skill's context-rot / degraded-orchestrator sections)

- **Durable state triple**: task ledger + memory + in-repo handoff doc. This session survived
  compaction and a date rollover because state lived outside the context window.
- **Liveness sampling** for long agents: check tool-use cadence / transcript growth to
  distinguish progress from a hang, instead of binary wait-or-kill.
- **Ground-truth corrections PR** at the end: fold what execution discovered back into the
  planning docs so they don't lie to the next reader.

## 8. Orchestrator self-critique (what I would do differently)

- Bake the invariant block (§7a) into brief #1 instead of accreting it over the first six
  tasks.
- rtk-proof the monitor from the start — the silent stall was avoidable.
- Default to worktree isolation everywhere; the live-tree Delamain run was a lucky near-miss on
  user data.
- Verify the delamain remote before relaying the operator's "joshuaduffill" framing.
- Sample long-running agents for liveness rather than waiting blind for 90 minutes.
- Consider a lightweight "second-reviewer" agent on the highest-blast-radius diffs (auth,
  destructive reapers) — I caught them solo, but a dedicated adversarial reviewer would be
  cheap insurance on exactly the changes where a miss is worst.

## 9. Environment/tooling gotchas (quick reference)

- CI is the only arbiter; local "pre-existing failure" claims are usually worktree-env noise.
- Typecheck = tsgo (`turbo run typecheck --force`), not `tsc`; custom Effect diagnostics are
  errors.
- `oxfmt --check .` repo-wide is a required gate; markdown is in scope.
- Never `git stash` in agent worktrees (shared `.git`).
- `rtk proxy gh api`, never `gh --json` inside scripts.
- Always `--repo Ecko95/gitscode` (delamain is `Ecko95/delamain`, not joshuaduffill).
- Verify a CI verdict's SHA against PR HEAD before merging.
- Deploy: `scripts/gits-hosting/deploy-subject28-gits.sh`; verify with `t3 db rebuild-projections --verify`.

---

_Companion docs: `docs/resume-work-2026-07-04.md` (status + open items), `docs/handoff-2026-07-04.md`
(actionable pickups). Session model: Fable orchestrates, Sonnet executes — `/frontier-orchestration`._
