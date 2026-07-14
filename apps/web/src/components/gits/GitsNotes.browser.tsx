import "../../index.css";

import type { GitsNote, GitsNoteSummary } from "@t3tools/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page, userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const ENVIRONMENT_ID = "notes-environment" as never;
const sshSummary: GitsNoteSummary = {
  id: "ssh.md",
  title: "SSH access",
  updatedAt: "2026-07-14T12:00:00.000Z",
  notionPageId: null,
};
const deploySummary: GitsNoteSummary = {
  id: "deploy.md",
  title: "Deploy runbook",
  updatedAt: "2026-07-13T12:00:00.000Z",
  notionPageId: null,
};
const sshNote: GitsNote = { ...sshSummary, content: "```sh\nssh deploy@example.com\n```" };
const deployNote: GitsNote = { ...deploySummary, content: "Deploy with confidence." };
const renamedSshNote: GitsNote = {
  ...sshNote,
  id: "SSH access renamed.md",
  title: "SSH access renamed",
  content: "updated SSH command",
};

const notes = vi.hoisted(() => ({
  create: vi.fn(),
  list: vi.fn(),
  read: vi.fn(),
  remove: vi.fn(),
  sync: vi.fn(),
  update: vi.fn(),
}));

vi.mock("~/environments/primary", () => ({
  usePrimaryEnvironmentId: () => ENVIRONMENT_ID,
}));
vi.mock("~/gitsClient", () => ({
  readGitsEnvironmentClient: () => ({ notes }),
}));
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: vi.fn() } }));

import { GitsNotes } from "./GitsNotes";

function renderNotes() {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <GitsNotes />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  notes.create.mockResolvedValue({ ...sshNote, id: "new.md" });
  notes.list.mockResolvedValue([sshSummary, deploySummary]);
  notes.read.mockImplementation(async ({ id }: { id: string }) =>
    id === sshNote.id ? sshNote : deployNote,
  );
  notes.remove.mockResolvedValue(undefined);
  notes.sync.mockResolvedValue({ created: [], updated: [], conflicts: [], warnings: [] });
  notes.update.mockImplementation(async (input: GitsNote) => input);
});

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

describe("GitsNotes", () => {
  it("shows seeded notes, searches title/content, and loads the selected note", async () => {
    const screen = await renderNotes();
    try {
      await expect.element(page.getByRole("button", { name: "SSH access" })).toBeInTheDocument();
      await userEvent.fill(page.getByLabelText("Search notes"), "EXAMPLE.COM");
      await expect
        .element(page.getByRole("button", { name: "Deploy runbook" }))
        .not.toBeInTheDocument();
      await userEvent.fill(page.getByLabelText("Search notes"), "");
      await page.getByRole("button", { name: "Deploy runbook" }).click();
      await expect
        .element(page.getByLabelText("Note content"))
        .toHaveValue("Deploy with confidence.");
    } finally {
      await screen.unmount();
    }
  });

  it("renders the selected SSH command in a code block", async () => {
    const screen = await renderNotes();
    try {
      await expect.element(page.getByLabelText("Note content")).toHaveValue(sshNote.content);
      await page.getByRole("button", { name: "Preview" }).click();
      await vi.waitFor(() =>
        expect(document.querySelector("pre code")?.textContent).toContain("ssh deploy@example.com"),
      );
    } finally {
      await screen.unmount();
    }
  });

  it("saves a renamed title through update and keeps the renamed note selected", async () => {
    notes.update.mockResolvedValue(renamedSshNote);
    notes.list
      .mockReset()
      .mockResolvedValueOnce([sshSummary])
      .mockResolvedValue([renamedSshNote, deploySummary]);
    const screen = await renderNotes();
    try {
      const editor = page.getByLabelText("Note content");
      await expect.element(editor).toHaveValue(sshNote.content);
      await userEvent.fill(page.getByLabelText("Note title"), "SSH access renamed");
      await userEvent.fill(editor, "updated SSH command");
      await page.getByRole("button", { name: "Save" }).click();
      await vi.waitFor(() =>
        expect(notes.update).toHaveBeenCalledWith({
          id: "ssh.md",
          title: "SSH access renamed",
          content: "updated SSH command",
        }),
      );
      expect(notes.update).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => expect(notes.list).toHaveBeenCalledTimes(2));
      await expect.element(page.getByLabelText("Note title")).toHaveValue("SSH access renamed");
      await expect.element(page.getByLabelText("Note content")).toHaveValue("updated SSH command");
    } finally {
      await screen.unmount();
    }
  });

  it("shows rejected RPC errors without clearing edited content", async () => {
    notes.update.mockRejectedValue(new Error("Save failed"));
    const screen = await renderNotes();
    try {
      const editor = page.getByLabelText("Note content");
      await expect.element(editor).toHaveValue(sshNote.content);
      await userEvent.fill(editor, "unsaved draft");
      await page.getByRole("button", { name: "Save" }).click();
      await expect.element(page.getByRole("alert")).toHaveTextContent("Save failed");
      await expect.element(editor).toHaveValue("unsaved draft");
    } finally {
      await screen.unmount();
    }
  });

  it("shows list and read query errors", async () => {
    notes.list.mockRejectedValue(new Error("List failed"));
    const listScreen = await renderNotes();
    try {
      await expect.element(page.getByRole("alert")).toHaveTextContent("List failed");
    } finally {
      await listScreen.unmount();
    }

    notes.list.mockResolvedValue([sshSummary]);
    notes.read.mockRejectedValue(new Error("Read failed"));
    const readScreen = await renderNotes();
    try {
      await expect.element(page.getByRole("alert")).toHaveTextContent("Read failed");
    } finally {
      await readScreen.unmount();
    }
  });

  it("clears the deleted selection and chooses only a refreshed remaining note", async () => {
    notes.list
      .mockReset()
      .mockResolvedValueOnce([sshSummary, deploySummary])
      .mockResolvedValue([deploySummary]);
    const screen = await renderNotes();
    try {
      await expect.element(page.getByLabelText("Note content")).toHaveValue(sshNote.content);
      await page.getByRole("button", { name: "Delete" }).click();
      await expect.element(page.getByLabelText("Note content")).toHaveValue(deployNote.content);
      expect(notes.remove).toHaveBeenCalledWith({ id: "ssh.md" });
    } finally {
      await screen.unmount();
    }
  });
});
