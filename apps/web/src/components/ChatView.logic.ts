import {
  type ClientOrchestrationCommand,
  type CommandId,
  type EnvironmentId,
  isProviderDriverKind,
  type MessageId,
  ProjectId,
  type ModelSelection,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ScopedThreadRef,
  type ThreadForkedMode,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import type { RepositoryProfile, RepositoryProfilesSettings } from "@t3tools/contracts/settings";
import { resolveRepositoryProviderInstance } from "@t3tools/shared/repositoryProfiles";
import { type ChatMessage, type SessionPhase, type Thread, type ThreadSession } from "../types";
import {
  type ComposerImageAttachment,
  type DraftThreadState,
  hydrateImagesFromPersisted,
  type QueuedComposerMessage,
} from "../composerDraftStore";
import * as Schema from "effect/Schema";
import { selectThreadByRef, selectThreadExistsByRef, useStore } from "../store";
import {
  filterTerminalContextsWithText,
  stripInlineTerminalContextPlaceholders,
  type TerminalContextDraft,
} from "../lib/terminalContext";
import type { DraftThreadEnvMode } from "../composerDraftStore";

export const LAST_INVOKED_SCRIPT_BY_PROJECT_KEY = "t3code:last-invoked-script-by-project";
export const MAX_HIDDEN_MOUNTED_TERMINAL_THREADS = 10;
export const THREAD_FORK_MODE = "full" as const;

export const LastInvokedScriptByProjectSchema = Schema.Record(ProjectId, Schema.String);

export interface InteractiveSessionAccountRoute {
  readonly preferredInstanceId: ProviderInstanceId | null;
  readonly requiresExplicitSelection: boolean;
  readonly usesPersonalInstanceForWork: boolean;
  readonly requiresWorkPersonalConfirmation: boolean;
}

function isSelectableProviderInstance(
  instanceId: ProviderInstanceId | null | undefined,
  driver: ProviderDriverKind,
  instanceEntries: ReadonlyArray<{
    readonly instanceId: ProviderInstanceId;
    readonly driverKind: ProviderDriverKind;
    readonly enabled: boolean;
    readonly isAvailable: boolean;
  }>,
): boolean {
  return Boolean(
    instanceId &&
    instanceEntries.some(
      (entry) =>
        entry.instanceId === instanceId &&
        entry.driverKind === driver &&
        entry.enabled &&
        entry.isAvailable,
    ),
  );
}

export function resolveInteractiveSessionPreferredInstance(input: {
  readonly isNewDraft: boolean;
  readonly isFirstLaunch: boolean;
  readonly repositoryProfile: RepositoryProfile;
  readonly driver: ProviderDriverKind;
  readonly profiles: RepositoryProfilesSettings;
  readonly instanceEntries: ReadonlyArray<{
    readonly instanceId: ProviderInstanceId;
    readonly driverKind: ProviderDriverKind;
    readonly enabled: boolean;
    readonly isAvailable: boolean;
  }>;
}): ProviderInstanceId | null {
  if (!input.isNewDraft || !input.isFirstLaunch) return null;
  const configuredInstanceId = resolveRepositoryProviderInstance({
    repositoryProfile: input.repositoryProfile,
    driver: input.driver,
    profiles: input.profiles,
  });
  if (!configuredInstanceId) return null;
  return isSelectableProviderInstance(configuredInstanceId, input.driver, input.instanceEntries)
    ? configuredInstanceId
    : null;
}

export function resolveInteractiveSessionAccountRoute(input: {
  readonly isNewDraft: boolean;
  readonly isFirstLaunch: boolean;
  readonly repositoryProfile: RepositoryProfile;
  readonly driver: ProviderDriverKind;
  readonly explicitInstanceId: ProviderInstanceId | null | undefined;
  readonly selectedInstanceId: ProviderInstanceId | null | undefined;
  readonly preferredInstanceId?: ProviderInstanceId | null;
  readonly profiles: RepositoryProfilesSettings;
  readonly instanceEntries: ReadonlyArray<{
    readonly instanceId: ProviderInstanceId;
    readonly driverKind: ProviderDriverKind;
    readonly enabled: boolean;
    readonly isAvailable: boolean;
  }>;
}): InteractiveSessionAccountRoute {
  const preferredInstanceId =
    input.preferredInstanceId === undefined
      ? resolveInteractiveSessionPreferredInstance(input)
      : input.preferredInstanceId;
  const hasExplicitInstance =
    input.explicitInstanceId !== null && input.explicitInstanceId !== undefined;
  const hasSelectableExplicitInstance = isSelectableProviderInstance(
    input.explicitInstanceId,
    input.driver,
    input.instanceEntries,
  );
  const personalInstanceId = resolveRepositoryProviderInstance({
    repositoryProfile: "personal",
    driver: input.driver,
    profiles: input.profiles,
  });
  const usesPersonalInstanceForWork = Boolean(
    input.repositoryProfile === "work" &&
    (input.driver === "codex" || input.driver === "cursor") &&
    personalInstanceId &&
    input.selectedInstanceId === personalInstanceId,
  );

  return {
    preferredInstanceId,
    requiresExplicitSelection: Boolean(
      input.isFirstLaunch &&
      ((hasExplicitInstance && !hasSelectableExplicitInstance) ||
        (input.isNewDraft && !hasExplicitInstance && !preferredInstanceId)),
    ),
    usesPersonalInstanceForWork,
    requiresWorkPersonalConfirmation: input.isFirstLaunch && usesPersonalInstanceForWork,
  };
}

export function queuedMessageToComposerDraft(message: QueuedComposerMessage) {
  const images = hydrateImagesFromPersisted(message.attachments);
  if (images.length !== message.attachments.length) return null;
  return {
    prompt: message.rawPrompt,
    images,
    modelSelection: message.modelSelection,
    runtimeMode: message.runtimeMode,
    interactionMode: message.interactionMode,
  };
}

type ThreadForkCommand = Extract<ClientOrchestrationCommand, { type: "thread.fork" }>;

// ponytail: keep the old full-mode helper name so slice 5 can widen the
// command payload without redesigning the row action call sites.
export function buildFullThreadForkCommand(input: {
  commandId: CommandId;
  sourceThreadId: ThreadId;
  newThreadId: ThreadId;
  messageId: MessageId;
  mode?: ThreadForkedMode;
  seedPrompt?: string | undefined;
  createdAt: string;
}): ThreadForkCommand {
  const mode = input.mode ?? THREAD_FORK_MODE;
  const seedPrompt = mode === "summary" ? input.seedPrompt?.trim() : undefined;
  return {
    type: "thread.fork",
    commandId: input.commandId,
    threadId: input.sourceThreadId,
    newThreadId: input.newThreadId,
    messageId: input.messageId,
    mode,
    ...(seedPrompt ? { seedPrompt } : {}),
    createdAt: input.createdAt,
  };
}

export function deriveThreadForkPrefillPrompt(
  message: Pick<ChatMessage, "role" | "text">,
): string | null {
  return message.role === "user" ? message.text : null;
}

export function buildLocalDraftThread(
  threadId: ThreadId,
  draftThread: DraftThreadState,
  fallbackModelSelection: ModelSelection,
  error: string | null,
): Thread {
  return {
    id: threadId,
    environmentId: draftThread.environmentId,
    codexThreadId: null,
    projectId: draftThread.projectId,
    title: "New thread",
    modelSelection: fallbackModelSelection,
    runtimeMode: draftThread.runtimeMode,
    interactionMode: draftThread.interactionMode,
    session: null,
    messages: [],
    error,
    createdAt: draftThread.createdAt,
    archivedAt: null,
    latestTurn: null,
    branch: draftThread.branch,
    worktreePath: draftThread.worktreePath,
    turnDiffSummaries: [],
    activities: [],
    proposedPlans: [],
    visualPlans: [],
  };
}

export function shouldWriteThreadErrorToCurrentServerThread(input: {
  serverThread:
    | {
        environmentId: EnvironmentId;
        id: ThreadId;
      }
    | null
    | undefined;
  routeThreadRef: ScopedThreadRef;
  targetThreadId: ThreadId;
}): boolean {
  return Boolean(
    input.serverThread &&
    input.targetThreadId === input.routeThreadRef.threadId &&
    input.serverThread.environmentId === input.routeThreadRef.environmentId &&
    input.serverThread.id === input.targetThreadId,
  );
}

export function reconcileMountedTerminalThreadIds(input: {
  currentThreadIds: ReadonlyArray<string>;
  openThreadIds: ReadonlyArray<string>;
  activeThreadId: string | null;
  activeThreadTerminalOpen: boolean;
  maxHiddenThreadCount?: number;
}): string[] {
  const openThreadIdSet = new Set(input.openThreadIds);
  const hiddenThreadIds = input.currentThreadIds.filter(
    (threadId) => threadId !== input.activeThreadId && openThreadIdSet.has(threadId),
  );
  const maxHiddenThreadCount = Math.max(
    0,
    input.maxHiddenThreadCount ?? MAX_HIDDEN_MOUNTED_TERMINAL_THREADS,
  );
  const nextThreadIds =
    hiddenThreadIds.length > maxHiddenThreadCount
      ? hiddenThreadIds.slice(-maxHiddenThreadCount)
      : hiddenThreadIds;

  if (
    input.activeThreadId &&
    input.activeThreadTerminalOpen &&
    !nextThreadIds.includes(input.activeThreadId)
  ) {
    nextThreadIds.push(input.activeThreadId);
  }

  return nextThreadIds;
}

export function revokeBlobPreviewUrl(previewUrl: string | undefined): void {
  if (!previewUrl || typeof URL === "undefined" || !previewUrl.startsWith("blob:")) {
    return;
  }
  URL.revokeObjectURL(previewUrl);
}

export function revokeUserMessagePreviewUrls(message: ChatMessage): void {
  if (message.role !== "user" || !message.attachments) {
    return;
  }
  for (const attachment of message.attachments) {
    if (attachment.type !== "image") {
      continue;
    }
    revokeBlobPreviewUrl(attachment.previewUrl);
  }
}

export function collectUserMessageBlobPreviewUrls(message: ChatMessage): string[] {
  if (message.role !== "user" || !message.attachments) {
    return [];
  }
  const previewUrls: string[] = [];
  for (const attachment of message.attachments) {
    if (attachment.type !== "image") continue;
    if (!attachment.previewUrl || !attachment.previewUrl.startsWith("blob:")) continue;
    previewUrls.push(attachment.previewUrl);
  }
  return previewUrls;
}

export interface PullRequestDialogState {
  initialReference: string | null;
  key: number;
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("Could not read image data."));
    });
    reader.addEventListener("error", () => {
      reject(reader.error ?? new Error("Failed to read image."));
    });
    reader.readAsDataURL(file);
  });
}

