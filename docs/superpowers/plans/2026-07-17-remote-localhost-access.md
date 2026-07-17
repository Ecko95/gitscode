# Remote Localhost Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver private-by-default remote localhost access and provider authentication without exposing development services or OAuth credentials.

**Architecture:** Keep provider authentication provider-specific, use the existing Codex app-server as the MCP OAuth authority, and add only narrow in-memory leases for callback relaying. Route terminal URLs through one environment-aware resolver: browser clients use the existing VPS-supervised browser; Desktop SSH clients create a managed local forward. Ports remain an additive snapshot, not a process supervisor.

**Tech Stack:** TypeScript, Effect, Effect Schema, Node HTTP/WebSocket server, React/TanStack Query, Electron IPC, OpenSSH, Vitest, Bun.

## Global Constraints

- Keep `packages/contracts` schema-only; put runtime URL logic in an explicit `@t3tools/shared/*` subpath.
- Default to loopback-only access. Do not automatically publish a port to Tailscale or the public internet.
- Never persist, broadcast, log, or include in diagnostics an OAuth URL query, callback ID, OAuth state, authorization code, device/manual code, token, password, cookie, or PTY transcript.
- Mutating provider auth and MCP auth are authorized only for the initiating authenticated connection; sessions are in-memory, single-flight per credential home, cancellable, and time-limited.
- Preserve the exact callback port for loopback OAuth. A collision is a hard failure, not a port rewrite.
- All HTTP(S) URL parsing uses `URL`; accept loopback only as `localhost`, `127.0.0.0/8`, or `[::1]`. Treat display-only `0.0.0.0` and `[::]` as loopback only after normalization.
- Every slice must run `bun fmt`, `bun lint`, and `bun typecheck`. Run focused tests with `bun run test`, never `bun test`.
- Slice 7 (native-browser preview endpoints) is not in this plan: it needs a separate approval after WebSocket Origin validation and cookie/CSRF isolation are implemented and reviewed.

---

## File Map

| Area               | Files                                                                                                                                                                                                                                         | Responsibility                                                                              |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Shared URL rules   | `packages/shared/src/environmentUrl.ts`, `packages/shared/src/environmentUrl.test.ts`, `packages/shared/package.json`                                                                                                                         | Parse and classify loopback URLs, extract OAuth redirects, and safely rewrite direct URLs.  |
| Contracts          | `packages/contracts/src/ports.ts`, `packages/contracts/src/providerAuth.ts`, `packages/contracts/src/browser-preview.ts`, `packages/contracts/src/ipc.ts`, `packages/contracts/src/index.ts`                                                  | Schema-only port, auth-session, and narrow Desktop open contracts.                          |
| Browser preview    | `apps/server/src/browser-preview/*`, `apps/web/src/components/BrowserPreviewPanel.tsx`, `apps/web/src/routes/_chat.$environmentId.$threadId.tsx`                                                                                              | Selected-port navigation, ticket validation/revocation, and cross-origin safe presentation. |
| Terminal links     | `apps/web/src/components/ThreadTerminalDrawer.tsx`, `apps/web/src/environmentApi.ts`, `apps/web/src/localApi.ts`                                                                                                                              | Delegate terminal URL activation to an environment-aware server/Desktop action.             |
| MCP OAuth          | `apps/server/src/gits/Layers/GitsMcpInventory.ts`, new `apps/server/src/gits/Layers/CodexMcpAuth.ts`, `apps/server/src/gits/Services/*`, `apps/server/src/ws.ts`, `apps/server/src/server.ts`, `apps/web/src/components/gits/GitsCockpit.tsx` | Live Codex MCP status, single-use callback leases, and Authenticate UI.                     |
| Provider auth      | new `apps/server/src/provider-auth/*`, `apps/server/src/provider/Layers/CodexAdapter.ts`, provider RPC/contracts, `apps/web/src/components/settings/ProviderInstanceCard.tsx`                                                                 | Device-code Codex and guided Claude flows, without a generic OAuth service.                 |
| Desktop forwarding | `packages/ssh/src/tunnel.ts`, `packages/ssh/src/tunnel.test.ts`, `apps/desktop/src/ssh/DesktopSshEnvironment.ts`, `apps/desktop/src/ipc/*`, `apps/desktop/src/preload.ts`                                                                     | Auxiliary forwards and one atomic validate-forward-open Desktop IPC call.                   |
| Ports/dev commands | `apps/server/src/gits/Layers/GitsDevCommands.ts`, new `apps/server/src/gits/Layers/GitsPorts.ts`, `apps/web/src/components/BrowserPreviewPanel.tsx`, `apps/web/src/components/DevCommandsControl.tsx`                                         | Additive port inventory, owned command lifecycle, and no implicit Tailnet exposure.         |

