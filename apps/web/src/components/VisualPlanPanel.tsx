import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  EnvironmentId,
  OrchestrationVisualPlan,
  PlanBlock,
  PlanComment,
  PlanCommentAnchor,
  PlanCommentResolutionTarget,
  PlanContent,
  PlanContentPatch,
  PlanLeafBlock,
  ThreadId,
} from "@t3tools/contracts";
import {
  applyPlanPatches,
  exportPlanToMarkdown,
  resolvePlanComment,
  upsertPlanComment,
} from "@t3tools/contracts";
import {
  CheckIcon,
  GripVerticalIcon,
  MessageSquarePlusIcon,
  PanelRightCloseIcon,
  PencilIcon,
  PlusIcon,
  SendHorizontalIcon,
} from "lucide-react";
import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { ScrollArea } from "./ui/scroll-area";
import { Textarea } from "./ui/textarea";
import ChatMarkdown from "./ChatMarkdown";
import { readGitsEnvironmentClient } from "~/gitsClient";
import { cn, randomUUID } from "~/lib/utils";
import { buildVisualBlockSrcDoc, readVisualPlanThemeVars } from "~/lib/visualPlanHtml";
import {
  buildBlockCommentAnchor,
  buildTextCommentAnchor,
  describeCommentAnchor,
} from "~/lib/visualPlanComments";

interface VisualPlanPanelProps {
  readonly visualPlan: OrchestrationVisualPlan | null;
  readonly mode: "sidebar" | "sheet";
  readonly onClose: () => void;
  readonly threadId?: ThreadId | undefined;
  readonly environmentId?: EnvironmentId | undefined;
  /** Dispatch the plan's export markdown as a new turn (wired by ChatView). */
  readonly onSendToAgent?: ((markdown: string) => void) | undefined;
}

const TONE_STYLES: Record<string, string> = {
  info: "border-blue-500/30 bg-blue-500/5",
  decision: "border-violet-500/40 bg-violet-500/5",
  risk: "border-rose-500/40 bg-rose-500/5",
  warning: "border-amber-500/40 bg-amber-500/5",
  success: "border-emerald-500/40 bg-emerald-500/5",
};

const nowIso = (): string => new Date().toISOString();
const newCommentId = (): string => `cmt_${randomUUID()}`;

/** Callback a block uses to emit a single content patch (edit mode). */
type PatchHandler = (patch: PlanContentPatch) => void;

function BlockTitle({
  title,
  summary,
}: {
  title?: string | undefined;
  summary?: string | undefined;
}) {
  if (!title && !summary) return null;
  return (
    <div className="mb-1.5">
      {title ? <div className="text-[13px] font-semibold text-foreground/90">{title}</div> : null}
      {summary ? <div className="text-[11px] text-muted-foreground/70">{summary}</div> : null}
    </div>
  );
}

/** Inert agent-authored HTML/CSS rendered inside a fully sandboxed iframe. */
function VisualBlockFrame({
  html,
  css,
  caption,
  surfaceRef,
}: {
  html: string;
  css?: string | undefined;
  caption?: string | undefined;
  surfaceRef: React.RefObject<HTMLDivElement | null>;
}) {
  const [themeVars, setThemeVars] = useState<Record<string, string>>({});
  useEffect(() => {
    setThemeVars(readVisualPlanThemeVars(surfaceRef.current));
  }, [surfaceRef]);
  const srcDoc = useMemo(
    () => buildVisualBlockSrcDoc({ html, css, themeVars }),
    [html, css, themeVars],
  );
  return (
    <figure className="m-0 flex flex-col gap-1">
      <iframe
        // `sandbox=""` → opaque origin, no scripts, no forms: the diagram cannot
        // run code or reach the GITS app. Never add allow-scripts/allow-same-origin.
        sandbox=""
        srcDoc={srcDoc}
        title={caption ?? "Visual plan diagram"}
        className="h-[320px] w-full rounded-md border border-border/50 bg-card/30"
        loading="lazy"
      />
      {caption ? (
        <figcaption className="text-center text-[10px] text-muted-foreground/60">
          {caption}
        </figcaption>
      ) : null}
    </figure>
  );
}

