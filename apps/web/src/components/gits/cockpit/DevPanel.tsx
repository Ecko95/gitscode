import type { GitsDevCommand, GitsDevCommandListResult } from "@t3tools/contracts";
import { CircleStopIcon, CopyIcon, ExternalLinkIcon, PlayIcon, RefreshCwIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";

import { StatusPill, formatIsoDate, statusTone } from "./primitives";
import { motokoSelectedRouteLabel } from "./MotokoPanel";
import type { DevCommandSessionState } from "./useDevCommandSessions";

export function handleDevOpenPreview(command: GitsDevCommand): void {
  if (!command.previewUrl) {
    return;
  }
  window.open(command.previewUrl, "_blank", "noopener,noreferrer");
}

function devCommandStatusTone(
  status: DevCommandSessionState["status"],
): ReturnType<typeof statusTone> {
  if (status === "running") {
    return "success";
  }
  if (status === "starting") {
    return "warning";
  }
  if (status === "error") {
    return "danger";
  }
  return "default";
}

export function DevCommandPanel({
  list,
  loading,
  error,
  selectedProjectRoot,
  onRefresh,
  sessionStateByCommandId,
  activeCommandId,
  actionError,
  actionPending,
  onStart,
  onStop,
  onCopyLaunchCommand,
  onOpenPreview,
}: {
  list: GitsDevCommandListResult | undefined;
  loading: boolean;
  error: unknown;
  selectedProjectRoot: string;
  onRefresh: () => void;
  sessionStateByCommandId: Readonly<Record<string, DevCommandSessionState | undefined>>;
  activeCommandId: string | null;
  actionError: string | null;
  actionPending: boolean;
  onStart: (command: GitsDevCommand) => void;
  onStop: (command: GitsDevCommand) => void;
  onCopyLaunchCommand: (command: GitsDevCommand) => void;
  onOpenPreview: (command: GitsDevCommand) => void;
}) {
  return (
    <section className="border-b border-border/60">
      <div className="flex min-w-0 flex-col gap-3 px-4 py-4 sm:px-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold">Dev Commands</h2>
            <p className="text-xs text-muted-foreground">
              Repo launchers start terminal sessions directly and can publish previews on the
              tailnet after the port is ready.
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={onRefresh} disabled={loading}>
            <RefreshCwIcon className={cn("size-3.5", loading && "animate-spin")} />
            Refresh
          </Button>
        </div>
        <div className="grid gap-1 text-xs text-muted-foreground">
          <div>Route: {motokoSelectedRouteLabel(selectedProjectRoot)}</div>
          <div>Config: {list?.configPath ?? "Missing"}</div>
          {list ? (
            <div>
              Bind: <span className="font-mono">{list.bindHost}</span> · Allowed hosts:{" "}
              {list.allowedHosts.length > 0 ? (
                <span className="font-mono">{list.allowedHosts.join(", ")}</span>
              ) : (
                <span title="Dev servers will reject requests proxied from any other hostname.">
                  localhost only — set GITS_DEV_ALLOWED_HOSTS
                </span>
              )}
            </div>
          ) : null}
          {list?.magicDnsName ? <div>Tailnet: {list.magicDnsName}</div> : null}
        </div>
        {list?.warnings.length ? (
          <div className="rounded-sm border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            {list.warnings.join(" ")}
          </div>
        ) : null}
        {actionError ? (
          <div
            aria-live="polite"
            className="rounded-sm border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
          >
            {actionError}
          </div>
        ) : null}
      </div>

      {loading ? (
        <div className="px-4 py-6 text-sm text-muted-foreground sm:px-5">
          Loading dev commands...
        </div>
      ) : error ? (
        <div className="px-4 py-6 text-sm text-destructive sm:px-5">
          {error instanceof Error ? error.message : "Failed to load dev commands."}
        </div>
      ) : !list || list.commands.length === 0 ? (
        <div className="px-4 py-6 text-sm text-muted-foreground sm:px-5">
          No repo launchers found.
        </div>
      ) : (
        <div className="divide-y divide-border/60">
          {list.commands.map((command) => {
            const session = sessionStateByCommandId[command.id];
            const status = session?.status ?? "idle";
            return (
              <div key={command.id} className="grid gap-3 px-4 py-4 sm:px-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div role="status" className="flex flex-wrap items-center gap-2">
                      <h3 className="text-sm font-medium">{command.name}</h3>
                      <StatusPill label={status} tone={devCommandStatusTone(status)} />
                      {command.localPort !== null ? (
                        <span className="font-mono text-[11px] text-muted-foreground">
                          {command.localHost ?? "127.0.0.1"}:{command.localPort}
                        </span>
                      ) : null}
                      {command.previewUrl ? (
                        <span className="font-mono text-[11px] text-muted-foreground">
                          {command.previewUrl}
                        </span>
                      ) : null}
                    </div>
                    {command.description ? (
                      <p className="mt-1 text-xs text-muted-foreground">{command.description}</p>
                    ) : null}
                    <div className="mt-2 grid gap-1 font-mono text-[11px] text-muted-foreground">
                      <div>{command.cwd}</div>
                      <div>{command.command}</div>
                      {session?.label ? <div>Session: {session.label}</div> : null}
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="default"
                      onClick={() => onStart(command)}
                      disabled={actionPending && activeCommandId === command.id}
                    >
                      <PlayIcon className="size-3.5" />
                      Start
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => onStop(command)}
                      disabled={actionPending && activeCommandId === command.id}
                    >
                      <CircleStopIcon className="size-3.5" />
                      Stop
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => onCopyLaunchCommand(command)}
                      aria-label={`Copy launch command for ${command.name}`}
                    >
                      <CopyIcon className="size-3.5" />
                    </Button>
                    {command.previewUrl ? (
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => onOpenPreview(command)}
                        aria-label={`Open preview for ${command.name}`}
                      >
                        <ExternalLinkIcon className="size-3.5" />
                      </Button>
                    ) : null}
                  </div>
                </div>
                <div className="rounded-sm border border-border/60 bg-muted/20">
                  <div className="flex items-center justify-between border-b border-border/60 px-3 py-2">
                    <span className="text-[11px] font-medium uppercase text-muted-foreground">
                      Terminal
                    </span>
                    <span className="font-mono text-[11px] text-muted-foreground">
                      {session?.updatedAt ? formatIsoDate(session.updatedAt) : "idle"}
                    </span>
                  </div>
                  <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[11px] text-foreground">
                    {session?.log?.trim().length ? session.log : "No output yet."}
                  </pre>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
