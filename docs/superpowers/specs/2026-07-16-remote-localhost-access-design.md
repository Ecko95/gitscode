# Remote Localhost Access and Provider Authentication Design

**Status:** Proposal for review; no implementation is authorized yet  
**Date:** 2026-07-16  
**Recommended decision:** Hybrid, private-by-default access using provider-native remote authentication, one-time MCP callback relay, GITS supervised browsing, and automatic Desktop SSH forwarding

## Executive summary

The reported symptoms look similar but are three different networking problems:

1. A development server listening on the VPS at `localhost:5173` is reachable only from the VPS.
   A client needs a tunnel, a private published endpoint, or a browser running on the VPS.
2. An OAuth login that redirects to `http://localhost:<port>` means the browser's own machine.
   A VPS listener cannot receive that callback unless the client establishes an exact local forward.
3. OAuth for a downstream remote MCP server, such as Supabase used by Codex, is owned by the MCP
   client. When that client supports a registered HTTPS ingress callback, GITS can relay one callback
   to it without exposing a general-purpose port.

There is no universal server-side trick that makes a browser on an arbitrary computer interpret its
own `localhost` as the VPS. A browser-only client also cannot create a local TCP listener. GITS must
choose the access mechanism based on the client and the purpose of the URL.

The recommended product is therefore a small hybrid rather than a new generic tunnel service:

- **Provider authentication:** use provider-supported device-code or manual-code flows first. Codex
  has a structured device-code API, Claude deliberately supports pasting a browser-displayed code
  when an SSH/container callback cannot be reached, GitHub uses device flow, and current OpenCode
  exposes provider auth methods through its server API. OAuth port forwarding becomes an advanced
  Desktop fallback rather than the normal login path.
- **Downstream MCP authentication:** treat OAuth for tools such as Supabase as a separate first-class
  flow. Reuse Codex app-server's MCP status, OAuth start, and completion APIs. For browser-only GITS,
  relay the single callback through a short-lived capability route on the existing GITS HTTPS origin;
  never replay an authorization code and never expose a general-purpose port proxy.
- **Browser clients:** open remote localhost applications in the existing GITS-supervised Chromium.
  Chromium runs on the VPS, so its `localhost` is the correct machine. This is the safe, framework-
  compatible option that works from any machine capable of opening the GITS GUI.
- **GITS Desktop over SSH:** when a user activates a remote localhost URL, atomically create a
  managed `ssh -L` child, rewrite the URL to its local port, and open the system browser. If an OAuth
  authorization URL contains a loopback `redirect_uri`, create the exact same local port before
  opening it.
- **Ports GUI:** evolve the current Browser Preview surface into an environment-aware **Ports &
  Browser** panel. It should merge configured dev commands, selected listener discovery, terminal URL
  observations, and manual ports without building a second process supervisor.
- **Direct Tailnet URLs:** do not productize the current same-host Tailscale Serve flow unchanged.
  GITS's session cookie is host-scoped, and cookies are sent to every port on the host. A dev server
  on `machine.ts.net:3000` can therefore receive the GITS cookie used at
  `machine.ts.net:8443`. GITS also does not currently enforce WebSocket `Origin`. Native-browser
  Tailnet publishing needs a distinct preview hostname or a cookie-stripping gateway plus control-
  plane Origin/CSRF hardening.

This approach removes the separate manual SSH terminal for supported clients, does not expose raw
callback listeners or generic services publicly, and builds on code already present in GITScode.

## Decision requested

Approve one of these product directions:

| Option                                | What it solves                                                                                                       | Main limitation                                                                                                     | Recommendation        |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------- |
| A. Desktop SSH only                   | Local browser dev URLs and exact OAuth callback ports                                                                | Does not help browser-only clients or machines without a configured SSH environment                                 | Too narrow            |
| B. Browser-supervised only            | Remote dev apps from any GITS browser client; no local networking setup                                              | The app runs in remote Chromium, not the client's native browser; cannot satisfy a client-local OAuth callback      | Useful but incomplete |
| C. Hybrid                             | Provider-native auth, one-time MCP callback relay, browser-supervised dev apps, and automatic Desktop local forwards | Several incremental slices; native browser access from browser-only clients remains a later isolated-origin feature | **Recommended**       |
| D. Same-host Tailnet Serve as default | Native browser URL from every Tailnet device                                                                         | Current cookie/origin isolation and lifecycle are unsafe; node-global Serve config can be clobbered                 | Reject until hardened |
| E. New hosted/public tunnel           | Native browser URLs from anywhere                                                                                    | New tunnel control plane, wildcard DNS/TLS, abuse controls, billing, and public exposure                            | Deliberately later    |

Recommended defaults within Option C:

1. A remote loopback URL clicked in a browser client opens in GITS-supervised Chromium.
2. The same URL clicked in a Desktop SSH environment automatically opens through a managed local
   forward.
3. Provider-native remote login is the default; loopback OAuth is labeled **Advanced fallback**.
4. Codex remote-MCP OAuth uses a one-time callback route only when GITS has a compatible HTTPS
   endpoint and can isolate the internal callback listener.
5. No port is published to a Tailnet or the public internet automatically.
6. Existing inferred `publishOnTailnet: true` behavior is disabled or placed behind an explicit
   experimental confirmation until origin isolation is complete.

## Goals

- Let a user reach an HTTP development service on the VPS from every supported GITS client without
  opening a separate SSH terminal.
- Make terminal `localhost` links environment-aware instead of blindly opening the client's
  localhost.
- Add provider login actions to the Settings GUI, starting with Codex and Claude subscriptions.
- Let Codex authenticate remote OAuth MCP servers such as Supabase from the browser-only GITS GUI.
- Preserve exact callback ports when a provider genuinely requires loopback OAuth.
- Keep dev services and fallback callback listeners bound to loopback by default; network-isolate the
  narrow temporary MCP listener when an HTTPS ingress callback requires a non-local bind.
- Reuse the existing terminal, dev-command, browser-preview, SSH, Tailscale, endpoint, and provider
  abstractions.
- Make collisions, lost connections, stale listeners, and cleanup visible and predictable.
- Work across Linux, macOS, and Windows clients using the OpenSSH path GITS Desktop already uses.

## Non-goals

- A public sharing service or automatic Tailscale Funnel.
- A generic OAuth broker that receives or stores provider refresh tokens.
- OAuth callback replay, shared callback URLs, or an arbitrary callback/port relay.
- A transparent arbitrary-host TCP proxy from the browser.
- A same-origin path proxy such as `/ports/5173/`; common dev servers are not path-prefix safe.
- Automatically exposing every port returned by `ss`.
- Replacing framework-specific transports such as Expo's native-device tunnel.
- Persisting ephemeral Desktop port forwards across application restarts.
- Making an uninstalled or undocumented provider login method appear supported.

## Fundamental constraint

Consider a CLI running on the VPS that prints this authorization URL:

```text
https://provider.example/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fcallback
```

The provider redirects the browser to `localhost:1455` on the browser's computer. Tailscale Serve on
the VPS, a GITS reverse proxy, and binding the VPS listener to `0.0.0.0` do not change that meaning.
The viable choices are:

- avoid the callback with device code or manual code;
- create a client-side listener/SSH forward on exactly port `1455`; or
- run the authentication browser on the VPS, which is not recommended for account credentials.

For a normal dev URL, the port does not need to be preserved. GITS can safely allocate another local
port and rewrite the URL. For a registered OAuth redirect, changing the port normally invalidates the
redirect, so exact-port collision is a hard failure.

