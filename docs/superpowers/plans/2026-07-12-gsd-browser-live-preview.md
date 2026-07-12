# GSD Browser Live Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an isolated, thread-scoped `gsd-browser` live workbench to every GITS chat with secure Tailnet bridging, supervision controls, and built-in commands.

**Architecture:** Reuse `gsd-browser` for browser lifecycle, MCP automation, frames, and human control. GITS injects a named MCP session into provider runtimes, exposes a typed preview service, and bridges the authenticated loopback viewer through a short-lived capability URL into the existing chat right-panel host.

**Tech Stack:** TypeScript, Effect 4 services/RPC/HTTP/WebSocket, React 19, TanStack Router, Zustand/client-runtime state, Vitest, Tailwind CSS, existing `gsd-browser` CLI.

## Global Constraints

- TypeScript; tabs, double quotes, semicolons, multiline trailing commas, maximum 160 columns.
- Variables and functions use snake_case; classes/components use PascalCase; constants use UPPER_SNAKE_CASE; files use kebab-case.
- Do not add a browser, streaming, proxy, or UI dependency.
- Each chat uses an isolated named `gsd-browser` session; no shared default session.
- Never persist live frames, viewer credentials, or input events.
- Missing `gsd-browser` must not prevent ordinary provider/chat startup.
- Never run `bun test`; use `bun run test` entrypoints.
- Completion requires `bun fmt`, `bun lint`, and `bun typecheck`.
- Preserve unrelated `.agents/` worktree content.

---

### Task 1: Shared preview contracts and client API

**Files:**
- Create: `packages/contracts/src/browser-preview.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/src/rpc.ts`
- Modify: `packages/contracts/src/ipc.ts`
- Modify: `packages/client-runtime/src/wsRpcClient.ts`
- Modify: `apps/web/src/environmentApi.ts`
- Test: `packages/contracts/src/browser-preview.test.ts`

**Interfaces:**
- Produces: `BrowserPreviewStatus`, `BrowserPreviewOpenResult`, `BrowserPreviewControlInput`, `BrowserPreviewError`, and `EnvironmentApi.browserPreview`.
- Control actions: `pause | resume | step | abort | takeover | release`.

- [ ] **Step 1: Write schema tests**

Cover a live open result, reject an empty ticket path, accept every control action, and reject unknown actions using `Schema.decodeUnknownSync`.

```ts
const decode_control = Schema.decodeUnknownSync(BrowserPreviewControlInput);
expect(decode_control({ threadId: "thread-1", action: "pause" }).action).toBe("pause");
expect(() => decode_control({ threadId: "thread-1", action: "destroy" })).toThrow();
```

- [ ] **Step 2: Run the contract test and verify failure**

Run: `bun run --cwd packages/contracts test -- browser-preview.test.ts`

Expected: FAIL because `browser-preview.ts` does not exist.

- [ ] **Step 3: Add minimal schemas and RPC methods**

Define bounded strings and typed results:

```ts
export const BrowserPreviewControlAction = Schema.Literals([
	"pause",
	"resume",
	"step",
	"abort",
	"takeover",
	"release",
]);

export const BrowserPreviewOpenInput = Schema.Struct({ threadId: ThreadId });
export const BrowserPreviewOpenResult = Schema.Struct({
	available: Schema.Boolean,
	status: Schema.Literals(["idle", "starting", "live", "paused", "takeover", "unavailable", "error"]),
	previewPath: Schema.NullOr(Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(512))),
	expiresAt: Schema.NullOr(Schema.String),
	message: Schema.NullOr(Schema.String),
});
```

Add `browserPreview.open`, `browserPreview.status`, and `browserPreview.control` RPCs to `WsRpcGroup`, expose them from `EnvironmentApi`, and wire the web adapter to the generated WS client.

- [ ] **Step 4: Run the contract test**

Run: `bun run --cwd packages/contracts test -- browser-preview.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts packages/client-runtime/src/wsRpcClient.ts apps/web/src/environmentApi.ts
git commit -m "feat(preview): add browser preview contracts"
```

### Task 2: Thread-scoped browser service and ticket registry

