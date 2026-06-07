# Headless / Remote-Agent Mode — Implementation Plan

Branch: `feat/gits-headless`
Category: Headless / remote-agent mode

## 0. TL;DR (what this plan delivers vs defers)

T3 Code **already has a working headless entrypoint**: `t3 serve` boots the full
server stack (`apps/server/src/server.ts` → `runServer`) with no Electron/desktop
UI and no browser, then prints a connection string, owner pairing token, pairing
URL and a terminal QR code. This is implemented today via
`startupPresentation: "headless"` (see `apps/server/src/cli/server.ts`,
`apps/server/src/cli/config.ts`, `apps/server/src/serverRuntimeStartup.ts:436`,
`apps/server/src/startupAccess.ts`). Tailscale HTTPS exposure (`--tailscale-serve`)
and credential/session/project management (`t3 auth`, `t3 project`) also already
work headlessly.

The **real gap** for "headless as a control plane for REMOTE AGENTS" is this:
all SSH remote-agent provisioning/management logic lives in `packages/ssh`
(`launchOrReuseRemoteServer`, `issueRemotePairingToken`, `stopRemoteServer`,
`SshEnvironmentManager`) but is **only wired into the desktop app** through
`apps/desktop/src/ssh/*` + `apps/desktop/src/ipc/methods/sshEnvironment.ts`. A
headless machine running `t3 serve` over SSH today has **no way** to set up or
manage other remote agents — that capability is locked behind the GUI.

**This slice** adds a server-side `t3 remote` CLI command group that reuses the
existing `packages/ssh` tunnel primitives (no duplication) to provision, list,
inspect, and tear down remote T3 agents from a headless host, persisting the
saved environments in a small server-side registry. It also documents `t3 serve`
as the canonical headless entrypoint in `REMOTE.md`.

Deferred (documented in §7): port-forward lifecycle daemon for headless (the
desktop keeps the forward alive in its process; CLI provisions + pairs and then
hands back a reachable URL), interactive SSH password prompts in the CLI,
exposing remote-agent management over the WebSocket/HTTP API for the web UI, and
remote project management GUIs.

---

## 1. Current State (verified, with file references)

### 1.1 Headless server boot — ALREADY EXISTS
- `apps/server/src/bin.ts` — CLI root. `Command.make("t3", …)` with subcommands
  `[startCommand, serveCommand, authCommand, projectCommand]`. Built to
  `dist/bin.mjs` (`apps/server/package.json` `bin.t3`, `tsdown.config.ts`).
- `apps/server/src/cli/server.ts`:
  - `serveCommand` → `runServerCommand(flags, { startupPresentation: "headless", forceAutoBootstrapProjectFromCwd: false })`.
  - `startCommand` / root → `startupPresentation: "browser"`.
- `apps/server/src/cli/config.ts` — `resolveServerConfig`. When
  `startupPresentation === "headless"`: forces `noBrowser = true` and
  `autoBootstrapProjectFromCwd = false`. Owns all shared flags incl.
  `--host`, `--port`, `--tailscale-serve`, `--tailscale-serve-port`,
  `--base-dir`, `cwd` argument.
- `apps/server/src/config.ts` — `StartupPresentation = Schema.Literals(["browser", "headless"])`,
  `ServerConfigShape`, `deriveServerPaths` (state dir, `server-runtime.json`,
  `secrets`, etc.), `ServerConfig` service tag.
- `apps/server/src/serverRuntimeStartup.ts:436-442` — on ready, if headless,
  calls `issueHeadlessServeAccessInfo()` and `Console.log(formatHeadlessServeOutput(...))`.
- `apps/server/src/startupAccess.ts` — `issueHeadlessServeAccessInfo`,
  `formatHeadlessServeOutput`, `buildPairingUrl`, `renderTerminalQrCode`,
  `resolveHeadlessConnectionString`. Issues an **owner** pairing credential via
  `ServerAuth.issuePairingCredential({ role: "owner" })`.
- `apps/server/src/server.ts` — `makeServerLayer`/`runServer`. Boots HTTP+WS,
  persistence, provider runtime, orchestration, gits layer, auth, tailscale serve
  acquire/release. **Only `ServerConfig` is provided by the CLI layer** (see the
  comment at `server.ts:490`) — important constraint for new layers.