export function resolveSendEnvMode(input: {
  requestedEnvMode: DraftThreadEnvMode;
  isGitRepo: boolean;
}): DraftThreadEnvMode {
  return input.isGitRepo ? input.requestedEnvMode : "local";
}

export function cloneComposerImageForRetry(
  image: ComposerImageAttachment,
): ComposerImageAttachment {
  if (typeof URL === "undefined" || !image.previewUrl.startsWith("blob:")) {
    return image;
  }
  try {
    return {
      ...image,
      previewUrl: URL.createObjectURL(image.file),
    };
  } catch {
    return image;
  }
}

export function deriveComposerSendState(options: {
  prompt: string;
  imageCount: number;
  terminalContexts: ReadonlyArray<TerminalContextDraft>;
}): {
  trimmedPrompt: string;
  sendableTerminalContexts: TerminalContextDraft[];
  expiredTerminalContextCount: number;
  hasSendableContent: boolean;
} {
  const trimmedPrompt = stripInlineTerminalContextPlaceholders(options.prompt).trim();
  const sendableTerminalContexts = filterTerminalContextsWithText(options.terminalContexts);
  const expiredTerminalContextCount =
    options.terminalContexts.length - sendableTerminalContexts.length;
  return {
    trimmedPrompt,
    sendableTerminalContexts,
    expiredTerminalContextCount,
    hasSendableContent:
      trimmedPrompt.length > 0 || options.imageCount > 0 || sendableTerminalContexts.length > 0,
  };
}

