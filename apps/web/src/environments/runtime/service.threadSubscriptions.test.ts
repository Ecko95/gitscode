import { QueryClient } from "@tanstack/react-query";
import type { WsRpcClient } from "@t3tools/client-runtime";
import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadStreamItem,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockSubscribeThread = vi.fn();
const mockThreadUnsubscribe = vi.fn();
const mockCreateEnvironmentConnection = vi.fn();
const mockCreateWsRpcClient = vi.fn();
const mockWaitForSavedEnvironmentRegistryHydration = vi.fn();
const mockListSavedEnvironmentRecords = vi.fn();
const mockGetSavedEnvironmentRecord = vi.fn();
const mockReadSavedEnvironmentBearerToken = vi.fn();
const mockSavedEnvironmentRegistrySubscribe = vi.fn();
const mockGetPrimaryKnownEnvironment = vi.hoisted(() => vi.fn());
const mockFetchRemoteSessionState = vi.fn();
const mockResolveRemoteWebSocketConnectionUrl = vi.fn(async () => "ws://remote.example.test/ws");
const mockRemoteHttpRunPromise = vi.fn((effect: Promise<unknown>) => effect);
const mockConnectionReconnects: Array<ReturnType<typeof vi.fn>> = [];
let savedEnvironmentRegistryListener: (() => void) | null = null;

function MockWsTransport() {
  return undefined;
}

vi.mock("../primary", () => ({
  getPrimaryKnownEnvironment: mockGetPrimaryKnownEnvironment,
}));

vi.mock("../../lib/runtime", () => ({
  remoteHttpRuntime: {
    runPromise: mockRemoteHttpRunPromise,
  },
}));

vi.mock("./catalog", () => ({
  getSavedEnvironmentRecord: mockGetSavedEnvironmentRecord,
  hasSavedEnvironmentRegistryHydrated: vi.fn(() => true),
  listSavedEnvironmentRecords: mockListSavedEnvironmentRecords,
  persistSavedEnvironmentRecord: vi.fn(),
  readSavedEnvironmentBearerToken: mockReadSavedEnvironmentBearerToken,
  removeSavedEnvironmentBearerToken: vi.fn(),
  useSavedEnvironmentRegistryStore: {
    subscribe: mockSavedEnvironmentRegistrySubscribe,
    getState: () => ({
      upsert: vi.fn(),
      remove: vi.fn(),
      markConnected: vi.fn(),
      rename: vi.fn(),
    }),
  },
  useSavedEnvironmentRuntimeStore: {
    getState: () => ({
      ensure: vi.fn(),
      patch: vi.fn(),
      clear: vi.fn(),
    }),
  },
  waitForSavedEnvironmentRegistryHydration: mockWaitForSavedEnvironmentRegistryHydration,
  writeSavedEnvironmentBearerToken: vi.fn(),
}));

vi.mock("./connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./connection")>()),
  createEnvironmentConnection: mockCreateEnvironmentConnection,
}));

