import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

const PathString = TrimmedNonEmptyString.check(Schema.isMaxLength(4096));
const SummaryString = TrimmedNonEmptyString.check(Schema.isMaxLength(10_000));
const NonNegativeNumber = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0));

export const GitsRepo = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  rootPath: PathString,
  remoteUrl: Schema.NullOr(TrimmedNonEmptyString),
  defaultBranch: Schema.NullOr(TrimmedNonEmptyString),
});
export type GitsRepo = typeof GitsRepo.Type;

export const GitsGsdState = Schema.Literals(["absent", "present", "partial", "error"]);
export type GitsGsdState = typeof GitsGsdState.Type;

export const GitsPlanningSummary = Schema.Struct({
  state: GitsGsdState,
  path: Schema.NullOr(PathString),
  phaseCount: NonNegativeInt,
  milestoneCount: NonNegativeInt,
  warnings: Schema.Array(TrimmedNonEmptyString),
  lastScannedAt: IsoDateTime,
});
export type GitsPlanningSummary = typeof GitsPlanningSummary.Type;

export const GitsProject = Schema.Struct({
  id: ProjectId,
  title: TrimmedNonEmptyString,
  rootPath: PathString,
  clientName: Schema.NullOr(TrimmedNonEmptyString),
  repo: GitsRepo,
  planning: GitsPlanningSummary,
});
export type GitsProject = typeof GitsProject.Type;

export const GsdPhaseStatus = Schema.Literals([
  "unknown",
  "discussing",
  "planned",
  "executing",
  "blocked",
  "completed",
  "verified",
]);
export type GsdPhaseStatus = typeof GsdPhaseStatus.Type;

export const GsdPhase = Schema.Struct({
  id: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  projectId: ProjectId,
  path: PathString,
  status: GsdPhaseStatus,
  hasContext: Schema.Boolean,
  hasSpec: Schema.Boolean,
  hasPlan: Schema.Boolean,
  hasFrozenContract: Schema.Boolean,
  hasVerification: Schema.Boolean,
  hasSummary: Schema.Boolean,
  riskFlags: Schema.Array(TrimmedNonEmptyString),
  updatedAt: Schema.NullOr(IsoDateTime),
});
export type GsdPhase = typeof GsdPhase.Type;

export const VerificationGateStatus = Schema.Literals([
  "unknown",
  "missing",
  "pending",
  "blocked",
  "failed",
  "passed",
]);
export type VerificationGateStatus = typeof VerificationGateStatus.Type;

export const VerificationGate = Schema.Struct({
  id: TrimmedNonEmptyString,
  projectId: ProjectId,
  phaseId: Schema.NullOr(TrimmedNonEmptyString),
  label: TrimmedNonEmptyString,
  status: VerificationGateStatus,
  sourcePath: Schema.NullOr(PathString),
  evidenceSummary: Schema.NullOr(SummaryString),
});
export type VerificationGate = typeof VerificationGate.Type;

export const AgentSessionStatus = Schema.Literals([
  "unknown",
  "idle",
  "starting",
  "running",
  "ready",
  "interrupted",
  "stopped",
  "error",
]);
export type AgentSessionStatus = typeof AgentSessionStatus.Type;

export const AgentSession = Schema.Struct({
  id: TrimmedNonEmptyString,
  projectId: ProjectId,
  threadId: Schema.NullOr(ThreadId),
  provider: TrimmedNonEmptyString,
  model: Schema.NullOr(TrimmedNonEmptyString),
  status: AgentSessionStatus,
  cwd: PathString,
  worktreePath: Schema.NullOr(PathString),
  lastActivityAt: Schema.NullOr(IsoDateTime),
});
export type AgentSession = typeof AgentSession.Type;

export const PeerStatus = Schema.Literals([
  "unknown",
  "pending",
  "running",
  "blocked",
  "waiting",
  "done",
  "completed",
  "failed",
  "frozen",
  "killed",
  "halted",
]);
export type PeerStatus = typeof PeerStatus.Type;

export const Peer = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: Schema.NullOr(TrimmedNonEmptyString),
  status: PeerStatus,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(PathString),
  prUrl: Schema.NullOr(TrimmedNonEmptyString),
  updatedAt: Schema.NullOr(IsoDateTime),
});
export type Peer = typeof Peer.Type;

export const GoalStatus = Schema.Literals([
  "unknown",
  "queued",
  "active",
  "waiting",
  "completed",
  "failed",
  "paused",
]);
export type GoalStatus = typeof GoalStatus.Type;

export const GoalMode = Schema.Literals(["manual", "supervised", "autonomous", "unknown"]);
export type GoalMode = typeof GoalMode.Type;

export const Goal = Schema.Struct({
  id: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  status: GoalStatus,
  mode: GoalMode,
  budgetTokens: Schema.NullOr(NonNegativeInt),
  budgetSeconds: Schema.NullOr(NonNegativeInt),
  updatedAt: Schema.NullOr(IsoDateTime),
});
export type Goal = typeof Goal.Type;

export const YourTurnKind = Schema.Literals([
  "missing-planning",
  "missing-plan",
  "missing-verification",
  "blocked",
  "human-review",
  "approval",
  "risk-flag",
]);
export type YourTurnKind = typeof YourTurnKind.Type;

export const YourTurnSeverity = Schema.Literals(["info", "warning", "critical"]);
export type YourTurnSeverity = typeof YourTurnSeverity.Type;

export const YourTurnCard = Schema.Struct({
  id: TrimmedNonEmptyString,
  projectId: ProjectId,
  phaseId: Schema.NullOr(TrimmedNonEmptyString),
  kind: YourTurnKind,
  severity: YourTurnSeverity,
  title: TrimmedNonEmptyString,
  detail: SummaryString,
  sourcePath: Schema.NullOr(PathString),
});
export type YourTurnCard = typeof YourTurnCard.Type;

export const GitsCockpitProject = Schema.Struct({
  project: GitsProject,
  phases: Schema.Array(GsdPhase),
  verificationGates: Schema.Array(VerificationGate),
  agentSessions: Schema.Array(AgentSession),
  peers: Schema.Array(Peer),
  goals: Schema.Array(Goal),
  yourTurn: Schema.Array(YourTurnCard),
});
export type GitsCockpitProject = typeof GitsCockpitProject.Type;

export const GitsCockpitTotals = Schema.Struct({
  projectCount: NonNegativeInt,
  planningProjectCount: NonNegativeInt,
  phaseCount: NonNegativeInt,
  verificationGateCount: NonNegativeInt,
  pendingYourTurnCount: NonNegativeInt,
  activeAgentSessionCount: NonNegativeInt,
  peerCount: NonNegativeInt,
});
export type GitsCockpitTotals = typeof GitsCockpitTotals.Type;

export const GitsCockpitSnapshot = Schema.Struct({
  scannedAt: IsoDateTime,
  projects: Schema.Array(GitsCockpitProject),
  totals: GitsCockpitTotals,
});
export type GitsCockpitSnapshot = typeof GitsCockpitSnapshot.Type;

