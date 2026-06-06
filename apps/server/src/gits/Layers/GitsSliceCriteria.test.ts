import { describe, expect, it } from "@effect/vitest";

import { parseSliceCriteria, renderSliceCriteria } from "./GitsSliceCriteria.ts";

describe("GitsSliceCriteria", () => {
  it("parses title + bullet criteria as authored", () => {
    const md = [
      "# Add input validation",
      "",
      "## Acceptance Criteria",
      "",
      "- endpoint rejects empty body with 400",
      "- malformed JSON returns a typed error",
      "",
      "## Notes",
      "- not a criterion",
    ].join("\n");
    const r = parseSliceCriteria("H1.2", md);
    expect(r.sliceId).toBe("H1.2");
    expect(r.title).toBe("Add input validation");
    expect(r.acceptanceCriteria).toEqual([
      "endpoint rejects empty body with 400",
      "malformed JSON returns a typed error",
    ]);
    expect(r.source).toBe("authored");
  });

  it("treats `*` bullets and case-insensitive heading", () => {
    const md = "# t\n\n## acceptance CRITERIA\n* one\n*   two  ";
    const r = parseSliceCriteria("s", md);
    expect(r.acceptanceCriteria).toEqual(["one", "two"]);
    expect(r.source).toBe("authored");
  });

  it("returns derived (empty) when there is no criteria section", () => {
    const r = parseSliceCriteria("s", "# Just a title\n\nsome prose");
    expect(r.acceptanceCriteria).toEqual([]);
    expect(r.source).toBe("derived");
    expect(r.title).toBe("Just a title");
  });

  it("renders then re-parses to the same criteria (round-trip)", () => {
    const criteria = ["does X", "handles edge case Y"];
    const md = renderSliceCriteria({
      sliceId: "H2.0",
      title: "Slice two",
      acceptanceCriteria: criteria,
    });
    const r = parseSliceCriteria("H2.0", md);
    expect(r.title).toBe("Slice two");
    expect(r.acceptanceCriteria).toEqual(criteria);
    expect(r.source).toBe("authored");
  });

  it("renders the sliceId as heading when no title, and parses empty criteria back as derived", () => {
    const md = renderSliceCriteria({ sliceId: "H3.0", acceptanceCriteria: [] });
    expect(md).toContain("# H3.0");
    const r = parseSliceCriteria("H3.0", md);
    expect(r.acceptanceCriteria).toEqual([]);
    expect(r.source).toBe("derived");
  });
});