## Slice 0 — Correctness and Safety Baseline

### Task 1: Correct existing remote-login and secret-storage copy

**Files:**

- Modify: `apps/web/src/components/settings/ProviderInstanceCard.tsx`
- Modify: `apps/web/src/components/settings/SettingsPanels.tsx`
- Modify: `packages/contracts/src/settings.ts`
- Modify: provider setup/help copy discovered by `rg -n '1455|plaintext|never written|API key|subscription' apps packages docs`
- Test: the closest existing component/contract tests

**Interfaces:** Produces copy that states device/manual-code login is the normal remote path, API-key billing differs from subscription login, and the server secret store is permission-protected filesystem storage rather than encryption/keychain storage.

- [ ] Add failing assertions for the corrected user-visible strings; do not snapshot unrelated settings content.
- [ ] Run the focused test and verify the old wording is observed.
- [ ] Replace only the incorrect wording. Codex remote guidance must recommend device code; Claude remote guidance must mention its manual-code fallback; API-key UI must not call itself subscription sign-in.
- [ ] Run the focused test and verify it passes.
- [ ] Commit `docs: correct remote authentication guidance`.

### Task 2: Disable inferred Tailnet publication

**Files:**

- Modify: `apps/server/src/gits/Layers/GitsDevCommands.ts`
- Modify: `apps/server/src/gits/Layers/GitsDevCommands.test.ts`
- Modify: `apps/web/src/components/DevCommandsControl.tsx`
- Test: `apps/server/src/gits/Layers/GitsDevCommands.test.ts`

**Interfaces:** `inferDiscoveryMetadata()` returns `publishOnTailnet: false`; explicit config remains the only way to request Tailnet publication until a later isolated-origin implementation.

- [ ] Add a failing test for root and app inferred commands asserting `publishOnTailnet === false`, even when a port hint exists.
- [ ] Run `bun run test apps/server/src/gits/Layers/GitsDevCommands.test.ts`; verify failure against current inferred `true` behavior.
- [ ] Change the single inference default and update UI copy to label explicit Tailnet publication experimental/disabled where it is currently shown.
- [ ] Run the focused test, then `bun fmt`, `bun lint`, and `bun typecheck`.
- [ ] Commit `fix: keep inferred dev commands private`.

## Slice 1 — Shared URL Semantics and Browser Preview Repair

### Task 3: Add shared environment URL classification

**Files:**

- Create: `packages/shared/src/environmentUrl.ts`
- Create: `packages/shared/src/environmentUrl.test.ts`
- Modify: `packages/shared/package.json`

**Interfaces:**

```ts
export type EnvironmentUrlKind = "external" | "loopback" | "oauth-loopback";
export function classifyEnvironmentUrl(rawUrl: string): {
  readonly url: URL;
  readonly kind: EnvironmentUrlKind;
};
export function isLoopbackHostname(hostname: string): boolean;
export function normalizeLoopbackDisplayUrl(url: URL): URL;
export function rewriteLoopbackOrigin(input: {
  readonly url: URL;
  readonly localPort: number;
}): URL;
export function extractLoopbackRedirectUri(authorizationUrl: URL): URL | null;
```

