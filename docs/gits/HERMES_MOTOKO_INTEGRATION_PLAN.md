# Hermes Motoko Integration Plan

Date: 2026-06-02

Source analysis: `docs/gits/HERMES_MOTOKO_INTEGRATION_ANALYSIS.md`

## Goal

Integrate Motoko as the Hermes-backed strategist/operator inside GITS without turning Hermes into the execution substrate.

The target operating model is:

```text
Motoko/Hermes thinks, remembers, briefs, and proposes.
GITS governs, displays, audits, and routes.
Delamain executes approved work in isolated worktrees.
Open GSD remains phase truth and verification state.
```

## Current Inputs

- Current branch: `research/hermes-motoko-integration`
- Base commit: `ecdc27a6 chore(gits): harden tailnet hosting runbook`
- Hosted GITS main reports commit `ecdc27a6a971a2e082b7ea48b9e6d33a07c665ae`
- Existing GITS modules on this branch: Overview, Delamain Fleet, Open GSD, Automode, Skills Intelligence, Projects, build-info, tailnet hosting runbooks
- Sibling Hermes branch: `/home/joshua/dev/projects/t3code-hermes-integration`, branch `feat/hermes-first-class-module`
- Sibling branch state: dirty, with Hermes contracts, server adapter, capacity monitor, cockpit tab, docs, and related tests
- Local Hermes runtime: v0.15.1, ACP check succeeds under `HERMES_HOME=/home/joshua/.gits/hermes`
- Setup blockers: GITS-managed Hermes home lacks `.env`, lacks `config.yaml`, and reports Codex OAuth incomplete

## Non-Negotiables

- Motoko is observe/propose by default. No direct repo edits, peer spawns, merges, admin merges, force pushes, or destructive shell execution.
- GITS owns approval state, kill switch, allowlists, budget policy, provider routing policy, telemetry, and audit history.
- Delamain owns all repo-writing execution through isolated worktrees after explicit approval.
- Open GSD owns `.planning` phases, specs, plans, verification artifacts, and autonomous phase truth.
- All Hermes shell calls use fixed server-side argument lists and an isolated `HERMES_HOME`.
- Secrets are never copied into repo files, browser payloads, logs, proposal details, or setup cards.
- Motoko identity can be private/operator-facing, but public copy must not imply an official copyrighted character or quote/copy canon material.

## Architecture Slices

### Slice 0: Branch Harvest And Safety Review

Purpose: make the sibling Hermes work usable without importing stale or unsafe behavior.

Tasks:

- Review the dirty sibling checkout and split reusable work into coherent patches.
- Rebase or manually port from `feat/hermes-first-class-module` onto current `origin/main`/this branch.
- Drop unrelated branding assets or splash-screen changes unless they are required for Motoko.
- Keep the first merge read-only/proposal-only.
- Preserve the current GITS tabbed cockpit structure and Skills Intelligence tab.

Owned files:

- `docs/gits/HERMES.md`
- `packages/contracts/src/gits.ts`
- `packages/contracts/src/rpc.ts`
- `packages/client-runtime/src/wsRpcClient.ts`
- `apps/server/src/gits/Services/HermesAdapter.ts`
- `apps/server/src/gits/Layers/HermesCliAdapter.ts`
- `apps/server/src/gits/Layers/HermesCliAdapter.test.ts`
- `apps/server/src/server.ts`
- `apps/server/src/ws.ts`
- `apps/web/src/components/gits/GitsCockpit.tsx`

Acceptance:

- Sibling branch differences are understood before porting.
- No unreviewed direct-execution behavior lands.
- Type contracts compile before UI work starts.

### Slice 1: Contracts And Proposal Card Shape

Purpose: make Motoko's output a durable, auditable typed contract.

Tasks:

- Add Hermes/Motoko RPC schemas under `packages/contracts/src/gits.ts`.
- Add RPC methods under `gits.hermes.*` in `packages/contracts/src/rpc.ts`.
- Add client methods in `packages/client-runtime/src/wsRpcClient.ts`.
- Extend the sibling branch's `HermesProposalCard` before using it in production:
  - `evidence: string[]`
  - `scope: string[]`
  - `risk: "low" | "medium" | "high" | "blocked"`
  - `recommendedExecutor: "none" | "delamain" | "open-gsd" | "operator"`
  - `verificationPlan: string[]`
  - `nextCommandOrPrompt: string | null`
  - `decisionReason: string | null`
  - `decidedAt: string | null`
- Keep action kinds:
  - `read-only`
  - `worktree-spawn`
  - `repo-write`
  - `integrate`
  - `destructive-shell`
