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
  AuthAccessDeniedError,
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
  BrowserPreviewError,
  CritError,
  DelamainAdapterError,
  GitsCapacityError,
  GitsCockpitError,
  GitsDevCommandError,
  GitsNotesError,
  GitsPortsError,
  HermesAdapterError,
  OpenGsdAdapterError,
  ProviderAuthError,
  ProviderOperationError,
  ThreadId,
  type TerminalAttachStreamEvent,
  type TerminalError,
  type TerminalEvent,
  type TerminalMetadataStreamEvent,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import { clamp } from "effect/Number";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";

import { CheckpointDiffQuery } from "./checkpointing/Services/CheckpointDiffQuery.ts";
import { ServerConfig } from "./config.ts";
import { Keybindings } from "./keybindings.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import { normalizeDispatchCommand } from "./orchestration/Normalizer.ts";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine.ts";
import { ProviderService } from "./provider/Services/ProviderService.ts";
import { TextGeneration } from "./textGeneration/TextGeneration.ts";
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
import { ProviderInstanceRegistry } from "./provider/Services/ProviderInstanceRegistry.ts";
import { ProviderAuthService } from "./provider-auth/ProviderAuthService.ts";
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
import { GitsPorts } from "./gits/Services/GitsPorts.ts";
import { GitsNotes } from "./gits/Services/GitsNotes.ts";
import { mutateVisualPlan } from "./gits/mcp/visualPlanWrite.ts";
import { GitsPlanningScanner } from "./gits/Services/GitsPlanningScanner.ts";
import { DelamainAdapter } from "./gits/Services/DelamainAdapter.ts";
import { GitsCapacityMonitor } from "./gits/Services/GitsCapacityMonitor.ts";
import { GitsSlotScheduler } from "./gits/Services/GitsSlotScheduler.ts";
import { HermesAdapter } from "./gits/Services/HermesAdapter.ts";
import { OpenGsdAdapter } from "./gits/Services/OpenGsdAdapter.ts";
import { AutomodeSupervisor } from "./gits/Services/AutomodeSupervisor.ts";
import { AutomodeEpisodeLedger } from "./persistence/Services/AutomodeEpisodeLedger.ts";
import { decideProposalWithAutomodeBridge } from "./gits/Layers/HermesAutomodeBridge.ts";
import { ServerEnvironment } from "./environment/Services/ServerEnvironment.ts";
import {
  denyThreadAccess,
  ServerAuth,
  type AuthenticatedSession,
} from "./auth/Services/ServerAuth.ts";
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
import { browser_preview_manager } from "./browser-preview/browser-preview-manager.ts";
const isOrchestrationDispatchCommandError = Schema.is(OrchestrationDispatchCommandError);
const isCritError = Schema.is(CritError);
const to_browser_preview_error = (cause: unknown) =>
  new BrowserPreviewError({
    message: cause instanceof Error ? cause.message : "Browser preview operation failed.",
    cause,
  });