**Files:**
- Create: `apps/server/src/browser-preview/Services/BrowserPreview.ts`
- Create: `apps/server/src/browser-preview/Layers/BrowserPreview.ts`
- Test: `apps/server/src/browser-preview/Layers/BrowserPreview.test.ts`
- Modify: `apps/server/src/server.ts`

**Interfaces:**
- Produces: `browser_session_name(thread_id)`, `get_mcp_server(thread_id)`, `status(thread_id)`, `open(thread_id)`, `control(input)`, `resolve_ticket(ticket)`, and `stop(thread_id)`.
- Uses: `ProcessRunner`, `Crypto.Crypto`, `Clock`, and an in-memory map of preview tickets.

- [ ] **Step 1: Write failing service tests**

Test deterministic UUID-safe names, distinct names, CLI JSON parsing, binary absence, unsafe non-loopback URLs, five-minute expiry, and revocation.

```ts
expect(browser_session_name(ThreadId.make("550e8400-e29b-41d4-a716-446655440000"))).toBe(
	"gits-550e8400-e29b-41d4-a716-446655440000",
);
expect(() => parse_view_result('{"url":"https://evil.example/ws"}')).toThrow();
```

- [ ] **Step 2: Run the service test and verify failure**

Run: `bun run --cwd apps/server test -- src/browser-preview/Layers/BrowserPreview.test.ts`

Expected: FAIL because the service is missing.

- [ ] **Step 3: Implement session naming and CLI adapter**

Use `ProcessRunner.run` with the binary from `GITS_GSD_BROWSER_BIN` or `gsd-browser`, a 10-second timeout, and 1 MiB output bound. Build commands as:

```ts
const session_args = (thread_id: ThreadId, args: ReadonlyArray<string>) => [
	...args,
	"--session",
	browser_session_name(thread_id),
	"--json",
];
```

Map control actions to existing CLI commands (`release` maps to `release-control`). Parse `view --print-only` only when the URL is `http://127.0.0.1:<port>/` or `http://localhost:<port>/` and contains `session`, `viewer`, and `token` query values.

- [ ] **Step 4: Implement ticket lifecycle**

Mint a 32-byte random hex ticket, store `{ threadId, viewerUrl, expiresAtMs }`, delete expired entries on every issue/resolve, and return only `/api/browser-preview/<ticket>` through RPC. `resolve_ticket` must return no upstream secrets after expiry.

- [ ] **Step 5: Provide the service to runtime dependencies**

Add `BrowserPreviewLive` beside `VisualPlanMcpServiceLive` in `RuntimeDependenciesLive`, providing `ProcessRunnerLive` through the existing dependency graph.

- [ ] **Step 6: Run the service test**

Run: `bun run --cwd apps/server test -- src/browser-preview/Layers/BrowserPreview.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/browser-preview apps/server/src/server.ts
git commit -m "feat(preview): manage isolated browser sessions"
```

### Task 3: Secure HTTP and WebSocket viewer bridge

**Files:**
- Create: `apps/server/src/browser-preview/http.ts`
- Test: `apps/server/src/browser-preview/http.test.ts`
- Modify: `apps/server/src/server.ts`

**Interfaces:**
- Consumes: `BrowserPreview.resolve_ticket(ticket)`.
- Produces: `GET /api/browser-preview/:ticket` and `GET /api/browser-preview/:ticket/ws`.

- [ ] **Step 1: Write failing HTML rewrite tests**

Use a minimal fixture containing the viewer CSP and `new WebSocket('ws://' + location.host + '/ws?' + query.toString())`. Assert the rewrite allows embedding, uses protocol-aware WebSockets, targets the ticket bridge path, preserves the nonce, and fails when the bootstrap expression is absent.

```ts
expect(rewritten.html).toContain("location.protocol === \"https:\" ? \"wss://\" : \"ws://\"");
expect(rewritten.headers["cache-control"]).toBe("no-store");
```

- [ ] **Step 2: Run the bridge test and verify failure**

Run: `bun run --cwd apps/server test -- src/browser-preview/http.test.ts`

Expected: FAIL because the bridge module is missing.

- [ ] **Step 3: Implement the HTML route**

