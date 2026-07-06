import { fnv1a32 } from "../lib/diffRendering";

export interface StreamingMarkdownBlock {
  key: string;
  contentHash: string;
  text: string;
  isComplete: boolean;
}

export type StreamingMarkdownBlockCache = Map<string, StreamingMarkdownBlock>;

interface RawStreamingMarkdownBlock {
  start: number;
  text: string;
  isComplete: boolean;
}

const FENCE_START_REGEX = /^ {0,3}(`{3,}|~{3,})/;

export function createStreamingMarkdownBlockCache(): StreamingMarkdownBlockCache {
  return new Map();
}

export function getStreamingMarkdownBlocks(
  text: string,
  cache: StreamingMarkdownBlockCache,
): StreamingMarkdownBlock[] {
  const rawBlocks = splitStreamingMarkdownBlocks(text);
  const nextCache: StreamingMarkdownBlockCache = new Map();
  const blocks = rawBlocks.map((block, index) => {
    const contentHash = fnv1a32(block.text).toString(36);
    const cacheKey = `${index}:${block.start}:${contentHash}`;
    const cachedBlock = cache.get(cacheKey);
    if (cachedBlock) {
      nextCache.set(cacheKey, cachedBlock);
      return cachedBlock;
    }

    const nextBlock: StreamingMarkdownBlock = {
      key: `${index}:${block.start}`,
      contentHash,
      text: block.text,
      isComplete: block.isComplete,
    };
    nextCache.set(cacheKey, nextBlock);
    return nextBlock;
  });

  cache.clear();
  for (const [key, block] of nextCache) {
    cache.set(key, block);
  }
  return blocks;
}

function splitStreamingMarkdownBlocks(text: string): RawStreamingMarkdownBlock[] {
  if (text.length === 0) {
    return [];
  }

  const blocks: RawStreamingMarkdownBlock[] = [];
  let blockStart = 0;
  let offset = 0;
  let fenceMarker: "`" | "~" | null = null;
  let fenceLength = 0;
  let splitFenceOnClose = false;

  while (offset < text.length) {
    const lineStart = offset;
    const nextNewline = text.indexOf("\n", offset);
    const lineEnd = nextNewline === -1 ? text.length : nextNewline + 1;
    const line = text.slice(lineStart, lineEnd);
    const lineWithoutNewline = line.endsWith("\n") ? line.slice(0, -1) : line;

    if (fenceMarker) {
      if (isClosingFence(lineWithoutNewline, fenceMarker, fenceLength)) {
        if (splitFenceOnClose) {
          blocks.push({
            start: blockStart,
            text: text.slice(blockStart, lineEnd),
            isComplete: true,
          });
          blockStart = lineEnd;
        }
        fenceMarker = null;
        fenceLength = 0;
        splitFenceOnClose = false;
      }
      offset = lineEnd;
      continue;
    }

    const fenceStart = lineWithoutNewline.match(FENCE_START_REGEX);
    if (fenceStart) {
      const fenceIndent = lineWithoutNewline.length - lineWithoutNewline.trimStart().length;
      splitFenceOnClose = fenceIndent === 0;
      if (splitFenceOnClose && lineStart > blockStart) {
        blocks.push({
          start: blockStart,
          text: text.slice(blockStart, lineStart),
          isComplete: true,
        });
        blockStart = lineStart;
      }
      fenceMarker = fenceStart[1]?.[0] === "~" ? "~" : "`";
      fenceLength = fenceStart[1]?.length ?? 3;
      offset = lineEnd;
      continue;
    }

    if (lineWithoutNewline.trim().length === 0) {
      blocks.push({
        start: blockStart,
        text: text.slice(blockStart, lineEnd),
        isComplete: true,
      });
      blockStart = lineEnd;
    }

    offset = lineEnd;
  }

  if (blockStart < text.length) {
    blocks.push({
      start: blockStart,
      text: text.slice(blockStart),
      isComplete: false,
    });
  }

  return blocks;
}

function isClosingFence(line: string, marker: "`" | "~", minLength: number): boolean {
  const trimmedStart = line.match(/^ {0,3}(`+|~+)/)?.[1];
  return (
    trimmedStart != null &&
    trimmedStart[0] === marker &&
    trimmedStart.length >= minLength &&
    line.slice(line.indexOf(trimmedStart) + trimmedStart.length).trim().length === 0
  );
}
