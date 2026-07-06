# Overview

GITS is the DevOS IDE and control plane for coding agents. It keeps the T3 Code remote shell and adds a GITS cockpit for Open GSD, Delamain peers, provider sessions, and remote operator workflows.

The product boundary is:

- T3 Code shell for remote access, clients, pairing, terminals, and provider sessions.
- DevOS Cockpit for projects, clients, repos, milestones, `.planning` state, GSD phases, verification gates, UAT evidence, visual baselines, queue status, resource monitoring, cost/session visibility, and Your Turn cards.
- Delamain Fleet for peer execution, isolated worktrees, peer lifecycle controls, frozen gates, and PR integration.
- Open GSD for the `.planning` source of truth and `gsd-sdk`-based workflows.

GITS currently supports Codex, Claude, OpenCode, and Cursor Agent where those providers are available. Install and authenticate at least one provider before use.

The underlying provider engine is Codex-first today: the server starts `codex app-server` over JSON-RPC stdio per provider session, then streams structured events to the browser over WebSocket push messages.

The main package boundaries are:

- `apps/server`: Node.js HTTP/WebSocket server, auth, pairing, provider sessions, orchestration projections, terminal management, VCS operations, and static web serving.
- `apps/web`: React/Vite UI for session UX, conversation and event rendering, client state, settings, command palette, saved environments, and WebSocket runtime client.
- `apps/desktop`: Electron shell for backend management, SSH launch, Tailscale endpoints, updates, menus, and native settings.
- `apps/mobile`: React Native remote operator client for paired environments, threads, terminals, diffs, and connection flows.
- `packages/contracts`: shared Effect schemas and RPC contracts. This package stays schema-only.
- `packages/shared`: shared runtime utilities with explicit subpath exports.

Sources: `README.md`, `AGENTS.md`, `docs/gits/ARCHITECTURE.md`.
