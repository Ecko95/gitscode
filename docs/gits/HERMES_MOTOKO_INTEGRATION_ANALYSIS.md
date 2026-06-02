# Hermes Motoko Integration Analysis

Date: 2026-06-02

## Purpose

Find the strongest way to integrate a Hermes-backed agent persona, Motoko Kusanagi, into GITS as an autonomous assistant for the operator's projects.

The practical target is not a free-running agent that edits repos directly. The useful target is a governed autonomous assistant inside GITS:

- Hermes/Motoko owns long-term memory, project reasoning, proposal drafting, and operator-facing recommendations.
- GITS owns the cockpit, typed RPCs, policy, approvals, telemetry, and audit history.
- Delamain owns execution in isolated worktrees after approval.
- Open GSD remains the `.planning` source of truth for project phases and verification state.

## Current Evidence

### GITS main

Current deployed GITS build-info reports:

```json
{
  "branch": "main",
  "commit": "ecdc27a6a971a2e082b7ea48b9e6d33a07c665ae",
  "dirty": false,
  "sourcePath": "/home/joshua/dev/projects/t3code-gits-hosted"
}
```

Current hosted skills inventory reports:

```json
{
  "skillCount": 488,
  "providerCount": 3,
  "ratedCount": 0,
  "reviewedCount": 0,
  "missingPortCount": 130,
  "hermesCandidateCount": 40
}
```

The current `main` checkout does not contain a Hermes adapter, Hermes service files, or a Hermes cockpit tab. Its GITS architecture currently names DevOS, Delamain, Open GSD, and Automode as first-class modules.

### Existing Hermes Branch

The sibling checkout `/home/joshua/dev/projects/t3code-hermes-integration` is on `feat/hermes-first-class-module` and has an uncommitted Hermes implementation. It includes:

- `docs/gits/HERMES.md`
- `apps/server/src/gits/Services/HermesAdapter.ts`
- `apps/server/src/gits/Layers/HermesCliAdapter.ts`
- `apps/server/src/gits/Services/GitsCapacityMonitor.ts`
- `apps/server/src/gits/Layers/GitsCapacityMonitor.ts`
- Hermes contracts in `packages/contracts/src/gits.ts` and `packages/contracts/src/rpc.ts`
- Hermes client methods in `packages/client-runtime/src/wsRpcClient.ts`
- A Hermes cockpit tab in `apps/web/src/components/gits/GitsCockpit.tsx`

That implementation already has the right safety posture: isolated `HERMES_HOME`, fixed CLI arguments, secret redaction, `SOUL.md` management, status/doctor/ACP checks, proposal cards, and no direct repo-write execution.

### Local Hermes Runtime

Local Hermes is installed:

```text
Hermes Agent v0.15.1 (2026.5.29)
Project: /home/joshua/.hermes/hermes-agent
Python: 3.11.15
OpenAI SDK: 2.24.0
Update available: 170 commits behind
```

GITS-managed Hermes home exists at:

```text
/home/joshua/.gits/hermes
```

`HERMES_HOME=/home/joshua/.gits/hermes hermes acp --check` succeeds:

```text
Hermes ACP check OK
```

`hermes doctor` shows the managed home exists and has `SOUL.md`, but setup is not complete:

- `.env` missing
- `config.yaml` missing, defaults used
- OpenAI Codex auth reported as not logged in
- Several optional toolsets are unavailable because required credentials or system dependencies are missing

This means Motoko can be integrated as a governed cockpit assistant now, but fully autonomous project operation needs setup/auth hardening first.

## Product Positioning

Motoko should be the named Hermes operator inside GITS, not a generic chatbot and not a direct executor.

Recommended identity:

```text
Motoko, the Hermes operator in the GITS shell.
```

Use the Motoko name privately in the operator environment, but avoid public product copy that implies an official or literal copyrighted character. The current sibling branch already uses the safer wording: a cybernetic operator identity inspired by a precise field-commander archetype, not canon imitation or quoted dialogue.

## What Motoko Should Do

### 1. Project Status Analyst

Motoko should answer "what is going on across my projects?" from GITS evidence:

- Current branch, dirty state, ahead/behind state, open PRs, and merge blockers.
- `.planning` health, active phases, missing plans, missing verification, stale summaries.
- Running Delamain peers, waiting peers, failed peers, open logs, and integration state.
- Open GSD status and last command results.
- Runtime status for hosted services such as GITS Tailnet build-info, systemd state, and endpoint health.

Output should be a ranked operator briefing: urgent blockers first, then safe next actions.

