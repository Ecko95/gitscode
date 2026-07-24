import {
  type ChatAttachment,
  CommandId,
  type DelamainMessage,
  EventId,
  MessageId,
  type ModelSelection,
  type OrchestrationMessage,
  type OrchestrationEvent,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ProjectId,
  type OrchestrationSession,
  ThreadId,
  type ProviderSession,
  type RuntimeMode,
  TextGenerationError,
  type TurnId,
} from "@t3tools/contracts";
import { isTemporaryWorktreeBranch, WORKTREE_BRANCH_PREFIX } from "@t3tools/shared/git";
import {
  resolveRepositoryProfile,
  resolveRepositoryProviderInstance,
} from "@t3tools/shared/repositoryProfiles";
import * as Cache from "effect/Cache";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";

import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import { increment, orchestrationEventsProcessedTotal } from "../../observability/Metrics.ts";
import { ProviderAdapterRequestError } from "../../provider/Errors.ts";
import type { ProviderServiceError } from "../../provider/Errors.ts";
import { TextGeneration } from "../../textGeneration/TextGeneration.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ProviderSessionDirectory } from "../../provider/Services/ProviderSessionDirectory.ts";
import { DelamainAdapter } from "../../gits/Services/DelamainAdapter.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  ProviderCommandReactor,
  type ProviderCommandReactorShape,
} from "../Services/ProviderCommandReactor.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import {
  findThreadForkPrefix,
  isCodexThreadForkProvider,
  resolveThreadForkAnchor,
  supportsFullThreadFork,
} from "../threadFork.ts";
import {
  ProjectionTurnRepository,
  type ProjectionTurn,
} from "../../persistence/Services/ProjectionTurns.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import type { CodexForkResumeCursor } from "../../provider/Layers/CodexSessionRuntime.ts";
const isProviderAdapterRequestError = Schema.is(ProviderAdapterRequestError);
const isProviderDriverKind = Schema.is(ProviderDriverKind);
const isTextGenerationError = Schema.is(TextGenerationError);

type ProviderIntentEvent = Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.runtime-mode-set"
      | "thread.turn-start-requested"
      | "thread.turn-interrupt-requested"
      | "thread.approval-response-requested"
      | "thread.user-input-response-requested"
      | "thread.session-stop-requested"
      | "thread.forked";
  }
>;

