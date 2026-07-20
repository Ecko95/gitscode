import type {
  GitsCodexMcpAuthAvailability,
  GitsCodexMcpAuthStatus,
  GitsMcpInventorySnapshot,
  GitsSkillInventorySnapshot,
} from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";

import { usePrimaryEnvironmentId } from "~/environments/primary";
import {
  getPrimaryEnvironmentConnection,
  readEnvironmentConnection,
  useSavedEnvironmentRuntimeStore,
} from "~/environments/runtime";
import { readUsageSummary } from "~/lib/providerUsage";
import { useStore } from "~/store";

import { normalizeBuildInfo, type BuildInfoSnapshot } from "./OverviewPanel";
import { readMcpAuthResponseError } from "./McpPanel";
import type { GitsCockpitTab } from "./tabs";

export function useGitsCockpitQueries({
  activeTab,
  selectedProjectRoot,
  selectedPeerId,
  mcpAuthSession,
}: {
  activeTab: GitsCockpitTab;
  selectedProjectRoot: string;
  selectedPeerId: string | null;
  mcpAuthSession: { readonly serverId: string; readonly sessionId: string } | null;
}) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const activeEnvironmentId = useStore((state) => state.activeEnvironmentId);
  const activeRemoteRuntime = useSavedEnvironmentRuntimeStore((state) =>
    activeEnvironmentId ? state.byId[activeEnvironmentId] : null,
  );
  const targetEnvironmentId = activeEnvironmentId ?? primaryEnvironmentId;
  const readEnvironmentClient = () => {
    if (targetEnvironmentId && targetEnvironmentId !== primaryEnvironmentId) {
      const connection = readEnvironmentConnection(targetEnvironmentId);
      if (!connection) {
        throw new Error("Remote environment is not connected.");
      }
      return connection.client;
    }
    return getPrimaryEnvironmentConnection().client;
  };
  const readGitsClient = () => readEnvironmentClient().gits;
  const query = useQuery({
    queryKey: [
      "gits",
      "cockpit",
      targetEnvironmentId,
      activeRemoteRuntime?.connectionState,
      activeRemoteRuntime?.authState,
    ],
    queryFn: async () => {
      return readGitsClient().getCockpit();
    },
    refetchInterval: 10_000,
  });
  const delamainQuery = useQuery({
    queryKey: [
      "gits",
      "delamain",
      "peers",
      targetEnvironmentId,
      activeRemoteRuntime?.connectionState,
      activeRemoteRuntime?.authState,
    ],
    queryFn: async () => readGitsClient().delamain.listPeers(),
    refetchInterval: 5_000,
  });
  const openGsdQuery = useQuery({
    queryKey: [
      "gits",
      "open-gsd",
      "status",
      targetEnvironmentId,
      activeRemoteRuntime?.connectionState,
      activeRemoteRuntime?.authState,
    ],
    queryFn: async () => readGitsClient().openGsd.getStatus(),
    refetchInterval: 30_000,
  });
  const automodeQuery = useQuery({
    queryKey: [
      "gits",
      "automode",
      "snapshot",
      targetEnvironmentId,
      activeRemoteRuntime?.connectionState,
      activeRemoteRuntime?.authState,
    ],
    queryFn: async () => readGitsClient().automode.getSnapshot(),
    refetchInterval: 5_000,
  });
  const schedulerQuery = useQuery({
    queryKey: [
      "gits",
      "automode",
      "scheduler",
      targetEnvironmentId,
      activeRemoteRuntime?.connectionState,
      activeRemoteRuntime?.authState,
    ],
    queryFn: async () => readGitsClient().automode.schedulerSnapshot(),
    refetchInterval: 10_000,
  });
  const capacityQuery = useQuery({
    queryKey: [
      "gits",
      "capacity",
      targetEnvironmentId,
      activeRemoteRuntime?.connectionState,
      activeRemoteRuntime?.authState,
    ],
    queryFn: async () => readGitsClient().capacity.getSnapshot(),
    refetchInterval: 30_000,
  });
  const hermesQuery = useQuery({
    queryKey: [
      "gits",
      "hermes",
      "status",
      targetEnvironmentId,
      activeRemoteRuntime?.connectionState,
      activeRemoteRuntime?.authState,
    ],
    queryFn: async () => readGitsClient().hermes.getStatus(),
    refetchInterval: 30_000,
  });
  const hermesSessionsQuery = useQuery({
    queryKey: [
      "gits",
      "hermes",
      "sessions",
      targetEnvironmentId,
      activeRemoteRuntime?.connectionState,
      activeRemoteRuntime?.authState,
    ],
    queryFn: async () => readGitsClient().hermes.listSessions({ limit: 8 }),
    refetchInterval: 30_000,
  });
  const hermesLogQuery = useQuery({
    queryKey: [
      "gits",
      "hermes",
      "log",
      targetEnvironmentId,
      activeRemoteRuntime?.connectionState,
      activeRemoteRuntime?.authState,
    ],
    queryFn: async () => readGitsClient().hermes.tailLog({ lines: 80 }),
    refetchInterval: 30_000,
  });
  const hermesProposalsQuery = useQuery({
    queryKey: [
      "gits",
      "hermes",
      "proposals",
      targetEnvironmentId,
      activeRemoteRuntime?.connectionState,
      activeRemoteRuntime?.authState,
    ],
    queryFn: async () => readGitsClient().hermes.listProposals(),
    refetchInterval: 10_000,
  });
  const devCommandsQuery = useQuery({
    queryKey: [
      "gits",
      "dev-commands",
      targetEnvironmentId,
      selectedProjectRoot,
      activeRemoteRuntime?.connectionState,
      activeRemoteRuntime?.authState,
    ],
    queryFn: async () => readGitsClient().devCommands.list({ projectDir: selectedProjectRoot }),
    enabled: selectedProjectRoot.trim().length > 0,
    refetchInterval: 30_000,
  });
  // Overview's "episodes by night" bar chart. Panel-local `episodesQuery` in
  // AutopilotPanel.tsx covers its own (smaller, always-on) ledger list — this is a
  // separate, wider pull just for the 14-night chart, so it only runs while Overview
  // is the active tab.
  const episodesListQuery = useQuery({
    queryKey: ["gits", "automode", "episodes", "overview", targetEnvironmentId],
    queryFn: async () => readGitsClient().automode.episodesList({ limit: 100 }),
    enabled: activeTab === "overview",
    refetchInterval: 60_000,
  });
  const resourceQuery = useQuery({
    queryKey: [
      "gits",
      "runtime-resources",
      targetEnvironmentId,
      activeRemoteRuntime?.connectionState,
      activeRemoteRuntime?.authState,
    ],
    queryFn: async () =>
      readEnvironmentClient().server.getProcessResourceHistory({
        windowMs: 15 * 60_000,
        bucketMs: 60_000,
      }),
    refetchInterval: 10_000,
  });
  const buildInfoQuery = useQuery({
    queryKey: ["gits", "build-info"],
    queryFn: async (): Promise<BuildInfoSnapshot> => {
      const response = await fetch("/api/gits/build-info", {
        headers: { accept: "application/json" },
      });
      if (response.status === 404 || response.status === 501) {
        return { status: "missing", fields: [], note: null };
      }
      if (!response.ok) {
        throw new Error(`Build info request failed with ${response.status}.`);
      }
      return normalizeBuildInfo(await response.json());
    },
    refetchInterval: 60_000,
    retry: false,
  });
  const skillsQuery = useQuery({
    queryKey: ["gits", "skills"],
    queryFn: async (): Promise<GitsSkillInventorySnapshot> => {
      const response = await fetch("/api/gits/skills", {
        headers: { accept: "application/json" },
      });
      if (!response.ok) {
        throw new Error(`Skills inventory request failed with ${response.status}.`);
      }
      return (await response.json()) as GitsSkillInventorySnapshot;
    },
    refetchInterval: 60_000,
    retry: false,
  });
  const mcpQuery = useQuery({
    queryKey: ["gits", "mcp"],
    queryFn: async (): Promise<GitsMcpInventorySnapshot> => {
      const response = await fetch("/api/gits/mcp", {
        headers: { accept: "application/json" },
      });
      if (!response.ok) {
        throw new Error(`MCP inventory request failed with ${response.status}.`);
      }
      return (await response.json()) as GitsMcpInventorySnapshot;
    },
    refetchInterval: 60_000,
    retry: false,
  });
  const mcpAuthCapabilityQuery = useQuery({
    queryKey: ["gits", "mcp-auth-capability"],
    queryFn: async (): Promise<GitsCodexMcpAuthAvailability> => {
      const response = await fetch("/api/gits/mcp/oauth/capability", {
        headers: { accept: "application/json" },
      });
      if (!response.ok) {
        throw await readMcpAuthResponseError(
          response,
          `MCP authentication preflight failed with ${response.status}.`,
        );
      }
      return (await response.json()) as GitsCodexMcpAuthAvailability;
    },
    enabled: activeTab === "system",
    retry: false,
  });
  const mcpAuthStatusQuery = useQuery({
    queryKey: ["gits", "mcp-auth-status", mcpAuthSession?.sessionId],
    queryFn: async (): Promise<GitsCodexMcpAuthStatus> => {
      const response = await fetch(
        `/api/gits/mcp/oauth/status/${encodeURIComponent(mcpAuthSession!.sessionId)}`,
        { headers: { accept: "application/json" } },
      );
      if (!response.ok) {
        throw await readMcpAuthResponseError(
          response,
          `MCP authentication status failed with ${response.status}.`,
        );
      }
      return (await response.json()) as GitsCodexMcpAuthStatus;
    },
    enabled: mcpAuthSession !== null,
    refetchInterval: (query) =>
      query.state.data === undefined || query.state.data.state === "waiting-provider"
        ? 1_000
        : false,
    retry: false,
  });
  const mcpAuthState = mcpAuthStatusQuery.data?.state;
  const refetchMcpInventory = mcpQuery.refetch;
  useEffect(() => {
    if (mcpAuthState && mcpAuthState !== "waiting-provider") {
      void refetchMcpInventory();
    }
  }, [mcpAuthState, refetchMcpInventory]);
  const usageQuery = useQuery({
    queryKey: ["gits", "usage"],
    queryFn: readUsageSummary,
    // Overview's cost stat tile and System's Usage section both need this.
    enabled: activeTab === "overview" || activeTab === "system",
    refetchOnMount: "always",
    retry: false,
  });
  const logQuery = useQuery({
    queryKey: ["gits", "delamain", "peer-log", targetEnvironmentId, selectedPeerId],
    queryFn: async () =>
      readGitsClient().delamain.readPeerLog({ peerId: selectedPeerId!, lines: 160 }),
    enabled: selectedPeerId !== null,
    refetchInterval: selectedPeerId ? 5_000 : false,
  });
  const inboxQuery = useQuery({
    queryKey: ["gits", "delamain", "peer-inbox", targetEnvironmentId, selectedPeerId],
    queryFn: async () =>
      readGitsClient().delamain.messages.inbox({ peerId: selectedPeerId!, includeDelivered: true }),
    enabled: selectedPeerId !== null,
    refetchInterval: selectedPeerId ? 5_000 : false,
  });

  return {
    targetEnvironmentId,
    readGitsClient,
    query,
    delamainQuery,
    openGsdQuery,
    automodeQuery,
    schedulerQuery,
    capacityQuery,
    hermesQuery,
    hermesSessionsQuery,
    hermesLogQuery,
    hermesProposalsQuery,
    devCommandsQuery,
    episodesListQuery,
    resourceQuery,
    buildInfoQuery,
    skillsQuery,
    mcpQuery,
    mcpAuthCapabilityQuery,
    mcpAuthStatusQuery,
    usageQuery,
    logQuery,
    inboxQuery,
  };
}
