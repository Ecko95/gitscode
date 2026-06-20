import type { PlanCommentAnchor } from "@t3tools/contracts";

/** Characters of surrounding text captured on each side of a quote anchor. */
export const COMMENT_CONTEXT_CHARS = 48;

export interface TextAnchorInput {
  readonly blockId?: string | undefined;
  readonly blockType?: string | undefined;
  /** Full text content of the anchored block (used to derive context). */
  readonly blockText: string;
  /** The selected substring the reviewer is commenting on. */
  readonly quote: string;
}

/**
 * Build a text-quote anchor from a selection inside a block. The before/after
 * context lets the agent re-locate the quote even if the surrounding prose
 * shifts. Pure — the DOM glue (turning a Range into `quote`) lives in the panel.
 */
export function buildTextCommentAnchor(input: TextAnchorInput): PlanCommentAnchor {
  const quote = input.quote.trim();
  const index = input.blockText.indexOf(quote);
  const before =
    index > 0 ? input.blockText.slice(Math.max(0, index - COMMENT_CONTEXT_CHARS), index) : "";
  const after =
    index >= 0
      ? input.blockText.slice(index + quote.length, index + quote.length + COMMENT_CONTEXT_CHARS)
      : "";
  return {
    ...(input.blockId ? { blockId: input.blockId } : {}),
    ...(input.blockType ? { blockType: input.blockType } : {}),
    anchorKind: "text",
    textQuote: quote,
    ...(before ? { contextBefore: before } : {}),
    ...(after ? { contextAfter: after } : {}),
  };
}

/** Build a whole-block anchor (the reviewer targeted a block, not a quote). */
export function buildBlockCommentAnchor(block: {
  readonly id: string;
  readonly type: string;
}): PlanCommentAnchor {
  return { blockId: block.id, blockType: block.type, anchorKind: "block" };
}

/** Short human label for a comment's anchor (panel comment list). */
export function describeCommentAnchor(anchor: PlanCommentAnchor): string {
  if (anchor.textQuote) {
    const quote =
      anchor.textQuote.length > 40 ? `${anchor.textQuote.slice(0, 39)}…` : anchor.textQuote;
    return `“${quote}”`;
  }
  if (anchor.blockId) {
    return `block ${anchor.blockId}`;
  }
  if (anchor.sectionId) {
    return `section ${anchor.sectionId}`;
  }
  return "general";
}
