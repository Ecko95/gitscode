import { useEffect, useState } from "react";

import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { readEnvironmentApi } from "~/environmentApi";

import { DiffPanelLoadingState, DiffPanelShell, type DiffPanelMode } from "./DiffPanelShell";
import { Button } from "./ui/button";

interface CritReviewPanelProps {
  environmentId: EnvironmentId;
  workspaceRoot: string;
  branch: string;
  threadId: ThreadId;
  onSwitchToNativeDiff: () => void;
  /** @internal test-only: seeds the initial status to bypass useEffect for renderToStaticMarkup tests */
  __testInitialStatus?: CritReviewState["status"];
}

interface CritReviewState {
  status: "starting" | "ready" | "unavailable";
  url: string | null;
}

const CRIT_REVIEW_PANEL_MODE: DiffPanelMode = "sidebar";

export function CritReviewPanel(props: CritReviewPanelProps) {
  const {
    environmentId,
    workspaceRoot,
    branch,
    threadId,
    onSwitchToNativeDiff,
    __testInitialStatus,
  } = props;
  const [reviewState, setReviewState] = useState<CritReviewState>({
    status: __testInitialStatus ?? "starting",
    url: null,
  });

  useEffect(() => {
    let cancelled = false;

    const api = readEnvironmentApi(environmentId);
    if (!api) {
      setReviewState({ status: "unavailable", url: null });
      return;
    }

    setReviewState({ status: "starting", url: null });

    void (async () => {
      try {
        const result = await api.crit.ensureSidecar({ workspaceRoot, branch, threadId });
        if (cancelled) {
          return;
        }
        if (result.status === "crashed" || result.status === "stopped") {
          setReviewState({ status: "unavailable", url: null });
          return;
        }
        setReviewState({ status: result.status as CritReviewState["status"], url: result.url });
      } catch {
        if (!cancelled) {
          setReviewState({ status: "unavailable", url: null });
        }
      }
    })();

    return () => {
      cancelled = true;
      // Release the refCount this effect's ensureSidecar took. Fire-and-forget:
      // unmount / input-change must not await teardown, and a failed release is
      // non-fatal (the manager tears down at refCount 0 regardless). Capture the
      // same workspaceRoot the effect ensured so a changed-input cleanup releases
      // the prior workspace, not the next one.
      void api.crit.releaseSidecar({ workspaceRoot }).catch(() => {});
    };
  }, [environmentId, workspaceRoot, branch, threadId]);

  const isReady = reviewState.status === "ready" && reviewState.url !== null;

  if (reviewState.status === "unavailable") {
    return (
      <DiffPanelShell mode={CRIT_REVIEW_PANEL_MODE} header={null}>
        <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center text-sm text-muted-foreground">
          <p>Crit review is unavailable for this thread.</p>
          <Button type="button" size="sm" variant="outline" onClick={onSwitchToNativeDiff}>
            View native diff
          </Button>
        </div>
      </DiffPanelShell>
    );
  }

  return (
    <DiffPanelShell mode={CRIT_REVIEW_PANEL_MODE} header={null}>
      {isReady && reviewState.url !== null ? (
        <iframe
          title="Crit review"
          src={reviewState.url}
          className="h-full w-full border-0"
          sandbox="allow-scripts allow-forms allow-same-origin"
        />
      ) : (
        <DiffPanelLoadingState label="Starting crit review…" />
      )}
    </DiffPanelShell>
  );
}
