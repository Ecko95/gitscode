import { memo, useState, useCallback, useMemo } from "react";
import type { DelamainPeer, EnvironmentId } from "@t3tools/contracts";
import { type TimestampFormat } from "@t3tools/contracts/settings";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { ScrollArea } from "./ui/scroll-area";
import ChatMarkdown from "./ChatMarkdown";
import {
  BotIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  EllipsisIcon,
  GitBranchIcon,
  LoaderIcon,
  PanelRightCloseIcon,
} from "lucide-react";
import { cn } from "~/lib/utils";
import { readGitsEnvironmentClient } from "~/gitsClient";
import type { ActivePlanState } from "../session-logic";
import type { LatestProposedPlanState } from "../session-logic";
import { formatTimestamp } from "../timestampFormat";
import {
  proposedPlanTitle,
  buildProposedPlanMarkdownFilename,
  normalizePlanMarkdownForExport,
  downloadPlanAsTextFile,
  stripDisplayedPlanMarkdown,
} from "../proposedPlan";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu";
import { readEnvironmentApi } from "~/environmentApi";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";

function stepStatusIcon(status: string): React.ReactNode {
  if (status === "completed") {
    return (
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-500">
        <CheckIcon className="size-3" />
      </span>
    );
  }
  if (status === "inProgress") {
    return (
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-blue-500/15 text-blue-400">
        <LoaderIcon className="size-3 animate-spin" />
      </span>
    );
  }
  return (
    <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-border/60 bg-muted/30">
      <span className="size-1.5 rounded-full bg-muted-foreground/30" />
    </span>
  );
}

const ACTIVE_PEER_STATUSES = new Set(["pending", "running", "blocked", "waiting", "frozen"]);

function delamainStatusClassName(peer: DelamainPeer): string {
  if (peer.status === "done" || peer.status === "completed") {
    return "bg-emerald-500/10 text-emerald-500";
  }
  if (peer.status === "failed" || peer.status === "killed" || peer.status === "halted") {
    return "bg-destructive/10 text-destructive";
  }
  if (peer.status === "waiting" || peer.status === "blocked" || peer.status === "frozen") {
    return "bg-amber-500/10 text-amber-500";
  }
  if (peer.status === "running" || peer.status === "pending") {
    return "bg-blue-500/10 text-blue-400";
  }
  return "bg-muted text-muted-foreground";
}

function pathLabel(path: string | null): string | null {
  if (!path) return null;
  const parts = path.split("/").filter(Boolean);
  if (parts.length === 0) return path;
  return parts.slice(-2).join("/");
}

function peerSortValue(peer: DelamainPeer): string {
  return peer.updatedAt ?? peer.startedAt ?? "";
}

function sortDelamainPeers(left: DelamainPeer, right: DelamainPeer): number {
  const leftActive = ACTIVE_PEER_STATUSES.has(left.status) ? 1 : 0;
  const rightActive = ACTIVE_PEER_STATUSES.has(right.status) ? 1 : 0;
  if (leftActive !== rightActive) return rightActive - leftActive;
  return peerSortValue(right).localeCompare(peerSortValue(left));
}

interface PlanSidebarProps {
  activePlan: ActivePlanState | null;
  activeProposedPlan: LatestProposedPlanState | null;
  label?: string;
  environmentId: EnvironmentId;
  markdownCwd: string | undefined;
  workspaceRoot: string | undefined;
  timestampFormat: TimestampFormat;
  mode?: "sheet" | "sidebar";
  onClose: () => void;
}

