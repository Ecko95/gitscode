import type { GitsNote, GitsNoteSummary } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  filterGitsNotes,
  GitsNotesMarkdownPreview,
  initialGitsNotesEditor,
  reduceGitsNotesEditor,
} from "./GitsNotes";

const summaries: ReadonlyArray<GitsNoteSummary> = [
  {
    id: "ssh.md",
    title: "SSH access",
    updatedAt: "2026-07-14T12:00:00.000Z",
    notionPageId: null,
  },
  {
    id: "deploy.md",
    title: "Deploy runbook",
    updatedAt: "2026-07-13T12:00:00.000Z",
    notionPageId: null,
  },
];

const sshNote: GitsNote = {
  ...summaries[0]!,
  content: "```sh\nssh deploy@example.com\n```",
};

describe("GitsNotes", () => {
  it("filters note titles and loaded content case-insensitively", () => {
    expect(filterGitsNotes(summaries, new Map([[sshNote.id, sshNote]]), "SSH")).toEqual([
      summaries[0],
    ]);
    expect(filterGitsNotes(summaries, new Map([[sshNote.id, sshNote]]), "EXAMPLE.COM")).toEqual([
      summaries[0],
    ]);
  });

  it("loads the first note, edits it, previews Markdown, saves and syncs without losing text on error", () => {
    let editor = initialGitsNotesEditor(summaries, sshNote);
    expect(editor).toMatchObject({
      selectedId: "ssh.md",
      title: "SSH access",
      content: sshNote.content,
    });

    editor = reduceGitsNotesEditor(editor, { type: "content", value: "draft ssh command" });
    editor = reduceGitsNotesEditor(editor, { type: "preview" });
    expect(editor).toMatchObject({ content: "draft ssh command", preview: true });

    editor = reduceGitsNotesEditor(editor, { type: "error", message: "Save failed" });
    expect(editor).toMatchObject({ content: "draft ssh command", error: "Save failed" });

    editor = reduceGitsNotesEditor(editor, { type: "saved" });
    editor = reduceGitsNotesEditor(editor, { type: "synced" });
    expect(editor.error).toBeNull();
  });

  it("renders an SSH command as a Markdown code block", () => {
    const html = renderToStaticMarkup(<GitsNotesMarkdownPreview content={sshNote.content} />);

    expect(html).toContain("<pre>");
    expect(html).toContain("ssh deploy@example.com");
  });
});