export function buildExpiredTerminalContextToastCopy(
  expiredTerminalContextCount: number,
  variant: "omitted" | "empty",
): { title: string; description: string } {
  const count = Math.max(1, Math.floor(expiredTerminalContextCount));
  const noun = count === 1 ? "Expired terminal context" : "Expired terminal contexts";
  if (variant === "empty") {
    return {
      title: `${noun} won't be sent`,
      description: "Remove it or re-add it to include terminal output.",
    };
  }
  return {
    title: `${noun} omitted from message`,
    description: "Re-add it if you want that terminal output included.",
  };
}

export function threadHasStarted(thread: Thread | null | undefined): boolean {
  return Boolean(
    thread && (thread.latestTurn !== null || thread.messages.length > 0 || thread.session !== null),
  );
}

// `threadProvider` is the open branded driver kind carried by the session.
// Unknown driver kinds degrade to `null` (i.e. "unlocked"), which is the safe
// rollback / fork behavior — the routing layer is the right place to surface
// "driver not installed" errors, not the lock state.
//
// `selectedProvider` takes the same open-string shape because the composer
// now tracks the picker selection as a `ProviderInstanceId` (e.g.
// `codex_personal`). Custom instance ids that don't directly match a
// registered driver resolve to `null` here, which matches the existing
// "unknown driver -> unlocked" semantics. Callers that want the lock to track
// a custom instance's underlying driver kind should resolve the instance id
// upstream and pass the correlated kind.
export function deriveLockedProvider(input: {
  thread: Thread | null | undefined;
  selectedProvider: string | null;
  threadProvider: string | null;
}): ProviderDriverKind | null {
  if (!threadHasStarted(input.thread)) {
    return null;
  }
  const sessionProvider = input.thread?.session?.provider ?? null;
  if (sessionProvider) {
    return sessionProvider;
  }
  const narrowedThreadProvider =
    input.threadProvider && isProviderDriverKind(input.threadProvider)
      ? input.threadProvider
      : null;
  const narrowedSelectedProvider =
    input.selectedProvider && isProviderDriverKind(input.selectedProvider)
      ? input.selectedProvider
      : null;
  return narrowedThreadProvider ?? narrowedSelectedProvider ?? null;
}

