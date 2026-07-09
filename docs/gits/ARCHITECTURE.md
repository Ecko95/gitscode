# GITS Architecture

GITS is a fork of T3 Code that keeps the existing remote IDE shell and adds DevOS, Delamain, and Open GSD as first-class modules.

## Product Boundary

GITS = T3 Code shell + DevOS Cockpit + Delamain Fleet + Open GSD.

The fork keeps T3 Code's existing web, desktop, server, mobile, pairing, Tailscale, SSH launch, provider session, and terminal streaming architecture. DevOS concepts are ported into this architecture as native modules; DevOS is not embedded as a second app or migrated wholesale into the monorepo.

## Ownership Split

- T3 shell: remote access, saved environments, desktop/browser/mobile clients, provider sessions, terminal streaming, pairing links, one-time tokens, bearer sessions, and WebSocket sessions.
- DevOS Cockpit: projects, clients, repos, milestones, `.planning` state, GSD phases, verification gates, UAT evidence, visual baselines, queue status, resource monitoring, cost/session visibility, and Your Turn cards.
- Delamain: peer execution substrate, worktree isolation, peer spawn/status/log/reply/wait/kill/integrate controls, frozen gates, and PR integration.
- Open GSD: `.planning` source of truth, `gsd-sdk` detection, `gsd-sdk init @prd`, and `gsd-sdk auto` execution once control surfaces exist.

## Current Open GSD Standard

- Package: `@opengsd/get-shit-done-redux`
- Active CLI: `gsd-sdk`
- Autonomous command: `gsd-sdk auto`
- Legacy `get-shit-done-cc` and `gsd-pi` are not supported.
- `gsd headless` is deferred legacy behavior and must not be the primary execution path.

## Existing T3 Code Map

- `apps/server`: HTTP/WebSocket server, auth, pairing, providers, orchestration projections, terminal manager, VCS operations, source control, diagnostics, and static web serving.
- `apps/web`: React/TanStack Router client, settings, command palette, thread shell, terminal drawer, saved remote environments, and WebSocket runtime client.
- `apps/desktop`: Electron shell, backend management, SSH launch, Tailscale endpoint handling, updates, menus, and native settings.
- `apps/mobile`: React Native remote operator client for paired environments, threads, terminals, diffs, and connection flows.
- `packages/contracts`: shared Effect schemas and RPC contracts. GITS domain contracts live in `packages/contracts/src/gits.ts`.
- `packages/client-runtime`: browser/mobile/desktop WebSocket RPC client wrappers. GITS cockpit, control, and runtime visibility APIs are exposed through this package.
- `packages/ssh`: desktop-managed SSH launch, local forwarding, remote pairing bootstrap, and bearer session bridge.
- `packages/tailscale`: Tailnet endpoint discovery and Tailscale Serve setup.
- `packages/shared`: shared runtime utilities with explicit subpath exports.

## RTK Output Boundary

RTK integration must separate post-execution display shaping from true provider-token savings:

- Display compaction rewrites or filters output after a command already ran. It is useful for operator-facing logs, stored transcript size, and UI readability, but it does not reduce provider tokens by itself.
- Agent token compaction requires rewriting the command path before the provider tool runs so the provider never emits the raw high-volume output into model context.
- Codex app-server currently emits command-output events only after the command has already run. For Codex sessions, the safe first path is concise developer guidance to prefer explicit RTK wrappers such as `rtk gh`, `rtk git`, `rtk tsc`, `rtk vitest`, `rtk grep`, and `rtk pipe` when RTK is available, while preserving raw commands for JSON, NDJSON, protocol payloads, and other exact-output flows.
- Claude-style tool interception remains the place where future provider-aware command rewriting can produce actual token savings.

## Milestone 1 Read-Only Flow

The first GITS surface is intentionally read-only:

1. The web app requests `gits.cockpit.get`.
2. The server reads the existing orchestration shell snapshot for registered projects and active threads.
3. The GITS planning scanner inspects each project root for `.planning` without running arbitrary shell commands.
4. The scanner returns projects, repos, GSD phases, verification gates, agent sessions, empty peer/goal placeholders, and Your Turn candidates.
5. The cockpit page renders observable state only. It does not spawn peers, execute GSD, merge PRs, or mutate `.planning`.