### 1.2 Credential / project management headlessly — ALREADY EXISTS
- `apps/server/src/cli/auth.ts` — `t3 auth pairing {create,list,revoke}`,
  `t3 auth session {issue,list,revoke}`, backed by `AuthControlPlane`
  (`apps/server/src/auth/Services/AuthControlPlane.ts`,
  `apps/server/src/auth/Layers/AuthControlPlane.ts`).
- `apps/server/src/cli/project.ts` — `t3 project {add,remove,rename}`. Dispatches
  through a running server (reads `server-runtime.json`) or offline through the
  orchestration engine. Pattern to copy for live-vs-offline CLI.

### 1.3 Remote-agent SSH provisioning — EXISTS but DESKTOP-ONLY
- `packages/ssh/src/tunnel.ts` (the reusable engine, transport-agnostic):
  - `launchOrReuseRemoteServer(target, auth?, runner?)` — SSHes in, runs
    `REMOTE_LAUNCH_SCRIPT`, returns `{ remotePort, remoteServerKind }`.
  - `issueRemotePairingToken(target, auth?, runner?)` — returns `{ credential }`.
  - `stopRemoteServer(target, auth?)` — runs `REMOTE_STOP_SCRIPT`.
  - `SshEnvironmentManager` (Context.Service) — `ensureEnvironment` (launch + pair
    + open local port forward + readiness) and `disconnectEnvironment`. **Holds
    the local port forward in-process** (`SshTunnelEntry.process`/`scope`).
  - `buildRemoteT3RunnerScript` / `resolveRemoteT3CliPackageSpec` —
    `t3@<version>` / `t3@nightly` / `t3@latest` selection.
- `packages/ssh/src/command.ts` — `resolveSshTarget(alias)` (via `ssh -G`),
  `runSshCommand`, `parseSshResolveOutput`, `buildSshHostSpec`,
  `remoteStateKey(target)`.
- `packages/ssh/src/auth.ts` — `SshAuthOptions` (`authSecret`, `interactiveAuth`,
  `batchMode`), `buildSshChildEnvironment`.
- `packages/contracts/src/ipc.ts:236+` — `DesktopSshEnvironmentTargetSchema`
  (`{ alias, hostname, username, port }`), `DesktopSshEnvironmentBootstrap`,
  `DesktopDiscoveredSshHost`. Note: these live under the `Desktop*` prefix even
  though the runtime engine in `packages/ssh` is desktop-agnostic.
- Desktop wiring (the only current consumer):
  `apps/desktop/src/ssh/DesktopSshEnvironment.ts` (provides
  `SshEnvironmentManager.layer(...)`), `apps/desktop/src/ipc/methods/sshEnvironment.ts`,
  `apps/desktop/src/ssh/DesktopSshRemoteApi.ts`,
  `apps/desktop/src/ssh/DesktopSshPasswordPrompts.ts`.
- Web/desktop UI surface: `apps/web/src/components/settings/ConnectionsSettings.tsx`,
  `apps/web/src/environments/runtime/*` (saved-environment registry on the client).

### 1.4 Tailscale — ALREADY EXISTS end-to-end
- `packages/tailscale/src/tailscale.ts` — `ensureTailscaleServe`,
  `disableTailscaleServe`, `resolveTailscaleHttpsBaseUrl`, status parsing.
- Wired in `apps/server/src/server.ts:418-468` behind `tailscaleServeEnabled`.

### 1.5 In-flight design context (build on, do not duplicate)
- `REMOTE.md` — already documents Option 2 "Headless Server (CLI)" = `t3 serve`,
  Option 3 "Desktop-Managed SSH Launch", pairing model, `t3 auth`.
- `.plans/19-remote-endpoints-hosted-static.md` — advertised-endpoint /
  saved-environment registry direction (`packages/contracts/src/remoteAccess.ts`
  `AdvertisedEndpoint`).
- `TODO.md` — the "Self-improving orchestration" gits stack (Hermes / Delamain /
  Automode / verifier-critic) is the *in-process* agent orchestration; it is
  orthogonal to this networking/headless slice and must not be disturbed.

---

## 2. Goal of this slice

Deliver a coherent, minimal-but-working vertical slice:

1. `t3 serve` is the documented headless entrypoint (already works) — verified +
   one regression test for headless config resolution.
2. A new `t3 remote` CLI command group, runnable from a headless box, that uses
   the **existing** `packages/ssh` engine to:
   - `t3 remote add <ssh-target>` — provision/reuse a remote T3 agent over SSH,
     issue a pairing credential, persist a saved environment record, print the
     reachable `httpBaseUrl` + pairing token/URL.
   - `t3 remote list` — list saved remote agents (no secrets).
   - `t3 remote status <id|alias>` — probe a saved remote agent's reachability.
   - `t3 remote remove <id|alias>` — stop the remote managed server (best-effort)
     and drop the saved record.
3. A small server-side saved-remote-agent registry (JSON under the server state
   dir), shared by the CLI now and reusable by HTTP/WS later.

No new networking primitives are written — everything routes through
`packages/ssh` and the existing `ServerAuth` pairing model.

---

## 3. Technical Approach (per piece)

### 3.1 `t3 remote` CLI command group (NEW)
New file `apps/server/src/cli/remote.ts`, mirroring the structure of
`apps/server/src/cli/auth.ts` and `apps/server/src/cli/project.ts`:
- Use `Command.make("remote")` + `Command.withSubcommands([...])`; export
  `remoteCommand`; register it in `apps/server/src/bin.ts`
  `Command.withSubcommands([startCommand, serveCommand, authCommand, projectCommand, remoteCommand])`.
- Shared flags via `projectLocationFlags` / `authLocationFlags` (`--base-dir`)
  and `resolveCliAuthConfig` to obtain a `ServerConfigShape` (so the registry path
  derives from `deriveServerPaths` exactly like every other CLI command).
- Subcommands call `packages/ssh` functions directly:
  - `add`: `resolveSshTarget(alias)` → `launchOrReuseRemoteServer(target, auth, runner)`
    → `issueRemotePairingToken(target, auth, runner)`. `runner` from
    `resolveRemoteT3CliPackageSpec({ appVersion: packageJson.version, updateChannel: "stable" })`
    (reuse the same resolver the desktop uses). Persist via the registry (§3.2),
    print reachable info.
  - `remove`: `stopRemoteServer(target, auth)` (best-effort, `Effect.ignore`),
    then registry delete.
  - `status`: registry read + `waitForHttpReady`/a lightweight probe against the
    saved `httpBaseUrl` (use `packages/ssh` `waitForHttpReady` or
    `fetchLoopbackSshJson` patterns; FetchHttpClient is already a CLI-available
    layer per `apps/server/src/cli/project.ts`).
  - `list`: registry read, redacting tokens (mirror `formatPairingCredentialList`
    redaction discipline in `apps/server/src/cliAuthFormat.ts`).
- Flags for `add`: `--user`, `--port` (SSH port), `--no-pair` (skip credential),
  `--json`. Provide `ChildProcessSpawner`/`FileSystem`/`Path`/`HttpClient`/`NetService`
  via the existing CLI runtime layer composition (see `bin.ts` `CliRuntimeLayer`
  = `NodeServices.layer + NetService.layer`; add `FetchHttpClient.layer` like
  `project.ts` does, and the SSH password-prompt service in non-interactive mode).
- Non-interactive auth: default `batchMode: "yes"` (no TTY prompts) for the
  headless path; interactive password prompts are deferred (§7). Provide a no-op
  `SshPasswordPrompt` layer that fails fast if a password is required, so the
  engine's required context is satisfied without desktop dependencies.

### 3.2 Saved remote-agent registry (NEW, server-side)
New file `apps/server/src/remote/RemoteAgentRegistry.ts` (+ `.test.ts`):
- A small Effect service persisting a JSON file at a new derived path
  `remoteAgentsPath = join(stateDir, "remote-agents.json")` added to
  `ServerDerivedPaths`/`deriveServerPaths` in `apps/server/src/config.ts`
  (and `ensureServerDirectories` already makes `stateDir`).