- [ ] Write failing tests for public URLs, localhost, every `127/8` address, `[::1]`, display wildcards, malformed URLs, default ports, a percent-encoded `redirect_uri`, and path/query/fragment preservation.
- [ ] Run `bun run test packages/shared/src/environmentUrl.test.ts`; verify the module is missing.
- [ ] Implement the pure functions with `URL`, numeric port bounds `1..65535`, and no network access. `extractLoopbackRedirectUri` returns `null` unless the decoded URI is HTTP(S) and loopback.
- [ ] Export `./environmentUrl` using the project’s explicit subpath-export pattern.
- [ ] Run the focused test, format, lint, and typecheck.
- [ ] Commit `feat(shared): classify environment URLs`.

### Task 4: Make browser preview exact-port and ticket-safe

**Files:**

- Modify: `packages/contracts/src/browser-preview.ts`
- Modify: `apps/server/src/browser-preview/browser-preview-manager.ts`
- Modify: `apps/server/src/browser-preview/browser-preview-manager.test.ts`
- Modify: `apps/server/src/browser-preview/browser-preview-routes.ts`
- Add test coverage in `apps/server/src/browser-preview/browser-preview-routes.test.ts`

**Interfaces:** Replace inferred `connect-localhost` selection with `navigate` to an explicit validated URL. Add `revokeThread(threadId)` and `revokeAll()` to the manager; `BrowserPreviewStatus.previewPath` is issued only from an HTTP(S) loopback viewer URL.

- [ ] Add failing manager tests proving a non-loopback viewer URL is rejected, selected `http://127.0.0.1:5173/path?q=1#x` is the only navigation target, and stopping/revoking removes every ticket for the thread.
- [ ] Add failing route tests for `Referrer-Policy: no-referrer`, expired/revoked ticket rejection, and a cross-origin response that is not framed.
- [ ] Remove `parse_localhost_dev_ports` selection from the access path. Keep it only if another displayed inventory still uses it; otherwise delete it and its tests.
- [ ] Require `viewer_url.hostname` to be loopback and `http:`/`https:` before storing it. On ticket issue, delete the replaced ticket; on stop/archive/delete/shutdown, revoke tickets before stopping the daemon.
- [ ] Keep same-origin framing only. For a cross-origin saved environment, return a status flag that makes the web client open the authenticated relay in a new tab rather than weakening CSP.
- [ ] Run the focused manager/route tests and full required checks.
- [ ] Commit `fix: make browser preview selected-port and revocable`.

### Task 5: Route terminal links through the environment resolver

**Files:**

- Modify: `apps/web/src/components/ThreadTerminalDrawer.tsx`
- Modify: `apps/web/src/components/ThreadTerminalDrawer.test.ts`
- Modify: `apps/web/src/environmentApi.ts`
- Modify: `apps/web/src/localApi.ts`
- Modify: `packages/contracts/src/providerRuntime.ts` or the existing WebSocket RPC contract that owns environment actions
- Modify: `apps/server/src/ws.ts`

**Interfaces:** Add one action with an input shape equivalent to:

```ts
{
  environmentId: EnvironmentId;
  threadId: ThreadId;
  url: string;
  source: "terminal";
}
```

The server returns `{ action: "external" | "supervised-browser" | "desktop-forward" | "unsupported"; url?: string; message?: string }`. Web code never guesses whether the selected environment is remote.

- [ ] Write failing UI tests: public links call the existing external opener; a saved remote loopback link calls the environment action; a path link retains editor behavior.
- [ ] Write failing RPC tests for malformed URLs, local loopback external behavior, and saved-browser loopback behavior that invokes explicit browser navigation.
- [ ] Implement the resolver as a server-side orchestration decision using `@t3tools/shared/environmentUrl`; reuse the selected environment metadata already used by `environmentApi`.
- [ ] For browser-only saved environments, open the existing supervised browser at the exact original URL. Preserve public-link behavior unchanged.
- [ ] Run focused web/server tests and required checks.
- [ ] Commit `feat: open remote terminal localhost links safely`.

## Slice 2 — Codex MCP OAuth Callback Relay

### Task 6: Represent runtime MCP status without replacing config fallback

**Files:**

