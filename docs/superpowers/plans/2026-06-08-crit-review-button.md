# Crit Review Button Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an explicit "Crit review" button next to "View diff" on the changed-files card that opens the right panel in Crit mode, replacing today's silent auto-swap of the diff panel.

**Architecture:** The right diff panel's mode is driven by the existing `?diff` route search param. Today `?diff=1` opens the native diff and Crit auto-replaces it when a flag+PR condition holds. We extend the param to `?diff=crit`, drive the panel from it (`critMode = search.diff === "crit"`), remove the auto-swap, add a gated "Crit review" button that navigates to `?diff=crit`, and give the Crit panel a graceful inline "unavailable" state (because no crit binary is deployed yet).

**Tech Stack:** React, TanStack Router (`useNavigate` + route search params), Vitest (`apps/web` config with the `~` alias), TailwindCSS, the existing `Button` component.

**Repo gotchas (MUST follow):**

- Prefix shell with `PATH="$HOME/.local/bin:$PATH" rtk …`. Format only changed files: `rtk npx oxfmt <paths>` (NEVER `bun fmt`).
- **Web tests run from inside `apps/web`:** `cd apps/web && ../../node_modules/.bin/vitest run src/<path>` (the root config lacks the `~` → `apps/web/src` alias).
- **Web typecheck:** `cd apps/web && bun run typecheck` (NOT `./node_modules/.bin/tsgo`, which does not exist and silently exits 0). Grep for your own files.
- Stage only your explicit files (`git add <paths>`, never `.`); the working tree carries other agents' WIP.
- Code style: tabs, double quotes, semicolons, ~160 cols; match each file's local idiom.

---

## File Structure

- **Modify** `apps/web/src/diffRouteSearch.ts` — extend the `diff` param to accept `"crit"`.
- **Test** `apps/web/src/diffRouteSearch.test.ts` (create) — unit tests for the parser.
- **Modify** `apps/web/src/routes/_chat.$environmentId.$threadId.tsx` — derive `panelOpen`/`critMode` from the param, drop the auto-swap, add `openCritReview`, update the `critPanel` render + `DiffPanelInlineSidebar`.
- **Modify** `apps/web/src/components/CritReviewPanel.tsx` — replace the silent `onUnavailable` revert with an inline "unavailable" state + an `onSwitchToNativeDiff` prop.
- **Test** `apps/web/src/components/CritReviewPanel.test.tsx` (extend) — assert the unavailable state renders the fallback action.
- **Modify** `apps/web/src/components/chat/MessagesTimeline.tsx` — thread `critReviewAvailable` + `onOpenCritReview` through props + `TimelineRowCtx`, render the gated "Crit review" button beside "View diff".
- **Modify** `apps/web/src/components/ChatView.tsx` — read `critReviewEnabled` + PR status, define `onOpenCritReview`, pass both new values to `MessagesTimeline`.

---

## Task 1: Extend the `diff` search param to support `"crit"`

**Files:**

- Modify: `apps/web/src/diffRouteSearch.ts`
- Test: `apps/web/src/diffRouteSearch.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/diffRouteSearch.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { parseDiffRouteSearch, stripDiffSearchParams } from "./diffRouteSearch";

describe("parseDiffRouteSearch", () => {
  it("parses the native diff value", () => {
    expect(parseDiffRouteSearch({ diff: "1" }).diff).toBe("1");
  });

  it("parses the crit value", () => {
    expect(parseDiffRouteSearch({ diff: "crit" }).diff).toBe("crit");
  });

  it("drops unknown diff values", () => {
    expect(parseDiffRouteSearch({ diff: "bogus" }).diff).toBeUndefined();
  });

  it("keeps diffTurnId/diffFilePath for native diff but not for crit", () => {
    const native = parseDiffRouteSearch({ diff: "1", diffTurnId: "turn-1", diffFilePath: "a.ts" });
    expect(native.diffTurnId).toBe("turn-1");
    expect(native.diffFilePath).toBe("a.ts");
    const crit = parseDiffRouteSearch({ diff: "crit", diffTurnId: "turn-1", diffFilePath: "a.ts" });
    expect(crit.diffTurnId).toBeUndefined();
    expect(crit.diffFilePath).toBeUndefined();
  });

  it("strips all diff params", () => {
    expect(stripDiffSearchParams({ diff: "crit", other: "keep" })).toEqual({ other: "keep" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && ../../node_modules/.bin/vitest run src/diffRouteSearch.test.ts`
