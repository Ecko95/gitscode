import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { CritReviewPanel } from "./CritReviewPanel";

// NOTE: the web vitest suite runs under the `node` environment (no jsdom), so we
// render with `renderToStaticMarkup`, matching the other component tests in this
// app. That only exercises the synchronous render path — effects (the
// crit.ensureSidecar call that flips the panel to its iframe) do not run here.
// The ready -> iframe transition is left to manual/integration verification.
describe("CritReviewPanel", () => {
  it("renders the starting/loading state on first render", () => {
    const markup = renderToStaticMarkup(
      <CritReviewPanel
        environmentId={"env-1" as EnvironmentId}
        workspaceRoot="/tmp/workspace"
        branch="feature/crit"
        threadId={"thread-1" as ThreadId}
        onUnavailable={() => undefined}
      />,
    );

    expect(markup).toContain("Starting crit review");
    expect(markup).not.toContain("<iframe");
  });
});