function ChecklistEditor({
  block,
  onPatch,
}: {
  block: Extract<PlanLeafBlock, { type: "checklist" }>;
  onPatch: PatchHandler;
}) {
  const [draft, setDraft] = useState("");
  const items = block.data.items;
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const replaceItems = (next: typeof items) => {
    onPatch({
      op: "replace-block",
      blockId: block.id,
      block: { ...block, data: { ...block.data, items: next } },
    });
  };

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = items.findIndex((item) => item.id === active.id);
    const to = items.findIndex((item) => item.id === over.id);
    if (from < 0 || to < 0) return;
    const next = [...items];
    const [moved] = next.splice(from, 1);
    if (moved) next.splice(to, 0, moved);
    replaceItems(next);
  };

  return (
    <div className="flex flex-col gap-1">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictToVerticalAxis]}
        onDragEnd={onDragEnd}
      >
        <SortableContext
          items={items.map((item) => item.id)}
          strategy={verticalListSortingStrategy}
        >
          {items.map((item) => (
            <SortableChecklistItem
              key={item.id}
              id={item.id}
              checked={Boolean(item.checked)}
              label={item.label}
              onToggle={() =>
                replaceItems(
                  items.map((i) => (i.id === item.id ? { ...i, checked: !i.checked } : i)),
                )
              }
              onLabel={(label) =>
                replaceItems(items.map((i) => (i.id === item.id ? { ...i, label } : i)))
              }
            />
          ))}
        </SortableContext>
      </DndContext>
      <form
        className="mt-1 flex items-center gap-1"
        onSubmit={(e) => {
          e.preventDefault();
          const label = draft.trim();
          if (!label) return;
          replaceItems([...items, { id: `item_${newCommentId()}`, label, checked: false }]);
          setDraft("");
        }}
      >
        <Input
          value={draft}
          onChange={(e) => setDraft(e.currentTarget.value)}
          placeholder="Add a checklist item…"
          className="h-7 text-[12px]"
        />
        <Button type="submit" size="icon-xs" variant="ghost" aria-label="Add checklist item">
          <PlusIcon className="size-3.5" />
        </Button>
      </form>
    </div>
  );
}

