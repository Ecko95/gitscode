# Crit PR Review Integration — Design

- **Date:** 2026-06-07
- **Branch:** `feat/crit-pr-review-integration`
- **Status:** Approved design, pending implementation plan
- **Upstream tool:** [crit](https://github.com/tomasz-tomczyk/crit) — single Go binary, local-by-default browser review UI ("point at the line, tell the agent")

## Summary

Embed the crit binary as a GITS-managed sidecar and surface its browser review UI inside the GITS **PR view**, replacing the current `DiffPanel` `"sidebar"` mode for PR review. crit's `agent_cmd` is wired to a small GITS **wrapper CLI** that injects review comments into the **active GITS thread** via the existing `/api/orchestration/dispatch` endpoint. The agent that runs is whatever the active thread is configured for (codex by default) — crit never spawns an agent itself.

## Goals

- Review PRs inside GITS using crit's inline-comment-on-diff UX.
- "Send to agent" lands in the user's active GITS conversation, honoring their default provider (codex).
- Zero user setup — the crit binary ships with GITS.

## Non-goals (deferred)

- crit's own GitHub PR comment pull/push sync (GITS has its own PR thread flow).
- Multi-thread routing / choosing a target thread per comment.
- crit async share URLs.
- Replacing the native `DiffPanel` for non-PR diffs — it stays.

## Key decisions (locked)

| Decision | Choice | Rationale |
| --- | --- | --- |
| Integration shape | Embed the crit binary (sidecar + webview) | User wants crit's real UI, not a reimplementation. |
| Render location | Inside the PR view, replacing the sidebar diff | The ask: PR-centric review, not the diff side menu. |
| "Send to agent" target | Inject into the **active GITS thread** | Honors the default provider; keeps one conversation. |
| Binary distribution | **Bundle & manage** per-platform binaries | True "native plugin" feel, zero setup. |
| Lifecycle owner | **`apps/server`** | Already owns sidecars, auth, dispatch, workspace resolution; works for desktop *and* remote/web. |
| Async-turn bridge | **Block-and-return** (with timeout fallback to ack) | Keeps the review conversation inside crit's UI. |

## Why crit's lack of codex support is not a problem

crit ships no `agent_cmd` recipe for codex because bare `codex` is an interactive TUI, not a stdin→stdout headless filter (the same reason a naive `agent_cmd = codex` fails). This design sidesteps that entirely:

- crit's `agent_cmd` points at the **GITS wrapper CLI**, never at codex.
- The wrapper satisfies crit's contract perfectly: reads the comment context on **stdin**, writes the agent reply on **stdout**, runs non-interactively with no prompts.
- The actual codex run happens *inside GITS* via the codex app-server GITS already drives correctly. crit has no idea what's downstream.

Had we chosen "spawn a fresh agent" (`agent_cmd = codex exec ...`), crit's codex gap would have required the `codex exec --full-auto -` workaround. The injection route avoids it.

## Architecture

```
┌─ Electron (apps/desktop) ─────────────────────────────┐
│  PR view (apps/web)                                    │
│   └─ CritReviewPanel  ──<webview>──►  http://127.0.0.1:<port>  (crit UI)
└───────────────────────────────────────────────────────┘
                                              ▲
                              spawns/manages  │  serves
┌─ apps/server ────────────────────────────────┴────────┐
│  CritSidecarManager ── spawns ──►  crit binary (bundled)│
│        │                                                │
│        │ provides URL/status (WS/HTTP)                  │
│        ▼                                                │
│  /api/orchestration/dispatch  ◄── POST thread.turn.start
└───────────────────────────────────────────────────────┘
                                              ▲
                                              │ stdin: comment ctx
                          crit runs agent_cmd │ stdout: agent reply
                                              ▼
                           GITS wrapper CLI (the agent_cmd)
```

## Components

### 1. Binary bundling + resolver

- Ship per-platform crit binaries via electron-builder `extraResources` (e.g. `resources/crit/<platform>-<arch>/crit`).
- A resolver in the desktop backend (and a dev fallback to a checked-out/`$PATH` crit) returns the binary path for the current platform/arch.
- **Pre-req:** verify crit's license permits redistribution before bundling. If not, fall back to auto-download-on-first-use (deferred alt).
- v1 populates the resolver for all three platforms but only ships binaries actually built; missing-binary → clear error + fallback to native `DiffPanel`.

### 2. `CritSidecarManager` (`apps/server`)

- One crit process **per active project workspace**, ref-counted to open PR views, idle-timeout teardown.
- Spawns crit pointed at the repo root + current branch/PR on an **ephemeral free port** bound to `127.0.0.1`; retries on port conflict.
- On startup, configures crit's (global-only, for security) `agent_cmd` to the GITS wrapper path, and passes the scoped token to the wrapper via env/args.
- Health-checks crit's HTTP endpoint before reporting "ready"; surfaces `starting | ready | crashed | stopped` status.
- Modeled on the existing provider-runtime managers in `apps/server/src/provider/`.
- Exposes crit URL + status to the web app over the existing WS/HTTP surface.

### 3. `CritReviewPanel` (`apps/web`)

- New component rendering an Electron `<webview>` at the crit URL, slotted where the `"sidebar"` `DiffPanel` renders **for PR review**.
- Subscribes to crit sidecar status; shows loading / crashed / restart states.
- On crash or missing binary, falls back to the existing native `DiffPanel` sidebar.
- Non-PR diffs continue to use `DiffPanel` unchanged.

### 4. GITS wrapper CLI (the `agent_cmd`)

- A small program shipped with GITS, invoked by crit as its `agent_cmd`.
- **Input (stdin):** crit's payload — comment text, quoted text (if any), file path, line range.
- **Behavior:**
  1. Resolve the active thread for the crit sidecar's workspace.
  2. Encode the payload as a `reviewCommentContext` message segment (reuse `apps/web/src/reviewCommentContext.ts` encoding; extract shared encoder into `packages/shared` if needed).
  3. `POST /api/orchestration/dispatch` a `thread.turn.start` command carrying that segment, authenticated with the scoped bearer token.
  4. **Block-and-return bridge:** subscribe/poll `/api/orchestration/snapshot` + thread turn-lifecycle events until the turn completes; emit the final assistant message on **stdout**. On timeout, emit an ack ("Sent to GITS — see the conversation") and exit 0.
- **Auth:** uses a narrowly-scoped token (see Security) — never a full user credential.

### 5. Config + auth plumbing

- crit config (incl. `agent_cmd`) stored in GITS app data; `agent_cmd` set on first sidecar launch.
- Per-sidecar scoped bearer token minted at spawn, restricted to dispatching into its own workspace's threads, revoked on teardown.

## Data flow

1. User opens the PR view → GITS resolves workspace + PR/branch → `CritSidecarManager` ensures a crit process and returns its `127.0.0.1:<port>` URL.
2. `CritReviewPanel` webview loads crit → user reviews the diff, selects lines, writes a comment, clicks send.
3. crit runs the wrapper (`agent_cmd`) with the payload on stdin.
4. Wrapper resolves the active thread + token → `POST /api/orchestration/dispatch` `thread.turn.start` with the review-comment segment.
5. GITS runs the turn on the thread's provider (codex by default); the wrapper blocks on turn completion.
6. Wrapper emits the assistant's final message on stdout → crit threads it as a reply.

## Error handling & failure modes

| Failure | Handling |
| --- | --- |
| Missing/unbuilt binary for platform | Clear error in PR view; fall back to native `DiffPanel`. |
| crit process crash | Sidecar status → `crashed`; PR view offers restart; fall back to `DiffPanel`. |
| Port conflict | Ephemeral-port retry in `CritSidecarManager`. |
| No active thread | Wrapper starts a new thread, or returns a clear error to crit. |
| Turn exceeds timeout | Block-and-return degrades to ack message; reply still appears in GITS conversation. |
| Dispatch auth failure | Wrapper returns a readable error to crit; status surfaced. |

## Security

- crit binds to `127.0.0.1` only, never a public interface.
- Per-sidecar token is workspace-scoped and dispatch-only; revoked on teardown.
- `agent_cmd` is set by GITS (global-only setting), not user-editable through crit.
- Verify crit redistribution license before bundling.

## Testing strategy

- **Unit:** wrapper payload→`thread.turn.start` mapping; `reviewCommentContext` encoder; `CritSidecarManager` port/lifecycle/ref-count; binary resolver per platform.
- **Integration:** spawn crit headless, POST a synthetic comment through the wrapper, assert a thread turn starts and the assistant reply is returned on stdout.
- **E2E:** drive the PR view + crit webview with the existing headless verify harness + Playwright (boot GITS headlessly with a pairing token + isolated `T3CODE_HOME`).
- Gate completion on `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test` (per `AGENTS.md`).

## Open items for the plan

- Confirm the exact `thread.turn.start` command shape and message-segment schema in `packages/contracts/src/orchestration.ts`.
- Confirm crit's CLI flags for: target repo/branch, bind host/port, and setting `agent_cmd` non-interactively.
- Decide where the wrapper CLI lives (new `apps/server/src/cli/` subcommand vs standalone bin) and how it's pathed for crit.