export const GitsCockpitInput = Schema.Struct({});
export type GitsCockpitInput = typeof GitsCockpitInput.Type;

export const GitsBuildInfo = Schema.Struct({
  branch: Schema.NullOr(TrimmedNonEmptyString),
  commit: Schema.NullOr(TrimmedNonEmptyString),
  time: Schema.NullOr(TrimmedNonEmptyString),
  dirty: Schema.NullOr(Schema.Boolean),
  sourcePath: Schema.NullOr(PathString),
});
export type GitsBuildInfo = typeof GitsBuildInfo.Type;

export const GitsDevCommand = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  description: Schema.NullOr(SummaryString),
  cwd: PathString,
  command: SummaryString,
  localPort: Schema.NullOr(NonNegativeInt),
  localHost: Schema.NullOr(TrimmedNonEmptyString),
  publishOnTailnet: Schema.Boolean,
  servePort: Schema.NullOr(NonNegativeInt),
  previewUrl: Schema.NullOr(TrimmedNonEmptyString),
  launchCommand: SummaryString,
});
export type GitsDevCommand = typeof GitsDevCommand.Type;

export const GitsDevCommandListInput = Schema.Struct({
  projectDir: PathString,
});
export type GitsDevCommandListInput = typeof GitsDevCommandListInput.Type;

export const GitsDevCommandInitInput = Schema.Struct({
  projectDir: PathString,
});
export type GitsDevCommandInitInput = typeof GitsDevCommandInitInput.Type;

export const GitsDevCommandListResult = Schema.Struct({
  projectDir: PathString,
  configPath: Schema.NullOr(PathString),
  tailscaleAvailable: Schema.Boolean,
  magicDnsName: Schema.NullOr(TrimmedNonEmptyString),
  commands: Schema.Array(GitsDevCommand),
  warnings: Schema.Array(TrimmedNonEmptyString),
});
export type GitsDevCommandListResult = typeof GitsDevCommandListResult.Type;

export const GitsSkillProvider = Schema.Literals(["codex", "claude", "cursor", "gits", "unknown"]);
export type GitsSkillProvider = typeof GitsSkillProvider.Type;

export const GitsSkillKind = Schema.Literals([
  "skill",
  "agent",
  "rule",
  "slash-command",
  "prompt",
  "workflow",
  "unknown",
]);
export type GitsSkillKind = typeof GitsSkillKind.Type;

export const GitsSkillPortability = Schema.Literals([
  "native",
  "ported",
  "candidate",
  "missing-port",
  "unknown",
]);
export type GitsSkillPortability = typeof GitsSkillPortability.Type;

export const GitsSkillInventoryItem = Schema.Struct({
  id: TrimmedNonEmptyString,
  provider: GitsSkillProvider,
  kind: GitsSkillKind,
  name: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  description: Schema.NullOr(SummaryString),
  path: PathString,
  sourceRoot: PathString,
  rating: Schema.NullOr(NonNegativeInt),
  review: Schema.NullOr(SummaryString),
  usageCount: NonNegativeInt,
  lastUsedAt: Schema.NullOr(IsoDateTime),
  lastModifiedAt: Schema.NullOr(IsoDateTime),
  portability: GitsSkillPortability,
  tags: Schema.Array(TrimmedNonEmptyString),
});
export type GitsSkillInventoryItem = typeof GitsSkillInventoryItem.Type;

export const GitsSkillProviderSummary = Schema.Struct({
  provider: GitsSkillProvider,
  totalCount: NonNegativeInt,
  nativeCount: NonNegativeInt,
  missingPortCount: NonNegativeInt,
  ratedCount: NonNegativeInt,
  reviewedCount: NonNegativeInt,
});
export type GitsSkillProviderSummary = typeof GitsSkillProviderSummary.Type;

export const GitsSkillInsightKind = Schema.Literals([
  "missing-provider-port",
  "weak-description",
  "duplicate-name",
  "hermes-candidate",
]);
export type GitsSkillInsightKind = typeof GitsSkillInsightKind.Type;

export const GitsSkillInsight = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: GitsSkillInsightKind,
  title: TrimmedNonEmptyString,
  detail: SummaryString,
  severity: YourTurnSeverity,
  skillIds: Schema.Array(TrimmedNonEmptyString),
});
export type GitsSkillInsight = typeof GitsSkillInsight.Type;

export const GitsSkillInventoryTotals = Schema.Struct({
  skillCount: NonNegativeInt,
  providerCount: NonNegativeInt,
  ratedCount: NonNegativeInt,
  reviewedCount: NonNegativeInt,
  missingPortCount: NonNegativeInt,
  hermesCandidateCount: NonNegativeInt,
});
export type GitsSkillInventoryTotals = typeof GitsSkillInventoryTotals.Type;

export const GitsSkillInventorySnapshot = Schema.Struct({
  scannedAt: IsoDateTime,
  skills: Schema.Array(GitsSkillInventoryItem),
  providers: Schema.Array(GitsSkillProviderSummary),
  totals: GitsSkillInventoryTotals,
  warnings: Schema.Array(TrimmedNonEmptyString),
  insights: Schema.Array(GitsSkillInsight),
});
export type GitsSkillInventorySnapshot = typeof GitsSkillInventorySnapshot.Type;

export const GitsMcpServerProvider = Schema.Literals(["codex", "claude", "cursor", "unknown"]);
export type GitsMcpServerProvider = typeof GitsMcpServerProvider.Type;

export const GitsMcpServerSource = Schema.Literals(["codex-app-server", "config-file", "unknown"]);
export type GitsMcpServerSource = typeof GitsMcpServerSource.Type;

export const GitsMcpAuthStatus = Schema.Literals([
  "unsupported",
  "unauthenticated",
  "authenticated",
  "unknown",
]);
export type GitsMcpAuthStatus = typeof GitsMcpAuthStatus.Type;

export const GitsMcpServerStatus = Schema.Literals([
  "running",
  "stopped",
  "error",
  "disabled",
  "unknown",
]);
export type GitsMcpServerStatus = typeof GitsMcpServerStatus.Type;

export const GitsMcpServerItem = Schema.Struct({
  id: TrimmedNonEmptyString,
  provider: GitsMcpServerProvider,
  name: TrimmedNonEmptyString,
  source: GitsMcpServerSource,
  status: GitsMcpServerStatus,
  authStatus: GitsMcpAuthStatus,
  enabled: Schema.Boolean,
  command: Schema.NullOr(TrimmedNonEmptyString),
  transport: Schema.NullOr(TrimmedNonEmptyString),
  toolCount: NonNegativeInt,
  resourceCount: NonNegativeInt,
  tools: Schema.Array(TrimmedNonEmptyString),
  configPath: Schema.NullOr(PathString),
  error: Schema.NullOr(SummaryString),
});
export type GitsMcpServerItem = typeof GitsMcpServerItem.Type;