vi.mock("@t3tools/client-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@t3tools/client-runtime")>();
  const stubWsClient: WsRpcClient = {
    dispose: async () => undefined,
    reconnect: async () => undefined,
    isHeartbeatFresh: () => false,
    provider: {
      steerTurn: vi.fn(),
      generateFollowUpSuggestions: vi.fn(),
      codexAccountUsage: vi.fn(),
      consumeCodexResetCredit: vi.fn(),
      auth: {
        start: vi.fn(),
        get: vi.fn(),
        cancel: vi.fn(),
        submitCode: vi.fn(),
        logout: vi.fn(),
      },
    },
    orchestration: {
      dispatchCommand: vi.fn(),
      getTurnDiff: vi.fn(),
      getFullThreadDiff: vi.fn(),
      getArchivedShellSnapshot: vi.fn(),
      subscribeShell: vi.fn(() => () => undefined),
      subscribeThread: mockSubscribeThread,
    },
    terminal: {
      open: vi.fn(),
      attach: vi.fn(() => () => undefined),
      write: vi.fn(),
      resize: vi.fn(),
      clear: vi.fn(),
      restart: vi.fn(),
      close: vi.fn(),
      onEvent: vi.fn(() => () => undefined),
      onMetadata: vi.fn(() => () => undefined),
    },
    projects: {
      searchEntries: vi.fn(),
      writeFile: vi.fn(),
    },
    filesystem: {
      browse: vi.fn(),
    },
    sourceControl: {
      lookupRepository: vi.fn(),
      cloneRepository: vi.fn(),
      publishRepository: vi.fn(),
    },
    audio: {
      transcribe: vi.fn(),
    },
    shell: {
      openInEditor: vi.fn(),
      openInTerminal: vi.fn(),
    },
    vcs: {
      pull: vi.fn(),
      refreshStatus: vi.fn(),
      onStatus: vi.fn(() => () => undefined),
      listRefs: vi.fn(),
      createWorktree: vi.fn(),
      removeWorktree: vi.fn(),
      createRef: vi.fn(),
      switchRef: vi.fn(),
      init: vi.fn(),
    },
    git: {
      runStackedAction: vi.fn(),
      resolvePullRequest: vi.fn(),
      preparePullRequestThread: vi.fn(),
    },
    review: {
      getDiffPreview: vi.fn(),
    },
    crit: {
      ensureSidecar: vi.fn(),
      sidecarStatus: vi.fn(),
      releaseSidecar: vi.fn(),
    },
    browserPreview: {
      open: vi.fn(),
      status: vi.fn(),
      control: vi.fn(),
    },
    gits: {
      getCockpit: vi.fn(),
      devCommands: {
        list: vi.fn(),
        init: vi.fn(),
      },
      notes: {
        list: vi.fn(),
        read: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        remove: vi.fn(),
        sync: vi.fn(),
      },
      visualPlan: {
        mutate: vi.fn(),
      },
      delamain: {
        listPeers: vi.fn(),
        getPeerStatus: vi.fn(),
        readPeerLog: vi.fn(),
        spawnPeer: vi.fn(),
        killPeer: vi.fn(),
        sendPeerReply: vi.fn(),
        waitForPeer: vi.fn(),
        integratePeer: vi.fn(),
        messages: {
          inbox: vi.fn(),
          send: vi.fn(),
        },
      },
      openGsd: {
        getStatus: vi.fn(),
        initProject: vi.fn(),
        runAuto: vi.fn(),
      },
      automode: {
        getSnapshot: vi.fn(),
        updatePolicy: vi.fn(),
        enqueueGoal: vi.fn(),
        approveGoal: vi.fn(),
        rejectGoal: vi.fn(),
        dispatchGoal: vi.fn(),
        schedulerSnapshot: vi.fn(),
        schedulerSetConfig: vi.fn(),
        schedulerArm: vi.fn(),
        schedulerDisarm: vi.fn(),
        resumeDriver: vi.fn(),
      },
      capacity: {
        getSnapshot: vi.fn(),
      },
      hermes: {
        getStatus: vi.fn(),
        getConfig: vi.fn(),
        check: vi.fn(),
        setupCodexOAuth: vi.fn(),
        startAcpSession: vi.fn(),
        listSessions: vi.fn(),
        tailLog: vi.fn(),
        listProposals: vi.fn(),
        inspectGits: vi.fn(),
        chat: vi.fn(),
        decideProposal: vi.fn(),
        writeProjectContext: vi.fn(),
        draftFromProposal: vi.fn(),
        runSchedule: vi.fn(),
      },
    },
    server: {
      getConfig: vi.fn(),
      refreshProviders: vi.fn(),
      discoverSourceControl: vi.fn(),
      updateProvider: vi.fn(),
      upsertKeybinding: vi.fn(),
      removeKeybinding: vi.fn(),
      getSettings: vi.fn(),
      updateSettings: vi.fn(),
      subscribeConfig: vi.fn(() => () => undefined),
      subscribeLifecycle: vi.fn(() => () => undefined),
      subscribeAuthAccess: vi.fn(() => () => undefined),
      getTraceDiagnostics: vi.fn(),
      getProcessDiagnostics: vi.fn(),
      getProcessResourceHistory: vi.fn(),
      signalProcess: vi.fn(),
    },
  };
  return {
    ...actual,
    createWsRpcClient: vi.fn(() => stubWsClient),
    fetchRemoteSessionState: mockFetchRemoteSessionState,
    isRemoteEnvironmentAuthHttpError: vi.fn(() => false),
    resolveRemoteWebSocketConnectionUrl: mockResolveRemoteWebSocketConnectionUrl,
  };
});

vi.mock("../../rpc/wsTransport", () => ({
  WsTransport: MockWsTransport,
}));

function makeThreadShellSnapshot(params: {
  readonly threadId: ThreadId;
  readonly sessionStatus?:
    | "idle"
    | "starting"
    | "running"
    | "ready"
    | "interrupted"
    | "stopped"
    | "error";
  readonly hasPendingApprovals?: boolean;
  readonly hasPendingUserInput?: boolean;
  readonly hasActionableProposedPlan?: boolean;
}): OrchestrationShellSnapshot {
  const projectId = ProjectId.make("project-1");
  const turnId = TurnId.make("turn-1");

  return {
    snapshotSequence: 1,
    projects: [],
    updatedAt: "2026-04-13T00:00:00.000Z",
    threads: [
      {
        id: params.threadId,
        projectId,
        title: "Thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn:
          params.sessionStatus === "running"
            ? {
                turnId,
                state: "running",
                requestedAt: "2026-04-13T00:00:00.000Z",
                startedAt: "2026-04-13T00:00:01.000Z",
                completedAt: null,
                assistantMessageId: null,
              }
            : null,
        createdAt: "2026-04-13T00:00:00.000Z",
        updatedAt: "2026-04-13T00:00:00.000Z",
        archivedAt: null,
        session: params.sessionStatus
          ? {
              threadId: params.threadId,
              status: params.sessionStatus,
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: params.sessionStatus === "running" ? turnId : null,
              lastError: null,
              updatedAt: "2026-04-13T00:00:00.000Z",
            }
          : null,
        latestUserMessageAt: null,
        hasPendingApprovals: params.hasPendingApprovals ?? false,
        hasPendingUserInput: params.hasPendingUserInput ?? false,
        hasActionableProposedPlan: params.hasActionableProposedPlan ?? false,
      },
    ],
  };
}

