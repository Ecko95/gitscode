import { describe, expect, it } from "vitest";

import {
  applyPlanPatches,
  exportPlanToMarkdown,
  type PlanComment,
  type PlanContent,
  resolvePlanComment,
  upsertPlanComment,
} from "./visualPlan.ts";

const baseContent: PlanContent = {
  version: 1,
  title: "Auth refactor",
  brief: "Move session minting behind the gateway.",
  blocks: [
    { id: "intro", type: "rich-text", data: { markdown: "Original prose." } },
    {
      id: "tasks",
      type: "checklist",
      data: {
        items: [
          { id: "t1", label: "Wire the route", checked: false },
          { id: "t2", label: "Add the test", checked: false },
        ],
      },
    },
    { id: "note", type: "callout", data: { tone: "risk", body: "Watch the token TTL." } },
  ],
};

const makeComment = (overrides: Partial<PlanComment> = {}): PlanComment => ({
  id: "c1",
  anchor: { blockId: "intro", anchorKind: "block" },
  message: "Please clarify the rollout order.",
  createdBy: "human",
  createdAt: "2026-06-20T10:00:00.000Z",
  updatedAt: "2026-06-20T10:00:00.000Z",
  ...overrides,
});

describe("applyPlanPatches", () => {
  it("updates rich-text markdown in place without touching other blocks", () => {
    const next = applyPlanPatches(baseContent, [
      { op: "update-rich-text", blockId: "intro", markdown: "Edited prose." },
    ]);
    const block = next.blocks.find((b) => b.id === "intro");
    expect(block?.type === "rich-text" && block.data.markdown).toBe("Edited prose.");
    // other blocks untouched
    expect(next.blocks).toHaveLength(3);
    expect(next.blocks[1]?.id).toBe("tasks");
  });

  it("replaces a checklist block (check/add/reorder) via replace-block", () => {
    const next = applyPlanPatches(baseContent, [
      {
        op: "replace-block",
        blockId: "tasks",
        block: {
          id: "tasks",
          type: "checklist",
          data: {
            items: [
              { id: "t2", label: "Add the test", checked: true },
              { id: "t1", label: "Wire the route", checked: true },
              { id: "t3", label: "Ship it", checked: false },
            ],
          },
        },
      },
    ]);
    const block = next.blocks.find((b) => b.id === "tasks");
    expect(block?.type === "checklist" && block.data.items.map((i) => i.id)).toEqual([
      "t2",
      "t1",
      "t3",
    ]);
    expect(block?.type === "checklist" && block.data.items[0]?.checked).toBe(true);
  });

  it("merges callout data via update-block without dropping sibling fields", () => {
    const next = applyPlanPatches(baseContent, [
      { op: "update-block", blockId: "note", patch: { data: { body: "Watch the refresh TTL." } } },
    ]);
    const block = next.blocks.find((b) => b.id === "note");
    expect(block?.type === "callout" && block.data.body).toBe("Watch the refresh TTL.");
    // tone preserved through the shallow data merge
    expect(block?.type === "callout" && block.data.tone).toBe("risk");
  });

  it("appends a block after a named anchor and removes by id", () => {
    const appended = applyPlanPatches(baseContent, [
      {
        op: "append-block",
        afterBlockId: "intro",
        block: { id: "mid", type: "rich-text", data: { markdown: "Inserted." } },
      },
    ]);
    expect(appended.blocks.map((b) => b.id)).toEqual(["intro", "mid", "tasks", "note"]);

    const removed = applyPlanPatches(appended, [{ op: "remove-block", blockId: "mid" }]);
    expect(removed.blocks.map((b) => b.id)).toEqual(["intro", "tasks", "note"]);
  });

  it("sets metadata without clobbering blocks", () => {
    const next = applyPlanPatches(baseContent, [{ op: "set-metadata", title: "Renamed" }]);
    expect(next.title).toBe("Renamed");
    expect(next.brief).toBe(baseContent.brief);
    expect(next.blocks).toHaveLength(3);
  });
});

describe("upsertPlanComment", () => {
  it("appends a new comment", () => {
    const next = upsertPlanComment([], makeComment());
    expect(next).toHaveLength(1);
    expect(next[0]?.id).toBe("c1");
  });

  it("replaces an existing comment by id, preserving position", () => {
    const first = makeComment({ id: "a" });
    const second = makeComment({ id: "b", message: "second" });
    const updated = makeComment({ id: "a", message: "edited" });
    const next = upsertPlanComment([first, second], updated);
    expect(next.map((c) => c.id)).toEqual(["a", "b"]);
    expect(next[0]?.message).toBe("edited");
  });
});

describe("resolvePlanComment", () => {
  it("stamps resolvedAt + updatedAt on the matching comment only", () => {
    const next = resolvePlanComment(
      [makeComment({ id: "a" }), makeComment({ id: "b" })],
      "a",
      "2026-06-20T12:00:00.000Z",
    );
    expect(next[0]?.resolvedAt).toBe("2026-06-20T12:00:00.000Z");
    expect(next[0]?.updatedAt).toBe("2026-06-20T12:00:00.000Z");
    expect(next[1]?.resolvedAt).toBeUndefined();
  });
});

describe("exportPlanToMarkdown", () => {
  it("serializes blocks and only OPEN reviewer comments", () => {
    const md = exportPlanToMarkdown(baseContent, [
      makeComment({ id: "open", message: "Open item", resolutionTarget: "agent" }),
      makeComment({ id: "closed", message: "Closed item", resolvedAt: "2026-06-20T11:00:00.000Z" }),
    ]);
    expect(md).toContain("# Auth refactor");
    expect(md).toContain("Original prose.");
    expect(md).toContain("- [ ] Wire the route");
    expect(md).toContain("## Reviewer comments");
    expect(md).toContain("Open item");
    expect(md).toContain("_(for: agent)_");
    expect(md).not.toContain("Closed item");
  });

  it("omits the reviewer-comments section when none are open", () => {
    const md = exportPlanToMarkdown(baseContent, []);
    expect(md).not.toContain("## Reviewer comments");
  });
});