- Modify: `packages/contracts/src/gits.ts`
- Modify: `apps/server/src/gits/Services/GitsMcpInventory.ts`
- Modify: `apps/server/src/gits/Layers/GitsMcpInventory.ts`
- Modify: `apps/server/src/gits/Layers/GitsMcpInventory.test.ts`
- Modify: `apps/server/src/provider/Layers/CodexAdapter.ts`

**Interfaces:** Extend `GitsMcpServerItem` with an optional runtime source/status field and a minimal `canAuthenticate` boolean. `GitsMcpInventoryResolver.getSnapshot()` merges Codex `mcpServerStatus/list` facts when a matching active Codex instance is available, otherwise retains config-file `unknown` auth status.

- [ ] Add failing tests that merge a fake runtime `notLoggedIn` server into its config row, preserve config-only rows, and never expose tokens or raw authorization URLs.
- [ ] Run the resolver/Codex adapter focused tests and verify failure.
- [ ] Add a narrow Codex runtime query on the existing app-server manager/adapter path; do not start a generic provider process from the inventory scanner.
- [ ] Decode only name, transport, enabled, status, tool/resource counts, and auth classification. Map unrecognized auth data to `unknown`.
- [ ] Run focused tests and required checks.
- [ ] Commit `feat: show live Codex MCP authentication status`.

### Task 7: Build the one-time Codex MCP auth helper and lease store

**Files:**

- Create: `apps/server/src/gits/Services/CodexMcpAuth.ts`
- Create: `apps/server/src/gits/Layers/CodexMcpAuth.ts`
- Create: `apps/server/src/gits/Layers/CodexMcpAuth.test.ts`
- Modify: `apps/server/src/server.ts`
- Modify: `apps/server/src/ws.ts`
- Modify: `packages/contracts/src/gits.ts`

**Interfaces:**

```ts
type StartCodexMcpAuthInput = {
  readonly providerInstanceId: string;
  readonly serverName: string;
  readonly connectionId: string;
};
type CodexMcpAuthResult = {
  readonly sessionId: string;
  readonly authorizationUrl: string;
  readonly expiresAt: string;
};
interface CodexMcpAuth {
  start(input: StartCodexMcpAuthInput): Effect.Effect<CodexMcpAuthResult, CodexMcpAuthError>;
  cancel(input: {
    sessionId: string;
    connectionId: string;
  }): Effect.Effect<void, CodexMcpAuthError>;
  handleCallback(input: SafeCallbackRequest): Effect.Effect<CallbackResult, never>;
}
```

- [ ] Add failing tests for one active session per `(effectiveCodexHome, serverName)`, owner-only status/cancel, timeout, cancellation, completion, and no authorization query in errors, logs, events, or returned status.
- [ ] Add failing tests that reject incompatible advertised HTTPS endpoints and any temporary callback listener whose isolation check cannot prove it is unavailable from non-loopback interfaces.
- [ ] Start a dedicated short-lived Codex app-server process with its resolved credential home, a random high callback port, `mcp_oauth_callback_port`, and `mcp_oauth_callback_url` set from a compatible advertised HTTPS endpoint. Use bounded bind retries after preflight; never choose a caller-supplied host or port.
- [ ] Call `mcpServer/oauth/login`, parse its returned authorization URL, require a standards-shaped redirect URI and state, and store only hashed/opaque comparison material necessary for constant-time validation.
- [ ] Consume `mcpServer/oauthLogin/completed`, reload MCP config, refresh inventory, stop the helper, and delete the session regardless of success, denial, timeout, or disconnect.
- [ ] Run focused tests and required checks.
- [ ] Commit `feat: add isolated Codex MCP OAuth helper`.

### Task 8: Add the narrow HTTPS callback route and MCP-panel action

**Files:**

- Create: `apps/server/src/gits/http/CodexMcpOauthRoutes.ts`
- Create: `apps/server/src/gits/http/CodexMcpOauthRoutes.test.ts`
- Modify: `apps/server/src/server.ts`
- Modify: `apps/web/src/components/gits/GitsCockpit.tsx`
- Modify: the existing authenticated GITS inventory route and tests

