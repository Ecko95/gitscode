// @effect-diagnostics nodeBuiltinImport:off
import { randomUUID } from "node:crypto";

import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import {
  AutomodeGoal as AutomodeGoalSchema,
  AutomodePolicy as AutomodePolicySchema,
  AutomodeSupervisorError,
  type AutomodeBudgetUsage,
  type AutomodeDispatchResult,
  type AutomodeGoal,
  type AutomodeGoalStatus,
  type AutomodePolicyUpdateInput,
  type AutomodePolicy,
  type AutomodeSnapshot,
  type AutomodeStopAllResult,
  type DelamainPeer,
  type PeerStatus,
  ProviderDriverKind,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import {
  resolveRepositoryProfile,
  resolveRepositoryProviderInstance,
} from "@t3tools/shared/repositoryProfiles";

import { writeFileStringAtomically } from "../../atomicWrite.ts";
import { ServerConfig } from "../../config.ts";
import { ProviderInstanceRegistry } from "../../provider/Services/ProviderInstanceRegistry.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { DelamainAdapter } from "../Services/DelamainAdapter.ts";
import { AUTOMODE_BASE_REF, AutomodeLanding } from "../Services/AutomodeLanding.ts";
import {
  AutomodeSupervisor,
  type AutomodeSupervisorShape,
} from "../Services/AutomodeSupervisor.ts";
import { AutomodeUsageMeter } from "../Services/AutomodeUsageMeter.ts";

interface AutomodeState {
  readonly policy: AutomodePolicy;
  readonly goals: ReadonlyArray<AutomodeGoal>;
  /** goalId → runtime-limit deadline (epoch ms); persisted so a restart re-arms the peer-kill timer. */
  readonly runtimeDeadlines: Readonly<Record<string, number>>;
  readonly driverHalted: boolean;
  readonly driverHaltedReason: string | null;
  readonly heldPrUrl: string | null;
  readonly heldPrNumber: number | null;
  readonly runMerged: boolean;
  readonly lastEvent: string | null;
  readonly updatedAt: string;
}

const ACTIVE_PEER_STATUSES = new Set<PeerStatus>(["pending", "running", "blocked", "waiting"]);
const INTEGRATION_PATTERN = /\b(merge|admin-merge|integrate|pull request|pr)\b/i;
const DESTRUCTIVE_PATTERN = /\b(reset --hard|rm -rf|delete|destroy|drop|truncate|force push)\b/i;
const AUTOMODE_STATE_FILE_NAME = "automode-state.json";
const CODEX_DRIVER = ProviderDriverKind.make("codex");

const PersistedAutomodeState = Schema.Struct({
  version: Schema.Literal(1),
  policy: AutomodePolicySchema,
  goals: Schema.Array(AutomodeGoalSchema),
  runtimeDeadlines: Schema.Record(Schema.String, Schema.Number).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  driverHalted: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  driverHaltedReason: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  heldPrUrl: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  heldPrNumber: Schema.NullOr(Schema.Number).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  runMerged: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  lastEvent: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
});
type PersistedAutomodeState = typeof PersistedAutomodeState.Type;

const decodePersistedAutomodeState = Schema.decodeUnknownEffect(
  Schema.fromJsonString(PersistedAutomodeState),
);

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

// Safe rollout gate (repo env idiom: inline read + default). Unset -> dispatchGoal keeps
// the byte-identical spawnPeer path. Set to delamain's workflows/automode-goal.ts absolute
// path -> goals dispatch as labeled workflow runs.
function resolveGoalWorkflowScript(): string | null {
  const raw = process.env.GITS_AUTOMODE_GOAL_WORKFLOW?.trim();
  return raw !== undefined && raw.length > 0 ? raw : null;
}

// Synthetic peer for a workflow dispatch: the workflow run IS a delamain peer record
// (id = workflow_id), so the dispatch result carries this stand-in until the driver
// re-reads live status. worktree/branch stay null — the WORK lands on the leaf peer.
function workflowRunPeer(
  workflowId: string,
  goal: AutomodeGoal,
  model: string | null,
): DelamainPeer {
  return {
    id: workflowId,
    name: goal.title,
    engine: "unknown",
    model,
    status: "running",
    rawStatus: "running",
    integrationStatus: null,
    sourceRepo: goal.repo,
    worktreePath: null,
    branch: null,
    baseBranch: null,
    mergeBranch: null,
    prUrl: null,
    task: goal.title,
    lastEvent: null,
    startedAt: null,
    updatedAt: null,
    finishedAt: null,
  };
}

function toAutomodeError(message: string, cause?: unknown) {
  return new AutomodeSupervisorError({
    message,
    ...(cause === undefined ? {} : { cause }),
  });
}

function unavailableBudgetUsage(note: string): AutomodeBudgetUsage {
  return {
    source: "unavailable",
    totalCostUsd: null,
    totalProcessedTokens: null,
    updatedAt: null,
    note,
  };
}

function formatBudgetUsd(value: number): string {
  return value.toFixed(2);
}

function toPersistedAutomodeState(state: AutomodeState): PersistedAutomodeState {
  return {
    version: 1,
    policy: state.policy,
    goals: [...state.goals],
    runtimeDeadlines: state.runtimeDeadlines,
    driverHalted: state.driverHalted,
    driverHaltedReason: state.driverHaltedReason,
    heldPrUrl: state.heldPrUrl,
    heldPrNumber: state.heldPrNumber,
    runMerged: state.runMerged,
    lastEvent: state.lastEvent,
    updatedAt: state.updatedAt,
  };
}

function fromPersistedAutomodeState(state: PersistedAutomodeState): AutomodeState {
  return {
    policy: state.policy,
    goals: state.goals,
    runtimeDeadlines: state.runtimeDeadlines,
    driverHalted: state.driverHalted,
    driverHaltedReason: state.driverHaltedReason,
    heldPrUrl: state.heldPrUrl,
    heldPrNumber: state.heldPrNumber,
    runMerged: state.runMerged,
    lastEvent: state.lastEvent,
    updatedAt: state.updatedAt,
  };
}

// Automode must never auto-resume real work on boot: a persisted autonomous +
// killswitch-off policy with approved goals would otherwise dispatch immediately.
// Re-arm the kill switch and require every goal to be re-approved by an operator.
function reArmOnBoot(state: AutomodeState): AutomodeState {
  return {
    ...state,
    policy: { ...state.policy, killSwitchEnabled: true },
    goals: state.goals.map((goal) =>
      goal.approvedAt === null ? goal : { ...goal, approvedAt: null },
    ),
    lastEvent:
      "Automode reloaded with kill switch re-armed and approvals cleared; re-enable and re-approve to run.",
  };
}

function persistAutomodeState(statePath: string, state: AutomodeState) {
  return writeFileStringAtomically({
    filePath: statePath,
    contents: `${JSON.stringify(toPersistedAutomodeState(state), null, 2)}\n`,
  }).pipe(
    Effect.mapError((cause) =>
      toAutomodeError(`Failed to persist automode state at ${statePath}.`, cause),
    ),
  );
}

function loadAutomodeState(statePath: string, fallback: AutomodeState) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs.exists(statePath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return fallback;
    }

    const raw = yield* fs
      .readFileString(statePath)
      .pipe(
        Effect.mapError((cause) =>
          toAutomodeError(`Failed to read automode state at ${statePath}.`, cause),
        ),
      );
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      return fallback;
    }

    return yield* decodePersistedAutomodeState(trimmed).pipe(
      Effect.matchCauseEffect({
        onFailure: (cause) =>
          Effect.logWarning("failed to parse automode state, using locked defaults", {
            path: statePath,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as(fallback)),
        onSuccess: (state) => Effect.succeed(reArmOnBoot(fromPersistedAutomodeState(state))),
      }),
    );
  });
}

