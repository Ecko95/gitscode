# Dev Notes and Notion Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a server-backed Markdown notes vault, a Dev Notes route, and safe two-way sync to a dedicated Notion data source.

**Architecture:** A `GitsNotes` Effect service owns filename validation, atomic vault I/O, seed creation, and the Notion Markdown HTTP calls. The WebSocket GITS aggregate exposes only typed note data. The React route keeps editor state local, renders existing Markdown dependencies, and refreshes the list after mutations/sync.

**Tech Stack:** Effect/Schema, Node `fs/promises` and `fetch`, TanStack Router/Query, React, `react-markdown`, `remark-gfm`, Vitest.

## Global Constraints

- Vault root: `GITS_NOTES_DIR`, default `~/.gits/notes`, must be deployment-mounted persistent storage.
- Sync credentials are server-only: `GITS_NOTES_NOTION_TOKEN`, `GITS_NOTES_NOTION_DATA_SOURCE_ID`.
- Use Notion API version `2026-03-11` and enhanced Markdown endpoints; add no new dependency.
- Every stored note is a `.md` file; mapping metadata lives in YAML frontmatter in that file.
- Never overwrite dual edits: retain local and create a remote conflict Markdown file.
- Required seed: `VPS localhost callback redirect for windows powershell.md` with the supplied SSH command, only when absent.
- Final verification is `bun fmt`, `bun lint`, and `bun typecheck`; never use `bun test`.

---

### Task 1: Define the notes contracts and client surface

**Files:**

- Modify: `packages/contracts/src/gits.ts`
- Modify: `packages/contracts/src/rpc.ts`
- Modify: `packages/contracts/src/gits.test.ts`
- Modify: `packages/client-runtime/src/wsRpcClient.ts`
- Modify: `packages/client-runtime/src/wsRpcClient.test.ts`

**Interfaces:**

- Produces `GitsNoteSummary`, `GitsNote`, `GitsNotesListInput`, `GitsNoteWriteInput`, `GitsNotesSyncResult`, and `GitsNotesError`.
- Produces `client.gits.notes.list/read/create/update/remove/sync`.

- [ ] **Step 1: Add failing schema tests** for a note summary, full note, write payload, and typed `GitsNotesError`; reject an empty ID, non-`.md` filename, and traversal-shaped filename.
- [ ] **Step 2: Add schemas** in `gits.ts`: IDs/filenames are trimmed non-empty strings capped at 255 characters; content is capped at 2 MiB; summaries expose `id`, `title`, `updatedAt`, and `notionPageId`; full notes add `content`; sync exposes `created`, `updated`, `conflicts`, and `warnings`.
- [ ] **Step 3: Add RPCs** in `rpc.ts`: `gits.notes.list`, `gits.notes.read`, `gits.notes.create`, `gits.notes.update`, `gits.notes.remove`, and `gits.notes.sync`; each uses its exact request schema and `GitsNotesError`.
- [ ] **Step 4: Wire the generated client** by adding a `notes` group under `WsRpcClient["gits"]` and transport requests matching the six new method constants.
- [ ] **Step 5: Run focused contracts/client tests.**

Run: `bun --filter @t3tools/contracts run test -- gits.test.ts && bun --filter @t3tools/client-runtime run test -- wsRpcClient.test.ts`
Expected: passing focused tests.

- [ ] **Step 6: Commit.**

Run: `git add packages/contracts/src/gits.ts packages/contracts/src/rpc.ts packages/contracts/src/gits.test.ts packages/client-runtime/src/wsRpcClient.ts packages/client-runtime/src/wsRpcClient.test.ts && git commit -m "feat: add dev notes RPC contracts"`

### Task 2: Implement durable Markdown vault and Notion synchronization

**Files:**

- Create: `apps/server/src/gits/Services/GitsNotes.ts`
- Create: `apps/server/src/gits/Layers/GitsNotes.ts`
- Create: `apps/server/src/gits/Layers/GitsNotes.test.ts`
- Modify: `apps/server/src/server.ts`

**Interfaces:**