**Interfaces:** Expose `POST` start/cancel endpoints only through the authenticated GITS control plane. Expose exactly one unauthenticated callback `GET /api/gits/mcp/oauth/callback/:callbackId`, accepted only by the in-memory auth helper.

- [ ] Add route tests for wrong ID, wrong state, wrong method, oversized query, expired/replayed lease, proxy/cookie/authorization header stripping, and a valid single handoff to the fixed local helper port.
- [ ] Run the route test and verify it fails before implementation.
- [ ] Forward only the bounded callback path/query to `http://127.0.0.1:<reserved-port>/...`; never construct an upstream from request fields. Delete the lease before forwarding so retries cannot replay.
- [ ] Add the MCP row’s `Authenticate` action only when `canAuthenticate` and the endpoint/isolation preflight are available. Open the returned authorization URL via the initiating client’s normal external browser and refetch the same inventory query on terminal state.
- [ ] Show documented Desktop exact-forward and PAT fallback guidance when the relay is unavailable; do not weaken route validation.
- [ ] Run focused route/UI tests and required checks.
- [ ] Commit `feat: authenticate Codex MCP servers from GITS`.

## Slice 3 — Provider Authentication Assistant

### Task 9: Add provider auth-session contracts and redacted lifecycle

**Files:**

- Create: `packages/contracts/src/providerAuth.ts`
- Create: `packages/contracts/src/providerAuth.test.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `apps/server/src/provider-auth/ProviderAuthService.ts`
- Create: `apps/server/src/provider-auth/ProviderAuthService.test.ts`

**Interfaces:** `ProviderAuthSession` has only `sessionId`, `providerInstanceId`, `method`, `state`, sanitized `prompt`, `acceptsCode`, and `expiresAt`; verification URI and user code are response-only transient fields, not persisted events/snapshots.

- [ ] Write schema tests that reject invalid state/method values and serialization tests proving sensitive fields are omitted from persisted/broadcast shapes.
- [ ] Write lifecycle tests for single-flight credential-home keys, owner-only reads, cancel, expiry, and terminal cleanup.
- [ ] Implement a small in-memory map keyed by resolved credential home and provider. It owns timeout fibers and has no database table.
- [ ] Run focused tests and required checks.
- [ ] Commit `feat: add private provider auth sessions`.

### Task 10: Implement Codex device-code login and logout

**Files:**

- Modify: `apps/server/src/provider/Layers/CodexAdapter.ts`
- Modify: `apps/server/src/codexAppServerManager.ts`
- Modify: `apps/server/src/provider-auth/ProviderAuthService.ts`
- Modify: provider RPC contracts/routes and their tests
- Modify: `apps/web/src/components/settings/ProviderInstanceCard.tsx`
- Add focused Codex adapter/auth tests

**Interfaces:** Codex supports `start({ method: "device-code" })`, `cancel(sessionId)`, and `logout(providerInstanceId)`. It calls structured `account/login/start` with `chatgptDeviceCode`; completion notification is authoritative.

- [ ] Add a fake app-server test for start, completion, cancel, timeout, and logout; assert API-key login is presented separately and never mislabeled subscription login.
- [ ] Implement the adapter calls in the existing resolved Codex home/environment scope; retain no device code/URL after completion and refresh the existing account probe.
- [ ] Add Sign in, Change login, and Sign out controls to the existing provider card. Restrict transient code/URL visibility to the initiating connection.
- [ ] Run focused tests and required checks.
- [ ] Commit `feat: sign in to Codex with device code`.

### Task 11: Implement Claude’s guided manual-code fallback

**Files:**

- Create: `apps/server/src/provider-auth/ClaudeGuidedLogin.ts`
- Create: `apps/server/src/provider-auth/ClaudeGuidedLogin.test.ts`
- Modify: `apps/server/src/provider-auth/ProviderAuthService.ts`
- Modify: `apps/web/src/components/settings/ProviderInstanceCard.tsx`

**Interfaces:** The guided session starts `claude auth login` in the selected provider home, exposes sanitized URL/prompt fragments only to the owner, accepts one submitted manual code, and determines success from process exit plus the existing provider status probe.

- [ ] Write fake-PTY tests with URLs/codes split across ANSI chunks, cancellation, exit failure, manual-code submission, and transcript redaction.
- [ ] Implement an isolated PTY invocation with the resolved provider environment. Never scrape a success sentence and never put a credential in argv.
- [ ] Add a code-entry form only when the session reports `acceptsCode`; disable it after submit/cancel/expiry.
- [ ] Run focused tests and required checks.
- [ ] Commit `feat: guide Claude remote login`.

## Slice 4 — Desktop Automatic SSH Forwards

### Task 12: Extend the SSH manager with scoped auxiliary forwards

**Files:**

- Modify: `packages/contracts/src/ipc.ts`
- Modify: `packages/ssh/src/tunnel.ts`
- Modify: `packages/ssh/src/tunnel.test.ts`
- Modify: `apps/desktop/src/ssh/DesktopSshEnvironment.ts`
- Modify: `apps/desktop/src/ssh/DesktopSshEnvironment.test.ts`

**Interfaces:**

```ts
type ForwardPolicy = { readonly kind: "flexible" } | { readonly kind: "exact"; readonly localPort: number };
ensureForward(target, { remoteHost: "127.0.0.1", remotePort, policy }): Effect.Effect<{ localPort: number }, SshEnvironmentEffectError, SshEnvironmentEffectContext>;
releaseForward(target, { remotePort, localPort }): Effect.Effect<void, SshEnvironmentEffectError, SshEnvironmentEffectContext>;
```

- [ ] Add failing tests for single-flight identical forwards, distinct target/port isolation, flexible collision retry, exact collision failure, child exit cleanup, and disconnect/application cleanup.
- [ ] Reuse `resolveSshTarget`, `runWithSshAuth`, child supervision, and the existing base-bridge lifecycle. Keep base bridge entries and auxiliary entries in distinct registries.
- [ ] Require `ExitOnForwardFailure=yes`, local loopback binding, readiness before success, and no remote process termination during cleanup.
- [ ] Run focused SSH tests and required checks.
- [ ] Commit `feat(ssh): manage auxiliary local forwards`.

### Task 13: Add atomic Desktop URL open and exact OAuth handling

**Files:**

- Modify: `packages/contracts/src/ipc.ts`
- Modify: `apps/desktop/src/ipc/methods/window.ts`
- Modify: `apps/desktop/src/ipc/DesktopIpcHandlers.ts`
- Modify: `apps/desktop/src/preload.ts`
- Modify: `apps/desktop/src/ssh/DesktopSshEnvironment.ts`
- Add tests beside the IPC and SSH environment tests

**Interfaces:** `desktopBridge.ssh.openRemoteUrl({ target, url, oauthRedirectPort?: number })` validates URL, establishes a flexible direct forward or exact redirect forward, rewrites only direct-loopback origins, then calls Electron `openExternal`.

- [ ] Add failing tests for preserved path/query/fragment, public URL passthrough, exact redirect port forwarding, occupied exact-port refusal, and no `openExternal` call before readiness.
- [ ] Implement parsing with `environmentUrl`; for OAuth use `extractLoopbackRedirectUri` and preserve the original authorization URL exactly. For direct URL use `rewriteLoopbackOrigin`.
- [ ] Return safe error categories for UI guidance; do not return SSH command output, secrets, or raw auth URLs.
- [ ] Run focused tests and required checks.
- [ ] Commit `feat(desktop): open remote localhost through SSH`.

### Task 14: Connect Desktop link actions and reconnect lifecycle

**Files:**

- Modify: `apps/web/src/environmentApi.ts`
- Modify: `apps/web/src/localApi.ts`
- Modify: `apps/web/src/components/ThreadTerminalDrawer.tsx`
- Modify: saved-environment connection lifecycle in `packages/client-runtime/src/environmentConnection.ts`
- Add focused client-runtime and terminal-link tests

- [ ] Add failing tests proving Desktop SSH environments call the atomic IPC action and browser-only environments never request a local SSH forward.
- [ ] Route the server action result from Task 5 to the Desktop bridge only for Desktop SSH metadata.
- [ ] Re-ensure the base bridge on saved-environment WebSocket reconnect without recreating unrelated auxiliary forwards.
- [ ] Run focused tests and required checks.
- [ ] Commit `feat: use managed SSH forwards for terminal links`.

## Slice 5 — Ports Inventory and Dev-command Lifecycle

### Task 15: Add an additive ports contract and snapshot service

**Files:**

- Create: `packages/contracts/src/ports.ts`
- Create: `packages/contracts/src/ports.test.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `apps/server/src/gits/Services/GitsPorts.ts`
- Create: `apps/server/src/gits/Layers/GitsPorts.ts`
- Create: `apps/server/src/gits/Layers/GitsPorts.test.ts`
- Modify: `apps/server/src/ws.ts`

