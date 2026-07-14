# Motoko Hermes Integration in GITS

Hermes is the runtime. Motoko is the GITS-owned operator profile running on that runtime.

Motoko is integrated as a first-class GITS module beside DevOS Cockpit, Delamain Fleet, Open GSD, Automode, and Skills Intelligence, but it does not own repo execution. Its default job is to reason, remember, brief, inspect read-only context, and produce proposal cards that the operator can approve, reject, defer, or convert into drafts.

## Architecture

GITS talks to Hermes through typed RPCs under `gits.hermes.*` and reads provider routing telemetry through `gits.capacity.snapshot`.

- Contracts live in `packages/contracts/src/gits.ts` and `packages/contracts/src/rpc.ts`.
- The browser client uses `packages/client-runtime/src/wsRpcClient.ts`.
- The server adapter lives in `apps/server/src/gits/Layers/HermesCliAdapter.ts`.
- The cockpit surface is rendered in `apps/web/src/components/gits/GitsCockpit.tsx`.

The adapter shells out to the local `hermes` binary with fixed argument lists. It detects `hermes --version`, runs `hermes doctor`, checks ACP with `hermes acp --check`, tails local Hermes logs, lists sessions, and records GITS proposal cards under the isolated Hermes home. Project context is generated under the GITS state area, not inside project repos.

## State And Identity

GITS does not use Hermes' default global home unless the operator explicitly configures it. The default GITS-managed home is:

```sh
~/.gits/hermes
```

Override it with:

```sh
GITS_HERMES_HOME=/path/to/hermes-home
```

## Telegram relay deployment

The GITS server service and the Hermes gateway's managed service environment both require these two variables:

```sh
GITS_HERMES_HOME=/path/to/hermes-home
GITS_HERMES_TELEGRAM_RELAY_TOKEN=<high-entropy-shared-token>
```

Use the same high-entropy relay token in both services. Hermes is the sole Telegram credential holder and long-poll owner. It relays only `APPROVE <goal-id>`, `REJECT <goal-id>`, `DEFER <goal-id>`, `ARM`, `SKIP <goal-id>`, and `STOP` to GITS's loopback-only `POST /api/gits/hermes-telegram/command` route with that bearer token, then returns the route response text verbatim. GITS does not run a Telegram poller, bot, or external listener.

The setup path creates or updates only a GITS-managed `SOUL.md`. Existing custom non-empty `SOUL.md` files are not overwritten. The Motoko profile distribution lives in:

```text
profiles/motoko-gits/
```

The operator-facing identity is:

> Motoko, the Hermes operator in the GITS shell

This is a private GITS operator profile: calm, tactical, precise, evidence-first, loyal to the operator, and protective of system integrity. It is not an official or public branded character profile and does not copy canon dialogue.

## Codex OAuth

Hermes supports OpenAI Codex OAuth and can import existing Codex CLI credentials from `~/.codex/auth.json`. GITS reports only auth source and existence:

- `hermes-home`
- `codex-cli`
- `both`
- `missing`

OAuth tokens are never read into the UI, logged, or copied into repo files. If auth is missing, the setup RPC returns an actionable next command such as:

```sh
HERMES_HOME=~/.gits/hermes hermes auth add openai-codex --type oauth
```

## ACP

ACP is the preferred first-class editor/agent integration because it exposes chat, tool activity, diffs, terminal commands, approval prompts, and streamed responses over stdio. GITS checks ACP with:

```sh
HERMES_HOME=~/.gits/hermes hermes acp --check
```

The cockpit's "Start ACP" action prepares and validates the attached-client launch command:

```sh
HERMES_HOME=~/.gits/hermes hermes acp
```

GITS does not keep an unattached stdio ACP process alive, so this RPC returns without hanging the server.

## Policy

Motoko/Hermes is observe/propose only by default.

- Motoko must not merge, admin-merge, force-push, or run destructive shell commands.
- Motoko must not use `HERMES_YOLO_MODE`.
- Hermes approval mode must be `manual` or `smart`; `off` is treated as unsafe.
- Repo writes must be handed to Delamain so execution happens in isolated worktrees.
- GITS owns visibility, approval state, and policy.
- Human approval is required before integrate, merge, destructive commands, or write-shaped proposals.

Proposal cards carry an action kind:

- `read-only`
- `worktree-spawn`
- `repo-write`
- `integrate`
- `destructive-shell`

Only read-only proposals can be treated as informational. All other action kinds are approval cards and remain handoff-only until the operator converts them into a Delamain or Open GSD draft.

## Relationship to Automode

