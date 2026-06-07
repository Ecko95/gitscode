export interface ReviewCommentBlockInput {
  readonly filePath: string;
  readonly sectionId: string;
  readonly sectionTitle: string;
  readonly rangeLabel: string;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly text: string;
  readonly diff: string;
}

function escape_attribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

export function build_review_comment_block(input: ReviewCommentBlockInput): string {
  const start = Math.min(input.startIndex, input.endIndex);
  const end = Math.max(input.startIndex, input.endIndex);
  const attributes = [
    `startIndex="${start}"`,
    `endIndex="${end}"`,
    `filePath="${escape_attribute(input.filePath)}"`,
    `sectionId="${escape_attribute(input.sectionId)}"`,
    `sectionTitle="${escape_attribute(input.sectionTitle)}"`,
    `rangeLabel="${escape_attribute(input.rangeLabel)}"`,
  ].join(" ");

  const body_parts = [input.text.trim()];
  const diff = input.diff.trim();
  if (diff.length > 0) {
    body_parts.push(["```diff", diff, "```"].join("\n"));
  }

  return `<review_comment ${attributes}>\n${body_parts.join("\n\n")}\n</review_comment>`;
}