export const GitsMcpServerProviderSummary = Schema.Struct({
  provider: GitsMcpServerProvider,
  serverCount: NonNegativeInt,
  runningCount: NonNegativeInt,
  disabledCount: NonNegativeInt,
  toolCount: NonNegativeInt,
});
export type GitsMcpServerProviderSummary = typeof GitsMcpServerProviderSummary.Type;

export const GitsMcpInventoryTotals = Schema.Struct({
  serverCount: NonNegativeInt,
  runningCount: NonNegativeInt,
  errorCount: NonNegativeInt,
  disabledCount: NonNegativeInt,
  toolCount: NonNegativeInt,
});
export type GitsMcpInventoryTotals = typeof GitsMcpInventoryTotals.Type;

export const GitsMcpInventorySnapshot = Schema.Struct({
  scannedAt: IsoDateTime,
  servers: Schema.Array(GitsMcpServerItem),
  providers: Schema.Array(GitsMcpServerProviderSummary),
  totals: GitsMcpInventoryTotals,
  warnings: Schema.Array(TrimmedNonEmptyString),
});
export type GitsMcpInventorySnapshot = typeof GitsMcpInventorySnapshot.Type;

export const DelamainEngine = Schema.Literals(["codex", "cursor", "unknown"]);
export type DelamainEngine = typeof DelamainEngine.Type;

export const DelamainCapability = Schema.Literals([
  "list",
  "status",
  "log",
  "spawn",
  "kill",
  "reply",
  "wait",
  "integrate",
]);
export type DelamainCapability = typeof DelamainCapability.Type;

export const DelamainCapabilities = Schema.Struct({
  available: Schema.Boolean,
  binaryPath: Schema.NullOr(TrimmedNonEmptyString),
  supported: Schema.Array(DelamainCapability),
  unsupported: Schema.Array(DelamainCapability),
  checkedAt: IsoDateTime,
});
export type DelamainCapabilities = typeof DelamainCapabilities.Type;

export const DelamainPeer = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: Schema.NullOr(TrimmedNonEmptyString),
  engine: DelamainEngine,
  model: Schema.NullOr(TrimmedNonEmptyString),
  status: PeerStatus,
  rawStatus: TrimmedNonEmptyString,
  integrationStatus: Schema.NullOr(TrimmedNonEmptyString),
  sourceRepo: Schema.NullOr(PathString),
  worktreePath: Schema.NullOr(PathString),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  baseBranch: Schema.NullOr(TrimmedNonEmptyString),
  mergeBranch: Schema.NullOr(TrimmedNonEmptyString),
  prUrl: Schema.NullOr(TrimmedNonEmptyString),
  task: Schema.NullOr(SummaryString),
  lastEvent: Schema.NullOr(SummaryString),
  startedAt: Schema.NullOr(IsoDateTime),
  updatedAt: Schema.NullOr(IsoDateTime),
  finishedAt: Schema.NullOr(IsoDateTime),
});
export type DelamainPeer = typeof DelamainPeer.Type;

export const DelamainPeerListInput = Schema.Struct({});
export type DelamainPeerListInput = typeof DelamainPeerListInput.Type;

export const DelamainPeerListResult = Schema.Struct({
  capabilities: DelamainCapabilities,
  peers: Schema.Array(DelamainPeer),
});
export type DelamainPeerListResult = typeof DelamainPeerListResult.Type;

export const DelamainPeerStatusInput = Schema.Struct({
  peerId: TrimmedNonEmptyString,
});
export type DelamainPeerStatusInput = typeof DelamainPeerStatusInput.Type;

export const DelamainPeerLogInput = Schema.Struct({
  peerId: TrimmedNonEmptyString,
  lines: Schema.optional(NonNegativeInt),
});
export type DelamainPeerLogInput = typeof DelamainPeerLogInput.Type;

export const DelamainPeerLogResult = Schema.Struct({
  peerId: TrimmedNonEmptyString,
  lines: NonNegativeInt,
  text: Schema.String,
});
export type DelamainPeerLogResult = typeof DelamainPeerLogResult.Type;

export const DelamainSpawnPeerInput = Schema.Struct({
  repo: PathString,
  prompt: SummaryString,
  name: Schema.optional(TrimmedNonEmptyString),
  startRef: Schema.optional(TrimmedNonEmptyString),
  mergeBranch: Schema.optional(TrimmedNonEmptyString),
  targetBranch: Schema.optional(TrimmedNonEmptyString),
  engine: Schema.optional(DelamainEngine),
  model: Schema.optional(TrimmedNonEmptyString),
  sandbox: Schema.optional(Schema.Literals(["read-only", "workspace-write", "danger-full-access"])),
  yolo: Schema.optional(Schema.Boolean),
  confine: Schema.optional(Schema.Boolean),
  egress: Schema.optional(Schema.Literals(["off", "host"])),
});
export type DelamainSpawnPeerInput = typeof DelamainSpawnPeerInput.Type;

export const DelamainPeerReplyInput = Schema.Struct({
  peerId: TrimmedNonEmptyString,
  prompt: SummaryString,
  model: Schema.optional(TrimmedNonEmptyString),
  yolo: Schema.optional(Schema.Boolean),
});
export type DelamainPeerReplyInput = typeof DelamainPeerReplyInput.Type;

export const DelamainPeerKillInput = Schema.Struct({
  peerId: TrimmedNonEmptyString,
  signal: Schema.optional(Schema.Literals(["SIGTERM", "SIGKILL"])),
});
export type DelamainPeerKillInput = typeof DelamainPeerKillInput.Type;

export const DelamainPeerWaitInput = Schema.Struct({
  peerId: TrimmedNonEmptyString,
  timeoutMs: Schema.optional(NonNegativeInt),
});
export type DelamainPeerWaitInput = typeof DelamainPeerWaitInput.Type;

export const DelamainPeerIntegrateInput = Schema.Struct({
  peerId: TrimmedNonEmptyString,
});
export type DelamainPeerIntegrateInput = typeof DelamainPeerIntegrateInput.Type;

export const DelamainPeerIntegrateResult = Schema.Struct({
  peer: DelamainPeer,
  prNumber: Schema.NullOr(NonNegativeInt),
  prUrl: Schema.NullOr(TrimmedNonEmptyString),
  autoMergeEnabled: Schema.Boolean,
});
export type DelamainPeerIntegrateResult = typeof DelamainPeerIntegrateResult.Type;

export const OpenGsdCapability = Schema.Literals(["detect", "init", "auto"]);
export type OpenGsdCapability = typeof OpenGsdCapability.Type;

export const OpenGsdStatusInput = Schema.Struct({});
export type OpenGsdStatusInput = typeof OpenGsdStatusInput.Type;

export const OpenGsdStatusResult = Schema.Struct({
  available: Schema.Boolean,
  binaryPath: Schema.NullOr(TrimmedNonEmptyString),
  packageName: TrimmedNonEmptyString,
  cliName: TrimmedNonEmptyString,
  version: Schema.NullOr(TrimmedNonEmptyString),
  supported: Schema.Array(OpenGsdCapability),
  unsupported: Schema.Array(OpenGsdCapability),
  checkedAt: IsoDateTime,
});
export type OpenGsdStatusResult = typeof OpenGsdStatusResult.Type;

