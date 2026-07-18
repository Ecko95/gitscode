import type { EnvironmentId } from "@t3tools/contracts";
import {
  ExternalLinkIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "~/components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import {
  useGitStackedAction,
  useSourceControlActionRunning,
} from "~/lib/sourceControlActions";
import { cn, randomUUID } from "~/lib/utils";
import { refreshVcsStatus, useVcsStatus } from "~/lib/vcsStatusState";
import { GitChecksPane } from "../GitChecksPane";
import {
  type GitStatusTone,
  resolvePrActions,
  summarizeGitStatus,
} from "./GitStatusTab.logic";

const RUNNING_SOURCE_CONTROL_ACTIONS = [
  "runStackedAction",
  "pull",
  "publishRepository",
  "preparePullRequestThread",
] as const;

const TONE_DOT_CLASS: Record<GitStatusTone, string> = {
  ok: "bg-success",
  warning: "bg-warning",
  blocked: "bg-destructive",
  neutral: "bg-muted-foreground",
};

interface GitStatusTabProps {
  environmentId: EnvironmentId;
  gitCwd: string | null;
  onReviewPullRequest?: (reference: string) => void;
}

export function GitStatusTab({
  environmentId,
  gitCwd,
  onReviewPullRequest,
}: GitStatusTabProps) {
  const scope = useMemo(
    () => ({ environmentId, cwd: gitCwd }),
    [environmentId, gitCwd],
  );
  const { data: gitStatus } = useVcsStatus(scope);
  const isBusy = useSourceControlActionRunning(
    scope,
    RUNNING_SOURCE_CONTROL_ACTIONS,
  );
  const createPrAction = useGitStackedAction(scope);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const summary = summarizeGitStatus(gitStatus);
  const { createPr, openPr, review } = resolvePrActions(
    gitStatus,
    isBusy || createPrAction.isPending,
  );
  const createPrError =
    createPrAction.error instanceof Error ? createPrAction.error.message : null;

  if (!gitCwd) {
    return null;
  }

  const runRefresh = () => {
    setIsRefreshing(true);
    void refreshVcsStatus(scope)
      .catch(() => undefined)
      .finally(() => setIsRefreshing(false));
  };

  const runCreatePr = () => {
    void createPrAction
      .run({ actionId: randomUUID(), action: "create_pr" })
      .catch(() => undefined);
  };

  return (
    <Popover
      onOpenChange={(open) => {
        if (open) {
          void refreshVcsStatus(scope).catch(() => undefined);
        }
      }}
    >
      <PopoverTrigger
        render={
          <Button
            aria-label={`Git status: ${summary.label}`}
            className="relative shrink-0"
            data-testid="git-status-tab-trigger"
            size="icon-xs"
            variant="outline"
          />
        }
      >
        <GitBranchIcon aria-hidden="true" className="size-3" />
        <span
          aria-hidden="true"
          className={cn(
            "absolute top-1 right-1 size-1.5 rounded-full",
            TONE_DOT_CLASS[summary.tone],
          )}
          data-testid="git-status-tab-dot"
        />
      </PopoverTrigger>
      <PopoverPopup
        align="end"
        className="w-88"
        data-testid="git-status-tab-panel"
        side="bottom"
      >
        <div className="flex items-center justify-between gap-2 px-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <GitBranchIcon
              aria-hidden="true"
              className="size-3.5 shrink-0 text-muted-foreground"
            />
            <span
              className="truncate font-mono text-xs font-medium"
              title={summary.branchLabel}
            >
              {summary.branchLabel}
            </span>
          </div>
          <Button
            aria-label="Refresh git status"
            disabled={isRefreshing}
            onClick={runRefresh}
            size="icon-xs"
            variant="ghost"
          >
            <RefreshCwIcon
              aria-hidden="true"
              className={cn("size-3.5", isRefreshing && "animate-spin")}
            />
          </Button>
        </div>
        <GitChecksPane gitStatus={gitStatus} />
        {createPr || openPr || (review && onReviewPullRequest) ? (
          <div className="mt-1 flex flex-wrap items-center gap-2 px-1">
            {createPr ? (
              <Button
                disabled={isBusy || createPrAction.isPending}
                onClick={runCreatePr}
                size="xs"
                variant="outline"
              >
                <GitPullRequestIcon aria-hidden="true" className="size-3.5" />
                {createPrAction.isPending ? "Creating..." : createPr.label}
              </Button>
            ) : null}
            {openPr ? (
              <Button
                render={
                  <a
                    href={openPr.url}
                    rel="noopener noreferrer"
                    target="_blank"
                  />
                }
                size="xs"
                variant="outline"
              >
                <ExternalLinkIcon aria-hidden="true" className="size-3.5" />
                {openPr.label}
              </Button>
            ) : null}
            {review && onReviewPullRequest ? (
              <Button
                onClick={() => onReviewPullRequest(review.reference)}
                size="xs"
                variant="ghost"
              >
                Review in thread
              </Button>
            ) : null}
          </div>
        ) : null}
        {createPrError ? (
          <p className="mt-2 px-1 text-xs text-destructive">{createPrError}</p>
        ) : null}
      </PopoverPopup>
    </Popover>
  );
}
