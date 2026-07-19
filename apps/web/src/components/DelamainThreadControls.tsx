import { memo, useCallback, useMemo, useState } from "react";
import type { DelamainPeer, EnvironmentId } from "@t3tools/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BotIcon, XCircleIcon } from "lucide-react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { cn } from "~/lib/utils";
import { readGitsEnvironmentClient } from "~/gitsClient";
import type { SubagentTask } from "../session-logic";

// Terminal workflow statuses: stop polling and disable the kill button.
const TERMINAL_WORKFLOW_STATUSES = new Set([
  "killed",
  "completed",
  "done",
  "failed",
  "halted",
  "frozen",
]);

function statusChipClassName(status: string): string {
  if (TERMINAL_WORKFLOW_STATUSES.has(status)) {
    return status === "failed" || status === "killed"
      ? "bg-destructive/10 text-destructive"
      : "bg-muted text-muted-foreground/70";
  }
  return "bg-blue-500/10 text-blue-400";
}

// Per-agent reply box, shown only when the peer is waiting.
function AgentReply({
  environmentId,
  peerId,
  question,
}: {
  environmentId: EnvironmentId;
  peerId: string;
  question: string | null;
}) {
  const queryClient = useQueryClient();
  const [reply, set_reply] = useState("");

  const reply_mutation = useMutation({
    mutationFn: async (prompt: string) => {
      const client = readGitsEnvironmentClient(environmentId);
      if (!client) throw new Error("No environment client");
      return client.delamain.sendPeerReply({ peerId, prompt });
    },
    onSuccess: async () => {
      set_reply("");
      await queryClient.invalidateQueries({
        queryKey: ["gits", "delamain", "peers", environmentId],
      });
    },
  });

  const send_reply = useCallback(() => {
    const trimmed = reply.trim();
    if (trimmed && !reply_mutation.isPending) reply_mutation.mutate(trimmed);
  }, [reply, reply_mutation]);

  return (
    <div className="mt-1 space-y-1 rounded-md border border-amber-500/30 bg-amber-500/5 p-1.5">
      <p className="text-[10px] font-medium text-amber-500">Waiting for you</p>
      {question ? (
        <p className="text-[11px] whitespace-pre-wrap break-words text-foreground/70">{question}</p>
      ) : null}
      <div className="flex items-center gap-1.5">
        <Input
          value={reply}
          onValueChange={set_reply}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send_reply();
            }
          }}
          placeholder="Reply to agent…"
          size="sm"
          disabled={reply_mutation.isPending}
          className="text-[11px]"
        />
        <Button
          size="sm"
          onClick={send_reply}
          disabled={!reply.trim() || reply_mutation.isPending}
          type="button"
        >
          {reply_mutation.isPending ? "Sending…" : "Send"}
        </Button>
      </div>
    </div>
  );
}

function AgentRow({
  task,
  peer,
  environmentId,
}: {
  task: SubagentTask;
  peer: DelamainPeer | undefined;
  environmentId: EnvironmentId;
}) {
  const queryClient = useQueryClient();
  const is_running = task.status === "running";
  const is_waiting = peer?.status === "waiting";
  const question = peer?.lastEvent ?? null;

  const kill_mutation = useMutation({
    mutationFn: async () => {
      const client = readGitsEnvironmentClient(environmentId);
      if (!client) throw new Error("No environment client");
      return client.delamain.killPeer({ peerId: task.id, signal: "SIGTERM" });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["gits", "delamain", "peers", environmentId],
      });
    },
  });

  return (
    <div className="rounded-md border border-border/50 bg-background/45 px-2 py-1.5">
      <div className="flex min-w-0 items-center gap-1.5">
        <BotIcon className="size-3.5 shrink-0 text-muted-foreground/50" />
        <span className="min-w-0 flex-1 truncate text-[12px] text-foreground/85">{task.title}</span>
        <span
          className={cn(
            "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium",
            statusChipClassName(peer?.status ?? task.status),
          )}
        >
          {peer?.rawStatus ?? task.status}
        </span>
        {is_running ? (
          <Button
            size="icon-xs"
            variant="ghost"
            className="h-5 w-auto shrink-0 gap-1 px-1.5 text-[10px] text-destructive/60 hover:bg-destructive/10 hover:text-destructive"
            onClick={() => kill_mutation.mutate()}
            disabled={kill_mutation.isPending}
            title={`Kill agent ${task.title}`}
            aria-label={`Kill agent ${task.title}`}
            type="button"
          >
            <XCircleIcon className="size-3" />
            {kill_mutation.isPending ? "Killing…" : "Kill"}
          </Button>
        ) : null}
      </div>
      {is_waiting ? (
        <AgentReply environmentId={environmentId} peerId={task.id} question={question} />
      ) : null}
    </div>
  );
}

