import type { FileDiffMetadata } from "@pierre/diffs/react";
import { describe, expect, it } from "vitest";

import {
  appendDiffLineReferenceToPrompt,
  buildDiffLineComposerReference,
  resolveDiffLineFilePath,
  resolveDiffLineSnippet,
} from "./diffLineComposerReference";

const fileDiff: FileDiffMetadata = {
  name: "src/new-name.ts",
  prevName: "src/old-name.ts",
  type: "rename-changed",
  isPartial: true,
  splitLineCount: 4,
  unifiedLineCount: 5,
  deletionLines: ["const keep = 1;", "const oldName = true;", "return keep;"],
  additionLines: ["const keep = 1;", "const newName = true;", "return keep;"],
  hunks: [
    {
      collapsedBefore: 0,
      additionStart: 40,
      additionCount: 3,
      additionLines: 3,
      additionLineIndex: 0,
      deletionStart: 10,
      deletionCount: 3,
      deletionLines: 3,
      deletionLineIndex: 0,
      hunkContent: [
        {
          type: "context",
          lines: 1,
          additionLineIndex: 0,
          deletionLineIndex: 0,
        },
        {
          type: "change",
          deletions: 1,
          deletionLineIndex: 1,
          additions: 1,
          additionLineIndex: 1,
        },
        {
          type: "context",
          lines: 1,
          additionLineIndex: 2,
          deletionLineIndex: 2,
        },
      ],
      splitLineStart: 0,
      splitLineCount: 3,
      unifiedLineStart: 0,
      unifiedLineCount: 3,
      noEOFCRDeletions: false,
      noEOFCRAdditions: false,
    },
  ],
};

describe("diffLineComposerReference", () => {
  it("builds compact composer references with normalized snippets", () => {
    expect(
      buildDiffLineComposerReference({
        filePath: "src/new-name.ts",
        lineNumber: 41,
        snippet: "  const   newName = true;  ",
      }),
    ).toBe("In src/new-name.ts:L41: const newName = true;\n");
  });

  it("appends references to existing drafts on a new line", () => {
    expect(appendDiffLineReferenceToPrompt("Existing question", "In src/a.ts:L1\n")).toBe(
      "Existing question\nIn src/a.ts:L1\n",
    );
  });

  it("resolves addition and deletion snippets from hunk metadata", () => {
    expect(resolveDiffLineSnippet(fileDiff, "additions", 41)).toBe("const newName = true;");
    expect(resolveDiffLineSnippet(fileDiff, "deletions", 11)).toBe("const oldName = true;");
  });

  it("uses the previous file name for deleted-side references", () => {
    expect(resolveDiffLineFilePath(fileDiff, "additions")).toBe("src/new-name.ts");
    expect(resolveDiffLineFilePath(fileDiff, "deletions")).toBe("src/old-name.ts");
  });
});