- Consumes the Task 1 contracts.
- Produces `GitsNotes` with `list`, `read`, `create`, `update`, `remove`, and `sync` methods returning Effects with `GitsNotesError`.

- [ ] **Step 1: Write failing vault tests** with a temporary `GITS_NOTES_DIR`: missing root is created; seed is created once; only direct `.md` files appear; `../x.md` is rejected; write/read round trips; deletion removes only the selected note; a failed rename leaves the previous complete file intact.
- [ ] **Step 2: Implement vault helpers** using `node:fs/promises` and `node:path`: resolve `GITS_NOTES_DIR ?? join(homedir(), ".gits", "notes")`, call `mkdir({ recursive: true })`, accept only basenames ending in `.md`, and write to `${path}.tmp-${randomUUID()}` then `rename`.
- [ ] **Step 3: Implement note metadata**: parse and serialize a minimal YAML frontmatter block containing `gitsNotionPageId` and `gitsLastSyncedHash`; calculate the hash using `node:crypto.createHash("sha256")` over the Markdown body; omit frontmatter when neither value exists.
- [ ] **Step 4: Write failing Notion sync tests** by stubbing `fetch`: local create posts a Markdown page under the configured data source; local update patches Markdown; remote page Markdown creates/updates a mapped file; a dual change writes a timestamped `Notion conflict` file; a missing token/data-source yields a typed configuration error without attempting HTTP.
- [ ] **Step 5: Implement Notion calls** with native `fetch`, `Authorization: Bearer ${token}`, `Notion-Version: 2026-03-11`, and JSON content type. Query the configured data source for pages, retrieve each page’s Markdown, create pages with the `Name` title property plus `markdown`, and replace page Markdown on updates. Treat non-2xx, malformed payloads, and truncation as typed warnings/errors; do not log credentials.
- [ ] **Step 6: Implement conflict logic**: compare local body hash and remote body hash to `gitsLastSyncedHash`; if both differ, preserve local and atomically write the remote to `<stem> (Notion conflict <UTC ISO timestamp>).md`; otherwise update the changed side and persist the fresh shared hash/page ID.
- [ ] **Step 7: Register `GitsNotesLive`** in `GitsLayerLive` in `apps/server/src/server.ts`.
- [ ] **Step 8: Run focused server tests.**

Run: `bun --filter t3 run test -- GitsNotes.test.ts`
Expected: passing vault, sync, and conflict tests.

- [ ] **Step 9: Commit.**

Run: `git add apps/server/src/gits apps/server/src/server.ts && git commit -m "feat: add durable markdown notes sync"`

### Task 3: Route note RPCs through the authenticated WebSocket server

**Files:**

- Modify: `apps/server/src/ws.ts`
- Modify: `apps/server/src/server.test.ts`

**Interfaces:**

- Consumes `GitsNotes` and all Task 1 RPC methods.
- Produces authenticated `gits.notes.*` handlers mapped through `observeRpcEffect`.

- [ ] **Step 1: Add failing dispatch tests** that invoke list/read/write/remove/sync and assert the corresponding `GitsNotes` method receives the decoded request.
- [ ] **Step 2: Resolve `const gitsNotes = yield* GitsNotes`** alongside the existing GITS services in the WebSocket program.
- [ ] **Step 3: Add six handlers** near `gitsGetCockpit`, each wrapping its service call with `observeRpcEffect`, its own `WS_METHODS.gitsNotes*` method, and `{ "rpc.aggregate": "gits" }`; map unexpected causes to `GitsNotesError` with a user-safe message.
- [ ] **Step 4: Run the focused RPC test.**

Run: `bun --filter t3 run test -- server.test.ts`
Expected: passing RPC dispatch coverage.

- [ ] **Step 5: Commit.**

Run: `git add apps/server/src/ws.ts apps/server/src/server.test.ts && git commit -m "feat: expose dev notes RPCs"`

### Task 4: Add the Dev Notes navigation and full-page Markdown UI

**Files:**

- Create: `apps/web/src/routes/notes.tsx`
- Create: `apps/web/src/components/gits/GitsNotes.tsx`
- Create: `apps/web/src/components/gits/GitsNotes.test.tsx`
- Modify: `apps/web/src/components/Sidebar.tsx`
- Modify: `apps/web/src/routeTree.gen.ts` via the repository’s TanStack route generation command

