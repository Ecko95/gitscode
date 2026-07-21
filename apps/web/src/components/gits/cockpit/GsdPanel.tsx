import type {
  GitsCockpitProject,
  OpenGsdCommandResult,
  OpenGsdStatusResult,
} from "@t3tools/contracts";
import { FilePlus2Icon, PlayIcon, RefreshCwIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";

import { EmptyState, SectionHeader, StatusPill, formatCount, statusTone } from "./primitives";

function commandResultTone(status: OpenGsdCommandResult["status"]): ReturnType<typeof statusTone> {
  if (status === "completed") {
    return "success";
  }
  return status === "timed-out" ? "warning" : "danger";
}

export function OpenGsdPanel({
  status,
  loading,
  error,
  projects,
  selectedProjectRoot,
  initInput,
  autoInitInput,
  model,
  maxBudget,
  commandResult,
  actionError,
  actionPending,
  onRefresh,
  onProjectRootChange,
  onInitInputChange,
  onAutoInitInputChange,
  onModelChange,
  onMaxBudgetChange,
  onInit,
  onAuto,
}: {
  status: OpenGsdStatusResult | undefined;
  loading: boolean;
  error: unknown;
  projects: ReadonlyArray<GitsCockpitProject>;
  selectedProjectRoot: string;
  initInput: string;
  autoInitInput: string;
  model: string;
  maxBudget: string;
  commandResult: OpenGsdCommandResult | undefined;
  actionError: unknown;
  actionPending: boolean;
  onRefresh: () => void;
  onProjectRootChange: (value: string) => void;
  onInitInputChange: (value: string) => void;
  onAutoInitInputChange: (value: string) => void;
  onModelChange: (value: string) => void;
  onMaxBudgetChange: (value: string) => void;
  onInit: () => void;
  onAuto: () => void;
}) {
  const supported = new Set(status?.supported ?? []);
  const canInit =
    supported.has("init") && selectedProjectRoot.trim().length > 0 && initInput.trim().length > 0;
  const canAuto = supported.has("auto") && selectedProjectRoot.trim().length > 0;
  const errorMessage =
    error instanceof Error
      ? error.message
      : actionError instanceof Error
        ? actionError.message
        : null;

  return (
    <section className="border-b border-border bg-background">
      <div className="flex flex-col gap-3 border-b border-border/70 px-4 py-4 sm:flex-row sm:items-start sm:justify-between sm:px-5">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="truncate text-base font-semibold">Open GSD</h2>
            <StatusPill
              label={status?.available ? "available" : "unavailable"}
              tone={status?.available ? "success" : "warning"}
            />
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {status?.cliName ?? "gsd-sdk"} | {status?.packageName ?? "@opengsd/get-shit-done-redux"}{" "}
            | {status?.version ?? "version unknown"}
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={onRefresh} disabled={loading}>
          <RefreshCwIcon className={cn("size-3.5", loading && "animate-spin")} />
          Refresh
        </Button>
      </div>

      {errorMessage ? (
        <div
          aria-live="polite"
          className="border-b border-border/60 px-4 py-2 text-xs text-destructive sm:px-5"
        >
          {errorMessage}
        </div>
      ) : null}

      <div className="grid min-w-0 grid-cols-1 xl:grid-cols-[minmax(0,1fr)_minmax(380px,0.8fr)]">
        <div className="grid min-w-0 gap-3 border-r border-border/60 px-4 py-4 sm:px-5">
          <select
            value={selectedProjectRoot}
            className="h-8 min-w-0 rounded-md border border-input bg-background px-3 text-xs"
            onChange={(event) => onProjectRootChange(event.currentTarget.value)}
          >
            {projects.length === 0 ? (
              <option value="">No project</option>
            ) : (
              projects.map((project) => (
                <option key={project.project.id} value={project.project.rootPath}>
                  {project.project.title}
                </option>
              ))
            )}
          </select>

          <div className="grid gap-2 sm:grid-cols-2">
            <Input
              nativeInput
              size="sm"
              value={model}
              placeholder="Model"
              onChange={(event) => onModelChange(event.currentTarget.value)}
            />
            <Input
              nativeInput
              size="sm"
              value={maxBudget}
              placeholder="Max budget USD"
              onChange={(event) => onMaxBudgetChange(event.currentTarget.value)}
            />
          </div>

          <div className="grid gap-2">
            <Input
              nativeInput
              size="sm"
              value={initInput}
              placeholder="@docs/prd.md"
              onChange={(event) => onInitInputChange(event.currentTarget.value)}
            />
            <div className="flex justify-end">
              <Button size="sm" onClick={onInit} disabled={!canInit || actionPending}>
                <FilePlus2Icon className="size-3.5" />
                Init
              </Button>
            </div>
          </div>

          <div className="grid gap-2">
            <Input
              nativeInput
              size="sm"
              value={autoInitInput}
              placeholder="Optional @prd"
              onChange={(event) => onAutoInitInputChange(event.currentTarget.value)}
            />
            <div className="flex justify-end">
              <Button
                size="sm"
                variant="outline"
                onClick={onAuto}
                disabled={!canAuto || actionPending}
              >
                <PlayIcon className="size-3.5" />
                Auto
              </Button>
            </div>
          </div>
        </div>

        <div className="min-w-0">
          <SectionHeader title="Last Open GSD run" count={commandResult ? 1 : 0} />
          {commandResult ? (
            <div className="grid gap-3 px-4 py-3 text-xs sm:px-5">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <StatusPill
                  label={commandResult.status}
                  tone={commandResultTone(commandResult.status)}
                />
                <span className="font-mono text-muted-foreground">
                  {commandResult.command} | {formatCount(commandResult.durationMs)} ms
                </span>
              </div>
              <div className="truncate font-mono text-[11px] text-muted-foreground">
                {commandResult.args.join(" ")}
              </div>
              <div className="overflow-hidden rounded-md border border-border/70 bg-muted/20">
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap px-3 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
                  {[commandResult.stdout, commandResult.stderr].filter(Boolean).join("\n") ||
                    "No command output."}
                </pre>
              </div>
            </div>
          ) : (
            <EmptyState label="No Open GSD command has run in this cockpit session." />
          )}
        </div>
      </div>
    </section>
  );
}
