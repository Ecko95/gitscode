import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { EnvironmentId, OrchestrationVisualPlan, ThreadId } from "@t3tools/contracts";

import VisualPlanPanel from "./VisualPlanPanel";

// The web vitest suite runs under the `node` environment (no jsdom), so we render
// with renderToStaticMarkup, matching the other component tests in this app.
vi.mock("~/gitsClient", () => ({ readGitsEnvironmentClient: vi.fn(() => null) }));

const makePlan = (
  block: OrchestrationVisualPlan["content"]["blocks"][number],
): OrchestrationVisualPlan => ({
  id: "vp1",
  turnId: null,
  content: { version: 1, title: "Plan", blocks: [block] },
  comments: [],
  createdAt: "2026-06-20T00:00:00.000Z",
  updatedAt: "2026-06-20T00:00:00.000Z",
});

describe("VisualPlanPanel diagram rendering", () => {
  it("renders diagram HTML inside a fully sandboxed iframe and strips scripts", () => {
    const markup = renderToStaticMarkup(
      <VisualPlanPanel
        visualPlan={makePlan({
          id: "d1",
          type: "diagram",
          data: {
            html: '<div class="node">box</div><script>window.parent.steal()</script>',
            css: ".node{color:var(--wf-ink)}",
            caption: "Architecture",
          },
        })}
        mode="sidebar"
        onClose={() => undefined}
      />,
    );

    // The iframe is sandboxed with the most restrictive (empty) policy.
    expect(markup).toContain('sandbox=""');
    expect(markup.toLowerCase()).toContain("srcdoc=");
    // The script is stripped before it ever reaches the srcdoc.
    expect(markup).not.toContain("window.parent.steal");
    expect(markup).not.toMatch(/<script/);
    expect(markup).toContain("Architecture");
  });

  it("shows the empty-state when there is no plan", () => {
    const markup = renderToStaticMarkup(
      <VisualPlanPanel visualPlan={null} mode="sidebar" onClose={() => undefined} />,
    );
    expect(markup).toContain("No visual plan yet");
  });

  it("offers comment + send-to-agent affordances only when wired for writes", () => {
    const writable = renderToStaticMarkup(
      <VisualPlanPanel
        visualPlan={makePlan({ id: "c1", type: "callout", data: { tone: "info", body: "hi" } })}
        mode="sidebar"
        onClose={() => undefined}
        threadId={"thread-1" as ThreadId}
        environmentId={"env-1" as EnvironmentId}
        onSendToAgent={() => undefined}
      />,
    );
    expect(writable).toContain("Send plan to agent");
    expect(writable).toContain("Edit plan");

    const readonly = renderToStaticMarkup(
      <VisualPlanPanel
        visualPlan={makePlan({ id: "c1", type: "callout", data: { tone: "info", body: "hi" } })}
        mode="sidebar"
        onClose={() => undefined}
      />,
    );
    expect(readonly).not.toContain("Send plan to agent");
    expect(readonly).not.toContain("Edit plan");
  });
});