function makeThreadDetailSnapshot(params: {
  readonly threadId: ThreadId;
  readonly messageId: string;
  readonly messageText: string;
  readonly snapshotSequence: number;
}): OrchestrationThreadStreamItem {
  const timestamp = "2026-04-13T00:00:00.000Z";

  return {
    kind: "snapshot",
    snapshot: {
      snapshotSequence: params.snapshotSequence,
      thread: {
        id: params.threadId,
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        archivedAt: null,
        deletedAt: null,
        session: null,
        messages: [
          {
            id: MessageId.make(params.messageId),
            role: "assistant",
            text: params.messageText,
            turnId: null,
            streaming: false,
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        ],
        proposedPlans: [],
        visualPlans: [],
        activities: [],
        checkpoints: [],
      },
    },
  };
}

describe("retainThreadDetailSubscription", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.clearAllMocks();
    mockGetPrimaryKnownEnvironment.mockReturnValue({
      id: "env-1",
      label: "Primary environment",
      source: "window-origin",
      target: {
        httpBaseUrl: "http://127.0.0.1:3000/",
        wsBaseUrl: "ws://127.0.0.1:3000/",
      },
      environmentId: EnvironmentId.make("env-1"),
    });

    mockThreadUnsubscribe.mockImplementation(() => undefined);
    mockSubscribeThread.mockImplementation(() => mockThreadUnsubscribe);
    mockCreateWsRpcClient.mockReturnValue({
      server: {
        getConfig: vi.fn(async () => ({
          environment: {
            environmentId: EnvironmentId.make("env-remote"),
            label: "Remote env",
            platform: { os: "darwin", arch: "arm64" },
            serverVersion: "0.0.0-test",
            capabilities: { repositoryIdentity: true },
          },
        })),
      },
      isHeartbeatFresh: vi.fn(() => true),
      orchestration: {
        subscribeThread: mockSubscribeThread,
      },
    });
    mockCreateEnvironmentConnection.mockImplementation((input) => {
      const reconnect = vi.fn(async () => undefined);
      mockConnectionReconnects.push(reconnect);
      queueMicrotask(() => {
        input.onConfigSnapshot?.({
          environment: {
            environmentId: input.knownEnvironment.environmentId,
            label: input.knownEnvironment.label,
            platform: { os: "darwin", arch: "arm64" },
            serverVersion: "0.0.0-test",
            capabilities: { repositoryIdentity: true },
          },
        });
      });
      return {
        kind: input.kind,
        environmentId: input.knownEnvironment.environmentId,
        knownEnvironment: input.knownEnvironment,
        client: input.client,
        ensureBootstrapped: vi.fn(async () => undefined),
        reconnect,
        dispose: vi.fn(async () => undefined),
      };
    });
    savedEnvironmentRegistryListener = null;
    mockSavedEnvironmentRegistrySubscribe.mockImplementation((listener: () => void) => {
      savedEnvironmentRegistryListener = listener;
      return () => {
        if (savedEnvironmentRegistryListener === listener) {
          savedEnvironmentRegistryListener = null;
        }
      };
    });
    mockWaitForSavedEnvironmentRegistryHydration.mockResolvedValue(undefined);
    mockListSavedEnvironmentRecords.mockReturnValue([]);
    mockGetSavedEnvironmentRecord.mockReturnValue(null);
    mockReadSavedEnvironmentBearerToken.mockResolvedValue(null);
    mockFetchRemoteSessionState.mockResolvedValue({
      authenticated: true,
      role: "client",
    });
    mockConnectionReconnects.length = 0;
  });

  afterEach(async () => {
    const { resetEnvironmentServiceForTests } = await import("./service");
    await resetEnvironmentServiceForTests();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("evicts idle detail payloads and reacquires them from a fresh snapshot", async () => {
    const capturedCallbacks: Array<(item: OrchestrationThreadStreamItem) => void> = [];
    mockSubscribeThread.mockImplementation(
      (_input: unknown, callback: (item: OrchestrationThreadStreamItem) => void) => {
        capturedCallbacks.push(callback);
        return mockThreadUnsubscribe;
      },
    );

    const { selectThreadByRef, useStore } = await import("~/store");
    const {
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-1");
    const threadRef = { environmentId, threadId };
    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();
    connectionInput.syncShellSnapshot(makeThreadShellSnapshot({ threadId }), environmentId);

    const releaseFirst = retainThreadDetailSubscription(environmentId, threadId);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);
    capturedCallbacks[0]?.(
      makeThreadDetailSnapshot({
        threadId,
        messageId: "message-stale",
        messageText: "stale cached payload",
        snapshotSequence: 1,
      }),
    );
    expect(selectThreadByRef(useStore.getState(), threadRef)?.messages).toMatchObject([
      { text: "stale cached payload" },
    ]);

    releaseFirst();
    expect(mockThreadUnsubscribe).not.toHaveBeenCalled();

    const releaseSecond = retainThreadDetailSubscription(environmentId, threadId);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);

    releaseSecond();
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    expect(mockThreadUnsubscribe).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(28 * 60 * 1000);
    expect(mockThreadUnsubscribe).toHaveBeenCalledTimes(1);
    expect(selectThreadByRef(useStore.getState(), threadRef)?.messages).toEqual([]);
    expect(selectThreadByRef(useStore.getState(), threadRef)?.title).toBe("Thread");
    expect(
      useStore.getState().environmentStateById[environmentId]?.sidebarThreadSummaryById[threadId]
        ?.title,
    ).toBe("Thread");

    const releaseThird = retainThreadDetailSubscription(environmentId, threadId);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(2);
    expect(selectThreadByRef(useStore.getState(), threadRef)?.messages).toEqual([]);
    capturedCallbacks[1]?.(
      makeThreadDetailSnapshot({
        threadId,
        messageId: "message-fresh",
        messageText: "fresh snapshot payload",
        snapshotSequence: 2,
      }),
    );
    expect(selectThreadByRef(useStore.getState(), threadRef)?.messages).toMatchObject([
      { text: "fresh snapshot payload" },
    ]);
    releaseThird();

    stop();
    await resetEnvironmentServiceForTests();
  });

  it("does not start the primary connection until the known environment has an id", async () => {
    mockGetPrimaryKnownEnvironment.mockReturnValue({
      id: "env-1",
      label: "Primary environment",
      source: "window-origin",
      target: {
        httpBaseUrl: "http://127.0.0.1:3000/",
        wsBaseUrl: "ws://127.0.0.1:3000/",
      },
    });
    const {
      listEnvironmentConnections,
      resetEnvironmentServiceForTests,
      startEnvironmentConnectionService,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());

    expect(mockCreateEnvironmentConnection).not.toHaveBeenCalled();
    expect(listEnvironmentConnections()).toEqual([]);

    stop();
    await resetEnvironmentServiceForTests();
  });

  it("keeps non-idle thread detail subscriptions attached until the thread becomes idle", async () => {
    const {
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-active");

    const connectionInput = mockCreateEnvironmentConnection.mock.calls[0]?.[0];
    expect(connectionInput).toBeDefined();

    connectionInput.syncShellSnapshot(
      makeThreadShellSnapshot({
        threadId,
        sessionStatus: "ready",
        hasPendingApprovals: true,
      }),
      environmentId,
    );

    const release = retainThreadDetailSubscription(environmentId, threadId);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);

    release();
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(mockThreadUnsubscribe).not.toHaveBeenCalled();

    connectionInput.applyShellEvent(
      {
        kind: "thread-upserted",
        sequence: 2,
        thread: makeThreadShellSnapshot({
          threadId,
          sessionStatus: "idle",
        }).threads[0]!,
      },
      environmentId,
    );

    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(mockThreadUnsubscribe).toHaveBeenCalledTimes(1);

    stop();
    await resetEnvironmentServiceForTests();
  });

  it("reattaches retained thread detail subscriptions after a saved environment reconnect replaces the client", async () => {
    const environmentId = EnvironmentId.make("env-remote");
    const threadId = ThreadId.make("thread-reconnect");
    const record = {
      environmentId,
      label: "Remote env",
      httpBaseUrl: "http://remote.example.test",
      wsBaseUrl: "ws://remote.example.test",
      createdAt: "2026-05-01T00:00:00.000Z",
      lastConnectedAt: "2026-05-01T00:00:00.000Z",
    };
    mockListSavedEnvironmentRecords.mockReturnValue([record]);
    mockGetSavedEnvironmentRecord.mockReturnValue(record);
    mockReadSavedEnvironmentBearerToken.mockResolvedValue("bearer-token");

    const {
      disconnectSavedEnvironment,
      listEnvironmentConnections,
      reconnectSavedEnvironment,
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    savedEnvironmentRegistryListener?.();
    await vi.waitFor(() => {
      expect(
        listEnvironmentConnections().some(
          (connection) => connection.environmentId === environmentId,
        ),
      ).toBe(true);
    });
    const createConnectionCallsBeforeReconnect = mockCreateEnvironmentConnection.mock.calls.length;

    const release = retainThreadDetailSubscription(environmentId, threadId);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);

    await disconnectSavedEnvironment(environmentId);
    expect(mockThreadUnsubscribe).toHaveBeenCalledTimes(1);
    expect(
      listEnvironmentConnections().some((connection) => connection.environmentId === environmentId),
    ).toBe(false);

    const reconnectPromise = reconnectSavedEnvironment(environmentId);
    await vi.advanceTimersByTimeAsync(200);
    await reconnectPromise;
    await vi.waitFor(() => {
      expect(mockCreateEnvironmentConnection).toHaveBeenCalledTimes(
        createConnectionCallsBeforeReconnect + 1,
      );
      expect(mockSubscribeThread).toHaveBeenCalledTimes(2);
    });

    release();
    stop();
    await resetEnvironmentServiceForTests();
  });

  it("keeps healthy environment streams connected when the browser resumes from the background", async () => {
    let visibilityState: DocumentVisibilityState = "visible";
    const documentTarget = new EventTarget();
    const windowTarget = new EventTarget();
    vi.stubGlobal("document", {
      addEventListener: documentTarget.addEventListener.bind(documentTarget),
      removeEventListener: documentTarget.removeEventListener.bind(documentTarget),
      get visibilityState() {
        return visibilityState;
      },
    });
    vi.stubGlobal("window", {
      addEventListener: windowTarget.addEventListener.bind(windowTarget),
      removeEventListener: windowTarget.removeEventListener.bind(windowTarget),
    });

    const { resetEnvironmentServiceForTests, startEnvironmentConnectionService } =
      await import("./service");
    mockCreateEnvironmentConnection.mockImplementation((input) => {
      const reconnect = vi.fn(async () => undefined);
      mockConnectionReconnects.push(reconnect);
      queueMicrotask(() => {
        input.onConfigSnapshot?.({
          environment: {
            environmentId: input.knownEnvironment.environmentId,
            label: input.knownEnvironment.label,
            platform: { os: "darwin", arch: "arm64" },
            serverVersion: "0.0.0-test",
            capabilities: { repositoryIdentity: true },
          },
        });
      });
      return {
        kind: input.kind,
        environmentId: input.knownEnvironment.environmentId,
        knownEnvironment: input.knownEnvironment,
        client: {
          ...input.client,
          isHeartbeatFresh: vi.fn(() => true),
        },
        ensureBootstrapped: vi.fn(async () => undefined),
        reconnect,
        dispose: vi.fn(async () => undefined),
      };
    });

    const stop = startEnvironmentConnectionService(new QueryClient());
    expect(mockConnectionReconnects).toHaveLength(1);

    visibilityState = "hidden";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    expect(mockConnectionReconnects[0]).not.toHaveBeenCalled();

    visibilityState = "visible";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    expect(mockConnectionReconnects[0]).not.toHaveBeenCalled();

    stop();
    await resetEnvironmentServiceForTests();
  });

  it("reconnects stale environment streams when the browser resumes from the background", async () => {
    let visibilityState: DocumentVisibilityState = "visible";
    const documentTarget = new EventTarget();
    const windowTarget = new EventTarget();
    vi.stubGlobal("document", {
      addEventListener: documentTarget.addEventListener.bind(documentTarget),
      removeEventListener: documentTarget.removeEventListener.bind(documentTarget),
      get visibilityState() {
        return visibilityState;
      },
    });
    vi.stubGlobal("window", {
      addEventListener: windowTarget.addEventListener.bind(windowTarget),
      removeEventListener: windowTarget.removeEventListener.bind(windowTarget),
    });
    mockCreateWsRpcClient.mockReturnValue({
      server: {
        getConfig: vi.fn(async () => ({
          environment: {
            environmentId: EnvironmentId.make("env-remote"),
            label: "Remote env",
            platform: { os: "darwin", arch: "arm64" },
            serverVersion: "0.0.0-test",
            capabilities: { repositoryIdentity: true },
          },
        })),
      },
      isHeartbeatFresh: vi.fn(() => false),
      orchestration: {
        subscribeThread: mockSubscribeThread,
      },
    });

    const { resetEnvironmentServiceForTests, startEnvironmentConnectionService } =
      await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    expect(mockConnectionReconnects).toHaveLength(1);

    visibilityState = "hidden";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    expect(mockConnectionReconnects[0]).not.toHaveBeenCalled();

    visibilityState = "visible";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    expect(mockConnectionReconnects[0]).toHaveBeenCalledTimes(1);

    stop();
    await resetEnvironmentServiceForTests();
  });

  it("evicts the oldest idle detail payload when the cache reaches capacity", async () => {
    const capturedCallbacks = new Map<ThreadId, (item: OrchestrationThreadStreamItem) => void>();
    mockSubscribeThread.mockImplementation(
      (
        input: { readonly threadId: ThreadId },
        callback: (item: OrchestrationThreadStreamItem) => void,
      ) => {
        capturedCallbacks.set(input.threadId, callback);
        return mockThreadUnsubscribe;
      },
    );
    const { selectThreadByRef, useStore } = await import("~/store");
    const {
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadIds = Array.from({ length: 33 }, (_, index) =>
      ThreadId.make(`thread-${index + 1}`),
    );

    for (const [index, threadId] of threadIds.entries()) {
      const release = retainThreadDetailSubscription(environmentId, threadId);
      capturedCallbacks.get(threadId)?.(
        makeThreadDetailSnapshot({
          threadId,
          messageId: `message-${index + 1}`,
          messageText: `payload-${index + 1}`,
          snapshotSequence: index + 1,
        }),
      );
      release();
      await vi.advanceTimersByTimeAsync(1);
    }

    expect(mockThreadUnsubscribe).toHaveBeenCalledTimes(1);
    expect(
      selectThreadByRef(useStore.getState(), {
        environmentId,
        threadId: threadIds[0]!,
      })?.messages,
    ).toEqual([]);
    expect(
      selectThreadByRef(useStore.getState(), {
        environmentId,
        threadId: threadIds[0]!,
      })?.title,
    ).toBe("Thread");
    expect(
      selectThreadByRef(useStore.getState(), {
        environmentId,
        threadId: threadIds[1]!,
      })?.messages,
    ).toMatchObject([{ text: "payload-2" }]);
    expect(
      selectThreadByRef(useStore.getState(), {
        environmentId,
        threadId: threadIds[32]!,
      })?.messages,
    ).toMatchObject([{ text: "payload-33" }]);

    stop();
    await resetEnvironmentServiceForTests();
  });

  it("disposes cached subscriptions and detail payloads when the environment service resets", async () => {
    const capturedCallbacks: Array<(item: OrchestrationThreadStreamItem) => void> = [];
    mockSubscribeThread.mockImplementation(
      (_input: unknown, callback: (item: OrchestrationThreadStreamItem) => void) => {
        capturedCallbacks.push(callback);
        return mockThreadUnsubscribe;
      },
    );
    const { selectThreadByRef, useStore } = await import("~/store");
    const {
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-2");

    const release = retainThreadDetailSubscription(environmentId, threadId);
    capturedCallbacks[0]?.(
      makeThreadDetailSnapshot({
        threadId,
        messageId: "message-reset",
        messageText: "reset payload",
        snapshotSequence: 1,
      }),
    );
    expect(
      selectThreadByRef(useStore.getState(), { environmentId, threadId })?.messages,
    ).toMatchObject([{ text: "reset payload" }]);
    release();

    await resetEnvironmentServiceForTests();
    expect(mockThreadUnsubscribe).toHaveBeenCalledTimes(1);
    expect(selectThreadByRef(useStore.getState(), { environmentId, threadId })?.messages).toEqual(
      [],
    );
    expect(selectThreadByRef(useStore.getState(), { environmentId, threadId })?.title).toBe(
      "Thread",
    );

    stop();
  });

  // W3.1: stale detail events (sequence ≤ snapshotSequence) arriving after a
  // resubscribe must be discarded; events with sequence > snapshotSequence apply.
  it("discards detail events whose sequence is at or below the latest snapshot sequence", async () => {
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-seq");

    // Capture the raw callback injected by subscribeThread so we can drive it directly.
    type StreamItem = Parameters<typeof mockSubscribeThread>[1] extends (item: infer I) => void
      ? I
      : never;
    let capturedCallback: ((item: StreamItem) => void) | null = null;
    mockSubscribeThread.mockImplementation((_input: unknown, cb: (item: StreamItem) => void) => {
      capturedCallback = cb;
      return mockThreadUnsubscribe;
    });

    // Spy on applyEnvironmentThreadDetailEvent to count how many events pass the gate.
    // We do this by wrapping the exported function — but since the module is mocked,
    // we instead spy on the store method that would be called for applied events.
    const { useStore } = await import("~/store");
    const applyEventsSpy = vi.spyOn(useStore.getState(), "applyOrchestrationEvents");

    const {
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    retainThreadDetailSubscription(environmentId, threadId);
    expect(capturedCallback).not.toBeNull();

    // Reset spy counts after subscription setup.
    applyEventsSpy.mockClear();

    // Deliver a snapshot with snapshotSequence=5.
    capturedCallback!({
      kind: "snapshot",
      snapshot: {
        snapshotSequence: 5,
        thread: {
          id: threadId,
          projectId: ProjectId.make("project-1"),
          title: "t",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          latestTurn: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          archivedAt: null,
          deletedAt: null,
          session: null,
          messages: [],
          proposedPlans: [],
          visualPlans: [],
          activities: [],
          checkpoints: [],
        },
      },
    } as StreamItem);

    // Stale event (sequence=3 ≤ snapshotSequence=5) — must be discarded.
    capturedCallback!({
      kind: "event",
      event: {
        sequence: 3,
        type: "thread.meta-updated",
        payload: { threadId, title: "stale-title", updatedAt: "2026-01-01T00:00:00.000Z" },
        occurredAt: "2026-01-01T00:00:00.000Z",
        eventId: "event-1",
        aggregateKind: "thread",
        aggregateId: threadId,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
      },
    } as StreamItem);

    // applyOrchestrationEvents must NOT have been called for the stale event.
    expect(applyEventsSpy).not.toHaveBeenCalled();

    // Fresh event (sequence=6 > snapshotSequence=5) — must be applied.
    capturedCallback!({
      kind: "event",
      event: {
        sequence: 6,
        type: "thread.meta-updated",
        payload: { threadId, title: "fresh-title", updatedAt: "2026-01-01T00:01:00.000Z" },
        occurredAt: "2026-01-01T00:01:00.000Z",
        eventId: "event-2",
        aggregateKind: "thread",
        aggregateId: threadId,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
      },
    } as StreamItem);

    // The fresh event must have reached applyOrchestrationEvents.
    expect(applyEventsSpy).toHaveBeenCalledTimes(1);

    stop();
    await resetEnvironmentServiceForTests();
  });

  // W4.4b/W1: contiguous events apply normally after snapshot; no resubscribe triggered.
  it("applies contiguous detail events after snapshot without triggering a resubscribe", async () => {
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-apply");

    type StreamItem = Parameters<typeof mockSubscribeThread>[1] extends (item: infer I) => void
      ? I
      : never;
    let capturedCallback: ((item: StreamItem) => void) | null = null;
    mockSubscribeThread.mockImplementation(
      (_input: unknown, cb: (item: StreamItem) => void, _options?: unknown) => {
        capturedCallback = cb;
        return mockThreadUnsubscribe;
      },
    );

    const { useStore } = await import("~/store");
    const applyEventsSpy = vi.spyOn(useStore.getState(), "applyOrchestrationEvents");

    const {
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    retainThreadDetailSubscription(environmentId, threadId);
    applyEventsSpy.mockClear();

    const makeThread = () => ({
      id: threadId,
      projectId: ProjectId.make("project-1"),
      title: "t",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      runtimeMode: "full-access" as const,
      interactionMode: "default" as const,
      branch: null,
      worktreePath: null,
      latestTurn: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      archivedAt: null,
      deletedAt: null,
      session: null,
      messages: [],
      proposedPlans: [],
      visualPlans: [],
      activities: [],
      checkpoints: [],
    });

    const makeEvent = (sequence: number, title = "t") => ({
      kind: "event" as const,
      event: {
        sequence,
        type: "thread.meta-updated" as const,
        payload: { threadId, title, updatedAt: "2026-01-01T00:00:00.000Z" },
        occurredAt: "2026-01-01T00:00:00.000Z",
        eventId: `e-${sequence}`,
        aggregateKind: "thread" as const,
        aggregateId: threadId,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
      },
    });

    // Snapshot at sequence 10.
    capturedCallback!({
      kind: "snapshot",
      snapshot: { snapshotSequence: 10, thread: makeThread() },
    } as StreamItem);

    // Events at 11, 12, 13 are contiguous with the snapshot floor.
    capturedCallback!(makeEvent(11) as StreamItem);
    capturedCallback!(makeEvent(12) as StreamItem);
    capturedCallback!(makeEvent(13) as StreamItem);

    // All three applied; subscribeThread called once (no resubscribe).
    expect(applyEventsSpy).toHaveBeenCalledTimes(3);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);

    stop();
    await resetEnvironmentServiceForTests();
  });

  // The server filters a global sequence stream by thread, so unrelated events
  // legitimately create gaps between relevant thread-detail events.
  it("applies non-contiguous relevant events without resubscribing", async () => {
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-gap");

    type StreamItem = Parameters<typeof mockSubscribeThread>[1] extends (item: infer I) => void
      ? I
      : never;
    const capturedCallbacks: Array<(item: StreamItem) => void> = [];
    mockSubscribeThread.mockImplementation(
      (_input: unknown, cb: (item: StreamItem) => void, _options?: unknown) => {
        capturedCallbacks.push(cb);
        return mockThreadUnsubscribe;
      },
    );

    const { useStore } = await import("~/store");
    const applyEventsSpy = vi.spyOn(useStore.getState(), "applyOrchestrationEvents");

    const {
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    retainThreadDetailSubscription(environmentId, threadId);
    applyEventsSpy.mockClear();

    const makeThread = () => ({
      id: threadId,
      projectId: ProjectId.make("project-1"),
      title: "t",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      runtimeMode: "full-access" as const,
      interactionMode: "default" as const,
      branch: null,
      worktreePath: null,
      latestTurn: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      archivedAt: null,
      deletedAt: null,
      session: null,
      messages: [],
      proposedPlans: [],
      visualPlans: [],
      activities: [],
      checkpoints: [],
    });

    const makeEvent = (sequence: number, title = "t") => ({
      kind: "event" as const,
      event: {
        sequence,
        type: "thread.meta-updated" as const,
        payload: { threadId, title, updatedAt: "2026-01-01T00:00:00.000Z" },
        occurredAt: "2026-01-01T00:00:00.000Z",
        eventId: `e-${sequence}`,
        aggregateKind: "thread" as const,
        aggregateId: threadId,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
      },
    });

    const firstCallback = capturedCallbacks[0]!;
    firstCallback({
      kind: "snapshot",
      snapshot: { snapshotSequence: 10, thread: makeThread() },
    } as StreamItem);

    firstCallback(makeEvent(11, "first relevant event") as StreamItem);
    expect(applyEventsSpy).toHaveBeenCalledTimes(1);

    firstCallback(makeEvent(13, "second relevant event") as StreamItem);
    expect(applyEventsSpy).toHaveBeenCalledTimes(2);
    expect(mockSubscribeThread).toHaveBeenCalledTimes(1);
    expect(mockThreadUnsubscribe).not.toHaveBeenCalled();

    stop();
    await resetEnvironmentServiceForTests();
  });

  // W2: server-side subscription failure (onEnd) backs off instead of looping synchronously.
  it("backs off and caps subscription failure resubscribes", async () => {
    const environmentId = EnvironmentId.make("env-1");
    const threadId = ThreadId.make("thread-failure");

    type StreamItem = Parameters<typeof mockSubscribeThread>[1] extends (item: infer I) => void
      ? I
      : never;
    type SubscribeOptions = Parameters<typeof mockSubscribeThread>[2];

    // Track callbacks and options across all subscribeThread calls.
    const capturedCallbacks: Array<(item: StreamItem) => void> = [];
    const capturedOptions: Array<SubscribeOptions> = [];
    mockSubscribeThread.mockImplementation(
      (_input: unknown, cb: (item: StreamItem) => void, options?: SubscribeOptions) => {
        capturedCallbacks.push(cb);
        capturedOptions.push(options);
        return mockThreadUnsubscribe;
      },
    );

    const { useStore } = await import("~/store");
    const applyEventsSpy = vi.spyOn(useStore.getState(), "applyOrchestrationEvents");

    const {
      retainThreadDetailSubscription,
      startEnvironmentConnectionService,
      resetEnvironmentServiceForTests,
    } = await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    retainThreadDetailSubscription(environmentId, threadId);

    const makeThread = () => ({
      id: threadId,
      projectId: ProjectId.make("project-1"),
      title: "t",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      runtimeMode: "full-access" as const,
      interactionMode: "default" as const,
      branch: null,
      worktreePath: null,
      latestTurn: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      archivedAt: null,
      deletedAt: null,
      session: null,
      messages: [],
      proposedPlans: [],
      visualPlans: [],
      activities: [],
      checkpoints: [],
    });

    const firstCallback = capturedCallbacks[0]!;

    // Seed snapshot at sequence 5.
    firstCallback({
      kind: "snapshot",
      snapshot: { snapshotSequence: 5, thread: makeThread() },
    } as StreamItem);
    applyEventsSpy.mockClear();

    const expectNextSubscribeAfter = async (optionIndex: number, delayMs: number) => {
      const expectedCallCount = optionIndex + 2;
      capturedOptions[optionIndex]?.onEnd?.(
        new Error("subscriber buffer overflow - resubscribe for fresh snapshot"),
      );
      capturedOptions[optionIndex]?.onEnd?.(new Error("duplicate end should not double-schedule"));
      expect(mockSubscribeThread).toHaveBeenCalledTimes(expectedCallCount - 1);
      await vi.advanceTimersByTimeAsync(delayMs - 1);
      expect(mockSubscribeThread).toHaveBeenCalledTimes(expectedCallCount - 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(mockSubscribeThread).toHaveBeenCalledTimes(expectedCallCount);
    };

    await expectNextSubscribeAfter(0, 1_000);
    await expectNextSubscribeAfter(1, 2_000);
    await expectNextSubscribeAfter(2, 4_000);
    await expectNextSubscribeAfter(3, 8_000);
    await expectNextSubscribeAfter(4, 16_000);
    await expectNextSubscribeAfter(5, 30_000);
    await expectNextSubscribeAfter(6, 30_000);

    const latestCallback = capturedCallbacks[7]!;
    latestCallback({
      kind: "snapshot",
      snapshot: { snapshotSequence: 20, thread: makeThread() },
    } as StreamItem);

    await expectNextSubscribeAfter(7, 1_000);
    expect(applyEventsSpy).not.toHaveBeenCalled();

    stop();
    await resetEnvironmentServiceForTests();
  });
});