Remote MCP OAuth is a supported exception to the client-local callback constraint when the MCP client
can register an HTTPS redirect URI. Codex supports an `mcp_oauth_callback_url` override specifically
for remote devbox ingress. GITS can therefore give one login attempt an unguessable callback path on
its existing HTTPS origin, relay that one request to the Codex-owned callback listener, and revoke the
path immediately afterward. This is a narrow OAuth adapter, not general port exposure.

## Current GITScode inventory

### Existing Desktop SSH bridge

[`packages/ssh/src/tunnel.ts`](../../../packages/ssh/src/tunnel.ts) already:

- resolves OpenSSH aliases and target configuration;
- starts or reuses the remote GITS server;
- reserves a client loopback port;
- spawns `ssh -n -N -L <local>:127.0.0.1:<remote>` with keepalives and
  `ExitOnForwardFailure=yes`;
- caches an in-memory password for subsequent operations;
- deduplicates base-environment tunnel creation;
- watches startup and performs scoped cleanup.

The Desktop IPC and saved-environment model retain the SSH target in
[`packages/contracts/src/ipc.ts`](../../../packages/contracts/src/ipc.ts) and expose it through
[`apps/desktop/src/ssh/DesktopSshEnvironment.ts`](../../../apps/desktop/src/ssh/DesktopSshEnvironment.ts).

The gap is that the manager owns only the base GITS HTTP/WebSocket forward. It has no auxiliary port
registry, exact-port mode, list/release operation, or URL-aware open transaction.

### Terminal URL handling

[`ThreadTerminalDrawer.tsx`](../../../apps/web/src/components/ThreadTerminalDrawer.tsx) already has
the selected `environmentId` and registers an xterm link provider. URL activation currently calls
`localApi.shell.openExternal(match.text)`. Desktop delegates to Electron; a browser calls
`window.open`. Neither path asks which environment emitted the URL, so remote `localhost` is treated
as client localhost.

[`terminal-links.ts`](../../../apps/web/src/terminal-links.ts) already handles wrapped HTTP(S) URLs,
which is the right observation seam. URL parsing, loopback classification, and origin rewriting should
move to a shared runtime helper rather than live inside the React component.

### Existing supervised browser

[`browser-preview-manager.ts`](../../../apps/server/src/browser-preview/browser-preview-manager.ts)
already launches a thread-scoped `gsd-browser` Chromium and can navigate it to a VPS loopback port.
This is the best framework-compatible browser path because the app retains its root origin, HMR
WebSockets, cookies, redirects, and even hardcoded absolute localhost URLs.

Before relying on it as the default remote-port experience, the existing implementation needs these
repairs:

- Resolve its relative `previewPath` against the selected environment backend. A hosted client with a
  saved VPS environment currently resolves it against the hosted UI origin.
- Initially open cross-origin saved-environment previews in a new tab. The relay currently sends
  `frame-ancestors 'self'`; embedding requires an explicit server-approved UI-origin policy.
- Validate that the viewer URL returned by `gsd-browser` is HTTP(S) loopback before storing it.
- Add `Referrer-Policy: no-referrer` and eagerly revoke tickets on stop, archive, delete, and shutdown.
- Stop selecting the first process-name-matched `ss` listener. Navigate to the port the user selected.
- Replace the hardcoded `npm run dev -- --port "$GITS_PORT"` panel action with the existing dev-command
  presets.
- Add browser cleanup to the same deletion lifecycle used by provider, terminal, and worktree
  resources.

### Deterministic session port

[`sessionPort.ts`](../../../apps/server/src/provider/sessionPort.ts) injects a deterministic
`GITS_PORT` in the range `30000..39999` into providers and terminals. This is a useful hint, not a
complete allocator: hash collisions are possible, and a framework may ignore or remap the requested
port. A Ports UI must confirm the actual listener and should request strict-port behavior where a
configured command claims ownership.

### Existing dev commands and Tailnet publishing

[`GitsDevCommands.ts`](../../../apps/server/src/gits/Layers/GitsDevCommands.ts) and
[`DevCommandsControl.tsx`](../../../apps/web/src/components/DevCommandsControl.tsx) already model and
launch commands with a local port, host, Tailnet publication flag, Serve port, and preview URL.

There are four important gaps:

1. The generated command points to
   `<project>/scripts/dev/run-dev-command.sh`. That helper exists in the GITScode repository but not
   in arbitrary projects, so inferred presets can produce a command that cannot launch.
2. Port inference is name-based. A root `dev` script with no `web`, `vite`, `frontend`, or similar
   hint often receives no port, even when the command later prints one.
3. The wrapper proves only that _something_ accepts TCP on the configured port. It does not prove the
   launched terminal owns it. Vite can also silently move to another port unless strict-port mode is
   enabled.
4. `tailscale serve --bg` mutates persistent node-global configuration. Cleanup turns an HTTPS port
   off without checking who owned the mapping, and a crash can strand it.

The launcher helper should be a GITS-owned runtime asset materialized under the GITS state directory,
or the lifecycle should move into the existing server/terminal manager. It must never depend on the
target repository carrying GITS internals.

### Existing endpoint abstraction

[`remoteAccess.ts`](../../../packages/contracts/src/remoteAccess.ts) and
[`advertisedEndpoint.ts`](../../../packages/shared/src/advertisedEndpoint.ts) already define
`AdvertisedEndpoint` for reaching the GITS environment itself. Port access should align with its
provider, reachability, compatibility, and status language, but should not overload it: an
environment can have many short-lived development ports with separate ownership and lifecycle.

### Provider status and secrets

Provider cards already show installed/authenticated state and account email, but have no sign-in or
sign-out action. Codex already runs app-server with `experimentalApi: true` and calls `account/read`.
The generated app-server schema already contains `account/login/start`, device-code login, cancel,
completion notification, and logout contracts.

Sensitive provider environment values are redacted from settings responses. However,
[`ServerSecretStore.ts`](../../../apps/server/src/auth/Layers/ServerSecretStore.ts) stores raw bytes in
files protected by directory mode `0700` and file mode `0600`; it does not encrypt them or use an OS
keyring. Some current UI/schema copy says values are never written in plaintext. That wording is
incorrect and must be fixed before asking users to store more long-lived credentials.

Native provider credential storage should remain the default. If an env-only token is needed, GITS
must describe its current permission-protected storage truthfully or introduce a real keyring/encrypted
backend as a separate security improvement.

### Existing MCP inventory and Codex OAuth seam

GITScode already has an MCP Servers panel in
[`GitsCockpit.tsx`](../../../apps/web/src/components/gits/GitsCockpit.tsx) and an authenticated
inventory route backed by
[`GitsMcpInventory.ts`](../../../apps/server/src/gits/Layers/GitsMcpInventory.ts). The panel already
shows each server's provider, transport, status, and an auth-status pill. Its config-file inventory
currently reports auth as unknown and has no Authenticate action.

The generated Codex app-server protocol already supplies the missing runtime facts and actions:

- `mcpServerStatus/list` returns configured servers and auth states including `notLoggedIn`,
  `bearerToken`, and `oAuth`;
- `mcpServer/oauth/login` accepts the server name/scopes/timeout and returns `authorizationUrl`;
- `mcpServer/oauthLogin/completed` reports success or failure;
- `config/mcpServer/reload` refreshes MCP configuration.

[`CodexAdapter.ts`](../../../apps/server/src/provider/Layers/CodexAdapter.ts) already translates the
completion notification to `mcp.oauth.completed`. The smallest design enriches the existing MCP panel
and exposes the missing start action; it does not create another MCP settings screen or scrape CLI
output.

## Provider and MCP authentication design

### Principle: provider-aware, not a generic OAuth server

