import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";

import { ExternalLauncherError, LaunchEditorInput, OpenInTerminalInput } from "./editor.ts";
import { AuthAccessDeniedError, AuthAccessStreamEvent } from "./auth.ts";
import {
  BrowserPreviewControlInput,
  BrowserPreviewError,
  BrowserPreviewStatus,
  BrowserPreviewThreadInput,
} from "./browser-preview.ts";
import {
  FilesystemBrowseInput,
  FilesystemBrowseResult,
  FilesystemBrowseError,
} from "./filesystem.ts";
import {
  AutomodeDispatchResult,
  AutomodeEnqueueGoalInput,
  AutomodeEpisode,
  AutomodeEpisodesListInput,
  AutomodeGoal,
  AutomodeGoalInput,
  AutomodePolicyUpdateInput,
  AutomodeRejectGoalInput,
  AutomodeSnapshot,
  AutomodeSnapshotInput,
  AutomodeStopAllResult,
  AutomodeSupervisorError,
  DelamainAdapterError,
  DelamainInboxResult,
  DelamainPeer,
  DelamainPeerIntegrateInput,
  DelamainPeerIntegrateResult,
  DelamainPeerKillInput,
  DelamainPeerListInput,
  DelamainPeerListResult,
  DelamainPeerLogInput,
  DelamainPeerLogResult,
  DelamainPeerLogParsedResult,
  DelamainPeerReplyInput,
  DelamainReadInboxInput,
  DelamainSendMessageInput,
  DelamainSendMessageResult,
  DelamainSpawnPeerInput,
  DelamainPeerStatusInput,
  DelamainPeerWaitInput,
  DelamainWorkflowStatusInput,
  DelamainWorkflowStatus,
  DelamainWorkflowKillInput,
  DelamainWorkflowKillResult,
  DelamainWorkflowRunInput,
  DelamainWorkflowRunResult,
  GitsCapacityError,
  GitsCapacitySnapshot,
  GitsCapacitySnapshotInput,
  GitsCockpitError,
  GitsCockpitInput,
  GitsCockpitSnapshot,
  GitsDevCommandError,
  GitsDevCommandInitInput,
  GitsDevCommandListInput,
  GitsDevCommandListResult,
  GitsNote,
  GitsNoteIdInput,
  GitsNoteSummary,
  GitsNoteWriteInput,
  GitsNotesError,
  GitsNotesListInput,
  GitsNotesSyncResult,
  GitsSchedulerDisarmInput,
  GitsSchedulerSetConfigInput,
  GitsSchedulerSnapshot,
  GitsSlotSchedulerError,
  HermesAdapterError,
  HermesChatInput,
  HermesChatResult,
  HermesCheckInput,
  HermesCommandResult,
  HermesConfigInput,
  HermesDraftFromProposalInput,
  HermesExecutionDraft,
  HermesInspectGitsProposalInput,
  HermesLogTailInput,
  HermesLogTailResult,
  HermesProjectContextInput,
  HermesProjectContextResult,
  HermesProposalCard,
  HermesProposalDecisionInput,
  HermesProposalListInput,
  HermesProposalListResult,
  HermesSafeConfig,
  HermesScheduleRunInput,
  HermesScheduleRunResult,
  HermesSessionListInput,
  HermesSessionListResult,
  HermesSetupCodexOAuthInput,
  HermesStartAcpSessionInput,
  HermesStatusInput,
  HermesStatusResult,
  OpenGsdAdapterError,
  OpenGsdCommandResult,
  OpenGsdInitProjectInput,
  OpenGsdRunAutoInput,
  OpenGsdStatusInput,
  OpenGsdStatusResult,
} from "./gits.ts";
import {
  GitActionProgressEvent,
  VcsSwitchRefInput,
  VcsSwitchRefResult,
  GitCommandError,
  VcsCreateRefInput,
  VcsCreateRefResult,
  VcsCreateWorktreeInput,
  VcsCreateWorktreeResult,
  VcsInitInput,
  VcsListRefsInput,
  VcsListRefsResult,
  GitManagerServiceError,
  GitPreparePullRequestThreadInput,
  GitPreparePullRequestThreadResult,
  VcsPullInput,
  GitPullRequestRefInput,
  VcsPullResult,
  VcsRemoveWorktreeInput,
  GitResolvePullRequestResult,
  GitRunStackedActionInput,
  VcsStatusInput,
  VcsStatusResult,
  VcsStatusStreamEvent,
} from "./git.ts";
import {
  CritEnsureSidecarRequest,
  CritError,
  CritReleaseSidecarResponse,
  CritSidecarStatusRequest,
  CritSidecarStatusResponse,
} from "./crit.ts";
import {
  ReviewDiffPreviewError,
  ReviewDiffPreviewInput,
  ReviewDiffPreviewResult,
} from "./review.ts";
import { KeybindingsConfigError } from "./keybindings.ts";
import {
  ClientOrchestrationCommand,
  ORCHESTRATION_WS_METHODS,
  OrchestrationDispatchCommandError,
  OrchestrationGetFullThreadDiffError,
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetSnapshotError,
  OrchestrationGetTurnDiffError,
  OrchestrationGetTurnDiffInput,
  OrchestrationReplayEventsError,
  OrchestrationReplayEventsInput,
  OrchestrationRpcSchemas,
  VisualPlanMutateError,
  VisualPlanMutateInput,
  VisualPlanMutateResult,
} from "./orchestration.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import {
  ProviderAuthError,
  ProviderAuthLogoutInput,
  ProviderAuthSession,
  ProviderAuthSessionInput,
  ProviderAuthStartInput,
  ProviderAuthStartResult,
  ProviderAuthSubmitCodeInput,
} from "./providerAuth.ts";
import {
  FollowUpSuggestionsInput,
  FollowUpSuggestionsResult,
  ProviderOperationError,
  ProviderSteerTurnInput,
} from "./provider.ts";
import {
  ProjectSearchEntriesError,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
  ProjectWriteFileError,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "./project.ts";
import {
  TerminalAttachInput,
  TerminalAttachStreamEvent,
  TerminalClearInput,
  TerminalCloseInput,
  TerminalError,
  TerminalEvent,
  TerminalMetadataStreamEvent,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalRestartInput,
  TerminalSessionSnapshot,
  TerminalWriteInput,
} from "./terminal.ts";
import {
  ServerConfigStreamEvent,
  ServerConfig,
  ServerProviderUpdateError,
  ServerProviderUpdateInput,
  ServerLifecycleStreamEvent,
  ServerRemoveKeybindingInput,
  ServerRemoveKeybindingResult,
  ServerProviderUpdatedPayload,
  ServerTraceDiagnosticsResult,
  ServerProcessDiagnosticsResult,
  ServerProcessResourceHistoryInput,
  ServerProcessResourceHistoryResult,
  ServerSignalProcessInput,
  ServerSignalProcessResult,
  ServerUpsertKeybindingInput,
  ServerUpsertKeybindingResult,
} from "./server.ts";
import { ServerSettings, ServerSettingsError, ServerSettingsPatch } from "./settings.ts";
import {
  SourceControlCloneRepositoryInput,
  SourceControlCloneRepositoryResult,
  SourceControlDiscoveryResult,
  SourceControlListOwnedRepositoriesInput,
  SourceControlListOwnedRepositoriesResult,
  SourceControlPublishRepositoryInput,
  SourceControlPublishRepositoryResult,
  SourceControlRepositoryError,
  SourceControlRepositoryInfo,
  SourceControlRepositoryLookupInput,
} from "./sourceControl.ts";
import { VcsError } from "./vcs.ts";
import { GitsPortsError, PortsListInput, PortsListResult } from "./ports.ts";
import {
  CodexAccountUsage,
  CodexAccountUsageInput,
  CodexResetCreditConsumeInput,
  CodexResetCreditConsumeResult,
  UsageModelBreakdown,
  UsageModelBreakdownInput,
} from "./usage.ts";

export const WS_METHODS = {
  // Project registry methods
  projectsList: "projects.list",
  projectsAdd: "projects.add",
  projectsRemove: "projects.remove",
  projectsSearchEntries: "projects.searchEntries",
  projectsWriteFile: "projects.writeFile",

  // Shell methods
  shellOpenInEditor: "shell.openInEditor",
  shellOpenInTerminal: "shell.openInTerminal",

  // Filesystem methods
  filesystemBrowse: "filesystem.browse",

  // VCS methods
  vcsPull: "vcs.pull",
  vcsRefreshStatus: "vcs.refreshStatus",
  vcsListRefs: "vcs.listRefs",
  vcsCreateWorktree: "vcs.createWorktree",
  vcsRemoveWorktree: "vcs.removeWorktree",
  vcsCreateRef: "vcs.createRef",
  vcsSwitchRef: "vcs.switchRef",
  vcsInit: "vcs.init",

  // Git workflow methods
  gitRunStackedAction: "git.runStackedAction",
  gitResolvePullRequest: "git.resolvePullRequest",
  gitPreparePullRequestThread: "git.preparePullRequestThread",

  // Review methods
  reviewGetDiffPreview: "review.getDiffPreview",

  // Crit PR review sidecar methods
  critEnsureSidecar: "crit.ensureSidecar",
  critSidecarStatus: "crit.sidecarStatus",
  critReleaseSidecar: "crit.releaseSidecar",

  // Thread-scoped browser supervision methods
  browserPreviewOpen: "browserPreview.open",
  browserPreviewStatus: "browserPreview.status",
  browserPreviewControl: "browserPreview.control",

  // GITS cockpit methods
  gitsGetCockpit: "gits.cockpit.get",
  gitsDevCommandsList: "gits.devCommands.list",
  gitsDevCommandsInit: "gits.devCommands.init",
  gitsPortsList: "gits.ports.list",
  gitsNotesList: "gits.notes.list",
  gitsNotesRead: "gits.notes.read",
  gitsNotesCreate: "gits.notes.create",
  gitsNotesUpdate: "gits.notes.update",
  gitsNotesRemove: "gits.notes.remove",
  gitsNotesSync: "gits.notes.sync",
  gitsVisualPlanMutate: "gits.visualPlan.mutate",
  gitsDelamainListPeers: "gits.delamain.peers.list",
  gitsDelamainGetPeerStatus: "gits.delamain.peers.status",
  gitsDelamainReadPeerLog: "gits.delamain.peers.log",
  gitsDelamainReadPeerLogParsed: "gits.delamain.peers.logParsed",
  gitsDelamainSpawnPeer: "gits.delamain.peers.spawn",
  gitsDelamainKillPeer: "gits.delamain.peers.kill",
  gitsDelamainSendPeerReply: "gits.delamain.peers.reply",
  gitsDelamainWaitForPeer: "gits.delamain.peers.wait",
  gitsDelamainIntegratePeer: "gits.delamain.peers.integrate",
  gitsDelamainWorkflowStatus: "gits.delamain.workflow.status",
  gitsDelamainWorkflowKill: "gits.delamain.workflow.kill",
  gitsDelamainRunWorkflow: "gits.delamain.workflow.run",
  gitsDelamainReadInbox: "gits.delamain.messages.inbox",
  gitsDelamainSendMessage: "gits.delamain.messages.send",
  gitsOpenGsdGetStatus: "gits.openGsd.status",
  gitsOpenGsdInitProject: "gits.openGsd.init",
  gitsOpenGsdRunAuto: "gits.openGsd.auto",
  gitsAutomodeGetSnapshot: "gits.automode.snapshot",
  gitsAutomodeUpdatePolicy: "gits.automode.policy.update",
  gitsAutomodeEnqueueGoal: "gits.automode.goals.enqueue",
  gitsAutomodeApproveGoal: "gits.automode.goals.approve",
  gitsAutomodeRejectGoal: "gits.automode.goals.reject",
  gitsAutomodeDispatchGoal: "gits.automode.goals.dispatch",
  gitsAutomodeSchedulerSnapshot: "gits.automode.scheduler.snapshot",
  gitsAutomodeSchedulerSetConfig: "gits.automode.scheduler.setConfig",
  gitsAutomodeSchedulerArm: "gits.automode.scheduler.arm",
  gitsAutomodeSchedulerDisarm: "gits.automode.scheduler.disarm",
  gitsAutomodeDriverResume: "gits.automode.driver.resume",
  gitsAutomodeEpisodesList: "gits.automode.episodes.list",
  gitsAutomodeStopAll: "gits.automode.stopAll",
  gitsAutomodeGoalsKill: "gits.automode.goals.kill",
  gitsCapacityGetSnapshot: "gits.capacity.snapshot",
  gitsHermesGetStatus: "gits.hermes.status",
  gitsHermesGetConfig: "gits.hermes.config",
  gitsHermesCheck: "gits.hermes.check",
  gitsHermesSetupCodexOAuth: "gits.hermes.setupCodexOAuth",
  gitsHermesStartAcpSession: "gits.hermes.acp.start",
  gitsHermesListSessions: "gits.hermes.sessions.list",
  gitsHermesTailLog: "gits.hermes.logs.tail",
  gitsHermesListProposals: "gits.hermes.proposals.list",
  gitsHermesInspectGits: "gits.hermes.proposals.inspectGits",
  gitsHermesChat: "gits.hermes.chat",
  gitsHermesDecideProposal: "gits.hermes.proposals.decide",
  gitsHermesWriteProjectContext: "gits.hermes.context.write",
  gitsHermesDraftFromProposal: "gits.hermes.proposals.draft",
  gitsHermesRunSchedule: "gits.hermes.schedules.run",

  // Terminal methods
  terminalOpen: "terminal.open",
  terminalAttach: "terminal.attach",
  terminalWrite: "terminal.write",
  terminalResize: "terminal.resize",
  terminalClear: "terminal.clear",
  terminalRestart: "terminal.restart",
  terminalClose: "terminal.close",

  // Server meta
  serverGetConfig: "server.getConfig",
  serverRefreshProviders: "server.refreshProviders",
  serverUpdateProvider: "server.updateProvider",
  serverUpsertKeybinding: "server.upsertKeybinding",
  serverRemoveKeybinding: "server.removeKeybinding",
  serverGetSettings: "server.getSettings",
  serverUpdateSettings: "server.updateSettings",
  serverDiscoverSourceControl: "server.discoverSourceControl",
  serverGetTraceDiagnostics: "server.getTraceDiagnostics",
  serverGetProcessDiagnostics: "server.getProcessDiagnostics",
  serverGetProcessResourceHistory: "server.getProcessResourceHistory",
  serverSignalProcess: "server.signalProcess",
  providerSteerTurn: "provider.steerTurn",
  providerGenerateFollowUpSuggestions: "provider.generateFollowUpSuggestions",
  providerCodexAccountUsage: "provider.codexAccountUsage",
  providerConsumeCodexResetCredit: "provider.consumeCodexResetCredit",
  usageModelBreakdown: "usage.modelBreakdown",
  providerAuthStart: "provider.auth.start",
  providerAuthGet: "provider.auth.get",
  providerAuthCancel: "provider.auth.cancel",
  providerAuthSubmitCode: "provider.auth.submitCode",
  providerAuthLogout: "provider.auth.logout",

  // Source control methods
  sourceControlLookupRepository: "sourceControl.lookupRepository",
  sourceControlListOwnedRepositories: "sourceControl.listOwnedRepositories",
  sourceControlCloneRepository: "sourceControl.cloneRepository",
  sourceControlPublishRepository: "sourceControl.publishRepository",

  // Audio methods
  audioTranscribe: "audio.transcribe",

  // Streaming subscriptions
  subscribeVcsStatus: "subscribeVcsStatus",
  subscribeTerminalEvents: "subscribeTerminalEvents",
  subscribeTerminalMetadata: "subscribeTerminalMetadata",
  subscribeServerConfig: "subscribeServerConfig",
  subscribeServerLifecycle: "subscribeServerLifecycle",
  subscribeAuthAccess: "subscribeAuthAccess",
} as const;

export const WsServerUpsertKeybindingRpc = Rpc.make(WS_METHODS.serverUpsertKeybinding, {
  payload: ServerUpsertKeybindingInput,
  success: ServerUpsertKeybindingResult,
  error: KeybindingsConfigError,
});

export const WsServerRemoveKeybindingRpc = Rpc.make(WS_METHODS.serverRemoveKeybinding, {
  payload: ServerRemoveKeybindingInput,
  success: ServerRemoveKeybindingResult,
  error: KeybindingsConfigError,
});

export const WsServerGetConfigRpc = Rpc.make(WS_METHODS.serverGetConfig, {
  payload: Schema.Struct({}),
  success: ServerConfig,
  error: Schema.Union([KeybindingsConfigError, ServerSettingsError]),
});

export const WsServerRefreshProvidersRpc = Rpc.make(WS_METHODS.serverRefreshProviders, {
  payload: Schema.Struct({
    /**
     * When supplied, only refresh this specific provider instance. When
     * omitted, refresh all configured instances — the legacy `refresh()`
     * behaviour retained for transports that still dispatch untargeted
     * refreshes.
     */
    instanceId: Schema.optional(ProviderInstanceId),
  }),
  success: ServerProviderUpdatedPayload,
});

export const WsServerUpdateProviderRpc = Rpc.make(WS_METHODS.serverUpdateProvider, {
  payload: ServerProviderUpdateInput,
  success: ServerProviderUpdatedPayload,
  error: ServerProviderUpdateError,
});

export const WsProviderSteerTurnRpc = Rpc.make(WS_METHODS.providerSteerTurn, {
  payload: ProviderSteerTurnInput,
  success: Schema.Void,
  error: ProviderOperationError,
});

export const WsProviderGenerateFollowUpSuggestionsRpc = Rpc.make(
  WS_METHODS.providerGenerateFollowUpSuggestions,
  {
    payload: FollowUpSuggestionsInput,
    success: FollowUpSuggestionsResult,
    error: ProviderOperationError,
  },
);

export const WsProviderCodexAccountUsageRpc = Rpc.make(WS_METHODS.providerCodexAccountUsage, {
  payload: CodexAccountUsageInput,
  success: CodexAccountUsage,
  error: ProviderOperationError,
});

export const WsProviderConsumeCodexResetCreditRpc = Rpc.make(
  WS_METHODS.providerConsumeCodexResetCredit,
  {
    payload: CodexResetCreditConsumeInput,
    success: CodexResetCreditConsumeResult,
    error: ProviderOperationError,
  },
);

export const WsUsageModelBreakdownRpc = Rpc.make(WS_METHODS.usageModelBreakdown, {
  payload: UsageModelBreakdownInput,
  success: UsageModelBreakdown,
  error: ProviderOperationError,
});

export const WsProviderAuthStartRpc = Rpc.make(WS_METHODS.providerAuthStart, {
  payload: ProviderAuthStartInput,
  success: ProviderAuthStartResult,
  error: ProviderAuthError,
});

export const WsProviderAuthGetRpc = Rpc.make(WS_METHODS.providerAuthGet, {
  payload: ProviderAuthSessionInput,
  success: ProviderAuthSession,
  error: ProviderAuthError,
});

export const WsProviderAuthCancelRpc = Rpc.make(WS_METHODS.providerAuthCancel, {
  payload: ProviderAuthSessionInput,
  success: Schema.Void,
  error: ProviderAuthError,
});

export const WsProviderAuthSubmitCodeRpc = Rpc.make(WS_METHODS.providerAuthSubmitCode, {
  payload: ProviderAuthSubmitCodeInput,
  success: ProviderAuthSession,
  error: ProviderAuthError,
});

export const WsProviderAuthLogoutRpc = Rpc.make(WS_METHODS.providerAuthLogout, {
  payload: ProviderAuthLogoutInput,
  success: Schema.Void,
  error: ProviderAuthError,
});

export const WsServerGetSettingsRpc = Rpc.make(WS_METHODS.serverGetSettings, {
  payload: Schema.Struct({}),
  success: ServerSettings,
  error: ServerSettingsError,
});

export const WsServerUpdateSettingsRpc = Rpc.make(WS_METHODS.serverUpdateSettings, {
  payload: Schema.Struct({ patch: ServerSettingsPatch }),
  success: ServerSettings,
  error: ServerSettingsError,
});

export const WsServerDiscoverSourceControlRpc = Rpc.make(WS_METHODS.serverDiscoverSourceControl, {
  payload: Schema.Struct({}),
  success: SourceControlDiscoveryResult,
});

export const WsServerGetTraceDiagnosticsRpc = Rpc.make(WS_METHODS.serverGetTraceDiagnostics, {
  payload: Schema.Struct({}),
  success: ServerTraceDiagnosticsResult,
});

export const WsServerGetProcessDiagnosticsRpc = Rpc.make(WS_METHODS.serverGetProcessDiagnostics, {
  payload: Schema.Struct({}),
  success: ServerProcessDiagnosticsResult,
});

export const WsServerGetProcessResourceHistoryRpc = Rpc.make(
  WS_METHODS.serverGetProcessResourceHistory,
  {
    payload: ServerProcessResourceHistoryInput,
    success: ServerProcessResourceHistoryResult,
  },
);

export const WsServerSignalProcessRpc = Rpc.make(WS_METHODS.serverSignalProcess, {
  payload: ServerSignalProcessInput,
  success: ServerSignalProcessResult,
});

export const WsSourceControlLookupRepositoryRpc = Rpc.make(
  WS_METHODS.sourceControlLookupRepository,
  {
    payload: SourceControlRepositoryLookupInput,
    success: SourceControlRepositoryInfo,
    error: SourceControlRepositoryError,
  },
);

export const WsSourceControlListOwnedRepositoriesRpc = Rpc.make(
  WS_METHODS.sourceControlListOwnedRepositories,
  {
    payload: SourceControlListOwnedRepositoriesInput,
    success: SourceControlListOwnedRepositoriesResult,
    error: SourceControlRepositoryError,
  },
);

export const WsSourceControlCloneRepositoryRpc = Rpc.make(WS_METHODS.sourceControlCloneRepository, {
  payload: SourceControlCloneRepositoryInput,
  success: SourceControlCloneRepositoryResult,
  error: SourceControlRepositoryError,
});

export const WsSourceControlPublishRepositoryRpc = Rpc.make(
  WS_METHODS.sourceControlPublishRepository,
  {
    payload: SourceControlPublishRepositoryInput,
    success: SourceControlPublishRepositoryResult,
    error: SourceControlRepositoryError,
  },
);

export const VoiceTranscriptionErrorReason = Schema.Literals([
  "missing_api_key",
  "empty_audio",
  "provider_error",
  "network_error",
]);
export type VoiceTranscriptionErrorReason = typeof VoiceTranscriptionErrorReason.Type;

export class VoiceTranscriptionError extends Schema.TaggedErrorClass<VoiceTranscriptionError>()(
  "VoiceTranscriptionError",
  {
    reason: VoiceTranscriptionErrorReason,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Voice transcription failed (${this.reason}): ${this.detail}`;
  }
}

export const AudioTranscribeInput = Schema.Struct({
  audioBase64: Schema.String,
  mimeType: Schema.String,
  fileName: Schema.String,
  durationMs: Schema.optional(Schema.Number),
});
export type AudioTranscribeInput = typeof AudioTranscribeInput.Type;

export const AudioTranscribeResult = Schema.Struct({
  text: Schema.String,
});
export type AudioTranscribeResult = typeof AudioTranscribeResult.Type;

export const WsAudioTranscribeRpc = Rpc.make(WS_METHODS.audioTranscribe, {
  payload: AudioTranscribeInput,
  success: AudioTranscribeResult,
  error: VoiceTranscriptionError,
});

export const WsProjectsSearchEntriesRpc = Rpc.make(WS_METHODS.projectsSearchEntries, {
  payload: ProjectSearchEntriesInput,
  success: ProjectSearchEntriesResult,
  error: ProjectSearchEntriesError,
});

export const WsProjectsWriteFileRpc = Rpc.make(WS_METHODS.projectsWriteFile, {
  payload: ProjectWriteFileInput,
  success: ProjectWriteFileResult,
  error: ProjectWriteFileError,
});

export const WsShellOpenInEditorRpc = Rpc.make(WS_METHODS.shellOpenInEditor, {
  payload: LaunchEditorInput,
  error: ExternalLauncherError,
});

export const WsShellOpenInTerminalRpc = Rpc.make(WS_METHODS.shellOpenInTerminal, {
  payload: OpenInTerminalInput,
  error: ExternalLauncherError,
});

export const WsFilesystemBrowseRpc = Rpc.make(WS_METHODS.filesystemBrowse, {
  payload: FilesystemBrowseInput,
  success: FilesystemBrowseResult,
  error: FilesystemBrowseError,
});

export const WsSubscribeVcsStatusRpc = Rpc.make(WS_METHODS.subscribeVcsStatus, {
  payload: VcsStatusInput,
  success: VcsStatusStreamEvent,
  error: GitManagerServiceError,
  stream: true,
});

export const WsVcsPullRpc = Rpc.make(WS_METHODS.vcsPull, {
  payload: VcsPullInput,
  success: VcsPullResult,
  error: GitCommandError,
});

export const WsVcsRefreshStatusRpc = Rpc.make(WS_METHODS.vcsRefreshStatus, {
  payload: VcsStatusInput,
  success: VcsStatusResult,
  error: GitManagerServiceError,
});

export const WsGitRunStackedActionRpc = Rpc.make(WS_METHODS.gitRunStackedAction, {
  payload: GitRunStackedActionInput,
  success: GitActionProgressEvent,
  error: GitManagerServiceError,
  stream: true,
});

export const WsGitResolvePullRequestRpc = Rpc.make(WS_METHODS.gitResolvePullRequest, {
  payload: GitPullRequestRefInput,
  success: GitResolvePullRequestResult,
  error: GitManagerServiceError,
});

export const WsGitPreparePullRequestThreadRpc = Rpc.make(WS_METHODS.gitPreparePullRequestThread, {
  payload: GitPreparePullRequestThreadInput,
  success: GitPreparePullRequestThreadResult,
  error: GitManagerServiceError,
});

export const WsVcsListRefsRpc = Rpc.make(WS_METHODS.vcsListRefs, {
  payload: VcsListRefsInput,
  success: VcsListRefsResult,
  error: GitCommandError,
});

export const WsVcsCreateWorktreeRpc = Rpc.make(WS_METHODS.vcsCreateWorktree, {
  payload: VcsCreateWorktreeInput,
  success: VcsCreateWorktreeResult,
  error: GitCommandError,
});

export const WsVcsRemoveWorktreeRpc = Rpc.make(WS_METHODS.vcsRemoveWorktree, {
  payload: VcsRemoveWorktreeInput,
  error: GitCommandError,
});

export const WsVcsCreateRefRpc = Rpc.make(WS_METHODS.vcsCreateRef, {
  payload: VcsCreateRefInput,
  success: VcsCreateRefResult,
  error: GitCommandError,
});

export const WsVcsSwitchRefRpc = Rpc.make(WS_METHODS.vcsSwitchRef, {
  payload: VcsSwitchRefInput,
  success: VcsSwitchRefResult,
  error: GitCommandError,
});

export const WsVcsInitRpc = Rpc.make(WS_METHODS.vcsInit, {
  payload: VcsInitInput,
  error: VcsError,
});

/**
 * Ephemeral live diff preview for compact/mobile surfaces.
 * Not the persisted T3 Review model. Future review sessions should use
 * review.open* + review.getSnapshot.
 */
export const WsReviewGetDiffPreviewRpc = Rpc.make(WS_METHODS.reviewGetDiffPreview, {
  payload: ReviewDiffPreviewInput,
  success: ReviewDiffPreviewResult,
  error: ReviewDiffPreviewError,
});

export const WsCritEnsureSidecarRpc = Rpc.make(WS_METHODS.critEnsureSidecar, {
  payload: CritEnsureSidecarRequest,
  success: CritSidecarStatusResponse,
  error: CritError,
});

export const WsCritSidecarStatusRpc = Rpc.make(WS_METHODS.critSidecarStatus, {
  payload: CritSidecarStatusRequest,
  success: CritSidecarStatusResponse,
  error: CritError,
});

export const WsCritReleaseSidecarRpc = Rpc.make(WS_METHODS.critReleaseSidecar, {
  payload: CritSidecarStatusRequest,
  success: CritReleaseSidecarResponse,
  error: CritError,
});

export const WsBrowserPreviewOpenRpc = Rpc.make(WS_METHODS.browserPreviewOpen, {
  payload: BrowserPreviewThreadInput,
  success: BrowserPreviewStatus,
  error: BrowserPreviewError,
});

export const WsBrowserPreviewStatusRpc = Rpc.make(WS_METHODS.browserPreviewStatus, {
  payload: BrowserPreviewThreadInput,
  success: BrowserPreviewStatus,
  error: BrowserPreviewError,
});

export const WsBrowserPreviewControlRpc = Rpc.make(WS_METHODS.browserPreviewControl, {
  payload: BrowserPreviewControlInput,
  success: BrowserPreviewStatus,
  error: BrowserPreviewError,
});

export const WsGitsGetCockpitRpc = Rpc.make(WS_METHODS.gitsGetCockpit, {
  payload: GitsCockpitInput,
  success: GitsCockpitSnapshot,
  error: GitsCockpitError,
});

export const WsGitsDevCommandsListRpc = Rpc.make(WS_METHODS.gitsDevCommandsList, {
  payload: GitsDevCommandListInput,
  success: GitsDevCommandListResult,
  error: GitsDevCommandError,
});

export const WsGitsDevCommandsInitRpc = Rpc.make(WS_METHODS.gitsDevCommandsInit, {
  payload: GitsDevCommandInitInput,
  success: GitsDevCommandListResult,
  error: GitsDevCommandError,
});

export const WsGitsPortsListRpc = Rpc.make(WS_METHODS.gitsPortsList, {
  payload: PortsListInput,
  success: PortsListResult,
  error: GitsPortsError,
});

export const WsGitsNotesListRpc = Rpc.make(WS_METHODS.gitsNotesList, {
  payload: GitsNotesListInput,
  success: Schema.Array(GitsNoteSummary),
  error: GitsNotesError,
});

export const WsGitsNotesReadRpc = Rpc.make(WS_METHODS.gitsNotesRead, {
  payload: GitsNoteIdInput,
  success: GitsNote,
  error: GitsNotesError,
});

export const WsGitsNotesCreateRpc = Rpc.make(WS_METHODS.gitsNotesCreate, {
  payload: GitsNoteWriteInput,
  success: GitsNote,
  error: GitsNotesError,
});

export const WsGitsNotesUpdateRpc = Rpc.make(WS_METHODS.gitsNotesUpdate, {
  payload: GitsNoteWriteInput,
  success: GitsNote,
  error: GitsNotesError,
});

export const WsGitsNotesRemoveRpc = Rpc.make(WS_METHODS.gitsNotesRemove, {
  payload: GitsNoteIdInput,
  success: Schema.Void,
  error: GitsNotesError,
});

export const WsGitsNotesSyncRpc = Rpc.make(WS_METHODS.gitsNotesSync, {
  payload: GitsNotesListInput,
  success: GitsNotesSyncResult,
  error: GitsNotesError,
});

export const WsGitsVisualPlanMutateRpc = Rpc.make(WS_METHODS.gitsVisualPlanMutate, {
  payload: VisualPlanMutateInput,
  success: VisualPlanMutateResult,
  error: VisualPlanMutateError,
});

export const WsGitsDelamainListPeersRpc = Rpc.make(WS_METHODS.gitsDelamainListPeers, {
  payload: DelamainPeerListInput,
  success: DelamainPeerListResult,
  error: DelamainAdapterError,
});

export const WsGitsDelamainGetPeerStatusRpc = Rpc.make(WS_METHODS.gitsDelamainGetPeerStatus, {
  payload: DelamainPeerStatusInput,
  success: DelamainPeer,
  error: DelamainAdapterError,
});

export const WsGitsDelamainReadPeerLogRpc = Rpc.make(WS_METHODS.gitsDelamainReadPeerLog, {
  payload: DelamainPeerLogInput,
  success: DelamainPeerLogResult,
  error: DelamainAdapterError,
});

export const WsGitsDelamainReadPeerLogParsedRpc = Rpc.make(
  WS_METHODS.gitsDelamainReadPeerLogParsed,
  {
    payload: DelamainPeerLogInput,
    success: DelamainPeerLogParsedResult,
    error: DelamainAdapterError,
  },
);

export const WsGitsDelamainSpawnPeerRpc = Rpc.make(WS_METHODS.gitsDelamainSpawnPeer, {
  payload: DelamainSpawnPeerInput,
  success: DelamainPeer,
  error: DelamainAdapterError,
});

export const WsGitsDelamainKillPeerRpc = Rpc.make(WS_METHODS.gitsDelamainKillPeer, {
  payload: DelamainPeerKillInput,
  success: DelamainPeer,
  error: DelamainAdapterError,
});

export const WsGitsDelamainSendPeerReplyRpc = Rpc.make(WS_METHODS.gitsDelamainSendPeerReply, {
  payload: DelamainPeerReplyInput,
  success: DelamainPeer,
  error: DelamainAdapterError,
});

export const WsGitsDelamainWaitForPeerRpc = Rpc.make(WS_METHODS.gitsDelamainWaitForPeer, {
  payload: DelamainPeerWaitInput,
  success: DelamainPeer,
  error: DelamainAdapterError,
});

export const WsGitsDelamainIntegratePeerRpc = Rpc.make(WS_METHODS.gitsDelamainIntegratePeer, {
  payload: DelamainPeerIntegrateInput,
  success: DelamainPeerIntegrateResult,
  error: DelamainAdapterError,
});

export const WsGitsDelamainWorkflowStatusRpc = Rpc.make(WS_METHODS.gitsDelamainWorkflowStatus, {
  payload: DelamainWorkflowStatusInput,
  success: DelamainWorkflowStatus,
  error: DelamainAdapterError,
});

export const WsGitsDelamainWorkflowKillRpc = Rpc.make(WS_METHODS.gitsDelamainWorkflowKill, {
  payload: DelamainWorkflowKillInput,
  success: DelamainWorkflowKillResult,
  error: DelamainAdapterError,
});

export const WsGitsDelamainRunWorkflowRpc = Rpc.make(WS_METHODS.gitsDelamainRunWorkflow, {
  payload: DelamainWorkflowRunInput,
  success: DelamainWorkflowRunResult,
  error: DelamainAdapterError,
});

export const WsGitsDelamainReadInboxRpc = Rpc.make(WS_METHODS.gitsDelamainReadInbox, {
  payload: DelamainReadInboxInput,
  success: DelamainInboxResult,
  error: DelamainAdapterError,
});

// Gated send routes through the AutomodeSupervisor (motokoAuthority + policy gate),
// so its error channel is AutomodeSupervisorError, not DelamainAdapterError.
export const WsGitsDelamainSendMessageRpc = Rpc.make(WS_METHODS.gitsDelamainSendMessage, {
  payload: DelamainSendMessageInput,
  success: DelamainSendMessageResult,
  error: AutomodeSupervisorError,
});

export const WsGitsOpenGsdGetStatusRpc = Rpc.make(WS_METHODS.gitsOpenGsdGetStatus, {
  payload: OpenGsdStatusInput,
  success: OpenGsdStatusResult,
  error: OpenGsdAdapterError,
});

export const WsGitsOpenGsdInitProjectRpc = Rpc.make(WS_METHODS.gitsOpenGsdInitProject, {
  payload: OpenGsdInitProjectInput,
  success: OpenGsdCommandResult,
  error: OpenGsdAdapterError,
});

export const WsGitsOpenGsdRunAutoRpc = Rpc.make(WS_METHODS.gitsOpenGsdRunAuto, {
  payload: OpenGsdRunAutoInput,
  success: OpenGsdCommandResult,
  error: OpenGsdAdapterError,
});

export const WsGitsAutomodeGetSnapshotRpc = Rpc.make(WS_METHODS.gitsAutomodeGetSnapshot, {
  payload: AutomodeSnapshotInput,
  success: AutomodeSnapshot,
  error: AutomodeSupervisorError,
});

export const WsGitsAutomodeUpdatePolicyRpc = Rpc.make(WS_METHODS.gitsAutomodeUpdatePolicy, {
  payload: AutomodePolicyUpdateInput,
  success: AutomodeSnapshot,
  error: AutomodeSupervisorError,
});

export const WsGitsAutomodeEnqueueGoalRpc = Rpc.make(WS_METHODS.gitsAutomodeEnqueueGoal, {
  payload: AutomodeEnqueueGoalInput,
  success: AutomodeSnapshot,
  error: AutomodeSupervisorError,
});

export const WsGitsAutomodeApproveGoalRpc = Rpc.make(WS_METHODS.gitsAutomodeApproveGoal, {
  payload: AutomodeGoalInput,
  success: AutomodeGoal,
  error: AutomodeSupervisorError,
});

export const WsGitsAutomodeRejectGoalRpc = Rpc.make(WS_METHODS.gitsAutomodeRejectGoal, {
  payload: AutomodeRejectGoalInput,
  success: AutomodeGoal,
  error: AutomodeSupervisorError,
});

export const WsGitsAutomodeDispatchGoalRpc = Rpc.make(WS_METHODS.gitsAutomodeDispatchGoal, {
  payload: AutomodeGoalInput,
  success: AutomodeDispatchResult,
  error: AutomodeSupervisorError,
});

export const WsGitsAutomodeSchedulerSnapshotRpc = Rpc.make(
  WS_METHODS.gitsAutomodeSchedulerSnapshot,
  {
    payload: Schema.Struct({}),
    success: GitsSchedulerSnapshot,
    error: GitsSlotSchedulerError,
  },
);

export const WsGitsAutomodeSchedulerSetConfigRpc = Rpc.make(
  WS_METHODS.gitsAutomodeSchedulerSetConfig,
  {
    payload: GitsSchedulerSetConfigInput,
    success: GitsSchedulerSnapshot,
    error: GitsSlotSchedulerError,
  },
);

export const WsGitsAutomodeSchedulerArmRpc = Rpc.make(WS_METHODS.gitsAutomodeSchedulerArm, {
  payload: Schema.Struct({}),
  success: GitsSchedulerSnapshot,
  error: GitsSlotSchedulerError,
});

export const WsGitsAutomodeSchedulerDisarmRpc = Rpc.make(WS_METHODS.gitsAutomodeSchedulerDisarm, {
  payload: GitsSchedulerDisarmInput,
  success: GitsSchedulerSnapshot,
  error: GitsSlotSchedulerError,
});

// Wires the EXISTING supervisor.resumeDriver — the halted-banner Resume button.
export const WsGitsAutomodeDriverResumeRpc = Rpc.make(WS_METHODS.gitsAutomodeDriverResume, {
  payload: Schema.Struct({}),
  success: AutomodeSnapshot,
  error: AutomodeSupervisorError,
});

export const WsGitsAutomodeEpisodesListRpc = Rpc.make(WS_METHODS.gitsAutomodeEpisodesList, {
  payload: AutomodeEpisodesListInput,
  success: Schema.Array(AutomodeEpisode),
  error: AutomodeSupervisorError,
});

// Wired to automodeSupervisor.stopAll() in ws.ts. Mirrors the counters the Telegram STOP
// command already computes (HermesTelegramCommand.ts `case "stop"`).
export const WsGitsAutomodeStopAllRpc = Rpc.make(WS_METHODS.gitsAutomodeStopAll, {
  payload: Schema.Struct({}),
  success: AutomodeStopAllResult,
  error: AutomodeSupervisorError,
});

// Wired to automodeSupervisor.killGoal(input) in ws.ts. Payload/success shape mirrors
// the other single-goal siblings (approveGoal/rejectGoal: {goalId} -> AutomodeGoal).
export const WsGitsAutomodeGoalsKillRpc = Rpc.make(WS_METHODS.gitsAutomodeGoalsKill, {
  payload: AutomodeGoalInput,
  success: AutomodeGoal,
  error: AutomodeSupervisorError,
});

export const WsGitsCapacityGetSnapshotRpc = Rpc.make(WS_METHODS.gitsCapacityGetSnapshot, {
  payload: GitsCapacitySnapshotInput,
  success: GitsCapacitySnapshot,
  error: GitsCapacityError,
});

export const WsGitsHermesGetStatusRpc = Rpc.make(WS_METHODS.gitsHermesGetStatus, {
  payload: HermesStatusInput,
  success: HermesStatusResult,
  error: HermesAdapterError,
});

export const WsGitsHermesGetConfigRpc = Rpc.make(WS_METHODS.gitsHermesGetConfig, {
  payload: HermesConfigInput,
  success: HermesSafeConfig,
  error: HermesAdapterError,
});

export const WsGitsHermesCheckRpc = Rpc.make(WS_METHODS.gitsHermesCheck, {
  payload: HermesCheckInput,
  success: HermesCommandResult,
  error: HermesAdapterError,
});

export const WsGitsHermesSetupCodexOAuthRpc = Rpc.make(WS_METHODS.gitsHermesSetupCodexOAuth, {
  payload: HermesSetupCodexOAuthInput,
  success: HermesCommandResult,
  error: HermesAdapterError,
});

export const WsGitsHermesStartAcpSessionRpc = Rpc.make(WS_METHODS.gitsHermesStartAcpSession, {
  payload: HermesStartAcpSessionInput,
  success: HermesCommandResult,
  error: HermesAdapterError,
});

export const WsGitsHermesListSessionsRpc = Rpc.make(WS_METHODS.gitsHermesListSessions, {
  payload: HermesSessionListInput,
  success: HermesSessionListResult,
  error: HermesAdapterError,
});

export const WsGitsHermesTailLogRpc = Rpc.make(WS_METHODS.gitsHermesTailLog, {
  payload: HermesLogTailInput,
  success: HermesLogTailResult,
  error: HermesAdapterError,
});

export const WsGitsHermesListProposalsRpc = Rpc.make(WS_METHODS.gitsHermesListProposals, {
  payload: HermesProposalListInput,
  success: HermesProposalListResult,
  error: HermesAdapterError,
});

export const WsGitsHermesInspectGitsRpc = Rpc.make(WS_METHODS.gitsHermesInspectGits, {
  payload: HermesInspectGitsProposalInput,
  success: HermesProposalCard,
  error: HermesAdapterError,
});

export const WsGitsHermesChatRpc = Rpc.make(WS_METHODS.gitsHermesChat, {
  payload: HermesChatInput,
  success: HermesChatResult,
  error: HermesAdapterError,
});

export const WsGitsHermesDecideProposalRpc = Rpc.make(WS_METHODS.gitsHermesDecideProposal, {
  payload: HermesProposalDecisionInput,
  success: HermesProposalCard,
  error: HermesAdapterError,
});

export const WsGitsHermesWriteProjectContextRpc = Rpc.make(
  WS_METHODS.gitsHermesWriteProjectContext,
  {
    payload: HermesProjectContextInput,
    success: HermesProjectContextResult,
    error: HermesAdapterError,
  },
);

export const WsGitsHermesDraftFromProposalRpc = Rpc.make(WS_METHODS.gitsHermesDraftFromProposal, {
  payload: HermesDraftFromProposalInput,
  success: HermesExecutionDraft,
  error: HermesAdapterError,
});

export const WsGitsHermesRunScheduleRpc = Rpc.make(WS_METHODS.gitsHermesRunSchedule, {
  payload: HermesScheduleRunInput,
  success: HermesScheduleRunResult,
  error: HermesAdapterError,
});

export const WsTerminalOpenRpc = Rpc.make(WS_METHODS.terminalOpen, {
  payload: TerminalOpenInput,
  success: TerminalSessionSnapshot,
  error: TerminalError,
});

export const WsTerminalAttachRpc = Rpc.make(WS_METHODS.terminalAttach, {
  payload: TerminalAttachInput,
  success: TerminalAttachStreamEvent,
  error: TerminalError,
  stream: true,
});

export const WsTerminalWriteRpc = Rpc.make(WS_METHODS.terminalWrite, {
  payload: TerminalWriteInput,
  error: TerminalError,
});

export const WsTerminalResizeRpc = Rpc.make(WS_METHODS.terminalResize, {
  payload: TerminalResizeInput,
  error: TerminalError,
});

export const WsTerminalClearRpc = Rpc.make(WS_METHODS.terminalClear, {
  payload: TerminalClearInput,
  error: TerminalError,
});

export const WsTerminalRestartRpc = Rpc.make(WS_METHODS.terminalRestart, {
  payload: TerminalRestartInput,
  success: TerminalSessionSnapshot,
  error: TerminalError,
});

export const WsTerminalCloseRpc = Rpc.make(WS_METHODS.terminalClose, {
  payload: TerminalCloseInput,
  error: TerminalError,
});

export const WsOrchestrationDispatchCommandRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.dispatchCommand,
  {
    payload: ClientOrchestrationCommand,
    success: OrchestrationRpcSchemas.dispatchCommand.output,
    error: OrchestrationDispatchCommandError,
  },
);

export const WsOrchestrationGetTurnDiffRpc = Rpc.make(ORCHESTRATION_WS_METHODS.getTurnDiff, {
  payload: OrchestrationGetTurnDiffInput,
  success: OrchestrationRpcSchemas.getTurnDiff.output,
  error: OrchestrationGetTurnDiffError,
});

export const WsOrchestrationGetFullThreadDiffRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.getFullThreadDiff,
  {
    payload: OrchestrationGetFullThreadDiffInput,
    success: OrchestrationRpcSchemas.getFullThreadDiff.output,
    error: OrchestrationGetFullThreadDiffError,
  },
);

export const WsOrchestrationReplayEventsRpc = Rpc.make(ORCHESTRATION_WS_METHODS.replayEvents, {
  payload: OrchestrationReplayEventsInput,
  success: OrchestrationRpcSchemas.replayEvents.output,
  error: OrchestrationReplayEventsError,
});

export const WsOrchestrationGetArchivedShellSnapshotRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot,
  {
    payload: OrchestrationRpcSchemas.getArchivedShellSnapshot.input,
    success: OrchestrationRpcSchemas.getArchivedShellSnapshot.output,
    error: OrchestrationGetSnapshotError,
  },
);

export const WsOrchestrationSubscribeShellRpc = Rpc.make(ORCHESTRATION_WS_METHODS.subscribeShell, {
  payload: OrchestrationRpcSchemas.subscribeShell.input,
  success: OrchestrationRpcSchemas.subscribeShell.output,
  error: OrchestrationGetSnapshotError,
  stream: true,
});

export const WsOrchestrationSubscribeThreadRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.subscribeThread,
  {
    payload: OrchestrationRpcSchemas.subscribeThread.input,
    success: OrchestrationRpcSchemas.subscribeThread.output,
    error: OrchestrationGetSnapshotError,
    stream: true,
  },
);

export const WsSubscribeTerminalEventsRpc = Rpc.make(WS_METHODS.subscribeTerminalEvents, {
  payload: Schema.Struct({}),
  success: TerminalEvent,
  stream: true,
});

export const WsSubscribeTerminalMetadataRpc = Rpc.make(WS_METHODS.subscribeTerminalMetadata, {
  payload: Schema.Struct({}),
  success: TerminalMetadataStreamEvent,
  stream: true,
});

export const WsSubscribeServerConfigRpc = Rpc.make(WS_METHODS.subscribeServerConfig, {
  payload: Schema.Struct({}),
  success: ServerConfigStreamEvent,
  error: Schema.Union([KeybindingsConfigError, ServerSettingsError]),
  stream: true,
});

export const WsSubscribeServerLifecycleRpc = Rpc.make(WS_METHODS.subscribeServerLifecycle, {
  payload: Schema.Struct({}),
  success: ServerLifecycleStreamEvent,
  stream: true,
});

export const WsSubscribeAuthAccessRpc = Rpc.make(WS_METHODS.subscribeAuthAccess, {
  payload: Schema.Struct({}),
  success: AuthAccessStreamEvent,
  error: AuthAccessDeniedError,
  stream: true,
});

export const WsRpcGroup = RpcGroup.make(
  WsServerGetConfigRpc,
  WsServerRefreshProvidersRpc,
  WsServerUpdateProviderRpc,
  WsProviderSteerTurnRpc,
  WsProviderGenerateFollowUpSuggestionsRpc,
  WsProviderCodexAccountUsageRpc,
  WsProviderConsumeCodexResetCreditRpc,
  WsUsageModelBreakdownRpc,
  WsProviderAuthStartRpc,
  WsProviderAuthGetRpc,
  WsProviderAuthCancelRpc,
  WsProviderAuthSubmitCodeRpc,
  WsProviderAuthLogoutRpc,
  WsServerUpsertKeybindingRpc,
  WsServerRemoveKeybindingRpc,
  WsServerGetSettingsRpc,
  WsServerUpdateSettingsRpc,
  WsServerDiscoverSourceControlRpc,
  WsServerGetTraceDiagnosticsRpc,
  WsServerGetProcessDiagnosticsRpc,
  WsServerGetProcessResourceHistoryRpc,
  WsServerSignalProcessRpc,
  WsSourceControlLookupRepositoryRpc,
  WsSourceControlListOwnedRepositoriesRpc,
  WsSourceControlCloneRepositoryRpc,
  WsSourceControlPublishRepositoryRpc,
  WsAudioTranscribeRpc,
  WsProjectsSearchEntriesRpc,
  WsProjectsWriteFileRpc,
  WsShellOpenInEditorRpc,
  WsShellOpenInTerminalRpc,
  WsFilesystemBrowseRpc,
  WsSubscribeVcsStatusRpc,
  WsVcsPullRpc,
  WsVcsRefreshStatusRpc,
  WsGitRunStackedActionRpc,
  WsGitResolvePullRequestRpc,
  WsGitPreparePullRequestThreadRpc,
  WsVcsListRefsRpc,
  WsVcsCreateWorktreeRpc,
  WsVcsRemoveWorktreeRpc,
  WsVcsCreateRefRpc,
  WsVcsSwitchRefRpc,
  WsVcsInitRpc,
  WsReviewGetDiffPreviewRpc,
  WsCritEnsureSidecarRpc,
  WsCritSidecarStatusRpc,
  WsCritReleaseSidecarRpc,
  WsBrowserPreviewOpenRpc,
  WsBrowserPreviewStatusRpc,
  WsBrowserPreviewControlRpc,
  WsGitsGetCockpitRpc,
  WsGitsDevCommandsListRpc,
  WsGitsDevCommandsInitRpc,
  WsGitsPortsListRpc,
  WsGitsNotesListRpc,
  WsGitsNotesReadRpc,
  WsGitsNotesCreateRpc,
  WsGitsNotesUpdateRpc,
  WsGitsNotesRemoveRpc,
  WsGitsNotesSyncRpc,
  WsGitsVisualPlanMutateRpc,
  WsGitsDelamainListPeersRpc,
  WsGitsDelamainGetPeerStatusRpc,
  WsGitsDelamainReadPeerLogRpc,
  WsGitsDelamainReadPeerLogParsedRpc,
  WsGitsDelamainSpawnPeerRpc,
  WsGitsDelamainKillPeerRpc,
  WsGitsDelamainSendPeerReplyRpc,
  WsGitsDelamainWaitForPeerRpc,
  WsGitsDelamainIntegratePeerRpc,
  WsGitsDelamainWorkflowStatusRpc,
  WsGitsDelamainWorkflowKillRpc,
  WsGitsDelamainRunWorkflowRpc,
  WsGitsDelamainReadInboxRpc,
  WsGitsDelamainSendMessageRpc,
  WsGitsOpenGsdGetStatusRpc,
  WsGitsOpenGsdInitProjectRpc,
  WsGitsOpenGsdRunAutoRpc,
  WsGitsAutomodeGetSnapshotRpc,
  WsGitsAutomodeUpdatePolicyRpc,
  WsGitsAutomodeEnqueueGoalRpc,
  WsGitsAutomodeApproveGoalRpc,
  WsGitsAutomodeRejectGoalRpc,
  WsGitsAutomodeDispatchGoalRpc,
  WsGitsAutomodeSchedulerSnapshotRpc,
  WsGitsAutomodeSchedulerSetConfigRpc,
  WsGitsAutomodeSchedulerArmRpc,
  WsGitsAutomodeSchedulerDisarmRpc,
  WsGitsAutomodeDriverResumeRpc,
  WsGitsAutomodeEpisodesListRpc,
  WsGitsAutomodeStopAllRpc,
  WsGitsAutomodeGoalsKillRpc,
  WsGitsCapacityGetSnapshotRpc,
  WsGitsHermesGetStatusRpc,
  WsGitsHermesGetConfigRpc,
  WsGitsHermesCheckRpc,
  WsGitsHermesSetupCodexOAuthRpc,
  WsGitsHermesStartAcpSessionRpc,
  WsGitsHermesListSessionsRpc,
  WsGitsHermesTailLogRpc,
  WsGitsHermesListProposalsRpc,
  WsGitsHermesInspectGitsRpc,
  WsGitsHermesChatRpc,
  WsGitsHermesDecideProposalRpc,
  WsGitsHermesWriteProjectContextRpc,
  WsGitsHermesDraftFromProposalRpc,
  WsGitsHermesRunScheduleRpc,
  WsTerminalOpenRpc,
  WsTerminalAttachRpc,
  WsTerminalWriteRpc,
  WsTerminalResizeRpc,
  WsTerminalClearRpc,
  WsTerminalRestartRpc,
  WsTerminalCloseRpc,
  WsSubscribeTerminalEventsRpc,
  WsSubscribeTerminalMetadataRpc,
  WsSubscribeServerConfigRpc,
  WsSubscribeServerLifecycleRpc,
  WsSubscribeAuthAccessRpc,
  WsOrchestrationDispatchCommandRpc,
  WsOrchestrationGetTurnDiffRpc,
  WsOrchestrationGetFullThreadDiffRpc,
  WsOrchestrationReplayEventsRpc,
  WsOrchestrationGetArchivedShellSnapshotRpc,
  WsOrchestrationSubscribeShellRpc,
  WsOrchestrationSubscribeThreadRpc,
);
