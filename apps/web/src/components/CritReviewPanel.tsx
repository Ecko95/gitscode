import { useEffect, useState } from "react";

import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { readEnvironmentApi } from "~/environmentApi";

import { DiffPanelLoadingState, DiffPanelShell, type DiffPanelMode } from "./DiffPanelShell";

interface CritReviewPanelProps {
  environmentId: EnvironmentId;
  workspaceRoot: string;
  branch: string;
  threadId: ThreadId;
  onUnavailable: () => void;
}

interface CritReviewState {
  status: string;
  url: string | null;
}

const CRIT_REVIEW_PANEL_MODE: DiffPanelMode = "sidebar";

export function CritReviewPanel(props: CritReviewPanelProps) {
  const { environmentId, workspaceRoot, branch, threadId, onUnavailable } = props;
  const [reviewState, setReviewState] = useState<CritReviewState>({
    status: "starting",
    url: null,
  });

  useEffect(() => {
    let cancelled = false;

    const api = readEnvironmentApi(environmentId);
    if (!api) {
      onUnavailable();
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
          onUnavailable();
          return;
        }
        setReviewState({ status: result.status, url: result.url });
      } catch {
        if (!cancelled) {
          onUnavailable();
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
  }, [environmentId, workspaceRoot, branch, threadId, onUnavailable]);

  const isReady = reviewState.status === "ready" && reviewState.url !== null;

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
