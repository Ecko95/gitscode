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
  type DelamainPeer,
  type PeerStatus,
} from "@t3tools/contracts";

import { writeFileStringAtomically } from "../../atomicWrite.ts";
import { ServerConfig } from "../../config.ts";
import { DelamainAdapter } from "../Services/DelamainAdapter.ts";
import {
  AutomodeSupervisor,
  type AutomodeSupervisorShape,
} from "../Services/AutomodeSupervisor.ts";
import { AutomodeUsageMeter } from "../Services/AutomodeUsageMeter.ts";

interface AutomodeState {
  readonly policy: AutomodePolicy;
  readonly goals: ReadonlyArray<AutomodeGoal>;
  readonly lastEvent: string | null;
  readonly updatedAt: string;
}

const ACTIVE_PEER_STATUSES = new Set<PeerStatus>(["pending", "running", "blocked", "waiting"]);
const INTEGRATION_PATTERN = /\b(merge|admin-merge|integrate|pull request|pr)\b/i;
const DESTRUCTIVE_PATTERN = /\b(reset --hard|rm -rf|delete|destroy|drop|truncate|force push)\b/i;
const AUTOMODE_STATE_FILE_NAME = "automode-state.json";

const PersistedAutomodeState = Schema.Struct({
  version: Schema.Literal(1),
  policy: AutomodePolicySchema,
  goals: Schema.Array(AutomodeGoalSchema),
  lastEvent: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
});
type PersistedAutomodeState = typeof PersistedAutomodeState.Type;

const decodePersistedAutomodeState = Schema.decodeUnknownEffect(
  Schema.fromJsonString(PersistedAutomodeState),
);

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

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
    lastEvent: state.lastEvent,
    updatedAt: state.updatedAt,
  };
}

function fromPersistedAutomodeState(state: PersistedAutomodeState): AutomodeState {
  return {
    policy: state.policy,
    goals: state.goals,
    lastEvent: state.lastEvent,
    updatedAt: state.updatedAt,
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
        onSuccess: (state) => Effect.succeed(fromPersistedAutomodeState(state)),
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
    updatedAt,
  };
}

function activePeerCount(peers: ReadonlyArray<DelamainPeer>): number {
  return peers.filter((peer) => ACTIVE_PEER_STATUSES.has(peer.status)).length;
}

function pendingApprovalCount(goals: ReadonlyArray<AutomodeGoal>): number {
  return goals.filter((goal) => goal.status === "waiting-approval").length;
}

function repoAllowed(policy: AutomodePolicy, repo: string): boolean {
  if (policy.allowedRepos.length === 0) {
    return true;
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

function goalNeedsApproval(policy: AutomodePolicy, goal: AutomodeGoal): boolean {
  if (goal.approvedAt !== null) {
    return false;
  }
  return (
    policy.mode === "supervised" ||
    policy.requireApprovalForPeerSpawn ||
    (policy.requireApprovalBeforeIntegrate && INTEGRATION_PATTERN.test(goal.prompt)) ||
    (policy.requireApprovalBeforeDestructiveAction && DESTRUCTIVE_PATTERN.test(goal.prompt))
  );
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
    updatedAt,
  };
}

export const AutomodeSupervisorLive = Layer.effect(
  AutomodeSupervisor,
  Effect.gen(function* () {
    const delamainAdapter = yield* DelamainAdapter;
    const usageMeter = yield* AutomodeUsageMeter;
    const config = yield* ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const initializedAt = yield* nowIso;
    const statePath = pathService.join(config.stateDir, "gits", AUTOMODE_STATE_FILE_NAME);
    const initialState = yield* loadAutomodeState(statePath, {
      policy: defaultPolicy(initializedAt),
      goals: [],
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

    const scheduleRuntimeLimit = (
      policy: AutomodePolicy,
      goal: AutomodeGoal,
      peer: DelamainPeer,
    ) => {
      if (!shouldScheduleRuntimeLimit(policy)) {
        return Effect.void;
      }

      return Effect.sleep(Duration.minutes(policy.maxRuntimeMinutes)).pipe(
        Effect.flatMap(() => delamainAdapter.killPeer({ peerId: peer.id, signal: "SIGTERM" })),
        Effect.tap(() =>
          Effect.gen(function* () {
            const updatedAt = yield* nowIso;
            yield* commitState((state) =>
              updateGoal(
                {
                  ...state,
                  lastEvent: `Runtime limit reached for ${goal.title}.`,
                  updatedAt,
                },
                goal.id,
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
          }),
        ),
        Effect.ignoreCause({ log: true }),
        Effect.forkDetach,
        Effect.asVoid,
      );
    };

    const supervisor: AutomodeSupervisorShape = {
      getSnapshot,
      updatePolicy: (input) =>
        Effect.gen(function* () {
          const updatedAt = yield* nowIso;
          const nextState = yield* commitState((state) => ({
            ...state,
            policy: applyPolicyUpdate(state.policy, input, updatedAt),
            lastEvent: "Automode policy updated.",
            updatedAt,
          }));
          return yield* snapshotFromState(nextState);
        }),
      enqueueGoal: (input) =>
        Effect.gen(function* () {
          const createdAt = yield* nowIso;
          const goal: AutomodeGoal = {
            id: `goal-${randomUUID()}`,
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
          const budgetReason = budgetBlockedReason(state.policy, budgetUsage);
          const blockedReason = state.policy.killSwitchEnabled
            ? "Kill switch is enabled."
            : state.policy.mode === "manual"
              ? "Automode is in manual mode."
              : activePeers >= state.policy.maxActivePeers
                ? `Active peer limit reached (${state.policy.maxActivePeers}).`
                : !repoAllowed(state.policy, goal.repo)
                  ? "Repository is outside the automode allowlist."
                  : !modelAllowed(state.policy, effectiveModel)
                    ? "Model is outside the automode allowlist."
                    : budgetReason;

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

          const peer = yield* delamainAdapter
            .spawnPeer({
              repo: goal.repo,
              prompt: goal.prompt,
              name: goal.title,
              ...(effectiveModel ? { model: effectiveModel } : {}),
            })
            .pipe(
              Effect.mapError((cause) =>
                toAutomodeError("Automode failed to spawn a Delamain peer.", cause),
              ),
            );
          yield* scheduleRuntimeLimit(state.policy, goal, peer);

          const updatedAt = yield* nowIso;
          const nextState = yield* commitState((current) =>
            updateGoal(
              {
                ...current,
                lastEvent: `Spawned peer ${peer.id} for ${goal.title}.`,
                updatedAt,
              },
              goal.id,
              (existing) => ({
                ...existing,
                status: "running",
                peerId: peer.id,
                blockedReason: null,
                updatedAt,
              }),
            ),
          );
          const nextGoal = findGoal(nextState, goal.id) ?? goal;
          return {
            snapshot: makeSnapshot(nextState, activePeers + 1, budgetUsage),
            goal: nextGoal,
            peer,
            approvalRequired: false,
            blockedReason: null,
          } satisfies AutomodeDispatchResult;
        }),
    };

    return supervisor;
  }),
);