Motoko remains handoff-only by default: drafts and proposals are returned to the cockpit for an operator to act on, never executed. Separately, the Automode module has a fully autonomous dispatch→verify→land→held-PR driver, gated by AutomodePolicy — mode, kill switch, budget cap, repo/model allowlists, the review gate, and a held PR that only a human merges.

An opt-in bridge connects the two: when the `autoEnqueueApprovedProposals` policy flag is on (off by default) AND automode is armed autonomous, approving a Motoko proposal converts it through the existing draft rails and enqueues the result as an automode goal. Only `delamain-peer` drafts with status `draft` qualify — open-gsd, verification, and blocked drafts stay handoff-only, and re-approving an already approved proposal never enqueues a duplicate. The bridge does not seed `verificationCommands`; the driver still halts fail-closed until the operator configures them per repo. Human judgment stays in the loop twice: the proposal approval itself, and the held-PR merge at the end of the run.

Two limits worth knowing: the automode usage meter reads GITS provider-thread cost only — Delamain peer (Codex/Cursor CLI) spend is not metered, so the runtime and peer caps are the effective bound on peer cost. And the INTEGRATION/DESTRUCTIVE prompt patterns used for approval gating are heuristics, not a security boundary.

Automode is opt-in on every server restart (see `docs/gits/ARCHITECTURE.md` § Milestone 4): boot re-arms the kill switch and clears every goal's approval, bridge-enqueued goals included. A bridge-armed run does not resume itself after a restart — the operator must re-enable the kill switch and re-approve.

## Operations

The cockpit exposes:

- Motoko/Hermes status and version
- Codex OAuth status with no secrets
- SOUL/profile status
- ACP health
- Cockpit message input for operator requests
- Recent sessions and log tail
- Self-improvement proposal cards
- Approve, reject, and defer controls
- Read-only project context writing
- Draft generation for approved proposals
- Manual scheduled briefing/sentinel runs that create proposal cards only

The minimal launch path is:

1. Check Hermes.
2. Setup Hermes with Codex OAuth and the Motoko profile.
3. Start Hermes ACP session.
4. Write read-only project context.
5. Ask Motoko to inspect GITS and produce one read-only proposal.

Cockpit messages use `hermes chat` in quiet one-shot mode and are stored as proposal cards. Requests that mention agents, peers, Delamain, parallel work, or worktrees are classified as `worktree-spawn`; they require approval and remain handoff-only until the operator reviews a generated draft and routes it through Delamain.

Read-only project context is generated at:

```text
~/.gits/hermes-context/<project-id>.md
```

The context includes git state, planning and verification evidence when present, Delamain fleet status, Open GSD status, automode policy, provider capacity summary, and `docs/gits` runbook excerpts. Missing evidence is written explicitly instead of inferred.

Approved proposal cards can become execution drafts:

- `delamain-peer` for approved repo-writing worktree tasks
- `open-gsd` for phase/spec/verification-shaped work
- `verification` for approved read-only follow-up

Drafts are returned to the cockpit. GITS does not spawn Delamain peers or run Open GSD automatically from Motoko approval.

Scheduled Motoko runs are RPC-triggered proposal generators. They support daily briefing, weekly stale scan, tailnet health, skills review, memory review, and verification sentinel prompts. `GITS_MOTOKO_SCHEDULES_DISABLED=1` blocks scheduled Hermes invocation.

Motoko cockpit chat also receives a safe provider-capacity snapshot:

- Codex 5h and weekly utilization are read from local Codex rate-limit events.
- Cursor monthly budget defaults to the BTS `$500` cap.
- Cursor spend can be supplied with `GITS_CURSOR_MONTHLY_SPEND_USD`, `GITS_CURSOR_USAGE_FILE`, or a local `WorkosCursorSessionToken` secret.
- The snapshot includes a recommended Delamain engine, but Hermes may only propose that routing. GITS approvals and Delamain worktree isolation still own execution.

Dashboard-backed Cursor spend is enabled by setting `GITS_CURSOR_WORKOS_TOKEN` or by writing a local secret outside the repo:

```json
{
  "workosCursorSessionToken": "paste cookie value here",
  "teamId": 123
}
```

Default path: `~/.gits/secrets/cursor-dashboard.json`. `teamId` is optional; when absent, GITS tries the first Cursor team returned by the dashboard API. The secret is only sent to `cursor.com/api` and is never exposed through GITS RPCs, logs, docs, or the browser UI.

## Upstream References

- https://github.com/NousResearch/hermes-agent
- https://hermes-agent.nousresearch.com/docs/integrations/providers
- https://hermes-agent.nousresearch.com/docs/user-guide/features/acp/
- https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp
- https://hermes-agent.nousresearch.com/docs/user-guide/features/personality/
- https://hermes-agent.nousresearch.com/docs/user-guide/security