### 2. Planning Copilot

Motoko should convert fuzzy operator intent into execution-ready plans:

- Ask for missing context only when needed.
- Generate GSD phase specs, plan-phase prompts, and Delamain worker prompts.
- Detect when a task belongs in Open GSD versus direct Delamain execution.
- Build prompt bundles with repo path, branch, constraints, verification commands, and expected artifacts.

This is valuable because the operator often works across multiple repos and wants exact branch/dependency order.

### 3. Governed Autonomous Dispatcher

Motoko should not spawn peers directly. It should prepare dispatch cards for GITS Automode:

- `read-only`: informational proposal, no approval required.
- `worktree-spawn`: approval required, then Delamain gets a scoped prompt.
- `repo-write`: approval required, then Delamain or a GSD phase executes in isolation.
- `integrate`: approval required, then GITS/Delamain handles PR or merge.
- `destructive-shell`: blocked by default.

The sibling Hermes branch already models these action kinds. The next integration step is to connect approved proposal cards to Automode and Delamain instead of leaving them as static cards.

### 4. Capacity-Aware Router

Motoko should recommend where work should run:

- Codex when local rate-limit headroom is healthy.
- Cursor when Codex is low and Cursor budget has headroom.
- Claude/OpenCode only when provider status and task fit justify it.
- No dispatch when budget telemetry is missing and the policy requires it.

The Hermes branch's `GitsCapacityMonitor` already formats a provider-capacity snapshot for Hermes and explicitly says Hermes may only propose routing. That is the correct separation.

### 5. Persistent Project Memory Curator

Hermes' strongest differentiator is long-term memory and skills. Motoko should curate:

- Operator preferences by repo and client.
- Repeated mistakes and fixes.
- Project runbooks and smoke-test recipes.
- Common Delamain prompts.
- Known branch/deploy topologies.
- Post-task learnings from successful and failed runs.

GITS should expose this as "memory proposals" before writing durable memory. Memory writes should be explicit because stale memories can damage future automation.

### 6. Daily/On-Demand Briefing Agent

Motoko should be able to run a scheduled "morning cockpit" pass:

- Scan configured repos.
- Summarize open PRs, dirty checkouts, stale branches, failed CI, blocked phases, and waiting peers.
- Report hosted service health for selected Tailnet or production endpoints.
- Recommend the next three actions with estimated risk and suggested execution path.

Hermes supports scheduled automations upstream, but GITS should own the schedule config and output cards so the operator can audit what ran.

### 7. Review And Verification Sentinel

Motoko should review whether work is actually done:

- Compare stated goal to files changed, tests run, deployment status, and runtime endpoints.
- Detect "green tests but uncovered objective" cases.
- Create verification cards that list missing evidence.
- Recommend next commands or peers to close gaps.

This matches how the operator already expects completion: source-of-truth evidence, not proxy success signals.

### 8. Skill Librarian

GITS already detects `40` Hermes candidate skills out of `488` total skills. Motoko should help turn that inventory into usable agent capability:

- Rank candidate skills by project usefulness.
- Suggest missing skill ports.
- Recommend which skills belong in the Motoko profile distribution.
- Detect duplicated or stale skills.
- Attach skills to project context based on repo type and recent tasks.

## Recommended Architecture

### Layer 1: Hermes Status And Profile

Land the first-class Hermes module from the sibling branch, rebased onto current `main`.

Minimum cockpit status:

- Hermes binary/version.
- Update status.
- `HERMES_HOME`.
- `.env`/config presence.
- Codex OAuth status, without token contents.
- ACP health.
- SOUL status.
- Proposal count.

### Layer 2: Motoko Profile Distribution

Create a GITS-owned Hermes profile distribution for Motoko:

```text
profiles/motoko-gits/
  distribution.yaml
  SOUL.md
  config.yaml.example
  skills/
  cron/
  mcp.json.example
```

This matches upstream Hermes profile-distribution mechanics and keeps personality, skills, cron jobs, MCP config, and defaults versioned while preserving local memories and secrets.

### Layer 3: Project Context Bridge

Add a generated, read-only project context file for Hermes:

```text
.gits/hermes-context/<project-id>.md
```

It should include:

- Repo path and current branch.
- Default remote and protected remotes.
- `.planning` summary.
- active Delamain peers.
- provider capacity summary.
- relevant runbooks.
- recent verification evidence.

Then pass it to Hermes via prompt context or an MCP/resource bridge. Do not write this into project repos unless the operator asks.

### Layer 4: Proposal Cards As The Main Contract

