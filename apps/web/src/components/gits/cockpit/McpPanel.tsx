import type {
  GitsCodexMcpAuthAvailability,
  GitsCodexMcpAuthStatus,
  GitsMcpInventorySnapshot,
  GitsMcpServerItem,
  GitsMcpServerProvider,
} from "@t3tools/contracts";
import {
  BotIcon,
  CheckCircle2Icon,
  CircleStopIcon,
  ExternalLinkIcon,
  PlugIcon,
  PowerIcon,
  RefreshCwIcon,
  SearchIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";

import {
  EmptyState,
  SectionHeader,
  StatBlock,
  StatusPill,
  formatCount,
  isRecord,
  statusTone,
} from "./primitives";

export type McpOverrideState = Record<string, boolean>;

const MCP_SERVER_OVERRIDE_STORAGE_KEY = "gits:mcp:overrides:v1";

export function loadMcpOverrideState(): McpOverrideState {
  if (typeof window === "undefined") {
    return {};
  }
  try {
    const raw = window.localStorage.getItem(MCP_SERVER_OVERRIDE_STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return {};
    }
    const overrides: McpOverrideState = {};
    for (const [serverId, value] of Object.entries(parsed)) {
      if (typeof value === "boolean") {
        overrides[serverId] = value;
      }
    }
    return overrides;
  } catch {
    return {};
  }
}

export function saveMcpOverrideState(overrides: McpOverrideState): void {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(MCP_SERVER_OVERRIDE_STORAGE_KEY, JSON.stringify(overrides));
}

function formatMcpProvider(provider: GitsMcpServerProvider): string {
  if (provider === "unknown") {
    return "Unknown";
  }
  return provider.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function isMcpServerEnabled(server: GitsMcpServerItem, overrides: McpOverrideState): boolean {
  return overrides[server.id] ?? server.enabled;
}

function mcpStatusTone(server: GitsMcpServerItem, enabled: boolean): ReturnType<typeof statusTone> {
  if (!enabled) {
    return "default";
  }
  if (server.status === "running") {
    return "success";
  }
  if (server.status === "error") {
    return "danger";
  }
  if (server.status === "stopped") {
    return "warning";
  }
  return "default";
}

export async function readMcpAuthResponseError(
  response: Response,
  fallback: string,
): Promise<Error> {
  try {
    const body = (await response.json()) as { error?: unknown };
    return new Error(typeof body.error === "string" && body.error ? body.error : fallback);
  } catch {
    return new Error(fallback);
  }
}

const NO_MCP_SERVERS: GitsMcpInventorySnapshot["servers"] = [];

export function McpServersPanel({
  snapshot,
  loading,
  error,
  overrides,
  authAvailability,
  authPending,
  authStatus,
  authError,
  onRefresh,
  onToggleServer,
  onAuthenticate,
  onCancelAuthentication,
}: {
  snapshot: GitsMcpInventorySnapshot | undefined;
  loading: boolean;
  error: unknown;
  overrides: McpOverrideState;
  authAvailability: GitsCodexMcpAuthAvailability | undefined;
  authPending: boolean;
  authStatus: GitsCodexMcpAuthStatus | null;
  authError: string | null;
  onRefresh: () => void;
  onToggleServer: (serverId: string, enabled: boolean) => void;
  onAuthenticate: (server: GitsMcpServerItem) => void;
  onCancelAuthentication: () => void;
}) {
  const [providerFilter, setProviderFilter] = useState<GitsMcpServerProvider | "all">("all");
  const [search, setSearch] = useState("");
  const [selectedServerId, setSelectedServerId] = useState<string | null>(null);
  const servers = snapshot?.servers ?? NO_MCP_SERVERS;
  const visibleServers = useMemo(() => {
    const query = search.trim().toLowerCase();
    return servers.filter((server) => {
      if (providerFilter !== "all" && server.provider !== providerFilter) {
        return false;
      }
      if (!query) {
        return true;
      }
      return [
        server.name,
        server.provider,
        server.command ?? "",
        server.transport ?? "",
        server.tools.join(" "),
      ]
        .join(" ")
        .toLowerCase()
        .includes(query);
    });
  }, [providerFilter, search, servers]);
  const selectedServer =
    (selectedServerId ? servers.find((server) => server.id === selectedServerId) : null) ??
    visibleServers[0] ??
    null;
  const enabledCount = servers.filter((server) => isMcpServerEnabled(server, overrides)).length;
  const overriddenCount = servers.filter(
    (server) => overrides[server.id] !== undefined && overrides[server.id] !== server.enabled,
  ).length;
  const errorMessage = error instanceof Error ? error.message : null;

  useEffect(() => {
    if (selectedServerId && visibleServers.some((server) => server.id === selectedServerId)) {
      return;
    }
    setSelectedServerId(visibleServers[0]?.id ?? null);
  }, [selectedServerId, visibleServers]);

  return (
    <section className="border-b border-border bg-background">
      <div className="flex flex-col gap-3 border-b border-border/70 px-4 py-4 sm:flex-row sm:items-start sm:justify-between sm:px-5">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="truncate text-base font-semibold">MCP Servers</h2>
            <StatusPill label="local host" tone="default" />
            <StatusPill
              label={loading && !snapshot ? "scanning" : "read-only"}
              tone={loading && !snapshot ? "warning" : "success"}
            />
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {formatCount(snapshot?.totals.serverCount ?? 0)} servers | {formatCount(enabledCount)}{" "}
            enabled | {formatCount(snapshot?.totals.toolCount ?? 0)} tools |{" "}
            {formatCount(overriddenCount)} overrides
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

      <div className="grid grid-cols-2 border-b border-border/60 sm:grid-cols-4">
        <StatBlock
          label="Servers"
          value={formatCount(snapshot?.totals.serverCount ?? 0)}
          icon={PlugIcon}
        />
        <StatBlock label="Enabled" value={formatCount(enabledCount)} icon={CheckCircle2Icon} />
        <StatBlock
          label="Tools"
          value={formatCount(snapshot?.totals.toolCount ?? 0)}
          icon={BotIcon}
        />
        <StatBlock
          label="Disabled"
          value={formatCount(snapshot?.totals.disabledCount ?? 0)}
          icon={CircleStopIcon}
        />
      </div>

      <div className="grid min-w-0 grid-cols-1 xl:grid-cols-[minmax(0,1fr)_minmax(380px,0.85fr)]">
        <div className="min-w-0 border-r border-border/60">
          <div className="grid gap-2 border-b border-border/60 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_180px] sm:px-5">
            <div className="relative min-w-0">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                nativeInput
                size="sm"
                value={search}
                placeholder="Search MCP servers"
                className="pl-8"
                onChange={(event) => setSearch(event.currentTarget.value)}
              />
            </div>
            <select
              value={providerFilter}
              className="h-8 min-w-0 rounded-md border border-input bg-background px-3 text-xs"
              onChange={(event) =>
                setProviderFilter(event.currentTarget.value as GitsMcpServerProvider | "all")
              }
            >
              <option value="all">All providers</option>
              <option value="codex">Codex</option>
              <option value="claude">Claude</option>
              <option value="cursor">Cursor</option>
            </select>
          </div>

          <SectionHeader title="Servers" count={visibleServers.length} />
          {loading && visibleServers.length === 0 ? (
            <EmptyState label="Scanning local MCP config..." />
          ) : visibleServers.length === 0 ? (
            <EmptyState label="No MCP servers match the current filters." />
          ) : (
            <div className="divide-y divide-border/60">
              {visibleServers.slice(0, 160).map((server) => {
                const enabled = isMcpServerEnabled(server, overrides);
                return (
                  <button
                    key={server.id}
                    type="button"
                    className={cn(
                      "flex w-full min-w-0 cursor-pointer items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/35 sm:px-5",
                      selectedServer?.id === server.id && "bg-muted/55",
                    )}
                    onClick={() => setSelectedServerId(server.id)}
                  >
                    <PlugIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <span className="truncate text-xs font-medium">{server.name}</span>
                        <StatusPill label={formatMcpProvider(server.provider)} tone="default" />
                        <StatusPill
                          label={enabled ? "enabled" : "disabled"}
                          tone={enabled ? "success" : "default"}
                        />
                      </div>
                      <div className="mt-1 line-clamp-2 font-mono text-[11px] text-muted-foreground">
                        {server.command ?? server.transport ?? "no command"}
                      </div>
                    </div>
                  </button>
                );
              })}
              {visibleServers.length > 160 ? (
                <div className="px-4 py-2 text-[11px] text-muted-foreground sm:px-5">
                  +{formatCount(visibleServers.length - 160)} more servers
                </div>
              ) : null}
            </div>
          )}
        </div>

        <div className="min-w-0">
          <SectionHeader title="Details" count={selectedServer ? 1 : 0} />
          {selectedServer ? (
            <div className="grid gap-4 px-4 py-4 text-xs sm:px-5">
              <div className="min-w-0">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <h3 className="truncate text-sm font-semibold">{selectedServer.name}</h3>
                  <StatusPill label={formatMcpProvider(selectedServer.provider)} tone="default" />
                  <StatusPill
                    label={selectedServer.status}
                    tone={mcpStatusTone(
                      selectedServer,
                      isMcpServerEnabled(selectedServer, overrides),
                    )}
                  />
                  <StatusPill label={`auth: ${selectedServer.authStatus}`} tone="default" />
                </div>
                {selectedServer.command ? (
                  <div className="mt-2 truncate font-mono text-[11px] text-muted-foreground">
                    {selectedServer.command}
                  </div>
                ) : null}
              </div>

              <div className="grid gap-2">
                <div className="text-[11px] font-medium uppercase text-muted-foreground/80">
                  State
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant={isMcpServerEnabled(selectedServer, overrides) ? "default" : "outline"}
                    onClick={() =>
                      onToggleServer(
                        selectedServer.id,
                        !isMcpServerEnabled(selectedServer, overrides),
                      )
                    }
                  >
                    <PowerIcon className="size-3.5" />
                    {isMcpServerEnabled(selectedServer, overrides) ? "Disable" : "Enable"}
                  </Button>
                  {overrides[selectedServer.id] !== undefined &&
                  overrides[selectedServer.id] !== selectedServer.enabled ? (
                    <StatusPill label="local override" tone="warning" />
                  ) : null}
                  {selectedServer.canAuthenticate &&
                  selectedServer.providerInstanceId &&
                  authAvailability?.available ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={authPending || authStatus?.state === "waiting-provider"}
                      onClick={() => onAuthenticate(selectedServer)}
                    >
                      <ExternalLinkIcon className="size-3.5" />
                      Authenticate
                    </Button>
                  ) : null}
                  {authStatus?.state === "waiting-provider" ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={authPending}
                      onClick={onCancelAuthentication}
                    >
                      Cancel authentication
                    </Button>
                  ) : null}
                </div>
                {selectedServer.canAuthenticate && authAvailability?.available === false ? (
                  <p className="text-[11px] text-muted-foreground">
                    Browser callback relay is unavailable. On Desktop, run the provider login with
                    an exact SSH forward for its loopback callback port, or configure the provider
                    PAT in Codex.
                  </p>
                ) : null}
                {authStatus ? (
                  <p className="text-[11px] text-muted-foreground">
                    Authentication: {authStatus.state}
                    {authStatus.message ? ` — ${authStatus.message}` : ""}
                  </p>
                ) : null}
                {authError ? <p className="text-[11px] text-destructive">{authError}</p> : null}
              </div>

              <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1.5">
                <span className="text-muted-foreground">Transport</span>
                <span className="text-right font-mono">
                  {selectedServer.transport ?? "unknown"}
                </span>
                <span className="text-muted-foreground">Source</span>
                <span className="text-right font-mono">{selectedServer.source}</span>
                <span className="text-muted-foreground">Tools</span>
                <span className="text-right font-mono">
                  {formatCount(selectedServer.toolCount)}
                </span>
                <span className="text-muted-foreground">Resources</span>
                <span className="text-right font-mono">
                  {formatCount(selectedServer.resourceCount)}
                </span>
              </div>

              {selectedServer.tools.length > 0 ? (
                <div className="grid gap-2">
                  <SectionHeader title="Tools" count={selectedServer.tools.length} />
                  <div className="flex flex-wrap gap-1.5">
                    {selectedServer.tools.slice(0, 40).map((tool) => (
                      <StatusPill key={tool} label={tool} tone="default" />
                    ))}
                  </div>
                </div>
              ) : null}

              {selectedServer.configPath ? (
                <div className="grid gap-1">
                  <div className="text-[11px] font-medium uppercase text-muted-foreground/80">
                    Config
                  </div>
                  <div className="truncate font-mono text-[11px] text-muted-foreground">
                    {selectedServer.configPath}
                  </div>
                </div>
              ) : null}

              {selectedServer.error ? (
                <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-destructive">
                  {selectedServer.error}
                </div>
              ) : null}

              <div className="grid gap-2">
                <SectionHeader title="Provider summaries" count={snapshot?.providers.length ?? 0} />
                <div className="overflow-hidden rounded-md border border-border/70">
                  {(snapshot?.providers ?? []).map((provider) => (
                    <div
                      key={provider.provider}
                      className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-3 border-b border-border/60 px-3 py-2 last:border-b-0"
                    >
                      <span className="truncate font-medium">
                        {formatMcpProvider(provider.provider)}
                      </span>
                      <span className="font-mono text-muted-foreground">
                        {formatCount(provider.serverCount)}
                      </span>
                      <span className="font-mono text-muted-foreground">
                        {formatCount(provider.toolCount)} tools
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {(snapshot?.warnings ?? []).length > 0 ? (
                <div className="rounded-md border border-amber-500/25 bg-amber-500/5 p-3 text-amber-700 dark:text-amber-300">
                  {(snapshot?.warnings ?? []).slice(0, 3).join(" | ")}
                </div>
              ) : null}
            </div>
          ) : (
            <EmptyState label="Select an MCP server to inspect." />
          )}
        </div>
      </div>
    </section>
  );
}