- Schema in `packages/contracts/src/remoteAccess.ts` (extend the existing file):
  `RemoteAgentRecord = Schema.Struct({ id, alias, target: DesktopSshEnvironmentTargetSchema (or a re-exported neutral alias), httpBaseUrl, wsBaseUrl, remoteServerKind, createdAt, lastSeenAt })`
  and `RemoteAgentRegistryFile = Schema.Struct({ version, agents: Schema.Array(RemoteAgentRecord) })`.
  Decode/encode with `Schema.fromJsonString` (consistent with codebase).
- Use `atomicWrite` (`apps/server/src/atomicWrite.ts`) for safe persistence,
  matching `serverRuntimeState.ts` patterns.
- Keep it schema-light and runtime-light so it can later back an HTTP route +
  WS RPC for the web UI without rework (this is the §7 deferred path).

### 3.3 Pairing reuse
- For SSH-provisioned remotes, pairing tokens come from the **remote** server via
  `issueRemotePairingToken` (already implemented). For the local headless server
  itself, the existing `t3 serve` headless output + `t3 auth` cover issuance.
  No new pairing logic is introduced.

### 3.4 Documentation
- `REMOTE.md` — add a short "Option 4: Headless control plane (`t3 remote`)"
  subsection under the existing Remote Access options, cross-referencing Option 2
  (`t3 serve`) and Option 3 (desktop SSH launch), and noting the port-forward
  lifecycle caveat (§7).

---

## 4. Files to Create / Modify (verified real paths)

### Create
- `apps/server/src/cli/remote.ts` — `t3 remote {add,list,status,remove}`.
- `apps/server/src/cli/remote.test.ts` — CLI parsing + registry round-trip
  (mirror `apps/server/src/bin.test.ts` / `apps/server/src/cli/config.test.ts`).
- `apps/server/src/remote/RemoteAgentRegistry.ts` — saved-agent registry service.
- `apps/server/src/remote/RemoteAgentRegistry.test.ts` — persistence round-trip.

### Modify
- `apps/server/src/bin.ts` — import + register `remoteCommand` in
  `Command.withSubcommands([...])`.
- `apps/server/src/config.ts` — add `remoteAgentsPath` to `ServerDerivedPaths`
  and populate it in `deriveServerPaths`; update the `ServerConfig.layerTest`
  and any `ServerConfigShape` literals (`apps/server/src/bin.test.ts:52`,
  `config.ts:138 layerTest`) to include the new field.
- `packages/contracts/src/remoteAccess.ts` — add `RemoteAgentRecord` +
  `RemoteAgentRegistryFile` schemas (re-export a neutral `RemoteSshTarget` alias
  for `DesktopSshEnvironmentTargetSchema` to avoid the `Desktop*` naming leaking
  into server-side code; keep the underlying schema shared).
- `apps/server/package.json` — add `"@t3tools/ssh": "workspace:*"` to
  `devDependencies` (currently only `@t3tools/tailscale` is listed; `@t3tools/ssh`
  is needed by the new CLI). Verify with `bun typecheck`.
- `REMOTE.md` — document the `t3 remote` control-plane option.
- `TODO.md` — add a short "Headless / remote-agent mode" progress section
  (per repo CLAUDE.md progress-tracking rule).

### Read-only references (do not modify)
- `apps/server/src/cli/auth.ts`, `apps/server/src/cli/project.ts`,
  `apps/server/src/cli/config.ts` — CLI conventions.
- `packages/ssh/src/tunnel.ts`, `packages/ssh/src/command.ts`,
  `packages/ssh/src/auth.ts` — engine to reuse.
- `apps/server/src/startupAccess.ts`, `apps/server/src/serverRuntimeStartup.ts` —
  existing headless output (left unchanged).

---

## 5. Acceptance Criteria

1. `t3 serve` continues to boot the full server stack headlessly (no browser, no
   Electron) and print connection string + owner pairing token + pairing URL +
   QR. A new/extended test asserts `resolveServerConfig(..., { startupPresentation: "headless" })`
   yields `noBrowser === true` and `autoBootstrapProjectFromCwd === false`.
2. `t3 remote --help`, `t3 remote add --help`, `list`, `status`, `remove` are
   registered and parse (covered by `remote.test.ts`, mirroring `bin.test.ts`
   parsing tests; no live SSH required for the parsing/registry tests).