Runtime visibility reuses the existing server resource-history RPC. The GITS cockpit shows active agent sessions, sampled CPU time, peak memory, top descendant processes, and provider-runtime cost/token usage when the active provider emits spend data.

## Milestone 2 Delamain Flow

The Delamain boundary is a typed server adapter over a narrow command surface. The web client calls `gits.delamain.*` RPC methods; only the server adapter invokes the local `delamain` binary with fixed argument lists.

Current CLI-backed methods:

- `gits.delamain.peers.list`: reads peer records and detected adapter capabilities.
- `gits.delamain.peers.status`: reads one peer record.
- `gits.delamain.peers.log`: reads recent peer logs.
- `gits.delamain.peers.spawn`: starts a peer in Delamain's isolated worktree flow.
- `gits.delamain.peers.reply`: resumes a waiting peer with an operator prompt.
- `gits.delamain.peers.kill`: terminates a peer runner.
- `gits.delamain.peers.wait`: polls peer status until a terminal state or timeout.

`integrate` is present in the GITS contract but is capability-gated because the local Delamain CLI currently does not expose an `integrate` command. The richer MCP integration path remains the target for PR/auto-merge controls.

## Milestone 3 Open GSD Flow

Open GSD is exposed through a typed server adapter over the current `gsd-sdk` CLI from `@opengsd/get-shit-done-redux`.

Current CLI-backed methods:

- `gits.openGsd.status`: detects `gsd-sdk`, reads `gsd-sdk --version`, and reports supported `detect`, `init`, and `auto` capabilities.
- `gits.openGsd.init`: runs `gsd-sdk init <input> --project-dir <dir>` where `<input>` is typically an `@prd` reference.
- `gits.openGsd.auto`: runs `gsd-sdk auto --project-dir <dir>` with optional `--init <input>`.

The cockpit polls `gits.cockpit.get` after Open GSD actions and on its normal refresh interval. The planning scanner reads `.planning/PROJECT.md` client metadata, `.planning/milestones/*` counts, `.planning/phases/*` artifact presence, and latest artifact mtimes so phase cards update as Open GSD mutates `.planning`.

## Milestone 4 Automode Flow

Automode is a server-owned supervisor surface. The cockpit reads and mutates typed automode state through `gits.automode.*`; the browser never spawns autonomous peers directly.

The supervisor persists policy and queued goal state under the server state directory at `gits/automode-state.json`. On every boot it schema-decodes this file, then **re-arms the kill switch** (`killSwitchEnabled: true`) and **clears every goal's `approvedAt`**, regardless of what was persisted. A missing or invalid state file falls back to locked defaults (`mode: "manual"`, kill switch on, empty allowlists) instead of resuming anything.

Automode is opt-in on every restart, not just on first boot: the policy, repo allowlist, and queued goals survive a reboot, but **execution does not resume** — nothing dispatches until an operator explicitly turns the kill switch back off (`updatePolicy`) and re-approves any goal that needs it (`approveGoal`). This is deliberate: a persisted autonomous, killswitch-off policy with already-approved goals must never auto-resume real work just because the server restarted.

Per-repo opt-in is separate from the kill switch: a repo only runs automode work if its absolute path is in the policy's `allowedRepos` list. **An empty list denies every repo** — it is not an allow-all default (see `repoAllowed` in `apps/server/src/gits/Layers/AutomodeSupervisor.ts`). Arming `mode: "autonomous"` additionally requires a non-empty `allowedRepos` and a non-null `maxBudgetUsd`; `updatePolicy` rejects the update otherwise.

Current supervisor methods:

- `gits.automode.snapshot`: reads the current policy, provider-runtime budget usage, goal queue, active peer count, and pending approvals.
- `gits.automode.policy.update`: updates mode, kill switch, max active peers, repo/model allowlists, budget/time fields, and approval gates.
- `gits.automode.goals.enqueue`: queues an operator goal with repo, model, and prompt.
- `gits.automode.goals.approve`: marks a goal as approved for supervised or approval-gated dispatch.
- `gits.automode.goals.reject`: rejects a queued or waiting goal.
- `gits.automode.goals.dispatch`: checks kill switch, mode, peer limit, repo allowlist, model allowlist, and approval gates before calling the Delamain adapter to spawn a peer.

Destructive and integration-shaped prompts are held for approval when the matching policy gates are enabled. Runtime limits are enforced by scheduling a Delamain peer termination after the configured max runtime. Budget checks read projected provider-runtime usage cost events and fail closed: when a USD budget is configured but provider cost telemetry is unavailable, dispatch is blocked until telemetry is available or the operator clears the budget cap.

In `mode: "autonomous"` with the kill switch off, a background driver (`apps/server/src/gits/Layers/AutomodeDriver.ts`, polling every `GITS_AUTOMODE_DRIVER_TICK_MS`, default 5000ms) dispatches the oldest queued goal itself, then verifies, lands, and opens a held PR without further operator RPC calls. In `manual` or `supervised` mode the driver takes no action at all; goals sit queued until an operator calls `dispatchGoal` by hand. The final merge is always a **held PR opened against `gits`** — the driver never merges it; a human does.

### How to enable automode for a repo

1. Arm the policy for one repo — `gits.automode.policy.update` (`updatePolicy`):

   ```jsonc
   {
     "mode": "autonomous", // or "supervised" to force approveGoal on every goal
     "killSwitchEnabled": false, // re-armed to true on every server restart
     "allowedRepos": ["/abs/path/to/repo"], // empty = no repo runs
     "integrationBranch": "main",
     "verificationCommands": [{ "label": "test", "cmd": ["bun", "test"] }],
     "maxBudgetUsd": 20, // required whenever mode is "autonomous"
   }
   ```

2. Queue work — `gits.automode.goals.enqueue` (`enqueueGoal`): `{ title, prompt, repo, model? }`.
3. Approve it — `gits.automode.goals.approve` (`approveGoal`): `{ goalId }`. Skip this only if `mode` is `autonomous`, `requireApprovalForPeerSpawn: false`, and the prompt doesn't trip the integration/destructive heuristics (or those gates are off too).
4. `autonomous` mode: the driver dispatches, verifies, lands, and opens the held PR on its own. `manual`/`supervised`: dispatch by hand with `gits.automode.goals.dispatch` (`dispatchGoal`): `{ goalId }`.
5. Merge the held PR yourself. There is no auto-merge, in any mode.

### With Motoko vs without Motoko

**Without Motoko (default, no extra setup):** the operator drives every step above directly through the `gits.automode.*` RPCs. Automode has no dependency on Motoko/Hermes being configured, running, or even installed.

**With Motoko:** approving a Motoko proposal can _additionally_ enqueue an automode goal, but only when the operator opts in — `autoEnqueueApprovedProposals: true` on the policy **and** `mode: "autonomous"`. Even then, Motoko never calls `enqueueGoal` itself: approval runs through the existing Hermes draft rails (`decideProposal` → `draftFromProposal`), and only an approved `delamain-peer` draft becomes a queued goal — same approval gates, same kill switch, same reboot reset as any operator-enqueued goal. See [HERMES.md § Relationship to Automode](./HERMES.md#relationship-to-automode) for the full bridge contract.

## Adapter Rule

UI code calls typed adapters and RPC methods. It must not construct arbitrary shell commands. Future write controls should land as explicit server-side adapters:

- Delamain adapter: list/status/log/spawn/kill/reply/wait/integrate.
- Open GSD adapter: detect `gsd-sdk`, run `gsd-sdk init @prd`, run `gsd-sdk auto`, and watch `.planning`.
- Automode adapter: goal queue, policy config, kill switch, approval gates, and supervised/autonomous limits.

## Automation Order

Observable state comes first, control second, automation last. Milestone 1 must stay read-only. Milestone 2 may add Delamain controls. Milestone 3 may add Open GSD execution. Milestone 4 may add automode policy and autonomous peer spawning within explicit limits.