function SortableChecklistItem({
  id,
  checked,
  label,
  onToggle,
  onLabel,
}: {
  id: string;
  checked: boolean;
  label: string;
  onToggle: () => void;
  onLabel: (label: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  };
  return (
    <div ref={setNodeRef} style={style} className="flex items-center gap-1.5 text-[12px]">
      <button
        type="button"
        {...attributes}
        {...listeners}
        aria-label="Reorder item"
        className="cursor-grab text-muted-foreground/40 hover:text-muted-foreground/70"
      >
        <GripVerticalIcon className="size-3.5" />
      </button>
      <button
        type="button"
        onClick={onToggle}
        aria-label={checked ? "Mark incomplete" : "Mark complete"}
        className={cn(
          "flex size-4 shrink-0 items-center justify-center rounded border text-[10px]",
          checked ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-500" : "border-border/60",
        )}
      >
        {checked ? "✓" : ""}
      </button>
      <Input
        defaultValue={label}
        key={label}
        onBlur={(e) => {
          const value = e.currentTarget.value.trim();
          if (value && value !== label) onLabel(value);
        }}
        className={cn(
          "h-6 border-transparent bg-transparent px-1 text-[12px]",
          checked && "text-muted-foreground/60 line-through",
        )}
      />
    </div>
  );
}

function LeafBlockView({
  block,
  editing,
  onPatch,
  surfaceRef,
}: {
  block: PlanLeafBlock;
  editing: boolean;
  onPatch: PatchHandler;
  surfaceRef: React.RefObject<HTMLDivElement | null>;
}) {
  switch (block.type) {
    case "rich-text":
      if (editing) {
        return (
          <Textarea
            defaultValue={block.data.markdown}
            key={block.data.markdown}
            onBlur={(e) => {
              const markdown = e.currentTarget.value;
              if (markdown !== block.data.markdown) {
                onPatch({ op: "update-rich-text", blockId: block.id, markdown });
              }
            }}
            className="min-h-[80px] font-mono text-[12px]"
          />
        );
      }
      return <ChatMarkdown text={block.data.markdown} cwd={undefined} />;

    case "callout":
      return (
        <div
          className={cn(
            "rounded-md border px-3 py-2 text-[12px] leading-relaxed",
            TONE_STYLES[block.data.tone ?? "info"] ?? TONE_STYLES.info,
          )}
        >
          {block.data.tone ? (
            <span className="mr-1.5 text-[10px] font-semibold tracking-wide uppercase opacity-70">
              {block.data.tone}
            </span>
          ) : null}
          {editing ? (
            <Textarea
              defaultValue={block.data.body}
              key={block.data.body}
              onBlur={(e) => {
                const body = e.currentTarget.value;
                if (body !== block.data.body) {
                  onPatch({ op: "update-block", blockId: block.id, patch: { data: { body } } });
                }
              }}
              className="mt-1 min-h-[48px] bg-transparent text-[12px]"
            />
          ) : (
            block.data.body
          )}
        </div>
      );

    case "checklist":
      if (editing) {
        return <ChecklistEditor block={block} onPatch={onPatch} />;
      }
      return (
        <ul className="flex flex-col gap-1">
          {block.data.items.map((item) => (
            <li key={item.id} className="flex items-start gap-2 text-[12px]">
              <span
                className={cn(
                  "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border text-[10px]",
                  item.checked
                    ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-500"
                    : "border-border/60",
                )}
              >
                {item.checked ? "✓" : ""}
              </span>
              <span className={cn(item.checked && "text-muted-foreground/60 line-through")}>
                {item.label}
                {item.note ? (
                  <span className="ml-1 text-muted-foreground/50">— {item.note}</span>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      );

    case "table":
      return (
        <div className="overflow-x-auto rounded-md border border-border/50">
          <table className="w-full text-[11px]">
            <thead className="bg-muted/30">
              <tr>
                {block.data.columns.map((col, i) => (
                  <th key={i} className="px-2 py-1 text-left font-semibold">
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.data.rows.map((row, ri) => (
                <tr key={ri} className="border-t border-border/40">
                  {row.map((cell, ci) => (
                    <td key={ci} className="px-2 py-1 align-top">
                      {editing ? (
                        <Input
                          defaultValue={cell}
                          key={cell}
                          onBlur={(e) => {
                            const value = e.currentTarget.value;
                            if (value === cell) return;
                            const rows = block.data.rows.map((r, rIdx) =>
                              rIdx === ri ? r.map((c, cIdx) => (cIdx === ci ? value : c)) : r,
                            );
                            onPatch({
                              op: "update-block",
                              blockId: block.id,
                              patch: { data: { rows } },
                            });
                          }}
                          className="h-6 border-transparent bg-transparent px-1 text-[11px]"
                        />
                      ) : (
                        cell
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );

    case "code":
      return (
        <ChatMarkdown
          text={`\`\`\`${block.data.language ?? ""}\n${block.data.code}\n\`\`\``}
          cwd={undefined}
        />
      );

    case "annotated-code":
      return (
        <div>
          {block.data.filename ? (
            <div className="mb-1 font-mono text-[10px] text-muted-foreground/60">
              {block.data.filename}
            </div>
          ) : null}
          <ChatMarkdown
            text={`\`\`\`${block.data.language ?? ""}\n${block.data.code}\n\`\`\``}
            cwd={undefined}
          />
          {block.data.annotations && block.data.annotations.length > 0 ? (
            <ul className="mt-1 flex flex-col gap-0.5 text-[11px] text-muted-foreground/70">
              {block.data.annotations.map((a, i) => (
                <li key={i}>
                  <span className="font-mono text-foreground/70">L{a.lines}</span>
                  {a.label ? <span className="font-semibold"> {a.label}</span> : null} — {a.note}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      );

    case "file-tree":
      return (
        <ul className="flex flex-col gap-0.5 font-mono text-[11px]">
          {block.data.entries.map((entry, i) => (
            <li key={i} className="flex items-baseline gap-1.5">
              {entry.change ? (
                <span className="text-[9px] text-muted-foreground/50 uppercase">
                  {entry.change}
                </span>
              ) : null}
              <span className="text-foreground/80">{entry.path}</span>
              {entry.note ? <span className="text-muted-foreground/50">— {entry.note}</span> : null}
            </li>
          ))}
        </ul>
      );

    case "implementation-map":
      return (
        <ul className="flex flex-col gap-1 text-[11px]">
          {block.data.files.map((file, i) => (
            <li key={i}>
              <span className="font-mono text-foreground/80">{file.path}</span>
              {file.title ? (
                <span className="text-muted-foreground/60"> ({file.title})</span>
              ) : null}
              <div className="text-muted-foreground/70">{file.note}</div>
            </li>
          ))}
        </ul>
      );

    case "api-endpoint":
      return (
        <div className="rounded-md border border-border/50 p-2 text-[11px]">
          <div className="font-mono">
            <span className="font-semibold text-foreground/90">{block.data.method}</span>{" "}
            <span className="text-muted-foreground/80">{block.data.path}</span>
          </div>
          {block.data.summary ? (
            <div className="mt-0.5 text-muted-foreground/70">{block.data.summary}</div>
          ) : null}
        </div>
      );

    case "data-model":
      return (
        <div className="flex flex-col gap-2">
          {block.data.entities.map((entity) => (
            <div key={entity.id} className="rounded-md border border-border/50 p-2 text-[11px]">
              <div className="font-semibold text-foreground/90">{entity.name}</div>
              <ul className="mt-1 flex flex-col gap-0.5 font-mono text-[10px]">
                {entity.fields.map((field, i) => (
                  <li key={i} className="text-muted-foreground/80">
                    {field.name}
                    {field.type ? `: ${field.type}` : ""}
                    {field.pk ? " (pk)" : ""}
                    {field.fk ? " (fk)" : ""}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      );

    case "question-form":
      return (
        <div className="flex flex-col gap-2">
          {block.data.questions.map((q) => (
            <div key={q.id} className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2">
              <div className="text-[12px] font-semibold text-foreground/90">{q.title}</div>
              {q.subtitle ? (
                <div className="text-[11px] text-muted-foreground/70">{q.subtitle}</div>
              ) : null}
              {q.options && q.options.length > 0 ? (
                <ul className="mt-1 flex flex-wrap gap-1">
                  {q.options.map((opt) => (
                    <li
                      key={opt.id}
                      className={cn(
                        "rounded border px-1.5 py-0.5 text-[10px]",
                        opt.recommended
                          ? "border-emerald-500/40 bg-emerald-500/10"
                          : "border-border/50",
                      )}
                    >
                      {opt.label}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ))}
        </div>
      );

    case "diagram":
    case "custom-html":
      return block.data.html ? (
        <VisualBlockFrame
          html={block.data.html}
          css={block.data.css}
          caption={block.data.caption}
          surfaceRef={surfaceRef}
        />
      ) : (
        <div className="rounded-md border border-dashed border-border/50 p-3 text-center text-[11px] text-muted-foreground/60">
          {block.data.caption ?? "Empty visual block"}
        </div>
      );
  }
}

function BlockView({
  block,
  editing,
  onPatch,
  surfaceRef,
}: {
  block: PlanBlock;
  editing: boolean;
  onPatch: PatchHandler;
  surfaceRef: React.RefObject<HTMLDivElement | null>;
}) {
  if (block.type === "tabs") {
    return (
      <div className="rounded-md border border-border/40">
        {block.data.tabs.map((tab) => (
          <div key={tab.id} className="border-b border-border/30 p-2 last:border-b-0">
            <div className="mb-1 text-[11px] font-semibold text-foreground/80">{tab.label}</div>
            <div className="flex flex-col gap-2">
              {tab.blocks.map((child) => (
                <LeafBlockView
                  key={child.id}
                  block={child}
                  editing={false}
                  onPatch={onPatch}
                  surfaceRef={surfaceRef}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  }
  if (block.type === "columns") {
    return (
      <div className="grid grid-cols-2 gap-2">
        {block.data.columns.map((column) => (
          <div key={column.id} className="flex flex-col gap-2">
            {column.label ? (
              <div className="text-[11px] font-semibold text-foreground/80">{column.label}</div>
            ) : null}
            {column.blocks.map((child) => (
              <LeafBlockView
                key={child.id}
                block={child}
                editing={false}
                onPatch={onPatch}
                surfaceRef={surfaceRef}
              />
            ))}
          </div>
        ))}
      </div>
    );
  }
  return (
    <LeafBlockView block={block} editing={editing} onPatch={onPatch} surfaceRef={surfaceRef} />
  );
}

const EDITABLE_TYPES = new Set(["rich-text", "checklist", "callout", "table"]);

interface PendingComment {
  readonly anchor: PlanCommentAnchor;
  readonly message: string;
  readonly target: PlanCommentResolutionTarget;
}

function VisualPlanPanel({
  visualPlan,
  mode,
  onClose,
  threadId,
  environmentId,
  onSendToAgent,
}: VisualPlanPanelProps) {
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  // Short-lived optimistic copy: cleared whenever a fresh server plan arrives.
  const [optimistic, setOptimistic] = useState<OrchestrationVisualPlan | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [pending, setPending] = useState<PendingComment | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setOptimistic(null);
  }, [visualPlan]);

  const plan = optimistic ?? visualPlan;
  const content = plan?.content ?? null;
  const canWrite = Boolean(threadId && environmentId);

  const runMutate = useCallback(
    async (
      input: {
        contentPatches?: PlanContentPatch[];
        addComment?: PendingCommentDraft;
        resolveCommentId?: string;
      },
      optimisticPlan: OrchestrationVisualPlan,
    ) => {
      setOptimistic(optimisticPlan);
      setError(null);
      if (!threadId || !environmentId) return;
      const client = readGitsEnvironmentClient(environmentId);
      if (!client) {
        setError("Not connected — changes not saved.");
        return;
      }
      try {
        await client.visualPlan.mutate({ threadId, ...input });
      } catch (cause) {
        setOptimistic(null);
        setError(cause instanceof Error ? cause.message : "Failed to save change.");
      }
    },
    [threadId, environmentId],
  );

  const handlePatch = useCallback<PatchHandler>(
    (patch) => {
      if (!plan) return;
      const nextContent = applyPlanPatches(plan.content, [patch]);
      void runMutate(
        { contentPatches: [patch] },
        { ...plan, content: nextContent, updatedAt: nowIso() },
      );
    },
    [plan, runMutate],
  );

  const submitComment = useCallback(() => {
    if (!plan || !pending) return;
    const message = pending.message.trim();
    if (!message) return;
    const id = newCommentId();
    const at = nowIso();
    const comment: PlanComment = {
      id,
      anchor: pending.anchor,
      message,
      createdBy: "human",
      resolutionTarget: pending.target,
      createdAt: at,
      updatedAt: at,
    };
    void runMutate(
      {
        addComment: {
          id,
          anchor: pending.anchor,
          message,
          createdBy: "human",
          resolutionTarget: pending.target,
        },
      },
      { ...plan, comments: upsertPlanComment(plan.comments, comment), updatedAt: at },
    );
    setPending(null);
  }, [plan, pending, runMutate]);

  const resolveComment = useCallback(
    (commentId: string) => {
      if (!plan) return;
      const at = nowIso();
      void runMutate(
        { resolveCommentId: commentId },
        { ...plan, comments: resolvePlanComment(plan.comments, commentId, at), updatedAt: at },
      );
    },
    [plan, runMutate],
  );

  const handleSelection = useCallback(() => {
    if (!canWrite) return;
    const selection = window.getSelection?.();
    if (!selection || selection.isCollapsed) return;
    const quote = selection.toString().trim();
    if (quote.length < 2) return;
    const node = selection.anchorNode;
    const element = node instanceof Element ? node : node?.parentElement;
    const blockEl = element?.closest<HTMLElement>("[data-block-id]");
    if (!blockEl) return;
    const anchor = buildTextCommentAnchor({
      blockId: blockEl.dataset.blockId,
      blockType: blockEl.dataset.blockType,
      blockText: blockEl.textContent ?? "",
      quote,
    });
    setPending({ anchor, message: "", target: "agent" });
  }, [canWrite]);

  const openComments = useMemo(
    () => (plan?.comments ?? []).filter((comment) => !comment.resolvedAt),
    [plan?.comments],
  );

  const sendToAgent = useCallback(() => {
    if (!content || !onSendToAgent) return;
    onSendToAgent(exportPlanToMarkdown(content, plan?.comments ?? []));
  }, [content, plan?.comments, onSendToAgent]);

  return (
    <div
      ref={surfaceRef}
      className={cn(
        "visual-plan-surface flex min-h-0 flex-col bg-card/50",
        mode === "sidebar"
          ? "h-full w-[360px] shrink-0 border-l border-border/70"
          : "h-full w-full",
      )}
    >
      <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border/60 px-3">
        <Badge
          variant="secondary"
          className="rounded-md bg-violet-500/10 px-1.5 py-0 text-[10px] font-semibold tracking-wide text-violet-400 uppercase"
        >
          Visual Plan
        </Badge>
        <div className="flex items-center gap-1">
          {canWrite ? (
            <Button
              size="icon-xs"
              variant={editMode ? "secondary" : "ghost"}
              onClick={() => setEditMode((value) => !value)}
              aria-label={editMode ? "Done editing" : "Edit plan"}
              title={editMode ? "Done editing" : "Edit plan"}
              className="text-muted-foreground/60 hover:text-foreground/80"
            >
              <PencilIcon className="size-3.5" />
            </Button>
          ) : null}
          {onSendToAgent ? (
            <Button
              size="icon-xs"
              variant="ghost"
              onClick={sendToAgent}
              disabled={!content}
              aria-label="Send plan to agent"
              title="Send plan to agent"
              className="text-muted-foreground/60 hover:text-foreground/80"
            >
              <SendHorizontalIcon className="size-3.5" />
            </Button>
          ) : null}
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={onClose}
            aria-label="Close visual plan panel"
            className="text-muted-foreground/50 hover:text-foreground/70"
          >
            <PanelRightCloseIcon className="size-3.5" />
          </Button>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        {content ? (
          <div className="flex flex-col gap-3 p-3" onMouseUp={handleSelection}>
            {content.title ? (
              <h2 className="text-[15px] font-semibold text-foreground">{content.title}</h2>
            ) : null}
            {content.brief ? (
              <p className="text-[12px] leading-relaxed text-muted-foreground/80">
                {content.brief}
              </p>
            ) : null}
            {content.blocks.map((block) => (
              <section
                key={block.id}
                data-block-id={block.id}
                data-block-type={block.type}
                className="group/block relative"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <BlockTitle title={block.title} summary={block.summary} />
                  </div>
                  {canWrite ? (
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      onClick={() =>
                        setPending({
                          anchor: buildBlockCommentAnchor({ id: block.id, type: block.type }),
                          message: "",
                          target: "agent",
                        })
                      }
                      aria-label={`Comment on ${block.id}`}
                      title="Comment on this block"
                      className="opacity-0 transition-opacity group-hover/block:opacity-100 text-muted-foreground/50 hover:text-foreground/70"
                    >
                      <MessageSquarePlusIcon className="size-3.5" />
                    </Button>
                  ) : null}
                </div>
                <BlockView
                  block={block}
                  editing={editMode && EDITABLE_TYPES.has(block.type)}
                  onPatch={handlePatch}
                  surfaceRef={surfaceRef}
                />
              </section>
            ))}

            {openComments.length > 0 ? (
              <div className="mt-1 flex flex-col gap-1.5 border-t border-border/50 pt-3">
                <div className="text-[10px] font-semibold tracking-wide text-muted-foreground/60 uppercase">
                  Comments
                </div>
                {openComments.map((comment) => (
                  <div
                    key={comment.id}
                    className="rounded-md border border-border/50 bg-background/40 px-2 py-1.5 text-[11px]"
                  >
                    <div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground/60">
                      <span className="truncate">{describeCommentAnchor(comment.anchor)}</span>
                      <div className="flex items-center gap-1">
                        {comment.resolutionTarget ? (
                          <span className="rounded bg-muted/40 px-1 py-px uppercase">
                            {comment.resolutionTarget}
                          </span>
                        ) : null}
                        <button
                          type="button"
                          onClick={() => resolveComment(comment.id)}
                          aria-label="Resolve comment"
                          title="Resolve"
                          className="text-muted-foreground/50 hover:text-emerald-500"
                        >
                          <CheckIcon className="size-3" />
                        </button>
                      </div>
                    </div>
                    <div className="mt-0.5 text-foreground/85">{comment.message}</div>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
            <div className="text-[13px] font-medium text-foreground/70">No visual plan yet</div>
            <p className="text-[11px] text-muted-foreground/60">
              Ask the agent to “render a visual plan” — it will appear here, ready to review.
            </p>
          </div>
        )}
      </ScrollArea>

      {pending ? (
        <div className="shrink-0 border-t border-border/60 bg-background/60 p-2">
          <div className="mb-1 text-[10px] text-muted-foreground/60">
            Commenting on {describeCommentAnchor(pending.anchor)}
          </div>
          <Textarea
            autoFocus
            value={pending.message}
            onChange={(e) => setPending({ ...pending, message: e.currentTarget.value })}
            placeholder="Leave a comment for the agent…"
            className="min-h-[56px] text-[12px]"
          />
          <div className="mt-1.5 flex items-center justify-between gap-2">
            <div className="flex items-center gap-1 text-[10px]">
              {(["agent", "human"] as const).map((target) => (
                <button
                  key={target}
                  type="button"
                  onClick={() => setPending({ ...pending, target })}
                  className={cn(
                    "rounded border px-1.5 py-0.5",
                    pending.target === target
                      ? "border-violet-500/40 bg-violet-500/10 text-violet-300"
                      : "border-border/50 text-muted-foreground/60",
                  )}
                >
                  {target === "agent" ? "For agent" : "For me"}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1">
              <Button size="xs" variant="ghost" onClick={() => setPending(null)}>
                Cancel
              </Button>
              <Button
                size="xs"
                onClick={submitComment}
                disabled={pending.message.trim().length === 0}
              >
                Comment
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {error ? (
        <div className="shrink-0 border-t border-rose-500/30 bg-rose-500/5 px-3 py-1.5 text-[11px] text-rose-400">
          {error}
        </div>
      ) : null}
    </div>
  );
}

interface PendingCommentDraft {
  readonly id: string;
  readonly anchor: PlanCommentAnchor;
  readonly message: string;
  readonly createdBy: "human" | "agent";
  readonly resolutionTarget: PlanCommentResolutionTarget;
}

export default memo(VisualPlanPanel);
export type { VisualPlanPanelProps };
