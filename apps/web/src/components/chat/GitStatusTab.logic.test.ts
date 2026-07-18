import type { VcsStatusResult } from "@t3tools/contracts";
import { assert, describe, it } from "vitest";

import { resolvePrActions, summarizeGitStatus } from "./GitStatusTab.logic";

function status(overrides: Partial<VcsStatusResult> = {}): VcsStatusResult {
  return {
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName: "feature/test",
    hasWorkingTreeChanges: false,
    workingTree: {
      files: [],
      insertions: 0,
      deletions: 0,
    },
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    pr: null,
    ...overrides,
  };
}

const openPr = {
  number: 12,
  title: "Existing PR",
  url: "https://example.com/pr/12",
  baseRef: "main",
  headRef: "feature/test",
  state: "open",
} as const;

describe("summarizeGitStatus", () => {
  it("is neutral when status is unavailable", () => {
    assert.deepEqual(summarizeGitStatus(null), {
      tone: "neutral",
      branchLabel: "No repository",
      label: "Git status unavailable",
    });
  });

  it("is neutral when the directory is not a repository", () => {
    assert.equal(summarizeGitStatus(status({ isRepo: false })).tone, "neutral");
  });

  it("is ok for a clean branch in sync with upstream", () => {
    assert.deepEqual(summarizeGitStatus(status()), {
      tone: "ok",
      branchLabel: "feature/test",
      label: "feature/test — up to date",
    });
  });

  it("warns on uncommitted changes", () => {
    const summary = summarizeGitStatus(status({ hasWorkingTreeChanges: true }));
    assert.equal(summary.tone, "warning");
    assert.include(summary.label, "uncommitted changes");
  });

  it("warns when ahead of upstream", () => {
    const summary = summarizeGitStatus(status({ aheadCount: 2 }));
    assert.equal(summary.tone, "warning");
    assert.include(summary.label, "2 ahead");
  });

  it("warns when the branch is not pushed", () => {
    const summary = summarizeGitStatus(status({ hasUpstream: false }));
    assert.equal(summary.tone, "warning");
    assert.include(summary.label, "not pushed");
  });

  it("blocks when the branch has diverged", () => {
    const summary = summarizeGitStatus(
      status({ aheadCount: 1, behindCount: 3 }),
    );
    assert.equal(summary.tone, "blocked");
    assert.include(summary.label, "1 ahead / 3 behind");
  });

  it("labels a detached HEAD as a warning", () => {
    const summary = summarizeGitStatus(
      status({ refName: null, hasUpstream: false }),
    );
    assert.equal(summary.tone, "warning");
    assert.equal(summary.branchLabel, "Detached HEAD");
  });

  it("mentions an open PR in the label", () => {
    assert.include(
      summarizeGitStatus(status({ pr: openPr })).label,
      "PR #12 open",
    );
  });
});

describe("resolvePrActions", () => {
  it("returns no actions when status is unavailable", () => {
    assert.deepEqual(resolvePrActions(null, false), {
      createPr: null,
      openPr: null,
      review: null,
    });
  });

  it("offers view and review for an open PR", () => {
    assert.deepEqual(resolvePrActions(status({ pr: openPr }), false), {
      createPr: null,
      openPr: { label: "View PR #12", url: "https://example.com/pr/12" },
      review: { reference: "https://example.com/pr/12" },
    });
  });

  it("offers create PR for a clean branch ahead of the default branch", () => {
    const actions = resolvePrActions(status({ aheadCount: 2 }), false);
    assert.deepEqual(actions.createPr, { label: "Create PR" });
    assert.isNull(actions.openPr);
    assert.isNull(actions.review);
  });

  it("uses aheadOfDefaultCount when the branch is pushed but ahead of default", () => {
    const actions = resolvePrActions(
      status({ aheadCount: 0, aheadOfDefaultCount: 3 }),
      false,
    );
    assert.isNotNull(actions.createPr);
  });

  it("does not offer create PR while busy", () => {
    assert.isNull(resolvePrActions(status({ aheadCount: 2 }), true).createPr);
  });

  it("does not offer create PR with uncommitted changes", () => {
    assert.isNull(
      resolvePrActions(
        status({ aheadCount: 2, hasWorkingTreeChanges: true }),
        false,
      ).createPr,
    );
  });

  it("does not offer create PR on the default ref", () => {
    assert.isNull(
      resolvePrActions(status({ aheadCount: 2, isDefaultRef: true }), false)
        .createPr,
    );
  });

  it("does not offer create PR when behind upstream", () => {
    assert.isNull(
      resolvePrActions(status({ aheadCount: 2, behindCount: 1 }), false)
        .createPr,
    );
  });

  it("does not offer create PR without a primary remote", () => {
    assert.isNull(
      resolvePrActions(
        status({ aheadCount: 2, hasPrimaryRemote: false }),
        false,
      ).createPr,
    );
  });

  it("links a merged PR but allows creating a new one when ahead of default", () => {
    const actions = resolvePrActions(
      status({ pr: { ...openPr, state: "merged" }, aheadOfDefaultCount: 1 }),
      false,
    );
    assert.deepEqual(actions.openPr, {
      label: "View PR #12",
      url: "https://example.com/pr/12",
    });
    assert.isNull(actions.review);
    assert.isNotNull(actions.createPr);
  });
});