export const OpenGsdCommandName = Schema.Literals(["init", "auto"]);
export type OpenGsdCommandName = typeof OpenGsdCommandName.Type;

export const OpenGsdCommandStatus = Schema.Literals(["completed", "failed", "timed-out"]);
export type OpenGsdCommandStatus = typeof OpenGsdCommandStatus.Type;

export const OpenGsdCommonCommandInput = {
  projectDir: PathString,
  workstream: Schema.optional(TrimmedNonEmptyString),
  model: Schema.optional(TrimmedNonEmptyString),
  maxBudgetUsd: Schema.optional(NonNegativeNumber),
  timeoutMs: Schema.optional(NonNegativeInt),
} as const;

export const OpenGsdInitProjectInput = Schema.Struct({
  ...OpenGsdCommonCommandInput,
  input: SummaryString,
});
export type OpenGsdInitProjectInput = typeof OpenGsdInitProjectInput.Type;

export const OpenGsdRunAutoInput = Schema.Struct({
  ...OpenGsdCommonCommandInput,
  initInput: Schema.optional(SummaryString),
});
export type OpenGsdRunAutoInput = typeof OpenGsdRunAutoInput.Type;

export const OpenGsdCommandResult = Schema.Struct({
  command: OpenGsdCommandName,
  projectDir: PathString,
  status: OpenGsdCommandStatus,
  args: Schema.Array(TrimmedNonEmptyString),
  exitCode: Schema.NullOr(Schema.Number),
  signal: Schema.NullOr(TrimmedNonEmptyString),
  stdout: Schema.String,
  stderr: Schema.String,
  startedAt: IsoDateTime,
  finishedAt: IsoDateTime,
  durationMs: NonNegativeInt,
});
export type OpenGsdCommandResult = typeof OpenGsdCommandResult.Type;

export const AutomodeMode = Schema.Literals(["manual", "supervised", "autonomous"]);
export type AutomodeMode = typeof AutomodeMode.Type;

export const AutomodeGoalStatus = Schema.Literals([
  "queued",
  "waiting-approval",
  "running",
  "completed",
  "failed",
  "blocked",
  "rejected",
]);
export type AutomodeGoalStatus = typeof AutomodeGoalStatus.Type;

// Server-pinned verification command (argv array, not a shell string). Defined here
// because `AutomodePolicy.verificationCommands` references it; the verification-gate
// section below (GitsVerifyInput/Result) reuses the same schema.
export const GitsVerifyCommand = Schema.Struct({
  label: TrimmedNonEmptyString,
  cmd: Schema.Array(TrimmedNonEmptyString), // explicit argv (argv[0] is the program), not a shell string
  timeoutSeconds: Schema.optional(NonNegativeInt),
});
export type GitsVerifyCommand = typeof GitsVerifyCommand.Type;

export const AutomodePolicy = Schema.Struct({
  mode: AutomodeMode,
  killSwitchEnabled: Schema.Boolean,
  maxActivePeers: NonNegativeInt,
  allowedRepos: Schema.Array(PathString),
  allowedModels: Schema.Array(TrimmedNonEmptyString),
  defaultModel: Schema.NullOr(TrimmedNonEmptyString),
  maxBudgetUsd: Schema.NullOr(NonNegativeNumber),
  maxRuntimeMinutes: Schema.NullOr(NonNegativeInt),
  requireApprovalForPeerSpawn: Schema.Boolean,
  requireApprovalBeforeIntegrate: Schema.Boolean,
  requireApprovalBeforeDestructiveAction: Schema.Boolean,
  verificationCommands: Schema.Array(GitsVerifyCommand).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  integrationBranch: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  updatedAt: IsoDateTime,
});
export type AutomodePolicy = typeof AutomodePolicy.Type;

export const AutomodeGoal = Schema.Struct({
  id: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  prompt: SummaryString,
  repo: PathString,
  model: Schema.NullOr(TrimmedNonEmptyString),
  status: AutomodeGoalStatus,
  peerId: Schema.NullOr(TrimmedNonEmptyString),
  blockedReason: Schema.NullOr(SummaryString),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  approvedAt: Schema.NullOr(IsoDateTime),
  rejectedAt: Schema.NullOr(IsoDateTime),
});
export type AutomodeGoal = typeof AutomodeGoal.Type;

export const AutomodeBudgetUsageSource = Schema.Literals(["provider-runtime", "unavailable"]);
export type AutomodeBudgetUsageSource = typeof AutomodeBudgetUsageSource.Type;

export const AutomodeBudgetUsage = Schema.Struct({
  source: AutomodeBudgetUsageSource,
  totalCostUsd: Schema.NullOr(NonNegativeNumber),
  totalProcessedTokens: Schema.NullOr(NonNegativeInt),
  updatedAt: Schema.NullOr(IsoDateTime),
  note: Schema.NullOr(SummaryString),
});
export type AutomodeBudgetUsage = typeof AutomodeBudgetUsage.Type;

export const AutomodeSnapshotInput = Schema.Struct({});
export type AutomodeSnapshotInput = typeof AutomodeSnapshotInput.Type;

export const AutomodeSnapshot = Schema.Struct({
  policy: AutomodePolicy,
  budgetUsage: AutomodeBudgetUsage,
  goals: Schema.Array(AutomodeGoal),
  activePeerCount: NonNegativeInt,
  pendingApprovalCount: NonNegativeInt,
  driverHalted: Schema.Boolean,
  driverHaltedReason: Schema.NullOr(SummaryString),
  lastEvent: Schema.NullOr(SummaryString),
  updatedAt: IsoDateTime,
});
export type AutomodeSnapshot = typeof AutomodeSnapshot.Type;

export const AutomodePolicyUpdateInput = Schema.Struct({
  mode: Schema.optional(AutomodeMode),
  killSwitchEnabled: Schema.optional(Schema.Boolean),
  maxActivePeers: Schema.optional(NonNegativeInt),
  allowedRepos: Schema.optional(Schema.Array(PathString)),
  allowedModels: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  defaultModel: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  maxBudgetUsd: Schema.optional(Schema.NullOr(NonNegativeNumber)),
  maxRuntimeMinutes: Schema.optional(Schema.NullOr(NonNegativeInt)),
  requireApprovalForPeerSpawn: Schema.optional(Schema.Boolean),
  requireApprovalBeforeIntegrate: Schema.optional(Schema.Boolean),
  requireApprovalBeforeDestructiveAction: Schema.optional(Schema.Boolean),
  verificationCommands: Schema.optional(Schema.Array(GitsVerifyCommand)),
  integrationBranch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
});
export type AutomodePolicyUpdateInput = typeof AutomodePolicyUpdateInput.Type;

export const AutomodeEnqueueGoalInput = Schema.Struct({
  title: TrimmedNonEmptyString,
  prompt: SummaryString,
  repo: PathString,
  model: Schema.optional(TrimmedNonEmptyString),
});
export type AutomodeEnqueueGoalInput = typeof AutomodeEnqueueGoalInput.Type;