- Ensure `worktree-spawn`, `repo-write`, `integrate`, and `destructive-shell` require approval.
- Add contract tests for schema decoding, action-kind approvals, and missing optional fields.

Acceptance:

- Proposal cards can show evidence, risk, executor, and verification without parsing free-form text.
- Rejected/deferred decisions persist with reason and timestamp.
- Destructive proposals decode but remain blocked by policy.

Verification:

```bash
bun run test packages/contracts/src/gits.test.ts
bun typecheck
```

### Slice 2: Hermes/Motoko Server Adapter

Purpose: expose Hermes safely through GITS server RPCs.

Tasks:

- Add `HermesAdapter` service and `HermesCliAdapter` layer.
- Resolve binary via `GITS_HERMES_BIN`, `HERMES_BIN`, then `hermes`.
- Resolve home via `GITS_HERMES_HOME`, defaulting to `~/.gits/hermes`.
- Set `HERMES_HOME` for child commands and strip `HERMES_YOLO_MODE`.
- Redact token-shaped output before returning command stdout/stderr.
- Detect:
  - binary/version
  - `hermes doctor`
  - ACP via `hermes acp --check`
  - Codex OAuth source/status
  - `SOUL.md` status
  - approval mode and unsafe config flags
- Add Motoko-managed profile status while preserving local secrets/memory.
- Persist proposal cards under the GITS-managed Hermes home, not in project repos.
- Treat unavailable Hermes as a warning state, not a server crash.

Acceptance:

- `gits.hermes.status` works when Hermes is missing, partially configured, or healthy.
- ACP check can succeed without leaving a hung stdio process.
- `HERMES_HOME=/home/joshua/.gits/hermes hermes acp --check` remains the local ground-truth smoke.
- No secret value appears in returned status, stderr, log tail, or proposal detail.

Verification:

```bash
bun run test apps/server/src/gits/Layers/HermesCliAdapter.test.ts
bun typecheck
HERMES_HOME=/home/joshua/.gits/hermes hermes acp --check
```

### Slice 3: Motoko Profile Distribution

Purpose: make Motoko a versioned GITS profile, not an ad hoc prompt.

Tasks:

- Create a GITS-owned profile distribution:

```text
profiles/motoko-gits/
  distribution.yaml
  SOUL.md
  config.yaml.example
  skills/
  cron/
  mcp.json.example
```

- Rename internal/operator-facing UI from generic Hermes to Motoko where the persona is active:
  - Header: `Motoko`
  - Subtitle: `Hermes operator for GITS`
  - Input label: `Ask Motoko`
  - Primary action: `Inspect selected project`
- Keep docs precise: Hermes is the runtime, Motoko is the operator profile.
- Add setup docs that explain `.env`, `config.yaml`, Codex OAuth, and local `HERMES_HOME` without embedding credentials.
- Do not overwrite an existing non-empty `SOUL.md`; surface a setup card instead.

Acceptance:

- GITS can report whether the Motoko profile exists, is managed, or needs setup.
- First-run setup creates only safe profile/config examples and never writes secrets.
- Existing local Hermes identity files are preserved unless explicitly approved.

Verification:

```bash
bun run test apps/server/src/gits/Layers/HermesCliAdapter.test.ts
bun typecheck
```

### Slice 4: Read-Only Project Context Bridge

Purpose: give Motoko useful evidence without allowing repo writes.

Tasks:

- Generate read-only context under the GITS state area:

```text
~/.gits/hermes-context/<project-id>.md
```

- Include:
  - repo path
  - branch, dirty state, upstream, ahead/behind
  - default remote
  - `.planning` summary when present
  - latest verification evidence when present
  - active Delamain peers
  - Open GSD status
  - Automode policy snapshot
  - provider capacity summary
  - relevant GITS runbooks
- Pass this context to Hermes through prompt context or a future MCP/resource bridge.
- Never write this generated context into the project repo unless the operator asks.

Acceptance:

- "What should I do next in this project?" returns a proposal grounded in files, commands, and state.
- Missing evidence is represented explicitly instead of hallucinated.
- Context generation is deterministic and can be tested without invoking Hermes.

Verification:

```bash
bun run test apps/server/src/gits/Layers/GitsPlanningScanner.test.ts
bun run test apps/server/src/gits/Layers/HermesCliAdapter.test.ts
bun typecheck
```

### Slice 5: Cockpit UI

Purpose: make Motoko useful in the existing tabbed cockpit without turning the app into a chat page.

Tasks:

- Add a `Motoko` or `Hermes/Motoko` tab while preserving current tabs:
  - `Overview`
  - `Fleet`
  - `Automode`
  - `Open GSD`
  - `Skills`
  - `Projects`