**Interfaces:** Define `PortRecord` with validated `remotePort: 1..65535`, loopback host, `http|https|tcp`, sources, listener state, ownership, optional terminal/command metadata, and access state. Expose `ports.list({ projectDir, threadId? })`; older clients decode a missing `ports` capability as unavailable.

- [ ] Write failing schema tests for port bounds, source merge/deduplication, environment scoping, and no public/Tailnet endpoint fields.
- [ ] Write failing service tests that combine configured ports, explicit selected ports, and terminal-observed URLs; discovered listeners are view-only unless terminal ownership is proven.
- [ ] Implement one on-demand `ss -ltnpH` parse only when requested. Filter control/reserved ports, never choose the first process-name-matched listener.
- [ ] Add RPC snapshot wiring using the existing Effect service/WS method pattern.
- [ ] Run focused tests and required checks.
- [ ] Commit `feat: add environment-scoped ports inventory`.

### Task 16: Make dev commands owned, strict, and repository-independent

**Files:**

- Modify: `apps/server/src/gits/Layers/GitsDevCommands.ts`
- Modify: `apps/server/src/gits/Layers/GitsDevCommands.test.ts`
- Create: `apps/server/src/gits/dev-command-runner.ts`
- Add runner tests alongside the layer
- Modify: `apps/web/src/components/DevCommandsControl.tsx`

