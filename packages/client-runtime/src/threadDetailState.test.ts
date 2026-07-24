import { AtomRegistry } from "effect/unstable/reactivity";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EventId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationThread,
  type OrchestrationThreadStreamItem,
} from "@t3tools/contracts";

import {
  createThreadDetailManager,
  type ThreadDetailClient,
  type ThreadDetailState,
} from "./threadDetailState.ts";

let atomRegistry = AtomRegistry.make();

function resetAtomRegistry() {
  atomRegistry.dispose();
  atomRegistry = AtomRegistry.make();
}

function registerListener<T>(listeners: Set<(event: T) => void>, listener: (event: T) => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const baseEventFields = {
  eventId: EventId.make("event-1"),
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
} as const;

const BASE_THREAD: OrchestrationThread = {
  id: ThreadId.make("thread-1"),
  projectId: ProjectId.make("project-1"),
  title: "Test Thread",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-01T00:00:00.000Z",
  archivedAt: null,
  deletedAt: null,
  messages: [],
  proposedPlans: [],
  visualPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
};

const TARGET = {
  environmentId: EnvironmentId.make("env-local"),
  threadId: ThreadId.make("thread-1"),
} as const;

function createMockClient(): {
  client: ThreadDetailClient;
  listeners: Set<(event: OrchestrationThreadStreamItem) => void>;
  emit: (event: OrchestrationThreadStreamItem) => void;
} {
  const listeners = new Set<(event: OrchestrationThreadStreamItem) => void>();
  const client: ThreadDetailClient = {
    subscribeThread: vi.fn((_input, listener: (event: OrchestrationThreadStreamItem) => void) =>
      registerListener(listeners, listener),
    ),
  };

  return {
    client,
    listeners,
    emit: (event) => {
      for (const listener of listeners) {
        listener(event);
      }
    },
  };
}

/**
 * Mock client that captures the onResubscribe callback so the test can
 * simulate a socket-kill + reconnect without real transports.
 *
 * In wsTransport, a transport-level reconnect does NOT re-call subscribeThread —
 * the same subscription listener continues receiving events on the new session.
 * onResubscribe fires (via streamRequestStartListeners) before the new snapshot
 * arrives, signaling that the subscription is resuming on a fresh connection.
 *
 * simulateSocketKill() mirrors that: fires onResubscribe (→ markPending in the
 * manager), then continues routing emit()s to the same listener (which will
 * receive the fresh completion snapshot next).
 */
function createReconnectAwareMockClient(): {
  client: ThreadDetailClient;
  /** Emit to the active subscription listener. */
  emit: (event: OrchestrationThreadStreamItem) => void;
  /**
   * Simulate a mid-turn WebSocket drop and reconnect.
   * Fires onResubscribe (transport signals pending state). Subsequent emit()
   * calls reach the same listener — the fresh snapshot arrives next.
   */
  simulateSocketKill: () => void;
} {
  const activeListeners = new Set<(event: OrchestrationThreadStreamItem) => void>();
  let savedOnResubscribe: (() => void) | null = null;

  const client: ThreadDetailClient = {
    subscribeThread: vi.fn(
      (
        _input,
        listener: (event: OrchestrationThreadStreamItem) => void,
        options?: { onResubscribe?: () => void; onEnd?: (error: unknown) => void },
      ) => {
        savedOnResubscribe = options?.onResubscribe ?? null;
        activeListeners.add(listener);
        return () => {
          activeListeners.delete(listener);
        };
      },
    ),
  };

  return {
    client,
    emit: (event) => {
      for (const listener of activeListeners) {
        listener(event);
      }
    },
    simulateSocketKill: () => {
      // Mirror wsTransport: onResubscribe fires on new-session open,
      // before the snapshot arrives. Same listener receives the snapshot.
      savedOnResubscribe?.();
    },
  };
}

describe("createThreadDetailManager", () => {
  afterEach(() => {
    vi.useRealTimers();
    resetAtomRegistry();
  });

  it("starts in a pending state when watching", () => {
    const { client } = createMockClient();
    const manager = createThreadDetailManager({
      getRegistry: () => atomRegistry,
      getClient: () => null,
    });

    manager.watch(TARGET, client);

    expect(manager.getSnapshot(TARGET)).toEqual({
      data: null,
      error: null,
      isPending: true,
      isDeleted: false,
    });
  });

  it("applies snapshots and incremental events", () => {
    const { client, emit } = createMockClient();
    const manager = createThreadDetailManager({
      getRegistry: () => atomRegistry,
      getClient: () => null,
    });

    const release = manager.watch(TARGET, client);

    emit({
      kind: "snapshot",
      snapshot: {
        snapshotSequence: 1,
        thread: BASE_THREAD,
      },
    });

    emit({
      kind: "event",
      event: {
        ...baseEventFields,
        sequence: 2,
        occurredAt: "2026-04-01T01:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.message-sent",
        payload: {
          threadId: ThreadId.make("thread-1"),
          turnId: TurnId.make("turn-1"),
          messageId: MessageId.make("message-1"),
          role: "assistant",
          text: "hello",
          streaming: false,
          createdAt: "2026-04-01T01:00:00.000Z",
          updatedAt: "2026-04-01T01:00:00.000Z",
        },
      } as any,
    });

    expect(manager.getSnapshot(TARGET)).toEqual({
      data: {
        ...BASE_THREAD,
        updatedAt: "2026-04-01T01:00:00.000Z",
        latestTurn: {
          turnId: TurnId.make("turn-1"),
          state: "completed",
          requestedAt: "2026-04-01T01:00:00.000Z",
          startedAt: "2026-04-01T01:00:00.000Z",
          completedAt: "2026-04-01T01:00:00.000Z",
          assistantMessageId: MessageId.make("message-1"),
        },
        messages: [
          {
            id: MessageId.make("message-1"),
            role: "assistant",
            text: "hello",
            turnId: TurnId.make("turn-1"),
            streaming: false,
            createdAt: "2026-04-01T01:00:00.000Z",
            updatedAt: "2026-04-01T01:00:00.000Z",
          },
        ],
      },
      error: null,
      isPending: false,
      isDeleted: false,
    });

    release();
  });

  it("marks threads as deleted when the stream deletes them", () => {
    const { client, emit } = createMockClient();
    const manager = createThreadDetailManager({
      getRegistry: () => atomRegistry,
      getClient: () => null,
    });

    const release = manager.watch(TARGET, client);

    emit({
      kind: "snapshot",
      snapshot: {
        snapshotSequence: 1,
        thread: BASE_THREAD,
      },
    });
    emit({
      kind: "event",
      event: {
        ...baseEventFields,
        sequence: 3,
        occurredAt: "2026-04-01T01:10:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.deleted",
        payload: {
          threadId: ThreadId.make("thread-1"),
          deletedAt: "2026-04-01T01:10:00.000Z",
        },
      } as any,
    });

    expect(manager.getSnapshot(TARGET)).toEqual({
      data: null,
      error: null,
      isPending: false,
      isDeleted: true,
    });

    release();
  });

  it("waits for delayed client registration when subscribeClientChanges is configured", () => {
    const connectionListeners = new Set<() => void>();
    const clients = new Map<string, ReturnType<typeof createMockClient>>();
    const manager = createThreadDetailManager({
      getRegistry: () => atomRegistry,
      getClient: (environmentId) => clients.get(environmentId)?.client ?? null,
      getClientIdentity: (environmentId) => (clients.has(environmentId) ? environmentId : null),
      subscribeClientChanges: (listener) => {
        connectionListeners.add(listener);
        return () => connectionListeners.delete(listener);
      },
    });

    const release = manager.watch(TARGET);
    expect(manager.getSnapshot(TARGET).isPending).toBe(true);

    const mock = createMockClient();
    clients.set("env-local", mock);
    for (const listener of connectionListeners) {
      listener();
    }

    mock.emit({
      kind: "snapshot",
      snapshot: {
        snapshotSequence: 1,
        thread: BASE_THREAD,
      },
    });

    expect(manager.getSnapshot(TARGET).data?.id).toBe(ThreadId.make("thread-1"));

    release();
  });

  it("evicts idle subscriptions after the configured ttl", () => {
    vi.useFakeTimers();
    const mock = createMockClient();
    const manager = createThreadDetailManager({
      getRegistry: () => atomRegistry,
      getClient: () => mock.client,
      retention: {
        idleTtlMs: 60_000,
        maxRetainedEntries: 10,
      },
    });

    const release = manager.watch(TARGET);
    expect(mock.listeners.size).toBe(1);

    release();
    expect(mock.listeners.size).toBe(1);

    vi.advanceTimersByTime(60_000);
    expect(mock.listeners.size).toBe(0);
  });

  it("keeps non-idle threads warm when the retention policy says to", () => {
    vi.useFakeTimers();
    const mock = createMockClient();
    const manager = createThreadDetailManager({
      getRegistry: () => atomRegistry,
      getClient: () => mock.client,
      retention: {
        idleTtlMs: 60_000,
        maxRetainedEntries: 10,
        shouldKeepWarm: (_target, state) => state.data?.session?.status === "running",
      },
    });

    const release = manager.watch(TARGET);
    mock.emit({
      kind: "snapshot",
      snapshot: {
        snapshotSequence: 1,
        thread: {
          ...BASE_THREAD,
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "running",
            providerName: "codex",
            workPersonalFallbackInstanceId: null,
            runtimeMode: "full-access",
            activeTurnId: TurnId.make("turn-1"),
            lastError: null,
            updatedAt: "2026-04-01T00:10:00.000Z",
          },
        },
      },
    });

    release();
    vi.advanceTimersByTime(60_000);

    expect(mock.listeners.size).toBe(1);
    manager.reset();
    expect(mock.listeners.size).toBe(0);
  });

  // ── W3.5: socket-kill integration test ─────────────────────────────────────
  // Subscribe → receive in-flight turn events → kill socket mid-turn →
  // reconnect → server sends completion snapshot → client state ≡ server
  // projection. Uses latches (Set membership) instead of sleeps.
  it("recovers in-flight turn state after socket kill: client state matches server projection on reconnect", () => {
    const { client, emit, simulateSocketKill } = createReconnectAwareMockClient();
    const manager = createThreadDetailManager({
      getRegistry: () => atomRegistry,
      getClient: () => null,
    });

    const release = manager.watch(TARGET, client);

    // ── Phase 1: subscribe + receive initial snapshot (turn idle) ──────────
    emit({
      kind: "snapshot",
      snapshot: { snapshotSequence: 1, thread: BASE_THREAD },
    });

    const afterInitial = manager.getSnapshot(TARGET);
    expect(afterInitial.data?.latestTurn).toBeNull();
    expect(afterInitial.isPending).toBe(false);

    // ── Phase 2: mid-turn streaming — server is running a turn ────────────
    // Simulate arrival of a streaming assistant message (turn running).
    emit({
      kind: "event",
      event: {
        ...baseEventFields,
        sequence: 2,
        occurredAt: "2026-04-01T01:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.message-sent",
        payload: {
          threadId: ThreadId.make("thread-1"),
          turnId: TurnId.make("turn-1"),
          messageId: MessageId.make("message-1"),
          role: "assistant",
          text: "Hello",
          streaming: true,
          createdAt: "2026-04-01T01:00:00.000Z",
          updatedAt: "2026-04-01T01:00:00.000Z",
        },
      } as any,
    });

    const duringTurn = manager.getSnapshot(TARGET);
    // ponytail: assert stale state is correct before kill
    expect(duringTurn.data?.latestTurn?.state).toBe("running");
    expect(
      duringTurn.data?.messages.find((m) => m.id === MessageId.make("message-1"))?.streaming,
    ).toBe(true);

    // ── Phase 3: socket kill mid-turn ─────────────────────────────────────
    // simulateSocketKill fires onResubscribe (→ markPending) then routes
    // future emit()s to the post-reconnect subscription.
    simulateSocketKill();

    // onResubscribe fired: state should be pending (data preserved, pending=true)
    const afterKill = manager.getSnapshot(TARGET);
    expect(afterKill.isPending).toBe(true);
    // Stale data still visible (not null) — the snapshot will replace it
    expect(afterKill.data?.latestTurn?.state).toBe("running");

    // ── Phase 4: reconnect — server sends completion snapshot ──────────────
    // The server finished the turn while the socket was down. Fresh snapshot
    // carries the completed turn and the final (non-streaming) message.
    const completedThread: OrchestrationThread = {
      ...BASE_THREAD,
      latestTurn: {
        turnId: TurnId.make("turn-1"),
        state: "completed",
        requestedAt: "2026-04-01T01:00:00.000Z",
        startedAt: "2026-04-01T01:00:00.000Z",
        completedAt: "2026-04-01T01:05:00.000Z",
        assistantMessageId: MessageId.make("message-1"),
      },
      messages: [
        {
          id: MessageId.make("message-1"),
          role: "assistant",
          text: "Hello world",
          turnId: TurnId.make("turn-1"),
          streaming: false,
          createdAt: "2026-04-01T01:00:00.000Z",
          updatedAt: "2026-04-01T01:05:00.000Z",
        },
      ],
      session: null,
      updatedAt: "2026-04-01T01:05:00.000Z",
    };

    emit({
      kind: "snapshot",
      snapshot: { snapshotSequence: 2, thread: completedThread },
    });

    // ── Phase 5: assert client state ≡ server projection ──────────────────
    const afterReconnect: ThreadDetailState = manager.getSnapshot(TARGET);
    expect(afterReconnect.isPending).toBe(false);
    expect(afterReconnect.data?.latestTurn?.state).toBe("completed");
    expect(afterReconnect.data?.latestTurn?.completedAt).toBe("2026-04-01T01:05:00.000Z");
    expect(afterReconnect.data?.latestTurn?.turnId).toBe(TurnId.make("turn-1"));
    // No message should remain streaming — the spinner must be resolved
    expect(afterReconnect.data?.messages.every((m) => !m.streaming)).toBe(true);
    expect(afterReconnect.data?.messages[0]?.text).toBe("Hello world");

    release();
  });
});
