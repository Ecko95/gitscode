import type {
  BrowserPreviewAction,
  BrowserPreviewStatus,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import { useCallback, useEffect, useState } from "react";
import {
  ExternalLinkIcon,
  HandIcon,
  PauseIcon,
  PlayIcon,
  RotateCcwIcon,
  StepForwardIcon,
  XIcon,
} from "lucide-react";

import { readEnvironmentApi } from "../environmentApi";
import { Button } from "./ui/button";

interface BrowserPreviewPanelProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly cwd: string | null;
  readonly onClose: () => void;
}

export function BrowserPreviewPanel({
  environmentId,
  threadId,
  cwd,
  onClose,
}: BrowserPreviewPanelProps) {
  const [preview_status, set_preview_status] = useState<BrowserPreviewStatus | null>(null);
  const [busy_action, set_busy_action] = useState<BrowserPreviewAction | "open" | "run-dev" | null>(
    "open",
  );
  const [browser_url, set_browser_url] = useState("");
  const [control_error, set_control_error] = useState<string | null>(null);
  const [console_open, set_console_open] = useState(false);

  const open_preview = useCallback(async () => {
    set_busy_action("open");
    try {
      const api = readEnvironmentApi(environmentId);
      if (!api) throw new Error("The environment connection is unavailable.");
      const status = await api.browserPreview.open({ threadId });
      set_preview_status(status);
      set_browser_url(status.terminalUrl ?? "");
    } catch (cause) {
      set_preview_status({
        available: false,
        status: "error",
        previewPath: null,
        terminalUrl: null,
        consoleEntries: [],
        expiresAt: null,
        message: cause instanceof Error ? cause.message : "Browser preview failed to start.",
      });
    } finally {
      set_busy_action(null);
    }
  }, [environmentId, threadId]);

  useEffect(() => {
    void open_preview();
  }, [open_preview]);

  const control = useCallback(
    async (action: BrowserPreviewAction, url?: string) => {
      const api = readEnvironmentApi(environmentId);
      if (!api) return;
      set_control_error(null);
      set_busy_action(action);
      try {
        set_preview_status(
          await api.browserPreview.control({ threadId, action, ...(url ? { url } : {}) }),
        );
      } catch (cause) {
        set_control_error(cause instanceof Error ? cause.message : "Browser control failed.");
      } finally {
        set_busy_action(null);
      }
    },
    [environmentId, threadId],
  );

  const is_paused = preview_status?.status === "paused";
  const is_takeover = preview_status?.status === "takeover";

  const run_dev = useCallback(async () => {
    const api = readEnvironmentApi(environmentId);
    if (!api || !cwd) return;
    set_busy_action("run-dev");
    set_control_error(null);
    try {
      await api.terminal.open({ threadId, terminalId: "browser-dev", cwd });
      await api.terminal.write({
        threadId,
        terminalId: "browser-dev",
        data: 'npm run dev -- --port "$GITS_PORT"\r',
      });
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 750));
        try {
          set_preview_status(
            await api.browserPreview.control({ threadId, action: "connect-localhost" }),
          );
          return;
        } catch {
          // The dev server may still be compiling.
        }
      }
      throw new Error("npm run dev started, but no local listener appeared.");
    } catch (cause) {
      set_control_error(cause instanceof Error ? cause.message : "Failed to start npm run dev.");
    } finally {
      set_busy_action(null);
    }
  }, [cwd, environmentId, threadId]);

  return (
    <section className="flex h-full min-h-0 flex-col bg-card" aria-label="Live browser preview">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm font-medium">
            <span
              className={`size-2 rounded-full ${preview_status?.status === "live" ? "bg-emerald-500" : "bg-amber-500"}`}
            />
            <span>Browser supervision</span>
          </div>
          <p className="truncate text-[11px] text-muted-foreground">
            Isolated to this chat session
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Open preview in new tab"
          disabled={!preview_status?.previewPath}
          onClick={() =>
            window.open(preview_status?.previewPath ?? "", "_blank", "noopener,noreferrer")
          }
        >
          <ExternalLinkIcon className="size-3.5" />
        </Button>
        <Button variant="ghost" size="icon-xs" aria-label="Close browser preview" onClick={onClose}>
          <XIcon className="size-3.5" />
        </Button>
      </header>

      <form
        className="flex shrink-0 gap-1 border-b border-border p-2"
        onSubmit={(event) => {
          event.preventDefault();
          void control("navigate", browser_url);
        }}
      >
        <input
          type="url"
          value={browser_url}
          onChange={(event) => set_browser_url(event.target.value)}
          placeholder="http://localhost:3000"
          aria-label="Browser URL"
          className="h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
          disabled={busy_action !== null}
          required
        />
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={busy_action !== null || !cwd}
          onClick={() => void run_dev()}
        >
          <PlayIcon className="size-3" />
          Run dev
        </Button>
        <Button
          type="submit"
          size="xs"
          variant="outline"
          disabled={busy_action !== null || browser_url.trim().length === 0}
        >
          Go
        </Button>
      </form>
      {control_error ? (
        <p
          className="shrink-0 border-b border-destructive/30 bg-destructive/10 px-2 py-1 text-xs text-destructive"
          role="alert"
        >
          {control_error}
        </p>
      ) : null}

      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border p-2">
        <Button
          size="xs"
          variant={is_paused ? "default" : "outline"}
          disabled={busy_action !== null}
          onClick={() => void control(is_paused ? "resume" : "pause")}
        >
          {is_paused ? <PlayIcon className="size-3" /> : <PauseIcon className="size-3" />}
          {is_paused ? "Resume" : "Pause"}
        </Button>
        <Button
          size="xs"
          variant="outline"
          disabled={busy_action !== null}
          onClick={() => void control("step")}
        >
          <StepForwardIcon className="size-3" />
          Step
        </Button>
        <Button
          size="xs"
          variant={is_takeover ? "default" : "outline"}
          disabled={busy_action !== null}
          onClick={() => void control(is_takeover ? "release" : "takeover")}
        >
          <HandIcon className="size-3" />
          {is_takeover ? "Release" : "Take over"}
        </Button>
        <Button
          size="xs"
          variant="destructive"
          disabled={busy_action !== null}
          onClick={() => void control("abort")}
        >
          <XIcon className="size-3" />
          Abort
        </Button>
        <Button
          size="xs"
          variant={console_open ? "default" : "outline"}
          disabled={busy_action !== null}
          onClick={() => {
            const next_open = !console_open;
            set_console_open(next_open);
            if (next_open) void control("console");
          }}
        >
          Console
        </Button>
      </div>

      {console_open ? (
        <pre className="max-h-40 shrink-0 overflow-auto border-b border-border bg-black p-2 text-[11px] text-zinc-100">
          {preview_status?.consoleEntries.length
            ? preview_status.consoleEntries.join("\n")
            : "No console entries."}
        </pre>
      ) : null}

      <div className="relative min-h-0 flex-1 bg-muted/30">
        {preview_status?.previewPath ? (
          <iframe
            key={preview_status.previewPath}
            src={preview_status.previewPath}
            title="Live automated browser"
            className="h-full w-full border-0"
            allow="clipboard-read; clipboard-write"
            sandbox="allow-scripts allow-forms allow-pointer-lock allow-popups allow-downloads"
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
            <p className="max-w-sm text-sm text-muted-foreground">
              {busy_action === "open"
                ? "Starting the isolated browser session…"
                : (preview_status?.message ?? "Browser preview is not available.")}
            </p>
            <Button
              size="sm"
              variant="outline"
              disabled={busy_action !== null}
              onClick={() => void open_preview()}
            >
              <RotateCcwIcon className="size-3.5" />
              Retry
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}
