import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import {
  DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL,
  type AuthAccessStreamEvent,
  AuthSessionId,
  CommandId,
  EventId,
  type OrchestrationCommand,
  type GitActionProgressEvent,
  type GitManagerServiceError,
  OrchestrationDispatchCommandError,
  type OrchestrationEvent,
  type OrchestrationShellStreamEvent,
  type OrchestrationThread,
  OrchestrationGetFullThreadDiffError,
  OrchestrationGetSnapshotError,
  OrchestrationGetTurnDiffError,
  ORCHESTRATION_WS_METHODS,
  ProjectSearchEntriesError,
  ProjectWriteFileError,
  OrchestrationReplayEventsError,
  FilesystemBrowseError,
  AutomodeSupervisorError,
  CritError,
  DelamainAdapterError,
  GitsCapacityError,
  GitsCockpitError,
  GitsDevCommandError,
  HermesAdapterError,
  OpenGsdAdapterError,
  ThreadId,
  type TerminalAttachStreamEvent,
  type TerminalError,
  type TerminalEvent,
  type TerminalMetadataStreamEvent,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import { clamp } from "effect/Number";
import { HttpRouter, HttpServerRequest } from "effect/unstable/http";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";

import { CheckpointDiffQuery } from "./checkpointing/Services/CheckpointDiffQuery.ts";
import { ServerConfig } from "./config.ts";
import { Keybindings } from "./keybindings.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import { normalizeDispatchCommand } from "./orchestration/Normalizer.ts";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  observeRpcEffect,
  observeRpcStream,
  observeRpcStreamEffect,
} from "./observability/RpcInstrumentation.ts";
import { ProviderRegistry } from "./provider/Services/ProviderRegistry.ts";
import * as ProviderMaintenanceRunner from "./provider/providerMaintenanceRunner.ts";
import { ServerLifecycleEvents } from "./serverLifecycleEvents.ts";
import { ServerRuntimeStartup } from "./serverRuntimeStartup.ts";
import { redactServerSettingsForClient, ServerSettingsService } from "./serverSettings.ts";
import { VoiceTranscriptionService } from "./voice/Services/VoiceTranscription.ts";
import { TerminalManager } from "./terminal/Services/Manager.ts";
import { WorkspaceEntries } from "./workspace/Services/WorkspaceEntries.ts";
import { WorkspaceFileSystem } from "./workspace/Services/WorkspaceFileSystem.ts";
import { WorkspacePathOutsideRootError } from "./workspace/Services/WorkspacePaths.ts";
import { VcsStatusBroadcaster } from "./vcs/VcsStatusBroadcaster.ts";
import { VcsProvisioningService } from "./vcs/VcsProvisioningService.ts";
import { GitWorkflowService } from "./git/GitWorkflowService.ts";
import { ReviewService } from "./review/ReviewService.ts";
import { ProjectSetupScriptRunner } from "./project/Services/ProjectSetupScriptRunner.ts";
import { RepositoryIdentityResolver } from "./project/Services/RepositoryIdentityResolver.ts";
import { GitsDevCommands } from "./gits/Services/GitsDevCommands.ts";
import { mutateVisualPlan } from "./gits/mcp/visualPlanWrite.ts";
import { GitsPlanningScanner } from "./gits/Services/GitsPlanningScanner.ts";
import { DelamainAdapter } from "./gits/Services/DelamainAdapter.ts";
import { GitsCapacityMonitor } from "./gits/Services/GitsCapacityMonitor.ts";
import { HermesAdapter } from "./gits/Services/HermesAdapter.ts";
import { OpenGsdAdapter } from "./gits/Services/OpenGsdAdapter.ts";
import { AutomodeSupervisor } from "./gits/Services/AutomodeSupervisor.ts";
import { decideProposalWithAutomodeBridge } from "./gits/Layers/HermesAutomodeBridge.ts";
import { ServerEnvironment } from "./environment/Services/ServerEnvironment.ts";
import { ServerAuth } from "./auth/Services/ServerAuth.ts";
import * as ProcessDiagnostics from "./diagnostics/ProcessDiagnostics.ts";
import * as ProcessResourceMonitor from "./diagnostics/ProcessResourceMonitor.ts";
import * as TraceDiagnostics from "./diagnostics/TraceDiagnostics.ts";
import * as SourceControlDiscoveryLayer from "./sourceControl/SourceControlDiscovery.ts";
import { SourceControlRepositoryService } from "./sourceControl/SourceControlRepositoryService.ts";
import * as AzureDevOpsCli from "./sourceControl/AzureDevOpsCli.ts";
import * as BitbucketApi from "./sourceControl/BitbucketApi.ts";
import * as GitHubCli from "./sourceControl/GitHubCli.ts";
import * as GitLabCli from "./sourceControl/GitLabCli.ts";
import * as SourceControlProviderRegistry from "./sourceControl/SourceControlProviderRegistry.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "./vcs/VcsDriverRegistry.ts";
import * as VcsProjectConfig from "./vcs/VcsProjectConfig.ts";
import * as VcsProcess from "./vcs/VcsProcess.ts";
import {
  BootstrapCredentialService,
  type BootstrapCredentialChange,
} from "./auth/Services/BootstrapCredentialService.ts";
import {
  SessionCredentialService,
  type SessionCredentialChange,
} from "./auth/Services/SessionCredentialService.ts";
import { respondToAuthError } from "./auth/http.ts";
import { CritSidecarManager } from "./crit/crit-sidecar-manager.ts";
import { resolve_crit_binary_path } from "./crit/crit-binary-resolver.ts";
import { build_ensure_sidecar_input } from "./crit/crit-sidecar-request.ts";
import { readPersistedServerRuntimeState } from "./serverRuntimeState.ts";
const isOrchestrationDispatchCommandError = Schema.is(OrchestrationDispatchCommandError);
const isCritError = Schema.is(CritError);
const isWorkspacePathOutsideRootError = Schema.is(WorkspacePathOutsideRootError);
const isGitsCockpitError = Schema.is(GitsCockpitError);
const isGitsDevCommandError = Schema.is(GitsDevCommandError);
const isDelamainAdapterError = Schema.is(DelamainAdapterError);
const isGitsCapacityError = Schema.is(GitsCapacityError);
const isHermesAdapterError = Schema.is(HermesAdapterError);
const isOpenGsdAdapterError = Schema.is(OpenGsdAdapterError);
const isAutomodeSupervisorError = Schema.is(AutomodeSupervisorError);

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

function isThreadDetailEvent(event: OrchestrationEvent): event is Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.message-sent"
      | "thread.forked"
      | "thread.proposed-plan-upserted"
      | "thread.visual-plan-upserted"
      | "thread.activity-appended"
      | "thread.turn-diff-completed"
      | "thread.reverted"
      | "thread.session-set";
  }
> {
  return (
    event.type === "thread.message-sent" ||
    event.type === "thread.forked" ||
    event.type === "thread.proposed-plan-upserted" ||
    event.type === "thread.visual-plan-upserted" ||
    event.type === "thread.activity-appended" ||
    event.type === "thread.turn-diff-completed" ||
    event.type === "thread.reverted" ||
    event.type === "thread.session-set"
  );
}

/**
 * logSequenceGap - detects and logs a gap between the snapshot boundary and
 * the first live event on a subscriber's hot stream.
 *
 * Called once per subscription at the point where the live stream is wired in.
 * A gap (firstLiveSequence > snapshotSequence + 1) means events were emitted
 * between snapshot-read and stream-subscription and will never be delivered to
 * this subscriber — silent event loss on reconnect.
 *
 * Recovery chosen: log structured warning and continue. Crashing the socket
 * or forcibly refetching the snapshot here would require redesigning the
 * stream contract; the warn gives the operator enough context to detect
 * and address this at the architectural level (e.g. subscribe-then-snapshot).
 *
 * ponytail: first-event check only — per-event monotonicity is a separate concern.
 */
export function logSequenceGap(
  label: string,
  snapshotSequence: number,
  firstLiveSequence: number,
): Effect.Effect<void> {
  if (firstLiveSequence <= snapshotSequence + 1) return Effect.void;
  return Effect.logWarning("subscribe-sequence-gap: live stream skips past snapshot boundary", {
    label,
    snapshotSequence,
    firstLiveSequence,
    gapSize: firstLiveSequence - snapshotSequence - 1,
  });
}

const PROVIDER_STATUS_DEBOUNCE_MS = 200;

