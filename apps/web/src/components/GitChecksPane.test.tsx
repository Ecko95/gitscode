import type { VcsStatusResult } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { GitChecksPane } from "./GitChecksPane";

function status(overrides: Partial<VcsStatusResult> = {}): VcsStatusResult {
  return {
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName: "feature/checks-pane",
    hasWorkingTreeChanges: false,
    workingTree: {
      files: [],
      insertions: 0,
      deletions: 0,
    },
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    pr: {
      number: 42,
      title: "Add checks pane",
      url: "https://github.com/pingdotgg/t3code/pull/42",
      baseRef: "main",
      headRef: "feature/checks-pane",
      state: "open",
    },
    prChecks: {
      summary: {
        passed: 1,
        failed: 1,
        pending: 1,
      },
      checks: [
        { name: "lint", state: "passed", detailUrl: null },
        { name: "test", state: "failed", detailUrl: "https://github.com/checks/2" },
        { name: "deploy", state: "pending", detailUrl: null },
      ],
      mergeable: "conflicting",
      unresolvedReviewThreads: 2,
    },
    ...overrides,
  };
}

describe("GitChecksPane", () => {
  it("renders merge readiness blockers and per-check states", () => {
    const html = renderToStaticMarkup(<GitChecksPane gitStatus={status()} />);

    expect(html).toContain("Blockers flagged");
    expect(html).toContain("1 passed, 1 failed, 1 pending");
    expect(html).toContain("test");
    expect(html).toContain("failed");
    expect(html).toContain("2 unresolved");
    expect(html).toContain("conflicting");
  });

  it("renders nullable provider check data as unavailable", () => {
    const html = renderToStaticMarkup(<GitChecksPane gitStatus={status({ prChecks: null })} />);

    expect(html).toContain("Checks");
    expect(html).toContain("Unavailable");
    expect(html).toContain("No blockers");
  });
});