3. `t3 remote add <alias>` (with a reachable SSH target) provisions/reuses a
   remote agent via `launchOrReuseRemoteServer`, issues a pairing token via
   `issueRemotePairingToken`, persists a `RemoteAgentRecord`, and prints the
   reachable URL + pairing token/URL. `--json` emits machine-readable output.
4. `t3 remote list --json` returns persisted records **without** pairing secrets.
5. `t3 remote remove <id|alias>` best-effort-stops the remote managed server and
   removes the registry record (idempotent: removing an unknown id is a clean
   no-op message).
6. The registry persists across CLI invocations under
   `<base-dir>/userdata/remote-agents.json` and round-trips through the
   contracts schema (covered by `RemoteAgentRegistry.test.ts`).
7. No new code duplicates `packages/ssh` networking logic; the CLI imports the
   existing functions. `apps/server/src/server.ts` launch-layer constraint
   ("only `ServerConfig` provided by the CLI layer") is respected — the registry
   is only used by CLI commands, not injected into `runServer`.
8. `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test` all pass
   (per `AGENTS.md`; never `bun test`).

---

## 6. Risks

- **Port-forward lifetime mismatch (biggest).** `SshEnvironmentManager.ensureEnvironment`
  keeps the local forward alive **inside the desktop process** (`SshTunnelEntry.scope`).
  A one-shot CLI command cannot hold a long-lived forward. Mitigation for this
  slice: `t3 remote add` provisions + pairs and returns the **remote** reachable
  URL (works directly when the remote is reachable over Tailnet/LAN/HTTPS, the
  recommended `REMOTE.md` setup); the persistent local-forward daemon is deferred
  (§7). This keeps the slice honest and avoids a half-built daemon.
- **`Desktop*` contract naming.** SSH target/bootstrap schemas are under
  `Desktop*` in `packages/contracts/src/ipc.ts`. Reusing them server-side risks
  conceptual confusion. Mitigation: add a neutral re-export alias rather than
  renaming (renaming would ripple through desktop/web/mobile).
- **CLI runtime context surface.** The SSH engine requires
  `ChildProcessSpawner | FileSystem | Path | HttpClient | NetService | SshPasswordPrompt`.
  Mitigation: compose exactly the layers `bin.ts`/`project.ts` already use, plus a
  fail-fast no-op `SshPasswordPrompt` for non-interactive mode.
- **Remote Node/version preflight.** `launchOrReuseRemoteServer` can fail if the
  remote Node doesn't satisfy `engines.node`. Mitigation: surface the engine
  `REMOTE.md` troubleshooting guidance verbatim in CLI error output; do not
  re-implement detection (the remote launch script already does it).
- **Schema literal drift.** Adding `remoteAgentsPath` to `ServerDerivedPaths`
  forces updates in `ServerConfig.layerTest` and `bin.test.ts`'s inline
  `ServerConfigShape`. Mitigation: grep for `satisfies ServerConfigShape` and
  `deriveServerPaths(` and update all sites; `bun typecheck` will catch misses.

---

## 7. Explicitly Deferred (with rationale)

- **Persistent local port-forward daemon for headless** (`t3 remote forward` /
  keeping the SSH `-L` forward alive in a background CLI process). Needs process
  supervision/PID files beyond a one-shot command; the desktop currently owns this.
  Recommended path meanwhile: reach the remote agent directly over Tailnet/LAN/HTTPS.
- **Interactive SSH password prompts in the CLI** (`SshPasswordPrompt` TTY impl).
  Headless boxes typically use key-based auth; non-interactive `batchMode: "yes"`
  is the default. Deferred prompt impl can mirror `apps/desktop/src/ssh/DesktopSshPasswordPrompts.ts`.
- **HTTP/WS API + web-UI surface for remote-agent management.** The registry is
  designed to back a future `/api/remote-agents` route + WS RPC so the web app's
  `ConnectionsSettings.tsx` can manage remotes against a headless backend. Out of
  scope for the thin slice; the registry shape is forward-compatible.
- **Remote project management GUI** (already flagged "coming soon" in `REMOTE.md`;
  use `t3 project ...` on the server in the meantime).
- **`AdvertisedEndpoint` unification** (`.plans/19-remote-endpoints-hosted-static.md`).
  Keep `RemoteAgentRecord` separate for now; converge later once the API surface
  exists.