interface DelamainThreadControlsProps {
  environmentId: EnvironmentId;
  workflowId: string;
  subagentTasks: ReadonlyArray<SubagentTask>;
}

// Mounted in the thread detail for mirrored delamain workflows (branch "delamain/wf-<id>").
// Replaces the (no-op) composer with kill / reply / status controls that drive the real
// workflow through the gits.delamain.* WS-RPC transport.
const DelamainThreadControls = memo(function DelamainThreadControls({
  environmentId,
  workflowId,
  subagentTasks,
}: DelamainThreadControlsProps) {
  const queryClient = useQueryClient();
  const [confirm_kill, set_confirm_kill] = useState(false);

  const status_query = useQuery({
    queryKey: ["gits", "delamain", "workflow-status", environmentId, workflowId],
    queryFn: async () => {
      const client = readGitsEnvironmentClient(environmentId);
      if (!client) return null;
      return client.delamain.workflow.status({ workflowId });
    },
    // Poll while the workflow is still live; stop once terminal.
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status && TERMINAL_WORKFLOW_STATUSES.has(status) ? false : 10_000;
    },
    retry: false,
  });

  const peers_query_key = ["gits", "delamain", "peers", environmentId];
  const peers_query = useQuery({
    queryKey: peers_query_key,
    queryFn: async () => {
      const client = readGitsEnvironmentClient(environmentId);
      if (!client) return null;
      return client.delamain.listPeers();
    },
    refetchInterval: 10_000,
    retry: false,
  });

  const peers_by_id = useMemo(() => {
    const map = new Map<string, DelamainPeer>();
    for (const peer of peers_query.data?.peers ?? []) map.set(peer.id, peer);
    return map;
  }, [peers_query.data?.peers]);

  const status = status_query.data?.status ?? null;
  const is_terminal = status !== null && TERMINAL_WORKFLOW_STATUSES.has(status);

  const kill_mutation = useMutation({
    mutationFn: async () => {
      const client = readGitsEnvironmentClient(environmentId);
      if (!client) throw new Error("No environment client");
      return client.delamain.workflow.kill({ workflowId });
    },
    onSuccess: async () => {
      set_confirm_kill(false);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["gits", "delamain", "workflow-status", environmentId, workflowId],
        }),
        queryClient.invalidateQueries({ queryKey: peers_query_key }),
      ]);
    },
  });

  return (
    <div className="space-y-2 rounded-lg border border-border/60 bg-card/50 p-2.5">
      {/* header: marker + status chip + kill workflow */}
      <div className="flex items-center gap-2">
        <Badge
          variant="secondary"
          className="rounded-md bg-blue-500/10 px-1.5 py-0 text-[10px] font-semibold tracking-wide text-blue-400 uppercase"
        >
          Delamain
        </Badge>
        {status ? (
          <span
            className={cn(
              "rounded px-1.5 py-0.5 text-[10px] font-medium",
              statusChipClassName(status),
            )}
          >
            {status}
          </span>
        ) : status_query.isPending ? (
          <span className="text-[10px] text-muted-foreground/40">Loading…</span>
        ) : (
          <span className="text-[10px] text-muted-foreground/40">Status unavailable</span>
        )}
        <span className="ml-auto" />
        {!is_terminal ? (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 gap-1 px-1.5 text-[11px] text-destructive/60 hover:bg-destructive/10 hover:text-destructive"
            onClick={() => set_confirm_kill(true)}
            disabled={kill_mutation.isPending}
            type="button"
          >
            <XCircleIcon className="size-3" />
            Kill workflow
          </Button>
        ) : null}
      </div>

      {/* read-only composer replacement notice */}
      <p className="text-[11px] text-muted-foreground/60">
        Mirrored delamain workflow — control it from the panel.
      </p>

      {/* per-agent rows */}
      {subagentTasks.length > 0 ? (
        <div className="space-y-1">
          {subagentTasks.map((task) => (
            <AgentRow
              key={task.id}
              task={task}
              peer={peers_by_id.get(task.id)}
              environmentId={environmentId}
            />
          ))}
        </div>
      ) : null}

      <AlertDialog
        open={confirm_kill}
        onOpenChange={(o) => {
          if (!o && !kill_mutation.isPending) set_confirm_kill(false);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Kill workflow?</AlertDialogTitle>
            <AlertDialogDescription>
              This terminates the delamain workflow and all of its live agents. Any unsaved work
              will be lost.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose
              disabled={kill_mutation.isPending}
              render={<Button variant="outline" disabled={kill_mutation.isPending} />}
            >
              Cancel
            </AlertDialogClose>
            <Button
              variant="destructive"
              disabled={kill_mutation.isPending}
              onClick={() => kill_mutation.mutate()}
              type="button"
            >
              {kill_mutation.isPending ? "Killing…" : "Kill workflow"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
});

export default DelamainThreadControls;
export type { DelamainThreadControlsProps };
