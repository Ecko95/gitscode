import { memo, useCallback, useMemo, useState } from "react";
import {
  type EnvironmentId,
  type ProviderInstanceId,
  type RepositoryProfile,
  type RepositoryProfilesSettings,
} from "@t3tools/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { ScrollArea } from "./ui/scroll-area";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Textarea } from "./ui/textarea";
import {
  BotIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ClipboardIcon,
  ExternalLinkIcon,
  GitBranchIcon,
  GitMergeIcon,
  MoreHorizontalIcon,
  PanelRightCloseIcon,
  PlusIcon,
  ScrollTextIcon,
  WorkflowIcon,
  XCircleIcon,
} from "lucide-react";
import { cn } from "~/lib/utils";
import {
  delamainStatusClassName,
  filterDelamainPeersForRepo,
  formatDelamainPathLabel,
  sortDelamainPeers,
} from "~/delamainPeers";
import { readGitsEnvironmentClient } from "~/gitsClient";
import { readLocalApi } from "~/localApi";
import type { ProviderInstanceEntry } from "~/providerInstances";
import {
  manualDelamainEnginesForMode,
  manualDelamainPersonalWorkConfirmationMessage,
  ROUTED_DELAMAIN_WORKFLOW_BLOCKED_MESSAGE,
  resolveManualDelamainLaunchRoute,
  startManualDelamainLaunch,
  type ManualDelamainEngine,
} from "./manualDelamainLaunch";
import type { DelamainPeer, ParsedLogEvent } from "@t3tools/contracts";
import { Input } from "./ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";

// --- Transcript renderer ---

function TranscriptEvent({ event }: { event: ParsedLogEvent }) {
  // Agent prose: the primary, readable content.
  if (event.isAgentMessage) {
    return (
      <div className="flex items-start gap-1.5 py-0.5">
        <span className="mt-0.5 shrink-0 rounded bg-blue-500/10 px-1 py-0 text-[10px] font-semibold text-blue-400">
          AI
        </span>
        <span className="text-[11px] text-foreground/80 whitespace-pre-wrap break-words">
          {event.text ?? ""}
        </span>
      </div>
    );
  }
  // Runner / stderr breadcrumbs: muted mono one-liners.
  if (event.type === "runner" || event.type === "stderr") {
    return (
      <div
        className={cn(
          "truncate py-0.5 font-mono text-[10px]",
          event.type === "stderr" ? "text-destructive/55" : "text-muted-foreground/40",
        )}
        title={event.text ?? undefined}
      >
        {event.text ?? ""}
      </div>
    );
  }
  // Unparseable line: dimmed, collapsed, never dominant.
  if (event.type === "raw") {
    return (
      <div
        className="truncate py-0.5 font-mono text-[10px] text-muted-foreground/30"
        title={event.raw ?? undefined}
      >
        {event.raw ?? event.text ?? ""}
      </div>
    );
  }
  // Everything else (tool calls, structured events): compact label chip.
  return (
    <div className="flex min-w-0 items-start gap-1.5 py-0.5">
      <span className="mt-0.5 shrink-0 rounded bg-muted px-1 py-0 text-[10px] font-mono text-muted-foreground/60">
        {event.label ?? event.type}
      </span>
      {event.text ? (
        <span className="truncate text-[11px] text-muted-foreground/55">{event.text}</span>
      ) : null}
    </div>
  );
}

// --- Transcript panel ---

const TAIL_LINES = 120;
const FULL_LINES = 500;