function defaultPolicy(updatedAt: string): AutomodePolicy {
  return {
    mode: "manual",
    killSwitchEnabled: true,
    maxActivePeers: 1,
    allowedRepos: [],
    allowedModels: [],
    defaultModel: null,
    maxBudgetUsd: null,
    maxRuntimeMinutes: 60,
    requireApprovalForPeerSpawn: true,
    requireApprovalBeforeIntegrate: true,
    requireApprovalBeforeDestructiveAction: true,
    autoEnqueueApprovedProposals: false,
    nightlyProposalSweep: false,
    proposalRepos: [],
    verificationCommands: [],
    integrationBranch: null,
    motokoAuthority: "observe",
    telegramDigestEnabled: true,
    sweepRequiresConfirmation: true,
    updatedAt,
  };
}

function activePeerCount(peers: ReadonlyArray<DelamainPeer>): number {
  return peers.filter((peer) => ACTIVE_PEER_STATUSES.has(peer.status)).length;
}

function pendingApprovalCount(goals: ReadonlyArray<AutomodeGoal>): number {
  return goals.filter((goal) => goal.status === "waiting-approval").length;
}

export function repoAllowed(policy: AutomodePolicy, repo: string): boolean {
  // ponytail: empty allowlist = deny-all (explicit opt-in), not allow-all.
  if (policy.allowedRepos.length === 0) {
    return false;
  }

  return policy.allowedRepos.some((allowedRepo) => {
    const normalizedAllowed = allowedRepo.endsWith("/") ? allowedRepo : `${allowedRepo}/`;
    return repo === allowedRepo || repo.startsWith(normalizedAllowed);
  });
}

function modelAllowed(policy: AutomodePolicy, model: string | null): boolean {
  if (policy.allowedModels.length === 0) {
    return true;
  }
  return model !== null && policy.allowedModels.includes(model);
}

function promptNeedsApproval(policy: AutomodePolicy, prompt: string): boolean {
  return (
    policy.mode === "supervised" ||
    policy.requireApprovalForPeerSpawn ||
    (policy.requireApprovalBeforeIntegrate && INTEGRATION_PATTERN.test(prompt)) ||
    (policy.requireApprovalBeforeDestructiveAction && DESTRUCTIVE_PATTERN.test(prompt))
  );
}

function goalNeedsApproval(policy: AutomodePolicy, goal: AutomodeGoal): boolean {
  if (goal.approvedAt !== null) {
    return false;
  }
  // Sweep-drafted goals gate on sweepRequiresConfirmation alone, independent of
  // requireApprovalForPeerSpawn — otherwise an operator who disables per-peer-spawn
  // approval also (unintentionally) waives the owner's sweep confirmation contract.
  if (goal.origin === "sweep" && policy.sweepRequiresConfirmation) {
    return true;
  }
  return promptNeedsApproval(policy, goal.prompt);
}

type PolicyGateKind = "dispatch" | "send";