- Surface only high-level Motoko signals in Overview:
  - pending proposal count
  - top recommended next action
  - setup incomplete warning
  - provider routing recommendation
- In the Motoko tab, show:
  - status chips: ACP, OAuth, SOUL, Mode, Update
  - setup blockers
  - `Ask Motoko`
  - `Inspect selected project`
  - proposal cards with Evidence, Risk, Approval, Executor, Verification
  - recent sessions/log tail as secondary diagnostics
- Use explicit action CTAs:
  - `Approve`
  - `Reject`
  - `Defer`
  - `Draft Delamain Peer`
  - `Draft GSD Plan`
  - `Open Verification Checklist`
- Do not add visible instructional copy about how the UI works beyond necessary labels.

Acceptance:

- Overview stays scannable and does not become a long chat transcript.
- Proposal cards fit desktop and mobile without text overlap.
- Motoko tab can operate when Hermes is unavailable, partially configured, or healthy.
- Skills Intelligence remains a separate tab and can later feed Motoko skill-librarian proposals.

Verification:

```bash
bun run test apps/web/src/components/gits/GitsCockpit.browser.tsx
bun typecheck
```

If browser tests are not available for this branch yet, add targeted tests for the new panel state transitions before relying on manual UI smoke.

### Slice 6: Approval-To-Delamain Draft Bridge

Purpose: connect approved proposals to execution drafts without automatic repo mutation.

Tasks:

- Add an RPC that converts an approved proposal into a Delamain spawn draft.
- Draft must include:
  - repo path
  - source branch
  - target branch
  - exact prompt
  - file/module ownership
  - risk level
  - approval reason
  - verification commands
  - "not alone in the codebase" coordination note
- Do not call `delamain spawn` directly from Hermes/Motoko approval.
- Let the operator review the draft and then use the existing Delamain spawn path.
- For `repo-write`, choose between Delamain draft and Open GSD plan draft based on proposal executor.
- For `integrate`, require a separate final confirmation and use the existing integrate capability gate.
- Keep `destructive-shell` blocked; allow only manual conversion into a narrow recovery task.

Acceptance:

- Approved `worktree-spawn` proposal creates a safe Delamain draft, not a live peer.
- The draft preserves evidence and verification from the proposal card.
- Automode policy gates still apply before dispatch.
- Rejected or deferred cards cannot be drafted accidentally.

Verification:

```bash
bun run test apps/server/src/gits/Layers/AutomodeSupervisor.test.ts
bun run test apps/server/src/gits/Layers/DelamainCliAdapter.test.ts
bun run test apps/server/src/gits/Layers/HermesCliAdapter.test.ts
bun typecheck
```

### Slice 7: Open GSD Draft Bridge

Purpose: route phase-shaped work into Open GSD instead of bypassing `.planning`.

Tasks:

- Add proposal executor `open-gsd` for phase/spec/verification shaped work.
- Add a draft artifact type that can become:
  - `gsd-sdk init @prd --project-dir <dir>`
  - `gsd-sdk auto --project-dir <dir>`
  - a manual `docs/gits/*_PLAN.md` artifact when `.planning` is absent
- If a project has `.planning`, Motoko can recommend phase/spec updates but GITS/Open GSD performs them.
- If a project lacks `.planning`, proposal cards should state that docs-only planning is the current route.

Acceptance:

- Motoko does not write `.planning` directly.
- Open GSD actions remain typed server adapter calls.
- Phase truth remains discoverable through existing GITS planning scanner.

Verification:

```bash
bun run test apps/server/src/gits/Layers/OpenGsdCliAdapter.test.ts
bun run test apps/server/src/gits/Layers/GitsPlanningScanner.test.ts
bun typecheck
```

### Slice 8: Scheduled Briefings And Sentinels

Purpose: add autonomy after manual proposal flows are stable.

Tasks:

- Add server-owned schedule config, not Hermes-owned hidden cron as the source of truth.
- Start with proposal-generating jobs only:
  - daily project briefing
  - weekly stale branch/PR scan
  - Tailnet hosted service health check
  - skills inventory review
  - memory review
  - verification sentinel
- Persist schedule runs and generated cards in GITS state.
- Add kill switch and allowlist checks before any scheduled job invokes Hermes.
- Never let scheduled jobs dispatch work directly.

Acceptance:

- Scheduled jobs create proposal cards only.
- Operator can audit last run, evidence, and generated cards.
- Kill switch disables scheduled Hermes invocations.

Verification:

```bash
bun run test apps/server/src/gits/Layers/AutomodeSupervisor.test.ts
bun typecheck
```

