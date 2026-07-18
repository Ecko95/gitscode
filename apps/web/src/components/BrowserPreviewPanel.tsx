import type {
  BrowserPreviewAction,
  BrowserPreviewStatus,
  EnvironmentId,
  PortProtocol,
  PortRecord,
  ThreadId,
} from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import {
  ExternalLinkIcon,
  HandIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  RotateCcwIcon,
  StepForwardIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { readEnvironmentApi } from "../environmentApi";
import { getEnvironmentHttpBaseUrl, getSavedEnvironmentRecord } from "../environments/runtime";
import { openDesktopSshUrl } from "../localApi";
import { resolveEnvironmentPreviewUrl } from "../openEnvironmentUrl";
import { useKnownTerminalSessions } from "../terminalSessionState";
import { buildPortUrl, createManualPort, mergePortInventory } from "./BrowserPreviewPanel.logic";
import DevCommandsControl from "./DevCommandsControl";
import { Button } from "./ui/button";

interface BrowserPreviewPanelProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projectDir: string | null;
  readonly onClose: () => void;
}

function sourceLabel(port: PortRecord): string {
  return port.sources
    .map((source) => (source === "terminal" ? "terminal URL" : source))
    .join(" · ");
}

export function BrowserPreviewPanel({
  environmentId,
  threadId,
  projectDir,
  onClose,
}: BrowserPreviewPanelProps) {
  const [previewStatus, setPreviewStatus] = useState<BrowserPreviewStatus | null>(null);
  const [busyAction, setBusyAction] = useState<BrowserPreviewAction | "open" | "local" | null>(
    null,
  );
  const [browserUrl, setBrowserUrl] = useState("");
  const [controlError, setControlError] = useState<string | null>(null);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [manualPort, setManualPort] = useState("");
  const [manualProtocol, setManualProtocol] = useState<PortProtocol>("http");
  const [manualPorts, setManualPorts] = useState<ReadonlyArray<PortRecord>>([]);
  const terminalSessions = useKnownTerminalSessions({ environmentId, threadId: null });
  const api = readEnvironmentApi(environmentId);
  const remoteEnvironment = getSavedEnvironmentRecord(environmentId);
  const desktopSsh = remoteEnvironment?.desktopSsh;
  const portsAvailable = api?.ports !== undefined;

  const portsQuery = useQuery({
    queryKey: ["environment-ports", environmentId, projectDir, threadId],
    enabled: Boolean(projectDir && api?.ports),
    queryFn: async () => {
      if (!projectDir || !api?.ports)
        throw new Error("Ports are unavailable for this environment.");
      return api.ports.list({ projectDir, threadId });
    },
    refetchInterval: 5_000,
  });

  const terminalLifecycleKey = terminalSessions
    .map(
      (session) =>
        `${session.target.threadId}:${session.target.terminalId}:${session.state.status}:${session.state.hasRunningSubprocess}:${session.state.summary?.updatedAt ?? ""}`,
    )
    .join("|");
  const previousTerminalLifecycleKey = useRef(terminalLifecycleKey);
  useEffect(() => {
    if (previousTerminalLifecycleKey.current === terminalLifecycleKey) return;
    previousTerminalLifecycleKey.current = terminalLifecycleKey;
    if (projectDir && api?.ports) void portsQuery.refetch();
  }, [api?.ports, portsQuery, projectDir, terminalLifecycleKey]);

  const ports = useMemo(
    () =>
      mergePortInventory({
        serverPorts: portsQuery.data?.ports ?? [],
        terminalSessions,
        manualPorts,
      }),
    [manualPorts, portsQuery.data?.ports, terminalSessions],
  );

  const previewPort = useCallback(
    async (port: PortRecord) => {
      const url = buildPortUrl(port);
      if (!url) return;
      const environmentApi = readEnvironmentApi(environmentId);
      if (!environmentApi) throw new Error("The environment connection is unavailable.");
      setBusyAction("open");
      setControlError(null);
      try {
        await environmentApi.browserPreview.open({ threadId });
        const status = await environmentApi.browserPreview.control({
          threadId,
          action: "navigate",
          url,
        });
        setPreviewStatus(status);
        setBrowserUrl(url);
      } catch (cause) {
        setControlError(
          cause instanceof Error ? cause.message : "Browser preview failed to start.",
        );
      } finally {
        setBusyAction(null);
      }
    },
    [environmentId, threadId],
  );

  const control = useCallback(
    async (action: BrowserPreviewAction, url?: string) => {
      const environmentApi = readEnvironmentApi(environmentId);
      if (!environmentApi) return;
      setControlError(null);
      setBusyAction(action);
      try {
        setPreviewStatus(
          await environmentApi.browserPreview.control({
            threadId,
            action,
            ...(url ? { url } : {}),
          }),
        );
      } catch (cause) {
        setControlError(cause instanceof Error ? cause.message : "Browser control failed.");
      } finally {
        setBusyAction(null);
      }
    },
    [environmentId, threadId],
  );

  const openLocally = useCallback(
    async (port: PortRecord) => {
      const url = buildPortUrl(port);
      if (!desktopSsh || !url) return;
      setBusyAction("local");
      setControlError(null);
      try {
        const result = await openDesktopSshUrl({ target: desktopSsh, url });
        if (!result.opened) throw new Error("Unable to create the local SSH forward.");
      } catch (cause) {
        setControlError(cause instanceof Error ? cause.message : "Unable to open locally.");
      } finally {
        setBusyAction(null);
      }
    },
    [desktopSsh],
  );

  const previewUrl = useMemo(() => {
    const baseUrl = getEnvironmentHttpBaseUrl(environmentId);
    return baseUrl && previewStatus?.previewPath
      ? resolveEnvironmentPreviewUrl(baseUrl, previewStatus.previewPath)
      : null;
  }, [environmentId, previewStatus?.previewPath]);
  const canEmbedPreview =
    previewUrl !== null &&
    typeof window !== "undefined" &&
    new URL(previewUrl).origin === window.location.origin;
  const isPaused = previewStatus?.status === "paused";
  const isTakeover = previewStatus?.status === "takeover";

  return (
    <section className="flex h-full min-h-0 flex-col bg-card" aria-label="Ports and browser">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">Ports &amp; Browser</p>
          <p className="truncate text-[11px] text-muted-foreground">
            {projectDir ?? "No project selected"}
          </p>
        </div>
        <DevCommandsControl environmentId={environmentId} projectDir={projectDir} />
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Refresh ports"
          disabled={!projectDir || !portsAvailable || portsQuery.isFetching}
          onClick={() => void portsQuery.refetch()}
        >
          <RotateCcwIcon className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Close Ports and Browser"
          onClick={onClose}
        >
          <XIcon className="size-3.5" />
        </Button>
      </header>

      <div
        className="flex shrink-0 flex-wrap gap-x-1.5 border-b border-border px-3 py-1 text-[10px] text-muted-foreground"
        aria-label="Available port access"
      >
        <span>In GITS (VPS browser)</span>
        {desktopSsh ? (
          <>
            <span aria-hidden>·</span>
            <span>Local via SSH (this computer only)</span>
          </>
        ) : null}
      </div>

      <form
        className="flex shrink-0 gap-1 border-b border-border p-2"
        onSubmit={(event) => {
          event.preventDefault();
          try {
            const port = createManualPort(Number(manualPort), manualProtocol);
            setManualPorts((current) => [...current.filter((entry) => entry.id !== port.id), port]);
            setManualPort("");
            setControlError(null);
          } catch (cause) {
            setControlError(cause instanceof Error ? cause.message : "Invalid port.");
          }
        }}
      >
        <input
          inputMode="numeric"
          value={manualPort}
          onChange={(event) => setManualPort(event.target.value)}
          placeholder="5173"
          aria-label="Manual port"
          className="h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
          required
        />
        <select
          value={manualProtocol}
          onChange={(event) => setManualProtocol(event.target.value as PortProtocol)}
          aria-label="Protocol"
          className="h-7 rounded-md border border-input bg-background px-2 text-xs"
        >
          <option value="http">HTTP</option>
          <option value="https">HTTPS</option>
          <option value="tcp">TCP</option>
        </select>
        <Button type="submit" size="xs" variant="outline">
          <PlusIcon className="size-3" />
          Add port
        </Button>
      </form>

      {controlError ? (
        <p
          className="shrink-0 border-b border-destructive/30 bg-destructive/10 px-2 py-1 text-xs text-destructive"
          role="alert"
        >
          {controlError}
        </p>
      ) : null}
      {portsQuery.error ? (
        <p
          className="shrink-0 border-b border-border px-3 py-2 text-xs text-destructive"
          role="alert"
        >
          {portsQuery.error instanceof Error ? portsQuery.error.message : "Failed to list ports."}
        </p>
      ) : null}
      {portsQuery.data?.warnings.map((warning) => (
        <p
          key={warning}
          className="shrink-0 border-b border-border px-3 py-1 text-xs text-amber-600"
        >
          {warning}
        </p>
      ))}

      <div className="max-h-[42%] shrink-0 overflow-auto border-b border-border p-2">
        {ports.length === 0 ? (
          <p className="p-3 text-center text-xs text-muted-foreground">
            {!portsAvailable
              ? "Ports inventory is unavailable for this environment."
              : !projectDir
                ? "Select a project to discover ports."
                : portsQuery.isPending
                  ? "Loading environment ports…"
                  : "No ports observed."}
          </p>
        ) : (
          <div className="space-y-1.5">
            {ports.map((port) => {
              const url = buildPortUrl(port);
              return (
                <article
                  key={port.id}
                  data-port-id={port.id}
                  className="rounded-md border border-border bg-background p-2"
                >
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <span className="font-mono text-sm font-semibold">{port.remotePort}</span>
                        <span className="text-[10px] font-medium uppercase text-muted-foreground">
                          {port.protocol}
                        </span>
                        <span className="truncate text-xs">
                          {port.label ?? port.processName ?? "Port"}
                        </span>
                      </div>
                      <p className="text-[11px] text-muted-foreground">
                        {sourceLabel(port)} · {port.listenerStatus} · {port.ownership}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-wrap justify-end gap-1">
                      {url ? (
                        <Button
                          size="xs"
                          variant="outline"
                          aria-label={`Preview ${port.remotePort} in GITS`}
                          disabled={busyAction !== null}
                          onClick={() => void previewPort(port)}
                        >
                          Preview in GITS
                        </Button>
                      ) : null}
                      {desktopSsh && url ? (
                        <Button
                          size="xs"
                          variant="outline"
                          aria-label={`Open ${port.remotePort} locally`}
                          disabled={busyAction !== null}
                          onClick={() => void openLocally(port)}
                        >
                          Open locally
                        </Button>
                      ) : null}
                      {port.ownership === "unmanaged" ? (
                        <>
                          <Button
                            size="xs"
                            variant="ghost"
                            disabled
                            title="Use a configured Dev command"
                          >
                            Start
                          </Button>
                          <Button
                            size="xs"
                            variant="ghost"
                            disabled
                            title="Unmanaged listeners are view-only"
                          >
                            Stop
                          </Button>
                        </>
                      ) : null}
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-1 border-b border-border p-2">
          <span className="mr-auto text-xs font-medium">Browser supervision</span>
          <Button
            size="xs"
            variant={isPaused ? "default" : "outline"}
            disabled={!previewStatus || busyAction !== null}
            onClick={() => void control(isPaused ? "resume" : "pause")}
          >
            {isPaused ? <PlayIcon className="size-3" /> : <PauseIcon className="size-3" />}
            {isPaused ? "Resume" : "Pause"}
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={!previewStatus || busyAction !== null}
            onClick={() => void control("step")}
          >
            <StepForwardIcon className="size-3" />
            Step
          </Button>
          <Button
            size="xs"
            variant={isTakeover ? "default" : "outline"}
            disabled={!previewStatus || busyAction !== null}
            onClick={() => void control(isTakeover ? "release" : "takeover")}
          >
            <HandIcon className="size-3" />
            {isTakeover ? "Release" : "Take over"}
          </Button>
          <Button
            size="xs"
            variant="destructive"
            disabled={!previewStatus || busyAction !== null}
            onClick={() => void control("abort")}
          >
            <XIcon className="size-3" />
            Abort
          </Button>
        </div>

        {previewStatus ? (
          <form
            className="flex shrink-0 gap-1 border-b border-border p-2"
            onSubmit={(event) => {
              event.preventDefault();
              void control("navigate", browserUrl);
            }}
          >
            <input
              type="url"
              value={browserUrl}
              onChange={(event) => setBrowserUrl(event.target.value)}
              aria-label="Browser URL"
              className="h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-xs"
              required
            />
            <Button type="submit" size="xs" variant="outline" disabled={busyAction !== null}>
              Go
            </Button>
            <Button
              type="button"
              size="xs"
              variant={consoleOpen ? "default" : "outline"}
              disabled={busyAction !== null}
              onClick={() => {
                const nextOpen = !consoleOpen;
                setConsoleOpen(nextOpen);
                if (nextOpen) void control("console");
              }}
            >
              Console
            </Button>
          </form>
        ) : null}

        {consoleOpen ? (
          <pre className="max-h-32 shrink-0 overflow-auto border-b border-border bg-black p-2 text-[11px] text-zinc-100">
            {previewStatus?.consoleEntries.length
              ? previewStatus.consoleEntries.join("\n")
              : "No console entries."}
          </pre>
        ) : null}

        <div className="relative min-h-0 flex-1 bg-muted/30">
          {previewUrl && canEmbedPreview ? (
            <iframe
              key={previewUrl}
              src={previewUrl}
              title="Live automated browser"
              className="h-full w-full border-0"
              allow="clipboard-read; clipboard-write"
              sandbox="allow-scripts allow-forms allow-pointer-lock allow-popups allow-downloads"
            />
          ) : previewUrl ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
              <p className="max-w-sm text-sm text-muted-foreground">
                This saved environment preview opens in a separate authenticated tab.
              </p>
              <Button
                size="sm"
                variant="outline"
                aria-label="Open supervised browser"
                onClick={() => window.open(previewUrl, "_blank", "noopener,noreferrer")}
              >
                <ExternalLinkIcon className="size-3.5" />
                Open supervised browser
              </Button>
            </div>
          ) : (
            <div className="flex h-full items-center justify-center p-6 text-center">
              <p className="max-w-sm text-sm text-muted-foreground">
                Select an HTTP port to preview it in the isolated VPS browser.
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