// The ONE automode gate. dispatchGoal and the gated peer-message send both call
// this — do not add a third ungated path. `kind` only gates the active-peer-limit
// check, which applies to spawns (dispatch) but not to sends.
function evaluatePolicyGate(
  policy: AutomodePolicy,
  args: {
    readonly repo: string;
    readonly model: string | null;
    readonly prompt: string;
    readonly kind: PolicyGateKind;
    readonly activePeers: number;
    readonly budgetUsage: AutomodeBudgetUsage;
  },
): { readonly blockedReason: string | null; readonly needsApproval: boolean } {
  // ponytail: a peer message is not a repo/model/cost operation, so the send gate
  // enforces only kill-switch, manual-mode, and destructive-content approval — not the
  // repo allowlist / model allowlist / budget (which govern where peers *operate*).
  // Without this, gits' empty-allowlist=deny (#139) would block every repo-less send.
  const resourceScoped = args.kind !== "send";
  const budgetReason = resourceScoped ? budgetBlockedReason(policy, args.budgetUsage) : null;
  const blockedReason = policy.killSwitchEnabled
    ? "Kill switch is enabled."
    : policy.mode === "manual"
      ? "Automode is in manual mode."
      : args.kind === "dispatch" && args.activePeers >= policy.maxActivePeers
        ? `Active peer limit reached (${policy.maxActivePeers}).`
        : resourceScoped && !repoAllowed(policy, args.repo)
          ? "Repository is outside the automode allowlist."
          : resourceScoped && !modelAllowed(policy, args.model)
            ? "Model is outside the automode allowlist."
            : budgetReason;
  return { blockedReason, needsApproval: promptNeedsApproval(policy, args.prompt) };
}

function updateGoal(
  state: AutomodeState,
  goalId: string,
  updater: (goal: AutomodeGoal) => AutomodeGoal,
): AutomodeState {
  return {
    ...state,
    goals: state.goals.map((goal) => (goal.id === goalId ? updater(goal) : goal)),
  };
}

function dropDeadline(state: AutomodeState, goalId: string): AutomodeState {
  if (!(goalId in state.runtimeDeadlines)) {
    return state;
  }
  const { [goalId]: _dropped, ...runtimeDeadlines } = state.runtimeDeadlines;
  return { ...state, runtimeDeadlines };
}

function findGoal(state: AutomodeState, goalId: string): AutomodeGoal | null {
  return state.goals.find((goal) => goal.id === goalId) ?? null;
}