## Implementation Order

1. Slice 0: harvest/rebase sibling Hermes branch.
2. Slice 1: contracts and proposal card schema.
3. Slice 2: server adapter and status/check/setup RPCs.
4. Slice 3: Motoko profile distribution.
5. Slice 4: read-only project context bridge.
6. Slice 5: cockpit UI.
7. Slice 6: approval-to-Delamain draft bridge.
8. Slice 7: Open GSD draft bridge.
9. Slice 8: scheduled briefings and sentinels.

## Suggested PR Breakdown

### PR 1: Motoko Status And Proposal Foundations

Includes slices 0-3.

This PR should land Hermes/Motoko status, config, ACP check, Codex OAuth status, SOUL/profile status, proposal persistence, and typed proposal cards. It must not include Delamain spawning or scheduled autonomy.

### PR 2: Motoko Cockpit And Project Context

Includes slices 4-5.

This PR should make the UI useful: Motoko tab, Overview signals, project inspection, proposal cards, setup blockers, and browser coverage.

### PR 3: Approval Draft Bridges

Includes slices 6-7.

This PR should turn approved proposal cards into reviewable Delamain/Open GSD drafts. It should still stop short of automatic dispatch.

### PR 4: Scheduled Proposal Autonomy

Includes slice 8.

This PR adds controlled scheduled scans that create proposal cards only.

## Deployment Order

1. Merge PR 1 and verify locally.
2. Deploy to the managed GITS worktree using the tailnet hosting runbook.
3. Verify `/api/gits/build-info` reports the new commit.
4. Verify `/gits` loads and the Motoko status surface reports setup blockers safely.
5. Complete local Hermes setup in `~/.gits/hermes` outside the repo.
6. Merge PR 2 after UI/browser verification.
7. Merge PR 3 only after proposal decisions persist correctly.
8. Merge PR 4 only after manual proposal routing has been stable in hosted GITS.

## Local Verification Commands

Use targeted tests while implementing each slice, then run the repo completion gates:

```bash
bun run test packages/contracts/src/gits.test.ts
bun run test apps/server/src/gits/Layers/HermesCliAdapter.test.ts
bun run test apps/server/src/gits/Layers/AutomodeSupervisor.test.ts
bun run test apps/server/src/gits/Layers/DelamainCliAdapter.test.ts
bun run test apps/server/src/gits/Layers/OpenGsdCliAdapter.test.ts
bun run test apps/web/src/components/gits/GitsCockpit.browser.tsx
bun fmt
bun lint
bun typecheck
```

Never use `bun test`; this repo requires `bun run test`.

## Hosted Smoke Checks

After deployment:

```bash
curl -fsS http://127.0.0.1:13773/api/gits/build-info | jq .
curl -fsS https://subject28.taild6d729.ts.net:8443/api/gits/build-info | jq .
curl -fsS https://subject28.taild6d729.ts.net:8443/gits >/dev/null
HERMES_HOME=/home/joshua/.gits/hermes hermes acp --check
```

Expected:

- Build info shows the deployed Motoko integration commit.
- GITS remains Tailnet-only on `:8443`.
- Motoko/Hermes status loads without exposing secrets.
- ACP check reports OK when local setup is complete.
- Setup blockers are shown as actionable warnings when local setup is incomplete.

## Open Risks

- The sibling Hermes branch is dirty and may include unrelated UI/branding changes.
- Local Hermes is behind upstream by a large number of commits; CLI behavior may drift.
- GITS-managed Hermes home is not fully configured yet.
- Proposal cards can become stale; decision timestamps and evidence are required.
- Provider capacity telemetry may be incomplete; routing recommendations must fail closed when policy requires budget evidence.
- Scheduled autonomy can create alert fatigue if added before proposal quality is proven.

## Done Criteria

The integration is done when:

1. GITS can show Motoko/Hermes status, version, ACP health, auth state, SOUL/profile state, and setup blockers without exposing secrets.
2. Asking Motoko "what should I do next in this project?" returns a ranked proposal with concrete evidence.
3. Repo-changing requests produce proposal cards, not direct edits.
4. Approving a `worktree-spawn` proposal creates a scoped Delamain draft with repo, branch, risk, file ownership, and verification commands.
5. Open GSD-shaped work is routed to Open GSD drafts or `.planning`-aware actions, not ad hoc Hermes writes.
6. Rejected/deferred proposal decisions persist and remain visible.
7. Scheduled jobs create proposal cards only and obey kill switch, allowlist, approval, provider, and budget policy.
8. Hosted GITS smoke checks prove the deployed build is the expected commit.