export const AutomodeGoalInput = Schema.Struct({
  goalId: TrimmedNonEmptyString,
});
export type AutomodeGoalInput = typeof AutomodeGoalInput.Type;

export const AutomodeRejectGoalInput = Schema.Struct({
  goalId: TrimmedNonEmptyString,
  reason: Schema.optional(SummaryString),
});
export type AutomodeRejectGoalInput = typeof AutomodeRejectGoalInput.Type;

export const AutomodeGoalOutcomeInput = Schema.Struct({
  goalId: TrimmedNonEmptyString,
  reason: Schema.optional(SummaryString),
});
export type AutomodeGoalOutcomeInput = typeof AutomodeGoalOutcomeInput.Type;

export const AutomodeDriverHaltInput = Schema.Struct({
  reason: SummaryString,
});
export type AutomodeDriverHaltInput = typeof AutomodeDriverHaltInput.Type;

export const AutomodeDispatchResult = Schema.Struct({
  snapshot: AutomodeSnapshot,
  goal: AutomodeGoal,
  peer: Schema.NullOr(DelamainPeer),
  approvalRequired: Schema.Boolean,
  blockedReason: Schema.NullOr(SummaryString),
});
export type AutomodeDispatchResult = typeof AutomodeDispatchResult.Type;

export const GitsProviderName = Schema.Literals(["codex", "cursor"]);
export type GitsProviderName = typeof GitsProviderName.Type;

export const GitsProviderStatus = Schema.Literals([
  "available",
  "configured",
  "degraded",
  "unavailable",
  "unknown",
]);
export type GitsProviderStatus = typeof GitsProviderStatus.Type;

export const GitsUsageLevel = Schema.Literals(["green", "yellow", "red", "critical", "unknown"]);
export type GitsUsageLevel = typeof GitsUsageLevel.Type;

export const GitsUsageSource = Schema.Literals([
  "codex-log",
  "codex-session-jsonl",
  "cursor-budget-config",
  "cursor-cli",
  "cursor-dashboard",
  "cursor-dashboard-cookie",
  "manual-config",
  "env",
  "unavailable",
]);
export type GitsUsageSource = typeof GitsUsageSource.Type;

export const GitsUsageWindow = Schema.Struct({
  label: TrimmedNonEmptyString,
  usedPercent: Schema.NullOr(NonNegativeNumber),
  remainingPercent: Schema.NullOr(NonNegativeNumber),
  windowMinutes: Schema.NullOr(NonNegativeInt),
  resetAt: Schema.NullOr(IsoDateTime),
  level: GitsUsageLevel,
  source: GitsUsageSource,
  note: Schema.NullOr(SummaryString),
});
export type GitsUsageWindow = typeof GitsUsageWindow.Type;

export const GitsProviderUsage = Schema.Struct({
  provider: GitsProviderName,
  displayName: TrimmedNonEmptyString,
  status: GitsProviderStatus,
  source: GitsUsageSource,
  accountLabel: Schema.NullOr(TrimmedNonEmptyString),
  planLabel: Schema.NullOr(TrimmedNonEmptyString),
  windows: Schema.Array(GitsUsageWindow),
  monthlyBudgetUsd: Schema.NullOr(NonNegativeNumber),
  monthlySpendUsd: Schema.NullOr(NonNegativeNumber),
  monthlyUtilizationPercent: Schema.NullOr(NonNegativeNumber),
  monthlyRemainingUsd: Schema.NullOr(NonNegativeNumber),
  monthlyResetAt: Schema.NullOr(IsoDateTime),
  note: Schema.NullOr(SummaryString),
  updatedAt: IsoDateTime,
});
export type GitsProviderUsage = typeof GitsProviderUsage.Type;

export const GitsCapacityRecommendation = Schema.Struct({
  recommendedEngine: DelamainEngine,
  confidence: Schema.Literals(["high", "medium", "low"]),
  reason: SummaryString,
  codexRemainingPercent: Schema.NullOr(NonNegativeNumber),
  cursorRemainingPercent: Schema.NullOr(NonNegativeNumber),
});
export type GitsCapacityRecommendation = typeof GitsCapacityRecommendation.Type;

export const GitsCapacitySnapshotInput = Schema.Struct({});
export type GitsCapacitySnapshotInput = typeof GitsCapacitySnapshotInput.Type;

export const GitsCapacitySnapshot = Schema.Struct({
  checkedAt: IsoDateTime,
  codex: GitsProviderUsage,
  cursor: GitsProviderUsage,
  recommendation: GitsCapacityRecommendation,
  notes: Schema.Array(SummaryString),
});
export type GitsCapacitySnapshot = typeof GitsCapacitySnapshot.Type;

export const HermesCapability = Schema.Literals([
  "status",
  "doctor",
  "acp",
  "codex-oauth",
  "chat",
  "sessions",
  "logs",
  "proposals",
  "profile",
  "project-context",
  "drafts",
  "schedules",
]);
export type HermesCapability = typeof HermesCapability.Type;

export const HermesHealthStatus = Schema.Literals([
  "unknown",
  "ok",
  "warning",
  "error",
  "unavailable",
]);
export type HermesHealthStatus = typeof HermesHealthStatus.Type;

export const HermesApprovalMode = Schema.Literals(["manual", "smart", "off", "unknown"]);
export type HermesApprovalMode = typeof HermesApprovalMode.Type;

export const HermesAuthState = Schema.Literals(["unknown", "detected", "missing", "needs-reauth"]);
export type HermesAuthState = typeof HermesAuthState.Type;

export const HermesAuthSource = Schema.Literals([
  "hermes-home",
  "codex-cli",
  "both",
  "missing",
  "unknown",
]);
export type HermesAuthSource = typeof HermesAuthSource.Type;

export const HermesCommandStatus = Schema.Literals([
  "completed",
  "failed",
  "timed-out",
  "action-required",
  "started",
]);
export type HermesCommandStatus = typeof HermesCommandStatus.Type;

export const HermesProposalActionKind = Schema.Literals([
  "read-only",
  "worktree-spawn",
  "repo-write",
  "integrate",
  "destructive-shell",
]);
export type HermesProposalActionKind = typeof HermesProposalActionKind.Type;

export const HermesProposalRisk = Schema.Literals(["low", "medium", "high", "blocked"]);
export type HermesProposalRisk = typeof HermesProposalRisk.Type;

export const HermesProposalExecutor = Schema.Literals(["none", "delamain", "open-gsd", "operator"]);
export type HermesProposalExecutor = typeof HermesProposalExecutor.Type;

export const HermesProposalStatus = Schema.Literals([
  "proposed",
  "approved",
  "rejected",
  "deferred",
  "blocked",
  "drafted",
]);
export type HermesProposalStatus = typeof HermesProposalStatus.Type;

export const HermesProposalDecision = Schema.Literals(["approve", "reject", "defer"]);
export type HermesProposalDecision = typeof HermesProposalDecision.Type;