function toNonEmptyProviderInput(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function mapProviderSessionStatusToOrchestrationStatus(
  status: "connecting" | "ready" | "running" | "error" | "closed",
): OrchestrationSession["status"] {
  switch (status) {
    case "connecting":
      return "starting";
    case "running":
      return "running";
    case "error":
      return "error";
    case "closed":
      return "stopped";
    case "ready":
    default:
      return "ready";
  }
}

const turnStartKeyForEvent = (event: ProviderIntentEvent): string =>
  event.commandId !== null ? `command:${event.commandId}` : `event:${event.eventId}`;

const HANDLED_TURN_START_KEY_MAX = 10_000;
const HANDLED_TURN_START_KEY_TTL = Duration.minutes(30);
const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";
const DEFAULT_THREAD_TITLE = "New thread";
const THREAD_FORK_SUMMARY_HEADING = "Fork summary";

function threadIdForProviderIntentEvent(event: ProviderIntentEvent): ThreadId {
  return event.type === "thread.forked"
    ? ThreadId.make(String(event.aggregateId))
    : event.payload.threadId;
}

function toOptionalTrimmedText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function renderThreadForkTranscript(messages: ReadonlyArray<OrchestrationMessage>): string {
  if (messages.length === 0) {
    return "(No previous messages are retained before this fork anchor.)";
  }

  return messages
    .map((message, index) => {
      const text = message.text.trim();
      return [`Message ${index + 1} (${message.role})`, text.length > 0 ? text : "(empty)"].join(
        "\n",
      );
    })
    .join("\n\n");
}

function buildThreadForkSummaryMessage(input: {
  readonly summary: string;
  readonly seedPrompt?: string | undefined;
}): string {
  const seedPrompt = toOptionalTrimmedText(input.seedPrompt);
  return [
    THREAD_FORK_SUMMARY_HEADING,
    "",
    input.summary.trim(),
    ...(seedPrompt ? ["", "Seed prompt", "", seedPrompt] : []),
  ].join("\n");
}

const PEER_INBOX_SEED_HEADING = "Peer inbox messages received since this thread's last turn:";

// R5: render a delamain peer's unseen inbox messages as a context seed prepended
// to the next provider turn. Mirrors delamain `formatInboxPrompt`'s shape (per
// message: a "[peer message] from <sender>" header, the response-id when present,
// then the body) — replicated locally rather than imported (cross-repo).
export function renderPeerInboxContextSeed(messages: ReadonlyArray<DelamainMessage>): string {
  const rendered = messages
    .map((message) => {
      const lines = [`[peer message] from ${message.fromPeerId}`];
      if (message.responseId) {
        lines.push(`response-id: ${message.responseId}`);
      }
      lines.push("", message.message);
      return lines.join("\n");
    })
    .join("\n\n---\n\n");
  return [PEER_INBOX_SEED_HEADING, "", rendered].join("\n");
}

function isThreadForkSummaryMessage(message: OrchestrationMessage): boolean {
  // ponytail: marker by rendered heading, not event metadata; replace with a
  // typed seed-message flag if summary forks gain richer lifecycle state.
  return (
    message.role === "assistant" &&
    !message.streaming &&
    message.text.startsWith(`${THREAD_FORK_SUMMARY_HEADING}\n\n`)
  );
}

function findThreadForkSummarySeedMessage(input: {
  readonly messages: ReadonlyArray<OrchestrationMessage>;
  readonly parentThreadId?: ThreadId | null | undefined;
}): OrchestrationMessage | undefined {
  if (!input.parentThreadId) {
    return undefined;
  }
  const userMessageCount = input.messages.filter((message) => message.role === "user").length;
  if (userMessageCount !== 1) {
    return undefined;
  }
  return input.messages.find(isThreadForkSummaryMessage);
}

function buildThreadForkSummarySeededTurnInput(input: {
  readonly summaryMessageText: string;
  readonly userMessageText: string;
}): string {
  return [
    "Context carried over from the forked source thread:",
    input.summaryMessageText,
    "",
    "New user request:",
    input.userMessageText,
  ].join("\n");
}

function readResumeSessionId(resumeCursor: unknown): string | undefined {
  if (!resumeCursor || typeof resumeCursor !== "object" || Array.isArray(resumeCursor)) {
    return undefined;
  }
  const raw =
    "resume" in resumeCursor
      ? resumeCursor.resume
      : "sessionId" in resumeCursor
        ? resumeCursor.sessionId
        : undefined;
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
}

function readCodexResumeThreadId(resumeCursor: unknown): string | undefined {
  if (!resumeCursor || typeof resumeCursor !== "object" || Array.isArray(resumeCursor)) {
    return undefined;
  }
  const raw = "threadId" in resumeCursor ? resumeCursor.threadId : undefined;
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
}

export function providerErrorLabel(value: string | undefined): string {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : "unknown";
}

export function providerErrorLabelFromInstanceHint(input: {
  readonly instanceId?: string | undefined;
  readonly modelSelectionInstanceId?: string | undefined;
  readonly sessionProvider?: string | undefined;
}): string {
  return providerErrorLabel(
    input.instanceId ?? input.modelSelectionInstanceId ?? input.sessionProvider,
  );
}

function canReplaceThreadTitle(currentTitle: string, titleSeed?: string): boolean {
  const trimmedCurrentTitle = currentTitle.trim();
  if (trimmedCurrentTitle === DEFAULT_THREAD_TITLE) {
    return true;
  }

  const trimmedTitleSeed = titleSeed?.trim();
  return trimmedTitleSeed !== undefined && trimmedTitleSeed.length > 0
    ? trimmedCurrentTitle === trimmedTitleSeed
    : false;
}

function findProviderAdapterRequestError(
  cause: Cause.Cause<ProviderServiceError>,
): ProviderAdapterRequestError | undefined {
  const failReason = cause.reasons.find(Cause.isFailReason);
  return isProviderAdapterRequestError(failReason?.error) ? failReason.error : undefined;
}

function isUnknownPendingApprovalRequestError(cause: Cause.Cause<ProviderServiceError>): boolean {
  const error = findProviderAdapterRequestError(cause);
  if (error) {
    const detail = error.detail.toLowerCase();
    return (
      detail.includes("unknown pending approval request") ||
      detail.includes("unknown pending permission request")
    );
  }
  const message = Cause.pretty(cause);
  return (
    message.includes("unknown pending approval request") ||
    message.includes("unknown pending permission request")
  );
}

function isUnknownPendingUserInputRequestError(cause: Cause.Cause<ProviderServiceError>): boolean {
  const error = findProviderAdapterRequestError(cause);
  if (error) {
    return error.detail.toLowerCase().includes("unknown pending user-input request");
  }
  return Cause.pretty(cause).toLowerCase().includes("unknown pending user-input request");
}

function stalePendingRequestDetail(
  requestKind: "approval" | "user-input",
  requestId: string,
): string {
  return `Stale pending ${requestKind} request: ${requestId}. Provider callback state does not survive app restarts or recovered sessions. Restart the turn to continue.`;
}

function buildGeneratedWorktreeBranchName(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/^refs\/heads\//, "")
    .replace(/['"`]/g, "");

  const withoutPrefix = normalized.startsWith(`${WORKTREE_BRANCH_PREFIX}/`)
    ? normalized.slice(`${WORKTREE_BRANCH_PREFIX}/`.length)
    : normalized;

  const branchFragment = withoutPrefix
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/-+/g, "-")
    .replace(/^[./_-]+|[./_-]+$/g, "")
    .slice(0, 64)
    .replace(/[./_-]+$/g, "");

  const safeFragment = branchFragment.length > 0 ? branchFragment : "update";
  return `${WORKTREE_BRANCH_PREFIX}/${safeFragment}`;
}

type CodexForkCursorSourceTurn = CodexForkResumeCursor["sourceTurns"][number];
type CodexForkCursorAnchor = CodexForkResumeCursor["anchor"];

function toOrderedCodexSourceTurns(
  turns: ReadonlyArray<ProjectionTurn>,
): ReadonlyArray<ProjectionTurn & { readonly turnId: TurnId }> {
  return turns
    .filter((turn): turn is ProjectionTurn & { readonly turnId: TurnId } => turn.turnId !== null)
    .toSorted((left, right) => {
      const requested = left.requestedAt.localeCompare(right.requestedAt);
      return requested !== 0 ? requested : String(left.turnId).localeCompare(String(right.turnId));
    });
}

function toCodexForkCursorSourceTurns(
  turns: ReadonlyArray<ProjectionTurn & { readonly turnId: TurnId }>,
): ReadonlyArray<CodexForkCursorSourceTurn> {
  return turns.map((turn) => ({
    turnId: String(turn.turnId),
    state: turn.state,
    ...(turn.checkpointTurnCount !== null ? { checkpointTurnCount: turn.checkpointTurnCount } : {}),
  }));
}

function findCodexTurnForAssistantMessage(
  turns: ReadonlyArray<ProjectionTurn & { readonly turnId: TurnId }>,
  message: OrchestrationMessage,
): (ProjectionTurn & { readonly turnId: TurnId }) | undefined {
  if (message.turnId !== null) {
    const byMessageTurn = turns.find((turn) => turn.turnId === message.turnId);
    if (byMessageTurn) {
      return byMessageTurn;
    }
  }
  return turns.find((turn) => turn.assistantMessageId === message.id);
}

function checkpointFallbackForRetainedProjectionCount(
  turns: ReadonlyArray<ProjectionTurn & { readonly turnId: TurnId }>,
  retainedProjectionTurnCount: number,
): Pick<CodexForkCursorAnchor, "retainedCheckpointTurnCount" | "checkpointFallbackAllowed"> {
  if (retainedProjectionTurnCount === 0) {
    return {
      retainedCheckpointTurnCount: 0,
      checkpointFallbackAllowed: true,
    };
  }

  const retainedTurns = turns.slice(0, retainedProjectionTurnCount);
  const lastRetainedTurn = retainedTurns[retainedTurns.length - 1];
  const checkpointFallbackAllowed =
    retainedTurns.length === retainedProjectionTurnCount &&
    retainedTurns.every(
      (turn, index) => turn.state === "completed" && turn.checkpointTurnCount === index + 1,
    );
  return {
    ...(lastRetainedTurn?.checkpointTurnCount !== null &&
    lastRetainedTurn?.checkpointTurnCount !== undefined
      ? { retainedCheckpointTurnCount: lastRetainedTurn.checkpointTurnCount }
      : {}),
    checkpointFallbackAllowed,
  };
}

function codexForkAnchorAfterTurn(input: {
  readonly turn: ProjectionTurn & { readonly turnId: TurnId };
  readonly turns: ReadonlyArray<ProjectionTurn & { readonly turnId: TurnId }>;
}): CodexForkCursorAnchor {
  const retainedProjectionTurnCount = input.turns.findIndex((turn) => turn === input.turn) + 1;
  return {
    boundary: "after-turn",
    turnId: String(input.turn.turnId),
    ...checkpointFallbackForRetainedProjectionCount(input.turns, retainedProjectionTurnCount),
  };
}

function codexForkAnchorBeforeTurn(input: {
  readonly turn: ProjectionTurn & { readonly turnId: TurnId };
  readonly turns: ReadonlyArray<ProjectionTurn & { readonly turnId: TurnId }>;
}): CodexForkCursorAnchor {
  const retainedProjectionTurnCount = input.turns.findIndex((turn) => turn === input.turn);
  return {
    boundary: "before-turn",
    turnId: String(input.turn.turnId),
    ...checkpointFallbackForRetainedProjectionCount(input.turns, retainedProjectionTurnCount),
  };
}

function buildCodexForkCursor(input: {
  readonly sourceProviderThreadId: string;
  readonly sourceMessages: ReadonlyArray<OrchestrationMessage>;
  readonly forkMessageId: OrchestrationMessage["id"];
  readonly sourceTurns: ReadonlyArray<ProjectionTurn>;
}): CodexForkResumeCursor | undefined {
  const anchorIndex = input.sourceMessages.findIndex(
    (message) => message.id === input.forkMessageId,
  );
  const anchorMessage = input.sourceMessages[anchorIndex];
  if (!anchorMessage) {
    return undefined;
  }

  const orderedTurns = toOrderedCodexSourceTurns(input.sourceTurns);
  const sourceTurns = toCodexForkCursorSourceTurns(orderedTurns);

  const anchor: CodexForkCursorAnchor | undefined = (() => {
    if (anchorMessage.role === "assistant") {
      const turn = findCodexTurnForAssistantMessage(orderedTurns, anchorMessage);
      return turn
        ? codexForkAnchorAfterTurn({ turn, turns: orderedTurns })
        : {
            boundary: "after-turn",
            checkpointFallbackAllowed: false,
          };
    }

    const containingTurn = orderedTurns.find((turn) => turn.pendingMessageId === anchorMessage.id);
    if (containingTurn) {
      return codexForkAnchorBeforeTurn({ turn: containingTurn, turns: orderedTurns });
    }

    const previousAssistant = input.sourceMessages
      .slice(0, anchorIndex)
      .findLast((message) => message.role === "assistant");
    if (previousAssistant) {
      const previousTurn = findCodexTurnForAssistantMessage(orderedTurns, previousAssistant);
      return previousTurn
        ? codexForkAnchorAfterTurn({ turn: previousTurn, turns: orderedTurns })
        : {
            boundary: "after-turn",
            checkpointFallbackAllowed: false,
          };
    }

    return {
      boundary: "before-turn",
      retainedCheckpointTurnCount: 0,
      checkpointFallbackAllowed: true,
    };
  })();

  if (!anchor) {
    return undefined;
  }

  return {
    forkSession: true,
    sourceThreadId: input.sourceProviderThreadId,
    anchor,
    sourceTurns,
  };
}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const providerSessionDirectory = yield* ProviderSessionDirectory;
  const delamainAdapter = yield* DelamainAdapter;
  const projectionTurnRepository = yield* ProjectionTurnRepository;
  const gitWorkflow = yield* GitWorkflowService;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster;
  const textGeneration = yield* TextGeneration;
  const serverSettingsService = yield* ServerSettingsService;
  const serverCommandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));
  const serverEventId = () => crypto.randomUUIDv4.pipe(Effect.map(EventId.make));
  const handledTurnStartKeys = yield* Cache.make<string, true>({
    capacity: HANDLED_TURN_START_KEY_MAX,
    timeToLive: HANDLED_TURN_START_KEY_TTL,
    lookup: () => Effect.succeed(true),
  });

  const hasHandledTurnStartRecently = (key: string) =>
    Cache.getOption(handledTurnStartKeys, key).pipe(
      Effect.flatMap((cached) =>
        Cache.set(handledTurnStartKeys, key, true).pipe(Effect.as(Option.isSome(cached))),
      ),
    );

  const threadModelSelections = new Map<string, ModelSelection>();

  const appendProviderFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly kind:
      | "provider.turn.start.failed"
      | "provider.turn.interrupt.failed"
      | "provider.approval.respond.failed"
      | "provider.user-input.respond.failed"
      | "provider.session.stop.failed"
      | "thread.fork.summary.failed"
      | "thread.fork.failed";
    readonly summary: string;
    readonly detail: string;
    readonly turnId: TurnId | null;
    readonly createdAt: string;
    readonly requestId?: string;
  }) =>
    Effect.all({
      commandId: serverCommandId("provider-failure-activity"),
      eventId: serverEventId(),
    }).pipe(
      Effect.flatMap(({ commandId, eventId }) =>
        orchestrationEngine.dispatch(
          {
            type: "thread.activity.append",
            commandId,
            threadId: input.threadId,
            activity: {
              id: eventId,
              tone: "error",
              kind: input.kind,
              summary: input.summary,
              payload: {
                detail: input.detail,
                ...(input.requestId ? { requestId: input.requestId } : {}),
              },
              turnId: input.turnId,
              createdAt: input.createdAt,
            },
            createdAt: input.createdAt,
          },
          "server",
        ),
      ),
    );

  const formatFailureDetail = (cause: Cause.Cause<unknown>): string => {
    const failReason = cause.reasons.find(Cause.isFailReason);
    const providerError = isProviderAdapterRequestError(failReason?.error)
      ? failReason.error
      : undefined;
    if (providerError) {
      return providerError.detail;
    }
    return Cause.pretty(cause);
  };

  const setThreadSession = (input: {
    readonly threadId: ThreadId;
    readonly session: OrchestrationSession;
    readonly createdAt: string;
  }) =>
    serverCommandId("provider-session-set").pipe(
      Effect.flatMap((commandId) =>
        orchestrationEngine.dispatch(
          {
            type: "thread.session.set",
            commandId,
            threadId: input.threadId,
            session: input.session,
            createdAt: input.createdAt,
          },
          "server",
        ),
      ),
    );

  const setThreadSessionErrorOnTurnStartFailure = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly detail: string;
    readonly createdAt: string;
  }) {
    const thread = yield* resolveThread(input.threadId);
    const session = thread?.session;
    if (!session) {
      return;
    }
    yield* setThreadSession({
      threadId: input.threadId,
      session: {
        ...session,
        status: session.status === "stopped" ? "stopped" : "ready",
        activeTurnId: null,
        lastError: input.detail,
        updatedAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });
  });

  const resolveProject = Effect.fnUntraced(function* (projectId: ProjectId) {
    return yield* projectionSnapshotQuery
      .getProjectShellById(projectId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  const resolveThread = Effect.fnUntraced(function* (threadId: ThreadId) {
    return yield* projectionSnapshotQuery
      .getThreadDetailById(threadId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  const ensureSessionForThread = Effect.fn("ensureSessionForThread")(function* (
    threadId: ThreadId,
    createdAt: string,
    options?: {
      readonly modelSelection?: ModelSelection;
      readonly workPersonalFallbackAcknowledgedInstanceId?: ProviderInstanceId;
    },
  ) {
    const thread = yield* resolveThread(threadId);
    if (!thread) {
      return yield* Effect.die(new Error(`Thread '${threadId}' was not found in read model.`));
    }

    const desiredRuntimeMode = thread.runtimeMode;
    const requestedModelSelection = options?.modelSelection;
    const resolveActiveSession = (threadId: ThreadId) =>
      providerService
        .listSessions()
        .pipe(Effect.map((sessions) => sessions.find((session) => session.threadId === threadId)));

    const activeSession = yield* resolveActiveSession(threadId);
    const activeThreadSession =
      thread.session !== null && thread.session.status !== "stopped" && activeSession
        ? thread.session
        : null;
    if (
      activeThreadSession !== null &&
      activeSession !== undefined &&
      (activeThreadSession.providerInstanceId === undefined ||
        activeSession.providerInstanceId === undefined)
    ) {
      return yield* new ProviderAdapterRequestError({
        provider: providerErrorLabel(activeThreadSession.providerName ?? undefined),
        method: "thread.turn.start",
        detail: `Thread '${threadId}' has an active provider session without a provider instance id.`,
      });
    }
    const currentInstanceId =
      activeThreadSession !== null &&
      activeSession !== undefined &&
      activeSession.providerInstanceId !== undefined
        ? activeSession.providerInstanceId
        : thread.modelSelection.instanceId;
    const desiredModelSelection = requestedModelSelection ?? thread.modelSelection;
    const desiredInstanceId = desiredModelSelection.instanceId;
    const currentInfo = yield* providerService.getInstanceInfo(currentInstanceId).pipe(
      Effect.mapError(
        () =>
          new ProviderAdapterRequestError({
            provider: providerErrorLabelFromInstanceHint({
              instanceId: String(currentInstanceId),
              modelSelectionInstanceId: String(thread.modelSelection.instanceId),
              sessionProvider: thread.session?.providerName ?? undefined,
            }),
            method: "thread.turn.start",
            detail: `Thread '${threadId}' references unknown provider instance '${currentInstanceId}'. The instance is not configured in this build.`,
          }),
      ),
    );
    const desiredInfo = yield* providerService.getInstanceInfo(desiredInstanceId).pipe(
      Effect.mapError(
        () =>
          new ProviderAdapterRequestError({
            provider: providerErrorLabelFromInstanceHint({
              instanceId: String(desiredModelSelection.instanceId),
            }),
            method: "thread.turn.start",
            detail: `Requested provider instance '${desiredInstanceId}' is not configured in this build.`,
          }),
      ),
    );
    const desiredDriverKind = desiredInfo.driverKind;
    if (!isProviderDriverKind(desiredDriverKind)) {
      return yield* new ProviderAdapterRequestError({
        provider: providerErrorLabel(String(desiredDriverKind)),
        method: "thread.turn.start",
        detail: `Requested provider instance '${desiredInstanceId}' uses unknown provider driver '${desiredDriverKind}'. The driver is not installed in this build.`,
      });
    }
    const preferredProvider: ProviderDriverKind = desiredDriverKind;
    if (
      thread.session !== null &&
      requestedModelSelection !== undefined &&
      requestedModelSelection.instanceId !== currentInstanceId
    ) {
      if (currentInfo.driverKind !== desiredInfo.driverKind) {
        return yield* new ProviderAdapterRequestError({
          provider: preferredProvider,
          method: "thread.turn.start",
          detail: `Thread '${threadId}' is bound to driver '${currentInfo.driverKind}' and cannot switch to '${desiredInfo.driverKind}'.`,
        });
      }
      if (
        currentInfo.continuationIdentity.continuationKey !==
        desiredInfo.continuationIdentity.continuationKey
      ) {
        return yield* new ProviderAdapterRequestError({
          provider: preferredProvider,
          method: "thread.turn.start",
          detail: `Thread '${threadId}' cannot switch from instance '${currentInstanceId}' to '${desiredInstanceId}' because their provider resume state is incompatible.`,
        });
      }
    }
    const project = yield* resolveProject(thread.projectId);
    const effectiveCwd = resolveThreadWorkspaceCwd({
      thread,
      projects: project ? [project] : [],
    });

    const resolveWorkRoute = Effect.fnUntraced(function* (
      providerInstanceId: NonNullable<OrchestrationSession["workPersonalFallbackInstanceId"]>,
      driver: ProviderDriverKind,
    ) {
      if (driver !== "codex" && driver !== "cursor") {
        return { workProviderInstanceId: null, workPersonalFallbackInstanceId: null };
      }
      if (!project) {
        return yield* new ProviderAdapterRequestError({
          provider: driver,
          method: "thread.turn.start",
          detail: `Thread '${threadId}' cannot resolve its repository project before provider launch.`,
        });
      }
      if (
        thread.session?.providerInstanceId === providerInstanceId &&
        thread.session.workPersonalFallbackInstanceId === providerInstanceId
      ) {
        return {
          workProviderInstanceId: null,
          workPersonalFallbackInstanceId: thread.session.workPersonalFallbackInstanceId,
        };
      }
      if (
        thread.session?.providerInstanceId === providerInstanceId &&
        thread.session.workProviderInstanceId === providerInstanceId
      ) {
        return {
          workProviderInstanceId: thread.session.workProviderInstanceId,
          workPersonalFallbackInstanceId: null,
        };
      }

      const { repositoryProfiles } = yield* serverSettingsService.getSettings;
      const repositoryProfile = resolveRepositoryProfile({
        workspaceRoot: project.workspaceRoot,
        repositoryProfileOverride: project.repositoryProfileOverride,
        profiles: repositoryProfiles,
      });
      if (repositoryProfile !== "work") {
        return { workProviderInstanceId: null, workPersonalFallbackInstanceId: null };
      }

      const workInstanceId = resolveRepositoryProviderInstance({
        repositoryProfile: "work",
        driver,
        profiles: repositoryProfiles,
      });
      const personalInstanceId = resolveRepositoryProviderInstance({
        repositoryProfile: "personal",
        driver,
        profiles: repositoryProfiles,
      });
      if (providerInstanceId === personalInstanceId) {
        if (options?.workPersonalFallbackAcknowledgedInstanceId !== providerInstanceId) {
          return yield* new ProviderAdapterRequestError({
            provider: driver,
            method: "thread.turn.start",
            detail: `Confirm the configured Personal account '${providerInstanceId}' before starting this Work session, then retry.`,
          });
        }
        return { workProviderInstanceId: null, workPersonalFallbackInstanceId: providerInstanceId };
      }
      if (providerInstanceId === workInstanceId) {
        return { workProviderInstanceId: providerInstanceId, workPersonalFallbackInstanceId: null };
      }
      return yield* new ProviderAdapterRequestError({
        provider: driver,
        method: "thread.turn.start",
        detail: `Requested provider instance '${providerInstanceId}' is not configured as the Work or Personal ${driver} account for this Work repository.`,
      });
    });

    const startProviderSession = (input?: {
      readonly resumeCursor?: unknown;
      readonly provider?: ProviderDriverKind;
    }) =>
      providerService.startSession(threadId, {
        threadId,
        ...(preferredProvider ? { provider: preferredProvider } : {}),
        providerInstanceId: desiredInstanceId,
        ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
        modelSelection: desiredModelSelection,
        ...(input?.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
        runtimeMode: desiredRuntimeMode,
      });

    const bindSessionToThread = (
      session: ProviderSession,
      workRoute: {
        readonly workProviderInstanceId: ProviderInstanceId | null;
        readonly workPersonalFallbackInstanceId: OrchestrationSession["workPersonalFallbackInstanceId"];
      },
    ) =>
      Effect.gen(function* () {
        if (session.providerInstanceId === undefined) {
          return yield* new ProviderAdapterRequestError({
            provider: providerErrorLabel(session.provider),
            method: "thread.turn.start",
            detail: `Provider session '${session.threadId}' started without a provider instance id.`,
          });
        }
        yield* setThreadSession({
          threadId,
          session: {
            threadId,
            status: mapProviderSessionStatusToOrchestrationStatus(session.status),
            providerName: session.provider,
            providerInstanceId: session.providerInstanceId,
            ...(workRoute.workProviderInstanceId !== null
              ? { workProviderInstanceId: workRoute.workProviderInstanceId }
              : {}),
            workPersonalFallbackInstanceId: workRoute.workPersonalFallbackInstanceId,
            runtimeMode: desiredRuntimeMode,
            // Provider turn ids are not orchestration turn ids.
            activeTurnId: null,
            lastError: session.lastError ?? null,
            updatedAt: session.updatedAt,
          },
          createdAt,
        });
      });

    const existingSessionThreadId =
      thread.session && thread.session.status !== "stopped" && activeSession ? thread.id : null;
    if (existingSessionThreadId) {
      const runtimeModeChanged = thread.runtimeMode !== thread.session?.runtimeMode;
      const cwdChanged = effectiveCwd !== activeSession?.cwd;
      const sessionModelSwitch = (yield* providerService.getCapabilities(desiredInstanceId))
        .sessionModelSwitch;
      const modelChanged =
        requestedModelSelection !== undefined &&
        requestedModelSelection.model !== activeSession?.model;
      const instanceChanged =
        requestedModelSelection !== undefined &&
        activeSession?.providerInstanceId !== requestedModelSelection.instanceId;
      const shouldRestartForModelChange = modelChanged && sessionModelSwitch === "unsupported";
      const previousModelSelection = threadModelSelections.get(threadId);
      const shouldRestartForModelSelectionChange =
        preferredProvider === "claudeAgent" &&
        requestedModelSelection !== undefined &&
        !Equal.equals(previousModelSelection, requestedModelSelection);
      const workRoute = yield* resolveWorkRoute(desiredInstanceId, preferredProvider);

      if (
        !runtimeModeChanged &&
        !cwdChanged &&
        !instanceChanged &&
        !shouldRestartForModelChange &&
        !shouldRestartForModelSelectionChange
      ) {
        if (
          (thread.session?.workProviderInstanceId !==
            (workRoute.workProviderInstanceId ?? undefined) ||
            thread.session?.workPersonalFallbackInstanceId !==
              workRoute.workPersonalFallbackInstanceId) &&
          activeSession !== undefined
        ) {
          yield* bindSessionToThread(activeSession, workRoute);
        }
        return existingSessionThreadId;
      }

      const resumeCursor = shouldRestartForModelChange
        ? undefined
        : (activeSession?.resumeCursor ?? undefined);
      yield* Effect.logInfo("provider command reactor restarting provider session", {
        threadId,
        existingSessionThreadId,
        currentProvider: activeSession?.provider,
        currentInstanceId,
        desiredInstanceId,
        desiredProvider: desiredModelSelection.instanceId,
        currentRuntimeMode: thread.session?.runtimeMode,
        desiredRuntimeMode: thread.runtimeMode,
        runtimeModeChanged,
        previousCwd: activeSession?.cwd,
        desiredCwd: effectiveCwd,
        cwdChanged,
        modelChanged,
        instanceChanged,
        shouldRestartForModelChange,
        shouldRestartForModelSelectionChange,
        hasResumeCursor: resumeCursor !== undefined,
      });
      const restartedSession = yield* startProviderSession(
        resumeCursor !== undefined ? { resumeCursor } : undefined,
      );
      yield* Effect.logInfo("provider command reactor restarted provider session", {
        threadId,
        previousSessionId: existingSessionThreadId,
        restartedSessionThreadId: restartedSession.threadId,
        provider: restartedSession.provider,
        runtimeMode: restartedSession.runtimeMode,
        cwd: restartedSession.cwd,
      });
      yield* bindSessionToThread(restartedSession, workRoute);
      return restartedSession.threadId;
    }

    const workRoute = yield* resolveWorkRoute(desiredInstanceId, preferredProvider);
    const startedSession = yield* startProviderSession(undefined);
    yield* bindSessionToThread(startedSession, workRoute);
    return startedSession.threadId;
  });

  // R5 cross-provider context replay. Returns the rendered inbox seed to prepend,
  // or undefined for a strict no-op (non-peer thread, no unseen messages). Only
  // spawns the delamain CLI for threads whose worktreePath matches a peer.
  const buildPeerInboxContextSeedForTurn = Effect.fnUntraced(function* (thread: {
    readonly id: ThreadId;
    readonly worktreePath: string | null;
    readonly modelSelection: ModelSelection;
  }) {
    const worktreePath = thread.worktreePath;
    if (!worktreePath) {
      return { seed: undefined, commitWatermark: Effect.void };
    }
    const binding = Option.getOrUndefined(yield* providerSessionDirectory.getBinding(thread.id));
    const runtimePayload =
      binding?.runtimePayload &&
      typeof binding.runtimePayload === "object" &&
      !Array.isArray(binding.runtimePayload)
        ? (binding.runtimePayload as Record<string, unknown>)
        : {};
    const cachedPeerId =
      typeof runtimePayload.r5PeerId === "string" ? runtimePayload.r5PeerId : undefined;
    const coveredMessageId =
      typeof runtimePayload.r5CoveredMessageId === "string"
        ? runtimePayload.r5CoveredMessageId
        : undefined;

    let peerId = cachedPeerId;
    let resolvedNewPeerId = false;
    if (!peerId) {
      const { peers } = yield* delamainAdapter.listPeers();
      const match = peers.find(
        (peer) => peer.worktreePath !== null && peer.worktreePath === worktreePath,
      );
      if (!match) {
        return { seed: undefined, commitWatermark: Effect.void };
      }
      peerId = match.id;
      resolvedNewPeerId = true;
    }

    const persistRuntimePayload = (payload: Record<string, unknown>) => {
      if (!binding) {
        // ponytail: no bound provider-session row to attach the watermark to;
        // skip the write (re-seeds next turn). A turn always binds a session
        // first (startSession upserts the directory), so this only trips in
        // degenerate states.
        return Effect.void;
      }
      return providerSessionDirectory.upsert({
        threadId: thread.id,
        provider: binding.provider,
        providerInstanceId: binding.providerInstanceId ?? thread.modelSelection.instanceId,
        runtimePayload: payload,
      });
    };

    const inbox = yield* delamainAdapter.readInbox({ peerId, includeDelivered: true }).pipe(
      // R5 self-heal: a cached r5PeerId that no longer resolves (delamain state
      // reset) makes readInbox fail every turn. Clear the stale cache so the next
      // turn re-correlates via listPeers, then let the failure propagate (the
      // call-site catch degrades this turn to no seed).
      Effect.tapError(() =>
        !resolvedNewPeerId ? persistRuntimePayload({ r5PeerId: null }) : Effect.void,
      ),
    );
    const messages = inbox.messages;
    // Watermark: everything AFTER the covered id is unseen. Unknown/absent id → all unseen.
    const coveredIndex = coveredMessageId
      ? messages.findIndex((message) => message.id === coveredMessageId)
      : -1;
    const unseen = messages.slice(coveredIndex + 1);

    if (unseen.length === 0) {
      if (resolvedNewPeerId) {
        // Cache the correlation so later turns skip listPeers.
        yield* persistRuntimePayload({ r5PeerId: peerId });
      }
      return { seed: undefined, commitWatermark: Effect.void };
    }

    const newestSeededId = unseen[unseen.length - 1]!.id;
    // The correlation cache is non-lossy: persist r5PeerId now so a turn that
    // fails to send doesn't force a listPeers re-resolve next turn.
    if (resolvedNewPeerId) {
      yield* persistRuntimePayload({ r5PeerId: peerId });
    }
    // R5/E2: defer the watermark advance until AFTER the turn sends. A turn that
    // fails to send leaves r5CoveredMessageId put, so these messages re-seed next
    // turn (benign) instead of being marked covered without ever being injected.
    const commitWatermark = persistRuntimePayload({
      r5PeerId: peerId,
      r5CoveredMessageId: newestSeededId,
    });
    return { seed: renderPeerInboxContextSeed(unseen), commitWatermark };
  });

  const buildSendTurnRequestForThread = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly messageText: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
    readonly modelSelection?: ModelSelection;
    readonly workPersonalFallbackAcknowledgedInstanceId?: ProviderInstanceId;
    readonly interactionMode?: "default" | "plan";
    readonly createdAt: string;
  }) {
    const thread = yield* resolveThread(input.threadId);
    if (!thread) {
      return yield* Effect.die(
        new Error(`Thread '${input.threadId}' was not found in read model.`),
      );
    }
    yield* ensureSessionForThread(input.threadId, input.createdAt, {
      ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
      ...(input.workPersonalFallbackAcknowledgedInstanceId !== undefined
        ? {
            workPersonalFallbackAcknowledgedInstanceId:
              input.workPersonalFallbackAcknowledgedInstanceId,
          }
        : {}),
    });
    if (input.modelSelection !== undefined) {
      threadModelSelections.set(input.threadId, input.modelSelection);
    }
    const summarySeedMessage = findThreadForkSummarySeedMessage({
      messages: thread.messages,
      parentThreadId: thread.parentThreadId,
    });
    const summarySeededText = summarySeedMessage
      ? buildThreadForkSummarySeededTurnInput({
          summaryMessageText: summarySeedMessage.text,
          userMessageText: input.messageText,
        })
      : input.messageText;
    // R5: prepend the delamain peer inbox messages this thread has not seen yet
    // (per-thread watermark). No delamain CLI spawn when the thread has no
    // worktreePath or an r5PeerId is cached; a worktree thread with no matching
    // peer pays one listPeers spawn per turn. Best-effort: any delamain error is
    // caught here and degrades to no seed — it NEVER aborts the provider turn.
    // Coexists with the summary seed.
    const peerInboxResult = yield* buildPeerInboxContextSeedForTurn(thread).pipe(
      Effect.catch((error) =>
        Effect.logWarning("R5 peer inbox seed skipped due to a delamain error", {
          threadId: input.threadId,
          error,
        }).pipe(Effect.as({ seed: undefined, commitWatermark: Effect.void })),
      ),
    );
    const providerMessageText = peerInboxResult.seed
      ? `${peerInboxResult.seed}\n\n${summarySeededText}`
      : summarySeededText;
    const normalizedInput = toNonEmptyProviderInput(providerMessageText);
    const normalizedAttachments = input.attachments ?? [];
    const activeSession = yield* providerService
      .listSessions()
      .pipe(
        Effect.map((sessions) => sessions.find((session) => session.threadId === input.threadId)),
      );
    const sessionModelSwitch =
      activeSession === undefined
        ? "in-session"
        : activeSession.providerInstanceId === undefined
          ? yield* new ProviderAdapterRequestError({
              provider: providerErrorLabel(activeSession.provider),
              method: "thread.turn.start",
              detail: `Active provider session '${activeSession.threadId}' is missing a provider instance id.`,
            })
          : (yield* providerService.getCapabilities(activeSession.providerInstanceId))
              .sessionModelSwitch;
    const requestedModelSelection =
      input.modelSelection ?? threadModelSelections.get(input.threadId) ?? thread.modelSelection;
    const modelForTurn =
      sessionModelSwitch === "unsupported" && input.modelSelection === undefined
        ? activeSession?.model !== undefined
          ? {
              ...requestedModelSelection,
              model: activeSession.model,
            }
          : requestedModelSelection
        : input.modelSelection;

    return {
      request: {
        threadId: input.threadId,
        ...(normalizedInput ? { input: normalizedInput } : {}),
        ...(normalizedAttachments.length > 0 ? { attachments: normalizedAttachments } : {}),
        ...(modelForTurn !== undefined ? { modelSelection: modelForTurn } : {}),
        ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
      },
      commitWatermark: peerInboxResult.commitWatermark,
    };
  });

  const maybeGenerateAndRenameWorktreeBranchForFirstTurn = Effect.fn(
    "maybeGenerateAndRenameWorktreeBranchForFirstTurn",
  )(function* (input: {
    readonly threadId: ThreadId;
    readonly branch: string | null;
    readonly worktreePath: string | null;
    readonly messageText: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
  }) {
    if (!input.branch || !input.worktreePath) {
      return;
    }
    if (!isTemporaryWorktreeBranch(input.branch)) {
      return;
    }

    const oldBranch = input.branch;
    const cwd = input.worktreePath;
    const attachments = input.attachments ?? [];
    yield* Effect.gen(function* () {
      const { textGenerationModelSelection: modelSelection } =
        yield* serverSettingsService.getSettings;

      const generated = yield* textGeneration.generateBranchName({
        cwd,
        message: input.messageText,
        ...(attachments.length > 0 ? { attachments } : {}),
        modelSelection,
      });
      if (!generated) return;

      const targetBranch = buildGeneratedWorktreeBranchName(generated.branch);
      if (targetBranch === oldBranch) return;

      const renamed = yield* gitWorkflow.renameBranch({ cwd, oldBranch, newBranch: targetBranch });
      yield* orchestrationEngine.dispatch(
        {
          type: "thread.meta.update",
          commandId: yield* serverCommandId("worktree-branch-rename"),
          threadId: input.threadId,
          branch: renamed.branch,
          worktreePath: cwd,
        },
        "server",
      );
      yield* vcsStatusBroadcaster.refreshStatus(cwd).pipe(Effect.ignoreCause({ log: true }));
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider command reactor failed to generate or rename worktree branch", {
          threadId: input.threadId,
          cwd,
          oldBranch,
          cause: Cause.pretty(cause),
        }),
      ),
    );
  });

  const maybeGenerateThreadTitleForFirstTurn = Effect.fn("maybeGenerateThreadTitleForFirstTurn")(
    function* (input: {
      readonly threadId: ThreadId;
      readonly cwd: string;
      readonly messageText: string;
      readonly attachments?: ReadonlyArray<ChatAttachment>;
      readonly titleSeed?: string;
    }) {
      const attachments = input.attachments ?? [];
      yield* Effect.gen(function* () {
        const { textGenerationModelSelection: modelSelection } =
          yield* serverSettingsService.getSettings;

        const generated = yield* textGeneration.generateThreadTitle({
          cwd: input.cwd,
          message: input.messageText,
          ...(attachments.length > 0 ? { attachments } : {}),
          modelSelection,
        });
        if (!generated) return;

        const thread = yield* resolveThread(input.threadId);
        if (!thread) return;
        if (!canReplaceThreadTitle(thread.title, input.titleSeed)) {
          return;
        }

        yield* orchestrationEngine.dispatch(
          {
            type: "thread.meta.update",
            commandId: yield* serverCommandId("thread-title-rename"),
            threadId: input.threadId,
            title: generated.title,
          },
          "server",
        );
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("provider command reactor failed to generate or rename thread title", {
            threadId: input.threadId,
            cwd: input.cwd,
            cause: Cause.pretty(cause),
          }),
        ),
      );
    },
  );

  const processTurnStartRequested = Effect.fn("processTurnStartRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-start-requested" }>,
  ) {
    const key = turnStartKeyForEvent(event);
    if (yield* hasHandledTurnStartRecently(key)) {
      return;
    }

    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }

    const message = thread.messages.find((entry) => entry.id === event.payload.messageId);
    if (!message || message.role !== "user") {
      yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.start.failed",
        summary: "Provider turn start failed",
        detail: `User message '${event.payload.messageId}' was not found for turn start request.`,
        turnId: null,
        createdAt: event.payload.createdAt,
      });
      return;
    }

    const isFirstUserMessageTurn =
      thread.messages.filter((entry) => entry.role === "user").length === 1;
    if (isFirstUserMessageTurn) {
      const project = yield* resolveProject(thread.projectId);
      const generationCwd =
        resolveThreadWorkspaceCwd({
          thread,
          projects: project ? [project] : [],
        }) ?? process.cwd();
      const generationInput = {
        messageText: message.text,
        ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
        ...(event.payload.titleSeed !== undefined ? { titleSeed: event.payload.titleSeed } : {}),
      };

      yield* maybeGenerateAndRenameWorktreeBranchForFirstTurn({
        threadId: event.payload.threadId,
        branch: thread.branch,
        worktreePath: thread.worktreePath,
        ...generationInput,
      }).pipe(Effect.forkScoped);

      if (canReplaceThreadTitle(thread.title, event.payload.titleSeed)) {
        yield* maybeGenerateThreadTitleForFirstTurn({
          threadId: event.payload.threadId,
          cwd: generationCwd,
          ...generationInput,
        }).pipe(Effect.forkScoped);
      }
    }

    const handleTurnStartFailure = (cause: Cause.Cause<unknown>) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.void;
      }
      const detail = formatFailureDetail(cause);
      return setThreadSessionErrorOnTurnStartFailure({
        threadId: event.payload.threadId,
        detail,
        createdAt: event.payload.createdAt,
      }).pipe(
        Effect.flatMap(() =>
          appendProviderFailureActivity({
            threadId: event.payload.threadId,
            kind: "provider.turn.start.failed",
            summary: "Provider turn start failed",
            detail,
            turnId: null,
            createdAt: event.payload.createdAt,
          }),
        ),
        Effect.asVoid,
      );
    };

    const recoverTurnStartFailure = (cause: Cause.Cause<unknown>) =>
      handleTurnStartFailure(cause).pipe(
        Effect.catchCause((recoveryCause) =>
          Effect.logWarning("provider command reactor failed to recover turn start failure", {
            eventType: event.type,
            threadId: event.payload.threadId,
            cause: Cause.pretty(recoveryCause),
            originalCause: Cause.pretty(cause),
          }),
        ),
      );

    const sendTurnRequest = yield* buildSendTurnRequestForThread({
      threadId: event.payload.threadId,
      messageText: message.text,
      ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
      ...(event.payload.modelSelection !== undefined
        ? { modelSelection: event.payload.modelSelection }
        : {}),
      ...(event.payload.workPersonalFallbackAcknowledgedInstanceId !== undefined
        ? {
            workPersonalFallbackAcknowledgedInstanceId:
              event.payload.workPersonalFallbackAcknowledgedInstanceId,
          }
        : {}),
      interactionMode: event.payload.interactionMode,
      createdAt: event.payload.createdAt,
    }).pipe(
      Effect.map(Option.some),
      Effect.catchCause((cause) => handleTurnStartFailure(cause).pipe(Effect.as(Option.none()))),
    );

    if (Option.isNone(sendTurnRequest)) {
      return;
    }

    yield* providerService.sendTurn(sendTurnRequest.value.request).pipe(
      // R5/E2: advance the watermark only after the turn actually sends.
      Effect.tap(() => sendTurnRequest.value.commitWatermark),
      Effect.catchCause(recoverTurnStartFailure),
      Effect.forkScoped,
    );
  });

  const processTurnInterruptRequested = Effect.fn("processTurnInterruptRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-interrupt-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }
    const hasSession = thread.session && thread.session.status !== "stopped";
    if (!hasSession) {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.interrupt.failed",
        summary: "Provider turn interrupt failed",
        detail: "No active provider session is bound to this thread.",
        turnId: event.payload.turnId ?? null,
        createdAt: event.payload.createdAt,
      });
    }

    // Orchestration turn ids are not provider turn ids, so interrupt by session.
    yield* providerService.interruptTurn({ threadId: event.payload.threadId });
  });

  const processApprovalResponseRequested = Effect.fn("processApprovalResponseRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.approval-response-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }
    const hasSession = thread.session && thread.session.status !== "stopped";
    if (!hasSession) {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.approval.respond.failed",
        summary: "Provider approval response failed",
        detail: "No active provider session is bound to this thread.",
        turnId: null,
        createdAt: event.payload.createdAt,
        requestId: event.payload.requestId,
      });
    }

    yield* providerService
      .respondToRequest({
        threadId: event.payload.threadId,
        requestId: event.payload.requestId,
        decision: event.payload.decision,
      })
      .pipe(
        Effect.catchCause((cause) =>
          appendProviderFailureActivity({
            threadId: event.payload.threadId,
            kind: "provider.approval.respond.failed",
            summary: "Provider approval response failed",
            detail: isUnknownPendingApprovalRequestError(cause)
              ? stalePendingRequestDetail("approval", event.payload.requestId)
              : Cause.pretty(cause),
            turnId: null,
            createdAt: event.payload.createdAt,
            requestId: event.payload.requestId,
          }),
        ),
      );
  });

  const processUserInputResponseRequested = Effect.fn("processUserInputResponseRequested")(
    function* (
      event: Extract<ProviderIntentEvent, { type: "thread.user-input-response-requested" }>,
    ) {
      const thread = yield* resolveThread(event.payload.threadId);
      if (!thread) {
        return;
      }
      const hasSession = thread.session && thread.session.status !== "stopped";
      if (!hasSession) {
        return yield* appendProviderFailureActivity({
          threadId: event.payload.threadId,
          kind: "provider.user-input.respond.failed",
          summary: "Provider user input response failed",
          detail: "No active provider session is bound to this thread.",
          turnId: null,
          createdAt: event.payload.createdAt,
          requestId: event.payload.requestId,
        });
      }

      yield* providerService
        .respondToUserInput({
          threadId: event.payload.threadId,
          requestId: event.payload.requestId,
          answers: event.payload.answers,
        })
        .pipe(
          Effect.catchCause((cause) =>
            appendProviderFailureActivity({
              threadId: event.payload.threadId,
              kind: "provider.user-input.respond.failed",
              summary: "Provider user input response failed",
              detail: isUnknownPendingUserInputRequestError(cause)
                ? stalePendingRequestDetail("user-input", event.payload.requestId)
                : Cause.pretty(cause),
              turnId: null,
              createdAt: event.payload.createdAt,
              requestId: event.payload.requestId,
            }),
          ),
        );
    },
  );

  const processSessionStopRequested = Effect.fn("processSessionStopRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.session-stop-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }

    const now = event.payload.createdAt;
    if (thread.session && thread.session.status !== "stopped") {
      yield* providerService.stopSession({ threadId: thread.id });
    }

    yield* setThreadSession({
      threadId: thread.id,
      session: {
        threadId: thread.id,
        status: "stopped",
        providerName: thread.session?.providerName ?? null,
        ...(thread.session?.providerInstanceId !== undefined
          ? { providerInstanceId: thread.session.providerInstanceId }
          : {}),
        ...(thread.session?.workProviderInstanceId !== undefined
          ? { workProviderInstanceId: thread.session.workProviderInstanceId }
          : {}),
        workPersonalFallbackInstanceId: thread.session?.workPersonalFallbackInstanceId ?? null,
        runtimeMode: thread.session?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
        activeTurnId: null,
        lastError: thread.session?.lastError ?? null,
        updatedAt: now,
      },
      createdAt: now,
    });
  });

  const setThreadForkSummarySessionState = (input: {
    readonly threadId: ThreadId;
    readonly runtimeMode: RuntimeMode;
    readonly status: OrchestrationSession["status"];
    readonly lastError: string | null;
    readonly createdAt: string;
  }) =>
    setThreadSession({
      threadId: input.threadId,
      session: {
        threadId: input.threadId,
        status: input.status,
        providerName: null,
        workPersonalFallbackInstanceId: null,
        runtimeMode: input.runtimeMode,
        activeTurnId: null,
        lastError: input.lastError,
        updatedAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });

  const appendThreadForkSummaryMessage = Effect.fn("appendThreadForkSummaryMessage")(
    function* (input: {
      readonly threadId: ThreadId;
      readonly text: string;
      readonly createdAt: string;
    }) {
      const uuid = yield* crypto.randomUUIDv4;
      const messageId = MessageId.make(`${input.threadId}:fork-summary:${uuid}`);
      yield* orchestrationEngine.dispatch(
        {
          type: "thread.message.assistant.delta",
          commandId: yield* serverCommandId("thread-fork-summary-delta"),
          threadId: input.threadId,
          messageId,
          delta: input.text,
          createdAt: input.createdAt,
        },
        "server",
      );
      yield* orchestrationEngine.dispatch(
        {
          type: "thread.message.assistant.complete",
          commandId: yield* serverCommandId("thread-fork-summary-complete"),
          threadId: input.threadId,
          messageId,
          createdAt: input.createdAt,
        },
        "server",
      );
    },
  );

  const processSummaryThreadForked = Effect.fn("processSummaryThreadForked")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.forked" }>,
  ) {
    const forkThreadId = ThreadId.make(String(event.aggregateId));
    const sourceThread = yield* resolveThread(event.payload.sourceThreadId);
    const forkThread = yield* resolveThread(forkThreadId);
    if (!sourceThread || !forkThread) {
      yield* Effect.logWarning("provider command reactor could not summarize fork", {
        sourceThreadId: event.payload.sourceThreadId,
        forkThreadId,
        reason: "missing-thread",
      });
      return;
    }

    yield* setThreadForkSummarySessionState({
      threadId: forkThread.id,
      runtimeMode: forkThread.runtimeMode,
      status: "starting",
      lastError: null,
      createdAt: event.occurredAt,
    });

    const prefixMessages = findThreadForkPrefix({
      sourceThread,
      messageId: event.payload.forkMessageId,
    });
    if (prefixMessages === undefined) {
      return yield* new TextGenerationError({
        operation: "generateThreadForkSummary",
        detail: `Message '${event.payload.forkMessageId}' does not belong to thread '${sourceThread.id}'.`,
      });
    }

    const seedPrompt = toOptionalTrimmedText(event.payload.seedPrompt);
    const project = yield* resolveProject(forkThread.projectId);
    const generationCwd =
      resolveThreadWorkspaceCwd({
        thread: forkThread,
        projects: project ? [project] : [],
      }) ?? process.cwd();
    const { textGenerationModelSelection: modelSelection } =
      yield* serverSettingsService.getSettings;
    const generated = yield* textGeneration.generateThreadForkSummary({
      cwd: generationCwd,
      transcript: renderThreadForkTranscript(prefixMessages),
      ...(seedPrompt ? { seedPrompt } : {}),
      modelSelection,
    });
    const summary = generated.summary.trim();
    if (!summary) {
      return yield* new TextGenerationError({
        operation: "generateThreadForkSummary",
        detail: "Text generation returned an empty fork summary.",
      });
    }

    yield* appendThreadForkSummaryMessage({
      threadId: forkThread.id,
      text: buildThreadForkSummaryMessage({ summary, seedPrompt }),
      createdAt: event.occurredAt,
    });
    yield* setThreadForkSummarySessionState({
      threadId: forkThread.id,
      runtimeMode: forkThread.runtimeMode,
      status: "stopped",
      lastError: null,
      createdAt: event.occurredAt,
    });
  });

  const recoverSummaryThreadForkFailure = Effect.fn("recoverSummaryThreadForkFailure")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.forked" }>,
    cause: Cause.Cause<unknown>,
  ) {
    const forkThreadId = ThreadId.make(String(event.aggregateId));
    const forkThread = yield* resolveThread(forkThreadId);
    if (!forkThread) {
      yield* Effect.logWarning("provider command reactor failed to recover summary fork failure", {
        forkThreadId,
        cause: Cause.pretty(cause),
      });
      return;
    }
    const failReason = cause.reasons.find(Cause.isFailReason);
    const detail = isTextGenerationError(failReason?.error)
      ? failReason.error.detail
      : formatFailureDetail(cause);
    yield* setThreadForkSummarySessionState({
      threadId: forkThread.id,
      runtimeMode: forkThread.runtimeMode,
      status: "error",
      lastError: detail,
      createdAt: event.occurredAt,
    });
    yield* appendProviderFailureActivity({
      threadId: forkThread.id,
      kind: "thread.fork.summary.failed",
      summary: "Thread fork summary failed",
      detail,
      turnId: null,
      createdAt: event.occurredAt,
    });
    yield* Effect.logWarning("provider command reactor failed to summarize fork", {
      sourceThreadId: event.payload.sourceThreadId,
      forkThreadId,
      cause: Cause.pretty(cause),
    });
  });

  const appendFullThreadForkFailureActivity = (input: {
    readonly event: Extract<ProviderIntentEvent, { type: "thread.forked" }>;
    readonly forkThreadId: ThreadId;
    readonly detail: string;
  }) =>
    // ponytail: surface the divergence without changing full-fork retry/session semantics.
    appendProviderFailureActivity({
      threadId: input.forkThreadId,
      kind: "thread.fork.failed",
      summary: "Thread fork context failed",
      detail: input.detail,
      turnId: null,
      createdAt: input.event.occurredAt,
    });

  const processThreadForked = Effect.fn("processThreadForked")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.forked" }>,
  ) {
    const forkThreadId = ThreadId.make(String(event.aggregateId));
    if (event.payload.mode === "summary") {
      yield* processSummaryThreadForked(event).pipe(
        Effect.catchCause((cause) => recoverSummaryThreadForkFailure(event, cause)),
        Effect.forkScoped,
      );
      return;
    }

    const sourceThread = yield* resolveThread(event.payload.sourceThreadId);
    const forkThread = yield* resolveThread(forkThreadId);
    if (!sourceThread || !forkThread) {
      return;
    }
    if (!supportsFullThreadFork(sourceThread)) {
      yield* Effect.logWarning("provider command reactor skipped unsupported fork provider", {
        sourceThreadId: sourceThread.id,
        forkThreadId,
        mode: event.payload.mode,
      });
      return;
    }

    const sourceBinding = Option.getOrUndefined(
      yield* providerSessionDirectory.getBinding(sourceThread.id),
    );
    if (!sourceBinding) {
      yield* Effect.logWarning("provider command reactor could not seed fork cursor", {
        sourceThreadId: sourceThread.id,
        forkThreadId,
        reason: "missing-source-provider-binding",
      });
      yield* appendFullThreadForkFailureActivity({
        event,
        forkThreadId: forkThread.id,
        detail:
          "Forked thread was created, but provider context could not be seeded because the source thread has no provider binding.",
      });
      return;
    }

    if (isCodexThreadForkProvider(sourceThread)) {
      const sourceProviderThreadId = readCodexResumeThreadId(sourceBinding.resumeCursor);
      if (!sourceProviderThreadId) {
        yield* Effect.logWarning("provider command reactor could not seed codex fork cursor", {
          sourceThreadId: sourceThread.id,
          forkThreadId,
          reason: "missing-source-provider-thread-id",
        });
        yield* appendFullThreadForkFailureActivity({
          event,
          forkThreadId: forkThread.id,
          detail:
            "Forked thread was created, but Codex context could not be seeded because the source provider thread id is missing.",
        });
        return;
      }

      const sourceTurns = yield* projectionTurnRepository.listByThreadId({
        threadId: sourceThread.id,
      });
      const forkCursor = buildCodexForkCursor({
        sourceProviderThreadId,
        sourceMessages: sourceThread.messages,
        forkMessageId: event.payload.forkMessageId,
        sourceTurns,
      });
      if (!forkCursor) {
        yield* Effect.logWarning("provider command reactor could not seed codex fork cursor", {
          sourceThreadId: sourceThread.id,
          forkThreadId,
          reason: "missing-fork-anchor",
        });
        yield* appendFullThreadForkFailureActivity({
          event,
          forkThreadId: forkThread.id,
          detail:
            "Forked thread was created, but Codex context could not be seeded because the fork anchor could not be resolved.",
        });
        return;
      }

      yield* providerSessionDirectory.upsert({
        threadId: forkThread.id,
        provider: sourceBinding.provider,
        providerInstanceId:
          sourceBinding.providerInstanceId ?? forkThread.modelSelection.instanceId,
        runtimeMode: forkThread.runtimeMode,
        status: "stopped",
        resumeCursor: forkCursor,
        runtimePayload: {
          cwd: forkThread.worktreePath,
          model: forkThread.modelSelection.model,
          modelSelection: forkThread.modelSelection,
          activeTurnId: null,
          lastError: null,
          lastRuntimeEvent: "thread.forked",
          lastRuntimeEventAt: event.occurredAt,
        },
      });
      return;
    }

    const sourceSessionId = readResumeSessionId(sourceBinding.resumeCursor);
    if (!sourceSessionId) {
      yield* Effect.logWarning("provider command reactor could not seed fork cursor", {
        sourceThreadId: sourceThread.id,
        forkThreadId,
        reason: "missing-source-resume-session-id",
      });
      yield* appendFullThreadForkFailureActivity({
        event,
        forkThreadId: forkThread.id,
        detail:
          "Forked thread was created, but provider context could not be seeded because the source resume session id is missing.",
      });
      return;
    }

    const anchor = resolveThreadForkAnchor({
      sourceThread,
      messageId: event.payload.forkMessageId,
    });
    if (anchor._tag === "missing-message" || anchor._tag === "unavailable") {
      yield* Effect.logWarning("provider command reactor could not seed fork cursor", {
        sourceThreadId: sourceThread.id,
        forkThreadId,
        reason: anchor._tag,
      });
      yield* appendFullThreadForkFailureActivity({
        event,
        forkThreadId: forkThread.id,
        detail:
          "Forked thread was created, but provider context could not be seeded because the fork anchor could not be resolved.",
      });
      return;
    }

    yield* providerSessionDirectory.upsert({
      threadId: forkThread.id,
      provider: sourceBinding.provider,
      providerInstanceId: sourceBinding.providerInstanceId ?? forkThread.modelSelection.instanceId,
      runtimeMode: forkThread.runtimeMode,
      status: "stopped",
      resumeCursor: {
        threadId: forkThread.id,
        resume: sourceSessionId,
        ...(anchor._tag === "provider-message"
          ? { resumeSessionAt: anchor.providerMessageId }
          : {}),
        forkSession: true,
      },
      runtimePayload: {
        cwd: forkThread.worktreePath,
        model: forkThread.modelSelection.model,
        modelSelection: forkThread.modelSelection,
        activeTurnId: null,
        lastError: null,
        lastRuntimeEvent: "thread.forked",
        lastRuntimeEventAt: event.occurredAt,
      },
    });
  });

  const processDomainEvent = Effect.fn("processDomainEvent")(function* (
    event: ProviderIntentEvent,
  ) {
    yield* Effect.annotateCurrentSpan({
      "orchestration.event_type": event.type,
      "orchestration.thread_id": threadIdForProviderIntentEvent(event),
      ...(event.commandId ? { "orchestration.command_id": event.commandId } : {}),
    });
    yield* increment(orchestrationEventsProcessedTotal, {
      eventType: event.type,
    });
    switch (event.type) {
      case "thread.runtime-mode-set": {
        const thread = yield* resolveThread(event.payload.threadId);
        if (!thread?.session || thread.session.status === "stopped") {
          return;
        }
        const cachedModelSelection = threadModelSelections.get(event.payload.threadId);
        yield* ensureSessionForThread(
          event.payload.threadId,
          event.occurredAt,
          cachedModelSelection !== undefined ? { modelSelection: cachedModelSelection } : {},
        );
        return;
      }
      case "thread.turn-start-requested":
        yield* processTurnStartRequested(event);
        return;
      case "thread.turn-interrupt-requested":
        yield* processTurnInterruptRequested(event);
        return;
      case "thread.approval-response-requested":
        yield* processApprovalResponseRequested(event);
        return;
      case "thread.user-input-response-requested":
        yield* processUserInputResponseRequested(event);
        return;
      case "thread.session-stop-requested":
        yield* processSessionStopRequested(event);
        return;
      case "thread.forked":
        yield* processThreadForked(event);
        return;
    }
  });

  const processDomainEventSafely = (event: ProviderIntentEvent) =>
    processDomainEvent(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("provider command reactor failed to process event", {
          eventType: event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processDomainEventSafely);

  const start: ProviderCommandReactorShape["start"] = Effect.fn("start")(function* () {
    const domainEvents = yield* orchestrationEngine.subscribeDomainEvents;
    const processEvent = Effect.fn("processEvent")(function* (event: OrchestrationEvent) {
      if (
        event.type === "thread.runtime-mode-set" ||
        event.type === "thread.turn-start-requested" ||
        event.type === "thread.turn-interrupt-requested" ||
        event.type === "thread.approval-response-requested" ||
        event.type === "thread.user-input-response-requested" ||
        event.type === "thread.session-stop-requested" ||
        event.type === "thread.forked"
      ) {
        return yield* worker.enqueue(event);
      }
    });

    yield* Effect.forkScoped(
      Stream.runForEach(Stream.fromSubscription(domainEvents), processEvent),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies ProviderCommandReactorShape;
});

export const ProviderCommandReactorLive = Layer.effect(ProviderCommandReactor, make).pipe(
  Layer.provide(ProjectionTurnRepositoryLive),
);