Each provider should expose the methods supported by the exact installed runtime. The common contract
is only a safe GUI view model and lifecycle; the implementation stays provider-specific.

```text
Settings provider card
  -> list safe methods for this provider instance
  -> start one server-side auth session under that instance's resolved home/environment
  -> show a device code, transient URL, code-input field, or credential field
  -> wait/cancel/expire
  -> refresh the existing provider probe
```

The UI should show **Sign in**, **Change login**, and **Sign out** beside the current auth status.
Every flow must use the exact provider instance's resolved credential scope. Codex shadow homes and
Claude alternate homes must never accidentally modify the default account.

### Safe common auth-session view

A minimal schema can represent:

```text
sessionId
providerInstanceId
method: device-code | manual-code | api-key | browser-loopback | guided-terminal
state: starting | awaiting-user | waiting-provider | succeeded | failed | cancelled | expired
verificationUri?          transient; never persisted
userCode?                 transient; never persisted
prompt?                   sanitized provider guidance
acceptsCode
expiresAt
```

The browser must never receive arbitrary executable commands from this contract. The server selects a
known adapter and resolves its environment. Auth URLs, state, PKCE values, codes, credentials, and PTY
transcripts are excluded from logs, orchestration events, telemetry, persistence, and broadcasts.

Sessions are single-flight per effective credential home, cancellable, time-limited, and visible only
to the initiating authenticated connection. Authorization should match the permission required to
mutate provider settings; if GITS adds roles, auth mutation is owner/admin-only.

### Codex

Use Codex app-server's structured API rather than scraping CLI text:

1. Start `account/login/start` with `chatgptDeviceCode` by default.
2. Display the verification URI and one-time code in the Settings modal.
3. Let the user open the URI in the local browser on any machine.
4. Listen for the completion notification; support explicit cancel and timeout.
5. Refresh the existing provider status probe.

Alternative methods can include API key or enterprise access token only when supported and clearly
labeled as different credential/billing modes. `codex login --with-api-key` is not a substitute for a
ChatGPT subscription.

Browser-loopback login remains an Advanced Desktop fallback. The installed Codex CLI currently uses
`127.0.0.1`, normally port `1455`, with `1457` as a registered fallback. GITS must parse the actual
redirect rather than hardcode either port.