export const HermesPolicySnapshot = Schema.Struct({
  mode: Schema.Literal("observe-propose-only"),
  directMergeAllowed: Schema.Boolean,
  directDestructiveShellAllowed: Schema.Boolean,
  repoWritesRequireDelamain: Schema.Boolean,
  humanApprovalRequiredForWriteActions: Schema.Boolean,
  notes: Schema.Array(TrimmedNonEmptyString),
});
export type HermesPolicySnapshot = typeof HermesPolicySnapshot.Type;

export const MotokoProfileStatus = Schema.Struct({
  exists: Schema.Boolean,
  managedByGits: Schema.Boolean,
  distributionPath: PathString,
  soulPath: PathString,
  configExamplePath: PathString,
  summary: SummaryString,
  updatedAt: Schema.NullOr(IsoDateTime),
});
export type MotokoProfileStatus = typeof MotokoProfileStatus.Type;

export const HermesSafeConfig = Schema.Struct({
  hermesHome: PathString,
  usingDefaultGitsHome: Schema.Boolean,
  configPath: PathString,
  soulPath: PathString,
  approvalMode: HermesApprovalMode,
  yoloModeDetected: Schema.Boolean,
  codexCliAuthPath: PathString,
});
export type HermesSafeConfig = typeof HermesSafeConfig.Type;

export const HermesModelStatus = Schema.Struct({
  provider: Schema.NullOr(TrimmedNonEmptyString),
  model: Schema.NullOr(TrimmedNonEmptyString),
  baseUrl: Schema.NullOr(TrimmedNonEmptyString),
  contextWindowTokens: Schema.NullOr(NonNegativeInt),
  contextWindowSource: Schema.Literals(["cache", "unknown"]),
});
export type HermesModelStatus = typeof HermesModelStatus.Type;

export const HermesCommandCheck = Schema.Struct({
  status: HermesHealthStatus,
  exitCode: Schema.NullOr(Schema.Number),
  stdout: Schema.String,
  stderr: Schema.String,
  checkedAt: IsoDateTime,
});
export type HermesCommandCheck = typeof HermesCommandCheck.Type;

export const HermesCodexAuthStatus = Schema.Struct({
  state: HermesAuthState,
  source: HermesAuthSource,
  hermesAuthExists: Schema.Boolean,
  codexCliAuthExists: Schema.Boolean,
  message: SummaryString,
});
export type HermesCodexAuthStatus = typeof HermesCodexAuthStatus.Type;

export const HermesSoulStatus = Schema.Struct({
  exists: Schema.Boolean,
  managedByGits: Schema.Boolean,
  path: PathString,
  summary: SummaryString,
  updatedAt: Schema.NullOr(IsoDateTime),
});
export type HermesSoulStatus = typeof HermesSoulStatus.Type;

export const HermesAcpStatus = Schema.Struct({
  available: Schema.Boolean,
  check: HermesCommandCheck,
  version: Schema.NullOr(TrimmedNonEmptyString),
});
export type HermesAcpStatus = typeof HermesAcpStatus.Type;

export const HermesStatusInput = Schema.Struct({});
export type HermesStatusInput = typeof HermesStatusInput.Type;

export const HermesStatusResult = Schema.Struct({
  available: Schema.Boolean,
  binaryPath: Schema.NullOr(TrimmedNonEmptyString),
  version: Schema.NullOr(TrimmedNonEmptyString),
  checkedAt: IsoDateTime,
  capabilities: Schema.Array(HermesCapability),
  unsupported: Schema.Array(HermesCapability),
  config: HermesSafeConfig,
  model: HermesModelStatus,
  codexAuth: HermesCodexAuthStatus,
  soul: HermesSoulStatus,
  acp: HermesAcpStatus,
  doctor: HermesCommandCheck,
  policy: HermesPolicySnapshot,
  motokoProfile: MotokoProfileStatus,
  proposalCount: NonNegativeInt,
  setupWarnings: Schema.Array(SummaryString),
});
export type HermesStatusResult = typeof HermesStatusResult.Type;

export const HermesConfigInput = Schema.Struct({});
export type HermesConfigInput = typeof HermesConfigInput.Type;

export const HermesCheckInput = Schema.Struct({});
export type HermesCheckInput = typeof HermesCheckInput.Type;

export const HermesSetupCodexOAuthInput = Schema.Struct({});
export type HermesSetupCodexOAuthInput = typeof HermesSetupCodexOAuthInput.Type;

export const HermesStartAcpSessionInput = Schema.Struct({
  cwd: Schema.optional(PathString),
});
export type HermesStartAcpSessionInput = typeof HermesStartAcpSessionInput.Type;

export const HermesInspectGitsProposalInput = Schema.Struct({
  projectDir: PathString,
  prompt: Schema.optional(SummaryString),
  timeoutMs: Schema.optional(NonNegativeInt),
});
export type HermesInspectGitsProposalInput = typeof HermesInspectGitsProposalInput.Type;

export const HermesChatInput = Schema.Struct({
  message: SummaryString,
  projectDir: Schema.optional(PathString),
  timeoutMs: Schema.optional(NonNegativeInt),
});
export type HermesChatInput = typeof HermesChatInput.Type;

export const HermesChatStatus = Schema.Literals([
  "answered",
  "proposal-created",
  "setup-required",
  "blocked",
]);
export type HermesChatStatus = typeof HermesChatStatus.Type;

export const HermesChatResult = Schema.Struct({
  status: HermesChatStatus,
  actionKind: HermesProposalActionKind,
  response: Schema.String,
  proposal: Schema.NullOr(Schema.suspend((): typeof HermesProposalCard => HermesProposalCard)),
  blockedReason: Schema.NullOr(SummaryString),
  setupTitle: Schema.NullOr(SummaryString),
  setupDetail: Schema.NullOr(Schema.String),
  setupCommand: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
});
export type HermesChatResult = typeof HermesChatResult.Type;

export const HermesCommandAction = Schema.Literals([
  "check",
  "setup-codex-oauth",
  "start-acp-session",
  "inspect-gits-proposal",
  "write-project-context",
  "run-scheduled-briefing",
]);
export type HermesCommandAction = typeof HermesCommandAction.Type;

export const HermesCommandResult = Schema.Struct({
  action: HermesCommandAction,
  status: HermesCommandStatus,
  args: Schema.Array(TrimmedNonEmptyString),
  exitCode: Schema.NullOr(Schema.Number),
  signal: Schema.NullOr(TrimmedNonEmptyString),
  stdout: Schema.String,
  stderr: Schema.String,
  startedAt: IsoDateTime,
  finishedAt: IsoDateTime,
  durationMs: NonNegativeInt,
  nextCommand: Schema.NullOr(TrimmedNonEmptyString),
});
export type HermesCommandResult = typeof HermesCommandResult.Type;

export const HermesSessionListInput = Schema.Struct({
  limit: Schema.optional(NonNegativeInt),
});
export type HermesSessionListInput = typeof HermesSessionListInput.Type;

