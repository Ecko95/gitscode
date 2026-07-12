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
  readonly onClose: () => void;
}

export function BrowserPreviewPanel({
  environmentId,
  threadId,
  onClose,
}: BrowserPreviewPanelProps) {
  const [preview_status, set_preview_status] = useState<BrowserPreviewStatus | null>(null);
  const [busy_action, set_busy_action] = useState<BrowserPreviewAction | "open" | null>("open");

  const open_preview = useCallback(async () => {
    set_busy_action("open");
    try {
      const api = readEnvironmentApi(environmentId);
      if (!api) throw new Error("The environment connection is unavailable.");
      set_preview_status(await api.browserPreview.open({ threadId }));
    } catch (cause) {
      set_preview_status({
        available: false,
        status: "error",
        previewPath: null,
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
    async (action: BrowserPreviewAction) => {
      const api = readEnvironmentApi(environmentId);
      if (!api) return;
      set_busy_action(action);
      try {
        set_preview_status(await api.browserPreview.control({ threadId, action }));
      } finally {
        set_busy_action(null);
      }
    },
    [environmentId, threadId],
  );

  const is_paused = preview_status?.status === "paused";
  const is_takeover = preview_status?.status === "takeover";

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
      </div>

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
