# Perf-remediation orchestration — handoff ledger

**Run:** T1–T16 from `docs/dev-notes/2026-07-18-gitscode-perf-remediation-and-upstream-attribution.md`
**Integration branch:** `feat/perf-remediation` (off `origin/gits` @ `d01e1840f`)
**Orchestrator:** Fable 5 @ high (frontier-orchestration pattern). Execution: Opus 4.8 @ high (complex), Sonnet 4.6 @ medium (default), Haiku 4.5 @ low (mechanical).
**State protocol:** this file is the single ledger; one file per slice under `slices/`. Updated at wave boundaries, not continuously. After any compaction/resume, re-ground from this file.

## Scope / definition of done

Remove the freezes, RSS churn (~2.1 GB → <1 GB), reconnect crashes (45/h → 0), and cross-task
isolation gaps on `gits-cockpit.service`, per T1–T16. Done = end acceptance gate green: full CI
suite + projection/integration tests + `t3 db rebuild-projections` on a DB copy, then one
controlled live redeploy with every task's live Verify assertion passing (acceptance matrix below).

**Non-goals:** Rust rewrite; Bun migration as a "fix" (T15 is a measured A/B only); upstream
ports from §1b (separate effort); any change to `cloud/ mcp/ relay/` subsystems.

## Operator decisions (recorded 2026-07-18)

1. **Verify:** behavioral verification only at the end; per-slice guard is `turbo run typecheck build --filter=t3` only.
2. **Scope:** full autonomous run across Phases 0–4 (no mid-run approval gate).
3. **Live host:** workflow may drive `gits-cockpit.service` for live assertions. Consent checkpoint retained for the T13 systemd edit + first production restart.

## Model-effort policy

| Tier                   | Model/effort      | Assignment                                                                    |
| ---------------------- | ----------------- | ----------------------------------------------------------------------------- |
| Orchestrator/validator | fable-5/high      | briefs, keep-change-drop review, merges, acceptance matrix. Never implements. |
| Complex/architectural  | opus-4-8/high     | T3 T4 T7 T9 T14 T15 T16; lane lead for B and D/H                              |
| Default implementer    | sonnet-4-6/medium | T1 T2 T5 T6 T8 T10 T11 T13                                                    |
| Mechanical             | haiku-4-5/low     | T12                                                                           |

Escalation: 2 failed acceptances on a slice → Fable re-scopes (smaller slice or model↑). Agents never improvise around the brief.

## Blast radius (assumptions to verify during run)

- **Highest risk:** T7 rewires core event delivery (`OrchestrationEngine.eventPubSub` → per-`aggregateId` routing). Every WS consumer (thread, shell, provider status) is downstream. Single-writer Opus lead; T5c→T7→T9→T8 sequence.
- **Data contracts:** T9a adds `afterSequence` to `packages/contracts` — client-runtime consumers must tolerate the optional field (assumption: additive = safe; verify in typecheck of dependent packages).
- **T1 changes at-rest event payloads** — `t3 db rebuild-projections` required afterward; UI must render from `summary`/`detail` only (assumption from plan; validator re-checks web usages of `data`).
- **T3/T12** touch fork-only `gits/` — no upstream coupling.
- **T6** patches a vendored dependency — verify patch applies at install (bun patch mechanism) in the guard.

## Ponytail review (pre-dispatch critique — decided)