// ponytail: per-WS-subscriber event buffer cap for UI push streams.
// With PubSub.unbounded, each subscriber holds a node in the PubSub linked list.
// A slow WS client (throttled browser tab) would grow that list without bound.
// On overflow we TERMINATE the subscriber's stream instead of silently dropping:
//   - Server knows it dropped → sends a typed failure Exit to client.
//   - Client's transport sees a non-transport error → stops the subscribe loop.
//   - The onEnd callback (added to StreamSubscriptionOptions) fires.
//   - Client resubscribes via attachThreadDetailSubscription → fresh snapshot.
//   - Slow clients degrade to snapshot-cycling; nobody silently goes stale.
// ponytail: 512 covers ~1s of burst at typical shell/thread event rates.
const WS_PUSH_SUBSCRIBER_BUFFER = 512;
const GIT_ACTION_STREAM_BUFFER = WS_PUSH_SUBSCRIBER_BUFFER;
// ponytail: sliding drops oldest PTY bytes for slow consumers; terminal manager keeps scrollback.
export const TERMINAL_STREAM_BUFFER = 512;

export function terminalCallbackStream<A, E = never, R = never>(
  register: (queue: Queue.Queue<A, E | Cause.Done>) => Effect.Effect<unknown, E, R | Scope.Scope>,
): Stream.Stream<A, E, Exclude<R, Scope.Scope>> {
  return Stream.callback<A, E, R>(register, {
    bufferSize: TERMINAL_STREAM_BUFFER,
    strategy: "sliding",
  });
}

/**
 * bufferOrTerminate — drop-in for `Stream.buffer({ dropping })` with fail-on-overflow.
 *
 * Uses Stream.callback with a bounded dropping queue. On each offer, if the
 * queue is full (offer returns false), the queue is failed with an
 * OrchestrationGetSnapshotError — terminating the downstream consumer's stream
 * with a typed error the client observes via onEnd (which triggers resubscribe).
 *
 * The upstream fiber runs at full PubSub speed; the WS serialiser consumes
 * the bounded queue at WS speed. Neither side blocks the other (I1).
 *
 * ponytail: Queue.dropping offer is non-blocking; failCause on overflow is
 * idempotent (already done). Stream.callback manages queue scope and lifetime.
 */
function bufferOrTerminate<A, E, R>(
  self: Stream.Stream<A, E, R>,
  capacity: number,
  overflowError: () => OrchestrationGetSnapshotError,
): Stream.Stream<A, E | OrchestrationGetSnapshotError, R> {
  return Stream.callback<A, E | OrchestrationGetSnapshotError, R>(
    (queue) =>
      self.pipe(
        Stream.runForEach((event) =>
          Queue.offer(queue, event).pipe(
            Effect.flatMap((accepted) =>
              accepted ? Effect.void : Queue.failCause(queue, Cause.fail(overflowError())),
            ),
          ),
        ),
        Effect.matchCauseEffect({
          onFailure: (cause) => Queue.failCause(queue, cause),
          onSuccess: () => Queue.end(queue),
        }),
      ),
    { bufferSize: capacity, strategy: "dropping" },
  );
}

export function readThreadDetailSnapshot(
  threadId: ThreadId,
  projectionSnapshotQuery: Pick<ProjectionSnapshotQueryShape, "getThreadDetailSnapshot">,
): Effect.Effect<
  {
    readonly snapshotSequence: number;
    readonly threadDetail: Option.Option<OrchestrationThread>;
  },
  OrchestrationGetSnapshotError
> {
  return projectionSnapshotQuery.getThreadDetailSnapshot(threadId).pipe(
    Effect.mapError(
      (cause) =>
        new OrchestrationGetSnapshotError({
          message: `Failed to load thread ${threadId}`,
          cause,
        }),
    ),
  );
}

function toAuthAccessStreamEvent(
  change: BootstrapCredentialChange | SessionCredentialChange,
  revision: number,
  currentSessionId: AuthSessionId,
): AuthAccessStreamEvent {
  switch (change.type) {
    case "pairingLinkUpserted":
      return {
        version: 1,
        revision,
        type: "pairingLinkUpserted",
        payload: change.pairingLink,
      };
    case "pairingLinkRemoved":
      return {
        version: 1,
        revision,
        type: "pairingLinkRemoved",
        payload: { id: change.id },
      };
    case "clientUpserted":
      return {
        version: 1,
        revision,
        type: "clientUpserted",
        payload: {
          ...change.clientSession,
          current: change.clientSession.sessionId === currentSessionId,
        },
      };
    case "clientRemoved":
      return {
        version: 1,
        revision,
        type: "clientRemoved",
        payload: { sessionId: change.sessionId },
      };
  }
}

