import { describe, expect, it } from "vitest";
import { build_review_comment_block } from "./review-comment-block.ts";

// Inline regexes mirroring apps/web/src/reviewCommentContext.ts to avoid cross-package project-boundary issues.
const REVIEW_COMMENT_BLOCK_PATTERN = /<review_comment\b([^>]*)>\s*([\s\S]*?)<\/review_comment>/g;
const REVIEW_COMMENT_ATTRIBUTE_PATTERN = /([a-zA-Z][a-zA-Z0-9_-]*)="([^"]*)"/g;

describe("build_review_comment_block", () => {
  it("emits attributes and a diff fence the web parser can read", () => {
    const block = build_review_comment_block({
      filePath: "src/app.ts",
      sectionId: "sec-1",
      sectionTitle: 'A & B "x" <y>',
      rangeLabel: "lines",
      startIndex: 10,
      endIndex: 12,
      text: 'Avoid the "any" cast here',
      diff: "@@ -10,3 +10,3 @@\n-old\n+new",
    });

    // Attributes must be HTML-escaped so the parser can read them.
    expect(block).toContain("&amp;");
    expect(block).toContain("&quot;");
    // '<' must NOT be escaped — &lt; contains '>' which truncates the parser's [^>]* regex.
    expect(block).toContain("<y>");

    // Body must be raw — the web parser extracts it without unescaping.
    expect(block).toContain('Avoid the "any" cast here');

    expect(block).toContain('startIndex="10"');
    expect(block).toContain('endIndex="12"');
    expect(block).toContain('filePath="src/app.ts"');
    expect(block).toContain('sectionId="sec-1"');
    expect(block).toContain("```diff");
    expect(block.startsWith("<review_comment")).toBe(true);
    expect(block.trimEnd().endsWith("</review_comment>")).toBe(true);
  });

  it("orders startIndex/endIndex low-to-high", () => {
    const block = build_review_comment_block({
      filePath: "a.ts",
      sectionId: "s",
      sectionTitle: "Review",
      rangeLabel: "line",
      startIndex: 9,
      endIndex: 4,
      text: "x",
      diff: "",
    });
    expect(block).toContain('startIndex="4"');
    expect(block).toContain('endIndex="9"');
  });

  it("round-trips through the web parser regex patterns", () => {
    const block = build_review_comment_block({
      filePath: "src/app.ts",
      sectionId: "sec-1",
      sectionTitle: "Review",
      rangeLabel: "lines",
      startIndex: 10,
      endIndex: 12,
      text: "comment body",
      diff: "@@ -10,1 +10,1 @@\n-a\n+b",
    });

    // Verify the block matches the outer block pattern used by the web parser.
    const block_matches = [...block.matchAll(REVIEW_COMMENT_BLOCK_PATTERN)];
    expect(block_matches).toHaveLength(1);

    // Verify the attribute pattern extracts the required fields.
    const raw_attributes = block_matches[0]![1]!;
    const attr_matches = [...raw_attributes.matchAll(REVIEW_COMMENT_ATTRIBUTE_PATTERN)];
    const attributes: Record<string, string> = {};
    for (const m of attr_matches) {
      attributes[m[1]!] = m[2]!;
    }

    expect(attributes.filePath).toBe("src/app.ts");
    expect(attributes.startIndex).toBe("10");
    expect(attributes.endIndex).toBe("12");
    expect(attributes.sectionId).toBe("sec-1");
  });

  it("keeps required attributes parseable when an attribute value contains '<'", () => {
    const block = build_review_comment_block({
      filePath: "src/app.ts",
      sectionId: "sec-1",
      sectionTitle: "A <tag> here",
      rangeLabel: "lines",
      startIndex: 3,
      endIndex: 5,
      text: "body",
      diff: "",
    });
    const BLOCK = /<review_comment\b([^>]*)>\s*([\s\S]*?)<\/review_comment>/g;
    const ATTR = /([a-zA-Z][a-zA-Z0-9_-]*)="([^"]*)"/g;
    const match = [...block.matchAll(BLOCK)][0];
    expect(match).toBeDefined();
    const attrs: Record<string, string> = {};
    for (const a of (match![1] ?? "").matchAll(ATTR)) {
      attrs[a[1]!] = a[2]!;
    }
    expect(attrs.filePath).toBe("src/app.ts");
    expect(attrs.sectionId).toBe("sec-1");
    expect(attrs.startIndex).toBe("3");
    expect(attrs.endIndex).toBe("5");
  });
});