Expected: FAIL — the `"crit"` case returns `undefined` (parser only handles `"1"`).

- [ ] **Step 3: Implement the parser change**

In `apps/web/src/diffRouteSearch.ts`, replace the interface and the `diff` derivation:

```ts
export interface DiffRouteSearch {
  diff?: "1" | "crit" | undefined;
  diffTurnId?: TurnId | undefined;
  diffFilePath?: string | undefined;
}
```

Then in `parseDiffRouteSearch`, replace the first three lines of the body:

```ts
const diff = isDiffOpenValue(search.diff) ? "1" : search.diff === "crit" ? "crit" : undefined;
// diffTurnId/diffFilePath only apply to the native per-turn diff, not crit.
const diffTurnIdRaw = diff === "1" ? normalizeSearchString(search.diffTurnId) : undefined;
const diffTurnId = diffTurnIdRaw ? TurnId.make(diffTurnIdRaw) : undefined;
const diffFilePath =
  diff === "1" && diffTurnId ? normalizeSearchString(search.diffFilePath) : undefined;
```

(`stripDiffSearchParams` is unchanged — it already strips `diff`/`diffTurnId`/`diffFilePath`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && ../../node_modules/.bin/vitest run src/diffRouteSearch.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Typecheck + format + commit**

```bash
cd apps/web && bun run typecheck 2>&1 | grep -E "diffRouteSearch"   # expect empty
cd /home/joshua/dev/projects/gitscode
PATH="$HOME/.local/bin:$PATH" rtk npx oxfmt apps/web/src/diffRouteSearch.ts apps/web/src/diffRouteSearch.test.ts
git add apps/web/src/diffRouteSearch.ts apps/web/src/diffRouteSearch.test.ts
git commit -m "feat(web): support diff=crit route search value"
```

---

## Task 2: Drive the panel from the param + add `openCritReview` (route)

**Files:**

- Modify: `apps/web/src/routes/_chat.$environmentId.$threadId.tsx`

Context: `diffOpen` is derived at line 179 (`search.diff === "1"`). The auto-swap lives at lines ~181–227 (`critReviewEnabled`, `critReviewDisabled`, `shouldUseCritReview`, `critPanel`). `openDiff`/`closeDiff` are at lines ~249–272. `DiffPanelInlineSidebar` (lines 60–148) renders `renderDiffContent ? (critPanel ?? <LazyDiffPanel mode="sidebar" />) : null` at line 143.

- [ ] **Step 1: Replace the panel-open + crit-mode derivation**

Replace line 179 (`const diffOpen = search.diff === "1";`) with:

```ts
const critMode = search.diff === "crit";
const diffOpen = search.diff === "1" || critMode;
```

- [ ] **Step 2: Remove the auto-swap; compute `critPanel` from the mode**

Replace the whole block from `// Crit PR review (off by default …` (≈line 181) through the `const critPanel = … : null;` assignment (≈line 227) with:

```ts
	// Crit PR review panel content. The panel mode is explicit (driven by
	// `?diff=crit`, set by the "Crit review" button); there is no auto-swap.
	const activeProjectId = serverThread?.projectId ?? null;
	const activeProject = useStore((store) =>
		threadRef && activeProjectId
			? selectProjectByRef(store, {
					environmentId: threadRef.environmentId,
					projectId: activeProjectId,
				})
			: undefined,
	);
	const activeWorkspaceRoot = serverThread?.worktreePath ?? activeProject?.cwd ?? null;
	const gitStatus = useVcsStatus({
		environmentId: threadRef?.environmentId ?? null,
		cwd: activeWorkspaceRoot,
	}).data;
	const activeBranch = gitStatus?.refName ?? null;
	const switchToNativeDiff = useCallback(() => {
		if (!threadRef) {
			return;
		}
		void navigate({
			to: "/$environmentId/$threadId",
			params: buildThreadRouteParams(threadRef),
			search: (previous) => {
				const rest = stripDiffSearchParams(previous);
				return { ...rest, diff: "1" };
			},
		});
	}, [navigate, threadRef]);
	const critPanel =
		critMode && threadRef && activeWorkspaceRoot && activeBranch ? (
			<CritReviewPanel
				environmentId={threadRef.environmentId}
				workspaceRoot={activeWorkspaceRoot}
				branch={activeBranch}
				threadId={threadRef.threadId}
				onSwitchToNativeDiff={switchToNativeDiff}
			/>
		) : null;
```

This deletes `critReviewEnabled`, `critReviewDisabled`, `disableCritReview`, the re-arm `useEffect`, `activePullRequest`, `shouldUseCritReview`, and the old `onUnavailable` wiring (availability now gates the button in Task 4/5, not the panel; failure handling moves into `CritReviewPanel` in Task 3). Keep the existing `activeProjectId`/`activeProject`/`activeWorkspaceRoot`/`gitStatus`/`activeBranch` lines only once — if they already exist below the deleted block, do not duplicate them; move this single copy above first use.

- [ ] **Step 3: Verify the sidebar renders crit in crit mode, native otherwise**

No change needed at line 143 — `renderDiffContent ? (critPanel ?? <LazyDiffPanel mode="sidebar" />) : null` already renders `critPanel` when non-null (crit mode) and falls back to the native `LazyDiffPanel` when `critPanel` is null (native mode). Confirm `DiffPanelInlineSidebar` still receives `critPanel={critPanel}` at its call sites (the inline branch ~line 309 and the sheet branch ~line 330); leave those props as-is.

- [ ] **Step 4: Typecheck**

Run: `cd apps/web && bun run typecheck 2>&1 | grep -E "_chat\.\\\$environmentId"`
Expected: empty (no errors in this route file). If `useVcsStatus`/`useSettings`/`selectProjectByRef` imports were only used by deleted code, remove now-unused imports until clean.

- [ ] **Step 5: Format + commit**

```bash
cd /home/joshua/dev/projects/gitscode
PATH="$HOME/.local/bin:$PATH" rtk npx oxfmt "apps/web/src/routes/_chat.\$environmentId.\$threadId.tsx"
git add "apps/web/src/routes/_chat.\$environmentId.\$threadId.tsx"
git commit -m "feat(web): drive review panel from diff=crit, remove crit auto-swap"
```

---

## Task 3: CritReviewPanel inline "unavailable" state

**Files:**

- Modify: `apps/web/src/components/CritReviewPanel.tsx`
- Test: `apps/web/src/components/CritReviewPanel.test.tsx`

- [ ] **Step 1: Write the failing test**

Read the existing `CritReviewPanel.test.tsx` first to reuse its render/mocking harness for `readEnvironmentApi`. Add a test that makes `crit.ensureSidecar` reject (or return `status: "crashed"`) and asserts the panel shows the unavailable copy and a "View native diff" button that calls `onSwitchToNativeDiff`:

```tsx
it("shows an unavailable state with a native-diff fallback when the sidecar fails", async () => {
  const onSwitchToNativeDiff = vi.fn();
  // Arrange the mocked environment api so crit.ensureSidecar rejects.
  // (Mirror the existing test's readEnvironmentApi mock; make ensureSidecar throw.)
  render(
    <CritReviewPanel
      environmentId={"env-1" as EnvironmentId}
      workspaceRoot="/repo"
      branch="feature"
      threadId={"thread-1" as ThreadId}
      onSwitchToNativeDiff={onSwitchToNativeDiff}
    />,
  );
  const fallback = await screen.findByRole("button", { name: /native diff/i });
  fallback.click();
  expect(onSwitchToNativeDiff).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && ../../node_modules/.bin/vitest run src/components/CritReviewPanel.test.tsx`
Expected: FAIL — `onSwitchToNativeDiff` is not a prop and no fallback button renders.

- [ ] **Step 3: Implement the unavailable state**

In `CritReviewPanel.tsx`: replace the `onUnavailable: () => void` prop with `onSwitchToNativeDiff: () => void`. Add an `"unavailable"` status. On `ensureSidecar` reject or a `crashed`/`stopped` result, set `setReviewState({ status: "unavailable", url: null })` instead of calling `onUnavailable`. Render, when `reviewState.status === "unavailable"`:

```tsx
<DiffPanelShell mode={CRIT_REVIEW_PANEL_MODE} header={null}>
  <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center text-sm text-muted-foreground">
    <p>Crit review is unavailable for this thread.</p>
    <Button type="button" size="sm" variant="outline" onClick={onSwitchToNativeDiff}>
      View native diff
    </Button>
  </div>
</DiffPanelShell>
```

(Import `Button` from the same path `MessagesTimeline.tsx` uses; keep the `starting` → `DiffPanelLoadingState` and `ready` → iframe branches.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && ../../node_modules/.bin/vitest run src/components/CritReviewPanel.test.tsx`
Expected: PASS (existing test + new test). Update the existing test if it passed `onUnavailable`.

- [ ] **Step 5: Typecheck + format + commit**

```bash
cd apps/web && bun run typecheck 2>&1 | grep -E "CritReviewPanel"   # expect empty
cd /home/joshua/dev/projects/gitscode
PATH="$HOME/.local/bin:$PATH" rtk npx oxfmt apps/web/src/components/CritReviewPanel.tsx apps/web/src/components/CritReviewPanel.test.tsx
git add apps/web/src/components/CritReviewPanel.tsx apps/web/src/components/CritReviewPanel.test.tsx
git commit -m "feat(web): CritReviewPanel inline unavailable state with native-diff fallback"
```

---

## Task 4: "Crit review" button in the changed-files card

**Files:**

- Modify: `apps/web/src/components/chat/MessagesTimeline.tsx`

Context: `TimelineRowSharedState` (interface ~line 88, carries `onOpenTurnDiff` at line 99) is the context value (`TimelineRowCtx`, line 107) consumed by the changed-files card. The card's "View diff" button is at lines 727–734. `MessagesTimelineProps` (line 117) carries `onOpenTurnDiff` (line 128); the `sharedState` object is assembled around lines 233–245.

- [ ] **Step 1: Add the two values to the props + context types**

In `MessagesTimelineProps` (after `onOpenTurnDiff`, line 128) add:

```ts
	critReviewAvailable: boolean;
	onOpenCritReview: () => void;
```

In `TimelineRowSharedState` (after `onOpenTurnDiff`, line 99) add the same two fields.

- [ ] **Step 2: Destructure + thread into the shared state**

In the `MessagesTimeline` destructure (around line 157) add `critReviewAvailable,` and `onOpenCritReview,`. In the `sharedState` object (around lines 233–245) add `critReviewAvailable,` and `onOpenCritReview,` alongside `onOpenTurnDiff`.

- [ ] **Step 3: Render the gated button beside "View diff"**

In the card's button row (immediately after the "View diff" `Button` closing tag, line 734), read the context where the row renders (the card component uses `use(TimelineRowCtx)`; add `const { critReviewAvailable, onOpenCritReview } = use(TimelineRowCtx);` near the existing `onOpenTurnDiff` access in that component) and add:

```tsx
{
  critReviewAvailable ? (
    <Button type="button" size="xs" variant="outline" onClick={onOpenCritReview}>
      Crit review
    </Button>
  ) : null;
}
```

- [ ] **Step 4: Typecheck**

Run: `cd apps/web && bun run typecheck 2>&1 | grep -E "MessagesTimeline"`
Expected: errors in `ChatView.tsx` ONLY about the missing `critReviewAvailable`/`onOpenCritReview` props on `<MessagesTimeline>` (fixed in Task 5). `MessagesTimeline.tsx` itself should be error-free.

- [ ] **Step 5: Format + commit**

```bash
cd /home/joshua/dev/projects/gitscode
PATH="$HOME/.local/bin:$PATH" rtk npx oxfmt apps/web/src/components/chat/MessagesTimeline.tsx
git add apps/web/src/components/chat/MessagesTimeline.tsx
git commit -m "feat(web): add gated Crit review button to changed-files card"
```

---

## Task 5: Wire flag + PR + navigation in ChatView

**Files:**

- Modify: `apps/web/src/components/ChatView.tsx`

Context: `useVcsStatus` is imported (line 43), `useSettings` (line 123). `onOpenTurnDiff` (lines 3713–3734) is the template for `onOpenCritReview` (same `navigate` + `stripDiffSearchParams`). `<MessagesTimeline … onOpenTurnDiff={onOpenTurnDiff} />` is rendered around line 3824. ChatView already has `environmentId`, `threadId`, `isServerThread`, `navigate`, and a `workspaceRoot` value (passed to `MessagesTimeline`).

- [ ] **Step 1: Compute availability + the callback (mirror `onOpenTurnDiff`)**

Near `onOpenTurnDiff` (after line 3734) add:

```ts
const critReviewEnabled = useSettings((settings) => settings.critReviewEnabled);
const critVcsStatus = useVcsStatus({
  environmentId,
  cwd: workspaceRoot ?? null,
}).data;
const critReviewAvailable =
  critReviewEnabled &&
  isServerThread &&
  Boolean(workspaceRoot) &&
  critVcsStatus?.pr != null &&
  Boolean(critVcsStatus?.refName);
const onOpenCritReview = useCallback(() => {
  if (!isServerThread) {
    return;
  }
  onDiffPanelOpen?.();
  void navigate({
    to: "/$environmentId/$threadId",
    params: { environmentId, threadId },
    search: (previous) => {
      const rest = stripDiffSearchParams(previous);
      return { ...rest, diff: "crit" };
    },
  });
}, [environmentId, isServerThread, navigate, onDiffPanelOpen, threadId]);
```

Use the exact local variable name ChatView already uses for the workspace root (grep `workspaceRoot` in ChatView; reuse it — do not introduce a new source). If `useSettings`/`useVcsStatus` are not yet called in this scope, the imports already exist (lines 43, 123).

- [ ] **Step 2: Pass the two new props to MessagesTimeline**

At the `<MessagesTimeline … />` render (≈line 3824), add:

```tsx
critReviewAvailable = { critReviewAvailable };
onOpenCritReview = { onOpenCritReview };
```

- [ ] **Step 3: Typecheck the web app end-to-end**

Run: `cd apps/web && bun run typecheck 2>&1 | grep -E "ChatView|MessagesTimeline|_chat\.\\\$|CritReviewPanel|diffRouteSearch"`
Expected: empty (all crit-touched web files clean). Investigate any hit; do not ignore.

- [ ] **Step 4: Run the crit-related web tests**

Run:

```bash
cd apps/web && ../../node_modules/.bin/vitest run src/diffRouteSearch.test.ts src/components/CritReviewPanel.test.tsx
```

Expected: PASS (Task 1 + Task 3 suites).

- [ ] **Step 5: Format + commit**

```bash
cd /home/joshua/dev/projects/gitscode
PATH="$HOME/.local/bin:$PATH" rtk npx oxfmt apps/web/src/components/ChatView.tsx
git add apps/web/src/components/ChatView.tsx
git commit -m "feat(web): wire Crit review button availability and navigation in ChatView"
```

---

## Task 6: Verification & manual check

**Files:** none (verification only)

- [ ] **Step 1: Full web typecheck for touched files**

Run: `cd apps/web && bun run typecheck 2>&1 | grep -E "diffRouteSearch|_chat\.\\\$|CritReviewPanel|MessagesTimeline|ChatView"`
Expected: empty.

- [ ] **Step 2: Run all crit/diff web tests**

Run: `cd apps/web && ../../node_modules/.bin/vitest run src/diffRouteSearch.test.ts src/components/CritReviewPanel.test.tsx`
Expected: PASS.

- [ ] **Step 3: Manual smoke (documented expectation)**

With `critReviewEnabled` ON and a thread whose branch has an open PR: the changed-files card shows **[Collapse all] [View diff] [Crit review]**. Clicking **Crit review** sets `?diff=crit` and opens the panel; since no crit binary is deployed, the panel shows **"Crit review is unavailable"** + **[View native diff]**, and clicking that returns to `?diff=1` (native diff). With the flag OFF or no open PR, the **Crit review** button is absent. This manual check is expected to surface the "unavailable" state until track #2 (real crit binary) lands.

- [ ] **Step 4: Final commit (if any formatting/cleanup remains)**

```bash
cd /home/joshua/dev/projects/gitscode
git status --short   # confirm only crit-button files are staged/changed
```

---

## Notes / non-goals

- Server-side and the crit binary are **out of scope** (track #2). The button is intentionally inert (shows the unavailable state) until a `crit` binary exists.
- No panel-header `Native | Crit` toggle (we chose the sibling button).
- The button appears on each turn's changed-files card (mirrors "View diff"); it always opens the thread's Crit panel.
