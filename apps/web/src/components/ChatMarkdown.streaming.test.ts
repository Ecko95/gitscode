import { describe, expect, it } from "vitest";
import {
  createStreamingMarkdownBlockCache,
  getStreamingMarkdownBlocks,
} from "./ChatMarkdown.streaming";

describe("ChatMarkdown streaming blocks", () => {
  it("keeps completed block objects stable when appending to the tail", () => {
    const cache = createStreamingMarkdownBlockCache();
    const first = getStreamingMarkdownBlocks("First paragraph.\n\nSecond", cache);
    const second = getStreamingMarkdownBlocks("First paragraph.\n\nSecond paragraph.", cache);

    expect(second).toHaveLength(2);
    expect(second[0]).toBe(first[0]);
    expect(second[1]).not.toBe(first[1]);
    expect(second[0]?.text).toBe("First paragraph.\n\n");
    expect(second[1]?.text).toBe("Second paragraph.");
  });

  it("holds an open code fence in the tail until the closing fence arrives", () => {
    const cache = createStreamingMarkdownBlockCache();
    const open = getStreamingMarkdownBlocks("Intro.\n\n```ts\nconst a = 1;", cache);
    const closed = getStreamingMarkdownBlocks("Intro.\n\n```ts\nconst a = 1;\n```\nTail", cache);

    expect(open).toHaveLength(2);
    expect(open[0]?.isComplete).toBe(true);
    expect(open[1]?.isComplete).toBe(false);
    expect(open[1]?.text).toBe("```ts\nconst a = 1;");

    expect(closed).toHaveLength(3);
    expect(closed[0]).toBe(open[0]);
    expect(closed[1]?.isComplete).toBe(true);
    expect(closed[1]?.text).toBe("```ts\nconst a = 1;\n```\n");
    expect(closed[2]?.text).toBe("Tail");
  });

  it("keeps indented fences with their containing list block", () => {
    const cache = createStreamingMarkdownBlockCache();
    const blocks = getStreamingMarkdownBlocks("- item\n  ```ts\n  const a = 1;\n  ```\n", cache);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.isComplete).toBe(false);
    expect(blocks[0]?.text).toBe("- item\n  ```ts\n  const a = 1;\n  ```\n");
  });
});
