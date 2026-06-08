import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { CritReviewPanel } from "./CritReviewPanel";

// NOTE: the web vitest suite runs under the `node` environment (no jsdom), so we
// render with `renderToStaticMarkup`, matching the other component tests in this
// app. That only exercises the synchronous render path — effects (the
// crit.ensureSidecar call that flips the panel to its iframe) do not run here.
// The ready -> iframe transition is left to manual/integration verification.
//
// To test the unavailable state without jsdom, we pass the optional
// __testInitialStatus prop which overrides the initial useState value so
// renderToStaticMarkup can exercise that render branch directly.

vi.mock("~/environmentApi", () => ({
  readEnvironmentApi: vi.fn(() => ({
    crit: {
      ensureSidecar: vi.fn(() => Promise.reject(new Error("sidecar unavailable"))),
      releaseSidecar: vi.fn(() => Promise.resolve()),
    },
  })),
}));

describe("CritReviewPanel", () => {
  it("renders the starting/loading state on first render", () => {
    const markup = renderToStaticMarkup(
      <CritReviewPanel
        environmentId={"env-1" as EnvironmentId}
        workspaceRoot="/tmp/workspace"
        branch="feature/crit"
        threadId={"thread-1" as ThreadId}
        onSwitchToNativeDiff={() => undefined}
      />,
    );

    expect(markup).toContain("Starting crit review");
    expect(markup).not.toContain("<iframe");
  });

  it("shows an unavailable state with a native-diff fallback when the sidecar fails", () => {
    const onSwitchToNativeDiff = vi.fn();
    // Use __testInitialStatus to seed the unavailable state synchronously so
    // renderToStaticMarkup (which does not run effects) can exercise this branch.
    const markup = renderToStaticMarkup(
      <CritReviewPanel
        environmentId={"env-1" as EnvironmentId}
        workspaceRoot="/repo"
        branch="feature"
        threadId={"thread-1" as ThreadId}
        onSwitchToNativeDiff={onSwitchToNativeDiff}
        __testInitialStatus="unavailable"
      />,
    );

    expect(markup).toContain("View native diff");
    expect(markup).toContain("unavailable");
  });
});
