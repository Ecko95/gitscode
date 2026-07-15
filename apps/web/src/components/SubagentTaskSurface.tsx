import { memo, useEffect, useRef } from "react";
import { BotIcon, CheckIcon, CircleAlertIcon, LoaderIcon, SquareIcon, XIcon } from "lucide-react";

import { formatElapsed, type SubagentTask, type SubagentTaskStatus } from "../session-logic";
import { cn } from "~/lib/utils";

const SUBAGENT_ACCENTS = [
  {
    background: "bg-blue-500/12",
    border: "border-blue-500/30",
    text: "text-blue-400",
    dot: "bg-blue-400",
  },
  {
    background: "bg-violet-500/12",
    border: "border-violet-500/30",
    text: "text-violet-400",
    dot: "bg-violet-400",
  },
  {
    background: "bg-cyan-500/12",
    border: "border-cyan-500/30",
    text: "text-cyan-400",
    dot: "bg-cyan-400",
  },
  {
    background: "bg-amber-500/12",
    border: "border-amber-500/30",
    text: "text-amber-400",
    dot: "bg-amber-400",
  },
  {
    background: "bg-pink-500/12",
    border: "border-pink-500/30",
    text: "text-pink-400",
    dot: "bg-pink-400",
  },
  {
    background: "bg-emerald-500/12",
    border: "border-emerald-500/30",
    text: "text-emerald-400",
    dot: "bg-emerald-400",
  },
] as const;

export function subagentAccent(taskId: string) {
  let hash = 0;
  for (let index = 0; index < taskId.length; index += 1) {
    hash = (hash * 31 + taskId.charCodeAt(index)) | 0;
  }
  return SUBAGENT_ACCENTS[Math.abs(hash) % SUBAGENT_ACCENTS.length] ?? SUBAGENT_ACCENTS[0];
}

export function SubagentTaskIcon({ taskId, className }: { taskId: string; className?: string }) {
  const accent = subagentAccent(taskId);
  return (
    <span
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded-md border",
        accent.background,
        accent.border,
        accent.text,
        className,
      )}
    >
      <BotIcon className="size-3.5" aria-hidden />
    </span>
  );
}

function statusLabel(status: SubagentTaskStatus): string {
  switch (status) {
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "stopped":
      return "Stopped";
    case "running":
      return "Running";
  }
}

function StatusIcon({ status, className }: { status: SubagentTaskStatus; className?: string }) {
  if (status === "completed") {
    return <CheckIcon className={cn("size-3.5 text-emerald-400", className)} aria-hidden />;
  }
  if (status === "failed") {
    return <CircleAlertIcon className={cn("size-3.5 text-destructive", className)} aria-hidden />;
  }
  if (status === "stopped") {
    return <SquareIcon className={cn("size-3 text-amber-400", className)} aria-hidden />;
  }
  return (
    <LoaderIcon className={cn("size-3.5 animate-spin text-blue-400", className)} aria-hidden />
  );
}

export const SubagentTaskCard = memo(function SubagentTaskCard({
  task,
  onOpen,
}: {
  task: SubagentTask;
  onOpen: (taskId: string) => void;
}) {
  const latestLog = task.logs.at(-1);
  const accent = subagentAccent(task.id);
  return (
    <button
      aria-label={`Open agent task ${task.title}`}
      className={cn(
        "group w-full cursor-pointer rounded-lg border bg-background/45 px-2.5 py-2.5 text-left transition-colors",
        "hover:bg-background/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        accent.border,
      )}
      onClick={() => onOpen(task.id)}
      type="button"
    >
      <span className="flex min-w-0 items-start gap-2.5">
        <SubagentTaskIcon taskId={task.id} className="mt-0.5" />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center justify-between gap-2">
            <span className="truncate text-[13px] font-medium text-foreground/90">
              {task.title}
            </span>
            <span className="flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground/65">
              <StatusIcon status={task.status} />
              {statusLabel(task.status)}
            </span>
          </span>
          {latestLog ? (
            <span className="mt-1 line-clamp-2 block text-[11px] leading-relaxed text-muted-foreground/55">
              {latestLog.detail ?? latestLog.label}
            </span>
          ) : (
            <span className="mt-1 block text-[11px] text-muted-foreground/45">
              Waiting for activity…
            </span>
          )}
        </span>
      </span>
    </button>
  );
});

