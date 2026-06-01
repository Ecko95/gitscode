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

export const AutomodeDispatchResult = Schema.Struct({
  snapshot: AutomodeSnapshot,
  goal: AutomodeGoal,
  peer: Schema.NullOr(DelamainPeer),
  approvalRequired: Schema.Boolean,
  blockedReason: Schema.NullOr(SummaryString),
});
export type AutomodeDispatchResult = typeof AutomodeDispatchResult.Type;

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