- Keep: lane file-locks; per-slice files as durable hand-backs; end-verify + compile guard; Opus single-writer D/H.
- Change: T11 Haiku→Sonnet (correctness-sensitive); no middle coordinator tier (≤4 lanes); T15/T16 are report-only.
- Drop: no slice-schema DSL, no status DB — Markdown + this ledger.
- Flagged risk: end-only behavioral verify concentrates risk at the final redeploy (operator's explicit tradeoff).

## Decisions log

| When       | Decision                                                                      | Why                                                                |
| ---------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 2026-07-18 | PR #170 squash-merged into `gits` (`d01e1840f`)                               | plan docs canonical before implementation                          |
| 2026-07-18 | Integration worktree `.worktrees/perf-remediation` on `feat/perf-remediation` | isolate from live server working tree                              |
| 2026-07-18 | T9c (Queue.unbounded + rate-limit) folded into slice p2-DH-T9-s2              | same hunk as the resume rewrite; separate slice = artificial churn |
| 2026-07-18 | All 26 slice briefs authored under `slices/`                                  | Fable-authored, paths-not-bodies, machine-checkable acceptance     |

## Slice table

Status: `pending → dispatched → implemented → guard-green → merged → verified` (or `failed` / `re-scoped`).

| Slice             | Task | Lane    | Model/effort | Status  | Guard | Merged @ | Verify |
| ----------------- | ---- | ------- | ------------ | ------- | ----- | -------- | ------ |
| p0-ops-T13-s1     | T13  | ops     | sonnet/med   | pending | —     | —        | —      |
| p0-obs-T14-s1     | T14  | obs     | opus/high    | pending | —     | —        | —      |
| p0-obs-T14-s2     | T14  | live    | opus/high    | pending | —     | —        | —      |
| p1-A-T1-s1        | T1   | A       | sonnet/med   | pending | —     | —        | —      |
| p1-A-T1-s2        | T1   | A       | sonnet/med   | pending | —     | —        | —      |
| p1-A-T2-s1        | T2   | A       | sonnet/med   | pending | —     | —        | —      |
| p1-B-T4-s1        | T4   | B       | opus/high    | pending | —     | —        | —      |
| p1-B-T4-s2        | T4   | B       | opus/high    | pending | —     | —        | —      |
| p1-B-T5-s1        | T5   | B       | sonnet/med   | pending | —     | —        | —      |
| p1-B-T5-s2        | T5   | B       | sonnet/med   | pending | —     | —        | —      |
| p1-C1-T3-s1       | T3   | C1      | opus/high    | pending | —     | —        | —      |
| p1-C1-T3-s2       | T3   | C1      | opus/high    | pending | —     | —        | —      |
| p2-E-T6-s1        | T6   | E       | sonnet/med   | pending | —     | —        | —      |
| p2-DH-T5-s3       | T5c  | D/H     | sonnet/med   | pending | —     | —        | —      |
| p2-DH-T7-s1       | T7   | D/H     | opus/high    | pending | —     | —        | —      |
| p2-DH-T7-s2       | T7   | D/H     | opus/high    | pending | —     | —        | —      |
| p2-DH-T7-s3       | T7   | D/H     | opus/high    | pending | —     | —        | —      |
| p2-DH-T9-s1       | T9   | D/H     | opus/high    | pending | —     | —        | —      |
| p2-DH-T9-s2       | T9   | D/H     | opus/high    | pending | —     | —        | —      |
| p2-DH-T8-s1       | T8   | D/H     | sonnet/med   | pending | —     | —        | —      |
| p3-F-T10-s1       | T10  | F       | sonnet/med   | pending | —     | —        | —      |
| p3-F-T10-s2       | T10  | F       | sonnet/med   | pending | —     | —        | —      |
| p3-G-T11-s1       | T11  | G       | sonnet/med   | pending | —     | —        | —      |
| p3-C2-T12-s1      | T12  | C2      | haiku/low    | pending | —     | —        | —      |
| p4-audit-T16-s1   | T16  | audit   | opus/high    | pending | —     | —        | —      |
| p4-staging-T15-s1 | T15  | staging | opus/high    | pending | —     | —        | —      |
| gate-T1-s3        | T1c  | gate    | ops          | pending | —     | —        | —      |

## Acceptance matrix (filled at end gate)

| Task | Verify assertion                                                     | Result |
| ---- | -------------------------------------------------------------------- | ------ |
| T1   | new `tool.completed` payloads < few KB (SQL max LENGTH)              | —      |
| T2   | `context-window.updated` count −≥90%; UI updates ≤5 s                | —      |
| T3   | no 5 s snapshot cadence; sawtooth flattens; budget numbers unchanged | —      |
| T4   | reload path sub-ms; no turn-boundary freezes                         | —      |
| T5   | read-model bytes drop; faster boot                                   | —      |
| T6   | `Failed to publish` = 0 over 10 min under reconnects                 | —      |
| T7   | subscriber only ever sees its own `aggregateId` (test)               | —      |
| T8   | frame+query count under burst drops; UI coherent                     | —      |
| T9   | burst recovery without snapshot stampede                             | —      |
| T10  | no CPU/GC spike on fast build output                                 | —      |
| T11  | large tool-call args no longer quadratic                             | —      |
| T12  | `getSnapshot` no loop-blocking spike                                 | —      |
| T13  | scavenge rate down; swap cleared post-restart                        | —      |
| T14  | baseline captured pre-change; deltas reported                        | —      |
| T15  | side-by-side T14 metrics report                                      | —      |
| T16  | isolation matrix with a test per row                                 | —      |

## Open risks

- T7 blast radius (see above) — may need finer slicing mid-run.
- End-only behavioral verify → late surfacing of logic regressions (operator tradeoff).
- One live redeploy at the end gate; T13 consent checkpoint pending.
