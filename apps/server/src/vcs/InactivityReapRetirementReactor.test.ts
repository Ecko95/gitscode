/**
 * Tests for InactivityReapRetirementReactor (plan 21, W2.2b).
 *
 * Coverage:
 *   - stopped session WITH worktree + no prior retirement events → retires with inactivity-reap
 *   - stopped session WITHOUT worktree → reaped, no graveyard events
 *   - stopped session with worktree already retiring (retiring-started event) → skipped
 *   - stopped session with worktree already buried → skipped
 *   - stopped session whose thread is deleted (None from getThreadShellById) → skipped
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@t3tools/contracts";
import type { OrchestrationEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vitest";

import {
  CheckpointStore,
  type CaptureCheckpointInput,
} from "../checkpointing/Services/CheckpointStore.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  RuntimeReceiptBus,
  type OrchestrationRuntimeReceipt,
} from "../orchestration/Services/RuntimeReceiptBus.ts";
import { ProviderSessionDirectory } from "../provider/Services/ProviderSessionDirectory.ts";
import { GitVcsDriver } from "./GitVcsDriver.ts";
import { runSweepOnce } from "./InactivityReapRetirementReactor.ts";

// -- minimal mock helpers --

type MockBinding = {
  threadId: ThreadId;
  status: "running" | "stopped";
  lastSeenAt: string;
  provider: string;
};

type WorktreeInfo = {
  worktreePath: string | null;
  branch: string | null;
  projectWorkspaceRoot: string | null;
};

function makeEngineLayer(domainEvents: OrchestrationEvent[] = []): {
  layer: Layer.Layer<OrchestrationEngineService>;
  dispatched: string[];
} {
  const dispatched: string[] = [];
  return {
    layer: Layer.succeed(OrchestrationEngineService, {
      dispatch: (command) =>
        Effect.sync(() => {
          dispatched.push(command.type);
          return { sequence: dispatched.length };
        }),
      readEvents: () => Stream.fromIterable(domainEvents) as Stream.Stream<OrchestrationEvent>,
      streamDomainEvents: Stream.empty as Stream.Stream<OrchestrationEvent>,
    }),
    dispatched,
  };
}

function makeReceiptLayer(): { layer: Layer.Layer<RuntimeReceiptBus>; published: string[] } {
  const published: string[] = [];
  return {
    layer: Layer.succeed(RuntimeReceiptBus, {
      publish: (receipt) =>
        Effect.sync(() => {
          published.push(receipt.type);
        }),
      streamEventsForTest: Stream.empty as Stream.Stream<OrchestrationRuntimeReceipt>,
    }),
    published,
  };
}

const makeCheckpointLayer = () =>
  Layer.succeed(CheckpointStore, {
    isGitRepository: () => Effect.succeed(true),
    captureCheckpoint: (_input: CaptureCheckpointInput) => Effect.void,
    hasCheckpointRef: () => Effect.die("unused"),
    restoreCheckpoint: () => Effect.die("unused"),
    listCheckpoints: () => Effect.die("unused"),
  } as never);

function makeGitLayer(): { layer: Layer.Layer<GitVcsDriver>; removeCalls: string[] } {
  const removeCalls: string[] = [];
  return {
    layer: Layer.succeed(
      GitVcsDriver,
      new Proxy({} as never, {
        get: (_target, prop) => {
          if (prop === "removeWorktree") {
            return (input: { path: string }) => {
              removeCalls.push(input.path);
              return Effect.void;
            };
          }
          return () => Effect.die(`unused git method: ${String(prop)}`);
        },
      }),
    ),
    removeCalls,
  };
}

function makeDirectoryLayer(bindings: MockBinding[]): Layer.Layer<ProviderSessionDirectory> {
  return Layer.succeed(ProviderSessionDirectory, {
    listBindings: () =>
      Effect.succeed(
        bindings.map((b) => ({
          threadId: b.threadId,
          status: b.status,
          provider: b.provider,
          lastSeenAt: b.lastSeenAt,
          providerInstanceId: null,
          adapterKey: b.provider,
          runtimeMode: "full-access" as const,
          resumeCursor: null,
          runtimePayload: null,
        })),
      ),
    getByThreadId: () => Effect.succeed(Option.none()),
    upsert: () => Effect.void,
    markStopped: () => Effect.void,
  } as never);
}

function makeProjectionLayer(
  worktreeInfoByThread: Map<ThreadId, WorktreeInfo>,
  aliveThreadIds: Set<ThreadId>,
): Layer.Layer<ProjectionSnapshotQuery> {
  return Layer.succeed(ProjectionSnapshotQuery, {
    getCommandReadModel: () => Effect.die("unused"),
    getSnapshot: () => Effect.die("unused"),
    getShellSnapshot: () => Effect.die("unused"),
    getArchivedShellSnapshot: () => Effect.die("unused"),
    getSnapshotSequence: () => Effect.die("unused"),
    getCounts: () => Effect.die("unused"),
    getActiveProjectByWorkspaceRoot: () => Effect.die("unused"),
    getProjectShellById: () => Effect.die("unused"),
    getFirstActiveThreadIdByProjectId: () => Effect.die("unused"),
    getThreadCheckpointContext: () => Effect.die("unused"),
    getFullThreadDiffContext: () => Effect.die("unused"),
    getThreadShellById: (threadId: ThreadId) =>
      Effect.succeed(aliveThreadIds.has(threadId) ? Option.some({} as never) : Option.none()),
    getThreadDetailById: () => Effect.die("unused"),
    getThreadWorktreeInfo: (threadId: ThreadId) => {
      const info = worktreeInfoByThread.get(threadId);
      return Effect.succeed(info != null ? Option.some(info) : Option.none());
    },
    hasLiveThreadForWorktreePath: () => Effect.succeed(false),
  } as never);
}

async function runSweep({
  bindings,
  worktreeInfoByThread,
  aliveThreadIds,
  existingEvents = [],
}: {
  bindings: MockBinding[];
  worktreeInfoByThread: Map<ThreadId, WorktreeInfo>;
  aliveThreadIds: Set<ThreadId>;
  existingEvents?: OrchestrationEvent[];
}) {
  const { layer: engineLayer, dispatched } = makeEngineLayer(existingEvents);
  const { layer: receiptLayer, published } = makeReceiptLayer();
  const { layer: gitLayer, removeCalls } = makeGitLayer();

  const layer = Layer.mergeAll(
    engineLayer,
    receiptLayer,
    makeCheckpointLayer(),
    gitLayer,
    makeDirectoryLayer(bindings),
    makeProjectionLayer(worktreeInfoByThread, aliveThreadIds),
    NodeServices.layer, // provides Crypto.Crypto
  );

  await Effect.runPromise(runSweepOnce.pipe(Effect.provide(layer)));

  return { dispatched, published, removeCalls };
}

// -- tests --

describe("InactivityReapRetirementReactor.runSweepOnce", () => {
  const staleLastSeen = "2026-04-14T00:00:00.000Z";
  const worktreePath = "/workspace/proj/.worktrees/thread-inactivity";
  const repoRoot = "/workspace/proj";

  it("retires worktree for stopped session with no prior retirement events", async () => {
    const threadId = ThreadId.make("thread-inactivity-reap-retire");
    const { dispatched, published, removeCalls } = await runSweep({
      bindings: [
        { threadId, status: "stopped", lastSeenAt: staleLastSeen, provider: "claudeAgent" },
      ],
      worktreeInfoByThread: new Map([
        [threadId, { worktreePath, branch: "feat/graveyard", projectWorkspaceRoot: repoRoot }],
      ]),
      aliveThreadIds: new Set([threadId]),
      existingEvents: [],
    });

    expect(dispatched).toContain("worktree.retire.start");
    expect(dispatched).toContain("worktree.bury");
    expect(published).toContain("worktree.retiring.started");
    expect(published).toContain("worktree.buried");
    expect(removeCalls).toContain(worktreePath);
  });

  it("skips stopped session without a worktree", async () => {
    const threadId = ThreadId.make("thread-inactivity-no-worktree");
    const { dispatched, published } = await runSweep({
      bindings: [
        { threadId, status: "stopped", lastSeenAt: staleLastSeen, provider: "claudeAgent" },
      ],
      worktreeInfoByThread: new Map(), // no worktree info → Option.none()
      aliveThreadIds: new Set([threadId]),
      existingEvents: [],
    });

    expect(dispatched).toHaveLength(0);
    expect(published).toHaveLength(0);
  });

  it("skips if worktree.retiring-started already exists (prior retirement in flight)", async () => {
    const threadId = ThreadId.make("thread-inactivity-already-retiring");
    const { dispatched } = await runSweep({
      bindings: [
        { threadId, status: "stopped", lastSeenAt: staleLastSeen, provider: "claudeAgent" },
      ],
      worktreeInfoByThread: new Map([
        [threadId, { worktreePath, branch: null, projectWorkspaceRoot: repoRoot }],
      ]),
      aliveThreadIds: new Set([threadId]),
      existingEvents: [
        {
          type: "worktree.retiring-started",
          aggregateKind: "worktree",
          aggregateId: worktreePath as never,
          sequence: 1,
          eventId: "ev-retiring" as never,
          occurredAt: staleLastSeen,
          commandId: "cmd-1" as never,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          payload: {
            threadId,
            worktreePath,
            branch: null,
            trigger: "inactivity-reap" as const,
            initiatedAt: staleLastSeen,
          },
        } as OrchestrationEvent,
      ],
    });

    expect(dispatched).toHaveLength(0);
  });

  it("skips if worktree.buried already exists", async () => {
    const threadId = ThreadId.make("thread-inactivity-already-buried");
    const { dispatched } = await runSweep({
      bindings: [
        { threadId, status: "stopped", lastSeenAt: staleLastSeen, provider: "claudeAgent" },
      ],
      worktreeInfoByThread: new Map([
        [threadId, { worktreePath, branch: null, projectWorkspaceRoot: repoRoot }],
      ]),
      aliveThreadIds: new Set([threadId]),
      existingEvents: [
        {
          type: "worktree.buried",
          aggregateKind: "worktree",
          aggregateId: worktreePath as never,
          sequence: 1,
          eventId: "ev-buried" as never,
          occurredAt: staleLastSeen,
          commandId: "cmd-1" as never,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          payload: {
            threadId,
            worktreePath,
            branch: null,
            trigger: "retirement" as const,
            finalCheckpointRef: null,
            buriedAt: staleLastSeen,
          },
        } as OrchestrationEvent,
      ],
    });

    expect(dispatched).toHaveLength(0);
  });

  it("skips if thread is deleted (getThreadShellById returns None)", async () => {
    const threadId = ThreadId.make("thread-inactivity-deleted-thread");
    const { dispatched } = await runSweep({
      bindings: [
        { threadId, status: "stopped", lastSeenAt: staleLastSeen, provider: "claudeAgent" },
      ],
      worktreeInfoByThread: new Map([
        [threadId, { worktreePath, branch: null, projectWorkspaceRoot: repoRoot }],
      ]),
      aliveThreadIds: new Set(), // thread not alive → None from getThreadShellById
      existingEvents: [],
    });

    // ThreadDeletionReactor owns deleted-thread case — we skip it
    expect(dispatched).toHaveLength(0);
  });
});