Official references: [Codex authentication](https://developers.openai.com/codex/auth) and
[Codex app-server auth API](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md#auth-endpoints).

### Claude Code

Claude has no stable structured login API comparable to Codex app-server. Use a guided, isolated PTY:

1. Start `claude auth login` under the selected Claude provider's resolved home/environment.
2. Surface the authorization link only to the initiating user.
3. Open it in the local browser.
4. When the local callback cannot be reached from an SSH/container environment, Claude deliberately
   displays an authorization code in the browser. Show a code field and send the submitted code to
   the PTY's stdin.
5. Treat the provider's own exit/status probe as success authority; do not depend on brittle success
   text.
6. Refresh the provider card.

`claude setup-token` can be offered for automation as an explicitly different method. A setup token is
long-lived and has different feature/security tradeoffs; it should not silently replace the native
account login. If stored as `CLAUDE_CODE_OAUTH_TOKEN`, the user must see the real storage semantics and
credential scope before saving.

Official references: [Claude Code authentication](https://code.claude.com/docs/en/authentication) and
[remote login troubleshooting](https://code.claude.com/docs/en/troubleshoot-install).

### OpenCode

OpenCode is not installed on the current VPS, so runtime support must be capability-driven. Current
OpenCode exposes provider auth method discovery, OAuth authorize/callback, and credential-setting
APIs. GITS should discover those methods from the connected OpenCode server rather than maintain a
stale catalogue.

- Prefer ChatGPT headless device code, GitHub Copilot device code, xAI remote device flow, or provider
  API-key methods when reported.
- Avoid the current ChatGPT browser listener on a VPS unless its installed version proves a loopback-
  only binding and no headless method exists.
- Do not advertise Anthropic subscription auth unless the connected runtime actually reports it.

Official references: [OpenCode server API](https://opencode.ai/docs/server/) and
[OpenCode providers](https://opencode.ai/docs/providers/).

### Cursor Agent

Cursor documents API key as its headless method. Offer `CURSOR_API_KEY` through the existing sensitive
environment-variable UI, never `--api-key` in process arguments where it may appear in process lists.
Subscription/browser login can use a guided raw PTY, but GITS should not claim callback automation
until Cursor documents or exposes a stable protocol.

Official reference: [Cursor CLI authentication](https://docs.cursor.com/en/cli/reference/authentication).

### GitHub CLI and other device-flow providers

Use the CLI's device flow in a guided PTY or its stable API where available. Display the one-time code,
open the verification page locally, and refresh `gh auth status` afterward. Token-from-stdin remains an
advanced automation method. Never put a personal access token in argv.

Official reference: [`gh auth login`](https://cli.github.com/manual/gh_auth_login).

### Unknown providers

An unknown provider can report one or more explicit capabilities:

- device code;
- manual code;
- API key/token;
- browser loopback;
- external/guided terminal only.

If it exposes no machine-readable capability, GITS provides a guided terminal and honest instructions.
It does not guess callback ports, scrape secrets, or expose a listener publicly.

### Downstream MCP OAuth: Supabase example

Supabase's hosted MCP endpoint uses browser OAuth with dynamic client registration by default. The
configured server can remain project-scoped, for example:

```text
https://mcp.supabase.com/mcp?project_ref=<project-ref>&read_only=true
```

`read_only=true` is recommended unless the user deliberately needs migrations or other writes. The
MCP is intended for development/testing rather than production data. Official reference:
[Supabase MCP Server](https://supabase.com/docs/guides/ai-tools/mcp).

The browser-only GUI flow is:

1. The existing MCP Servers panel obtains Codex runtime status through `mcpServerStatus/list` and
   shows **Authenticate** for `supabase` when its status is `notLoggedIn`.
2. GITS creates one auth session scoped to the Codex provider instance's effective `CODEX_HOME` and
   MCP server name. Only one session may mutate that pair at a time.
3. A dedicated short-lived Codex app-server/auth process starts with a preflighted high internal
   callback port and a fixed, non-secret callback base under the selected environment's advertised
   HTTPS GITS endpoint. A bounded bind retry handles the unavoidable preflight-to-bind race. Using a
   dedicated process avoids callback-port collisions with thread app-server processes and preserves
   the exact provider-instance credential scope.
4. GITS calls `mcpServer/oauth/login` and receives `authorizationUrl`. It extracts and validates the
   registered `redirect_uri` and opaque OAuth `state`, then activates only the exact Codex-appended
   callback ID and expected state for that login.
5. The initiating browser opens the Supabase authorization URL. The user signs in and grants the
   requested organization/project access.
6. Supabase redirects to the one-time GITS callback path. GITS accepts only the active path and method,
   removes cookies/authorization/proxy headers, and forwards the bounded path/query to the reserved
   local Codex callback listener.
7. Codex validates OAuth state and PKCE, exchanges the code, and stores the MCP credentials in its own
   configured MCP credential store. GITS never reads or stores the access/refresh token.
8. On `mcpServer/oauthLogin/completed`, GITS consumes the callback lease, stops the auth process,
   refreshes MCP status/inventory, and updates the existing row.

The callback route has a fixed, non-secret base. Codex appends a server-specific callback ID, and GITS
also retains the expected OAuth state from the returned authorization URL in memory. The pair forms
the login capability; GITS must reject the flow if its format/entropy does not meet policy. The route
is unauthenticated because the OAuth provider may return through a browser without a GITS session, but
it exists only for one active login, accepts one bounded GET response with the exact opaque state, is
rate limited, has a short TTL, and is invalidated on first use. Codex remains authoritative for the
full state/PKCE validation and code exchange; the relay only performs a constant-time precheck and
never modifies, persists, or replays the code.

Codex exposes the required fixed-port and ingress-base controls as top-level
`mcp_oauth_callback_port` and `mcp_oauth_callback_url` settings. The latter is a base URL: Codex
appends its server-specific callback ID to form the registered `redirect_uri`. GITS must use that
derived URI exactly rather than guessing or rewriting its suffix. Official reference:
[Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp).

Codex currently binds a non-local callback URL on `0.0.0.0`. Until Codex offers a separate callback
bind-address setting, GITS must use a random high internal port, verify that the host firewall does not
expose it, keep the listener short-lived, and refuse relay startup when that isolation cannot be
proved. The external browser reaches only the normal GITS HTTPS port.

If no compatible advertised HTTPS endpoint or safe internal-port isolation exists, the UI offers two
fallbacks rather than weakening the relay:

- GITS Desktop creates an exact SSH callback forward; or
- the user supplies a Supabase personal access token through
  `bearer_token_env_var = "SUPABASE_ACCESS_TOKEN"`, which Supabase documents for CI/headless use.

The PAT path is explicitly secondary: it is long-lived, uses different revocation semantics, and must
follow the existing truthful secret-storage warning. It is never put in config plaintext, a URL, or
process arguments.

## Remote-port design

### One environment-aware URL resolver

All terminal URL activation should pass through one function conceptually shaped as:

```text
openEnvironmentUrl({ environmentId, url, source })
```

The resolver classifies both the clicked URL and the selected environment:

| URL/environment                                                                  | Default result                                                     |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Non-loopback HTTP(S) URL                                                         | Open externally unchanged                                          |
| Loopback URL from local GITS environment                                         | Open externally unchanged                                          |
| Loopback URL from saved browser/HTTPS environment                                | Open selected port in GITS-supervised browser                      |
| Loopback URL from Desktop SSH environment                                        | Atomically ensure SSH forward, rewrite origin, open system browser |
| Authorization URL with loopback `redirect_uri`, provider-native method available | Offer/restart recommended remote auth method                       |
| Authorization URL with loopback `redirect_uri` in Desktop SSH                    | Ensure exact-port forward, then open original URL                  |
| Authorization URL with loopback `redirect_uri` in browser-only client            | Explain the constraint; do not open a callback that cannot succeed |

The shared classifier accepts `localhost`, `127.0.0.0/8`, and `[::1]`. Display URLs printed as
`0.0.0.0` or `[::]` can be normalized to loopback, but those wildcard addresses are never accepted as
arbitrary proxy targets.

For a direct dev URL, rewrite only the origin and preserve protocol, path, query, and fragment. For an
authorization URL, parse only a standards-shaped `redirect_uri`, establish its exact port, and leave
the authorization URL untouched. Provider adapters remain authoritative when the redirect is not
visible in the link.

URL handling in Desktop must be one main-process IPC transaction—validate, establish, rewrite, and
open—so the renderer cannot race the tunnel or ask Electron to proxy an arbitrary host.

### Ports & Browser panel

Evolve the existing Browser Preview right panel into **Ports & Browser** instead of creating another
launcher or another global state system.

The upper section lists ports; the lower section retains the supervised browser. The existing Dev menu
remains the command editor/launcher and links to the same records.

Each row shows:

- remote port and protocol;
- label/command/process when known;
- source: configured, terminal URL, detected listener, or manual;
- listener state: stopped, starting, ready, unknown, or error;
- ownership: GITS-owned terminal or unmanaged/view-only;
- access status: supervised browser, Desktop forward, isolated private endpoint, or none;
- actions supported by the current client.

Primary actions are contextual:

- **Preview in GITS** for HTTP(S) ports;
- **Open locally** for a Desktop SSH environment;
- **Open private URL** only for an already-safe isolated endpoint;
- **Start** or **Stop** only when GITS owns the configured command/terminal;
- **Add port** for an explicit numeric port;
- **Refresh** for on-demand listener discovery.

Do not run a permanent listener scanner. Poll while the panel is open with TanStack Query, refresh after
terminal lifecycle changes, and observe URLs as terminal output is written. Closing the panel stops
polling but never kills the dev server.

### Minimal port record

Add a schema-only contract such as `packages/contracts/src/ports.ts`:

```text
id                        stable within one environment
remoteHost                loopback only for MVP
remotePort                1..65535
protocol                  http | https | tcp
label?
sources[]                 configured | terminal | listener | manual
listenerStatus            stopped | starting | ready | unknown | error
ownership                 gits-terminal | unmanaged
threadId?
terminalId?
commandId?
pid?
processName?
lastSeenAt?
supervisedStatus          unavailable | stopped | starting | ready | error
exposureStatus            none | starting | private | public | error
```

The server provides listener/configured facts. The web client merges transient terminal observations.
The Desktop bridge contributes client-local forward state. Do not persist ephemeral forward mappings in
saved environment records; the SSH target is already persisted.

### Listener discovery and ownership

The current `ss -ltnpH` parser is sufficient as a starting inventory but not as an exposure decision.

- Validate numeric ports and filter GITS-reserved/control ports.
- Prefer configured `GITS_PORT`, configured dev-command ports, and the explicitly selected port.
- Do not automatically select the first Node/Bun/Python listener.
- Treat discovered listeners as view-only unless the terminal manager can associate PID/process group
  ownership with a GITS-launched command.
- Before launching a configured command that claims a strict port, preflight that the port is free.
- After launch, confirm both listener readiness and ownership; a TCP accept alone is insufficient.
- If a framework moves to a different port, report the detected port instead of publishing the claimed
  one.

### Supervised browser lifecycle

1. User selects **Preview in GITS** for an exact port.
2. GITS opens or reuses the thread-scoped browser session.
3. The server navigates remote Chromium to `http://127.0.0.1:<port>/` or the observed path.
4. Same-origin clients may use the panel. Cross-origin saved-environment clients initially open the
   authenticated relay in a new tab.
5. Closing the panel does not stop the browser daemon or dev service.
6. Archive/delete/shutdown revokes tickets and stops owned browser resources.

The relay remains a capability bridge to a server-created loopback viewer; clients never supply an
arbitrary upstream viewer URL.

## Desktop SSH forwarding design

### Recommended mechanism

Add a process-scoped auxiliary-forward registry to the existing `SshEnvironmentManager`. Use one
standard `ssh -n -N -L` child per active remote endpoint for the baseline implementation.

This is intentionally simpler than ControlMaster:

- it reuses OpenSSH config, ProxyJump, keys, agents, known-host verification, and the current password
  helper;
- it works with the cross-platform OpenSSH path GITS already ships/supports;
- it does not interrupt the base GITS HTTP/WebSocket bridge when a port is added;
- the normal number of active dev ports is small, and GITS can cap it per environment.

ControlMaster plus `ssh -O forward` can be a later feature-detected optimization. SOCKS, a native SSH
library, or a custom TCP mux adds more integration and security complexity without solving exact
OAuth callbacks better.

### IPC shape

Expose a narrow operation such as:

```text
openSshExternalUrl({ target, url })
  -> { opened, kind, remotePort, localPort, rewrittenUrl? }
```

Supporting list/release operations can power the Ports panel:

```text
listSshPortForwards({ target })
releaseSshPortForward({ target, remoteHost, remotePort })
```

Do not expose a renderer method that forwards arbitrary destination hosts. The main process accepts only
HTTP(S) loopback URLs and recognized loopback `redirect_uri` values for this flow.

### Generic development URL

- Allocate an ephemeral local port. Reusing the same numeric port is optional; correctness matters more
  than visual symmetry.
- Explicitly bind `127.0.0.1:<localPort>` so client SSH configuration cannot make the listener public.
- Forward to the normalized remote loopback host and port.
- Retry a small number of allocation/spawn races because reserving a port releases the reservation
  before `ssh` binds it.
- Wait until the local listener exists, rewrite the origin, and only then call Electron
  `openExternal`.
- Preserve the selected local port across bounded automatic reconnects so an already-open tab remains
  valid.

### Exact OAuth callback

- Extract the actual loopback redirect port from structured provider metadata or `redirect_uri`.
- Confirm the remote callback listener is starting/listening before opening the browser where the
  provider exposes that state.
- Bind the exact same port locally and do not rewrite the authorization URL.
- If the local port is occupied, fail before browser launch with an explanation and the provider-native
  device/manual-code alternative.
- Expire/release a callback-only forward after completion, cancel, or timeout. A normal dev forward may
  live until explicit release or environment disconnect.

### Registry and lifecycle

Key each mapping by:

```text
targetConnectionKey + remoteLoopbackHost + remotePort + exactLocalPortConstraint
```

Required behavior:

- deduplicate identical concurrent requests with the same deferred/single-flight pattern as the base
  tunnel;
- serialize authentication per SSH target to avoid multiple password dialogs;
- reuse the in-memory SSH secret but never persist it;
- watch every child after startup, not only during initial readiness;
- retry unexpected exits with bounded backoff only when agent/key/cached auth can succeed without an
  unsolicited prompt;
- mark failed if the previous local port was taken during downtime rather than silently changing URL;
- cancel pending starts/retries on environment disconnect;
- kill auxiliary children and clear the SSH secret on disconnect/application shutdown;
- never call `stopRemoteServer` when closing an auxiliary forward;
- prevent a creator racing with disconnect from installing a late tunnel;
- ensure the base SSH bridge is healthy during automatic saved-environment WebSocket reconnects.

### OpenSSH configuration caveat

An auxiliary SSH child re-reads the user's alias. If that alias contains `LocalForward` or
`DynamicForward`, each child can try to recreate inherited listeners and fail. `ClearAllForwardings=yes`
also clears command-line forwards and is not a universal fix.

Use `ssh -G` output to detect inherited forwards. Keep `ExitOnForwardFailure=yes` for ordinary aliases.
For affected aliases, use explicit requested-listener preflight/probing and clear diagnostics; a managed
ControlMaster may later become the clean optimized path. Include aliases with `LocalForward`,
ProxyJump, agent auth, and password auth in integration tests.

Official reference: [OpenSSH `ssh(1)`](https://man.openbsd.org/ssh).

## Direct native-browser exposure

### Why a path proxy is rejected

A URL such as `https://gits.example/ports/5173/` is not a generic zero-config solution:

- Vite uses root-absolute `/@vite/client` and HMR WebSockets;
- Next uses `/_next`, root routes, redirects, and build-time `basePath` behavior;
- Expo/Metro has its own URLs and transports;
- application cookies and service workers would share the privileged GITS origin;
- untrusted agent-written JavaScript would execute on the GITS control-plane origin.

Rewriting HTML is incomplete and framework-specific. GITS should not build this for MVP.

### Why current same-host Tailscale Serve is blocked

The current deployment exposes GITS as HTTPS on a MagicDNS hostname and can expose a dev service on a
different HTTPS port of that same hostname. This preserves root paths and is likely compatible with
ordinary WebSockets, but ports do not isolate cookies.

Risks:

1. The dev server receives the host-only `t3_session` cookie even though it runs on a different port.
2. Agent-written server code can log or exfiltrate that cookie. `HttpOnly` only prevents JavaScript
   reads; it does not prevent the dev server receiving the `Cookie` header.
3. Agent-written browser code on the dev origin can initiate requests or a WebSocket to the GITS
   control port. The current authenticated WebSocket upgrade does not validate `Origin`.
4. Tailscale Serve configuration is node-global and persistent. Port-only cleanup can clobber an
   operator mapping or leave a stale GITS route after a crash.
5. Framework host/origin allowlists may reject the MagicDNS host; these must be configured narrowly,
   never with a blanket allow-all.

RFC 6265 explicitly notes that cookies do not provide isolation between mutually distrusting services
on different ports: [HTTP State Management Mechanism](https://www.rfc-editor.org/rfc/rfc6265.html).

### Safe future native-browser shape

The preferred future architecture is a **distinct-origin root gateway**:

- each preview receives a different hostname, not merely a different port;
- the target is a server-created lease to one loopback numeric port;
- a short-lived bootstrap capability establishes preview auth and redirects to a clean URL;
- HTTP bodies/streams and WebSocket upgrades are forwarded without a path prefix;
- GITS control cookies are never sent to or forwarded upstream;
- the gateway strips `Cookie`, `Authorization`, proxy headers, and unrelated identity headers;
- GITS itself enforces strict `Origin`/CSRF checks on cookie-authenticated HTTP mutations and
  WebSocket upgrades;
- leases expire and are revoked on terminal stop, restart, environment shutdown, or explicit close;
- public sharing is a separate, visibly public action with expiry and abuse controls.

Possible endpoint providers are a GITS-owned wildcard DNS/TLS domain, a future hosted tunnel, or a
distinct-host Tailscale Service where the tailnet supports it. Do not promise a specific provider until
its hostname, TLS, ACL, and lifecycle behavior are proven.

An advanced Tailnet-IP HTTP option can remain manual, but it lacks HTTPS secure-context features and
requires deliberately binding/proxying onto the Tailnet interface. It is not the default experience.

### Expo special case

Expo Web can use the HTTP preview paths above. Native Expo Go/Metro connectivity is not a generic HTTP
port-forward problem. Offer framework guidance such as `npx expo start --tunnel` or an explicitly
configured private-network mode. Expo's tunnel uses a third-party path and is slower, so it remains an
opt-in command rather than a GITS-wide automatic exposure.

Official reference: [Expo CLI tunneling](https://docs.expo.dev/more/expo-cli/).

## Security requirements

### Authentication

- Prefer native provider stores and structured provider APIs.
- Never publish an OAuth listener or provide a generic callback proxy merely to avoid localhost. The
  only HTTPS exception is a server-created, one-time MCP callback lease for a client such as Codex
  that explicitly supports an ingress callback URL.
- Keep fallback callback listeners on remote and client loopback only.
- Never duplicate provider refresh tokens into GITS settings when the native runtime can own them.
- Never put API keys, tokens, codes, or passwords in argv.
- Bind auth sessions to the initiating authorized connection and effective credential home.
- Enforce one active auth mutation per credential home.
- Use provider state/PKCE checks as implemented by the provider; GITS must not bypass them.
- Key each MCP callback lease by effective credential home and MCP server. Match the exact
  Codex-appended callback ID and expected opaque OAuth state, allow one GET with a short TTL and
  bounded request size, and reject wrong, expired, or reused values without forwarding them. Keep the
  configured GITS callback base fixed and non-secret so no capability is exposed in process arguments.
- Resolve the public callback base only from a server-approved compatible `AdvertisedEndpoint`; never
  accept an arbitrary callback host, upstream host, or local port from the browser.
- Treat the authorization code and state query as opaque transit data; compare state only in constant
  time before Codex validates it authoritatively. Strip `Cookie`,
  `Authorization`, `Forwarded`, and proxy identity headers before the local handoff; never persist or
  replay the request.
- Let Codex perform state/PKCE validation, code exchange, and credential storage. GITS must never read
  or store the resulting access or refresh token.
- Because Codex currently binds a non-local MCP callback on `0.0.0.0`, prove that the reserved internal
  port is unreachable outside the host before starting. Refuse the relay and offer Desktop/PAT
  fallbacks if isolation cannot be established.
- Redact auth URLs, query strings, device codes, manual codes, PTY transcripts, and credentials from
  logs, events, errors, diagnostics, and telemetry.
- Correct the current plaintext-storage wording before adding token-oriented auth UI.

### Ports and previews

- Accept ports `1..65535`; target loopback only for MVP.
- Deny the configured GITS control port and known SSH, database, Docker/admin, and browser-viewer
  listeners from exposure actions.
- Never expose a raw listener solely because `ss` found it.
- Require a user gesture before creating a Desktop forward or private/public exposure.
- Cap active auxiliary SSH forwards per environment and rate-limit creation.
- Bind Desktop forwards explicitly to `127.0.0.1`.
- Validate server-created browser viewer endpoints as loopback.
- Scope and expire preview tickets; revoke them on every terminal lifecycle boundary.
- Do not forward GITS cookies or authorization headers to a preview service.
- Add strict WebSocket `Origin` validation and HTTP mutation CSRF/Origin protection before enabling a
  same-site native preview origin.
- Never enable Tailscale Funnel or a public tunnel automatically.

### Tailscale, if reintroduced

- Treat Tailnet ACL policy—not the word "private"—as the access boundary shown to users.
- Inspect existing Serve configuration before mutation; never overwrite a non-GITS handler.
- Persist only GITS-owned lease metadata and disable only an exact owned mapping.
- Reconcile owned mappings after restart and leave unknown mappings untouched.
- Require a distinct hostname or the full cookie-stripping/origin-hardening design.
- Confirm framework host allowlists narrowly and verify HMR WebSocket behavior.

## Failure behavior

| Failure                                      | Required behavior                                                                                                              |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| No listener yet                              | Keep the row in starting/stopped state; offer retry; never publish a different process found on the same port                  |
| Framework moved ports                        | Show the actual detected port and explain strict-port configuration; do not expose the claimed port                            |
| Generic Desktop local-port collision         | Allocate another ephemeral port and rewrite the dev URL                                                                        |
| OAuth exact-port collision                   | Do not open the browser; identify the occupied port and offer device/manual-code auth                                          |
| SSH password prompt cancelled                | Leave the URL unopened and the mapping absent                                                                                  |
| SSH child exits                              | Retry boundedly on the same local port without a surprise password prompt; otherwise mark failed                               |
| SSH disconnect during startup                | Cancel the creator and prevent a late child from entering the registry                                                         |
| Remote app stops                             | Keep or close the forward according to policy, but show listener stopped; never claim readiness                                |
| `gsd-browser` unavailable                    | Keep terminal/dev service functional; show install/update guidance and Desktop alternatives                                    |
| Browser ticket expired                       | Request one fresh ticket/reopen once, then show an explicit reconnect state                                                    |
| Cross-origin preview cannot embed            | Open the authenticated remote preview in a new tab                                                                             |
| Tailscale unavailable                        | Hide/disable the provider with actionable setup text; all local/supervised paths continue                                      |
| Existing Serve mapping conflicts             | Refuse to overwrite it and show the current owner/port where safely discoverable                                               |
| Process/server crashes after Serve mutation  | Reconcile only mappings recorded as GITS-owned; warn about unknown stale state                                                 |
| Unknown provider callback                    | Do not guess; show guided terminal and provider docs; Desktop may forward only a visible loopback `redirect_uri`               |
| No compatible HTTPS callback endpoint        | Do not start MCP OAuth relay; offer the Desktop exact-forward or documented PAT fallback                                       |
| MCP callback port isolation cannot be proven | Refuse to start the `0.0.0.0` listener; explain the firewall requirement and offer safe fallbacks                              |
| MCP callback path is wrong or expired        | Return not found/gone without reaching Codex; let the user restart authentication                                              |
| MCP callback is received more than once      | Reject it as consumed; never replay the authorization code                                                                     |
| MCP callback handoff fails                   | Consume/revoke the lease, stop the auth helper, and require a fresh OAuth attempt                                              |
| MCP authorization is denied                  | Show the provider-safe failure, clean up the lease/helper, and refresh MCP status without storing credentials                  |
| Multiple client machines                     | Server port inventory is shared; Desktop forwards are local to each client; auth session secrets remain initiating-client-only |

## Data and lifecycle ownership

| Resource                      | Owner                             | Persistence                                   | Cleanup                                           |
| ----------------------------- | --------------------------------- | --------------------------------------------- | ------------------------------------------------- |
| Configured dev command        | Project `.gits/dev-commands.json` | Project config                                | User edit/remove                                  |
| Terminal URL observation      | Web client/environment view       | Ephemeral                                     | Terminal buffer/session removal                   |
| Listener snapshot             | Server Ports service              | None                                          | Refresh expiry                                    |
| GITS-owned dev process        | Existing terminal manager         | Existing terminal semantics                   | User stop, terminal exit, configured lifecycle    |
| Supervised Chromium           | Browser preview manager           | Named runtime only; no GITS event persistence | Archive/delete/shutdown/explicit stop             |
| Preview ticket                | Browser preview manager           | In-memory, short TTL                          | Expiry and eager revocation                       |
| Desktop auxiliary forward     | Desktop SSH manager               | Process-local                                 | Release, environment disconnect, application exit |
| Provider auth session         | Provider auth adapter             | In-memory only                                | Success, cancel, disconnect, timeout              |
| MCP OAuth auth helper         | Codex MCP auth service            | Process-local; native Codex credentials only  | Success, denial, cancel, timeout, server shutdown |
| MCP callback lease            | Codex MCP auth service            | In-memory only; query is never persisted      | First request, failure, cancel, timeout, shutdown |
| Future private endpoint lease | Exposure provider                 | Minimal owned lease metadata                  | Stop, listener loss, expiry, reconciliation       |

## Implementation seams

### Shared/contracts

- Add schema-only port/auth-session contracts under `packages/contracts`; do not place runtime logic
  there.
- Reuse the existing MCP inventory/auth-status contracts. Add only the minimal authenticate action
  and transient result/session state needed by the current MCP Servers panel; do not invent a generic
  OAuth framework.
- Add URL classification, loopback recognition, redirect extraction, and URL rewriting under an
  explicit `packages/shared` subpath.
- Reuse `AdvertisedEndpoint` vocabulary for reachability/compatibility but keep transient ports a
  separate contract.
- Add an optional `ports` capability with a decoding default so older saved environments remain
  compatible.

### Server

- Enrich the existing MCP inventory from Codex `mcpServerStatus/list`, preserving the current
  config-file inventory as a degraded fallback.
- Add a dedicated, credential-home-scoped Codex MCP auth helper that calls
  `mcpServer/oauth/login`, observes `mcpServer/oauthLogin/completed`, and refreshes/reloads inventory.
- Add one exact callback route under the approved GITS HTTPS endpoint. It owns short-lived leases,
  validates callback ID/state/method/TTL/size, strips sensitive forwarding headers, performs the
  bounded handoff to the preflighted local Codex listener, and never logs the callback suffix or
  query.
- Refuse helper startup unless the advertised endpoint is compatible and the temporary
  `0.0.0.0` listener is isolated from external interfaces.
- Add a small Ports service that lists configured/selected listeners and drives exact browser
  navigation; reuse terminal metadata and `NetService`.
- Poll on request while the panel is active; do not introduce a streaming inventory subsystem.
- Repair browser URL resolution, viewer validation, ticket headers/revocation, exact-port navigation,
  and deletion/shutdown cleanup.
- Move the dev-command wrapper out of target repositories into a GITS-owned runtime asset, or fold its
  lifecycle into the terminal manager.
- Add provider-specific auth adapters. Reuse Codex app-server; dynamically use OpenCode server auth;
  use isolated guided PTYs for Claude/GitHub/Cursor where needed.
- Reuse the provider instance environment/home resolver, not duplicated shell construction.
- Extend Tailscale only in a later slice with status inspection, conflict detection, ownership, and
  isolated-origin support.

### Desktop

- Extend `SshEnvironmentManager` with auxiliary and pending registries while leaving the base GITS
  bridge lifecycle intact.
- Reuse target resolution and `runWithSshAuth`.
- Add post-start child supervision, exact/flexible local-port policies, and atomic open.
- Expose one narrow IPC route through contracts, channels, handler, preload, and
  `DesktopSshEnvironment`.
- Make automatic saved-environment WebSocket reconnect re-ensure the base SSH bridge.

### Web

- Add **Authenticate** and pending/success/error state to the existing MCP Servers details in
  `GitsCockpit`; open the returned provider authorization URL in the user's local browser and refresh
  the same row on completion. Do not add another MCP page.
- Replace direct terminal `openExternal` for URLs with the environment-aware resolver.
- Resolve saved-environment preview paths against the backend rather than the UI origin.
- Evolve Browser Preview into Ports & Browser; reuse the existing Dev menu/configuration.
- Use TanStack Query only while the panel is open; keep transient terminal observations scoped by
  environment and project/thread.
- Add provider-card auth actions and a small modal for device/manual-code or guided PTY state.
- Refresh the provider probe after auth completion without requiring a page reload.

## Provisional implementation sequence

This sequence assumes the recommended hybrid. It is implementation-plan-ready, but the final task-by-
task plan should be written only after the product direction is approved.

### Slice 0 — Correctness and safety baseline (small)

Deliverables:

- update Codex VPS guidance from hardcoded `ssh -L 1455` to device auth;
- update Claude guidance to document its manual-code remote fallback;
- replace the seeded hardcoded callback note for new installs with provider-native guidance;
- correct plaintext secret-store claims;
- disable or explicitly gate inferred Tailnet publication;
- document the current direct-publication security boundary.

Acceptance:

- a new VPS setup no longer tells users that manual port `1455` forwarding is required for Codex;
- docs never conflate subscription login with API-key billing;
- UI copy accurately describes credential storage;
- no configured dev command becomes Tailnet-visible merely because its package name looks like a web
  app.

### Slice 1 — Codex remote-MCP OAuth callback relay (medium)

Deliverables:

- live Codex MCP auth status in the existing MCP Servers panel;
- an **Authenticate** action backed by the structured Codex app-server MCP OAuth API;
- a dedicated credential-home/server-scoped auth helper and single-use callback lease;
- compatible advertised-HTTPS-endpoint selection and a fixed, non-secret callback route base;
- callback path, method, size, TTL, rate-limit, header-stripping, redaction, and listener-isolation
  enforcement;
- post-completion MCP reload/inventory refresh plus Desktop exact-forward and PAT fallback guidance.

Acceptance:

- Supabase MCP OAuth completes from an ordinary browser-only GITS session without Desktop, a PAT, or
  a separately managed SSH tunnel;
- the resulting credential lands in the correct Codex provider instance's native credential store;
- GITS never persists or logs the authorization code and never reads or stores an OAuth token;
- a wrong-ID, wrong-state, expired, repeated, oversized, or non-GET callback never reaches the Codex
  listener;
- the callback route cannot select an arbitrary host, port, MCP server, or credential home;
- startup refuses an incompatible HTTPS endpoint or externally reachable callback listener and offers
  the two documented fallbacks.

### Slice 2 — Repair supervised browser and smart loopback links (medium)

Deliverables:

- shared URL classifier/rewriter;
- environment-aware terminal link activation;
- exact selected-port browser navigation;
- remote backend URL resolution and cross-origin new-tab fallback;
- viewer endpoint validation, safe headers, ticket revocation, and lifecycle cleanup;
- reuse Dev commands in place of the hardcoded npm launcher.

Acceptance:

- clicking `http://localhost:5173/path?q=1#x` in a VPS browser terminal opens that exact path in VPS
  Chromium;
- an ordinary public link still opens locally unchanged;
- saved-environment previews request the saved backend, not the hosted UI origin;
- unrelated `ss` listeners are never selected implicitly;
- deleting/archiving a thread leaves no usable ticket or browser daemon owned by that thread.

### Slice 3 — Provider Auth Assistant: Codex and Claude (large)

Deliverables:

- safe auth-session contracts and server lifecycle;
- Codex app-server device-code/cancel/logout/completion support;
- Claude isolated guided PTY with transient URL and code submission;
- provider-instance scope resolution;
- Sign in/change/sign out UI and post-success probe refresh;
- secret-leak and authorization tests.

Acceptance:

- Codex subscription login succeeds from a browser-only machine without any SSH tunnel;
- Claude subscription login can complete using its documented browser code fallback;
- concurrent flows cannot mutate the same credential home;
- another connected GITS client cannot observe the URL, code, or transcript;
- no auth secret appears in logs, settings responses, orchestration events, or process argv.

### Slice 4 — Desktop automatic SSH forwards (large)

Deliverables:

- auxiliary forward registry, single-flight start, exact/flexible policies, list/release;
- atomic Desktop URL open IPC;
- scoped supervision/retry/cleanup and disconnect-race fix;
- base bridge re-ensure on WebSocket reconnect;
- terminal resolver integration and Ports row state.

Acceptance:

- a remote Vite/Next URL opens in the local system browser with no separate terminal;
- path/query/fragment are preserved after local-port rewrite;
- a fake OAuth flow reaches the remote exact callback listener;
- an occupied exact port blocks browser launch and recommends provider-native auth;
- disconnect/app exit kills every auxiliary child and does not stop an unrelated remote dev process;
- key, password, ProxyJump, and inherited-forward SSH configurations have explicit test coverage.

### Slice 5 — Ports inventory and generic dev-command lifecycle (medium/large)

Deliverables:

- additive ports capability and RPC snapshot;
- Ports & Browser UI merging configured, observed, discovered, and manual sources;
- strict port preflight/readiness/ownership states;
- GITS-owned launcher helper independent of the project repository;
- start/stop only for owned terminals and view-only behavior for unmanaged listeners.

Acceptance:

- an arbitrary repository with a root `npm run dev` can be started and its actual listener selected;
- the command does not depend on `<project>/scripts/dev/run-dev-command.sh`;
- Vite port fallback cannot cause GITS to expose an unrelated process;
- closing the panel stops polling but not the service;
- environment/thread/project state does not collide.

### Slice 6 — Additional provider adapters (medium each, independently shippable)

Deliverables:

- OpenCode dynamic method discovery using the connected server API;
- GitHub device flow;
- Cursor API-key UI and guided subscription terminal with honest capability labels;
- generic capability fallback for future providers.

Acceptance:

- only methods reported/supported by the installed provider are offered;
- provider-global versus instance-isolated credential scope is shown before mutation;
- API keys never appear in argv or responses after save;
- all auth integration tests use fakes, never live accounts.

### Slice 7 — Isolated native-browser preview endpoint (separate decision, large)

Prerequisites:

- strict GITS WebSocket Origin validation;
- CSRF/Origin protection for cookie-authenticated mutations;
- distinct preview hostname design or an equivalent proven isolation boundary;
- lease ownership and cleanup model.

Deliverables:

- root-preserving HTTP/WebSocket gateway to server-created loopback leases;
- cookie/header stripping and redirect rules;
- private endpoint provider with expiry/reconciliation;
- framework E2E validation;
- optional Tailscale provider only when it produces isolated origins safely.

Acceptance:

- a preview app never receives `t3_session` or GITS authorization data;
- preview-origin requests/WebSockets cannot mutate GITS;
- Vite and Next HMR work through the distinct origin;
- a non-GITS Serve mapping is never overwritten or disabled;
- stopping/expiry removes only the exact owned lease;
- no public exposure exists without a separate explicit action.

## Test plan

### Pure unit tests

- loopback classification for localhost, IPv4, IPv6, wildcard display hosts, malformed URLs, and
  default ports;
- direct URL rewrite with preserved scheme/path/query/fragment;
- encoded `redirect_uri` extraction and exact-port rules;
- port bounds and reserved-port rejection;
- port-source merge and environment scoping;
- listener ownership and claimed-versus-actual-port behavior;
- auth-session transition, expiry, single-flight, redaction, and credential-home keying;
- MCP callback URL derivation, advertised-endpoint compatibility, callback-ID/state matching, TTL,
  one-use consumption, request bounds, and rejected replay;
- MCP callback header sanitization and safe error mapping;
- Tailnet config conflict/no-clobber logic before any provider is enabled.

### Desktop/SSH integration tests

- concurrent identical requests create one child;
- different targets/ports remain isolated;
- generic collision retries and exact collision refusal;
- listener ready before `openExternal`;
- password prompt single-flight, cancellation, cached-secret reuse, and clearing;
- child exit/retry on the same port;
- disconnect during pending start and application-scope cleanup;
- SSH configs with `LocalForward`, `DynamicForward`, ProxyJump, keys, agent, and password;
- real smoke coverage on Linux, macOS, and representative Windows in-box OpenSSH.

### Auth integration tests

- fake Codex app-server device start/completion/cancel/timeout/logout;
- fake Codex `mcpServerStatus/list`, `mcpServer/oauth/login`, completion, reload, and credential-home
  isolation;
- fake Supabase authorization success, denial, callback handoff failure, and Codex state mismatch;
- fake OpenCode method discovery and callback modes;
- fake PTYs with ANSI and URLs/codes split across chunks;
- raw provider terminal fallback without success-string scraping;
- owner/authorization and cross-client isolation;
- no secrets in browser responses, broadcasts, NDJSON, logs, telemetry, errors, or argv;
- provider status refresh after completion;
- fake loopback OAuth callback with state mismatch and exact-port cleanup;
- no MCP callback query/code in persistence, responses, broadcasts, logs, telemetry, diagnostics, or
  error serialization.

### Browser/server integration tests

- the exact active MCP callback ID/state works without a GITS cookie; wrong, expired, and consumed
  values return not-found/gone and never reach the helper;
- the callback route accepts one bounded GET, strips browser/proxy credentials, and has no
  user-controlled upstream;
- relay startup refuses incompatible advertised endpoints and externally reachable internal callback
  ports;
- preview URL resolves to the selected saved environment;
- same-origin iframe and cross-origin new-tab paths;
- loopback-only viewer acceptance;
- ticket issue, expiry, eager revocation, cross-thread denial, and peer close;
- listener selection never falls back to an unrelated service;
- archive, delete, server restart, terminal exit, and reconnect cleanup;
- GITS WebSocket rejects disallowed `Origin` before native-preview rollout.

### Framework end-to-end matrix

- Vite: initial load, route, edit, HMR without full reload, strict-port conflict;
- Next App and Pages routers: `/_next` assets, navigation, HMR, redirects, server-action origin behavior;
- Expo Web/Metro: browser load/live refresh; explicit documentation that native-device transport uses
  Expo tunnel/private-network setup;
- app with an absolute `http://localhost` URL to prove supervised Chromium behavior;
- app attempting to read/log incoming GITS cookies—the test must receive none in any future native
  gateway.

### Client modes

- GITS web UI served by the VPS;
- hosted web UI connected to a saved remote environment;
- Desktop local environment;
- Desktop SSH environment with key and password auth;
- multiple simultaneous clients where server inventory is shared and local forwards are not.

### Repository verification

Every implementation slice must finish with:

```text
bun fmt
bun lint
bun typecheck
```

Focused Vitest suites run through `bun run test`, never `bun test`.

## Observability and diagnostics

Log structured lifecycle facts only:

- environment/target identifier;
- MCP server name and safe auth-session state, but never its callback ID, OAuth state, or query;
- remote and local numeric port;
- access mechanism;
- state transition and safe error category;
- command/terminal ownership identifier where applicable;
- duration and cleanup reason.

Never log a full authorization URL, query string, callback request, device/manual code, token, password,
cookie, or PTY transcript. A diagnostic bundle should redact URL query/fragment and provider/user data.

The UI should make the access boundary visible:

- **In GITS (VPS browser)**
- **Local via SSH (this computer only)**
- **Tailnet/private endpoint (devices allowed by policy)**
- **Public** only if a later explicit public feature exists

## Rollout and rollback

- Use additive environment capabilities so older servers/clients degrade to the current external-link
  behavior with an explanatory warning.
- Ship the Codex MCP callback relay as an early independent slice. Show **Authenticate** only when a
  compatible advertised HTTPS endpoint and safe internal-listener isolation are available.
- Ship supervised-browser repair before making it the default link action.
- Ship Codex and Claude independently of Desktop forwarding.
- Ship auxiliary SSH forwards independently of the Ports inventory.
- Keep the original **Open externally** action in a secondary menu for non-loopback links and
  troubleshooting.
- Do not migrate or persist existing ephemeral forwards.
- Gate future native exposure behind its capability and security prerequisites, not merely a UI flag.
- Each provider adapter and access mechanism must be independently disableable without breaking
  terminals, chat, or provider status probing.

## Success criteria

The recommended design is complete when:

1. A browser-only user can authenticate Codex's Supabase MCP server from the existing MCP panel
   without a PAT or manually created SSH tunnel, with the credential stored by the correct Codex
   instance.
2. A user connected through the GITS web GUI can run a dev server on the VPS, select/click its
   localhost URL, and use it in supervised Chromium without a manual SSH terminal.
3. A user connected through GITS Desktop SSH can click the same URL and have it open in the local
   system browser through an automatically managed forward.
4. Codex subscription login completes through device code from any browser-capable machine.
5. Claude subscription login completes through its documented remote manual-code path.
6. Exact callback forwarding works as a Desktop fallback and fails safely on collision.
7. No access action exposes a loopback service publicly or to the Tailnet without explicit intent.
8. A dev app cannot receive the GITS session cookie or use its origin to control GITS.
9. All tunnels, auth sessions, callback leases, browser tickets, and owned resources have
   deterministic cleanup.
10. Existing terminal, MCP, provider, saved-environment, and dev-command workflows continue to work.

## Recommendation to approve

Approve **Option C, the hybrid**, with this order:

1. safety/docs baseline;
2. Codex remote-MCP OAuth callback relay;
3. supervised-browser repair and smart links;
4. Codex/Claude Auth Assistant;
5. Desktop automatic SSH forwarding;
6. Ports inventory and generic launcher repair;
7. additional provider adapters;
8. isolated native-browser endpoints only as a separate later decision.

This is the shortest path that solves all three reported problems honestly. It gives browser-only
clients a safe Codex-to-Supabase MCP login, gives every GITS browser client a working dev-app path,
gives Desktop users native local browsing and exact callback support, and removes most provider-login
tunnel requirements through provider-native authentication. It avoids turning GITS's privileged
control origin or Tailnet node into an unsafe generic proxy.