Extract the wildcard ticket from the URL, resolve it, fetch the stored loopback viewer URL with `HttpClient`, and rewrite exactly one WebSocket bootstrap. Replace `frame-ancestors 'none'` with `frame-ancestors *`; set `Content-Security-Policy`, `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, and `X-Content-Type-Options: nosniff`.

- [ ] **Step 4: Implement duplex socket forwarding**

Upgrade the client request through `request.upgrade`, construct the upstream socket with `Socket.makeWebSocket`, acquire both writers inside one scope, and run both raw pumps concurrently:

```ts
yield* Effect.all(
	[
		client_socket.runRaw((frame) => upstream_write(frame)),
		upstream_socket.runRaw((frame) => client_write(frame)),
	],
	{ concurrency: "unbounded" },
);
```

Close the peer when either side terminates. Never accept a target URL from route parameters.

- [ ] **Step 5: Register routes before the static wildcard**

Merge `browserPreviewHttpRouteLayer` into `makeRoutesLayer` before `staticAndDevRouteLayer`.

- [ ] **Step 6: Run bridge tests**

Run: `bun run --cwd apps/server test -- src/browser-preview/http.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/browser-preview apps/server/src/server.ts
git commit -m "feat(preview): bridge the live browser viewer"
```

### Task 4: RPC handlers and provider MCP injection

**Files:**
- Modify: `apps/server/src/ws.ts`
- Modify: `apps/server/src/provider/Layers/CodexSessionRuntime.ts`
- Modify: `apps/server/src/provider/Layers/CodexAdapter.ts`
- Modify: `apps/server/src/provider/Drivers/CodexDriver.ts`
- Modify: `apps/server/src/provider/Layers/ClaudeAdapter.ts`
- Modify: `apps/server/src/provider/Drivers/ClaudeDriver.ts`
- Modify: `apps/server/src/provider/Layers/CursorAdapter.ts`
- Modify: `apps/server/src/provider/Drivers/CursorDriver.ts`
- Modify: `apps/server/src/provider/Layers/OpenCodeAdapter.ts`
- Modify: `apps/server/src/provider/opencodeRuntime.ts`
- Test: existing provider adapter/runtime tests plus new focused assertions.

**Interfaces:**
- Consumes: `BrowserPreview.get_mcp_server(thread_id)` and control methods.
- Produces: per-thread MCP definitions named `gsd-browser` for every managed provider runtime.

- [ ] **Step 1: Add failing provider injection assertions**

For each provider, assert the generated MCP server command is `gsd-browser` and args include `mcp`, `--session`, and the derived thread session. Assert an unavailable binary omits injection without failing session start.

- [ ] **Step 2: Run focused provider tests and verify failure**

Run:

```bash
bun run --cwd apps/server test -- src/provider/Layers/CodexSessionRuntime.test.ts src/provider/Layers/ClaudeAdapter.test.ts src/provider/Layers/CursorAdapter.test.ts src/provider/Layers/OpenCodeAdapter.test.ts
```

Expected: FAIL on missing browser MCP definitions.

- [ ] **Step 3: Wire browser preview RPC handlers**

Resolve `BrowserPreview` in `makeWsRpcLayer`. Map open/status/control failures to `BrowserPreviewError` without returning stderr, viewer URLs, or tokens. Observe methods under `rpc.aggregate = "browser-preview"`.

- [ ] **Step 4: Inject MCP into Codex, Claude, and Cursor**

Mirror the optional `VisualPlanMcpService` pattern in each driver. Merge the browser server into existing per-session config rather than replacing `gits-visual-plan`. Use the stdio shapes required by each provider.

- [ ] **Step 5: Inject MCP into managed OpenCode**

Allow `startOpenCodeServerProcess` to receive generated config content and replace the hard-coded empty `OPENCODE_CONFIG_CONTENT`. Generate only the `mcp.gsd-browser` local command for the thread while preserving the existing empty-config isolation. For external OpenCode servers, omit injection and return an explanatory preview status.

- [ ] **Step 6: Run provider tests**

Run the Step 2 command.

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/ws.ts apps/server/src/provider
git commit -m "feat(preview): bind browser MCP to provider chats"
```