const PlanSidebar = memo(function PlanSidebar({
  activePlan,
  activeProposedPlan,
  label = "Plan",
  environmentId,
  markdownCwd,
  workspaceRoot,
  timestampFormat,
  mode = "sidebar",
  onClose,
}: PlanSidebarProps) {
  const [proposedPlanExpanded, setProposedPlanExpanded] = useState(false);
  const [isSavingToWorkspace, setIsSavingToWorkspace] = useState(false);
  const { copyToClipboard, isCopied } = useCopyToClipboard();

  const planMarkdown = activeProposedPlan?.planMarkdown ?? null;
  const displayedPlanMarkdown = planMarkdown ? stripDisplayedPlanMarkdown(planMarkdown) : null;
  const planTitle = planMarkdown ? proposedPlanTitle(planMarkdown) : null;
  const delamainPeersQuery = useQuery({
    queryKey: ["gits", "delamain", "peers", environmentId],
    queryFn: async () => {
      const client = readGitsEnvironmentClient(environmentId);
      if (!client) return null;
      return client.delamain.listPeers();
    },
    refetchInterval: 10_000,
    retry: false,
  });
  const delamainPeers = useMemo(
    () => [...(delamainPeersQuery.data?.peers ?? [])].sort(sortDelamainPeers),
    [delamainPeersQuery.data?.peers],
  );
  const visibleDelamainPeers = delamainPeers.slice(0, 6);
  const hiddenDelamainPeerCount = Math.max(0, delamainPeers.length - visibleDelamainPeers.length);

  const handleCopyPlan = useCallback(() => {
    if (!planMarkdown) return;
    copyToClipboard(planMarkdown);
  }, [planMarkdown, copyToClipboard]);

  const handleDownload = useCallback(() => {
    if (!planMarkdown) return;
    const filename = buildProposedPlanMarkdownFilename(planMarkdown);
    downloadPlanAsTextFile(filename, normalizePlanMarkdownForExport(planMarkdown));
  }, [planMarkdown]);

  const handleSaveToWorkspace = useCallback(() => {
    const api = readEnvironmentApi(environmentId);
    if (!api || !workspaceRoot || !planMarkdown) return;
    const filename = buildProposedPlanMarkdownFilename(planMarkdown);
    setIsSavingToWorkspace(true);
    void api.projects
      .writeFile({
        cwd: workspaceRoot,
        relativePath: filename,
        contents: normalizePlanMarkdownForExport(planMarkdown),
      })
      .then((result) => {
        toastManager.add({
          type: "success",
          title: "Plan saved",
          description: result.relativePath,
        });
      })
      .catch((error) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not save plan",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      })
      .then(
        () => setIsSavingToWorkspace(false),
        () => setIsSavingToWorkspace(false),
      );
  }, [environmentId, planMarkdown, workspaceRoot]);

  return (
    <div
      className={cn(
        "flex min-h-0 flex-col bg-card/50",
        mode === "sidebar"
          ? "h-full w-[340px] shrink-0 border-l border-border/70"
          : "h-full w-full",
      )}
    >
      {/* Header */}
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border/60 px-3">
        <div className="flex items-center gap-2">
          <Badge
            variant="secondary"
            className="rounded-md bg-blue-500/10 px-1.5 py-0 text-[10px] font-semibold tracking-wide text-blue-400 uppercase"
          >
            {label}
          </Badge>
          {activePlan ? (
            <span className="text-[11px] text-muted-foreground/60">
              {formatTimestamp(activePlan.createdAt, timestampFormat)}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-1">
          {planMarkdown ? (
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="text-muted-foreground/50 hover:text-foreground/70"
                    aria-label="Plan actions"
                  />
                }
              >
                <EllipsisIcon className="size-3.5" />
              </MenuTrigger>
              <MenuPopup align="end">
                <MenuItem onClick={handleCopyPlan}>
                  {isCopied ? "Copied!" : "Copy to clipboard"}
                </MenuItem>
                <MenuItem onClick={handleDownload}>Download as markdown</MenuItem>
                <MenuItem
                  onClick={handleSaveToWorkspace}
                  disabled={!workspaceRoot || isSavingToWorkspace}
                >
                  Save to workspace
                </MenuItem>
              </MenuPopup>
            </Menu>
          ) : null}
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={onClose}
            aria-label={`Close ${label.toLowerCase()} sidebar`}
            className="text-muted-foreground/50 hover:text-foreground/70"
          >
            <PanelRightCloseIcon className="size-3.5" />
          </Button>
        </div>
      </div>

      {/* Content */}
      <ScrollArea className="min-h-0 flex-1">
        <div className="p-3 space-y-4">
          {visibleDelamainPeers.length > 0 ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-[10px] font-semibold tracking-widest text-muted-foreground/40 uppercase">
                  Deployed Delamain peers
                </p>
                <Badge
                  variant="secondary"
                  className="rounded-md bg-muted px-1.5 py-0 text-[10px] text-muted-foreground"
                >
                  {delamainPeers.length}
                </Badge>
              </div>
              <div className="space-y-1.5">
                {visibleDelamainPeers.map((peer) => {
                  const repoLabel = pathLabel(peer.sourceRepo ?? peer.worktreePath);
                  const title = peer.name ?? peer.id;
                  return (
                    <div
                      key={peer.id}
                      className="rounded-lg border border-border/50 bg-background/45 px-2.5 py-2"
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <BotIcon className="size-3.5 shrink-0 text-muted-foreground/50" />
                        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground/85">
                          {title}
                        </span>
                        <span
                          className={cn(
                            "shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-medium",
                            delamainStatusClassName(peer),
                          )}
                        >
                          {peer.rawStatus}
                        </span>
                      </div>
                      <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground/55">
                        <GitBranchIcon className="size-3 shrink-0" />
                        <span className="truncate">{peer.branch ?? "no branch"}</span>
                        {repoLabel ? (
                          <>
                            <span className="shrink-0 text-muted-foreground/30">|</span>
                            <span className="truncate">{repoLabel}</span>
                          </>
                        ) : null}
                      </div>
                      {peer.lastEvent || peer.task ? (
                        <p className="mt-1 truncate text-[11px] text-muted-foreground/45">
                          {peer.lastEvent ?? peer.task}
                        </p>
                      ) : null}
                    </div>
                  );
                })}
              </div>
              {hiddenDelamainPeerCount > 0 ? (
                <p className="px-1 text-[11px] text-muted-foreground/40">
                  +{hiddenDelamainPeerCount} more in Delamain.
                </p>
              ) : null}
            </div>
          ) : null}

          {/* Explanation */}
          {activePlan?.explanation ? (
            <p className="text-[13px] leading-relaxed text-muted-foreground/80">
              {activePlan.explanation}
            </p>
          ) : null}

          {/* Plan Steps */}
          {activePlan && activePlan.steps.length > 0 ? (
            <div className="space-y-1">
              <p className="mb-2 text-[10px] font-semibold tracking-widest text-muted-foreground/40 uppercase">
                Steps
              </p>
              {activePlan.steps.map((step) => (
                <div
                  key={`${step.status}:${step.step}`}
                  className={cn(
                    "flex items-start gap-2.5 rounded-lg px-2.5 py-2 transition-colors duration-200",
                    step.status === "inProgress" && "bg-blue-500/5",
                    step.status === "completed" && "bg-emerald-500/5",
                  )}
                >
                  <div className="mt-0.5">{stepStatusIcon(step.status)}</div>
                  <p
                    className={cn(
                      "text-[13px] leading-snug",
                      step.status === "completed"
                        ? "text-muted-foreground/50 line-through decoration-muted-foreground/20"
                        : step.status === "inProgress"
                          ? "text-foreground/90"
                          : "text-muted-foreground/70",
                    )}
                  >
                    {step.step}
                  </p>
                </div>
              ))}
            </div>
          ) : null}

          {/* Proposed Plan Markdown */}
          {planMarkdown ? (
            <div className="space-y-2">
              <button
                type="button"
                className="group flex w-full items-center gap-1.5 text-left"
                onClick={() => setProposedPlanExpanded((v) => !v)}
              >
                {proposedPlanExpanded ? (
                  <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground/40 transition-transform" />
                ) : (
                  <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground/40 transition-transform" />
                )}
                <span className="text-[10px] font-semibold tracking-widest text-muted-foreground/40 uppercase group-hover:text-muted-foreground/60">
                  {planTitle ?? "Full Plan"}
                </span>
              </button>
              {proposedPlanExpanded ? (
                <div className="rounded-lg border border-border/50 bg-background/50 p-3">
                  <ChatMarkdown
                    text={displayedPlanMarkdown ?? ""}
                    cwd={markdownCwd}
                    isStreaming={false}
                  />
                </div>
              ) : null}
            </div>
          ) : null}

          {/* Empty state */}
          {!activePlan && !planMarkdown && visibleDelamainPeers.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <p className="text-[13px] text-muted-foreground/40">No active plan yet.</p>
              <p className="mt-1 text-[11px] text-muted-foreground/30">
                Plans will appear here when generated.
              </p>
            </div>
          ) : null}
        </div>
      </ScrollArea>
    </div>
  );
});

export default PlanSidebar;
export type { PlanSidebarProps };