export const HermesSession = Schema.Struct({
  id: TrimmedNonEmptyString,
  title: Schema.NullOr(TrimmedNonEmptyString),
  status: Schema.Literals(["unknown", "active", "completed", "background"]),
  updatedAt: Schema.NullOr(IsoDateTime),
  summary: Schema.NullOr(SummaryString),
});
export type HermesSession = typeof HermesSession.Type;

export const HermesSessionListResult = Schema.Struct({
  sessions: Schema.Array(HermesSession),
  checkedAt: IsoDateTime,
  source: TrimmedNonEmptyString,
});
export type HermesSessionListResult = typeof HermesSessionListResult.Type;

export const HermesLogTailInput = Schema.Struct({
  lines: Schema.optional(NonNegativeInt),
});
export type HermesLogTailInput = typeof HermesLogTailInput.Type;

export const HermesLogTailResult = Schema.Struct({
  path: Schema.NullOr(PathString),
  lines: NonNegativeInt,
  text: Schema.String,
  checkedAt: IsoDateTime,
});
export type HermesLogTailResult = typeof HermesLogTailResult.Type;

export const HermesProposalCard = Schema.Struct({
  id: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  summary: SummaryString,
  detail: SummaryString,
  evidence: Schema.Array(SummaryString),
  scope: Schema.Array(SummaryString),
  risk: HermesProposalRisk,
  actionKind: HermesProposalActionKind,
  status: HermesProposalStatus,
  requiresApproval: Schema.Boolean,
  recommendedExecutor: HermesProposalExecutor,
  verificationPlan: Schema.Array(SummaryString),
  nextCommandOrPrompt: Schema.NullOr(SummaryString),
  blockedReason: Schema.NullOr(SummaryString),
  source: TrimmedNonEmptyString,
  projectDir: Schema.NullOr(PathString),
  decisionReason: Schema.NullOr(SummaryString),
  decidedAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type HermesProposalCard = typeof HermesProposalCard.Type;

export const HermesProposalListInput = Schema.Struct({});
export type HermesProposalListInput = typeof HermesProposalListInput.Type;

export const HermesProposalListResult = Schema.Struct({
  proposals: Schema.Array(HermesProposalCard),
  checkedAt: IsoDateTime,
});
export type HermesProposalListResult = typeof HermesProposalListResult.Type;

export const HermesProposalDecisionInput = Schema.Struct({
  proposalId: TrimmedNonEmptyString,
  decision: HermesProposalDecision,
  reason: Schema.optional(SummaryString),
});
export type HermesProposalDecisionInput = typeof HermesProposalDecisionInput.Type;

export const HermesProjectContextInput = Schema.Struct({
  projectDir: PathString,
});
export type HermesProjectContextInput = typeof HermesProjectContextInput.Type;

export const HermesProjectContextResult = Schema.Struct({
  projectId: TrimmedNonEmptyString,
  projectDir: PathString,
  path: PathString,
  markdown: SummaryString,
  writtenAt: IsoDateTime,
});
export type HermesProjectContextResult = typeof HermesProjectContextResult.Type;

export const HermesDraftKind = Schema.Literals(["delamain-peer", "open-gsd", "verification"]);
export type HermesDraftKind = typeof HermesDraftKind.Type;

export const HermesDraftStatus = Schema.Literals(["draft", "blocked"]);
export type HermesDraftStatus = typeof HermesDraftStatus.Type;

export const HermesDraftFromProposalInput = Schema.Struct({
  proposalId: TrimmedNonEmptyString,
});
export type HermesDraftFromProposalInput = typeof HermesDraftFromProposalInput.Type;

export const HermesExecutionDraft = Schema.Struct({
  id: TrimmedNonEmptyString,
  proposalId: TrimmedNonEmptyString,
  kind: HermesDraftKind,
  status: HermesDraftStatus,
  title: TrimmedNonEmptyString,
  repo: Schema.NullOr(PathString),
  sourceBranch: Schema.NullOr(TrimmedNonEmptyString),
  targetBranch: Schema.NullOr(TrimmedNonEmptyString),
  prompt: SummaryString,
  risk: HermesProposalRisk,
  fileOwnership: Schema.Array(SummaryString),
  verificationCommands: Schema.Array(SummaryString),
  blockedReason: Schema.NullOr(SummaryString),
  createdAt: IsoDateTime,
});
export type HermesExecutionDraft = typeof HermesExecutionDraft.Type;

export const HermesScheduleKind = Schema.Literals([
  "daily-briefing",
  "weekly-stale-scan",
  "tailnet-health",
  "skills-review",
  "memory-review",
  "verification-sentinel",
]);
export type HermesScheduleKind = typeof HermesScheduleKind.Type;

export const HermesScheduleRunInput = Schema.Struct({
  kind: HermesScheduleKind,
  projectDir: Schema.optional(PathString),
});
export type HermesScheduleRunInput = typeof HermesScheduleRunInput.Type;

export const HermesScheduleRunResult = Schema.Struct({
  kind: HermesScheduleKind,
  ranAt: IsoDateTime,
  proposals: Schema.Array(HermesProposalCard),
  blockedReason: Schema.NullOr(SummaryString),
});
export type HermesScheduleRunResult = typeof HermesScheduleRunResult.Type;

export class AutomodeSupervisorError extends Schema.TaggedErrorClass<AutomodeSupervisorError>()(
  "AutomodeSupervisorError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export class OpenGsdAdapterError extends Schema.TaggedErrorClass<OpenGsdAdapterError>()(
  "OpenGsdAdapterError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export class DelamainAdapterError extends Schema.TaggedErrorClass<DelamainAdapterError>()(
  "DelamainAdapterError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export class GitsCockpitError extends Schema.TaggedErrorClass<GitsCockpitError>()(
  "GitsCockpitError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export class GitsCapacityError extends Schema.TaggedErrorClass<GitsCapacityError>()(
  "GitsCapacityError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export class GitsDevCommandError extends Schema.TaggedErrorClass<GitsDevCommandError>()(
  "GitsDevCommandError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export class HermesAdapterError extends Schema.TaggedErrorClass<HermesAdapterError>()(
  "HermesAdapterError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

// --- GITS verification gate (H0: confined, server-pinned verification) --------------------
// The GITS-side counterpart to the autopilot's confined verification: runs an UNTRUSTED
// worktree's verification suite under OS-level confinement (scripts/gits-confine.sh, verify
// profile). Commands are SERVER-PINNED argv arrays — never the repo's own `npm run` indirection.
// See docs/gits/H0_CONFINEMENT.md.
// `GitsVerifyCommand` is defined earlier (above `AutomodePolicy`, which references it).

export const GitsVerifyInput = Schema.Struct({
  worktree: PathString,
  commands: Schema.Array(GitsVerifyCommand),
  // When true (default), the gate FAILS CLOSED if confinement is unavailable rather than
  // running the untrusted suite on the host.
  requireConfinement: Schema.optional(Schema.Boolean),
});
export type GitsVerifyInput = typeof GitsVerifyInput.Type;

export const GitsVerifyCommandResult = Schema.Struct({
  label: TrimmedNonEmptyString,
  passed: Schema.Boolean,
  exitCode: Schema.NullOr(Schema.Number),
  timedOut: Schema.Boolean,
  durationMs: NonNegativeInt,
  outputTail: SummaryString,
});
export type GitsVerifyCommandResult = typeof GitsVerifyCommandResult.Type;

export const GitsVerifyResult = Schema.Struct({
  worktree: PathString,
  confined: Schema.Boolean, // true if commands ran under gits-confine.sh; false only when requireConfinement=false and bwrap is absent
  passed: Schema.Boolean, // all commands exited 0
  results: Schema.Array(GitsVerifyCommandResult),
  checkedAt: IsoDateTime,
});
export type GitsVerifyResult = typeof GitsVerifyResult.Type;

export class GitsVerificationGateError extends Schema.TaggedErrorClass<GitsVerificationGateError>()(
  "GitsVerificationGateError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

// --- Semantic verifier-critic (Rev 2: "green ≠ correct") ----------------------------------
// AFTER the mechanical gate (GitsVerificationGate) is green, a FRESH read-only codex agent
// judges the diff against the slice's acceptance criteria + an adversarial "what did it miss"
// pass, and TRIAGES the PR. It never blocks the chain. The diff is UNTRUSTED data (possible
// prompt injection); the verifier runs read-only and is instructed to ignore embedded
// instructions. See docs/gits/ORCHESTRATION_SELF_IMPROVEMENT_DESIGN.md §"Revision 2".

export const GitsVerifierVerdict = Schema.Literals(["pass", "fail", "uncertain"]);
export type GitsVerifierVerdict = typeof GitsVerifierVerdict.Type;

export const GitsVerifierConfidence = Schema.Literals(["low", "medium", "high"]);
export type GitsVerifierConfidence = typeof GitsVerifierConfidence.Type;

export const GitsVerifierRecommendation = Schema.Literals(["auto-merge", "hold-for-review"]);
export type GitsVerifierRecommendation = typeof GitsVerifierRecommendation.Type;

export const GitsSemanticVerifyInput = Schema.Struct({
  worktree: PathString,
  baseRef: TrimmedNonEmptyString, // diff scope is `<baseRef>..HEAD` (e.g. "origin/main")
  acceptanceCriteria: Schema.Array(SummaryString), // per-slice; empty → verifier derives provisional + flags
  sliceTitle: Schema.NullOr(SummaryString),
  model: Schema.optional(TrimmedNonEmptyString), // default codex tier (gpt-5.4-mini); escalate on uncertain
  timeoutSeconds: Schema.optional(NonNegativeInt),
});
export type GitsSemanticVerifyInput = typeof GitsSemanticVerifyInput.Type;

export const GitsSemanticVerifyResult = Schema.Struct({
  worktree: PathString,
  verdict: GitsVerifierVerdict,
  confidence: GitsVerifierConfidence,
  recommendation: GitsVerifierRecommendation, // derived: pass + (medium|high) + criteriaProvided → auto-merge; else hold
  reasons: Schema.Array(SummaryString),
  missed: Schema.Array(SummaryString), // acceptance criteria not satisfied / gaps found
  criteriaProvided: Schema.Boolean, // false → verifier derived provisional criteria → confidence capped, always hold
  model: TrimmedNonEmptyString,
  checkedAt: IsoDateTime,
});
export type GitsSemanticVerifyResult = typeof GitsSemanticVerifyResult.Type;

export class GitsSemanticVerifierError extends Schema.TaggedErrorClass<GitsSemanticVerifierError>()(
  "GitsSemanticVerifierError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

// --- Per-slice acceptance criteria (Rev 2: the verifier's source of truth) -----------------
// Authored at planning time (/grill-me, GSD .planning) and stored per slice; the peer prompt
// builds to them and the verifier judges against them (same bar). `source: "derived"` flags a
// slice with no authored criteria (verifier derives provisional ones → lower-confidence verdict).
// See docs/gits/ORCHESTRATION_SELF_IMPROVEMENT_DESIGN.md §"Revision 2".

export const GitsSliceCriteriaSource = Schema.Literals(["authored", "derived"]);
export type GitsSliceCriteriaSource = typeof GitsSliceCriteriaSource.Type;

export const GitsSliceCriteria = Schema.Struct({
  sliceId: TrimmedNonEmptyString,
  title: Schema.NullOr(SummaryString),
  acceptanceCriteria: Schema.Array(SummaryString),
  source: GitsSliceCriteriaSource,
});
export type GitsSliceCriteria = typeof GitsSliceCriteria.Type;

export const GitsSliceCriteriaLoadInput = Schema.Struct({ sliceId: TrimmedNonEmptyString });
export type GitsSliceCriteriaLoadInput = typeof GitsSliceCriteriaLoadInput.Type;

export const GitsSliceCriteriaSaveInput = Schema.Struct({
  sliceId: TrimmedNonEmptyString,
  title: Schema.optional(SummaryString),
  acceptanceCriteria: Schema.Array(SummaryString),
});
export type GitsSliceCriteriaSaveInput = typeof GitsSliceCriteriaSaveInput.Type;

export class GitsSliceCriteriaError extends Schema.TaggedErrorClass<GitsSliceCriteriaError>()(
  "GitsSliceCriteriaError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

// --- Review pipeline (Rev 2): mechanical gate → semantic verifier → combined triage ---------
// Runs the confined mechanical gate (GitsVerificationGate); only if it's GREEN does it run the
// semantic verifier-critic (GitsSemanticVerifier) against the slice's acceptance criteria. The
// semantic step is skipped on a red gate (already a hold) to save codex spend. Triage, never block.

export const GitsReviewInput = Schema.Struct({
  worktree: PathString,
  baseRef: TrimmedNonEmptyString,
  sliceId: TrimmedNonEmptyString, // criteria are loaded for this slice
  verificationCommands: Schema.Array(GitsVerifyCommand), // server-pinned mechanical suite
  model: Schema.optional(TrimmedNonEmptyString), // verifier model override
});
export type GitsReviewInput = typeof GitsReviewInput.Type;

export const GitsReviewResult = Schema.Struct({
  sliceId: TrimmedNonEmptyString,
  recommendation: GitsVerifierRecommendation, // auto-merge | hold-for-review
  mechanicalPassed: Schema.Boolean,
  mechanical: GitsVerifyResult,
  semantic: Schema.NullOr(GitsSemanticVerifyResult), // null when the gate failed (semantic skipped)
  criteriaSource: GitsSliceCriteriaSource,
  summary: SummaryString,
  checkedAt: IsoDateTime,
});
export type GitsReviewResult = typeof GitsReviewResult.Type;

export class GitsReviewError extends Schema.TaggedErrorClass<GitsReviewError>()("GitsReviewError", {
  message: TrimmedNonEmptyString,
  cause: Schema.optional(Schema.Defect),
}) {}