const isWorkspacePathOutsideRootError = Schema.is(WorkspacePathOutsideRootError);
const isGitsCockpitError = Schema.is(GitsCockpitError);
const isGitsDevCommandError = Schema.is(GitsDevCommandError);
const isGitsNotesError = Schema.is(GitsNotesError);
const isGitsPortsError = Schema.is(GitsPortsError);
const toGitsNotesError = (cause: unknown, message: string) =>
  isGitsNotesError(cause) ? cause : new GitsNotesError({ message, cause });
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
export function bufferOrTerminate<A, E, R>(
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

// ponytail: coalesce a subscriber's live events into one WS frame per tick.
// Effect RPC emits exactly one "Chunk" wire message per stream chunk
// (RpcServer.streamEffect → Stream.runForEachArray), so collapsing a tick's
// events into a single chunk == a single frame. groupedWithin skips empty
// windows (aggregateWithin drops idle schedule steps → no empty frames), keeps
// order, and MAX_SAFE_INTEGER size means only the timer closes a frame.
// flattenIterable re-emits each group as one chunk (verified). ~33ms ≈ 30fps,
// inside the 16–50ms target. Upgrade path: tune WS_FRAME_BATCH_WINDOW if UI lag
// or per-frame size ever demands it.
export const WS_FRAME_BATCH_WINDOW = Duration.millis(33);

export function coalescePerTick<A, E, R>(self: Stream.Stream<A, E, R>): Stream.Stream<A, E, R> {
  return self.pipe(
    Stream.groupedWithin(Number.MAX_SAFE_INTEGER, WS_FRAME_BATCH_WINDOW),
    Stream.flattenIterable,
  );
}

// T8: throttle thread domain events per-threadId within 200ms windows.
// The first event per thread per window triggers getThreadShellById + one WS frame;
// subsequent events within the cooldown are suppressed. Non-thread events pass through.
// Since getThreadShellById reads current DB state, the first event in a burst already
// reflects the latest projection by the time it's processed.
// ponytail: throttle (first-wins) rather than debounce (last-wins) — no timer fibers,
// no interaction with aggregateWithin + PubSub subscription interruption. Upgrade path:
// per-key fiber-based debounce if last-state fidelity under back-pressure matters.
export function debounceShellThreadEvents<E, R>(
  events: Stream.Stream<OrchestrationEvent, E, R>,
): Stream.Stream<OrchestrationEvent, E, R> {
  const lastEmitted = new Map<string, number>();
  return events.pipe(
    Stream.filter((event) => {
      if (event.aggregateKind !== "thread") return true;
      const key = event.aggregateId;
      const now = performance.now();
      const last = lastEmitted.get(key) ?? 0;
      if (now - last >= PROVIDER_STATUS_DEBOUNCE_MS) {
        lastEmitted.set(key, now);
        return true;
      }
      return false;
    }),
  );
}

// T9-s2 resume: assemble subscribeThread's output when the client already holds
// the snapshot — replay (catch-up) events after its cursor, then live events, both
// filtered to this thread's detail events and tagged as stream items. Catch-up
// comes from the global event store (needs the aggregate filter); live comes from
// the already-routed per-aggregate queue (the aggregate filter is a harmless no-op
// there). NO snapshot frame — the client already has it; overlap between catch-up
// and live is deduped by sequence on the client. Exported so the ordering + filter
// seam is unit-testable without the full RPC layer.
export function resumeThreadStream<E1, E2, R>(
  catchUpEvents: Stream.Stream<OrchestrationEvent, E1, R>,
  liveEvents: Stream.Stream<OrchestrationEvent, E2, R>,
  threadId: ThreadId,
): Stream.Stream<{ readonly kind: "event"; readonly event: OrchestrationEvent }, E1 | E2, R> {
  const keep = (event: OrchestrationEvent) =>
    event.aggregateKind === "thread" &&
    event.aggregateId === threadId &&
    isThreadDetailEvent(event);
  const toItem = (event: OrchestrationEvent) => ({ kind: "event" as const, event });
  return Stream.concat(
    catchUpEvents.pipe(Stream.filter(keep), Stream.map(toItem)),
    liveEvents.pipe(Stream.filter(keep), Stream.map(toItem)),
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

const makeWsRpcLayer = (
  currentSession: Pick<AuthenticatedSession, "sessionId" | "role" | "subject">,
) =>
  WsRpcGroup.toLayer(
    Effect.gen(function* () {
      const currentSessionId = currentSession.sessionId;
      const crypto = yield* Crypto.Crypto;
      const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
      const orchestrationEngine = yield* OrchestrationEngineService;
      const providerService = yield* Effect.serviceOption(ProviderService);
      const textGeneration = yield* Effect.serviceOption(TextGeneration);
      const checkpointDiffQuery = yield* CheckpointDiffQuery;
      const keybindings = yield* Keybindings;
      const externalLauncher = yield* ExternalLauncher.ExternalLauncher;
      const gitWorkflow = yield* GitWorkflowService;
      const review = yield* ReviewService;
      const vcsProvisioning = yield* VcsProvisioningService;
      const vcsStatusBroadcaster = yield* VcsStatusBroadcaster;
      const terminalManager = yield* TerminalManager;
      const providerRegistry = yield* ProviderRegistry;
      const providerInstanceRegistry = yield* ProviderInstanceRegistry;
      const providerAuthService = yield* ProviderAuthService;
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
      const gitsPorts = yield* GitsPorts;
      const gitsNotes = yield* GitsNotes;
      const gitsPlanningScanner = yield* GitsPlanningScanner;
      const delamainAdapter = yield* DelamainAdapter;
      const gitsCapacityMonitor = yield* GitsCapacityMonitor;
      const gitsSlotScheduler = yield* GitsSlotScheduler;
      const hermesAdapter = yield* HermesAdapter;
      const openGsdAdapter = yield* OpenGsdAdapter;
      const automodeSupervisor = yield* AutomodeSupervisor;
      const automodeEpisodeLedger = yield* AutomodeEpisodeLedger;
      // R#1 (kill-switch-only manual gate): manual peer actions stay human-driven, but the
      // global automode kill switch also freezes them. ponytail: reuse DelamainAdapterError
      // (these RPC channels already carry it) so no rpc.ts/client contract change is needed.
      const withKillSwitchGuard = <A, E, R>(
        action: Effect.Effect<A, E, R>,
      ): Effect.Effect<A, E | DelamainAdapterError, R> =>
        automodeSupervisor.getSnapshot().pipe(
          Effect.mapError(
            (cause) =>
              new DelamainAdapterError({
                message: "Failed to check the automode kill switch.",
                cause,
              }),
          ),
          Effect.flatMap(
            (snapshot): Effect.Effect<A, E | DelamainAdapterError, R> =>
              snapshot.policy.killSwitchEnabled
                ? Effect.fail(
                    new DelamainAdapterError({ message: "Blocked by the automode kill switch." }),
                  )
                : action,
          ),
        );
      const requireRoutedDelamainLaunch = <
        A extends {
          readonly engine?: unknown;
          readonly providerInstanceId?: unknown;
        },
      >(
        input: A,
      ): Effect.Effect<A, DelamainAdapterError> =>
        input.engine !== undefined && input.providerInstanceId !== undefined
          ? Effect.succeed(input)
          : Effect.fail(
              new DelamainAdapterError({
                message: "Public Delamain launches require both engine and providerInstanceId.",
              }),
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

      const requireProviderAuthOwner =
        currentSession.role === "owner"
          ? Effect.void
          : Effect.fail(
              new ProviderAuthError({
                code: "access-denied",
                message: "Only owner sessions can manage provider authentication.",
              }),
            );
      const resolveProviderAuth = (
        providerInstanceId: Parameters<typeof providerInstanceRegistry.getInstance>[0],
      ) =>
        providerInstanceRegistry.getInstance(providerInstanceId).pipe(
          Effect.flatMap((instance) => {
            if (!instance) {
              return Effect.fail(
                new ProviderAuthError({
                  code: "not-found",
                  message: "Provider instance was not found.",
                }),
              );
            }
            if (!instance.adapter.providerAuth) {
              return Effect.fail(
                new ProviderAuthError({
                  code: "unsupported",
                  message: "This provider does not support managed authentication.",
                }),
              );
            }
            return Effect.succeed({ instance, adapter: instance.adapter.providerAuth });
          }),
        );

      return WsRpcGroup.of({
        [WS_METHODS.providerSteerTurn]: (input) =>
          Option.match(providerService, {
            onNone: () =>
              Effect.fail(new ProviderOperationError({ message: "Provider service unavailable" })),
            onSome: (service) =>
              service.steerTurn
                ? service
                    .steerTurn(input)
                    .pipe(
                      Effect.mapError(
                        (error) => new ProviderOperationError({ message: error.message }),
                      ),
                    )
                : Effect.fail(
                    new ProviderOperationError({ message: "Active-turn steering unavailable" }),
                  ),
          }),
        [WS_METHODS.providerGenerateFollowUpSuggestions]: (input) =>
          Option.match(textGeneration, {
            onNone: () =>
              Effect.fail(new ProviderOperationError({ message: "Text generation unavailable" })),
            onSome: (service) =>
              service
                .generateFollowUpSuggestions(input)
                .pipe(
                  Effect.mapError(
                    (error) => new ProviderOperationError({ message: error.message }),
                  ),
                ),
          }),
        [WS_METHODS.providerCodexAccountUsage]: (input) =>
          Option.match(providerService, {
            onNone: () =>
              Effect.fail(new ProviderOperationError({ message: "Provider service unavailable" })),
            onSome: (service) =>
              service.readCodexAccountUsage
                ? service
                    .readCodexAccountUsage(input)
                    .pipe(
                      Effect.mapError(
                        (error) => new ProviderOperationError({ message: error.message }),
                      ),
                    )
                : Effect.fail(
                    new ProviderOperationError({ message: "Codex account usage unavailable" }),
                  ),
          }),
        [WS_METHODS.providerConsumeCodexResetCredit]: (input) =>
          Option.match(providerService, {
            onNone: () =>
              Effect.fail(new ProviderOperationError({ message: "Provider service unavailable" })),
            onSome: (service) =>
              service.consumeCodexResetCredit
                ? service
                    .consumeCodexResetCredit(input)
                    .pipe(
                      Effect.mapError(
                        (error) => new ProviderOperationError({ message: error.message }),
                      ),
                    )
                : Effect.fail(
                    new ProviderOperationError({ message: "Codex reset credits unavailable" }),
                  ),
          }),
        [WS_METHODS.usageModelBreakdown]: (input) =>
          projectionSnapshotQuery.getUsageModelBreakdown
            ? projectionSnapshotQuery.getUsageModelBreakdown(input).pipe(
                Effect.tapError((cause) =>
                  Effect.logError("usage model breakdown load failed", { cause }),
                ),
                Effect.mapError(
                  () => new ProviderOperationError({ message: "Failed to load usage breakdown" }),
                ),
              )
            : Effect.fail(new ProviderOperationError({ message: "Usage breakdown unavailable" })),
        [WS_METHODS.providerAuthStart]: (input) =>
          observeRpcEffect(
            WS_METHODS.providerAuthStart,
            Effect.gen(function* () {
              yield* requireProviderAuthOwner;
              const resolved = yield* resolveProviderAuth(input.providerInstanceId);
              return yield* providerAuthService.startProvider({
                provider: resolved.instance.driverKind,
                providerInstanceId: input.providerInstanceId,
                connectionId: currentSessionId,
                method: input.method,
                ...(input.capabilityId ? { capabilityId: input.capabilityId } : {}),
                adapter: resolved.adapter,
                refresh: providerRegistry
                  .refreshInstance(input.providerInstanceId)
                  .pipe(Effect.asVoid),
                verifyAuthenticated: providerRegistry
                  .refreshInstance(input.providerInstanceId)
                  .pipe(
                    Effect.map((providers) =>
                      providers.some(
                        (provider) =>
                          provider.instanceId === input.providerInstanceId &&
                          provider.auth.status === "authenticated",
                      ),
                    ),
                  ),
              });
            }),
            { "rpc.aggregate": "provider-auth" },
          ),
        [WS_METHODS.providerAuthGet]: (input) =>
          observeRpcEffect(
            WS_METHODS.providerAuthGet,
            requireProviderAuthOwner.pipe(
              Effect.andThen(
                providerAuthService.get({
                  sessionId: input.sessionId,
                  connectionId: currentSessionId,
                }),
              ),
            ),
            { "rpc.aggregate": "provider-auth" },
          ),
        [WS_METHODS.providerAuthCancel]: (input) =>
          observeRpcEffect(
            WS_METHODS.providerAuthCancel,
            requireProviderAuthOwner.pipe(
              Effect.andThen(
                providerAuthService.cancel({
                  sessionId: input.sessionId,
                  connectionId: currentSessionId,
                }),
              ),
            ),
            { "rpc.aggregate": "provider-auth" },
          ),
        [WS_METHODS.providerAuthSubmitCode]: (input) =>
          observeRpcEffect(
            WS_METHODS.providerAuthSubmitCode,
            requireProviderAuthOwner.pipe(
              Effect.andThen(
                providerAuthService.submitCode({
                  sessionId: input.sessionId,
                  connectionId: currentSessionId,
                  code: input.code,
                }),
              ),
            ),
            { "rpc.aggregate": "provider-auth" },
          ),
        [WS_METHODS.providerAuthLogout]: (input) =>
          observeRpcEffect(
            WS_METHODS.providerAuthLogout,
            Effect.gen(function* () {
              yield* requireProviderAuthOwner;
              const resolved = yield* resolveProviderAuth(input.providerInstanceId);
              yield* providerAuthService.logoutProvider({
                provider: resolved.instance.driverKind,
                providerInstanceId: input.providerInstanceId,
                adapter: resolved.adapter,
                refresh: providerRegistry
                  .refreshInstance(input.providerInstanceId)
                  .pipe(Effect.asVoid),
              });
            }),
            { "rpc.aggregate": "provider-auth" },
          ),
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
                yield* Effect.promise(() =>
                  browser_preview_manager.stop(normalizedCommand.threadId),
                ).pipe(
                  Effect.catch((cause) =>
                    Effect.logWarning("failed to stop browser preview after archive", {
                      threadId: normalizedCommand.threadId,
                      cause,
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
        [ORCHESTRATION_WS_METHODS.subscribeShell]: (input) =>
          observeRpcStreamEffect(
            ORCHESTRATION_WS_METHODS.subscribeShell,
            Effect.gen(function* () {
              // T9-s2: acquire the live subscription BEFORE reading the snapshot or
              // draining the resume replay, so an event published during either read
              // is buffered in the subscription and never lost (no-gap seam).
              const domainEvents = yield* orchestrationEngine.subscribeDomainEvents;
              const toShellStream = <E, R>(events: Stream.Stream<OrchestrationEvent, E, R>) =>
                events.pipe(
                  Stream.mapEffect(toShellStreamEvent),
                  Stream.flatMap((event) =>
                    Option.isSome(event) ? Stream.succeed(event.value) : Stream.empty,
                  ),
                );

              // T9-s2 resume: the client already holds a shell snapshot (its sequence
              // in afterSequence) → skip the full projects/threads frame and replay
              // only shell events after the cursor, then stream live. Overlap between
              // the replay tail and the buffered live subscription is deduped by
              // sequence on the client.
              // ponytail: the live subscription is unbounded (was bufferOrTerminate
              // 512-cap), so overflow no longer terminates the stream. Unlike the
              // thread path this is not per-thread routed — a stalled shell client can
              // still grow the PubSub; upstream accepts this, upgrade path = re-cap +
              // resume.
              if (input.afterSequence !== undefined) {
                const catchUpStream = orchestrationEngine.readEvents(input.afterSequence).pipe(
                  Stream.mapError(
                    (cause) =>
                      new OrchestrationGetSnapshotError({
                        message: "Failed to replay orchestration shell events",
                        cause,
                      }),
                  ),
                );
                return Stream.concat(
                  toShellStream(catchUpStream),
                  // T8: debounce live thread events by threadId before SQL query.
                  toShellStream(debounceShellThreadEvents(Stream.fromSubscription(domainEvents))),
                );
              }

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

              // T8: debounce live thread events by threadId before SQL query.
              const liveStream = toShellStream(
                debounceShellThreadEvents(
                  Stream.fromSubscription(domainEvents).pipe(
                    Stream.filter((event) => event.sequence > snapshot.snapshotSequence),
                  ),
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
              // T7 isolation half: authorize the thread↔client binding BEFORE
              // registering the per-aggregate queue, so a session never gets a
              // queue (and thus events) for a thread it may not see. Reuses the
              // session's existing thread-visibility rule (subject === threadId
              // for thread-scoped sessions). Refuse with the stream's existing
              // error shape — a typed failure, never a silent empty stream.
              const denied = denyThreadAccess(currentSession, input.threadId);
              if (denied) {
                return yield* new OrchestrationGetSnapshotError({
                  message: `Thread ${input.threadId} is not accessible for this session`,
                  cause: denied,
                });
              }
              // T7: register a per-aggregateId queue BEFORE reading the snapshot or
              // draining the resume replay, so no post-cursor event is missed (the
              // no-gap seam). The queue is unbounded and routed to this thread only.
              const aggregateEvents = yield* orchestrationEngine.subscribeAggregate(input.threadId);

              // T9-s2 resume: the client already loaded the snapshot over HTTP (its
              // sequence in afterSequence) → skip the (multi-KB) snapshot frame and
              // replay only events after the cursor, then stream live. The live queue
              // was registered above so an event published during the replay is held
              // there; overlap between the replay tail and live is deduped by sequence
              // on the client → no gap, no loss.
              // ponytail: the per-aggregate queue is unbounded (was bufferOrTerminate
              // 512-cap). T7 routing bounds it to one thread's events, and resume makes
              // reconnect cheap, so overflow no longer terminates the stream. A
              // hyperactive thread + a stalled client can still grow it — upgrade path
              // = re-cap + resume-on-overflow.
              if (input.afterSequence !== undefined) {
                const catchUpStream = orchestrationEngine.readEvents(input.afterSequence).pipe(
                  Stream.mapError(
                    (cause) =>
                      new OrchestrationGetSnapshotError({
                        message: `Failed to replay thread ${input.threadId} events`,
                        cause,
                      }),
                  ),
                );
                return coalescePerTick(
                  resumeThreadStream(
                    catchUpStream,
                    Stream.fromQueue(aggregateEvents),
                    input.threadId,
                  ),
                );
              }

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

              // First-subscribe live stream: routing guarantees the aggregate, so
              // only the snapshot-cursor dedup + event-type filter remain.
              const liveStream = Stream.fromQueue(aggregateEvents).pipe(
                Stream.filter(
                  (event) => event.sequence > snapshotSequence && isThreadDetailEvent(event),
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
                // T7-s3: batch this per-thread subscriber's events into one WS frame
                // per tick. The N-open-tabs multiplier is the target.
                coalescePerTick(liveStream),
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
        [WS_METHODS.sourceControlListOwnedRepositories]: (input) =>
          observeRpcEffect(
            WS_METHODS.sourceControlListOwnedRepositories,
            sourceControlRepositories.listOwnedRepositories(input),
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
        [WS_METHODS.browserPreviewOpen]: (input) =>
          observeRpcEffect(
            WS_METHODS.browserPreviewOpen,
            Effect.tryPromise({
              try: () => browser_preview_manager.open(input.threadId),
              catch: to_browser_preview_error,
            }),
            { "rpc.aggregate": "browserPreview" },
          ),
        [WS_METHODS.browserPreviewStatus]: (input) =>
          observeRpcEffect(
            WS_METHODS.browserPreviewStatus,
            Effect.tryPromise({
              try: () => browser_preview_manager.status(input.threadId),
              catch: to_browser_preview_error,
            }),
            { "rpc.aggregate": "browserPreview" },
          ),
        [WS_METHODS.browserPreviewControl]: (input) =>
          observeRpcEffect(
            WS_METHODS.browserPreviewControl,
            Effect.tryPromise({
              try: () =>
                browser_preview_manager.control(
                  input.threadId,
                  input.action,
                  input.url,
                  input.instruction,
                ),
              catch: to_browser_preview_error,
            }),
            { "rpc.aggregate": "browserPreview" },
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
        [WS_METHODS.gitsNotesList]: (_input) =>
          observeRpcEffect(
            WS_METHODS.gitsNotesList,
            gitsNotes
              .list()
              .pipe(
                Effect.mapError((cause) => toGitsNotesError(cause, "Failed to list GITS notes.")),
              ),
            { "rpc.aggregate": "gits" },
          ),
        [WS_METHODS.gitsNotesRead]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitsNotesRead,
            gitsNotes
              .read(input)
              .pipe(
                Effect.mapError((cause) => toGitsNotesError(cause, "Failed to read GITS note.")),
              ),
            { "rpc.aggregate": "gits" },
          ),
        [WS_METHODS.gitsNotesCreate]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitsNotesCreate,
            gitsNotes
              .create(input)
              .pipe(
                Effect.mapError((cause) => toGitsNotesError(cause, "Failed to create GITS note.")),
              ),
            { "rpc.aggregate": "gits" },
          ),
        [WS_METHODS.gitsNotesUpdate]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitsNotesUpdate,
            gitsNotes
              .update(input)
              .pipe(
                Effect.mapError((cause) => toGitsNotesError(cause, "Failed to update GITS note.")),
              ),
            { "rpc.aggregate": "gits" },
          ),
        [WS_METHODS.gitsNotesRemove]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitsNotesRemove,
            gitsNotes
              .remove(input)
              .pipe(
                Effect.mapError((cause) => toGitsNotesError(cause, "Failed to remove GITS note.")),
              ),
            { "rpc.aggregate": "gits" },
          ),
        [WS_METHODS.gitsNotesSync]: (_input) =>
          observeRpcEffect(
            WS_METHODS.gitsNotesSync,
            gitsNotes
              .sync()
              .pipe(
                Effect.mapError((cause) => toGitsNotesError(cause, "Failed to sync GITS notes.")),
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
        [WS_METHODS.gitsPortsList]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitsPortsList,
            gitsPorts.list(input).pipe(
              Effect.mapError((cause) =>
                isGitsPortsError(cause)
                  ? cause
                  : new GitsPortsError({
                      message: "Failed to list environment ports.",
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
        [WS_METHODS.gitsDelamainReadPeerLogParsed]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitsDelamainReadPeerLogParsed,
            delamainAdapter.readPeerLogParsed(input),
            { "rpc.aggregate": "gits" },
          ),
        // Human-in-the-loop RPC: spawn is intentionally outside automode's autonomous policy gate
        // (kill-switch/allowlist), because this is an explicit operator action.
        [WS_METHODS.gitsDelamainSpawnPeer]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitsDelamainSpawnPeer,
            requireRoutedDelamainLaunch(input).pipe(
              Effect.flatMap((routedInput) =>
                withKillSwitchGuard(delamainAdapter.spawnPeer(routedInput)),
              ),
            ),
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
        [WS_METHODS.gitsDelamainWorkflowStatus]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitsDelamainWorkflowStatus,
            delamainAdapter.workflowStatus(input),
            { "rpc.aggregate": "gits" },
          ),
        [WS_METHODS.gitsDelamainWorkflowKill]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitsDelamainWorkflowKill,
            withKillSwitchGuard(delamainAdapter.workflowKill(input)),
            { "rpc.aggregate": "gits" },
          ),
        // Operator launch — kill-switch guarded like spawn (it dispatches peers).
        [WS_METHODS.gitsDelamainRunWorkflow]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitsDelamainRunWorkflow,
            requireRoutedDelamainLaunch(input).pipe(
              Effect.flatMap((routedInput) =>
                withKillSwitchGuard(delamainAdapter.runWorkflow(routedInput)),
              ),
            ),
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
        [WS_METHODS.gitsAutomodeSchedulerSnapshot]: (_input) =>
          observeRpcEffect(
            WS_METHODS.gitsAutomodeSchedulerSnapshot,
            gitsSlotScheduler.getSnapshot(),
            { "rpc.aggregate": "gits" },
          ),
        [WS_METHODS.gitsAutomodeSchedulerSetConfig]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitsAutomodeSchedulerSetConfig,
            gitsSlotScheduler.setConfig(input),
            { "rpc.aggregate": "gits" },
          ),
        [WS_METHODS.gitsAutomodeSchedulerArm]: (_input) =>
          observeRpcEffect(WS_METHODS.gitsAutomodeSchedulerArm, gitsSlotScheduler.arm(), {
            "rpc.aggregate": "gits",
          }),
        [WS_METHODS.gitsAutomodeSchedulerDisarm]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitsAutomodeSchedulerDisarm,
            gitsSlotScheduler.disarm(input),
            {
              "rpc.aggregate": "gits",
            },
          ),
        [WS_METHODS.gitsAutomodeDriverResume]: (_input) =>
          observeRpcEffect(WS_METHODS.gitsAutomodeDriverResume, automodeSupervisor.resumeDriver(), {
            "rpc.aggregate": "gits",
          }),
        [WS_METHODS.gitsAutomodeEpisodesList]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitsAutomodeEpisodesList,
            automodeEpisodeLedger.list_episodes(input).pipe(
              Effect.mapError(
                (cause) =>
                  new AutomodeSupervisorError({
                    message: "Failed to list automode episodes.",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "gits" },
          ),
        [WS_METHODS.gitsAutomodeStopAll]: (_input) =>
          observeRpcEffect(WS_METHODS.gitsAutomodeStopAll, automodeSupervisor.stopAll(), {
            "rpc.aggregate": "gits",
          }),
        [WS_METHODS.gitsAutomodeGoalsKill]: (input) =>
          observeRpcEffect(WS_METHODS.gitsAutomodeGoalsKill, automodeSupervisor.killGoal(input), {
            "rpc.aggregate": "gits",
          }),
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
              if (currentSession.role !== "owner") {
                return yield* new AuthAccessDeniedError({
                  message: "Only owner sessions can manage network access.",
                });
              }

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
        const sessionChanges = yield* sessions.subscribeChanges;
        const session = yield* serverAuth.authenticateWebSocketUpgrade(request);
        const rpcWebSocketHttpEffect = yield* RpcServer.toHttpEffectWebsocket(WsRpcGroup, {
          disableTracing: true,
        }).pipe(
          Effect.provide(
            makeWsRpcLayer(session).pipe(
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
        const sessionRevoked = Stream.fromSubscription(sessionChanges).pipe(
          Stream.filter(
            (change) => change.type === "clientRemoved" && change.sessionId === session.sessionId,
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.as(HttpServerResponse.empty()),
        );
        return yield* Effect.acquireUseRelease(
          sessions.markConnected(session.sessionId),
          () => Effect.raceFirst(rpcWebSocketHttpEffect, sessionRevoked),
          () => sessions.markDisconnected(session.sessionId),
        );
      }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
    ),
  ),
);
