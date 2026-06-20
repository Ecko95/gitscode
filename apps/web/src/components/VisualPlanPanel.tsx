import { memo, useMemo } from "react";
import type {
  OrchestrationVisualPlan,
  PlanBlock,
  PlanContent,
  PlanLeafBlock,
} from "@t3tools/contracts";
import { PanelRightCloseIcon } from "lucide-react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { ScrollArea } from "./ui/scroll-area";
import ChatMarkdown from "./ChatMarkdown";
import { cn } from "~/lib/utils";

interface VisualPlanPanelProps {
  readonly visualPlan: OrchestrationVisualPlan | null;
  readonly mode: "sidebar" | "sheet";
  readonly onClose: () => void;
}

const TONE_STYLES: Record<string, string> = {
  info: "border-blue-500/30 bg-blue-500/5",
  decision: "border-violet-500/40 bg-violet-500/5",
  risk: "border-rose-500/40 bg-rose-500/5",
  warning: "border-amber-500/40 bg-amber-500/5",
  success: "border-emerald-500/40 bg-emerald-500/5",
};

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

function LeafBlockView({ block }: { block: PlanLeafBlock }) {
  switch (block.type) {
    case "rich-text":
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
          {block.data.body}
        </div>
      );

    case "checklist":
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
                      {cell}
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
      // Inert HTML/CSS is rendered in Phase 2 (sanitized). For now show a caption.
      return (
        <div className="rounded-md border border-dashed border-border/50 p-3 text-center text-[11px] text-muted-foreground/60">
          {block.data.caption ?? "Visual block (renders in a later phase)"}
        </div>
      );
  }
}

function BlockView({ block }: { block: PlanBlock }) {
  if (block.type === "tabs") {
    return (
      <div className="rounded-md border border-border/40">
        {block.data.tabs.map((tab) => (
          <div key={tab.id} className="border-b border-border/30 p-2 last:border-b-0">
            <div className="mb-1 text-[11px] font-semibold text-foreground/80">{tab.label}</div>
            <div className="flex flex-col gap-2">
              {tab.blocks.map((child) => (
                <LeafBlockView key={child.id} block={child} />
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
              <LeafBlockView key={child.id} block={child} />
            ))}
          </div>
        ))}
      </div>
    );
  }
  return <LeafBlockView block={block} />;
}

function VisualPlanDocument({ content }: { content: PlanContent }) {
  return (
    <div className="flex flex-col gap-3 p-3">
      {content.title ? (
        <h2 className="text-[15px] font-semibold text-foreground">{content.title}</h2>
      ) : null}
      {content.brief ? (
        <p className="text-[12px] leading-relaxed text-muted-foreground/80">{content.brief}</p>
      ) : null}
      {content.blocks.map((block) => (
        <section key={block.id}>
          <BlockTitle title={block.title} summary={block.summary} />
          <BlockView block={block} />
        </section>
      ))}
    </div>
  );
}

function VisualPlanPanel({ visualPlan, mode, onClose }: VisualPlanPanelProps) {
  const content = useMemo(() => visualPlan?.content ?? null, [visualPlan]);

  return (
    <div
      className={cn(
        "visual-plan-surface flex min-h-0 flex-col bg-card/50",
        mode === "sidebar"
          ? "h-full w-[360px] shrink-0 border-l border-border/70"
          : "h-full w-full",
      )}
    >
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border/60 px-3">
        <Badge
          variant="secondary"
          className="rounded-md bg-violet-500/10 px-1.5 py-0 text-[10px] font-semibold tracking-wide text-violet-400 uppercase"
        >
          Visual Plan
        </Badge>
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

      <ScrollArea className="min-h-0 flex-1">
        {content ? (
          <VisualPlanDocument content={content} />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
            <div className="text-[13px] font-medium text-foreground/70">No visual plan yet</div>
            <p className="text-[11px] text-muted-foreground/60">
              Ask the agent to “render a visual plan” — it will appear here, ready to review.
            </p>
          </div>
        )}
      </ScrollArea>
    </div>
  );
}

export default memo(VisualPlanPanel);
export type { VisualPlanPanelProps };
