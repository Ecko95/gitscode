# GSD Browser Live Preview Design

## Goal

Add a thread-scoped live browser preview to GITS so an operator can watch, pause, step, abort, annotate, record, or take over automated browser interactions without leaving the chat session.

## Decisions

- Each chat owns an isolated named `gsd-browser` session.
- GITS reuses the installed `gsd-browser` MCP server and authenticated live workbench instead of implementing browser capture or input forwarding.
- The preview is part of the chat route, mutually exclusive with Diff and Crit panels.
- Desktop uses a resizable right panel; narrow screens use the existing right-side sheet.
- Frames and input events are bridged transiently and are never written to orchestration persistence.

## Architecture

### Thread-scoped browser identity

The server derives a stable, CLI-safe session name from the thread ID. Every provider session for that thread receives a per-session MCP definition equivalent to:

```text
gsd-browser mcp --session <derived-session-name>
```

Codex, Claude, and Cursor use their existing per-session MCP injection points. The managed OpenCode runtime receives the same server through its generated runtime configuration. An externally managed OpenCode server cannot be rewritten safely, so GITS reports that it requires matching external MCP configuration instead of silently sharing the default browser.

Reopening or resuming a thread reuses its named browser. Forked threads receive new browser sessions. Closing the panel does not stop automation. Deleting the thread stops the associated daemon; server restarts only invalidate viewer tickets, not the named browser state.

### Browser preview service

A focused server service owns:

- binary discovery and version/status checks;
- deterministic thread-to-session naming;
- `view --print-only --json` startup and response validation;
- short-lived preview tickets;
- control commands (`pause`, `resume`, `step`, `abort`, `takeover`, `release-control`);
- thread deletion cleanup.

The service uses the existing `ProcessRunner`; no new process or browser dependency is introduced. Binary absence is cached briefly and never prevents the coding provider itself from starting.

### Secure viewer bridge

An authenticated WebSocket RPC opens the preview and returns an opaque, short-lived capability path. The HTTP route validates that capability, fetches only the service-generated loopback viewer URL, and returns the existing self-contained workbench HTML with two minimal compatibility rewrites:

1. allow embedding in the GITS panel;
2. connect its WebSocket to the GITS bridge using `ws:` or `wss:` based on the current origin.

The bridge validates the ticket, connects only to the stored loopback viewer endpoint, and forwards text/binary frames in both directions. Clients cannot supply an upstream URL, host, or port. Responses use `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.

Tickets expire after five minutes for new HTTP/WebSocket handshakes. An already-open WebSocket may continue; reconnecting requests a fresh ticket through the authenticated RPC.

## Contracts and data flow

The shared contracts add:

- preview availability/status;
- open-preview result with capability path and expiry;
- thread-scoped control actions;
- typed operational errors with safe operator-facing messages.

Data flow:

1. A provider starts a thread with the named `gsd-browser` MCP server.
2. Browser tool calls reach that named daemon and its isolated Chrome instance.
3. The operator opens Browser Preview from the same thread.
4. GITS issues a preview ticket and embeds the bridged workbench.
5. Frames, annotations, recordings, and control input travel through the bridge directly to `gsd-browser`.
6. Only low-frequency availability/control summaries live in client state; frame payloads bypass Zustand and orchestration storage.

All web state is keyed by `ScopedThreadRef`, not a bare thread ID, so saved environments cannot collide.

## UI and commands

### Chat integration

The thread route generalizes its existing Diff/Crit right-panel host to support Browser Preview as a third mutually exclusive surface. The active panel remains URL-addressable so refresh, browser history, and deep links behave predictably.

The chat header gains a browser toggle beside Terminal and Diff. It shows disabled/unavailable, connecting, live, paused, takeover, and disconnected states with existing semantic colors and compact controls.

The panel contains:

- a 48-pixel GITS header with session status, reload, open-in-new-window, and close actions;
- the embedded `gsd-browser` workbench, which already provides Control, Annotate, Record, Sensitive, Pause, Step, Resume, and Abort controls;
- actionable setup, startup, expired-ticket, and disconnected states;
- retry without closing the chat.

Desktop reuses the existing resizable right sidebar with a browser-specific saved width. At 980 pixels and below it uses `RightPanelSheet`; the preview fills the sheet without adding a second nested scroll region. Keyboard focus remains inside the viewer during takeover and returns to the composer when the panel closes.

### Command surfaces

The feature is available through all built-in command surfaces:

- header toggle;
- command palette actions for open/close, pause, resume, step, abort, take over, and return control;
- configurable `browser.toggle` keybinding;
- local composer commands: `/browser`, `/browser pause`, `/browser resume`, `/browser step`, `/browser abort`, `/browser takeover`, and `/browser release`.

Local slash commands are handled in both the composer-menu selection path and raw submission parser so they are never sent to the coding provider. Control actions retain the same names in buttons, command results, and notifications.

## Errors and reliability

- Missing or outdated `gsd-browser`: show the detected command/version and the install/update command; keep chat functional.
- Daemon startup failure: preserve stderr server-side, return a typed safe message, and offer Retry.
- Viewer HTML incompatibility: fail closed if the expected WebSocket bootstrap cannot be rewritten; do not serve a partially functional viewer.
- Ticket expiry: request a fresh ticket and reload the iframe once; repeated failure becomes an explicit disconnected state.
- WebSocket interruption: the embedded viewer performs bounded reconnects; the outer panel exposes manual reconnect.
- Thread switching: detach the old iframe immediately and open the selected thread's ticket, preventing cross-thread frames or controls.
- Slow clients: bridge frames directly without copying them into application queues or stores; closing either socket closes the peer.
- Thread deletion: revoke tickets first, then stop the named daemon as best-effort cleanup.

## Security

- Preview tickets use cryptographically random values, are stored only in memory, expire quickly, and are scoped to one thread/session.
- The proxy accepts no arbitrary target URLs and permits loopback viewer endpoints created by `gsd-browser` only.
- Upstream viewer tokens are never returned through RPC or stored in browser persistence.
- Capability responses are non-cacheable and do not send referrers.
- Existing GITS authentication is required to mint or control a preview.
- Sensitive mode remains implemented by `gsd-browser`; GITS does not capture frames separately.

## Testing and verification

Focused tests cover:

- deterministic, valid, collision-resistant session names;
- CLI JSON parsing, missing binary, timeout, and unsafe viewer URL rejection;
- ticket issue, expiry, revocation, and thread scoping;
- viewer HTML rewrite and `ws:`/`wss:` bridge paths;
- bidirectional WebSocket forwarding and peer-close behavior;
- provider MCP injection for Codex, Claude, Cursor, and managed OpenCode;
- local `/browser` parsing and prevention of provider dispatch;
- route mutual exclusion, header states, thread switching, desktop resizing, and narrow-screen sheet rendering;
- actionable unavailable, retry, expired, and disconnected states.

Completion requires:

```text
bun fmt
bun lint
bun typecheck
```

Relevant focused Vitest suites run with `bun run test` entrypoints; `bun test` is never used.

## Deliberate exclusions

- No second browser engine or screenshot polling implementation.
- No frame/event persistence, replay database, or custom recording format; `gsd-browser` already owns recordings and history.
- No shared browser between chats.
- No automatic panel opening on every browser tool call; the operator chooses when to supervise.
- No unrelated redesign of chat, Diff, Crit, or terminal panels.
