import type { GitsNote, GitsNoteSummary } from "@t3tools/contracts";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { FilePlus2Icon, RefreshCwIcon, SaveIcon, Trash2Icon } from "lucide-react";
import { useEffect, useMemo, useReducer, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { usePrimaryEnvironmentId } from "~/environments/primary";
import { readGitsEnvironmentClient } from "~/gitsClient";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { toastManager } from "~/components/ui/toast";

type GitsNotesEditor = {
  readonly selectedId: string | null;
  readonly title: string;
  readonly content: string;
  readonly preview: boolean;
  readonly error: string | null;
};

type GitsNotesEditorAction =
  | { readonly type: "select"; readonly note: GitsNote }
  | { readonly type: "clear" }
  | { readonly type: "content"; readonly value: string }
  | { readonly type: "preview" }
  | { readonly type: "error"; readonly message: string }
  | { readonly type: "saved" }
  | { readonly type: "synced" };

const EMPTY_NOTES: ReadonlyArray<GitsNoteSummary> = [];

function initialGitsNotesEditor(
  notes: ReadonlyArray<GitsNoteSummary>,
  selectedNote: GitsNote | undefined,
): GitsNotesEditor {
  const selectedId = selectedNote?.id ?? notes[0]?.id ?? null;
  return {
    selectedId,
    title: selectedNote?.title ?? "",
    content: selectedNote?.content ?? "",
    preview: false,
    error: null,
  };
}

function reduceGitsNotesEditor(
  state: GitsNotesEditor,
  action: GitsNotesEditorAction,
): GitsNotesEditor {
  switch (action.type) {
    case "select":
      return {
        ...state,
        selectedId: action.note.id,
        title: action.note.title,
        content: action.note.content,
        error: null,
      };
    case "clear":
      return { ...state, selectedId: null, title: "", content: "", error: null };
    case "content":
      return { ...state, content: action.value };
    case "preview":
      return { ...state, preview: !state.preview };
    case "error":
      return { ...state, error: action.message };
    case "saved":
    case "synced":
      return { ...state, error: null };
  }
}

function filterGitsNotes(
  notes: ReadonlyArray<GitsNoteSummary>,
  loadedNotes: ReadonlyMap<string, GitsNote>,
  query: string,
): ReadonlyArray<GitsNoteSummary> {
  const term = query.trim().toLocaleLowerCase();
  if (!term) return notes;
  return notes.filter((note) => {
    const content = loadedNotes.get(note.id)?.content ?? "";
    return `${note.title}\n${content}`.toLocaleLowerCase().includes(term);
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Notes operation failed.";
}

function GitsNotesMarkdownPreview({ content }: { readonly content: string }) {
  return (
    <article className="prose prose-sm mt-4 max-w-none overflow-auto dark:prose-invert">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </article>
  );
}

export function GitsNotes() {
  const environmentId = usePrimaryEnvironmentId();
  const client = environmentId ? readGitsEnvironmentClient(environmentId)?.notes : null;
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [deleteSelectionState, setDeleteSelectionState] = useState<"none" | "waiting" | "ready">(
    "none",
  );
  const [editor, dispatch] = useReducer(
    reduceGitsNotesEditor,
    initialGitsNotesEditor([], undefined),
  );
  const listKey = ["gits", "notes", environmentId, "list"] as const;
  const readKey = ["gits", "notes", environmentId, "read", editor.selectedId] as const;
  const listQuery = useQuery({
    queryKey: listKey,
    enabled: Boolean(client),
    queryFn: () => client!.list({}),
  });
  const notes = listQuery.data ?? EMPTY_NOTES;
  const selectedNoteQuery = useQuery({
    queryKey: readKey,
    enabled: Boolean(client && editor.selectedId),
    queryFn: () => client!.read({ id: editor.selectedId! }),
  });
  const searchQueries = useQueries({
    queries: search.trim()
      ? notes.map((note) => ({
          queryKey: ["gits", "notes", environmentId, "read", note.id] as const,
          queryFn: () => client!.read({ id: note.id }),
          enabled: Boolean(client),
        }))
      : [],
  });
  const loadedNotes = useMemo(() => {
    const entries = searchQueries.flatMap((query) =>
      query.data ? [[query.data.id, query.data] as const] : [],
    );
    if (selectedNoteQuery.data) entries.push([selectedNoteQuery.data.id, selectedNoteQuery.data]);
    return new Map(entries);
  }, [searchQueries, selectedNoteQuery.data]);
  const filteredNotes = filterGitsNotes(notes, loadedNotes, search);
  const queryError =
    listQuery.error ??
    selectedNoteQuery.error ??
    searchQueries.find((query) => query.error)?.error ??
    null;

  useEffect(() => {
    if (!editor.selectedId && deleteSelectionState === "none" && notes[0])
      dispatch({
        type: "select",
        note: loadedNotes.get(notes[0].id) ?? { ...notes[0], content: "" },
      });
  }, [deleteSelectionState, editor.selectedId, loadedNotes, notes]);
  useEffect(() => {
    if (selectedNoteQuery.data) dispatch({ type: "select", note: selectedNoteQuery.data });
  }, [selectedNoteQuery.data]);
  useEffect(() => {
    if (deleteSelectionState !== "ready") return;
    const nextNote = notes[0];
    setDeleteSelectionState("none");
    if (nextNote) {
      dispatch({
        type: "select",
        note: loadedNotes.get(nextNote.id) ?? { ...nextNote, content: "" },
      });
    }
  }, [deleteSelectionState, loadedNotes, notes]);

  const invalidateNotes = async () => {
    await queryClient.invalidateQueries({ queryKey: ["gits", "notes", environmentId] });
  };
  const saveMutation = useMutation({
    mutationFn: () =>
      client!.update({
        id: editor.selectedId!,
        title: editor.title.trim(),
        content: editor.content,
      }),
    onSuccess: async () => {
      dispatch({ type: "saved" });
      toastManager.add({ title: "Note saved", type: "success" });
      await invalidateNotes();
    },
    onError: (error) => dispatch({ type: "error", message: errorMessage(error) }),
  });
  const createMutation = useMutation({
    mutationFn: () =>
      client!.create({ id: `note-${Date.now()}.md`, title: "Untitled note", content: "" }),
    onSuccess: async (note) => {
      dispatch({ type: "select", note });
      await invalidateNotes();
    },
    onError: (error) => dispatch({ type: "error", message: errorMessage(error) }),
  });
  const deleteMutation = useMutation({
    mutationFn: (id: string) => client!.remove({ id }),
    onSuccess: async () => {
      dispatch({ type: "clear" });
      setDeleteSelectionState("waiting");
      await invalidateNotes();
      setDeleteSelectionState("ready");
    },
    onError: (error) => dispatch({ type: "error", message: errorMessage(error) }),
  });
  const syncMutation = useMutation({
    mutationFn: () => client!.sync({}),
    onSuccess: async () => {
      dispatch({ type: "synced" });
      toastManager.add({ title: "Notes synced", type: "success" });
      await invalidateNotes();
    },
    onError: (error) => dispatch({ type: "error", message: errorMessage(error) }),
  });

  if (!environmentId || !client) {
    return (
      <main className="p-6">
        <Alert variant="warning">
          <AlertTitle>Notes unavailable</AlertTitle>
          <AlertDescription>Connect an environment to use Dev Notes.</AlertDescription>
        </Alert>
      </main>
    );
  }

  return (
    <main className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden md:grid-cols-[18rem_minmax(0,1fr)_minmax(16rem,0.7fr)]">
      <aside className="min-h-0 border-b p-4 md:border-r md:border-b-0">
        <div className="mb-3 flex gap-2">
          <Input
            aria-label="Search notes"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search notes"
          />
          <Button
            size="sm"
            onClick={() => createMutation.mutate()}
            disabled={createMutation.isPending}
          >
            <FilePlus2Icon />
            New
          </Button>
        </div>
        <div className="space-y-1 overflow-y-auto">
          {filteredNotes.map((note) => (
            <Button
              key={note.id}
              variant={note.id === editor.selectedId ? "secondary" : "ghost"}
              className="h-auto w-full justify-start whitespace-normal text-left"
              onClick={() =>
                dispatch({
                  type: "select",
                  note: loadedNotes.get(note.id) ?? { ...note, content: "" },
                })
              }
            >
              {note.title}
            </Button>
          ))}
        </div>
      </aside>
      <section className="flex min-h-0 flex-col gap-3 p-4">
        <div className="flex flex-wrap gap-2">
          <h1 className="min-w-0 flex-1 truncate px-3 py-2 font-medium">
            {editor.title || "Untitled note"}
          </h1>
          <Button
            size="sm"
            onClick={() => saveMutation.mutate()}
            disabled={!editor.selectedId || saveMutation.isPending}
          >
            <SaveIcon />
            Save
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => syncMutation.mutate()}
            disabled={syncMutation.isPending}
          >
            <RefreshCwIcon />
            Sync
          </Button>
          <Button
            size="sm"
            variant="destructive-outline"
            onClick={() => editor.selectedId && deleteMutation.mutate(editor.selectedId)}
            disabled={!editor.selectedId || deleteMutation.isPending}
          >
            <Trash2Icon />
            Delete
          </Button>
        </div>
        {editor.error || queryError ? (
          <Alert variant="error">
            <AlertTitle>Notes error</AlertTitle>
            <AlertDescription>{editor.error ?? errorMessage(queryError)}</AlertDescription>
          </Alert>
        ) : null}
        <Textarea
          aria-label="Note content"
          className="min-h-96 flex-1"
          value={editor.content}
          onChange={(event) => dispatch({ type: "content", value: event.target.value })}
          placeholder="Write Markdown…"
        />
      </section>
      <section className="min-h-0 border-t p-4 md:border-t-0 md:border-l">
        <Button
          size="sm"
          variant="outline"
          aria-pressed={editor.preview}
          onClick={() => dispatch({ type: "preview" })}
        >
          {editor.preview ? "Edit" : "Preview"}
        </Button>
        {editor.preview ? (
          <GitsNotesMarkdownPreview content={editor.content} />
        ) : (
          <p className="mt-4 text-sm text-muted-foreground">Preview is off.</p>
        )}
      </section>
    </main>
  );
}