function sortGoals(goals: ReadonlyArray<AutomodeGoal>): AutomodeGoal[] {
  return [...goals].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function shouldScheduleRuntimeLimit(policy: AutomodePolicy): policy is AutomodePolicy & {
  readonly maxRuntimeMinutes: number;
} {
  return policy.maxRuntimeMinutes !== null && policy.maxRuntimeMinutes > 0;
}

function budgetBlockedReason(
  policy: AutomodePolicy,
  budgetUsage: AutomodeBudgetUsage,
): string | null {
  if (policy.maxBudgetUsd === null) {
    return null;
  }
  if (budgetUsage.totalCostUsd === null) {
    return "Budget limit is set but provider cost telemetry is unavailable.";
  }
  if (budgetUsage.totalCostUsd >= policy.maxBudgetUsd) {
    return `Budget limit reached ($${formatBudgetUsd(budgetUsage.totalCostUsd)} / $${formatBudgetUsd(
      policy.maxBudgetUsd,
    )}).`;
  }
  return null;
}

function makeSnapshot(
  state: AutomodeState,
  activePeers: number,
  budgetUsage: AutomodeBudgetUsage,
): AutomodeSnapshot {
  return {
    policy: state.policy,
    budgetUsage,
    goals: sortGoals(state.goals),
    activePeerCount: activePeers,
    pendingApprovalCount: pendingApprovalCount(state.goals),
    driverHalted: state.driverHalted,
    driverHaltedReason: state.driverHaltedReason,
    heldPrUrl: state.heldPrUrl,
    heldPrNumber: state.heldPrNumber,
    runMerged: state.runMerged,
    lastEvent: state.lastEvent,
    updatedAt: state.updatedAt,
  };
}

function applyPolicyUpdate(
  policy: AutomodePolicy,
  input: AutomodePolicyUpdateInput,
  updatedAt: string,
): AutomodePolicy {
  return {
    mode: input.mode ?? policy.mode,
    killSwitchEnabled: input.killSwitchEnabled ?? policy.killSwitchEnabled,
    maxActivePeers: input.maxActivePeers ?? policy.maxActivePeers,
    allowedRepos: input.allowedRepos ?? policy.allowedRepos,
    allowedModels: input.allowedModels ?? policy.allowedModels,
    defaultModel: input.defaultModel === undefined ? policy.defaultModel : input.defaultModel,
    maxBudgetUsd: input.maxBudgetUsd === undefined ? policy.maxBudgetUsd : input.maxBudgetUsd,
    maxRuntimeMinutes:
      input.maxRuntimeMinutes === undefined ? policy.maxRuntimeMinutes : input.maxRuntimeMinutes,
    requireApprovalForPeerSpawn:
      input.requireApprovalForPeerSpawn ?? policy.requireApprovalForPeerSpawn,
    requireApprovalBeforeIntegrate:
      input.requireApprovalBeforeIntegrate ?? policy.requireApprovalBeforeIntegrate,
    requireApprovalBeforeDestructiveAction:
      input.requireApprovalBeforeDestructiveAction ?? policy.requireApprovalBeforeDestructiveAction,
    autoEnqueueApprovedProposals:
      input.autoEnqueueApprovedProposals ?? policy.autoEnqueueApprovedProposals,
    nightlyProposalSweep: input.nightlyProposalSweep ?? policy.nightlyProposalSweep,
    proposalRepos: input.proposalRepos ?? policy.proposalRepos,
    verificationCommands: input.verificationCommands ?? policy.verificationCommands,
    integrationBranch:
      input.integrationBranch === undefined ? policy.integrationBranch : input.integrationBranch,
    motokoAuthority: input.motokoAuthority ?? policy.motokoAuthority,
    telegramDigestEnabled: input.telegramDigestEnabled ?? policy.telegramDigestEnabled,
    sweepRequiresConfirmation: input.sweepRequiresConfirmation ?? policy.sweepRequiresConfirmation,
    updatedAt,
  };
}

export const AutomodeSupervisorLive = Layer.effect(
  AutomodeSupervisor,
  Effect.gen(function* () {
    const delamainAdapter = yield* DelamainAdapter;
    const landing = yield* AutomodeLanding;
    const usageMeter = yield* AutomodeUsageMeter;
    const config = yield* ServerConfig;
    const serverSettings = yield* ServerSettingsService;
    const providerInstances = yield* ProviderInstanceRegistry;
    const fs = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const initializedAt = yield* nowIso;
    const statePath = pathService.join(config.stateDir, "gits", AUTOMODE_STATE_FILE_NAME);
    const initialState = yield* loadAutomodeState(statePath, {
      policy: defaultPolicy(initializedAt),
      goals: [],
      runtimeDeadlines: {},
      driverHalted: false,
      driverHaltedReason: null,
      heldPrUrl: null,
      heldPrNumber: null,
      runMerged: false,
      lastEvent: "Automode initialized with kill switch enabled.",
      updatedAt: initializedAt,
    });
    const stateRef = yield* Ref.make<AutomodeState>(initialState);
    const writeSemaphore = yield* Semaphore.make(1);

    const readActivePeerCount = delamainAdapter.listPeers().pipe(
      Effect.map((result) => activePeerCount(result.peers)),
      Effect.catch(() => Effect.succeed(0)),
    );

    const readBudgetUsage = usageMeter
      .readBudgetUsage()
      .pipe(Effect.catch((error) => Effect.succeed(unavailableBudgetUsage(error.message))));

    const snapshotFromState = (state: AutomodeState) =>
      Effect.all([readActivePeerCount, readBudgetUsage]).pipe(
        Effect.map(([count, budgetUsage]) => makeSnapshot(state, count, budgetUsage)),
      );

    const getSnapshot = () => Ref.get(stateRef).pipe(Effect.flatMap(snapshotFromState));

    // Cheap policy read (stateRef only) so the driver can gate on mode/kill-switch
    // without paying for the peer-list + budget IO that getSnapshot performs.
    const getPolicy = () => Ref.get(stateRef).pipe(Effect.map((state) => state.policy));

    const resolveWorkerRoute = (repo: string) =>
      Effect.gen(function* () {
        const settings = yield* serverSettings.getSettings.pipe(
          Effect.mapError((cause) =>
            toAutomodeError("Failed to resolve Automode repository worker routing.", cause),
          ),
        );
        const repositoryProfile = resolveRepositoryProfile({
          workspaceRoot: repo,
          profiles: settings.repositoryProfiles,
        });
        const providerInstanceId = resolveRepositoryProviderInstance({
          repositoryProfile,
          driver: CODEX_DRIVER,
          profiles: settings.repositoryProfiles,
        });
        if (providerInstanceId === null) {
          return {
            providerInstanceId: null,
            blockedReason: `${repositoryProfile === "work" ? "Work" : "Personal"} repository has no Codex provider instance mapping.`,
          };
        }
        const instance = yield* providerInstances.getInstance(providerInstanceId);
        if (
          !instance ||
          !instance.enabled ||
          instance.driverKind !== CODEX_DRIVER ||
          instance.workerEnvironment === undefined
        ) {
          return {
            providerInstanceId: null,
            blockedReason: `Mapped Codex provider instance '${providerInstanceId}' is unavailable.`,
          };
        }
        return {
          providerInstanceId,
          blockedReason: null,
        } satisfies {
          readonly providerInstanceId: ProviderInstanceId;
          readonly blockedReason: null;
        };
      });

    const commitState = (updater: (state: AutomodeState) => AutomodeState) =>
      writeSemaphore.withPermits(1)(
        Effect.gen(function* () {
          const nextState = updater(yield* Ref.get(stateRef));
          yield* persistAutomodeState(statePath, nextState).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, pathService),
          );
          yield* Ref.set(stateRef, nextState);
          return nextState;
        }),
      );

    // Same critical section as commitState, but the updater computes nextState and
    // validates it before anything is written — used where invariants must be checked
    // against the FINAL state atomically (no unlocked pre-read) yet still fail
    // recoverably (a typed error, not a thrown defect) when invalid.
    const commitStateOrFail = (
      updater: (state: AutomodeState) => Effect.Effect<AutomodeState, AutomodeSupervisorError>,
    ) =>
      writeSemaphore.withPermits(1)(
        Effect.gen(function* () {
          const nextState = yield* updater(yield* Ref.get(stateRef));
          yield* persistAutomodeState(statePath, nextState).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, pathService),
          );
          yield* Ref.set(stateRef, nextState);
          return nextState;
        }),
      );

    // Sleeps until the persisted deadline, then kills the peer and blocks the goal.
    // Deadline-based (not duration-based) so a restart can re-arm with the remaining time.
    const enforceRuntimeLimit = (
      goalId: string,
      goalTitle: string,
      peerId: string,
      deadlineEpochMs: number,
    ) =>
      Effect.gen(function* () {
        const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
        yield* Effect.sleep(Duration.millis(Math.max(0, deadlineEpochMs - nowMs)));
        // Re-read state after the sleep: the goal may have completed/failed (deadline
        // dropped) or been re-dispatched to a NEW peer under a NEW deadline while this
        // fiber slept — killing then would SIGTERM the wrong (or a finished) peer.
        // Deadline equality distinguishes this timer from a re-dispatch's timer.
        const current = yield* Ref.get(stateRef);
        const currentGoal = findGoal(current, goalId);
        if (
          currentGoal === null ||
          currentGoal.status !== "running" ||
          currentGoal.peerId !== peerId ||
          current.runtimeDeadlines[goalId] !== deadlineEpochMs
        ) {
          return;
        }
        // Workflow-dispatched goals track the workflow run's id as peerId; kill the whole
        // run (runner + live leaves), not the run record as if it were a leaf peer.
        if (currentGoal.workflowId !== null) {
          yield* delamainAdapter.workflowKill({ workflowId: currentGoal.workflowId });
        } else {
          yield* delamainAdapter.killPeer({ peerId, signal: "SIGTERM" });
        }
        const updatedAt = yield* nowIso;
        yield* commitState((state) =>
          updateGoal(
            {
              ...dropDeadline(state, goalId),
              lastEvent: `Runtime limit reached for ${goalTitle}.`,
              updatedAt,
            },
            goalId,
            (existing) =>
              existing.status === "running"
                ? {
                    ...existing,
                    status: "blocked",
                    blockedReason: "Runtime limit reached and peer was terminated.",
                    updatedAt,
                  }
                : existing,
          ),
        );
      }).pipe(Effect.ignoreCause({ log: true }));

    // Re-arm runtime-limit timers for goals that were running when the server stopped:
    // the old timer was an in-memory fiber, so without this a restart orphans the peer.
    const bootMs = DateTime.toEpochMillis(yield* DateTime.now);
    for (const goal of initialState.goals) {
      const deadline = initialState.runtimeDeadlines[goal.id];
      if (goal.status !== "running" || goal.peerId === null || deadline === undefined) {
        continue;
      }
      const enforce = enforceRuntimeLimit(goal.id, goal.title, goal.peerId, deadline);
      if (deadline <= bootMs) {
        yield* enforce;
      } else {
        yield* enforce.pipe(Effect.forkDetach, Effect.asVoid);
      }
    }

    const supervisor: AutomodeSupervisorShape = {
      getSnapshot,
      getPolicy,
      updatePolicy: (input) =>
        Effect.gen(function* () {
          const updatedAt = yield* nowIso;
          const nextState = yield* commitStateOrFail((state) =>
            Effect.gen(function* () {
              const nextPolicy = applyPolicyUpdate(state.policy, input, updatedAt);
              // Codex peers produce no cost telemetry, so a dollar budget is unenforceable
              // on an all-codex box; the runtime cap is the enforceable V1 envelope
              // (docs/brainstorms/off-hours-autonomy.md, decision 11 + accepted gaps).
              if (
                nextPolicy.mode === "autonomous" &&
                nextPolicy.maxBudgetUsd === null &&
                !shouldScheduleRuntimeLimit(nextPolicy)
              ) {
                return yield* toAutomodeError(
                  "Autonomous mode requires a resource cap — set a max budget (maxBudgetUsd) or a runtime cap (maxRuntimeMinutes).",
                );
              }
              if (nextPolicy.mode === "autonomous" && nextPolicy.allowedRepos.length === 0) {
                return yield* toAutomodeError(
                  "Autonomous mode requires a non-empty repo allowlist (allowedRepos) — an empty list allows no repos.",
                );
              }
              return {
                ...state,
                policy: nextPolicy,
                lastEvent: "Automode policy updated.",
                updatedAt,
              };
            }),
          );
          return yield* snapshotFromState(nextState);
        }),
      enqueueGoal: (input) =>
        Effect.gen(function* () {
          const createdAt = yield* nowIso;
          const goal: AutomodeGoal = {
            id: `goal-${randomUUID()}`,
            // Episode thread (decision 23): carried from the proposal when present.
            episodeId: input.episodeId ?? `epi-${randomUUID()}`,
            origin: input.origin ?? "manual",
            title: input.title,
            prompt: input.prompt,
            repo: input.repo,
            model: input.model ?? null,
            status: "queued",
            peerId: null,
            blockedReason: null,
            createdAt,
            updatedAt: createdAt,
            approvedAt: null,
            rejectedAt: null,
            workflowId: null,
            branch: null,
          };
          const nextState = yield* commitState((state) => ({
            ...state,
            goals: [goal, ...state.goals],
            lastEvent: `Queued ${input.title}.`,
            updatedAt: createdAt,
          }));
          return yield* snapshotFromState(nextState);
        }),
      approveGoal: (input) =>
        Effect.gen(function* () {
          const approvedAt = yield* nowIso;
          const nextState = yield* commitState((state) => {
            const goal = findGoal(state, input.goalId);
            if (goal === null) {
              return state;
            }
            return updateGoal(
              {
                ...state,
                lastEvent: `Approved ${goal.title}.`,
                updatedAt: approvedAt,
              },
              input.goalId,
              (existing) => ({
                ...existing,
                status:
                  existing.status === "waiting-approval" || existing.status === "blocked"
                    ? "queued"
                    : existing.status,
                blockedReason: null,
                approvedAt,
                rejectedAt: null,
                updatedAt: approvedAt,
              }),
            );
          });
          const goal = findGoal(nextState, input.goalId);
          if (goal === null) {
            return yield* toAutomodeError(`Automode goal ${input.goalId} was not found.`);
          }
          return goal;
        }),
      rejectGoal: (input) =>
        Effect.gen(function* () {
          const rejectedAt = yield* nowIso;
          const reason = input.reason ?? "Rejected by operator.";
          const nextState = yield* commitState((state) => {
            const goal = findGoal(state, input.goalId);
            if (goal === null) {
              return state;
            }
            return updateGoal(
              {
                ...state,
                lastEvent: `Rejected ${goal.title}.`,
                updatedAt: rejectedAt,
              },
              input.goalId,
              (existing) => ({
                ...existing,
                status: "rejected",
                blockedReason: reason,
                rejectedAt,
                updatedAt: rejectedAt,
              }),
            );
          });
          const goal = findGoal(nextState, input.goalId);
          if (goal === null) {
            return yield* toAutomodeError(`Automode goal ${input.goalId} was not found.`);
          }
          return goal;
        }),
      dispatchGoal: (input) =>
        Effect.gen(function* () {
          const state = yield* Ref.get(stateRef);
          const goal = findGoal(state, input.goalId);
          if (goal === null) {
            return yield* toAutomodeError(`Automode goal ${input.goalId} was not found.`);
          }

          const effectiveModel = goal.model ?? state.policy.defaultModel;
          const activePeers = yield* readActivePeerCount;
          const budgetUsage = yield* readBudgetUsage;
          const policyBlockedReason = evaluatePolicyGate(state.policy, {
            repo: goal.repo,
            model: effectiveModel,
            prompt: goal.prompt,
            kind: "dispatch",
            activePeers,
            budgetUsage,
          }).blockedReason;
          const workerRoute = yield* resolveWorkerRoute(goal.repo);
          const blockedReason = policyBlockedReason ?? workerRoute.blockedReason;

          if (blockedReason !== null) {
            const updatedAt = yield* nowIso;
            const nextState = yield* commitState((current) =>
              updateGoal(
                {
                  ...current,
                  lastEvent: blockedReason,
                  updatedAt,
                },
                goal.id,
                (existing) => ({
                  ...existing,
                  status: "blocked" satisfies AutomodeGoalStatus,
                  blockedReason,
                  updatedAt,
                }),
              ),
            );
            const nextGoal = findGoal(nextState, goal.id) ?? goal;
            return {
              snapshot: makeSnapshot(nextState, activePeers, budgetUsage),
              goal: nextGoal,
              peer: null,
              approvalRequired: false,
              blockedReason,
            } satisfies AutomodeDispatchResult;
          }

          if (goalNeedsApproval(state.policy, goal)) {
            const updatedAt = yield* nowIso;
            const reason = "Manual approval required before automode dispatch.";
            const nextState = yield* commitState((current) =>
              updateGoal(
                {
                  ...current,
                  lastEvent: reason,
                  updatedAt,
                },
                goal.id,
                (existing) => ({
                  ...existing,
                  status: "waiting-approval",
                  blockedReason: reason,
                  updatedAt,
                }),
              ),
            );
            const nextGoal = findGoal(nextState, goal.id) ?? goal;
            return {
              snapshot: makeSnapshot(nextState, activePeers, budgetUsage),
              goal: nextGoal,
              peer: null,
              approvalRequired: true,
              blockedReason: reason,
            } satisfies AutomodeDispatchResult;
          }

          const providerInstanceId = workerRoute.providerInstanceId;
          if (providerInstanceId === null) {
            return yield* toAutomodeError("Automode worker route was not resolved.");
          }

          // The peer spawns from (startRef) and syncs against (mergeBranch) the goal's
          // branch, so it must exist on origin before delamain touches it — first dispatch
          // against a fresh branch would otherwise fail at spawn/integration. Same baseRef
          // the driver lands with. Without a shared integration branch each goal gets its
          // own branch off the base ref — the full goal id, so two goals can never collide
          // into one branch, and deterministic, so a re-approved goal resumes its branch.
          // Never spawn unpinned: delamain's default would merge peer work straight into
          // the origin default branch.
          const goalBranch = state.policy.integrationBranch ?? `automode/${goal.id}`;
          yield* landing.ensure_integration_branch({
            repo: goal.repo,
            integrationBranch: goalBranch,
            baseRef: AUTOMODE_BASE_REF,
          });

          // Episode threading v1: traceability via the prompt (delamain untouched).
          const episodePrompt = `Episode: ${goal.episodeId}\n${goal.prompt}`;
          const workflowScript = resolveGoalWorkflowScript();
          const { peer, workflowId } = yield* workflowScript === null
            ? delamainAdapter
                .spawnPeer({
                  repo: goal.repo,
                  prompt: episodePrompt,
                  engine: "codex",
                  providerInstanceId,
                  name: goal.title,
                  ...(effectiveModel ? { model: effectiveModel } : {}),
                  startRef: goalBranch,
                  // delamain treats mergeBranch as the SYNC BASE (fetch + merge
                  // origin/<ref> into the peer branch before pushing the peer branch) —
                  // it never creates the ref, so it must be the branch landing
                  // fast-forwards.
                  mergeBranch: goalBranch,
                  confine: true,
                  yolo: true,
                  egress: "host",
                })
                .pipe(
                  Effect.mapError((cause) =>
                    toAutomodeError("Automode failed to spawn a Delamain peer.", cause),
                  ),
                  Effect.map((spawned) => ({ peer: spawned, workflowId: null as string | null })),
                )
            : delamainAdapter
                .runGoalWorkflow({
                  workflowScript,
                  repo: goal.repo,
                  engine: "codex",
                  providerInstanceId,
                  name: `Motoko Proposal - Verified (Automated) · ${goal.title}`,
                  // Same branch rails as the spawn path: startRef == mergeBranch ==
                  // the goal's branch. The leaf runs integrate:true.
                  // @effect-diagnostics-next-line preferSchemaOverJson:off
                  argsJson: JSON.stringify({
                    title: goal.title,
                    prompt: episodePrompt,
                    startRef: goalBranch,
                    mergeBranch: goalBranch,
                    model: effectiveModel ?? null,
                  }),
                })
                .pipe(
                  Effect.mapError((cause) =>
                    toAutomodeError("Automode failed to dispatch a Delamain workflow.", cause),
                  ),
                  Effect.map((result) => ({
                    peer: workflowRunPeer(result.workflowId, goal, effectiveModel),
                    workflowId: result.workflowId as string | null,
                  })),
                );
          const deadlineEpochMs = shouldScheduleRuntimeLimit(state.policy)
            ? DateTime.toEpochMillis(yield* DateTime.now) + state.policy.maxRuntimeMinutes * 60_000
            : null;

          const updatedAt = yield* nowIso;
          const nextState = yield* commitState((current) =>
            updateGoal(
              {
                ...current,
                runtimeDeadlines:
                  deadlineEpochMs === null
                    ? current.runtimeDeadlines
                    : { ...current.runtimeDeadlines, [goal.id]: deadlineEpochMs },
                lastEvent:
                  workflowId === null
                    ? `Spawned peer ${peer.id} for ${goal.title}.`
                    : `Dispatched workflow ${workflowId} for ${goal.title}.`,
                updatedAt,
              },
              goal.id,
              (existing) => ({
                ...existing,
                status: "running",
                peerId: peer.id,
                workflowId,
                branch: goalBranch,
                blockedReason: null,
                updatedAt,
              }),
            ),
          );
          if (deadlineEpochMs !== null) {
            yield* enforceRuntimeLimit(goal.id, goal.title, peer.id, deadlineEpochMs).pipe(
              Effect.forkDetach,
              Effect.asVoid,
            );
          }
          const nextGoal = findGoal(nextState, goal.id) ?? goal;
          return {
            snapshot: makeSnapshot(nextState, activePeers + 1, budgetUsage),
            goal: nextGoal,
            peer,
            approvalRequired: false,
            blockedReason: null,
          } satisfies AutomodeDispatchResult;
        }),
      completeGoal: (input) =>
        Effect.gen(function* () {
          const completedAt = yield* nowIso;
          const nextState = yield* commitState((state) => {
            const goal = findGoal(state, input.goalId);
            if (goal === null) {
              return state;
            }
            return updateGoal(
              {
                ...dropDeadline(state, input.goalId),
                lastEvent: `Completed ${goal.title}.`,
                updatedAt: completedAt,
              },
              input.goalId,
              (existing) => ({
                ...existing,
                status: "completed",
                blockedReason: null,
                updatedAt: completedAt,
              }),
            );
          });
          const goal = findGoal(nextState, input.goalId);
          if (goal === null) {
            return yield* toAutomodeError(`Automode goal ${input.goalId} was not found.`);
          }
          return goal;
        }),
      failGoal: (input) =>
        Effect.gen(function* () {
          const failedAt = yield* nowIso;
          const reason = input.reason ?? "Peer ended in a failure state.";
          const nextState = yield* commitState((state) => {
            const goal = findGoal(state, input.goalId);
            if (goal === null) {
              return state;
            }
            return updateGoal(
              {
                ...dropDeadline(state, input.goalId),
                lastEvent: `Failed ${goal.title}.`,
                updatedAt: failedAt,
              },
              input.goalId,
              (existing) => ({
                ...existing,
                status: "failed",
                blockedReason: reason,
                updatedAt: failedAt,
              }),
            );
          });
          const goal = findGoal(nextState, input.goalId);
          if (goal === null) {
            return yield* toAutomodeError(`Automode goal ${input.goalId} was not found.`);
          }
          return goal;
        }),
      // ponytail: promoted verbatim from HermesTelegramCommand.ts `case "stop"` — same
      // kill-switch-first + best-effort peer/workflow kill loop, now callable from ws.ts too.
      // Self-referencing supervisor.updatePolicy/getSnapshot (closure) instead of duplicating
      // their logic. Goal status is left untouched, matching STOP's existing behavior exactly.
      stopAll: () =>
        Effect.gen(function* () {
          yield* supervisor.updatePolicy({ killSwitchEnabled: true });
          const snapshot = yield* supervisor.getSnapshot();
          let stoppedPeers = 0;
          let failures = 0;

          for (const goal of snapshot.goals) {
            const status: string = goal.status;
            if (goal.peerId === null || (status !== "running" && status !== "pending")) continue;
            const ok = yield* (
              goal.workflowId
                ? delamainAdapter
                    .workflowKill({ workflowId: goal.workflowId })
                    .pipe(Effect.as(true))
                : delamainAdapter.killPeer({ peerId: goal.peerId }).pipe(Effect.as(true))
            ).pipe(Effect.orElseSucceed(() => false));
            if (ok) {
              stoppedPeers += 1;
            } else {
              failures += 1;
            }
          }

          return { stoppedPeers, failures } satisfies AutomodeStopAllResult;
        }),
      killGoal: (input) =>
        Effect.gen(function* () {
          const state = yield* Ref.get(stateRef);
          const goal = findGoal(state, input.goalId);
          if (goal === null) {
            return yield* toAutomodeError(`Automode goal ${input.goalId} was not found.`);
          }

          if (goal.peerId !== null) {
            // ponytail: kill failure is swallowed (peer may already be dead) — the goal is
            // still marked failed below, mirroring stopAll's per-goal tolerance.
            yield* (
              goal.workflowId
                ? delamainAdapter.workflowKill({ workflowId: goal.workflowId }).pipe(Effect.asVoid)
                : delamainAdapter.killPeer({ peerId: goal.peerId }).pipe(Effect.asVoid)
            ).pipe(Effect.orElseSucceed(() => undefined));
          }

          return yield* supervisor.failGoal({
            goalId: input.goalId,
            reason: "Killed from cockpit.",
          });
        }),
      haltDriver: (input) =>
        Effect.gen(function* () {
          const updatedAt = yield* nowIso;
          const nextState = yield* commitState((state) => ({
            ...state,
            driverHalted: true,
            driverHaltedReason: input.reason,
            lastEvent: input.reason,
            updatedAt,
          }));
          return yield* snapshotFromState(nextState);
        }),
      resumeDriver: () =>
        Effect.gen(function* () {
          const updatedAt = yield* nowIso;
          const nextState = yield* commitState((state) => ({
            ...state,
            driverHalted: false,
            driverHaltedReason: null,
            lastEvent: "Driver resumed by operator.",
            updatedAt,
          }));
          return yield* snapshotFromState(nextState);
        }),
      recordHeldPr: (input) =>
        Effect.gen(function* () {
          const updatedAt = yield* nowIso;
          const reason = `Opened held PR #${input.number} → gits.`;
          const nextState = yield* commitState((state) => ({
            ...state,
            heldPrUrl: input.url,
            heldPrNumber: input.number,
            lastEvent: reason,
            updatedAt,
          }));
          return yield* snapshotFromState(nextState);
        }),
      markRunMerged: () =>
        Effect.gen(function* () {
          const updatedAt = yield* nowIso;
          const nextState = yield* commitState((state) => ({
            ...state,
            runMerged: true,
            lastEvent: "Run complete: held PR merged to gits.",
            updatedAt,
          }));
          return yield* snapshotFromState(nextState);
        }),
      sendPeerMessage: (input) =>
        Effect.gen(function* () {
          const state = yield* Ref.get(stateRef);
          const authority = state.policy.motokoAuthority;
          const isReply = input.responseId !== undefined && input.responseId !== null;

          // (a) motokoAuthority tier: observe blocks all sends; respond allows
          // only replies (a send carrying a responseId); dispatch allows new sends.
          const tierBlockedReason =
            authority === "observe"
              ? "Motoko authority is observe-only; peer messaging is disabled."
              : authority === "respond" && !isReply
                ? "Motoko authority allows replies only; new sends require dispatch authority."
                : null;
          if (tierBlockedReason !== null) {
            return yield* toAutomodeError(tierBlockedReason);
          }

          // (b) shared automode gate: kill switch / mode / repo allowlist / model /
          // budget, plus integrate/merge/destructive content stays human-gated.
          const activePeers = yield* readActivePeerCount;
          const budgetUsage = yield* readBudgetUsage;
          const gate = evaluatePolicyGate(state.policy, {
            repo: input.repo ?? "",
            model: input.model ?? null,
            prompt: input.message,
            kind: "send",
            activePeers,
            budgetUsage,
          });
          if (gate.blockedReason !== null) {
            return yield* toAutomodeError(gate.blockedReason);
          }
          if (gate.needsApproval) {
            return yield* toAutomodeError(
              "Manual approval required before Motoko can send this message.",
            );
          }

          // R#3: default the sender so the delamain CLI doesn't fall back to cwd-inference
          // (which never matches the GITS server). ponytail: constant sender id (config later);
          // documented residual — replies addressed back to "motoko" won't deliver through
          // delamain since Motoko is not a delamain peer (reply-routing is future work).
          return yield* delamainAdapter
            .sendMessage({ ...input, fromPeerId: input.fromPeerId ?? "motoko" })
            .pipe(
              Effect.mapError((cause) =>
                toAutomodeError("Failed to send a Delamain peer message.", cause),
              ),
            );
        }),
    };

    return supervisor;
  }),
);