**Interfaces:**

- Consumes `readGitsEnvironmentClient(environmentId)?.notes` and Task 1 note response types.
- Produces the `/notes` authenticated route and a **Dev Notes** menu entry immediately above **GITS Cockpit**.

- [ ] **Step 1: Add failing component tests**: seed note appears; search filters title/content case-insensitively; selecting a note loads its content; Edit changes a textarea; Preview renders the SSH command in a code block; save calls update; sync refreshes the list; an RPC failure stays visible and leaves editor text intact.
- [ ] **Step 2: Add `routes/notes.tsx`** by copying the authentication guard shape from `routes/gits.tsx` and rendering `GitsNotes`.
- [ ] **Step 3: Add the sidebar item** above the existing GITS Cockpit item using `StickyNoteIcon`, `pathname.startsWith("/notes")`, mobile close behavior, and `navigate({ to: "/notes" })`.
- [ ] **Step 4: Implement `GitsNotes.tsx`** as a three-column responsive layout: searchable list and New button; editor with title and Markdown textarea; Preview toggle with `ReactMarkdown remarkPlugins={[remarkGfm]}`. Fetch lists with React Query, select the first result when nothing is selected, invalidate the list/read queries after create/update/delete/sync, and use existing `Button`, `Input`, alert/toast primitives.
- [ ] **Step 5: Regenerate the route tree** using the project’s existing web build/typecheck route generation path; do not hand-edit `routeTree.gen.ts`.
- [ ] **Step 6: Run focused UI tests.**

Run: `bun --filter @t3tools/web run test -- GitsNotes.test.tsx`
Expected: passing note list, search, preview, mutation, and error-state coverage.

- [ ] **Step 7: Commit.**

Run: `git add apps/web/src/routes/notes.tsx apps/web/src/components/gits/GitsNotes.tsx apps/web/src/components/gits/GitsNotes.test.tsx apps/web/src/components/Sidebar.tsx apps/web/src/routeTree.gen.ts && git commit -m "feat: add dev notes workspace"`

### Task 5: Provision Notion and document deployment configuration

**Files:**

- Modify: `README.md`

**Interfaces:**

- Consumes the Notion data-source ID created through the authenticated Notion MCP connection.
- Produces deployment instructions and a known sync target.

- [ ] **Step 1: Use the authenticated Notion MCP** to create a parent page named `GITS Dev Notes` and a child Notes database/data source with the required title property `Name`; share it with the server integration and record its data-source ID.
- [ ] **Step 2: Add README setup instructions** containing exactly: persistent volume mount for `GITS_NOTES_DIR`; server-only `GITS_NOTES_NOTION_TOKEN`; `GITS_NOTES_NOTION_DATA_SOURCE_ID`; integration sharing requirement; the Notion page/data-source URL; and a warning that the token must not be exposed to browser clients.
- [ ] **Step 3: Commit.**

Run: `git add README.md && git commit -m "docs: configure dev notes notion sync"`

### Task 6: Verify the integrated feature

**Files:**

- Modify only files changed by formatting.

- [ ] **Step 1: Run the focused test suite.**

Run: `bun run test --filter=@t3tools/contracts --filter=@t3tools/client-runtime --filter=t3 --filter=@t3tools/web`
Expected: passing tests; investigate any failure before proceeding.

- [ ] **Step 2: Run required repository checks.**

Run: `bun fmt && bun lint && bun typecheck`
Expected: all commands exit 0.

- [ ] **Step 3: Verify the runtime manually.** Start the server, open its actual listening URL through the browser supervision tool, authenticate, navigate to `/notes`, verify the seed note and preview, then create/edit/delete a note and run a Notion sync.

- [ ] **Step 4: Commit formatting changes if any.**

Run: `git status --short && git add -u && git commit -m "style: format dev notes" || true`

- [ ] **Step 5: Push the feature branch and open a review.**

Run: `git push -u origin docs/dev-notes-notion-plan`
