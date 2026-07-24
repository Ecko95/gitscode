import type {
  DelamainInboxResult,
  DelamainPeer,
  DelamainPeerListResult,
  ProviderInstanceId,
} from "@t3tools/contracts";
import {
  BotIcon,
  CircleStopIcon,
  GitBranchIcon,
  ListChecksIcon,
  RefreshCwIcon,
  SendIcon,
} from "lucide-react";

import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";

import { EmptyState, SectionHeader, StatusPill, statusTone } from "./primitives";

function peerStatusTone(peer: DelamainPeer): ReturnType<typeof statusTone> {
  return statusTone(peer.status);
}

export function PeerFleetPanel({
  list,
  loading,
  error,
  selectedPeerId,
  logText,
  logLoading,
  inbox,
  actionError,
  spawnRepo,
  spawnName,
  spawnPrompt,
  spawnProviderInstanceId,
  spawnProviderOptions,
  replyText,
  actionPending,
  onRefresh,
  onSelectPeer,
  onSpawnRepoChange,
  onSpawnNameChange,
  onSpawnPromptChange,
  onSpawnProviderInstanceChange,
  onReplyTextChange,
  onSpawn,
  onReply,
  onWait,
  onKill,
  onIntegrate,
  killSwitchEnabled,
}: {
  list: DelamainPeerListResult | undefined;
  loading: boolean;
  error: unknown;
  selectedPeerId: string | null;
  logText: string | undefined;
  logLoading: boolean;
  inbox: DelamainInboxResult | undefined;
  actionError: unknown;
  spawnRepo: string;
  spawnName: string;
  spawnPrompt: string;
  spawnProviderInstanceId: ProviderInstanceId | null;
  spawnProviderOptions: ReadonlyArray<{
    readonly instanceId: ProviderInstanceId;
    readonly label: string;
  }>;
  replyText: string;
  actionPending: boolean;
  onRefresh: () => void;
  onSelectPeer: (peerId: string) => void;
  onSpawnRepoChange: (value: string) => void;
  onSpawnNameChange: (value: string) => void;
  onSpawnPromptChange: (value: string) => void;
  onSpawnProviderInstanceChange: (value: ProviderInstanceId | null) => void;
  onReplyTextChange: (value: string) => void;
  onSpawn: () => void;
  onReply: () => void;
  onWait: () => void;
  onKill: () => void;
  onIntegrate: () => void;
  killSwitchEnabled: boolean;
}) {
  const peers = list?.peers ?? [];
  const selectedPeer = selectedPeerId
    ? (peers.find((peer) => peer.id === selectedPeerId) ?? null)
    : null;
  const supported = new Set(list?.capabilities.supported ?? []);
  // The automode kill switch (R#1) freezes the guarded manual actions
  // (spawn/reply/kill/integrate) server-side; disable them here so the block is a
  // visible, explained state instead of a bare RPC error. `wait` is read-only and
  // stays enabled.
  const canSpawn =
    supported.has("spawn") &&
    spawnRepo.trim().length > 0 &&
    spawnPrompt.trim().length > 0 &&
    spawnProviderInstanceId !== null &&
    !killSwitchEnabled;
  const canReply =
    supported.has("reply") &&
    selectedPeer !== null &&
    replyText.trim().length > 0 &&
    !killSwitchEnabled;
  const canWait = supported.has("wait") && selectedPeer !== null;
  const canKill = supported.has("kill") && selectedPeer !== null && !killSwitchEnabled;
  const canIntegrate = supported.has("integrate") && selectedPeer !== null && !killSwitchEnabled;
  const errorMessage =
    error instanceof Error
      ? error.message
      : actionError instanceof Error
        ? actionError.message
        : null;

  return (
    <section className="border-b border-border bg-background">
      <div className="flex flex-col gap-3 border-b border-border/70 px-4 py-4 sm:flex-row sm:items-start sm:justify-between sm:px-5">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="truncate text-base font-semibold">Delamain Peer Fleet</h2>
            <StatusPill
              label={list?.capabilities.available ? "available" : "unavailable"}
              tone={list?.capabilities.available ? "success" : "warning"}
            />
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {list?.capabilities.binaryPath ?? "delamain"} |{" "}
            {list ? `${list.capabilities.supported.length} controls detected` : "checking"}
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={onRefresh} disabled={loading}>
          <RefreshCwIcon className={cn("size-3.5", loading && "animate-spin")} />
          Refresh
        </Button>
      </div>

      {errorMessage ? (
        <div
          aria-live="polite"
          className="border-b border-border/60 px-4 py-2 text-xs text-destructive sm:px-5"
        >
          {errorMessage}
        </div>
      ) : null}

      <div className="grid min-w-0 grid-cols-1 xl:grid-cols-[minmax(0,1fr)_minmax(380px,0.8fr)]">
        <div className="min-w-0 border-r border-border/60">
          <SectionHeader title="Peers" count={peers.length} />
          {loading && peers.length === 0 ? (
            <EmptyState label="Loading peers..." />
          ) : peers.length === 0 ? (
            <EmptyState label="No live Delamain peers." />
          ) : (
            <div className="divide-y divide-border/60">
              {peers.map((peer) => (
                <button
                  key={peer.id}
                  type="button"
                  className={cn(
                    "flex w-full min-w-0 cursor-pointer items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/35 sm:px-5",
                    selectedPeerId === peer.id && "bg-muted/55",
                  )}
                  onClick={() => onSelectPeer(peer.id)}
                >
                  <BotIcon className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-xs font-medium">{peer.name ?? peer.id}</span>
                      <StatusPill label={peer.rawStatus} tone={peerStatusTone(peer)} />
                    </div>
                    <div className="mt-1 truncate text-[11px] text-muted-foreground">
                      {peer.engine} | {peer.branch ?? "no branch"} |{" "}
                      {peer.sourceRepo ?? peer.worktreePath ?? "no repo"}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}

          <div className="border-t border-border/60 px-4 py-4 sm:px-5">
            <div className="grid gap-2">
              <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,0.7fr)]">
                <Input
                  nativeInput
                  size="sm"
                  value={spawnRepo}
                  placeholder="Repository path"
                  onChange={(event) => onSpawnRepoChange(event.currentTarget.value)}
                />
                <Input
                  nativeInput
                  size="sm"
                  value={spawnName}
                  placeholder="Peer name"
                  onChange={(event) => onSpawnNameChange(event.currentTarget.value)}
                />
              </div>
              <Textarea
                value={spawnPrompt}
                placeholder="Spawn prompt"
                className="min-h-20 text-xs"
                onChange={(event) => onSpawnPromptChange(event.currentTarget.value)}
              />
              <label className="grid gap-1 text-[11px] text-muted-foreground">
                Account
                <select
                  aria-label="Provider account"
                  className="h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground"
                  value={spawnProviderInstanceId ?? ""}
                  onChange={(event) =>
                    onSpawnProviderInstanceChange(
                      event.currentTarget.value
                        ? (event.currentTarget.value as ProviderInstanceId)
                        : null,
                    )
                  }
                >
                  <option value="">Select account</option>
                  {spawnProviderOptions.map((option) => (
                    <option key={option.instanceId} value={option.instanceId}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <div className="flex justify-end">
                <Button size="sm" onClick={onSpawn} disabled={!canSpawn || actionPending}>
                  <BotIcon className="size-3.5" />
                  Spawn Peer
                </Button>
              </div>
            </div>
          </div>
        </div>

        <div className="min-w-0">
          <SectionHeader title="Selected peer" count={selectedPeer ? 1 : 0} />
          {selectedPeer ? (
            <div className="grid gap-3 px-4 py-3 text-xs sm:px-5">
              <div className="grid gap-1 text-muted-foreground">
                <div className="truncate">
                  <span className="text-foreground">ID:</span> {selectedPeer.id}
                </div>
                <div className="truncate">
                  <span className="text-foreground">Worktree:</span>{" "}
                  {selectedPeer.worktreePath ?? "none"}
                </div>
                <div className="truncate">
                  <span className="text-foreground">Branch:</span> {selectedPeer.branch ?? "none"}
                </div>
                <div className="truncate">
                  <span className="text-foreground">Merge target:</span>{" "}
                  {selectedPeer.mergeBranch ?? selectedPeer.baseBranch ?? "none"}
                </div>
                <div className="truncate">
                  <span className="text-foreground">PR:</span>{" "}
                  {selectedPeer.prUrl ? (
                    <a
                      href={selectedPeer.prUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-primary underline-offset-2 hover:underline"
                    >
                      {selectedPeer.prUrl}
                    </a>
                  ) : (
                    "none"
                  )}
                </div>
                <div className="truncate">
                  <span className="text-foreground">Integration:</span>{" "}
                  {selectedPeer.integrationStatus ?? "none"}
                </div>
                <div className="truncate">
                  <span className="text-foreground">Last event:</span>{" "}
                  {selectedPeer.lastEvent ?? "none"}
                </div>
                <div>
                  <span className="text-foreground">Inbox:</span>{" "}
                  {inbox && inbox.messages.length > 0 ? (
                    <ul className="mt-1 grid gap-1">
                      {inbox.messages.map((msg) => (
                        <li key={msg.id} className="truncate font-mono text-[11px]">
                          <span className="text-foreground">{msg.fromPeerId}</span>
                          {msg.deliveredAt ? "" : " (queued)"}: {msg.message}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    "no messages"
                  )}
                </div>
              </div>
              <div className="grid gap-2">
                {killSwitchEnabled ? (
                  <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-600 dark:text-amber-400">
                    Automode kill switch is on — manual peer actions (spawn, reply, kill, integrate)
                    are disabled. Turn it off in the Automode tab to re-enable.
                  </div>
                ) : null}
                <Textarea
                  value={replyText}
                  placeholder="Reply to this peer"
                  className="min-h-20 text-xs"
                  onChange={(event) => onReplyTextChange(event.currentTarget.value)}
                />
                <div className="flex flex-wrap justify-end gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={onReply}
                    disabled={!canReply || actionPending}
                  >
                    <SendIcon className="size-3.5" />
                    Reply
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive-outline"
                    onClick={onKill}
                    disabled={!canKill || actionPending}
                  >
                    <CircleStopIcon className="size-3.5" />
                    Kill
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={onWait}
                    disabled={!canWait || actionPending}
                  >
                    <ListChecksIcon className="size-3.5" />
                    Wait
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={onIntegrate}
                    disabled={!canIntegrate || actionPending}
                  >
                    <GitBranchIcon className="size-3.5" />
                    Integrate
                  </Button>
                </div>
              </div>
              <div className="overflow-hidden rounded-md border border-border/70 bg-muted/20">
                <div className="border-b border-border/60 px-3 py-2 font-medium text-muted-foreground">
                  Log
                </div>
                <pre className="max-h-80 overflow-auto whitespace-pre-wrap px-3 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
                  {logLoading ? "Loading log..." : logText || "No log output."}
                </pre>
              </div>
            </div>
          ) : (
            <EmptyState label="Select a peer to inspect logs and controls." />
          )}
        </div>
      </div>
    </section>
  );
}
