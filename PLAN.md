# UI Polish Plan — Collapsible Sidebar + Double-Click Thread Rename

Branch: `feat/gits-ui-polish`
Scope: `apps/web` (UI), plus keybinding registration in `packages/contracts` and `packages/shared`.

All work follows the existing patterns verified in this codebase. Tasks are complete only when
`bun fmt`, `bun lint`, and `bun typecheck` pass (see AGENTS.md).

---

## Feature 1 — Collapsible Sidebar (Cmd/Ctrl+B, persisted)

### Current state (verified)
- The left thread sidebar shell lives in `apps/web/src/components/AppSidebarLayout.tsx`, which renders
  `SidebarProvider` (defaultOpen hardcoded `true`) → `Sidebar side="left" collapsible="offcanvas"` →
  `<ThreadSidebar/>` + `<SidebarRail/>`. This is mounted by `apps/web/src/routes/__root.tsx`
  (`<AppSidebarLayout>{<Outlet/>}</AppSidebarLayout>`), so all child routes are inside the provider.
- The shadcn-style primitive `apps/web/src/components/ui/sidebar.tsx` already implements full collapse:
  `useSidebar()` exposes `{ open, state, setOpen, toggleSidebar, isMobile, openMobile, setOpenMobile }`.
  With `collapsible="offcanvas"`, the `data-slot="sidebar-gap"` div collapses to `w-0` and the container
  slides off-screen via `group-data-[collapsible=offcanvas]:left-[calc(var(--sidebar-width)*-1)]`, so the
  main content **already reclaims the space automatically** when collapsed. No layout/CSS changes needed.
- The primitive writes a `sidebar_state` cookie on every `setOpen` (line ~118), but **nothing reads it
  back at init** — `defaultOpen` is hardcoded `true`. So collapse state does NOT currently persist across
  reloads. The original shadcn `Cmd/Ctrl+B` keydown listener was removed from this fork (no keydown in the
  primitive), so **there is no toggle keybinding today**.
- There is a SECOND, independent `SidebarProvider` for the right-hand diff panel in
  `apps/web/src/routes/_chat.$environmentId.$threadId.tsx` (controlled via `diffOpen`/`onOpenChange`,
  `side="right"`). Our toggle must target ONLY the left provider.
- `SidebarTrigger` (toggle button) is rendered in headers but always `md:hidden` (mobile only). On desktop
  the only re-open affordance is `<SidebarRail/>` (click/drag). Keyboard toggle is the requested mechanism.

### Keybinding system (verified registration pattern)
Commands are a typed union. To add `sidebar.toggle`:
1. `packages/contracts/src/keybindings.ts` — add `"sidebar.toggle"` to the `STATIC_KEYBINDING_COMMANDS`
   array (the union backing `KeybindingCommand`).
2. `packages/shared/src/keybindings.ts` — add `{ key: "mod+b", command: "sidebar.toggle" }` to
   `DEFAULT_KEYBINDINGS`. `mod` resolves to Cmd on macOS and Ctrl elsewhere (verified `mod+b` is unused).
   No `when` clause needed (global toggle). This auto-flows into `DEFAULT_RESOLVED_KEYBINDINGS`.
3. Settings UI needs **no manual change**: `commandLabel()` derives "Sidebar: Toggle" from the id, and
   `buildKeybindingCommandOptions()` enumerates commands from default + custom bindings — so the new
   command appears in `apps/web/src/components/settings/KeybindingsSettings.tsx` automatically.

### Dispatch + persistence (web)
4. Persistence module (new) `apps/web/src/sidebarCollapseState.ts`, mirroring
   `apps/web/src/editorPreferences.ts`: a `useSidebarOpenState()` hook over
   `useLocalStorage("t3code:sidebar-open", true, Schema.Boolean)` (Effect Schema, namespaced
   `t3code:` key, matching `LAST_EDITOR_KEY` convention and the existing
   `chat_thread_sidebar_width` localStorage usage). Returns `[open, setOpen]`.
5. `apps/web/src/components/AppSidebarLayout.tsx` — make the left `SidebarProvider` controlled:
   read initial state with `useSidebarOpenState()`, pass `open={open}` and
   `onOpenChange={setOpen}` (replacing the hardcoded `defaultOpen`). This persists collapse across
   reloads via localStorage — same controlled pattern the diff-panel provider already uses. (`window` is
   always available in this Vite SPA; no SSR concern.)