const makeWsRpcLayer = (currentSessionId: AuthSessionId) =>
  WsRpcGroup.toLayer(
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
      const orchestrationEngine = yield* OrchestrationEngineService;
      const checkpointDiffQuery = yield* CheckpointDiffQuery;
      const keybindings = yield* Keybindings;
      const externalLauncher = yield* ExternalLauncher.ExternalLauncher;
      const gitWorkflow = yield* GitWorkflowService;
      const review = yield* ReviewService;
      const vcsProvisioning = yield* VcsProvisioningService;
      const vcsStatusBroadcaster = yield* VcsStatusBroadcaster;
      const terminalManager = yield* TerminalManager;
      const providerRegistry = yield* ProviderRegistry;
      const providerMaintenanceRunner = yield* ProviderMaintenanceRunner.ProviderMaintenanceRunner;
      const config = yield* ServerConfig;
      const lifecycleEvents = yield* ServerLifecycleEvents;
      const serverSettings = yield* ServerSettingsService;
      const voiceTranscription = yield* VoiceTranscriptionService;
      const startup = yield* ServerRuntimeStartup;
      const workspaceEntries = yield* WorkspaceEntries;
      const workspaceFileSystem = yield* WorkspaceFileSystem;
      const projectSetupScriptRunner = yield* ProjectSetupScriptRunner;
      const repositoryIdentityResolver = yield* RepositoryIdentityResolver;
      const gitsDevCommands = yield* GitsDevCommands;
      const gitsPlanningScanner = yield* GitsPlanningScanner;
      const delamainAdapter = yield* DelamainAdapter;
      const gitsCapacityMonitor = yield* GitsCapacityMonitor;
      const hermesAdapter = yield* HermesAdapter;
      const openGsdAdapter = yield* OpenGsdAdapter;
      const automodeSupervisor = yield* AutomodeSupervisor;
      // R#1 (kill-switch-only manual gate): manual peer actions stay human-driven, but the
      // global automode kill switch also freezes them. ponytail: reuse DelamainAdapterError
      // (these RPC channels already carry it) so no rpc.ts/client contract change is needed.
      const withKillSwitchGuard = <A, E, R>(
        action: Effect.Effect<A, E, R>,
      ): Effect.Effect<A, E | DelamainAdapterError, R> =>
        automodeSupervisor.getSnapshot().pipe(
          Effect.mapError(
            (cause) =>
              new DelamainAdapterError({ message: "Failed to check the automode kill switch.", cause }),
          ),
          Effect.flatMap((snapshot): Effect.Effect<A, E | DelamainAdapterError, R> =>
            snapshot.policy.killSwitchEnabled
              ? Effect.fail(new DelamainAdapterError({ message: "Blocked by the automode kill switch." }))
              : action,
          ),
        );
      const serverEnvironment = yield* ServerEnvironment;
      const serverAuth = yield* ServerAuth;
      const critSidecarManager = yield* CritSidecarManager;
      const sourceControlDiscovery = yield* SourceControlDiscoveryLayer.SourceControlDiscovery;
      const automaticGitFetchInterval = serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.automaticGitFetchInterval),
        Effect.catch((cause) =>
          Effect.logWarning("Failed to read automatic Git fetch interval setting", {
            detail: cause.message,
          }).pipe(Effect.as(DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL)),
        ),
      );
      const sourceControlRepositories = yield* SourceControlRepositoryService;
      const bootstrapCredentials = yield* BootstrapCredentialService;
      const sessions = yield* SessionCredentialService;
      const processDiagnostics = yield* ProcessDiagnostics.ProcessDiagnostics;
      const processResourceMonitor = yield* ProcessResourceMonitor.ProcessResourceMonitor;
      const toDispatchCommandError = (cause: unknown, fallbackMessage: string) =>
        isOrchestrationDispatchCommandError(cause)
          ? cause
          : new OrchestrationDispatchCommandError({
              message: cause instanceof Error ? cause.message : fallbackMessage,
              cause,
            });
      const randomUUID = crypto.randomUUIDv4.pipe(
        Effect.mapError((cause) =>
          toDispatchCommandError(cause, "Failed to generate orchestration command identifier."),
        ),
      );
      const serverEventId = randomUUID.pipe(Effect.map(EventId.make));
      const serverCommandId = (tag: string) =>
        randomUUID.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));

      const loadAuthAccessSnapshot = () =>
        Effect.all({
          pairingLinks: serverAuth.listPairingLinks().pipe(Effect.orDie),
          clientSessions: serverAuth.listClientSessions(currentSessionId).pipe(Effect.orDie),
        });

      const appendSetupScriptActivity = (input: {
        readonly threadId: ThreadId;
        readonly kind: "setup-script.requested" | "setup-script.started" | "setup-script.failed";
        readonly summary: string;
        readonly createdAt: string;
        readonly payload: Record<string, unknown>;
        readonly tone: "info" | "error";
      }) =>
        Effect.all({
          commandId: serverCommandId("setup-script-activity"),
          activityId: serverEventId,
        }).pipe(
          Effect.flatMap(({ commandId, activityId }) =>
            orchestrationEngine.dispatch(
              {
                type: "thread.activity.append",
                commandId,
                threadId: input.threadId,
                activity: {
                  id: activityId,
                  tone: input.tone,
                  kind: input.kind,
                  summary: input.summary,
                  payload: input.payload,
                  turnId: null,
                  createdAt: input.createdAt,
                },
                createdAt: input.createdAt,
              },
              "server",
            ),
          ),
        );

      const toBootstrapDispatchCommandCauseError = (cause: Cause.Cause<unknown>) => {
        const error = Cause.squash(cause);
        return isOrchestrationDispatchCommandError(error)
          ? error
          : new OrchestrationDispatchCommandError({
              message:
                error instanceof Error ? error.message : "Failed to bootstrap thread turn start.",
              cause,
            });
      };

      const enrichProjectEvent = (
        event: OrchestrationEvent,
      ): Effect.Effect<OrchestrationEvent, never, never> => {
        switch (event.type) {
          case "project.created":
            return repositoryIdentityResolver.resolve(event.payload.workspaceRoot).pipe(
              Effect.map((repositoryIdentity) => ({
                ...event,
                payload: {
                  ...event.payload,
                  repositoryIdentity,
                },
              })),
            );
          case "project.meta-updated":
            return Effect.gen(function* () {
              const workspaceRoot =
                event.payload.workspaceRoot ??
                Option.match(
                  yield* projectionSnapshotQuery.getProjectShellById(event.payload.projectId),
                  {
                    onNone: () => null,
                    onSome: (project) => project.workspaceRoot,
                  },
                ) ??
                null;
              if (workspaceRoot === null) {
                return event;
              }

              const repositoryIdentity = yield* repositoryIdentityResolver.resolve(workspaceRoot);
              return {
                ...event,
                payload: {
                  ...event.payload,
                  repositoryIdentity,
                },
              } satisfies OrchestrationEvent;
            }).pipe(Effect.catch(() => Effect.succeed(event)));
          default:
            return Effect.succeed(event);
        }
      };

      const enrichOrchestrationEvents = (events: ReadonlyArray<OrchestrationEvent>) =>
        Effect.forEach(events, enrichProjectEvent, { concurrency: 4 });

      const toShellStreamEvent = (
        event: OrchestrationEvent,
      ): Effect.Effect<Option.Option<OrchestrationShellStreamEvent>, never, never> => {
        switch (event.type) {
          case "project.created":
          case "project.meta-updated":
            return projectionSnapshotQuery.getProjectShellById(event.payload.projectId).pipe(
              Effect.map((project) =>
                Option.map(project, (nextProject) => ({
                  kind: "project-upserted" as const,
                  sequence: event.sequence,
                  project: nextProject,
                })),
              ),
              Effect.catch(() => Effect.succeed(Option.none())),
            );
          case "project.deleted":
            return Effect.succeed(
              Option.some({
                kind: "project-removed" as const,
                sequence: event.sequence,
                projectId: event.payload.projectId,
              }),
            );
          case "thread.deleted":
          case "thread.archived":
            return Effect.succeed(
              Option.some({
                kind: "thread-removed" as const,
                sequence: event.sequence,
                threadId: event.payload.threadId,
              }),
            );
          case "thread.unarchived":
            return projectionSnapshotQuery.getThreadShellById(event.payload.threadId).pipe(
              Effect.map((thread) =>
                Option.map(thread, (nextThread) => ({
                  kind: "thread-upserted" as const,
                  sequence: event.sequence,
                  thread: nextThread,
                })),
              ),
              Effect.catch(() => Effect.succeed(Option.none())),
            );
          default:
            if (event.aggregateKind !== "thread") {
              return Effect.succeed(Option.none());
            }
            return projectionSnapshotQuery
              .getThreadShellById(ThreadId.make(event.aggregateId))
              .pipe(
                Effect.map((thread) =>
                  Option.map(thread, (nextThread) => ({
                    kind: "thread-upserted" as const,
                    sequence: event.sequence,
                    thread: nextThread,
                  })),
                ),
                Effect.catch(() => Effect.succeed(Option.none())),
              );
        }
      };

      const dispatchBootstrapTurnStart = (
        command: Extract<OrchestrationCommand, { type: "thread.turn.start" }>,
      ): Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError> =>
        Effect.gen(function* () {
          const bootstrap = command.bootstrap;
          const { bootstrap: _bootstrap, ...finalTurnStartCommand } = command;
          let createdThread = false;
          let targetProjectId = bootstrap?.createThread?.projectId;
          let targetProjectCwd = bootstrap?.prepareWorktree?.projectCwd;
          let targetWorktreePath = bootstrap?.createThread?.worktreePath ?? null;

          const cleanupCreatedThread = () =>
            createdThread
              ? serverCommandId("bootstrap-thread-delete").pipe(
                  Effect.flatMap((commandId) =>
                    orchestrationEngine.dispatch(
                      {
                        type: "thread.delete",
                        commandId,
                        threadId: command.threadId,
                      },
                      "server",
                    ),
                  ),
                  Effect.ignoreCause({ log: true }),
                )
              : Effect.void;

          const recordSetupScriptLaunchFailure = (input: {
            readonly error: unknown;
            readonly requestedAt: string;
            readonly worktreePath: string;
          }) => {
            const detail =
              input.error instanceof Error ? input.error.message : "Unknown setup failure.";
            return appendSetupScriptActivity({
              threadId: command.threadId,
              kind: "setup-script.failed",
              summary: "Setup script failed to start",
              createdAt: input.requestedAt,
              payload: {
                detail,
                worktreePath: input.worktreePath,
              },
              tone: "error",
            }).pipe(
              Effect.ignoreCause({ log: false }),
              Effect.flatMap(() =>
                Effect.logWarning("bootstrap turn start failed to launch setup script", {
                  threadId: command.threadId,
                  worktreePath: input.worktreePath,
                  detail,
                }),
              ),
            );
          };

          const recordSetupScriptStarted = (input: {
            readonly requestedAt: string;
            readonly worktreePath: string;
            readonly scriptId: string;
            readonly scriptName: string;
            readonly terminalId: string;
          }) =>
            Effect.gen(function* () {
              const startedAt = yield* nowIso;
              const payload = {
                scriptId: input.scriptId,
                scriptName: input.scriptName,
                terminalId: input.terminalId,
                worktreePath: input.worktreePath,
              };
              yield* Effect.all([
                appendSetupScriptActivity({
                  threadId: command.threadId,
                  kind: "setup-script.requested",
                  summary: "Starting setup script",
                  createdAt: input.requestedAt,
                  payload,
                  tone: "info",
                }),
                appendSetupScriptActivity({
                  threadId: command.threadId,
                  kind: "setup-script.started",
                  summary: "Setup script started",
                  createdAt: startedAt,
                  payload,
                  tone: "info",
                }),
              ]).pipe(
                Effect.asVoid,
                Effect.catch((error) =>
                  Effect.logWarning(
                    "bootstrap turn start launched setup script but failed to record setup activity",
                    {
                      threadId: command.threadId,
                      worktreePath: input.worktreePath,
                      scriptId: input.scriptId,
                      terminalId: input.terminalId,
                      detail: error.message,
                    },
                  ),
                ),
              );
            });

          const runSetupProgram = () =>
            Effect.gen(function* () {
              if (!bootstrap?.runSetupScript || !targetWorktreePath) {
                return;
              }
              const worktreePath = targetWorktreePath;
              const requestedAt = yield* nowIso;
              yield* projectSetupScriptRunner
                .runForThread({
                  threadId: command.threadId,
                  ...(targetProjectId ? { projectId: targetProjectId } : {}),
                  ...(targetProjectCwd ? { projectCwd: targetProjectCwd } : {}),
                  worktreePath,
                })
                .pipe(
                  Effect.matchEffect({
                    onFailure: (error) =>
                      recordSetupScriptLaunchFailure({
                        error,
                        requestedAt,
                        worktreePath,
                      }),
                    onSuccess: (setupResult) => {
                      if (setupResult.status !== "started") {
                        return Effect.void;
                      }
                      return recordSetupScriptStarted({
                        requestedAt,
                        worktreePath,
                        scriptId: setupResult.scriptId,
                        scriptName: setupResult.scriptName,
                        terminalId: setupResult.terminalId,
                      });
                    },
                  }),
                );
            });

          const bootstrapProgram = Effect.gen(function* () {
            if (bootstrap?.createThread) {
              yield* orchestrationEngine.dispatch(
                {
                  type: "thread.create",
                  commandId: yield* serverCommandId("bootstrap-thread-create"),
                  threadId: command.threadId,
                  projectId: bootstrap.createThread.projectId,
                  title: bootstrap.createThread.title,
                  modelSelection: bootstrap.createThread.modelSelection,
                  runtimeMode: bootstrap.createThread.runtimeMode,
                  interactionMode: bootstrap.createThread.interactionMode,
                  branch: bootstrap.createThread.branch,
                  worktreePath: bootstrap.createThread.worktreePath,
                  createdAt: bootstrap.createThread.createdAt,
                },
                "operator",
              );
              createdThread = true;
            }

            if (bootstrap?.prepareWorktree) {
              const worktree = yield* gitWorkflow.createWorktree({
                cwd: bootstrap.prepareWorktree.projectCwd,
                refName: bootstrap.prepareWorktree.baseBranch,
                newRefName: bootstrap.prepareWorktree.branch,
                path: null,
              });
              targetWorktreePath = worktree.worktree.path;
              yield* orchestrationEngine.dispatch(
                {
                  type: "thread.meta.update",
                  commandId: yield* serverCommandId("bootstrap-thread-meta-update"),
                  threadId: command.threadId,
                  branch: worktree.worktree.refName,
                  worktreePath: targetWorktreePath,
                },
                "operator",
              );
              // W2.5 (plan 21): record ownership so the orphan adopter can distinguish
              // live-bound worktrees from leaks. Requires projectId from createThread —
              // if absent (worktree added to an existing thread) log a warning and
              // skip; the orphan adopter will adopt it at next startup.
              if (targetProjectId !== undefined) {
                yield* orchestrationEngine
                  .dispatch(
                    {
                      type: "worktree.record-owner",
                      commandId: yield* serverCommandId("bootstrap-worktree-record-owner"),
                      threadId: command.threadId,
                      worktreePath: targetWorktreePath,
                      branch: worktree.worktree.refName ?? null,
                      projectId: targetProjectId,
                      recordedAt: yield* nowIso,
                    },
                    "operator",
                  )
                  .pipe(Effect.ignoreCause({ log: true }));
              } else {
                yield* Effect.logWarning(
                  "worktree.record-owner skipped: no projectId available at bootstrap (orphan adopter will bind at startup)",
                  { threadId: command.threadId, worktreePath: targetWorktreePath },
                );
              }
              yield* refreshGitStatus(targetWorktreePath);
            }

            yield* runSetupProgram();

            return yield* orchestrationEngine.dispatch(finalTurnStartCommand, "operator");
          });

          return yield* bootstrapProgram.pipe(
            Effect.catchCause((cause) => {
              const dispatchError = toBootstrapDispatchCommandCauseError(cause);
              if (Cause.hasInterruptsOnly(cause)) {
                return Effect.fail(dispatchError);
              }
              return cleanupCreatedThread().pipe(Effect.flatMap(() => Effect.fail(dispatchError)));
            }),
          );
        });

      const dispatchNormalizedCommand = (
        normalizedCommand: OrchestrationCommand,
      ): Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError> => {
        const dispatchEffect =
          normalizedCommand.type === "thread.turn.start" && normalizedCommand.bootstrap
            ? dispatchBootstrapTurnStart(normalizedCommand)
            : orchestrationEngine
                .dispatch(normalizedCommand, "operator")
                .pipe(
                  Effect.mapError((cause) =>
                    toDispatchCommandError(cause, "Failed to dispatch orchestration command"),
                  ),
                );

        return startup
          .enqueueCommand(dispatchEffect)
          .pipe(
            Effect.mapError((cause) =>
              toDispatchCommandError(cause, "Failed to dispatch orchestration command"),
            ),
          );
      };

      const loadServerConfig = Effect.gen(function* () {
        const keybindingsConfig = yield* keybindings.loadConfigState;
        const providers = yield* providerRegistry.getProviders;
        const settings = redactServerSettingsForClient(yield* serverSettings.getSettings);
        const environment = yield* serverEnvironment.getDescriptor;
        const auth = yield* serverAuth.getDescriptor();

        return {
          environment,
          auth,
          cwd: config.cwd,
          keybindingsConfigPath: config.keybindingsConfigPath,
          keybindings: keybindingsConfig.keybindings,
          issues: keybindingsConfig.issues,
          providers,
          availableEditors: ExternalLauncher.resolveAvailableEditors(),
          observability: {
            logsDirectoryPath: config.logsDir,
            localTracingEnabled: true,
            ...(config.otlpTracesUrl !== undefined ? { otlpTracesUrl: config.otlpTracesUrl } : {}),
            otlpTracesEnabled: config.otlpTracesUrl !== undefined,
            ...(config.otlpMetricsUrl !== undefined
              ? { otlpMetricsUrl: config.otlpMetricsUrl }
              : {}),
            otlpMetricsEnabled: config.otlpMetricsUrl !== undefined,
          },
          settings,
        };
      });

      const refreshGitStatus = (cwd: string) =>
        vcsStatusBroadcaster
          .refreshStatus(cwd)
          .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach, Effect.asVoid);

      // Resolve the loopback origin the crit wrapper CLI will call back into.
      // Prefer the persisted runtime-state origin (written once the HTTP server
      // binds its real port), then a `GITS_SELF_ORIGIN` env override, then a
      // best-effort default derived from the configured port. ASSUMPTION: the
      // wrapper runs on the same host, so loopback (127.0.0.1) is reachable.
      const resolveCritSelfOrigin = Effect.gen(function* () {
        const persisted = yield* readPersistedServerRuntimeState(
          config.serverRuntimeStatePath,
        ).pipe(Effect.catchCause(() => Effect.succeed(Option.none())));
        if (Option.isSome(persisted)) {
          return persisted.value.origin;
        }
        const override = yield* Config.string("GITS_SELF_ORIGIN").pipe(
          Config.option,
          Config.map(Option.getOrUndefined),
          Effect.catchCause(() => Effect.succeed(undefined)),
        );
        if (override && override.trim().length > 0) {
          return override.trim();
        }
        return `http://127.0.0.1:${config.port}`;
      });

      // The production build path of the crit wrapper CLI is not yet established
      // (deferred Phase 7). Until then the `agent_cmd` is supplied via the
      // `GITS_CRIT_AGENT_CMD` env override. PENDING: replace the fallback with
      // the resolved built wrapper path once Phase 7 lands; the current dev
      // fallback runs the TypeScript source directly under bun.
      const resolveCritWrapperCommand = Config.string("GITS_CRIT_AGENT_CMD").pipe(
        Config.option,
        Config.map(Option.getOrUndefined),
        Effect.catchCause(() => Effect.succeed(undefined)),
        Effect.map((override) =>
          override && override.trim().length > 0
            ? override.trim()
            : "bun ./apps/server/src/crit/crit-agent-cli.ts",
        ),
      );

      const toCritError = (cause: unknown, message: string) =>
        isCritError(cause) ? cause : new CritError({ message, cause });

      return WsRpcGroup.of({
        [ORCHESTRATION_WS_METHODS.dispatchCommand]: (command) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.dispatchCommand,
            Effect.gen(function* () {
              const normalizedCommand = yield* normalizeDispatchCommand(command);
              const shouldStopSessionAfterArchive =
                normalizedCommand.type === "thread.archive"
                  ? yield* projectionSnapshotQuery
                      .getThreadShellById(normalizedCommand.threadId)
                      .pipe(
                        Effect.map(
                          Option.match({
                            onNone: () => false,
                            onSome: (thread) =>
                              thread.session !== null && thread.session.status !== "stopped",
                          }),
                        ),
                        Effect.catch(() => Effect.succeed(false)),
                      )
                  : false;
              const result = yield* dispatchNormalizedCommand(normalizedCommand);
              if (normalizedCommand.type === "thread.archive") {
                if (shouldStopSessionAfterArchive) {
                  yield* Effect.gen(function* () {
                    const stopCommand = yield* normalizeDispatchCommand({
                      type: "thread.session.stop",
                      commandId: CommandId.make(
                        `session-stop-for-archive:${normalizedCommand.commandId}`,
                      ),
                      threadId: normalizedCommand.threadId,
                      createdAt: yield* nowIso,
                    });

                    yield* dispatchNormalizedCommand(stopCommand);
                  }).pipe(
                    Effect.catchCause((cause) =>
                      Effect.logWarning("failed to stop provider session during archive", {
                        threadId: normalizedCommand.threadId,
                        cause,
                      }),
                    ),
                  );
                }

                yield* terminalManager.close({ threadId: normalizedCommand.threadId }).pipe(
                  Effect.catch((error) =>
                    Effect.logWarning("failed to close thread terminals after archive", {
                      threadId: normalizedCommand.threadId,
                      error: error.message,
                    }),
                  ),
                );
              }
              return result;
            }).pipe(
              Effect.mapError((cause) =>
                isOrchestrationDispatchCommandError(cause)
                  ? cause
                  : new OrchestrationDispatchCommandError({
                      message: "Failed to dispatch orchestration command",
                      cause,
                    }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.getTurnDiff]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.getTurnDiff,
            checkpointDiffQuery.getTurnDiff(input).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationGetTurnDiffError({
                    message: "Failed to load turn diff",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.getFullThreadDiff]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.getFullThreadDiff,
            checkpointDiffQuery.getFullThreadDiff(input).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationGetFullThreadDiffError({
                    message: "Failed to load full thread diff",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.replayEvents]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.replayEvents,
            Stream.runCollect(
              orchestrationEngine.readEvents(
                clamp(input.fromSequenceExclusive, {
                  maximum: Number.MAX_SAFE_INTEGER,
                  minimum: 0,
                }),
              ),
            ).pipe(
              Effect.map((events) => Array.from(events)),
              Effect.flatMap(enrichOrchestrationEvents),
              Effect.mapError(
                (cause) =>
                  new OrchestrationReplayEventsError({
                    message: "Failed to replay orchestration events",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.subscribeShell]: (_input) =>
          observeRpcStreamEffect(
            ORCHESTRATION_WS_METHODS.subscribeShell,
            Effect.gen(function* () {
              const snapshot = yield* projectionSnapshotQuery.getShellSnapshot().pipe(
                Effect.tapError((cause) =>
                  Effect.logError("orchestration shell snapshot load failed", { cause }),
                ),
                Effect.mapError(
                  (cause) =>
                    new OrchestrationGetSnapshotError({
                      message: "Failed to load orchestration shell snapshot",
                      cause,
                    }),
                ),
              );

              const liveStream = bufferOrTerminate(
                orchestrationEngine.streamDomainEvents,
                WS_PUSH_SUBSCRIBER_BUFFER,
                () =>
                  new OrchestrationGetSnapshotError({
                    message:
                      "subscribeShell: subscriber buffer overflow — resubscribe for fresh snapshot",
                    cause: "overflow",
                  }),
              ).pipe(
                // ponytail: gap check on raw stream before toShellStreamEvent filters
                // may drop the event.
                Stream.mapAccumEffect(
                  () => false as boolean,
                  (checked, event: OrchestrationEvent) =>
                    checked
                      ? Effect.succeed([true, [event]] as const)
                      : logSequenceGap(
                          "subscribeShell",
                          snapshot.snapshotSequence,
                          event.sequence,
                        ).pipe(Effect.as([true, [event]] as const)),
                ),
                Stream.mapEffect(toShellStreamEvent),
                Stream.flatMap((event) =>
                  Option.isSome(event) ? Stream.succeed(event.value) : Stream.empty,
                ),
              );

              return Stream.concat(
                Stream.make({
                  kind: "snapshot" as const,
                  snapshot,
                }),
                liveStream,
              );
            }),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot]: (_input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot,
            projectionSnapshotQuery.getArchivedShellSnapshot().pipe(
              Effect.tapError((cause) =>
                Effect.logError("orchestration archived shell snapshot load failed", { cause }),
              ),
              Effect.mapError(
                (cause) =>
                  new OrchestrationGetSnapshotError({
                    message: "Failed to load archived orchestration shell snapshot",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.subscribeThread]: (input) =>
          observeRpcStreamEffect(
            ORCHESTRATION_WS_METHODS.subscribeThread,
            Effect.gen(function* () {
              const { threadDetail, snapshotSequence } = yield* readThreadDetailSnapshot(
                input.threadId,
                projectionSnapshotQuery,
              );

              if (Option.isNone(threadDetail)) {
                return yield* new OrchestrationGetSnapshotError({
                  message: `Thread ${input.threadId} was not found`,
                  cause: input.threadId,
                });
              }

              const liveStream = bufferOrTerminate(
                orchestrationEngine.streamDomainEvents,
                WS_PUSH_SUBSCRIBER_BUFFER,
                () =>
                  new OrchestrationGetSnapshotError({
                    message: `subscribeThread:${input.threadId}: subscriber buffer overflow — resubscribe for fresh snapshot`,
                    cause: "overflow",
                  }),
              ).pipe(
                // ponytail: gap check on raw stream before thread filter so the first
                // event arriving after snapshot-read (even for other aggregates) sets
                // the checked flag — the sequence space is global, not per-thread.
                Stream.mapAccumEffect(
                  () => false as boolean,
                  (checked, event: OrchestrationEvent) =>
                    checked
                      ? Effect.succeed([true, [event]] as const)
                      : logSequenceGap(
                          `subscribeThread:${input.threadId}`,
                          snapshotSequence,
                          event.sequence,
                        ).pipe(Effect.as([true, [event]] as const)),
                ),
                Stream.filter(
                  (event) =>
                    event.aggregateKind === "thread" &&
                    event.aggregateId === input.threadId &&
                    isThreadDetailEvent(event),
                ),
                Stream.map((event) => ({
                  kind: "event" as const,
                  event,
                })),
              );

              return Stream.concat(
                Stream.make({
                  kind: "snapshot" as const,
                  snapshot: {
                    snapshotSequence,
                    thread: threadDetail.value,
                  },
                }),
                liveStream,
              );
            }),
            { "rpc.aggregate": "orchestration" },
          ),
        [WS_METHODS.serverGetConfig]: (_input) =>
          observeRpcEffect(WS_METHODS.serverGetConfig, loadServerConfig, {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.serverRefreshProviders]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverRefreshProviders,
            (input.instanceId !== undefined
              ? providerRegistry.refreshInstance(input.instanceId)
              : providerRegistry.refresh()
            ).pipe(Effect.map((providers) => ({ providers }))),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverUpdateProvider]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverUpdateProvider,
            providerMaintenanceRunner.updateProvider(input),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverUpsertKeybinding]: (rule) =>
          observeRpcEffect(
            WS_METHODS.serverUpsertKeybinding,
            Effect.gen(function* () {
              const keybindingsConfig = yield* keybindings.upsertKeybindingRule(rule);
              return { keybindings: keybindingsConfig, issues: [] };
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverRemoveKeybinding]: (rule) =>
          observeRpcEffect(
            WS_METHODS.serverRemoveKeybinding,
            Effect.gen(function* () {
              const keybindingsConfig = yield* keybindings.removeKeybindingRule(rule);
              return { keybindings: keybindingsConfig, issues: [] };
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverGetSettings]: (_input) =>
          observeRpcEffect(
            WS_METHODS.serverGetSettings,
            serverSettings.getSettings.pipe(Effect.map(redactServerSettingsForClient)),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverUpdateSettings]: ({ patch }) =>
          observeRpcEffect(
            WS_METHODS.serverUpdateSettings,
            Effect.gen(function* () {
              const result = yield* serverSettings.updateSettings(patch);
              const changedKeys = Object.keys(patch ?? {});
              if (changedKeys.length > 0) {
                // W5.4b: fire-and-forget audit emit; catchCause covers dispatch + commandId errors
                yield* Effect.gen(function* () {
                  yield* orchestrationEngine.dispatch(
                    {
                      type: "settings.record-change",
                      commandId: yield* serverCommandId("settings-change"),
                      // ponytail: key names only — never values (security)
                      changedKeys,
                      changedAt: yield* nowIso,
                    },
                    "operator",
                  );
                }).pipe(Effect.catchCause(() => Effect.void));
              }
              return redactServerSettingsForClient(result);
            }),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverDiscoverSourceControl]: (_input) =>
          observeRpcEffect(
            WS_METHODS.serverDiscoverSourceControl,
            sourceControlDiscovery.discover,
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverGetTraceDiagnostics]: (_input) =>
          observeRpcEffect(
            WS_METHODS.serverGetTraceDiagnostics,
            TraceDiagnostics.readTraceDiagnostics({
              traceFilePath: config.serverTracePath,
              maxFiles: config.traceMaxFiles,
            }),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverGetProcessDiagnostics]: (_input) =>
          observeRpcEffect(WS_METHODS.serverGetProcessDiagnostics, processDiagnostics.read, {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.serverGetProcessResourceHistory]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverGetProcessResourceHistory,
            processResourceMonitor.readHistory(input),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverSignalProcess]: (input) =>
          observeRpcEffect(WS_METHODS.serverSignalProcess, processDiagnostics.signal(input), {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.sourceControlLookupRepository]: (input) =>
          observeRpcEffect(
            WS_METHODS.sourceControlLookupRepository,
            sourceControlRepositories.lookupRepository(input),
            {
              "rpc.aggregate": "source-control",
            },
          ),
        [WS_METHODS.sourceControlCloneRepository]: (input) =>
          observeRpcEffect(
            WS_METHODS.sourceControlCloneRepository,
            sourceControlRepositories.cloneRepository(input),
            {
              "rpc.aggregate": "source-control",
            },
          ),
        [WS_METHODS.sourceControlPublishRepository]: (input) =>
          observeRpcEffect(
            WS_METHODS.sourceControlPublishRepository,
            sourceControlRepositories
              .publishRepository(input)
              .pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            {
              "rpc.aggregate": "source-control",
            },
          ),
        [WS_METHODS.audioTranscribe]: (input) =>
          observeRpcEffect(WS_METHODS.audioTranscribe, voiceTranscription.transcribe(input), {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.projectsSearchEntries]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsSearchEntries,
            workspaceEntries.search(input).pipe(
              Effect.mapError(
                (cause) =>
                  new ProjectSearchEntriesError({
                    message: `Failed to search workspace entries: ${cause.detail}`,
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.projectsWriteFile]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsWriteFile,
            workspaceFileSystem.writeFile(input).pipe(
              Effect.mapError((cause) => {
                const message = isWorkspacePathOutsideRootError(cause)
                  ? "Workspace file path must stay within the project root."
                  : "Failed to write workspace file";
                return new ProjectWriteFileError({
                  message,
                  cause,
                });
              }),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.shellOpenInEditor]: (input) =>
          observeRpcEffect(WS_METHODS.shellOpenInEditor, externalLauncher.launchEditor(input), {
            "rpc.aggregate": "workspace",
          }),
        [WS_METHODS.shellOpenInTerminal]: (input) =>
          observeRpcEffect(
            WS_METHODS.shellOpenInTerminal,
            externalLauncher.launchTerminal(input.cwd),
            {
              "rpc.aggregate": "workspace",
            },
          ),
        [WS_METHODS.filesystemBrowse]: (input) =>
          observeRpcEffect(
            WS_METHODS.filesystemBrowse,
            workspaceEntries.browse(input).pipe(
              Effect.mapError(
                (cause) =>
                  new FilesystemBrowseError({
                    message: cause.detail,
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.subscribeVcsStatus]: (input) =>
          observeRpcStream(
            WS_METHODS.subscribeVcsStatus,
            vcsStatusBroadcaster.streamStatus(input, {
              automaticRemoteRefreshInterval: automaticGitFetchInterval,
            }),
            {
              "rpc.aggregate": "vcs",
            },
          ),
        [WS_METHODS.vcsRefreshStatus]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsRefreshStatus,
            vcsStatusBroadcaster.refreshStatus(input.cwd),
            {
              "rpc.aggregate": "vcs",
            },
          ),
        [WS_METHODS.vcsPull]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsPull,
            gitWorkflow.pullCurrentBranch(input.cwd).pipe(
              Effect.matchCauseEffect({
                onFailure: (cause) => Effect.failCause(cause),
                onSuccess: (result) =>
                  refreshGitStatus(input.cwd).pipe(Effect.ignore({ log: true }), Effect.as(result)),
              }),
            ),
            { "rpc.aggregate": "git" },
          ),
        [WS_METHODS.gitRunStackedAction]: (input) =>
          observeRpcStream(
            WS_METHODS.gitRunStackedAction,
            Stream.callback<GitActionProgressEvent, GitManagerServiceError>(
              (queue) =>
                gitWorkflow
                  .runStackedAction(input, {
                    actionId: input.actionId,
                    progressReporter: {
                      publish: (event) => Queue.offer(queue, event).pipe(Effect.asVoid),
                    },
                  })
                  .pipe(
                    Effect.matchCauseEffect({
                      onFailure: (cause) => Queue.failCause(queue, cause),
                      onSuccess: () =>
                        refreshGitStatus(input.cwd).pipe(
                          Effect.andThen(Queue.end(queue).pipe(Effect.asVoid)),
                        ),
                    }),
                  ),
              { bufferSize: GIT_ACTION_STREAM_BUFFER, strategy: "dropping" },
            ),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.gitResolvePullRequest]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitResolvePullRequest,
            gitWorkflow.resolvePullRequest(input),
            {
              "rpc.aggregate": "git",
            },
          ),
        [WS_METHODS.gitPreparePullRequestThread]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitPreparePullRequestThread,
            gitWorkflow
              .preparePullRequestThread(input)
              .pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "git" },
          ),
        [WS_METHODS.vcsListRefs]: (input) =>
          observeRpcEffect(WS_METHODS.vcsListRefs, gitWorkflow.listRefs(input), {
            "rpc.aggregate": "vcs",
          }),
        [WS_METHODS.vcsCreateWorktree]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsCreateWorktree,
            Effect.gen(function* () {
              const result = yield* gitWorkflow.createWorktree(input);
              yield* refreshGitStatus(input.cwd);
              // W5.4b: fire-and-forget audit emit; catchCause covers dispatch + commandId errors
              yield* Effect.gen(function* () {
                yield* orchestrationEngine.dispatch(
                  {
                    type: "vcs.worktree.record-created",
                    commandId: yield* serverCommandId("vcs-worktree-created"),
                    worktreePath: result.worktree.path,
                    branch: result.worktree.refName,
                    createdAt: yield* nowIso,
                  },
                  "operator",
                );
              }).pipe(Effect.catchCause(() => Effect.void));
              return result;
            }),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.vcsRemoveWorktree]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsRemoveWorktree,
            Effect.gen(function* () {
              yield* gitWorkflow.removeWorktree(input);
              yield* refreshGitStatus(input.cwd);
              // W5.4b: fire-and-forget audit emit; catchCause covers dispatch + commandId errors
              yield* Effect.gen(function* () {
                yield* orchestrationEngine.dispatch(
                  {
                    type: "vcs.worktree.record-removed",
                    commandId: yield* serverCommandId("vcs-worktree-removed"),
                    worktreePath: input.path,
                    removedAt: yield* nowIso,
                  },
                  "operator",
                );
              }).pipe(Effect.catchCause(() => Effect.void));
            }),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.vcsCreateRef]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsCreateRef,
            gitWorkflow.createRef(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.vcsSwitchRef]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsSwitchRef,
            gitWorkflow.switchRef(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.vcsInit]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsInit,
            vcsProvisioning
              .initRepository(input)
              .pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.reviewGetDiffPreview]: (input) =>
          observeRpcEffect(WS_METHODS.reviewGetDiffPreview, review.getDiffPreview(input), {
            "rpc.aggregate": "review",
          }),
        [WS_METHODS.critEnsureSidecar]: (input) =>
          observeRpcEffect(
            WS_METHODS.critEnsureSidecar,
            Effect.gen(function* () {
              const origin = yield* resolveCritSelfOrigin;
              const wrapperCommand = yield* resolveCritWrapperCommand;
              // The wrapper's bearer token is minted (with a bounded TTL) and
              // revoked-on-teardown inside CritSidecarManager.ensure_sidecar, so
              // the reuse path no longer leaks a fresh owner session per call.
              const handle = yield* critSidecarManager.ensure_sidecar(
                build_ensure_sidecar_input({
                  request: input,
                  origin,
                  wrapperCommand,
                  binaryPath: resolve_crit_binary_path(),
                }),
              );
              return { status: handle.status, url: handle.url };
            }).pipe(
              Effect.mapError((cause) =>
                toCritError(cause, "Failed to ensure the crit review sidecar."),
              ),
            ),
            { "rpc.aggregate": "crit" },
          ),
        [WS_METHODS.critSidecarStatus]: (input) =>
          observeRpcEffect(
            WS_METHODS.critSidecarStatus,
            critSidecarManager
              .sidecar_status(input.workspaceRoot)
              .pipe(Effect.map((handle) => ({ status: handle.status, url: handle.url }))),
            { "rpc.aggregate": "crit" },
          ),
        [WS_METHODS.critReleaseSidecar]: (input) =>
          observeRpcEffect(
            WS_METHODS.critReleaseSidecar,
            critSidecarManager
              .release_sidecar(input.workspaceRoot)
              .pipe(Effect.as({ released: true })),
            { "rpc.aggregate": "crit" },
          ),
        [WS_METHODS.gitsGetCockpit]: (_input) =>
          observeRpcEffect(
            WS_METHODS.gitsGetCockpit,
            projectionSnapshotQuery.getShellSnapshot().pipe(
              Effect.flatMap((snapshot) =>
                gitsPlanningScanner.scan({
                  projects: snapshot.projects,
                  threads: snapshot.threads,
                  fallbackCwd: config.cwd,
                }),
              ),
              Effect.mapError((cause) =>
                isGitsCockpitError(cause)
                  ? cause
                  : new GitsCockpitError({
                      message: "Failed to load GITS cockpit state.",
                      cause,
                    }),
              ),
            ),
            { "rpc.aggregate": "gits" },
          ),
        [WS_METHODS.gitsDevCommandsList]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitsDevCommandsList,
            gitsDevCommands.listCommands(input).pipe(
              Effect.mapError((cause) =>
                isGitsDevCommandError(cause)
                  ? cause
                  : new GitsDevCommandError({
                      message: "Failed to list GITS dev commands.",
                      cause,
                    }),
              ),
            ),
            { "rpc.aggregate": "gits" },
          ),
        [WS_METHODS.gitsDevCommandsInit]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitsDevCommandsInit,
            gitsDevCommands.initCommands(input).pipe(
              Effect.mapError((cause) =>
                isGitsDevCommandError(cause)
                  ? cause
                  : new GitsDevCommandError({
                      message: "Failed to initialize GITS dev commands.",
                      cause,
                    }),
              ),
            ),
            { "rpc.aggregate": "gits" },
          ),
        [WS_METHODS.gitsVisualPlanMutate]: (input) =>
          observeRpcEffect(WS_METHODS.gitsVisualPlanMutate, mutateVisualPlan(input), {
            "rpc.aggregate": "gits",
          }),
        [WS_METHODS.gitsDelamainListPeers]: (_input) =>
          observeRpcEffect(
            WS_METHODS.gitsDelamainListPeers,
            delamainAdapter.listPeers().pipe(
              Effect.mapError((cause) =>
                isDelamainAdapterError(cause)
                  ? cause
                  : new DelamainAdapterError({
                      message: "Failed to list Delamain peers.",
                      cause,
                    }),
              ),
            ),
            { "rpc.aggregate": "gits" },
          ),
        [WS_METHODS.gitsDelamainGetPeerStatus]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitsDelamainGetPeerStatus,
            delamainAdapter.getPeerStatus(input),
            { "rpc.aggregate": "gits" },
          ),
        [WS_METHODS.gitsDelamainReadPeerLog]: (input) =>
          observeRpcEffect(WS_METHODS.gitsDelamainReadPeerLog, delamainAdapter.readPeerLog(input), {
            "rpc.aggregate": "gits",
          }),
        // Human-in-the-loop RPC: spawn is intentionally outside automode's autonomous policy gate
        // (kill-switch/allowlist), because this is an explicit operator action.
        [WS_METHODS.gitsDelamainSpawnPeer]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitsDelamainSpawnPeer,
            withKillSwitchGuard(delamainAdapter.spawnPeer(input)),
            { "rpc.aggregate": "gits" },
          ),
        [WS_METHODS.gitsDelamainKillPeer]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitsDelamainKillPeer,
            withKillSwitchGuard(delamainAdapter.killPeer(input)),
            { "rpc.aggregate": "gits" },
          ),
        [WS_METHODS.gitsDelamainSendPeerReply]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitsDelamainSendPeerReply,
            withKillSwitchGuard(delamainAdapter.sendPeerReply(input)),
            { "rpc.aggregate": "gits" },
          ),
        [WS_METHODS.gitsDelamainWaitForPeer]: (input) =>
          observeRpcEffect(WS_METHODS.gitsDelamainWaitForPeer, delamainAdapter.waitForPeer(input), {
            "rpc.aggregate": "gits",
          }),
        [WS_METHODS.gitsDelamainIntegratePeer]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitsDelamainIntegratePeer,
            withKillSwitchGuard(delamainAdapter.integratePeer(input)),
            { "rpc.aggregate": "gits" },
          ),
        [WS_METHODS.gitsDelamainReadInbox]: (input) =>
          observeRpcEffect(WS_METHODS.gitsDelamainReadInbox, delamainAdapter.readInbox(input), {
            "rpc.aggregate": "gits",
          }),
        // Gated send: routes through the supervisor (motokoAuthority + evaluatePolicyGate),
        // never delamainAdapter.sendMessage directly.
        [WS_METHODS.gitsDelamainSendMessage]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitsDelamainSendMessage,
            automodeSupervisor.sendPeerMessage(input),
            { "rpc.aggregate": "gits" },
          ),
        [WS_METHODS.gitsOpenGsdGetStatus]: (_input) =>
          observeRpcEffect(
            WS_METHODS.gitsOpenGsdGetStatus,
            openGsdAdapter.getStatus().pipe(
              Effect.mapError((cause) =>
                isOpenGsdAdapterError(cause)
                  ? cause
                  : new OpenGsdAdapterError({
                      message: "Failed to detect Open GSD.",
                      cause,
                    }),
              ),
            ),
            { "rpc.aggregate": "gits" },
          ),
        [WS_METHODS.gitsOpenGsdInitProject]: (input) =>
          observeRpcEffect(WS_METHODS.gitsOpenGsdInitProject, openGsdAdapter.initProject(input), {
            "rpc.aggregate": "gits",
          }),
        [WS_METHODS.gitsOpenGsdRunAuto]: (input) =>
          observeRpcEffect(WS_METHODS.gitsOpenGsdRunAuto, openGsdAdapter.runAuto(input), {
            "rpc.aggregate": "gits",
          }),
        [WS_METHODS.gitsAutomodeGetSnapshot]: (_input) =>
          observeRpcEffect(
            WS_METHODS.gitsAutomodeGetSnapshot,
            automodeSupervisor.getSnapshot().pipe(
              Effect.mapError((cause) =>
                isAutomodeSupervisorError(cause)
                  ? cause
                  : new AutomodeSupervisorError({
                      message: "Failed to load automode state.",
                      cause,
                    }),
              ),
            ),
            { "rpc.aggregate": "gits" },
          ),
        [WS_METHODS.gitsAutomodeUpdatePolicy]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitsAutomodeUpdatePolicy,
            automodeSupervisor.updatePolicy(input),
            { "rpc.aggregate": "gits" },
          ),
        [WS_METHODS.gitsAutomodeEnqueueGoal]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitsAutomodeEnqueueGoal,
            automodeSupervisor.enqueueGoal(input),
            { "rpc.aggregate": "gits" },
          ),
        [WS_METHODS.gitsAutomodeApproveGoal]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitsAutomodeApproveGoal,
            automodeSupervisor.approveGoal(input),
            { "rpc.aggregate": "gits" },
          ),
        [WS_METHODS.gitsAutomodeRejectGoal]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitsAutomodeRejectGoal,
            automodeSupervisor.rejectGoal(input),
            { "rpc.aggregate": "gits" },
          ),
        [WS_METHODS.gitsAutomodeDispatchGoal]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitsAutomodeDispatchGoal,
            automodeSupervisor.dispatchGoal(input),
            { "rpc.aggregate": "gits" },
          ),
        [WS_METHODS.gitsCapacityGetSnapshot]: (_input) =>
          observeRpcEffect(
            WS_METHODS.gitsCapacityGetSnapshot,
            gitsCapacityMonitor.getSnapshot().pipe(
              Effect.mapError((cause) =>
                isGitsCapacityError(cause)
                  ? cause
                  : new GitsCapacityError({
                      message: "Failed to load GITS capacity snapshot.",
                      cause,
                    }),
              ),
            ),
            { "rpc.aggregate": "gits" },
          ),
        [WS_METHODS.gitsHermesGetStatus]: (_input) =>
          observeRpcEffect(
            WS_METHODS.gitsHermesGetStatus,
            hermesAdapter.getStatus().pipe(
              Effect.mapError((cause) =>
                isHermesAdapterError(cause)
                  ? cause
                  : new HermesAdapterError({
                      message: "Failed to load Hermes status.",
                      cause,
                    }),
              ),
            ),
            { "rpc.aggregate": "gits" },
          ),
        [WS_METHODS.gitsHermesGetConfig]: (_input) =>
          observeRpcEffect(WS_METHODS.gitsHermesGetConfig, hermesAdapter.getConfig(), {
            "rpc.aggregate": "gits",
          }),
        [WS_METHODS.gitsHermesCheck]: (_input) =>
          observeRpcEffect(WS_METHODS.gitsHermesCheck, hermesAdapter.check(), {
            "rpc.aggregate": "gits",
          }),
        [WS_METHODS.gitsHermesSetupCodexOAuth]: (_input) =>
          observeRpcEffect(WS_METHODS.gitsHermesSetupCodexOAuth, hermesAdapter.setupCodexOAuth(), {
            "rpc.aggregate": "gits",
          }),
        [WS_METHODS.gitsHermesStartAcpSession]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitsHermesStartAcpSession,
            hermesAdapter.startAcpSession(input),
            { "rpc.aggregate": "gits" },
          ),
        [WS_METHODS.gitsHermesListSessions]: (input) =>
          observeRpcEffect(WS_METHODS.gitsHermesListSessions, hermesAdapter.listSessions(input), {
            "rpc.aggregate": "gits",
          }),
        [WS_METHODS.gitsHermesTailLog]: (input) =>
          observeRpcEffect(WS_METHODS.gitsHermesTailLog, hermesAdapter.tailLog(input), {
            "rpc.aggregate": "gits",
          }),
        [WS_METHODS.gitsHermesListProposals]: (_input) =>
          observeRpcEffect(WS_METHODS.gitsHermesListProposals, hermesAdapter.listProposals(), {
            "rpc.aggregate": "gits",
          }),
        [WS_METHODS.gitsHermesInspectGits]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitsHermesInspectGits,
            hermesAdapter.inspectGitsAndPropose(input),
            { "rpc.aggregate": "gits" },
          ),
        [WS_METHODS.gitsHermesChat]: (input) =>
          observeRpcEffect(WS_METHODS.gitsHermesChat, hermesAdapter.chat(input), {
            "rpc.aggregate": "gits",
          }),
        [WS_METHODS.gitsHermesDecideProposal]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitsHermesDecideProposal,
            decideProposalWithAutomodeBridge(hermesAdapter, automodeSupervisor, input),
            { "rpc.aggregate": "gits" },
          ),
        [WS_METHODS.gitsHermesWriteProjectContext]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitsHermesWriteProjectContext,
            hermesAdapter.writeProjectContext(input),
            { "rpc.aggregate": "gits" },
          ),
        [WS_METHODS.gitsHermesDraftFromProposal]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitsHermesDraftFromProposal,
            hermesAdapter.draftFromProposal(input),
            { "rpc.aggregate": "gits" },
          ),
        [WS_METHODS.gitsHermesRunSchedule]: (input) =>
          observeRpcEffect(WS_METHODS.gitsHermesRunSchedule, hermesAdapter.runSchedule(input), {
            "rpc.aggregate": "gits",
          }),
        [WS_METHODS.terminalOpen]: (input) =>
          observeRpcEffect(WS_METHODS.terminalOpen, terminalManager.open(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.terminalAttach]: (input) =>
          observeRpcStream(
            WS_METHODS.terminalAttach,
            terminalCallbackStream<TerminalAttachStreamEvent, TerminalError>((queue) =>
              Effect.acquireRelease(
                terminalManager.attachStream(input, (event) => Queue.offer(queue, event)),
                (unsubscribe) => Effect.sync(unsubscribe),
              ),
            ),
            { "rpc.aggregate": "terminal" },
          ),
        [WS_METHODS.terminalWrite]: (input) =>
          observeRpcEffect(WS_METHODS.terminalWrite, terminalManager.write(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.terminalResize]: (input) =>
          observeRpcEffect(WS_METHODS.terminalResize, terminalManager.resize(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.terminalClear]: (input) =>
          observeRpcEffect(WS_METHODS.terminalClear, terminalManager.clear(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.terminalRestart]: (input) =>
          observeRpcEffect(WS_METHODS.terminalRestart, terminalManager.restart(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.terminalClose]: (input) =>
          observeRpcEffect(WS_METHODS.terminalClose, terminalManager.close(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.subscribeTerminalEvents]: (_input) =>
          observeRpcStream(
            WS_METHODS.subscribeTerminalEvents,
            terminalCallbackStream<TerminalEvent>((queue) =>
              Effect.acquireRelease(
                terminalManager.subscribe((event) => Queue.offer(queue, event)),
                (unsubscribe) => Effect.sync(unsubscribe),
              ),
            ),
            { "rpc.aggregate": "terminal" },
          ),
        [WS_METHODS.subscribeTerminalMetadata]: (_input) =>
          observeRpcStream(
            WS_METHODS.subscribeTerminalMetadata,
            terminalCallbackStream<TerminalMetadataStreamEvent>((queue) =>
              Effect.acquireRelease(
                terminalManager.subscribeMetadata((event) => Queue.offer(queue, event)),
                (unsubscribe) => Effect.sync(unsubscribe),
              ),
            ),
            { "rpc.aggregate": "terminal" },
          ),
        [WS_METHODS.subscribeServerConfig]: (_input) =>
          observeRpcStreamEffect(
            WS_METHODS.subscribeServerConfig,
            Effect.gen(function* () {
              const keybindingsUpdates = keybindings.streamChanges.pipe(
                Stream.map((event) => ({
                  version: 1 as const,
                  type: "keybindingsUpdated" as const,
                  payload: {
                    keybindings: event.keybindings,
                    issues: event.issues,
                  },
                })),
              );
              const providerStatuses = providerRegistry.streamChanges.pipe(
                Stream.map((providers) => ({
                  version: 1 as const,
                  type: "providerStatuses" as const,
                  payload: { providers },
                })),
                Stream.debounce(Duration.millis(PROVIDER_STATUS_DEBOUNCE_MS)),
              );
              const settingsUpdates = serverSettings.streamChanges.pipe(
                Stream.map((settings) => redactServerSettingsForClient(settings)),
                Stream.map((settings) => ({
                  version: 1 as const,
                  type: "settingsUpdated" as const,
                  payload: { settings },
                })),
              );

              yield* providerRegistry
                .refresh()
                .pipe(Effect.ignoreCause({ log: true }), Effect.forkScoped);

              const liveUpdates = Stream.merge(
                keybindingsUpdates,
                Stream.merge(providerStatuses, settingsUpdates),
              );

              return Stream.concat(
                Stream.make({
                  version: 1 as const,
                  type: "snapshot" as const,
                  config: yield* loadServerConfig,
                }),
                liveUpdates,
              );
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.subscribeServerLifecycle]: (_input) =>
          observeRpcStreamEffect(
            WS_METHODS.subscribeServerLifecycle,
            Effect.gen(function* () {
              const snapshot = yield* lifecycleEvents.snapshot;
              const snapshotEvents = Array.from(snapshot.events).toSorted(
                (left, right) => left.sequence - right.sequence,
              );
              const liveEvents = lifecycleEvents.stream.pipe(
                Stream.filter((event) => event.sequence > snapshot.sequence),
              );
              return Stream.concat(Stream.fromIterable(snapshotEvents), liveEvents);
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.subscribeAuthAccess]: (_input) =>
          observeRpcStreamEffect(
            WS_METHODS.subscribeAuthAccess,
            Effect.gen(function* () {
              const initialSnapshot = yield* loadAuthAccessSnapshot();
              const revisionRef = yield* Ref.make(1);
              const accessChanges: Stream.Stream<
                BootstrapCredentialChange | SessionCredentialChange
              > = Stream.merge(bootstrapCredentials.streamChanges, sessions.streamChanges);

              const liveEvents: Stream.Stream<AuthAccessStreamEvent> = accessChanges.pipe(
                Stream.mapEffect((change) =>
                  Ref.updateAndGet(revisionRef, (revision) => revision + 1).pipe(
                    Effect.map((revision) =>
                      toAuthAccessStreamEvent(change, revision, currentSessionId),
                    ),
                  ),
                ),
              );

              return Stream.concat(
                Stream.make({
                  version: 1 as const,
                  revision: 1,
                  type: "snapshot" as const,
                  payload: initialSnapshot,
                }),
                liveEvents,
              );
            }),
            { "rpc.aggregate": "auth" },
          ),
      });
    }),
  );

export const websocketRpcRouteLayer = Layer.unwrap(
  Effect.succeed(
    HttpRouter.add(
      "GET",
      "/ws",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const serverAuth = yield* ServerAuth;
        const sessions = yield* SessionCredentialService;
        const session = yield* serverAuth.authenticateWebSocketUpgrade(request);
        const rpcWebSocketHttpEffect = yield* RpcServer.toHttpEffectWebsocket(WsRpcGroup, {
          disableTracing: true,
        }).pipe(
          Effect.provide(
            makeWsRpcLayer(session.sessionId).pipe(
              Layer.provideMerge(RpcSerialization.layerJson),
              Layer.provide(ProviderMaintenanceRunner.layer),
              Layer.provide(
                SourceControlDiscoveryLayer.layer.pipe(
                  Layer.provide(
                    SourceControlProviderRegistry.layer.pipe(
                      Layer.provide(
                        Layer.mergeAll(
                          AzureDevOpsCli.layer,
                          BitbucketApi.layer,
                          GitHubCli.layer,
                          GitLabCli.layer,
                        ),
                      ),
                      Layer.provideMerge(GitVcsDriver.layer),
                      Layer.provide(
                        VcsDriverRegistry.layer.pipe(Layer.provide(VcsProjectConfig.layer)),
                      ),
                    ),
                  ),
                  Layer.provide(VcsProcess.layer),
                ),
              ),
            ),
          ),
        );
        return yield* Effect.acquireUseRelease(
          sessions.markConnected(session.sessionId),
          () => rpcWebSocketHttpEffect,
          () => sessions.markDisconnected(session.sessionId),
        );
      }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
    ),
  ),
);