export const SubagentTaskTabs = memo(function SubagentTaskTabs({
  tasks,
  activeTaskId,
  onSelect,
  onClose,
}: {
  tasks: ReadonlyArray<SubagentTask>;
  activeTaskId: string | null;
  onSelect: (taskId: string | null) => void;
  onClose: (taskId: string) => void;
}) {
  return (
    <div
      aria-label="Chat tabs"
      className="flex h-10 shrink-0 items-end gap-1 overflow-x-auto border-b border-border/60 bg-card/35 px-2 pt-1"
      role="tablist"
    >
      <button
        aria-selected={activeTaskId === null}
        className={cn(
          "h-8 shrink-0 cursor-pointer rounded-t-md border border-b-0 px-3 text-xs transition-colors",
          activeTaskId === null
            ? "border-border/70 bg-background text-foreground"
            : "border-transparent text-muted-foreground hover:bg-muted/45 hover:text-foreground/80",
        )}
        onClick={() => onSelect(null)}
        role="tab"
        type="button"
      >
        Main
      </button>
      {tasks.map((task) => {
        const active = task.id === activeTaskId;
        const accent = subagentAccent(task.id);
        return (
          <div
            className={cn(
              "flex h-8 max-w-56 shrink-0 items-center rounded-t-md border border-b-0 transition-colors",
              active
                ? cn("bg-background", accent.border)
                : "border-transparent text-muted-foreground hover:bg-muted/45",
            )}
            key={task.id}
          >
            <button
              aria-selected={active}
              className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 py-1.5 pl-2.5 text-xs outline-none"
              onClick={() => onSelect(task.id)}
              role="tab"
              title={task.title}
              type="button"
            >
              <span className={cn("size-1.5 shrink-0 rounded-full", accent.dot)} />
              <span className={cn("truncate", active && "text-foreground")}>{task.title}</span>
            </button>
            <button
              aria-label={`Close ${task.title} tab`}
              className="mr-1 flex size-5 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground/55 hover:bg-muted hover:text-foreground"
              onClick={() => onClose(task.id)}
              type="button"
            >
              <XIcon className="size-3" aria-hidden />
            </button>
          </div>
        );
      })}
    </div>
  );
});

function formatTaskElapsed(task: SubagentTask): string {
  return formatElapsed(task.startedAt, task.completedAt ?? new Date().toISOString()) ?? "0ms";
}

function LiveTaskElapsed({ task }: { task: SubagentTask }) {
  const textRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const update = () => {
      if (textRef.current) textRef.current.textContent = formatTaskElapsed(task);
    };
    update();
    if (task.status !== "running") return;
    const interval = window.setInterval(update, 1_000);
    return () => window.clearInterval(interval);
  }, [task]);
  return <span ref={textRef}>{formatTaskElapsed(task)}</span>;
}

function logTime(createdAt: string): string {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export const SubagentTaskTranscript = memo(function SubagentTaskTranscript({
  task,
}: {
  task: SubagentTask;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const followOutputRef = useRef(true);
  const accent = subagentAccent(task.id);

  useEffect(() => {
    followOutputRef.current = true;
  }, [task.id]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !followOutputRef.current) return;
    viewport.scrollTop = viewport.scrollHeight;
  }, [task.id, task.logs.length]);

  return (
    <section
      className="flex min-h-0 flex-1 flex-col bg-background"
      aria-label="Agent task transcript"
    >
      <header className="shrink-0 border-b border-border/60 px-4 py-3 sm:px-6">
        <div className="mx-auto flex w-full max-w-4xl items-start gap-3">
          <SubagentTaskIcon taskId={task.id} className="mt-0.5 size-8" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <h2 className="min-w-0 truncate text-sm font-semibold text-foreground">
                {task.title}
              </h2>
              <span
                className={cn(
                  "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium",
                  accent.background,
                  accent.border,
                  accent.text,
                )}
              >
                <StatusIcon status={task.status} className="size-3" />
                {statusLabel(task.status)}
              </span>
              <span className="text-[11px] text-muted-foreground/55">
                <LiveTaskElapsed task={task} /> elapsed
              </span>
            </div>
            {task.description ? (
              <p className="mt-1.5 whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground/75">
                {task.description}
              </p>
            ) : null}
          </div>
        </div>
      </header>

      <div
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-6"
        onScroll={(event) => {
          const viewport = event.currentTarget;
          followOutputRef.current =
            viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 80;
        }}
        ref={viewportRef}
      >
        <div className="mx-auto w-full max-w-4xl space-y-2.5">
          {task.logs.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border/60 px-4 py-8 text-center text-xs text-muted-foreground/55">
              Waiting for the agent’s first activity…
            </div>
          ) : (
            task.logs.map((entry) => (
              <article
                className={cn(
                  "rounded-lg border border-border/55 bg-card/35 px-3 py-2.5",
                  entry.tone === "error" && "border-destructive/35 bg-destructive/5",
                )}
                key={entry.id}
              >
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      "size-1.5 shrink-0 rounded-full",
                      entry.tone === "error"
                        ? "bg-destructive"
                        : entry.tone === "tool"
                          ? accent.dot
                          : "bg-muted-foreground/50",
                    )}
                  />
                  <p className="min-w-0 flex-1 text-xs font-medium text-foreground/85">
                    {entry.label}
                  </p>
                  <time className="shrink-0 text-[10px] text-muted-foreground/45">
                    {logTime(entry.createdAt)}
                  </time>
                </div>
                {entry.detail ? (
                  <p className="mt-1.5 whitespace-pre-wrap break-words pl-3.5 font-mono text-[11px] leading-relaxed text-muted-foreground/75 select-text">
                    {entry.detail}
                  </p>
                ) : null}
              </article>
            ))
          )}
        </div>
      </div>
    </section>
  );
});