export async function waitForStartedServerThread(
  threadRef: ScopedThreadRef,
  timeoutMs = 1_000,
): Promise<boolean> {
  const getThread = () => selectThreadByRef(useStore.getState(), threadRef);
  const thread = getThread();

  if (threadHasStarted(thread)) {
    return true;
  }

  return await new Promise<boolean>((resolve) => {
    let settled = false;
    let timeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;
    const finish = (result: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutId !== null) {
        globalThis.clearTimeout(timeoutId);
      }
      unsubscribe();
      resolve(result);
    };

    const unsubscribe = useStore.subscribe((state) => {
      if (!threadHasStarted(selectThreadByRef(state, threadRef))) {
        return;
      }
      finish(true);
    });

    if (threadHasStarted(getThread())) {
      finish(true);
      return;
    }

    timeoutId = globalThis.setTimeout(() => {
      finish(false);
    }, timeoutMs);
  });
}

export async function waitForRegisteredServerThread(
  threadRef: ScopedThreadRef,
  timeoutMs = 1_000,
): Promise<boolean> {
  if (selectThreadExistsByRef(useStore.getState(), threadRef)) {
    return true;
  }

  return await new Promise<boolean>((resolve) => {
    let settled = false;
    let timeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;
    const finish = (result: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutId !== null) {
        globalThis.clearTimeout(timeoutId);
      }
      unsubscribe();
      resolve(result);
    };

    const unsubscribe = useStore.subscribe((state) => {
      if (!selectThreadExistsByRef(state, threadRef)) {
        return;
      }
      finish(true);
    });

    if (selectThreadExistsByRef(useStore.getState(), threadRef)) {
      finish(true);
      return;
    }

    timeoutId = globalThis.setTimeout(() => {
      finish(false);
    }, timeoutMs);
  });
}

