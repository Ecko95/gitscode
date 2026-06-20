import { memo, useMemo } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { ScrollArea } from "./ui/scroll-area";
import { BotIcon, GitBranchIcon, PanelRightCloseIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import {
  delamainStatusClassName,
  filterDelamainPeersForRepo,
  formatDelamainPathLabel,
  sortDelamainPeers,
} from "~/delamainPeers";
import { readGitsEnvironmentClient } from "~/gitsClient";

interface DelamainSidebarProps {
  environmentId: EnvironmentId;
  projectRepoRoot: string | undefined;
  mode?: "sheet" | "sidebar";
  onClose: () => void;
}

const DelamainSidebar = memo(function DelamainSidebar({
  environmentId,
  projectRepoRoot,
  mode = "sidebar",
  onClose,
}: DelamainSidebarProps) {
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
    () =>
      filterDelamainPeersForRepo(delamainPeersQuery.data?.peers ?? [], projectRepoRoot).sort(
        sortDelamainPeers,
      ),
    [delamainPeersQuery.data?.peers, projectRepoRoot],
  );
  const visibleDelamainPeers = delamainPeers.slice(0, 6);
  const hiddenDelamainPeerCount = Math.max(0, delamainPeers.length - visibleDelamainPeers.length);

  return (
    <div
      className={cn(
        "flex min-h-0 flex-col bg-card/50",
        mode === "sidebar"
          ? "h-full w-[340px] shrink-0 border-l border-border/70"
          : "h-full w-full",
      )}
    >
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border/60 px-3">
        <div className="flex items-center gap-2">
          <Badge
            variant="secondary"
            className="rounded-md bg-blue-500/10 px-1.5 py-0 text-[10px] font-semibold tracking-wide text-blue-400 uppercase"
          >
            Delamain
          </Badge>
          <span className="text-[11px] text-muted-foreground/60">
            {delamainPeers.length} peer{delamainPeers.length === 1 ? "" : "s"}
          </span>
        </div>
        <Button
          size="icon-xs"
          variant="ghost"
          onClick={onClose}
          aria-label="Close delamain sidebar"
          className="text-muted-foreground/50 hover:text-foreground/70"
        >
          <PanelRightCloseIcon className="size-3.5" />
        </Button>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-3 p-3">
          {visibleDelamainPeers.length > 0 ? (
            <>
              <div className="space-y-1.5">
                {visibleDelamainPeers.map((peer) => {
                  const repoLabel = formatDelamainPathLabel(peer.sourceRepo ?? peer.worktreePath);
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
            </>
          ) : (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <p className="text-[13px] text-muted-foreground/40">
                No deployed peers for this repo.
              </p>
              <p className="mt-1 text-[11px] text-muted-foreground/30">
                Only peers whose repo matches the active project are shown here.
              </p>
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
});

export default DelamainSidebar;
export type { DelamainSidebarProps };
