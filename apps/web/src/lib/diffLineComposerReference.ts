import type { FileDiffMetadata } from "@pierre/diffs/react";

export type DiffLineSide = "additions" | "deletions";

export interface DiffLineReferenceTarget {
  filePath: string;
  lineNumber: number;
  snippet?: string | null;
}

export function buildDiffLineComposerReference(target: DiffLineReferenceTarget): string {
  const lineReference = `In ${target.filePath}:L${target.lineNumber}`;
  const snippet = compactDiffLineSnippet(target.snippet);
  return snippet ? `${lineReference}: ${snippet}\n` : `${lineReference}\n`;
}

export function appendDiffLineReferenceToPrompt(prompt: string, reference: string): string {
  const normalizedReference = reference.endsWith("\n") ? reference : `${reference}\n`;
  if (prompt.trim().length === 0) {
    return normalizedReference;
  }
  return `${prompt}${prompt.endsWith("\n") ? "" : "\n"}${normalizedReference}`;
}

export function resolveDiffLineFilePath(fileDiff: FileDiffMetadata, side: DiffLineSide): string {
  return side === "deletions" ? (fileDiff.prevName ?? fileDiff.name) : fileDiff.name;
}

export function resolveDiffLineSnippet(
  fileDiff: FileDiffMetadata,
  side: DiffLineSide,
  lineNumber: number,
): string | null {
  for (const hunk of fileDiff.hunks) {
    let additionLineNumber = hunk.additionStart;
    let deletionLineNumber = hunk.deletionStart;
    let additionLineIndex = hunk.additionLineIndex;
    let deletionLineIndex = hunk.deletionLineIndex;

    for (const content of hunk.hunkContent) {
      if (content.type === "context") {
        for (let offset = 0; offset < content.lines; offset += 1) {
          if (side === "additions" && additionLineNumber + offset === lineNumber) {
            return fileDiff.additionLines[additionLineIndex + offset] ?? null;
          }
          if (side === "deletions" && deletionLineNumber + offset === lineNumber) {
            return fileDiff.deletionLines[deletionLineIndex + offset] ?? null;
          }
        }
        additionLineNumber += content.lines;
        deletionLineNumber += content.lines;
        additionLineIndex += content.lines;
        deletionLineIndex += content.lines;
        continue;
      }

      if (side === "deletions") {
        for (let offset = 0; offset < content.deletions; offset += 1) {
          if (deletionLineNumber + offset === lineNumber) {
            return fileDiff.deletionLines[deletionLineIndex + offset] ?? null;
          }
        }
      } else {
        for (let offset = 0; offset < content.additions; offset += 1) {
          if (additionLineNumber + offset === lineNumber) {
            return fileDiff.additionLines[additionLineIndex + offset] ?? null;
          }
        }
      }

      additionLineNumber += content.additions;
      deletionLineNumber += content.deletions;
      additionLineIndex += content.additions;
      deletionLineIndex += content.deletions;
    }
  }

  return null;
}

function compactDiffLineSnippet(snippet: string | null | undefined): string | null {
  const normalized = snippet?.replace(/\s+/g, " ").trim() ?? "";
  if (normalized.length === 0) {
    return null;
  }
  // ponytail: one-line refs stay compact; richer quote blocks can come with a later comment UI.
  return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
}