export interface LocalDispatchSnapshot {
  startedAt: string;
  preparingWorktree: boolean;
  latestTurnTurnId: TurnId | null;
  latestTurnRequestedAt: string | null;
  latestTurnStartedAt: string | null;
  latestTurnCompletedAt: string | null;
  sessionOrchestrationStatus: ThreadSession["orchestrationStatus"] | null;
  sessionUpdatedAt: string | null;
}

export function createLocalDispatchSnapshot(
  activeThread: Thread | undefined,
  options?: { preparingWorktree?: boolean },
): LocalDispatchSnapshot {
  const latestTurn = activeThread?.latestTurn ?? null;
  const session = activeThread?.session ?? null;
  return {
    startedAt: new Date().toISOString(),
    preparingWorktree: Boolean(options?.preparingWorktree),
    latestTurnTurnId: latestTurn?.turnId ?? null,
    latestTurnRequestedAt: latestTurn?.requestedAt ?? null,
    latestTurnStartedAt: latestTurn?.startedAt ?? null,
    latestTurnCompletedAt: latestTurn?.completedAt ?? null,
    sessionOrchestrationStatus: session?.orchestrationStatus ?? null,
    sessionUpdatedAt: session?.updatedAt ?? null,
  };
}

export function hasServerAcknowledgedLocalDispatch(input: {
  localDispatch: LocalDispatchSnapshot | null;
  phase: SessionPhase;
  latestTurn: Thread["latestTurn"] | null;
  session: Thread["session"] | null;
  hasPendingApproval: boolean;
  hasPendingUserInput: boolean;
  threadError: string | null | undefined;
}): boolean {
  if (!input.localDispatch) {
    return false;
  }
  if (input.hasPendingApproval || input.hasPendingUserInput || Boolean(input.threadError)) {
    return true;
  }

  const latestTurn = input.latestTurn ?? null;
  const session = input.session ?? null;
  const latestTurnChanged =
    input.localDispatch.latestTurnTurnId !== (latestTurn?.turnId ?? null) ||
    input.localDispatch.latestTurnRequestedAt !== (latestTurn?.requestedAt ?? null) ||
    input.localDispatch.latestTurnStartedAt !== (latestTurn?.startedAt ?? null) ||
    input.localDispatch.latestTurnCompletedAt !== (latestTurn?.completedAt ?? null);

  if (input.phase === "running") {
    if (!latestTurnChanged) {
      return false;
    }
    if (latestTurn?.startedAt === null || latestTurn === null) {
      return false;
    }
    if (
      session?.activeTurnId !== undefined &&
      session.activeTurnId !== null &&
      latestTurn?.turnId !== session.activeTurnId
    ) {
      return false;
    }
    return true;
  }

  return (
    latestTurnChanged ||
    input.localDispatch.sessionOrchestrationStatus !== (session?.orchestrationStatus ?? null) ||
    input.localDispatch.sessionUpdatedAt !== (session?.updatedAt ?? null)
  );
}
