import type {
  GitsCodexMcpAuthStartResult,
  GitsMcpServerItem,
  HermesCommandResult,
  HermesScheduleKind,
  OpenGsdCommandResult,
} from "@t3tools/contracts";
import { useMutation } from "@tanstack/react-query";
import { RefreshCwIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { readLocalApi } from "../../localApi";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset, SidebarTrigger } from "../ui/sidebar";

import { CockpitTabNav } from "./cockpit/CockpitTabNav";
import type { GitsCockpitTab } from "./cockpit/tabs";
import { formatCount } from "./cockpit/primitives";
import {
  BuildProvenancePanel,
  CockpitOverviewPanel,
  ResourceVisibilityPanel,
} from "./cockpit/OverviewPanel";
import { AutopilotPanel } from "./cockpit/AutopilotPanel";
import { FleetOpsPanel } from "./cockpit/FleetOpsPanel";
import { SystemPanel } from "./cockpit/SystemPanel";
import {
  loadSkillReviewState,
  saveSkillReviewState,
  type SkillReviewState,
} from "./cockpit/SkillsPanel";
import {
  loadMcpOverrideState,
  readMcpAuthResponseError,
  saveMcpOverrideState,
  type McpOverrideState,
} from "./cockpit/McpPanel";
import {
  EMPTY_MOTOKO_TRANSCRIPT,
  MOTOKO_ROOT_ROUTE_VALUE,
  MotokoPanel,
  loadMotokoTranscripts,
  makeTranscriptEntryId,
  motokoDecisionSummary,
  saveMotokoTranscripts,
  type MotokoInteractionMode,
  type MotokoProposalDecision,
  type MotokoTranscriptEntry,
  type MotokoTranscriptState,
} from "./cockpit/MotokoPanel";
import { handleDevOpenPreview } from "./cockpit/DevPanel";
import { useGitsCockpitQueries } from "./cockpit/useGitsCockpitQueries";
import { useDevCommandSessions } from "./cockpit/useDevCommandSessions";