- [ ] Add failing tests that an inferred root `dev` command has no assumed port, an explicit claimed port is preflighted, and the launch path does not reference `<project>/scripts/dev/run-dev-command.sh`.
- [ ] Materialize/use a GITS-owned runner under the server state directory or invoke the terminal manager directly; do not write a helper into the target repository.
- [ ] Request strict-port behavior only for known frameworks/configured commands that explicitly claim a port. If the process moves port, report observed port and ownership mismatch rather than exposing the claimed port.
- [ ] Remove automatic Tailnet `serve --bg` behavior from command launch. Preserve explicit configuration as disabled/unavailable until Slice 7’s security prerequisites are approved.
- [ ] Run focused tests and required checks.
- [ ] Commit `fix: keep dev command lifecycle owned and private`.

### Task 17: Evolve Browser Preview to Ports & Browser

**Files:**

- Modify: `apps/web/src/components/BrowserPreviewPanel.tsx`
- Modify: `apps/web/src/routes/_chat.$environmentId.$threadId.tsx`
- Modify: `apps/web/src/environmentApi.ts`
- Add component/browser tests

- [ ] Add failing component tests for configured/manual/terminal/detected rows, Preview in GITS for HTTP(S), Desktop-only Open locally, and disabled Start/Stop for unmanaged listeners.
- [ ] Use TanStack Query only while the panel is open; refetch after terminal lifecycle changes and manual Refresh. Closing the panel stops polling but never stops a dev process or browser daemon.
- [ ] Reuse `DevCommandsControl` for command editing/launching; the panel only selects/navigates exact ports.
- [ ] For saved cross-origin environments, open the authenticated browser viewer relay in a new tab; do not embed it.
- [ ] Run focused tests and required checks.
- [ ] Commit `feat: show Ports and Browser inventory`.