### Task 5: Thread route panel and live preview UI

**Files:**
- Create: `apps/web/src/components/browser-preview/BrowserPreviewPanel.tsx`
- Create: `apps/web/src/components/browser-preview/browser-preview-state.ts`
- Create: `apps/web/src/components/browser-preview/browser-preview-url.ts`
- Modify: `apps/web/src/diffRouteSearch.ts`
- Modify: `apps/web/src/routes/_chat.$environmentId.$threadId.tsx`
- Modify: `apps/web/src/components/chat/ChatHeader.tsx`
- Modify: `apps/web/src/components/ChatView.tsx`
- Modify: `apps/web/src/components/RightPanelSheet.tsx`
- Test: `apps/web/src/diffRouteSearch.test.ts`
- Test: `apps/web/src/components/chat/ChatHeader.browser.tsx`
- Test: `apps/web/src/components/ChatView.browser.tsx`

**Interfaces:**
- Consumes: `EnvironmentApi.browserPreview.open/status/control` and environment HTTP base URL.
- Produces: URL-addressable `panel=browser`, resizable desktop panel, and responsive sheet.

- [ ] **Step 1: Write failing route and header tests**

Assert `panel=browser` parses, Diff/Crit/browser are mutually exclusive, the browser toggle reports pressed state, and unavailable preview disables it with setup copy.

- [ ] **Step 2: Run focused web tests and verify failure**

Run:

```bash
bun run --cwd apps/web test -- src/diffRouteSearch.test.ts src/components/chat/ChatHeader.browser.tsx
```

Expected: FAIL because browser panel state is absent.

- [ ] **Step 3: Generalize route panel state**

Preserve existing `diff=1|crit` links while accepting `panel=browser`. Opening browser clears Diff/Crit search; opening Diff/Crit clears browser. Reuse `SidebarProvider`, `Sidebar`, and `SidebarRail` with a browser-specific width key and 540-pixel default.

- [ ] **Step 4: Build the panel states**

`BrowserPreviewPanel` opens a ticket on mount/thread change, derives the full iframe URL from the environment target, and renders one of: checking, unavailable with install command, startup error with Retry, live iframe, or disconnected with Reconnect. The header provides reload, open externally, and close. The iframe title is `Browser preview for <thread title>` and sandbox permissions are limited to the viewer's required scripts, same-origin connection, forms, and downloads.

- [ ] **Step 5: Add responsive behavior and focus restoration**

Use the inline sidebar above 980 pixels and `RightPanelSheet` below it. When closing, focus the composer; when takeover begins, leave keyboard focus inside the iframe.

- [ ] **Step 6: Run route/header/browser tests**

Run:

```bash
bun run --cwd apps/web test -- src/diffRouteSearch.test.ts src/components/chat/ChatHeader.browser.tsx src/components/ChatView.browser.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/browser-preview apps/web/src/components/ChatView.tsx apps/web/src/components/chat/ChatHeader.tsx apps/web/src/routes apps/web/src/diffRouteSearch.ts apps/web/src/components/RightPanelSheet.tsx
git commit -m "feat(preview): add live browser chat panel"
```

### Task 6: Built-in commands and keybinding

**Files:**
- Modify: `packages/contracts/src/keybindings.ts`
- Modify: `packages/shared/src/keybindings.ts`
- Modify: `apps/web/src/keybindings.ts`
- Modify: `apps/web/src/components/settings/KeybindingsSettings.logic.ts`
- Modify: `apps/web/src/components/CommandPalette.tsx`
- Modify: `apps/web/src/components/chat/ChatComposer.tsx`
- Modify: `apps/web/src/components/ChatView.tsx`
- Modify: `apps/web/src/composer-logic.ts`
- Test: `packages/contracts/src/keybindings.test.ts`
- Test: `apps/web/src/composer-logic.test.ts`
- Test: `apps/web/src/components/CommandPalette.logic.test.ts`

**Interfaces:**
- Produces: `browser.toggle`, command-palette controls, and local `/browser` commands.

- [ ] **Step 1: Write failing parser and keybinding tests**