Keep Motoko's output in a typed proposal format:

```text
title
summary
evidence
scope
risk
actionKind
approvalRequired
recommendedExecutor
verificationPlan
nextCommandOrPrompt
```

The current branch's proposal schema is a good start, but it should add `evidence`, `recommendedExecutor`, and `verificationPlan` before being treated as a real autonomous-assistant surface.

### Layer 5: Approval-To-Execution Bridge

Once proposal cards are reliable:

- Approved `worktree-spawn` cards should create a Delamain spawn draft.
- Approved `repo-write` cards should create a Delamain or Open GSD plan draft.
- Approved `integrate` cards should require a separate final confirmation and then invoke the existing integration path.
- `destructive-shell` should stay blocked unless the operator manually converts it into a narrowly scoped recovery task.

This lets Motoko be autonomous in analysis and recommendation while GITS remains the control boundary.

### Layer 6: Scheduled Autonomy

Only after proposal routing is stable, add scheduled tasks:

- Daily project briefing.
- Weekly stale-branch and stale-PR scan.
- Tailnet/hosted service health check.
- Skills inventory review.
- Memory review.

Scheduled tasks should create proposal cards, not execute changes.

## UI Changes That Would Matter

The Hermes tab should be renamed or visually framed as Motoko once the profile exists:

- Header: `Motoko`
- Subtitle: `Hermes operator for GITS`
- Status chips: `ACP`, `OAuth`, `SOUL`, `Mode`, `Update`
- Primary input: `Ask Motoko`
- Primary action: `Inspect selected project`
- Proposal columns: `Evidence`, `Risk`, `Approval`, `Executor`
- CTA from approved cards: `Draft Delamain Peer`, `Draft GSD Plan`, or `Open Verification Checklist`

The Overview tab should surface only high-level Motoko output:

- Number of pending proposals.
- Top recommended next action.
- Whether Hermes setup is incomplete.
- Whether provider capacity suggests Codex or Cursor.

Avoid making the whole cockpit a chat UI. Motoko should augment the operational dashboard, not replace it.

## Immediate Implementation Plan

1. Rebase and clean the sibling Hermes branch onto current `origin/main`.
2. Keep the branch read-only/proposal-only until the first merge.
3. Add missing fields to proposal cards: evidence, risk level, recommended executor, verification plan.
4. Add a Motoko profile/SOUL document, using safe private persona wording.
5. Add setup UX for `.env`, config, Codex OAuth, and Hermes update status.
6. Add an explicit "Draft Delamain Peer" action from approved proposal cards.
7. Add a daily briefing proposal generator after manual proposal flows are stable.

## Setup Blockers

- Local Hermes is installed but behind upstream by `170` commits.
- GITS-managed Hermes home has no `.env`.
- `hermes doctor` reports Codex OAuth as not logged in for the GITS-managed home.
- Current production `main` has no Hermes module yet.
- The sibling Hermes branch is dirty and should be reviewed carefully before merging.

## Recommended Success Criteria

Motoko integration should be considered useful only when these pass:

1. GITS can show Hermes/Motoko status, version, ACP health, auth state, and SOUL state without exposing secrets.
2. Asking "what should I do next in this project?" returns a ranked proposal with file/command evidence.
3. Asking for a repo-changing task produces a proposal card, not a direct edit.
4. Approving a `worktree-spawn` proposal creates a scoped Delamain prompt with repo, branch, risk, and verification commands.
5. Rejecting or deferring a proposal is persisted and visible.
6. Motoko can produce a daily briefing across configured projects without writing to repos.
7. Every autonomous path has a kill switch, approval gate, repo allowlist, model/provider policy, and budget policy.

## Bottom Line

Motoko should become the memory-rich strategist and operator interface for GITS, not the execution substrate. The right integration is:

```text
Motoko/Hermes thinks, remembers, briefs, and proposes.
GITS governs, displays, audits, and routes.
Delamain executes in isolated worktrees.
Open GSD defines phase truth and verification.
```

That gives the operator a genuinely useful autonomous assistant without weakening the boundaries that make GITS safe to run across real projects.

## External References Consulted

- https://hermes-agent.nousresearch.com/docs/
- https://hermes-agent.nousresearch.com/docs/user-guide/features/overview/
- https://hermes-agent.nousresearch.com/docs/user-guide/configuration/
- https://hermes-agent.nousresearch.com/docs/user-guide/profile-distributions
- https://github.com/NousResearch/hermes-agent/blob/main/website/docs/reference/cli-commands.md
- https://github.com/NousResearch/hermes-agent/security