6. Wire the shortcut dispatch in `apps/web/src/routes/_chat.tsx` inside the existing
   `ChatRouteGlobalShortcuts` component (which already calls `resolveShortcutCommand(event, keybindings, …)`
   and is rendered inside the LEFT provider, ABOVE the diff provider in the tree). Call `useSidebar()` to
   get `toggleSidebar`, and add an `if (command === "sidebar.toggle") { event.preventDefault();
   event.stopPropagation(); toggleSidebar(); return; }` branch alongside the existing `chat.new` /
   `chat.newLocal` branches. Add `toggleSidebar` to the effect deps array.

### Acceptance criteria
- Pressing Cmd+B (macOS) / Ctrl+B (Windows/Linux) toggles the left sidebar open↔collapsed.
- When collapsed, the sidebar slides off-canvas and the main content fills the reclaimed width.
- The collapsed/expanded state survives a full page reload.
- The shortcut is registered through the keybinding system: it appears in Settings → Keybindings as
  "Sidebar: Toggle" (`mod+b`) and can be rebound/removed there.
- The diff (right) sidebar is unaffected; `mod+d` (`diff.toggle`) still works independently.
- `bun fmt`, `bun lint`, `bun typecheck` pass.

---

## Feature 2 — Double-Click Thread Rename (inline)

### Current state (verified)
- The inline-rename input ALREADY exists and is fully wired in `apps/web/src/components/Sidebar.tsx`.
  The render branch is in `SidebarThreadRow` (~line 582):
  `renamingThreadKey === threadKey ? <input … /> : <span>{thread.title}</span>`, with handlers
  `handleRenameInputRef` (focus+select), `handleRenameInputChange`, `handleRenameInputKeyDown`
  (Enter→commit, Esc→cancel), `handleRenameInputBlur` (commit if not already committed),
  `handleRenameInputClick` (stopPropagation).
- Rename state lives in the parent component: `renamingThreadKey`/`setRenamingThreadKey` and
  `renamingTitle`/`setRenamingTitle` (`useState`, ~lines 1061–1062), plus `renamingCommittedRef` and
  `renamingInputRef` (`useRef`, ~lines 1073–1074).
- The rename MUTATION is `commitRename` (~line 1769) which dispatches
  `api.orchestration.dispatchCommand({ type: "thread.meta.update", commandId: newCommandId(),
  threadId, title })`. `cancelRename` (~line 1764) clears the editing state.
- Entering rename mode today happens ONLY via the context menu: `handleThreadContextMenu` (~line 1905)
  on `clicked === "rename"` does exactly:
  `setRenamingThreadKey(threadKey); setRenamingTitle(thread.title); renamingCommittedRef.current = false;`
  (~lines 1927–1931). This is the canonical "begin rename" sequence to reuse.
- Prop drilling chain (must extend): parent → `SidebarProjectThreadList` (props iface ~line 723, render
  ~line 2077) → `SidebarThreadRow` (props iface ~line 281, render ~line 830). `commitRename`,
  `cancelRename`, `setRenamingTitle`, `renamingInputRef`, `renamingCommittedRef`, `renamingThreadKey`,
  `renamingTitle` already travel this chain. `setRenamingThreadKey` does NOT yet — it stays in the parent.

### Approach
1. In the parent component of `Sidebar.tsx`, add a memoized `beginRename` callback that reproduces the
   context-menu rename sequence exactly (single source of truth):
   ```ts
   const beginRename = useCallback((threadRef: ScopedThreadRef, currentTitle: string) => {
     setRenamingThreadKey(scopedThreadKey(threadRef));
     setRenamingTitle(currentTitle);
     renamingCommittedRef.current = false;
   }, []);
   ```
   Then refactor the context menu's `clicked === "rename"` branch (~line 1927) to call
   `beginRename(threadRef, thread.title)` so both entry points share one implementation (per AGENTS.md:
   avoid duplicate logic).
2. Thread `beginRename` through the prop chain: add it to `SidebarProjectThreadListProps` (~line 723) and
   `SidebarThreadRowProps` (~line 281), destructure it, and pass it at both render sites
   (~line 2077 → list, ~line 830 → row).