Assert `/browser` defaults to open, accept each control subcommand, reject extra text as an app command, and add `browser.toggle` to the keybinding schema/default labels.

```ts
expect(parseStandaloneComposerSlashCommand("/browser pause")).toEqual({
	type: "browser",
	action: "pause",
});
expect(parseStandaloneComposerSlashCommand("/browser explain this")).toBeNull();
```

- [ ] **Step 2: Run command tests and verify failure**

Run:

```bash
bun run --cwd packages/contracts test -- keybindings.test.ts
bun run --cwd apps/web test -- src/composer-logic.test.ts src/components/CommandPalette.logic.test.ts
```

Expected: FAIL on missing browser command support.

- [ ] **Step 3: Implement local slash dispatch**

Add `/browser`, `/browser pause`, `/browser resume`, `/browser step`, `/browser abort`, `/browser takeover`, and `/browser release` to the menu. Handle both menu selection and raw Enter submission before provider dispatch. Show success/error toasts using the exact action name.

- [ ] **Step 4: Implement palette actions and keybinding**

Add browser actions only when a server thread is active. `browser.toggle` opens/closes the route panel and is configurable through existing keybinding settings. Do not assign a conflicting default key; expose it for user configuration.

- [ ] **Step 5: Run command tests**

Run the Step 2 commands.

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/keybindings* packages/shared/src/keybindings.ts apps/web/src
git commit -m "feat(preview): add browser supervision commands"
```

### Task 7: Lifecycle cleanup, docs, TODO, and final verification

**Files:**
- Modify: `apps/server/src/orchestration/Layers/ThreadDeletionReactor.ts`
- Test: `apps/server/src/orchestration/Layers/ThreadDeletionReactor.test.ts`
- Modify: `README.md`
- Modify: `docs/gits/TAILNET_HOSTING_REFRESH_PLAN.md`
- Modify: `TODO.md`

**Interfaces:**
- Consumes: `BrowserPreview.stop(thread_id)`.
- Produces: revoked tickets and best-effort daemon stop after thread deletion.

- [ ] **Step 1: Write cleanup failure-path test**

Assert thread deletion revokes preview access before calling daemon stop and that a stop failure is logged/ignored rather than rolling back deletion.

- [ ] **Step 2: Run cleanup test and verify failure**

Run: `bun run --cwd apps/server test -- src/orchestration/Layers/ThreadDeletionReactor.test.ts`

Expected: FAIL because preview cleanup is not wired.

- [ ] **Step 3: Wire best-effort cleanup**

Resolve the optional BrowserPreview service in `ThreadDeletionReactor`, revoke tickets synchronously, then run daemon stop with logged failure suppression.

- [ ] **Step 4: Update operator documentation**

Document installation/version check, optional `GITS_GSD_BROWSER_BIN`, per-chat isolation, `/browser` commands, Tailnet behavior, and the fact that existing global MCP configuration is no longer required for managed GITS sessions. Update `TODO.md` current status/completed/pending/notes sections.

- [ ] **Step 5: Run all focused tests**

Run:

```bash
bun run --cwd packages/contracts test -- browser-preview.test.ts keybindings.test.ts
bun run --cwd apps/server test -- src/browser-preview src/provider/Layers/CodexSessionRuntime.test.ts src/orchestration/Layers/ThreadDeletionReactor.test.ts
bun run --cwd apps/web test -- src/diffRouteSearch.test.ts src/composer-logic.test.ts src/components/chat/ChatHeader.browser.tsx
```

Expected: PASS.

- [ ] **Step 6: Run mandatory repository checks**

Run:

```bash
bun fmt
bun lint
bun typecheck
```

Expected: all commands exit 0.

- [ ] **Step 7: Inspect the final diff**

Run:

```bash
git status --short
git diff --check
git diff --stat origin/gits...HEAD
```

Expected: only preview feature files, documentation, and the pre-existing untracked `.agents/` directory appear; no whitespace errors.

- [ ] **Step 8: Commit final lifecycle and documentation changes**

```bash
git add apps/server/src/orchestration README.md docs/gits/TAILNET_HOSTING_REFRESH_PLAN.md TODO.md
git commit -m "docs(preview): document browser supervision"
```