## Slice 6 — Capability-driven Additional Providers

### Task 18: Add provider capability adapters one provider at a time

**Files:**

- Create: `apps/server/src/provider-auth/OpenCodeAuth.ts` and tests
- Create: `apps/server/src/provider-auth/GitHubAuth.ts` and tests
- Create: `apps/server/src/provider-auth/CursorAuth.ts` and tests
- Modify: `apps/server/src/provider-auth/ProviderAuthService.ts`
- Modify: `apps/web/src/components/settings/ProviderInstanceCard.tsx`

- [ ] Add OpenCode tests using a fake connected server that reports device-code/OAuth/API-key methods; only render reported methods.
- [ ] Add GitHub fake-PTY device-flow tests; never accept a PAT through process argv.
- [ ] Add Cursor tests for sensitive-environment API key submission and guided-terminal labels; do not claim browser callback automation.
- [ ] Wire each adapter behind the same owner-only transient session interface from Task 9. Unknown providers get guided-terminal instructions, not guessed callback ports.
- [ ] Run each focused suite and required checks after each provider commit: `feat: add OpenCode auth capabilities`, `feat: add GitHub device login`, `feat: add Cursor auth options`.

## Final Integration and Release Gate

### Task 19: Exercise cleanup, redaction, and compatibility boundaries

**Files:**

- Modify/add tests in each slice’s test files
- Modify: `apps/server/src/server.test.ts`
- Modify: `apps/web/src/localApi.test.ts`
- Modify: `packages/contracts/src/providerRuntime.test.ts`

- [ ] Add integration tests for archive/delete/shutdown cancelling browser tickets, MCP callback leases/helpers, provider sessions, and SSH auxiliary forwards.
- [ ] Add a redaction test harness that serializes RPC errors, NDJSON/event logger payloads, diagnostics, and browser responses after fake auth data is supplied; assert each sensitive marker is absent.
- [ ] Add older-client decoding tests for absent `ports` capability and config-only MCP inventory fallback.
- [ ] Run the focused integration suites, then `bun fmt`, `bun lint`, and `bun typecheck`.
- [ ] Run the repository’s browser/integration suite through `bun run test` if its package scripts expose it; do not run `bun test`.
- [ ] Commit `test: cover remote access lifecycle boundaries`.

### Task 20: Release documentation and feature gates

**Files:**

- Modify: user-facing setup/provider/remote-environment documentation discovered by `rg -l 'Tailscale|localhost|Codex|Claude|Browser Preview' docs apps`
- Modify: settings and feature-capability copy introduced by the slices

- [ ] Document the four access labels exactly: `In GITS (VPS browser)`, `Local via SSH (this computer only)`, `Tailnet/private endpoint`, and `Public`.
- [ ] Document that native preview endpoints remain unavailable pending separate origin isolation approval; do not describe same-host Tailscale Serve as safe.
- [ ] Document rollback: disable the MCP auth helper, supervised-browser link routing, provider auth adapters, Desktop forwards, and Ports capability independently without breaking terminal or provider probes.
- [ ] Run documentation-adjacent focused tests and required checks.
- [ ] Commit `docs: document private remote access boundaries`.

## Acceptance Checklist

- [ ] Codex MCP OAuth completes from a browser-only client using a single callback lease and the correct provider credential home; no code/token is stored by GITS.
- [ ] A remote terminal `http://localhost:5173/path?q=1#x` opens in VPS-supervised Chromium for browser clients and locally via managed SSH for Desktop SSH clients.
- [ ] OAuth redirect loopback ports are exact for Desktop and fail safely when occupied.
- [ ] Codex device-code login and Claude manual-code fallback are private to the initiating connection.
- [ ] No inferred dev command is Tailnet-visible; no arbitrary listener is selected or exposed.
- [ ] Closing UI panels never kills unmanaged services; archive/delete/shutdown release every resource GITS owns.
- [ ] `bun fmt`, `bun lint`, `bun typecheck`, and all focused tests pass before each slice is merged.
