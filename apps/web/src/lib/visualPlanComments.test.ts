import { describe, expect, it } from "vitest";

import {
  buildBlockCommentAnchor,
  buildTextCommentAnchor,
  describeCommentAnchor,
} from "./visualPlanComments.ts";

describe("buildTextCommentAnchor", () => {
  it("captures the quote with surrounding context", () => {
    const anchor = buildTextCommentAnchor({
      blockId: "intro",
      blockType: "rich-text",
      blockText: "We will mint the session token behind the gateway before routing.",
      quote: "session token",
    });
    expect(anchor.anchorKind).toBe("text");
    expect(anchor.textQuote).toBe("session token");
    expect(anchor.blockId).toBe("intro");
    expect(anchor.blockType).toBe("rich-text");
    expect(anchor.contextBefore).toContain("mint the ");
    expect(anchor.contextAfter).toContain(" behind the gateway");
  });

  it("trims the quote and omits empty context at the start", () => {
    const anchor = buildTextCommentAnchor({
      blockId: "b",
      blockText: "Token first, then route.",
      quote: "  Token first  ",
    });
    expect(anchor.textQuote).toBe("Token first");
    expect(anchor.contextBefore).toBeUndefined();
    expect(anchor.contextAfter).toContain(", then route.");
  });

  it("tolerates a quote not found in the block text", () => {
    const anchor = buildTextCommentAnchor({ blockText: "abc", quote: "zzz" });
    expect(anchor.textQuote).toBe("zzz");
    expect(anchor.contextBefore).toBeUndefined();
    expect(anchor.contextAfter).toBeUndefined();
  });
});

describe("buildBlockCommentAnchor", () => {
  it("targets a whole block", () => {
    const anchor = buildBlockCommentAnchor({ id: "tasks", type: "checklist" });
    expect(anchor).toEqual({ blockId: "tasks", blockType: "checklist", anchorKind: "block" });
  });
});

describe("describeCommentAnchor", () => {
  it("prefers a truncated quote", () => {
    expect(describeCommentAnchor({ anchorKind: "text", textQuote: "hello world" })).toBe(
      "“hello world”",
    );
  });
  it("falls back to block then section then general", () => {
    expect(describeCommentAnchor({ blockId: "b1" })).toBe("block b1");
    expect(describeCommentAnchor({ sectionId: "s1" })).toBe("section s1");
    expect(describeCommentAnchor({})).toBe("general");
  });
});