function PeerTranscript({
  peer,
  environmentId,
}: {
  peer: DelamainPeer;
  environmentId: EnvironmentId;
}) {
  const peerId = peer.id;
  const queryClient = useQueryClient();
  const [full, set_full] = useState(false);
  const [reply, set_reply] = useState("");
  const lines = full ? FULL_LINES : TAIL_LINES;

  const log_query = useQuery({
    queryKey: ["gits", "delamain", "peer-log-parsed", environmentId, peerId, lines],
    queryFn: async () => {
      const client = readGitsEnvironmentClient(environmentId);
      if (!client) return null;
      return client.delamain.readPeerLogParsed({ peerId, lines });
    },
    refetchInterval: 5_000,
    retry: false,
  });

  const events = log_query.data?.events ?? [];

  const waiting_question = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const q = events[i]?.waitingQuestion;
      if (q) return q;
    }
    return null;
  }, [events]);
  const is_waiting = peer.status === "waiting";

  const reply_mutation = useMutation({
    mutationFn: async (prompt: string) => {
      const client = readGitsEnvironmentClient(environmentId);
      if (!client) throw new Error("No environment client");
      return client.delamain.sendPeerReply({ peerId, prompt });
    },
    onSuccess: async () => {
      set_reply("");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["gits", "delamain", "peers", environmentId] }),
        queryClient.invalidateQueries({
          queryKey: ["gits", "delamain", "peer-log-parsed", environmentId, peerId],
        }),
      ]);
    },
  });

  const send_reply = useCallback(() => {
    const trimmed = reply.trim();
    if (trimmed && !reply_mutation.isPending) reply_mutation.mutate(trimmed);
  }, [reply, reply_mutation]);

  return (
    <div className="space-y-2">
      {is_waiting ? (
        <div className="space-y-1.5 rounded-md border border-amber-500/30 bg-amber-500/5 p-2">
          <p className="text-[11px] font-medium text-amber-500">Waiting for you</p>
          {waiting_question ? (
            <p className="text-[11px] whitespace-pre-wrap break-words text-foreground/70">
              {waiting_question}
            </p>
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
              placeholder="Reply to peer…"
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
      ) : null}

      {log_query.isPending ? (
        <div className="py-2 text-center text-[11px] text-muted-foreground/40">Loading…</div>
      ) : log_query.isError ? (
        <div className="flex flex-col items-center gap-1.5 py-2">
          <span className="text-[11px] text-destructive/60">Failed to load log.</span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void log_query.refetch()}
            type="button"
          >
            Retry
          </Button>
        </div>
      ) : events.length === 0 ? (
        <div className="py-2 text-center text-[11px] text-muted-foreground/35">No log yet.</div>
      ) : (
        <div className="space-y-0.5">
          {events.map((event, i) => (
            /* ponytail: key by line-idx + type; parsed events have no stable id */
            <TranscriptEvent key={`${i}-${event.type}`} event={event} />
          ))}
          {!full && events.length >= TAIL_LINES ? (
            <button
              className="mt-1 text-[10px] text-blue-400/70 underline-offset-2 hover:text-blue-400 hover:underline"
              onClick={() => set_full(true)}
              type="button"
            >
              Load more
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}

// --- Kill dialog ---

interface KillDialogState {
  peer: DelamainPeer;
}

function KillPeerDialog({
  state,
  onClose,
  onKill,
  isPending,
}: {
  state: KillDialogState | null;
  onClose: () => void;
  onKill: (peerId: string, signal: "SIGTERM" | "SIGKILL") => void;
  isPending: boolean;
}) {
  const [signal, set_signal] = useState<"SIGTERM" | "SIGKILL">("SIGTERM");
  const open = state !== null;

  return (
    <AlertDialog
      open={open}
      onOpenChange={(o) => {
        if (!o && !isPending) onClose();
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Kill peer?</AlertDialogTitle>
          <AlertDialogDescription>
            {state ? (
              <>
                This will stop <strong>{state.peer.name ?? state.peer.id}</strong>
                {state.peer.branch ? (
                  <>
                    {" "}
                    on branch <strong>{state.peer.branch}</strong>
                  </>
                ) : null}
                . Any unsaved work will be lost.
              </>
            ) : null}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {/* signal selector */}
        <div className="flex gap-2 px-6 pb-2">
          <Button
            size="sm"
            variant={signal === "SIGTERM" ? "default" : "outline"}
            onClick={() => set_signal("SIGTERM")}
            type="button"
          >
            Graceful (SIGTERM)
          </Button>
          <Button
            size="sm"
            variant={signal === "SIGKILL" ? "destructive" : "outline"}
            onClick={() => set_signal("SIGKILL")}
            type="button"
          >
            Force (SIGKILL)
          </Button>
        </div>
        <AlertDialogFooter>
          <AlertDialogClose
            disabled={isPending}
            render={<Button variant="outline" disabled={isPending} />}
          >
            Cancel
          </AlertDialogClose>
          <Button
            variant="destructive"
            disabled={isPending || !state}
            onClick={() => state && onKill(state.peer.id, signal)}
            type="button"
          >
            {isPending ? "Killing…" : "Kill peer"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

// --- Integrate confirm dialog ---

interface IntegrateDialogState {
  peer: DelamainPeer;
}

function IntegrateDialog({
  state,
  onClose,
  onIntegrate,
  isPending,
}: {
  state: IntegrateDialogState | null;
  onClose: () => void;
  onIntegrate: (peerId: string) => void;
  isPending: boolean;
}) {
  return (
    <AlertDialog
      open={state !== null}
      onOpenChange={(o) => {
        if (!o && !isPending) onClose();
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Integrate peer?</AlertDialogTitle>
          <AlertDialogDescription>
            {state ? (
              <>
                Integrate <strong>{state.peer.name ?? state.peer.id}</strong> — this will open or
                update a PR from <strong>{state.peer.branch ?? "the peer branch"}</strong> into{" "}
                <strong>{state.peer.baseBranch ?? "base"}</strong>.
              </>
            ) : null}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose
            disabled={isPending}
            render={<Button variant="outline" disabled={isPending} />}
          >
            Cancel
          </AlertDialogClose>
          <Button
            variant="default"
            disabled={isPending || !state}
            onClick={() => state && onIntegrate(state.peer.id)}
            type="button"
          >
            {isPending ? "Integrating…" : "Integrate"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

// --- Launch dialog (spawn peer / run workflow) ---

// ponytail: plain default path. A workflow-script registry (list + pick) is the upgrade
// path when there is more than one script worth launching from the UI.
const DEFAULT_WORKFLOW_SCRIPT = "/srv/gits/repos/delamain/workflows/automode-goal.ts";
const PROFILE_DEFAULT_ACCOUNT = "__profile_default__";
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error.";
}

function LaunchDialog({
  open,
  onOpenChange,
  environmentId,
  repo,
  repositoryProfile,
  repositoryProfiles,
  providerInstanceEntries,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  environmentId: EnvironmentId;
  repo: string;
  repositoryProfile: RepositoryProfile;
  repositoryProfiles: RepositoryProfilesSettings;
  providerInstanceEntries: ReadonlyArray<ProviderInstanceEntry>;
}) {
  const queryClient = useQueryClient();
  const [mode, set_mode] = useState<"spawn" | "workflow">("spawn");

  // Spawn-peer form.
  const [prompt, set_prompt] = useState("");
  const [spawn_name, set_spawn_name] = useState("");
  const [engine, set_engine] = useState<ManualDelamainEngine>("codex");
  const [selected_provider_instance_id, set_selected_provider_instance_id] =
    useState<ProviderInstanceId | null>(null);

  // Run-workflow form.
  const [script, set_script] = useState(DEFAULT_WORKFLOW_SCRIPT);
  const [wf_name, set_wf_name] = useState("");
  const [args_json, set_args_json] = useState("");
  const [launch_error, set_launch_error] = useState<unknown>(null);
  const selectable_engines = manualDelamainEnginesForMode(mode);
  const launch_engine = engine;
  const launch_route = useMemo(() => {
    if (mode === "workflow") {
      return {
        providerInstanceId: null,
        requiresWorkPersonalConfirmation: false,
        error: ROUTED_DELAMAIN_WORKFLOW_BLOCKED_MESSAGE,
      };
    }
    return resolveManualDelamainLaunchRoute({
      repositoryProfile,
      engine: launch_engine,
      selectedProviderInstanceId: selected_provider_instance_id,
      profiles: repositoryProfiles,
      instanceEntries: providerInstanceEntries,
    });
  }, [
    launch_engine,
    mode,
    providerInstanceEntries,
    repositoryProfile,
    repositoryProfiles,
    selected_provider_instance_id,
  ]);
  const compatible_instances = useMemo(
    () =>
      providerInstanceEntries.filter(
        (entry) => entry.driverKind === launch_engine && entry.enabled && entry.isAvailable,
      ),
    [launch_engine, providerInstanceEntries],
  );
  const selected_instance_label =
    providerInstanceEntries.find((entry) => entry.instanceId === launch_route.providerInstanceId)
      ?.displayName ?? launch_route.providerInstanceId;

  // Client-side JSON validation — inline error, blocks submit before we ever shell the CLI.
  const args_json_error = useMemo(() => {
    const trimmed = args_json.trim();
    if (!trimmed) return null;
    try {
      JSON.parse(trimmed);
      return null;
    } catch (err) {
      return errorMessage(err);
    }
  }, [args_json]);

  const spawn_mutation = useMutation({
    mutationFn: async (providerInstanceId: ProviderInstanceId) => {
      const client = readGitsEnvironmentClient(environmentId);
      if (!client) throw new Error("No environment client");
      return client.delamain.spawnPeer({
        repo,
        prompt: prompt.trim(),
        engine: launch_engine,
        providerInstanceId,
        ...(spawn_name.trim() ? { name: spawn_name.trim() } : {}),
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["gits", "delamain", "peers", environmentId],
      });
    },
  });

  const workflow_mutation = useMutation({
    mutationFn: async (providerInstanceId: ProviderInstanceId) => {
      const client = readGitsEnvironmentClient(environmentId);
      if (!client) throw new Error("No environment client");
      const trimmedArgs = args_json.trim();
      return client.delamain.workflow.run({
        script: script.trim(),
        repo,
        engine: "codex",
        providerInstanceId,
        ...(wf_name.trim() ? { name: wf_name.trim() } : {}),
        ...(trimmedArgs ? { argsJson: trimmedArgs } : {}),
      });
    },
  });

  const pending = spawn_mutation.isPending || workflow_mutation.isPending;

  const confirm_personal_work_usage = useCallback(async () => {
    const localApi = readLocalApi();
    if (!localApi) return false;
    return localApi.dialogs.confirm(
      manualDelamainPersonalWorkConfirmationMessage(selected_instance_label ?? launch_engine),
    );
  }, [launch_engine, selected_instance_label]);

  const launch = useCallback(() => {
    set_launch_error(null);
    startManualDelamainLaunch(
      {
        route: launch_route,
        confirm: confirm_personal_work_usage,
        launch: async (providerInstanceId) => {
          if (mode === "spawn") {
            await spawn_mutation.mutateAsync(providerInstanceId);
          } else {
            await workflow_mutation.mutateAsync(providerInstanceId);
          }
        },
      },
      set_launch_error,
    );
  }, [confirm_personal_work_usage, launch_route, mode, spawn_mutation, workflow_mutation]);

  const reset_and_close = useCallback(
    (next: boolean) => {
      if (!next && !pending) {
        spawn_mutation.reset();
        workflow_mutation.reset();
        set_launch_error(null);
        set_selected_provider_instance_id(null);
        onOpenChange(false);
      } else if (next) {
        onOpenChange(true);
      }
    },
    [pending, spawn_mutation, workflow_mutation, onOpenChange],
  );

  const can_spawn = prompt.trim().length > 0 && launch_route.error === null && !pending;
  const can_run =
    script.trim().length > 0 && args_json_error === null && launch_route.error === null && !pending;

  return (
    <Dialog open={open} onOpenChange={reset_and_close}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Launch</DialogTitle>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          {/* mode selector */}
          <div className="flex gap-1.5">
            <Button
              size="sm"
              variant={mode === "spawn" ? "default" : "outline"}
              onClick={() => set_mode("spawn")}
              type="button"
            >
              <BotIcon className="size-3.5" />
              Spawn peer
            </Button>
            <Button
              size="sm"
              variant={mode === "workflow" ? "default" : "outline"}
              onClick={() => set_mode("workflow")}
              type="button"
            >
              <WorkflowIcon className="size-3.5" />
              Run workflow
            </Button>
          </div>

          {/* repo (read-only, prefilled from the active project) */}
          <div className="grid gap-1">
            <label className="text-[11px] font-medium text-muted-foreground/70">Repo</label>
            <div className="truncate rounded-md border border-border/50 bg-muted/40 px-2 py-1.5 font-mono text-[11px] text-muted-foreground/70">
              {repo}
            </div>
          </div>

          <div className="grid gap-1">
            <label className="text-[11px] font-medium text-muted-foreground/70">Engine</label>
            {mode === "spawn" ? (
              <div className="flex gap-1.5">
                {selectable_engines.map((eng) => (
                  <Button
                    key={eng}
                    size="sm"
                    variant={engine === eng ? "default" : "outline"}
                    onClick={() => {
                      set_engine(eng);
                      set_selected_provider_instance_id(null);
                    }}
                    type="button"
                    disabled={pending}
                  >
                    {eng}
                  </Button>
                ))}
              </div>
            ) : (
              <div className="rounded-md border border-border/50 bg-muted/40 px-2 py-1.5 font-mono text-[11px] text-muted-foreground/70">
                Unavailable
              </div>
            )}
          </div>
          {mode === "spawn" ? (
            <label className="grid gap-1">
              <span className="text-[11px] font-medium text-muted-foreground/70">Account</span>
              <Select
                value={selected_provider_instance_id ?? PROFILE_DEFAULT_ACCOUNT}
                onValueChange={(value) =>
                  set_selected_provider_instance_id(
                    value === PROFILE_DEFAULT_ACCOUNT ? null : (value as ProviderInstanceId),
                  )
                }
              >
                <SelectTrigger aria-label="Provider account" className="w-full">
                  <SelectValue>
                    {selected_provider_instance_id
                      ? (selected_instance_label ?? selected_provider_instance_id)
                      : `Profile default · ${selected_instance_label ?? "Not configured"}`}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup alignItemWithTrigger={false}>
                  <SelectItem value={PROFILE_DEFAULT_ACCOUNT}>Profile default</SelectItem>
                  {compatible_instances.map((entry) => (
                    <SelectItem key={entry.instanceId} value={entry.instanceId}>
                      {entry.displayName}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </label>
          ) : null}
          {launch_route.error ? (
            <p className="text-[11px] text-destructive/70">{launch_route.error}</p>
          ) : null}
          {launch_error !== null && !spawn_mutation.isError && !workflow_mutation.isError ? (
            <p className="text-[11px] text-destructive/70">{errorMessage(launch_error)}</p>
          ) : null}

          {mode === "spawn" ? (
            <>
              <div className="grid gap-1">
                <label className="text-[11px] font-medium text-muted-foreground/70">Prompt</label>
                <Textarea
                  value={prompt}
                  onChange={(e) => set_prompt(e.currentTarget.value)}
                  placeholder="What should the peer do?"
                  className="min-h-20 text-xs"
                  disabled={pending}
                />
              </div>
              <div className="grid gap-1">
                <label className="text-[11px] font-medium text-muted-foreground/70">
                  Name (optional)
                </label>
                <Input
                  value={spawn_name}
                  onValueChange={set_spawn_name}
                  placeholder="Peer name"
                  size="sm"
                  disabled={pending}
                  className="text-[11px]"
                />
              </div>
              {spawn_mutation.isError ? (
                <p className="text-[11px] text-destructive/70">
                  {errorMessage(spawn_mutation.error)}
                </p>
              ) : null}
              {spawn_mutation.isSuccess ? (
                <p className="text-[11px] text-emerald-500">
                  Spawned peer <span className="font-mono">{spawn_mutation.data.id}</span>.
                </p>
              ) : null}
            </>
          ) : (
            <>
              <div className="grid gap-1">
                <label className="text-[11px] font-medium text-muted-foreground/70">
                  Workflow script
                </label>
                <Input
                  value={script}
                  onValueChange={set_script}
                  placeholder="/path/to/workflow.ts"
                  size="sm"
                  disabled={pending}
                  className="font-mono text-[11px]"
                />
              </div>
              <div className="grid gap-1">
                <label className="text-[11px] font-medium text-muted-foreground/70">
                  Name (optional)
                </label>
                <Input
                  value={wf_name}
                  onValueChange={set_wf_name}
                  placeholder="Run name"
                  size="sm"
                  disabled={pending}
                  className="text-[11px]"
                />
              </div>
              <div className="grid gap-1">
                <label className="text-[11px] font-medium text-muted-foreground/70">
                  Args JSON (optional)
                </label>
                <Textarea
                  value={args_json}
                  onChange={(e) => set_args_json(e.currentTarget.value)}
                  placeholder='{"title":"…","prompt":"…"}'
                  className="min-h-16 font-mono text-[11px]"
                  aria-invalid={args_json_error !== null}
                  disabled={pending}
                />
                {args_json_error ? (
                  <p className="text-[11px] text-destructive/70">Invalid JSON: {args_json_error}</p>
                ) : null}
              </div>
              {workflow_mutation.isError ? (
                <p className="text-[11px] text-destructive/70">
                  {errorMessage(workflow_mutation.error)}
                </p>
              ) : null}
              {workflow_mutation.isSuccess ? (
                <div className="space-y-0.5">
                  <p className="text-[11px] text-emerald-500">
                    Started workflow{" "}
                    <span className="font-mono">{workflow_mutation.data.workflowId}</span>.
                  </p>
                  <p className="text-[10px] text-muted-foreground/50">
                    It will appear as a mirrored thread shortly.
                  </p>
                </div>
              ) : null}
            </>
          )}
        </DialogPanel>
        <DialogFooter>
          {mode === "spawn" ? (
            <Button onClick={launch} disabled={!can_spawn} type="button" size="sm">
              {spawn_mutation.isPending ? "Spawning…" : "Spawn peer"}
            </Button>
          ) : (
            <Button onClick={launch} disabled={!can_run} type="button" size="sm">
              {workflow_mutation.isPending ? "Starting…" : "Run workflow"}
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

// --- Active statuses ---

// frozen is terminal server-side (DelamainCliAdapter) — no Kill button on frozen peers.
const ACTIVE_STATUSES = new Set(["pending", "running", "blocked", "waiting"]);
const TERMINAL_STATUSES = new Set(["done", "completed", "failed", "frozen", "killed", "halted"]);

// --- Per-peer card ---

function PeerCard({
  peer,
  environmentId,
  onKill,
  onIntegrate,
}: {
  peer: DelamainPeer;
  environmentId: EnvironmentId;
  onKill: (peer: DelamainPeer) => void;
  onIntegrate: (peer: DelamainPeer) => void;
}) {
  const repoLabel = formatDelamainPathLabel(peer.sourceRepo ?? peer.worktreePath);
  const title = peer.name ?? peer.id;
  const [chat_open, set_chat_open] = useState(false);

  const is_active = ACTIVE_STATUSES.has(peer.status);
  const is_terminal = TERMINAL_STATUSES.has(peer.status);
  const can_integrate = (peer.status === "done" || peer.status === "completed") && !peer.prUrl;

  const copy_branch = useCallback(() => {
    if (peer.branch) void navigator.clipboard.writeText(peer.branch);
  }, [peer.branch]);

  return (
    <div className="rounded-lg border border-border/50 bg-background/45">
      {/* header row */}
      <div className="flex min-w-0 items-center gap-1.5 px-2.5 pt-2 pb-1">
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
        {/* overflow menu */}
        <Menu>
          <MenuTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost"
                className="shrink-0 text-muted-foreground/40 hover:text-foreground/60"
                aria-label={`Actions for ${title}`}
                title={`Actions for ${title}`}
              />
            }
          >
            <MoreHorizontalIcon className="size-3.5" />
          </MenuTrigger>
          <MenuPopup align="end" className="w-44">
            <MenuItem onClick={() => set_chat_open((v) => !v)} className="text-sm">
              <ScrollTextIcon className="size-4" />
              {chat_open ? "Hide chat" : "View chat"}
            </MenuItem>
            {peer.branch ? (
              <MenuItem onClick={copy_branch} className="text-sm">
                <ClipboardIcon className="size-4" />
                Copy branch
              </MenuItem>
            ) : null}
            {peer.prUrl ? (
              <MenuItem
                render={<a href={peer.prUrl} target="_blank" rel="noopener noreferrer" />}
                className="text-sm"
              >
                <ExternalLinkIcon className="size-4" />
                Open PR
              </MenuItem>
            ) : null}
            {can_integrate ? (
              <MenuItem onClick={() => onIntegrate(peer)} className="text-sm">
                <GitMergeIcon className="size-4" />
                Integrate
              </MenuItem>
            ) : null}
            {is_active ? (
              <MenuItem onClick={() => onKill(peer)} variant="destructive" className="text-sm">
                <XCircleIcon className="size-4" />
                Kill peer
              </MenuItem>
            ) : null}
          </MenuPopup>
        </Menu>
      </div>

      {/* branch + repo row */}
      <div className="flex min-w-0 items-center gap-1.5 px-2.5 pb-1.5 text-[11px] text-muted-foreground/55">
        <GitBranchIcon className="size-3 shrink-0" />
        <span className="truncate">{peer.branch ?? "no branch"}</span>
        {repoLabel ? (
          <>
            <span className="shrink-0 text-muted-foreground/30">|</span>
            <span className="truncate">{repoLabel}</span>
          </>
        ) : null}
      </div>

      {/* last event / task summary */}
      {peer.lastEvent || peer.task ? (
        <p className="truncate px-2.5 pb-1 text-[11px] text-muted-foreground/45">
          {peer.lastEvent ?? peer.task}
        </p>
      ) : null}

      {/* inline action buttons row (primary shortcuts) */}
      <div className="flex items-center gap-1 px-2 pb-2">
        <Button
          size="icon-xs"
          variant="ghost"
          className={cn(
            "h-5 w-auto gap-1 px-1.5 text-[10px] text-muted-foreground/50 hover:text-foreground/70",
            chat_open && "text-blue-400/80",
          )}
          onClick={() => set_chat_open((v) => !v)}
          aria-label={chat_open ? "Hide chat transcript" : "View chat transcript"}
          title={chat_open ? "Hide chat transcript" : "View chat transcript"}
        >
          <ScrollTextIcon className="size-3" />
          {chat_open ? (
            <ChevronDownIcon className="size-3" />
          ) : (
            <ChevronRightIcon className="size-3" />
          )}
        </Button>

        {peer.prUrl ? (
          <a
            href={peer.prUrl}
            target="_blank"
            rel="noopener noreferrer"
            title="Open PR"
            aria-label="Open pull request"
            className="inline-flex h-5 items-center gap-1 rounded px-1.5 text-[10px] text-muted-foreground/50 hover:bg-accent hover:text-foreground/70"
          >
            <ExternalLinkIcon className="size-3" />
            PR
          </a>
        ) : null}

        {is_active ? (
          <Button
            size="icon-xs"
            variant="ghost"
            className="h-5 w-auto gap-1 px-1.5 text-[10px] text-destructive/50 hover:bg-destructive/10 hover:text-destructive"
            onClick={() => onKill(peer)}
            aria-label={`Kill peer ${title}`}
            title="Kill peer"
          >
            <XCircleIcon className="size-3" />
            Kill
          </Button>
        ) : null}

        {/* terminal status hint */}
        {is_terminal && !peer.prUrl && peer.integrationStatus ? (
          <span className="text-[10px] text-muted-foreground/30">{peer.integrationStatus}</span>
        ) : null}
      </div>

      {/* transcript (collapsible) */}
      {chat_open ? (
        <div className="border-t border-border/40 px-2.5 py-2">
          <PeerTranscript peer={peer} environmentId={environmentId} />
        </div>
      ) : null}
    </div>
  );
}

// --- Main sidebar ---

interface DelamainSidebarProps {
  environmentId: EnvironmentId;
  projectRepoRoot: string | undefined;
  repositoryProfile: RepositoryProfile;
  repositoryProfiles: RepositoryProfilesSettings;
  providerInstanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  mode?: "sheet" | "sidebar";
  onClose: () => void;
}

const DelamainSidebar = memo(function DelamainSidebar({
  environmentId,
  projectRepoRoot,
  repositoryProfile,
  repositoryProfiles,
  providerInstanceEntries,
  mode = "sidebar",
  onClose,
}: DelamainSidebarProps) {
  const queryClient = useQueryClient();
  const [kill_state, set_kill_state] = useState<{ peer: DelamainPeer } | null>(null);
  const [integrate_state, set_integrate_state] = useState<{ peer: DelamainPeer } | null>(null);
  const [show_all, set_show_all] = useState(false);
  const [launch_open, set_launch_open] = useState(false);

  const peers_query_key = ["gits", "delamain", "peers", environmentId];

  const delamain_peers_query = useQuery({
    queryKey: peers_query_key,
    queryFn: async () => {
      const client = readGitsEnvironmentClient(environmentId);
      if (!client) return null;
      return client.delamain.listPeers();
    },
    refetchInterval: 10_000,
    retry: false,
  });

  const delamain_peers = useMemo(
    () =>
      filterDelamainPeersForRepo(delamain_peers_query.data?.peers ?? [], projectRepoRoot).sort(
        sortDelamainPeers,
      ),
    [delamain_peers_query.data?.peers, projectRepoRoot],
  );

  const DEFAULT_VISIBLE = 6;
  const visible_peers = show_all ? delamain_peers : delamain_peers.slice(0, DEFAULT_VISIBLE);
  const hidden_count = Math.max(0, delamain_peers.length - visible_peers.length);

  const kill_mutation = useMutation({
    mutationFn: async ({ peerId, signal }: { peerId: string; signal: "SIGTERM" | "SIGKILL" }) => {
      const client = readGitsEnvironmentClient(environmentId);
      if (!client) throw new Error("No environment client");
      return client.delamain.killPeer({ peerId, signal });
    },
    onSuccess: async () => {
      set_kill_state(null);
      await queryClient.invalidateQueries({ queryKey: peers_query_key });
    },
  });

  const integrate_mutation = useMutation({
    mutationFn: async (peerId: string) => {
      const client = readGitsEnvironmentClient(environmentId);
      if (!client) throw new Error("No environment client");
      return client.delamain.integratePeer({ peerId });
    },
    onSuccess: async () => {
      set_integrate_state(null);
      await queryClient.invalidateQueries({ queryKey: peers_query_key });
    },
  });

  const handle_kill = useCallback((peer: DelamainPeer) => {
    set_kill_state({ peer });
  }, []);

  const handle_integrate = useCallback((peer: DelamainPeer) => {
    set_integrate_state({ peer });
  }, []);

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
            {delamain_peers.length} peer{delamain_peers.length === 1 ? "" : "s"}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {projectRepoRoot ? (
            <Button
              size="icon-xs"
              variant="ghost"
              onClick={() => set_launch_open(true)}
              aria-label="Launch delamain peer or workflow"
              title="Launch peer or workflow"
              className="text-muted-foreground/50 hover:text-foreground/70"
            >
              <PlusIcon className="size-3.5" />
            </Button>
          ) : null}
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
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-3 p-3">
          {visible_peers.length > 0 ? (
            <>
              <div className="space-y-1.5">
                {visible_peers.map((peer) => (
                  <PeerCard
                    key={peer.id}
                    peer={peer}
                    environmentId={environmentId}
                    onKill={handle_kill}
                    onIntegrate={handle_integrate}
                  />
                ))}
              </div>
              {hidden_count > 0 || show_all ? (
                <button
                  type="button"
                  onClick={() => set_show_all((v) => !v)}
                  className="px-1 text-[11px] text-blue-400/70 underline-offset-2 hover:text-blue-400 hover:underline"
                >
                  {show_all ? "Show fewer" : `Show ${hidden_count} more`}
                </button>
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

      <KillPeerDialog
        state={kill_state}
        onClose={() => set_kill_state(null)}
        onKill={(peerId, signal) => kill_mutation.mutate({ peerId, signal })}
        isPending={kill_mutation.isPending}
      />

      <IntegrateDialog
        state={integrate_state}
        onClose={() => set_integrate_state(null)}
        onIntegrate={(peerId) => integrate_mutation.mutate(peerId)}
        isPending={integrate_mutation.isPending}
      />

      {projectRepoRoot ? (
        <LaunchDialog
          open={launch_open}
          onOpenChange={set_launch_open}
          environmentId={environmentId}
          repo={projectRepoRoot}
          repositoryProfile={repositoryProfile}
          repositoryProfiles={repositoryProfiles}
          providerInstanceEntries={providerInstanceEntries}
        />
      ) : null}
    </div>
  );
});

export default DelamainSidebar;
export type { DelamainSidebarProps };