export function GitsCockpit() {
  const [activeTab, setActiveTab] = useState<GitsCockpitTab>("overview");
  const [selectedPeerId, setSelectedPeerId] = useState<string | null>(null);
  const [spawnRepo, setSpawnRepo] = useState("");
  const [spawnName, setSpawnName] = useState("");
  const [spawnPrompt, setSpawnPrompt] = useState("");
  const [replyText, setReplyText] = useState("");
  const [selectedProjectRoot, setSelectedProjectRoot] = useState("");
  const [mcpAuthSession, setMcpAuthSession] = useState<{
    readonly serverId: string;
    readonly sessionId: string;
  } | null>(null);
  const [mcpAuthError, setMcpAuthError] = useState<string | null>(null);
  const [motokoChatInput, setMotokoChatInput] = useState("");
  // One chat per Motoko route: keyed by trimmed project root ("" = root/gits).
  const [motokoTranscripts, setMotokoTranscripts] = useState<MotokoTranscriptState>(() =>
    loadMotokoTranscripts(),
  );
  useEffect(() => {
    saveMotokoTranscripts(motokoTranscripts);
  }, [motokoTranscripts]);
  const motokoRoute = selectedProjectRoot.trim();
  const motokoTranscript = motokoTranscripts[motokoRoute] ?? EMPTY_MOTOKO_TRANSCRIPT;
  const appendMotokoTranscript = (routeKey: string, entry: MotokoTranscriptEntry) => {
    setMotokoTranscripts((current) => ({
      ...current,
      [routeKey]: [...(current[routeKey] ?? []), entry],
    }));
  };
  const [motokoInteractionMode, setMotokoInteractionMode] =
    useState<MotokoInteractionMode>("default");
  const [motokoScheduleKind, setMotokoScheduleKind] =
    useState<HermesScheduleKind>("daily-briefing");
  const [gsdInitInput, setGsdInitInput] = useState("");
  const [gsdAutoInitInput, setGsdAutoInitInput] = useState("");
  const [gsdModel, setGsdModel] = useState("");
  const [gsdMaxBudget, setGsdMaxBudget] = useState("");
  const [skillReviews, setSkillReviews] = useState<SkillReviewState>(() => loadSkillReviewState());
  const [mcpOverrides, setMcpOverrides] = useState<McpOverrideState>(() => loadMcpOverrideState());
  const [automodeGoalTitle, setAutomodeGoalTitle] = useState("");
  const [automodeGoalRepo, setAutomodeGoalRepo] = useState("");
  const [automodeGoalModel, setAutomodeGoalModel] = useState("");
  const [automodeGoalPrompt, setAutomodeGoalPrompt] = useState("");
  const [openGsdCommandResult, setOpenGsdCommandResult] = useState<
    OpenGsdCommandResult | undefined
  >(undefined);
  const [hermesCommandResult, setHermesCommandResult] = useState<HermesCommandResult | undefined>(
    undefined,
  );

  const {
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
  } = useGitsCockpitQueries({ activeTab, selectedProjectRoot, selectedPeerId, mcpAuthSession });

  const {
    devSessionStateByCommandId,
    devActionError,
    devActiveCommandId,
    devActionPending,
    handleDevStart,
    handleDevStop,
    handleDevCopyLaunchCommand,
  } = useDevCommandSessions({ targetEnvironmentId, selectedProjectRoot });

  const mcpAuthStartMutation = useMutation({
    mutationFn: async (server: GitsMcpServerItem) => {
      if (!server.providerInstanceId) {
        throw new Error("The selected Codex instance is unavailable.");
      }
      const response = await fetch("/api/gits/mcp/oauth/start", {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({
          providerInstanceId: server.providerInstanceId,
          serverName: server.name,
        }),
      });
      if (!response.ok) {
        throw await readMcpAuthResponseError(
          response,
          `MCP authentication failed with ${response.status}.`,
        );
      }
      const result = (await response.json()) as GitsCodexMcpAuthStartResult;
      const cancelStartedSession = () =>
        fetch("/api/gits/mcp/oauth/cancel", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId: result.sessionId }),
        }).catch(() => undefined);
      try {
        let authorizationUrl: URL;
        try {
          authorizationUrl = new URL(result.authorizationUrl);
        } catch {
          throw new Error("The provider returned an invalid authorization URL.");
        }
        if (authorizationUrl.protocol !== "https:") {
          throw new Error("The provider returned an invalid authorization URL.");
        }
        const localApi = readLocalApi();
        if (!localApi) {
          throw new Error("Opening the authorization page is unavailable.");
        }
        await localApi.shell.openExternal(result.authorizationUrl);
      } catch (cause) {
        await cancelStartedSession();
        if (
          cause instanceof Error &&
          (cause.message === "The provider returned an invalid authorization URL." ||
            cause.message === "Opening the authorization page is unavailable.")
        ) {
          throw cause;
        }
        throw new Error("The authorization page could not be opened.", { cause });
      }
      return { serverId: server.id, sessionId: result.sessionId };
    },
    onMutate: () => setMcpAuthError(null),
    onSuccess: setMcpAuthSession,
    onError: (cause) =>
      setMcpAuthError(cause instanceof Error ? cause.message : "MCP authentication failed."),
  });
  const mcpAuthCancelMutation = useMutation({
    mutationFn: async () => {
      if (!mcpAuthSession) return;
      const response = await fetch("/api/gits/mcp/oauth/cancel", {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ sessionId: mcpAuthSession.sessionId }),
      });
      if (!response.ok) {
        throw await readMcpAuthResponseError(
          response,
          `MCP authentication cancellation failed with ${response.status}.`,
        );
      }
    },
    onSuccess: async () => {
      await mcpAuthStatusQuery.refetch();
    },
    onError: (cause) =>
      setMcpAuthError(
        cause instanceof Error ? cause.message : "MCP authentication cancellation failed.",
      ),
  });
  const peerIds = useMemo(
    () => new Set((delamainQuery.data?.peers ?? []).map((peer) => peer.id)),
    [delamainQuery.data?.peers],
  );
  const selectedPeer = selectedPeerId
    ? delamainQuery.data?.peers.find((peer) => peer.id === selectedPeerId)
    : null;
  const hermesCheckMutation = useMutation({
    mutationFn: async () => readGitsClient().hermes.check(),
    onSuccess: async (result) => {
      setHermesCommandResult(result);
      await hermesQuery.refetch();
    },
  });
  const hermesSetupMutation = useMutation({
    mutationFn: async () => readGitsClient().hermes.setupCodexOAuth(),
    onSuccess: async (result) => {
      setHermesCommandResult(result);
      await Promise.all([hermesQuery.refetch(), hermesLogQuery.refetch()]);
    },
  });
  const hermesAcpMutation = useMutation({
    mutationFn: async () =>
      readGitsClient().hermes.startAcpSession(
        selectedProjectRoot.trim().length > 0 ? { cwd: selectedProjectRoot.trim() } : {},
      ),
    onSuccess: async (result) => {
      setHermesCommandResult(result);
      await Promise.all([hermesQuery.refetch(), hermesLogQuery.refetch()]);
    },
  });
  const hermesContextMutation = useMutation({
    mutationFn: async () =>
      readGitsClient().hermes.writeProjectContext({ projectDir: selectedProjectRoot.trim() }),
    onSuccess: async () => {
      await hermesLogQuery.refetch();
    },
  });
  const hermesInspectMutation = useMutation({
    mutationFn: async () =>
      readGitsClient().hermes.inspectGits({ projectDir: selectedProjectRoot.trim() }),
    onSuccess: async () => {
      await Promise.all([
        hermesProposalsQuery.refetch(),
        hermesLogQuery.refetch(),
        hermesQuery.refetch(),
      ]);
    },
  });
  const hermesChatMutation = useMutation({
    // routeKey travels with the request so replies land in the chat they were sent from,
    // even if the operator switches repos mid-flight.
    mutationFn: async (input: { message: string; routeKey: string }) => {
      const effectiveMessage =
        motokoInteractionMode === "plan"
          ? [
              "Motoko interaction mode: plan.",
              "Respond with analysis, options, and a proposed approval path. Do not recommend direct execution.",
              "",
              input.message,
            ].join("\n")
          : input.message;

      return readGitsClient().hermes.chat({
        message: effectiveMessage,
        ...(input.routeKey.length > 0 ? { projectDir: input.routeKey } : {}),
      });
    },
    onMutate: async (input) => {
      appendMotokoTranscript(input.routeKey, {
        id: makeTranscriptEntryId("operator", new Date().toISOString()),
        role: "operator",
        message: input.message,
        createdAt: new Date().toISOString(),
      });
    },
    onSuccess: async (result, input) => {
      appendMotokoTranscript(input.routeKey, {
        id: makeTranscriptEntryId("motoko", result.createdAt),
        role: "motoko",
        message: result.response,
        createdAt: result.createdAt,
        result,
      });
      // No input clear here: MotokoPanel clears optimistically at submit time and pushes
      // the empty value up. Clearing again would wipe a message typed during the in-flight
      // window (the panel's ref-diff sync treats direct shell writes as external resets).
      await Promise.all([
        hermesLogQuery.refetch(),
        hermesQuery.refetch(),
        ...(result.proposal ? [hermesProposalsQuery.refetch()] : []),
      ]);
    },
    onError: (error, input) => {
      appendMotokoTranscript(input.routeKey, {
        id: makeTranscriptEntryId("motoko", new Date().toISOString()),
        role: "motoko",
        message: error instanceof Error ? error.message : "Motoko chat failed.",
        createdAt: new Date().toISOString(),
      });
    },
  });
  const hermesDecisionMutation = useMutation({
    mutationFn: async (input: {
      proposalId: string;
      decision: MotokoProposalDecision;
      routeKey: string;
      title: string;
    }) => {
      const client = readGitsClient();
      const decided = await client.hermes.decideProposal({
        proposalId: input.proposalId,
        decision: input.decision,
      });
      if (input.decision !== "approve" || decided.status !== "approved") {
        return { decided, draft: null };
      }
      // Approval means "go" through the automode rails: the server-side approve bridge
      // enqueues delamain-peer drafts as automode goals (own branch, verify floor, held
      // PR). Never spawn a raw peer here — an unpinned spawn would let delamain merge
      // unreviewed work straight into the origin default branch.
      const draft = await client.hermes.draftFromProposal({ proposalId: input.proposalId });
      return { decided, draft };
    },
    onSuccess: async (result, input) => {
      appendMotokoTranscript(input.routeKey, {
        id: makeTranscriptEntryId("motoko", new Date().toISOString()),
        role: "motoko",
        message: motokoDecisionSummary(input.decision, input.title, result),
        createdAt: new Date().toISOString(),
      });
      await Promise.all([hermesProposalsQuery.refetch(), hermesQuery.refetch()]);
    },
    onError: (error, input) => {
      appendMotokoTranscript(input.routeKey, {
        id: makeTranscriptEntryId("motoko", new Date().toISOString()),
        role: "motoko",
        message: `Decision on "${input.title}" failed: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
        createdAt: new Date().toISOString(),
      });
    },
  });
  const hermesDraftMutation = useMutation({
    mutationFn: async (proposalId: string) =>
      readGitsClient().hermes.draftFromProposal({ proposalId }),
    onSuccess: async () => {
      await hermesProposalsQuery.refetch();
    },
  });
  const hermesScheduleMutation = useMutation({
    mutationFn: async () =>
      readGitsClient().hermes.runSchedule({
        kind: motokoScheduleKind,
        ...(selectedProjectRoot.trim().length > 0
          ? { projectDir: selectedProjectRoot.trim() }
          : {}),
      }),
    onSuccess: async () => {
      await Promise.all([hermesProposalsQuery.refetch(), hermesQuery.refetch()]);
    },
  });
  const spawnMutation = useMutation({
    mutationFn: async () =>
      readGitsClient().delamain.spawnPeer({
        repo: spawnRepo.trim(),
        prompt: spawnPrompt.trim(),
        ...(spawnName.trim().length > 0 ? { name: spawnName.trim() } : {}),
      }),
    onSuccess: async (peer) => {
      setSelectedPeerId(peer.id);
      setSpawnPrompt("");
      await delamainQuery.refetch();
    },
  });
  const replyMutation = useMutation({
    mutationFn: async () =>
      readGitsClient().delamain.sendPeerReply({
        peerId: selectedPeerId!,
        prompt: replyText.trim(),
      }),
    onSuccess: async () => {
      setReplyText("");
      await Promise.all([delamainQuery.refetch(), logQuery.refetch()]);
    },
  });
  const killMutation = useMutation({
    mutationFn: async () => readGitsClient().delamain.killPeer({ peerId: selectedPeerId! }),
    onSuccess: async () => {
      await Promise.all([delamainQuery.refetch(), logQuery.refetch()]);
    },
  });
  const waitMutation = useMutation({
    mutationFn: async () => readGitsClient().delamain.waitForPeer({ peerId: selectedPeerId! }),
    onSuccess: async (peer) => {
      setSelectedPeerId(peer.id);
      await Promise.all([delamainQuery.refetch(), logQuery.refetch()]);
    },
  });
  const integrateMutation = useMutation({
    mutationFn: async () => readGitsClient().delamain.integratePeer({ peerId: selectedPeerId! }),
    onSuccess: async (result) => {
      setSelectedPeerId(result.peer.id);
      await Promise.all([delamainQuery.refetch(), logQuery.refetch()]);
    },
  });
  const gsdCommonInput = () => {
    const maxBudget = Number(gsdMaxBudget);
    return {
      projectDir: selectedProjectRoot.trim(),
      ...(gsdModel.trim().length > 0 ? { model: gsdModel.trim() } : {}),
      ...(Number.isFinite(maxBudget) && maxBudget >= 0 && gsdMaxBudget.trim().length > 0
        ? { maxBudgetUsd: maxBudget }
        : {}),
    };
  };
  const gsdInitMutation = useMutation({
    mutationFn: async () =>
      readGitsClient().openGsd.initProject({
        ...gsdCommonInput(),
        input: gsdInitInput.trim(),
      }),
    onSuccess: async (result) => {
      setOpenGsdCommandResult(result);
      await query.refetch();
    },
  });
  const gsdAutoMutation = useMutation({
    mutationFn: async () =>
      readGitsClient().openGsd.runAuto({
        ...gsdCommonInput(),
        ...(gsdAutoInitInput.trim().length > 0 ? { initInput: gsdAutoInitInput.trim() } : {}),
      }),
    onSuccess: async (result) => {
      setOpenGsdCommandResult(result);
      await query.refetch();
    },
  });
  const automodeKillSwitchEnabled = automodeQuery.data?.policy.killSwitchEnabled ?? true;
  const automodeKillSwitchMutation = useMutation({
    mutationFn: async (killSwitchEnabled: boolean) =>
      readGitsClient().automode.updatePolicy({ killSwitchEnabled }),
    onSuccess: async () => {
      await automodeQuery.refetch();
    },
  });
  const automodeEnqueueMutation = useMutation({
    mutationFn: async () =>
      readGitsClient().automode.enqueueGoal({
        title: automodeGoalTitle.trim(),
        repo: automodeGoalRepo.trim(),
        prompt: automodeGoalPrompt.trim(),
        ...(automodeGoalModel.trim().length > 0 ? { model: automodeGoalModel.trim() } : {}),
      }),
    onSuccess: async () => {
      setAutomodeGoalTitle("");
      setAutomodeGoalPrompt("");
      await automodeQuery.refetch();
    },
  });
  const automodeApproveMutation = useMutation({
    mutationFn: async (goalId: string) => readGitsClient().automode.approveGoal({ goalId }),
    onSuccess: async () => {
      await automodeQuery.refetch();
    },
  });
  const automodeRejectMutation = useMutation({
    mutationFn: async (goalId: string) =>
      readGitsClient().automode.rejectGoal({ goalId, reason: "Rejected in cockpit." }),
    onSuccess: async () => {
      await automodeQuery.refetch();
    },
  });
  const automodeDispatchMutation = useMutation({
    mutationFn: async (goalId: string) => readGitsClient().automode.dispatchGoal({ goalId }),
    onSuccess: async () => {
      await Promise.all([automodeQuery.refetch(), delamainQuery.refetch()]);
    },
  });
  const schedulerSetConfigMutation = useMutation({
    mutationFn: async (input: { enabled: boolean }) =>
      readGitsClient().automode.schedulerSetConfig(input),
    onSuccess: async () => {
      await schedulerQuery.refetch();
    },
  });
  const schedulerArmMutation = useMutation({
    mutationFn: async () => readGitsClient().automode.schedulerArm(),
    onSuccess: async () => {
      await schedulerQuery.refetch();
    },
  });
  const schedulerDisarmMutation = useMutation({
    mutationFn: async () =>
      readGitsClient().automode.schedulerDisarm({ reason: "Disarmed in cockpit." }),
    onSuccess: async () => {
      await schedulerQuery.refetch();
    },
  });
  const driverResumeMutation = useMutation({
    mutationFn: async () => readGitsClient().automode.resumeDriver(),
    onSuccess: async () => {
      await automodeQuery.refetch();
    },
  });
  const actionError =
    spawnMutation.error ??
    replyMutation.error ??
    killMutation.error ??
    waitMutation.error ??
    integrateMutation.error;
  const actionPending =
    spawnMutation.isPending ||
    replyMutation.isPending ||
    killMutation.isPending ||
    waitMutation.isPending ||
    integrateMutation.isPending;
  const openGsdActionError = gsdInitMutation.error ?? gsdAutoMutation.error;
  const openGsdActionPending = gsdInitMutation.isPending || gsdAutoMutation.isPending;
  const hermesActionError =
    hermesCheckMutation.error ??
    hermesSetupMutation.error ??
    hermesAcpMutation.error ??
    hermesContextMutation.error ??
    hermesInspectMutation.error ??
    hermesChatMutation.error ??
    hermesDecisionMutation.error ??
    hermesDraftMutation.error ??
    hermesScheduleMutation.error;
  const hermesActionPending =
    hermesCheckMutation.isPending ||
    hermesSetupMutation.isPending ||
    hermesAcpMutation.isPending ||
    hermesContextMutation.isPending ||
    hermesInspectMutation.isPending ||
    hermesChatMutation.isPending ||
    hermesDecisionMutation.isPending ||
    hermesDraftMutation.isPending ||
    hermesScheduleMutation.isPending;
  const automodeActionError =
    automodeKillSwitchMutation.error ??
    automodeEnqueueMutation.error ??
    automodeApproveMutation.error ??
    automodeRejectMutation.error ??
    automodeDispatchMutation.error ??
    schedulerSetConfigMutation.error ??
    schedulerArmMutation.error ??
    schedulerDisarmMutation.error ??
    driverResumeMutation.error;
  const automodeActionPending =
    automodeKillSwitchMutation.isPending ||
    automodeEnqueueMutation.isPending ||
    automodeApproveMutation.isPending ||
    automodeRejectMutation.isPending ||
    automodeDispatchMutation.isPending ||
    schedulerSetConfigMutation.isPending ||
    schedulerArmMutation.isPending ||
    schedulerDisarmMutation.isPending ||
    driverResumeMutation.isPending;
  const updateSkillReview = (
    skillId: string,
    updater: (current: SkillReviewState[string]) => SkillReviewState[string],
  ) => {
    setSkillReviews((current) => {
      const next = {
        ...current,
        [skillId]: updater(current[skillId] ?? { rating: null, review: "" }),
      };
      saveSkillReviewState(next);
      return next;
    });
  };

  const toggleMcpServer = (serverId: string, enabled: boolean) => {
    setMcpOverrides((current) => {
      const next = { ...current, [serverId]: enabled };
      saveMcpOverrideState(next);
      return next;
    });
  };

  useEffect(() => {
    const peers = delamainQuery.data?.peers;
    if (peers === undefined) {
      return;
    }
    if (selectedPeerId !== null && peerIds.has(selectedPeerId)) {
      return;
    }
    setSelectedPeerId(peers[0]?.id ?? null);
  }, [delamainQuery.data?.peers, peerIds, selectedPeerId]);

  useEffect(() => {
    const projects = query.data?.projects;
    if (projects === undefined) {
      return;
    }
    const projectRoots = projects.map((project) => project.project.rootPath);
    if (
      selectedProjectRoot === MOTOKO_ROOT_ROUTE_VALUE ||
      projectRoots.includes(selectedProjectRoot)
    ) {
      return;
    }
    setSelectedProjectRoot(MOTOKO_ROOT_ROUTE_VALUE);
  }, [query.data?.projects, selectedProjectRoot]);

  useEffect(() => {
    if (automodeGoalRepo.trim().length > 0) {
      return;
    }
    setAutomodeGoalRepo(selectedProjectRoot);
  }, [automodeGoalRepo, selectedProjectRoot]);

  const tabCounts = useMemo<Record<GitsCockpitTab, string>>(() => {
    const runningGoals =
      automodeQuery.data?.goals.filter((goal) => goal.status === "running").length ?? 0;
    const runningDevSessions = Object.values(devSessionStateByCommandId).filter(
      (session) => session?.status === "running",
    ).length;
    const pendingProposals =
      hermesProposalsQuery.data?.proposals.filter((proposal) => proposal.status === "proposed")
        .length ?? 0;
    const mcpErrorCount = mcpQuery.data?.totals.errorCount ?? 0;
    return {
      overview: "—",
      motoko: formatCount(pendingProposals),
      autopilot: formatCount((automodeQuery.data?.pendingApprovalCount ?? 0) + runningGoals),
      fleet: formatCount((automodeQuery.data?.activePeerCount ?? 0) + runningDevSessions),
      system: mcpQuery.data ? (mcpErrorCount > 0 ? formatCount(mcpErrorCount) : "ok") : "—",
    };
  }, [
    automodeQuery.data?.activePeerCount,
    automodeQuery.data?.goals,
    automodeQuery.data?.pendingApprovalCount,
    devSessionStateByCommandId,
    hermesProposalsQuery.data?.proposals,
    mcpQuery.data,
  ]);
  // ponytail: 5s/10s pollers excluded so the header spinner only reflects slower, user-meaningful refreshes
  const isRefreshing =
    capacityQuery.isFetching ||
    hermesQuery.isFetching ||
    hermesSessionsQuery.isFetching ||
    hermesLogQuery.isFetching ||
    devCommandsQuery.isFetching ||
    openGsdQuery.isFetching ||
    buildInfoQuery.isFetching ||
    skillsQuery.isFetching ||
    mcpQuery.isFetching ||
    usageQuery.isFetching;

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <header className="flex min-h-14 shrink-0 items-center justify-between gap-3 border-b border-border bg-card px-4 sm:px-5">
        <div className="flex min-w-0 items-center gap-2">
          <SidebarTrigger className="size-7 shrink-0 md:hidden" />
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold">GITS Cockpit</h1>
            <p className="truncate text-xs text-muted-foreground">DevOS, GSD, and fleet control</p>
          </div>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            void Promise.all([
              query.refetch(),
              delamainQuery.refetch(),
              automodeQuery.refetch(),
              schedulerQuery.refetch(),
              capacityQuery.refetch(),
              hermesQuery.refetch(),
              hermesSessionsQuery.refetch(),
              hermesLogQuery.refetch(),
              hermesProposalsQuery.refetch(),
              ...(selectedProjectRoot ? [devCommandsQuery.refetch()] : []),
              episodesListQuery.refetch(),
              openGsdQuery.refetch(),
              resourceQuery.refetch(),
              buildInfoQuery.refetch(),
              skillsQuery.refetch(),
              mcpQuery.refetch(),
              usageQuery.refetch(),
            ]);
          }}
          disabled={isRefreshing}
        >
          <RefreshCwIcon className={cn("size-3.5", isRefreshing && "animate-spin")} />
          Refresh
        </Button>
      </header>

      <ScrollArea chainVerticalScroll scrollFade className="min-h-0 flex-1">
        {query.isPending ? (
          <div className="px-5 py-8 text-sm text-muted-foreground">Loading cockpit state...</div>
        ) : query.error ? (
          <div className="px-5 py-8 text-sm text-destructive">
            {query.error instanceof Error ? query.error.message : "Failed to load cockpit state."}
          </div>
        ) : query.data ? (
          <>
            <CockpitTabNav activeTab={activeTab} counts={tabCounts} onTabChange={setActiveTab} />
            <div
              role="tabpanel"
              id={`gits-cockpit-panel-${activeTab}`}
              aria-labelledby={`gits-cockpit-tab-${activeTab}`}
            >
              {activeTab === "overview" ? (
                <>
                  <CockpitOverviewPanel
                    automode={automodeQuery.data}
                    scheduler={schedulerQuery.data}
                    capacity={capacityQuery.data}
                    history={resourceQuery.data}
                    episodes={episodesListQuery.data}
                    usage={usageQuery.data}
                    onNavigate={setActiveTab}
                  />
                  <details className="border-b border-border bg-background">
                    <summary className="cursor-pointer select-none px-4 py-3 text-xs font-semibold uppercase text-muted-foreground/80 sm:px-5">
                      Build provenance &amp; runtime visibility
                    </summary>
                    <BuildProvenancePanel
                      buildInfo={buildInfoQuery.data}
                      loading={buildInfoQuery.isPending || buildInfoQuery.isFetching}
                      error={buildInfoQuery.error}
                      onRefresh={() => void buildInfoQuery.refetch()}
                    />
                    <ResourceVisibilityPanel
                      snapshot={query.data}
                      automode={automodeQuery.data}
                      history={resourceQuery.data}
                      loading={resourceQuery.isPending || resourceQuery.isFetching}
                      error={resourceQuery.error}
                      onRefresh={() => void resourceQuery.refetch()}
                    />
                  </details>
                </>
              ) : null}
              {activeTab === "motoko" ? (
                <MotokoPanel
                  status={hermesQuery.data}
                  capacity={capacityQuery.data}
                  sessions={hermesSessionsQuery.data}
                  projects={query.data?.projects ?? []}
                  log={hermesLogQuery.data}
                  proposals={hermesProposalsQuery.data}
                  loading={
                    hermesQuery.isPending ||
                    hermesQuery.isFetching ||
                    hermesSessionsQuery.isFetching ||
                    hermesLogQuery.isFetching ||
                    hermesProposalsQuery.isFetching ||
                    capacityQuery.isFetching
                  }
                  error={
                    hermesQuery.error ??
                    hermesSessionsQuery.error ??
                    hermesLogQuery.error ??
                    hermesProposalsQuery.error ??
                    capacityQuery.error
                  }
                  actionError={hermesActionError}
                  chatResult={hermesChatMutation.data}
                  commandResult={hermesCommandResult}
                  draft={hermesDraftMutation.data}
                  scheduleResult={hermesScheduleMutation.data}
                  transcript={motokoTranscript}
                  selectedProjectRoot={selectedProjectRoot}
                  chatInput={motokoChatInput}
                  interactionMode={motokoInteractionMode}
                  scheduleKind={motokoScheduleKind}
                  actionPending={hermesActionPending}
                  onRefresh={() => {
                    void Promise.all([
                      hermesQuery.refetch(),
                      hermesSessionsQuery.refetch(),
                      hermesLogQuery.refetch(),
                      hermesProposalsQuery.refetch(),
                      capacityQuery.refetch(),
                    ]);
                  }}
                  onToggleInteractionMode={() =>
                    setMotokoInteractionMode((mode) => (mode === "plan" ? "default" : "plan"))
                  }
                  onProjectRootChange={setSelectedProjectRoot}
                  onChatInputChange={setMotokoChatInput}
                  onScheduleKindChange={setMotokoScheduleKind}
                  onCheck={() => void hermesCheckMutation.mutate()}
                  onSetupCodexOAuth={() => void hermesSetupMutation.mutate()}
                  onStartAcp={() => void hermesAcpMutation.mutate()}
                  onInspectGits={() => void hermesInspectMutation.mutate()}
                  onChatSubmit={() => {
                    const message = motokoChatInput.trim();
                    if (message.length === 0) {
                      return;
                    }
                    void hermesChatMutation.mutate({ message, routeKey: motokoRoute });
                  }}
                  onClearChat={() =>
                    setMotokoTranscripts((current) => ({ ...current, [motokoRoute]: [] }))
                  }
                  onNewChat={() => {
                    setMotokoTranscripts((current) => ({ ...current, [motokoRoute]: [] }));
                    setMotokoChatInput("");
                    hermesChatMutation.reset();
                  }}
                  onDecision={(proposal, decision) =>
                    void hermesDecisionMutation.mutate({
                      proposalId: proposal.id,
                      decision,
                      routeKey: motokoRoute,
                      title: proposal.title,
                    })
                  }
                  onWriteContext={() => void hermesContextMutation.mutate()}
                  onDraft={(proposalId) => void hermesDraftMutation.mutate(proposalId)}
                  onRunSchedule={() => void hermesScheduleMutation.mutate()}
                />
              ) : null}
              {activeTab === "autopilot" ? (
                <AutopilotPanel
                  snapshot={automodeQuery.data}
                  scheduler={schedulerQuery.data}
                  loading={automodeQuery.isPending || automodeQuery.isFetching}
                  error={automodeQuery.error}
                  actionError={automodeActionError}
                  actionPending={automodeActionPending}
                  killSwitchEnabled={automodeKillSwitchEnabled}
                  goalTitle={automodeGoalTitle}
                  goalRepo={automodeGoalRepo}
                  goalModel={automodeGoalModel}
                  goalPrompt={automodeGoalPrompt}
                  projects={query.data?.projects}
                  onRefresh={() => void automodeQuery.refetch()}
                  onKillSwitchChange={(next) => void automodeKillSwitchMutation.mutate(next)}
                  onGoalTitleChange={setAutomodeGoalTitle}
                  onGoalRepoChange={setAutomodeGoalRepo}
                  onGoalModelChange={setAutomodeGoalModel}
                  onGoalPromptChange={setAutomodeGoalPrompt}
                  onEnqueueGoal={() => void automodeEnqueueMutation.mutate()}
                  onApproveGoal={(goalId) => void automodeApproveMutation.mutate(goalId)}
                  onRejectGoal={(goalId) => {
                    if (window.confirm(`Reject automode goal ${goalId}?`)) {
                      void automodeRejectMutation.mutate(goalId);
                    }
                  }}
                  onDispatchGoal={(goalId) => void automodeDispatchMutation.mutate(goalId)}
                  onSchedulerEnabledChange={(enabled) =>
                    void schedulerSetConfigMutation.mutate({ enabled })
                  }
                  onSchedulerArm={() => void schedulerArmMutation.mutate()}
                  onSchedulerDisarm={() => void schedulerDisarmMutation.mutate()}
                  onResumeDriver={() => void driverResumeMutation.mutate()}
                />
              ) : null}
              {activeTab === "fleet" ? (
                <FleetOpsPanel
                  peerFleet={{
                    list: delamainQuery.data,
                    loading: delamainQuery.isPending || delamainQuery.isFetching,
                    error: delamainQuery.error,
                    selectedPeerId: selectedPeer?.id ?? selectedPeerId,
                    logText: logQuery.data?.text,
                    logLoading: logQuery.isPending || logQuery.isFetching,
                    inbox: inboxQuery.data,
                    actionError: actionError ?? logQuery.error,
                    spawnRepo,
                    spawnName,
                    spawnPrompt,
                    replyText,
                    actionPending,
                    killSwitchEnabled: automodeQuery.data?.policy.killSwitchEnabled ?? false,
                    onRefresh: () => void delamainQuery.refetch(),
                    onSelectPeer: setSelectedPeerId,
                    onSpawnRepoChange: setSpawnRepo,
                    onSpawnNameChange: setSpawnName,
                    onSpawnPromptChange: setSpawnPrompt,
                    onReplyTextChange: setReplyText,
                    onSpawn: () => void spawnMutation.mutate(),
                    onReply: () => void replyMutation.mutate(),
                    onWait: () => void waitMutation.mutate(),
                    onKill: () => {
                      if (!selectedPeerId) {
                        return;
                      }
                      if (window.confirm(`Kill Delamain peer ${selectedPeerId}?`)) {
                        void killMutation.mutate();
                      }
                    },
                    onIntegrate: () => {
                      if (!selectedPeerId) {
                        return;
                      }
                      if (
                        window.confirm(
                          `Open an integration PR for Delamain peer ${selectedPeerId}?`,
                        )
                      ) {
                        void integrateMutation.mutate();
                      }
                    },
                  }}
                  devCommands={{
                    list: devCommandsQuery.data,
                    loading: devCommandsQuery.isFetching,
                    error: devCommandsQuery.error,
                    selectedProjectRoot,
                    onRefresh: () => void devCommandsQuery.refetch(),
                    sessionStateByCommandId: devSessionStateByCommandId,
                    activeCommandId: devActiveCommandId,
                    actionError: devActionError,
                    actionPending: devActionPending,
                    onStart: (command) => void handleDevStart(command),
                    onStop: (command) => void handleDevStop(command),
                    onCopyLaunchCommand: (command) => void handleDevCopyLaunchCommand(command),
                    onOpenPreview: handleDevOpenPreview,
                  }}
                />
              ) : null}
              {activeTab === "system" ? (
                <SystemPanel
                  usage={{
                    usage: usageQuery.data,
                    loading: usageQuery.isPending || usageQuery.isFetching,
                    error: usageQuery.error,
                    onRefresh: () => void usageQuery.refetch(),
                  }}
                  skills={{
                    snapshot: skillsQuery.data,
                    loading: skillsQuery.isPending || skillsQuery.isFetching,
                    error: skillsQuery.error,
                    reviews: skillReviews,
                    onRefresh: () => void skillsQuery.refetch(),
                    onRatingChange: (skillId, rating) =>
                      updateSkillReview(skillId, (current) => ({ ...current, rating })),
                    onReviewChange: (skillId, review) =>
                      updateSkillReview(skillId, (current) => ({ ...current, review })),
                  }}
                  mcp={{
                    snapshot: mcpQuery.data,
                    loading: mcpQuery.isPending || mcpQuery.isFetching,
                    error: mcpQuery.error,
                    overrides: mcpOverrides,
                    authAvailability:
                      mcpAuthCapabilityQuery.data ??
                      (mcpAuthCapabilityQuery.error
                        ? {
                            available: false,
                            message: "Browser callback relay is unavailable on this host.",
                          }
                        : undefined),
                    authPending: mcpAuthStartMutation.isPending || mcpAuthCancelMutation.isPending,
                    authStatus: mcpAuthStatusQuery.data ?? null,
                    authError:
                      mcpAuthError ??
                      (mcpAuthStatusQuery.error instanceof Error
                        ? mcpAuthStatusQuery.error.message
                        : null),
                    onRefresh: () => void mcpQuery.refetch(),
                    onToggleServer: toggleMcpServer,
                    onAuthenticate: (server) => mcpAuthStartMutation.mutate(server),
                    onCancelAuthentication: () => mcpAuthCancelMutation.mutate(),
                  }}
                  gsd={{
                    status: openGsdQuery.data,
                    loading: openGsdQuery.isPending || openGsdQuery.isFetching,
                    error: openGsdQuery.error,
                    projects: query.data.projects,
                    selectedProjectRoot,
                    initInput: gsdInitInput,
                    autoInitInput: gsdAutoInitInput,
                    model: gsdModel,
                    maxBudget: gsdMaxBudget,
                    commandResult: openGsdCommandResult,
                    actionError: openGsdActionError,
                    actionPending: openGsdActionPending,
                    onRefresh: () => void openGsdQuery.refetch(),
                    onProjectRootChange: setSelectedProjectRoot,
                    onInitInputChange: setGsdInitInput,
                    onAutoInitInputChange: setGsdAutoInitInput,
                    onModelChange: setGsdModel,
                    onMaxBudgetChange: setGsdMaxBudget,
                    onInit: () => void gsdInitMutation.mutate(),
                    onAuto: () => {
                      if (!selectedProjectRoot) {
                        return;
                      }
                      if (window.confirm(`Run gsd-sdk auto in ${selectedProjectRoot}?`)) {
                        void gsdAutoMutation.mutate();
                      }
                    },
                  }}
                  projects={{ snapshot: query.data }}
                />
              ) : null}
            </div>
          </>
        ) : null}
      </ScrollArea>
    </SidebarInset>
  );
}