3. In `SidebarThreadRow`, add `handleTitleDoubleClick` on the title `<span>` (~line 596) that
   `stopPropagation` (so it doesn't trigger row navigation/selection) and calls
   `beginRename(threadRef, thread.title)`. Attach `onDoubleClick={handleTitleDoubleClick}` to the title
   span (the non-editing branch). Do NOT attach it when the input is showing.
4. Existing input handlers (focus/select, Enter commit, Esc cancel, blur commit) are reused unchanged —
   double-click just enters the same edit mode the menu already opens.

### Acceptance criteria
- Double-clicking a thread title in the sidebar replaces it in place with the editable input (focused,
  text selected), without navigating to the thread or toggling selection.
- Enter commits the new title (calls existing `commitRename` → `thread.meta.update`); Esc cancels with no
  change; blur commits (matching current menu-driven behavior).
- The context-menu "Rename thread" action continues to work and now shares the same `beginRename` helper.
- Empty/whitespace title shows the existing "Thread title cannot be empty" warning toast and exits edit
  mode (unchanged `commitRename` behavior).
- `bun fmt`, `bun lint`, `bun typecheck` pass.

---

## Files to create / modify

Create:
- `apps/web/src/sidebarCollapseState.ts` — `useLocalStorage`-backed persisted open/collapsed state hook.

Modify:
- `packages/contracts/src/keybindings.ts` — add `"sidebar.toggle"` to `STATIC_KEYBINDING_COMMANDS`.
- `packages/shared/src/keybindings.ts` — add `{ key: "mod+b", command: "sidebar.toggle" }` to
  `DEFAULT_KEYBINDINGS`.
- `apps/web/src/components/AppSidebarLayout.tsx` — controlled `SidebarProvider` (open/onOpenChange) using
  the persisted state hook.
- `apps/web/src/routes/_chat.tsx` — handle `command === "sidebar.toggle"` via `useSidebar().toggleSidebar`
  in `ChatRouteGlobalShortcuts`.
- `apps/web/src/components/Sidebar.tsx` — add `beginRename` helper, refactor context-menu rename to use it,
  drill it to `SidebarProjectThreadList` and `SidebarThreadRow`, add `onDoubleClick` to the title span.

Docs (optional but consistent with repo conventions):
- `KEYBINDINGS.md` — add `sidebar.toggle` to "Available Commands" and `{ "key": "mod+b",
  "command": "sidebar.toggle" }` to the Defaults block.

Tests (optional per AGENTS.md "tests welcome, not mandatory"):
- Extend `apps/web/src/keybindings.test.ts` / `packages/shared` keybinding tests to assert `mod+b`
  resolves to `sidebar.toggle`. The double-click path is small UI glue over already-tested rename logic.

---

## Risks / watch-outs

- **Two SidebarProviders.** `useSidebar()` resolves to the nearest provider. The toggle handler MUST live
  outside the right diff-panel provider (it does — `ChatRouteGlobalShortcuts` is in `_chat.tsx`, a parent
  of the thread route that mounts the diff provider). Verify Cmd+B never toggles the diff panel.
- **Controlled provider + cookie.** The primitive still writes the `sidebar_state` cookie internally; that
  is harmless. localStorage (via `onOpenChange`) becomes the source of truth read at init. Don't try to
  also read the cookie — avoid two competing persistence layers.
- **Mobile.** On mobile (`isMobile`), `toggleSidebar` flips `openMobile` (a sheet), not `open`. Persisting
  `open` is desktop-relevant; the mobile sheet is ephemeral by design. Acceptable — don't persist mobile.
- **Desktop re-open affordance.** Desktop `SidebarTrigger` is `md:hidden`; after collapse the user re-opens
  via Cmd+B or the `SidebarRail`. If a visible desktop toggle is later wanted, that's a follow-up (out of
  scope here).
- **Double-click vs single-click race.** The title span sits inside the row button; `onDoubleClick` must
  `stopPropagation` to avoid the row's `onClick` navigation firing. Mirror the existing
  `handleRenameInputClick` stopPropagation approach.
- **Keep diffs minimal.** `Sidebar.tsx` is ~124KB; touch only the rename prop chain + double-click handler.
  Do not refactor unrelated rows.
