import { describe, expect, it } from "vitest";
import type { PlanContent } from "@t3tools/contracts";
import { applyPlanPatches, buildBlockCatalog, exportPlanToMarkdown } from "./visualPlanModel.ts";

const baseContent: PlanContent = {
  version: 1,
  title: "Add login",
  brief: "Wire up auth",
  blocks: [
    { id: "b1", type: "rich-text", data: { markdown: "Outcome: users can log in." } },
    {
      id: "b2",
      type: "checklist",
      title: "Steps",
      data: {
        items: [
          { id: "s1", label: "Add form", checked: true },
          { id: "s2", label: "Wire API" },
        ],
      },
    },
  ],
};

describe("applyPlanPatches", () => {
  it("set-metadata replaces title/brief", () => {
    const next = applyPlanPatches(baseContent, [{ op: "set-metadata", title: "Renamed" }]);
    expect(next.title).toBe("Renamed");
    expect(next.brief).toBe("Wire up auth");
  });

  it("update-rich-text edits the markdown of the targeted block only", () => {
    const next = applyPlanPatches(baseContent, [
      { op: "update-rich-text", blockId: "b1", markdown: "New outcome." },
    ]);
    const block = next.blocks.find((b) => b.id === "b1");
    expect(block?.type).toBe("rich-text");
    expect(block?.type === "rich-text" && block.data.markdown).toBe("New outcome.");
    expect(next.blocks[1]).toBe(baseContent.blocks[1]);
  });

  it("append-block inserts after the given block", () => {
    const next = applyPlanPatches(baseContent, [
      {
        op: "append-block",
        afterBlockId: "b1",
        block: { id: "b3", type: "rich-text", data: { markdown: "inserted" } },
      },
    ]);
    expect(next.blocks.map((b) => b.id)).toEqual(["b1", "b3", "b2"]);
  });

  it("remove-block drops the block", () => {
    const next = applyPlanPatches(baseContent, [{ op: "remove-block", blockId: "b2" }]);
    expect(next.blocks.map((b) => b.id)).toEqual(["b1"]);
  });
});

describe("exportPlanToMarkdown", () => {
  it("renders title, brief, and blocks", () => {
    const md = exportPlanToMarkdown(baseContent, []);
    expect(md).toContain("# Add login");
    expect(md).toContain("Wire up auth");
    expect(md).toContain("Outcome: users can log in.");
    expect(md).toContain("- [x] Add form");
    expect(md).toContain("- [ ] Wire API");
  });

  it("appends open reviewer comments", () => {
    const md = exportPlanToMarkdown(baseContent, [
      {
        id: "c1",
        anchor: { textQuote: "users can log in" },
        message: "clarify SSO",
        createdBy: "human",
        resolutionTarget: "agent",
        createdAt: "2026-06-20T00:00:00.000Z",
        updatedAt: "2026-06-20T00:00:00.000Z",
      },
    ]);
    expect(md).toContain("## Reviewer comments");
    expect(md).toContain("clarify SSO");
  });
});

describe("buildBlockCatalog", () => {
  it("includes the v1 block types", () => {
    const catalog = buildBlockCatalog();
    expect(catalog.blockTypes).toContain("rich-text");
    expect(catalog.blockTypes).toContain("question-form");
  });
});
