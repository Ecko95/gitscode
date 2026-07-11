// @effect-diagnostics nodeBuiltinImport:off globalDate:off
/**
 * Tests for GraveyardReaper (plan 21, W2.4).
 *
 * Coverage:
 *   - Aged adopted worktree → captured + removed + buried (trigger: "reaper", ref set)
 *   - Under-age adopted worktree → untouched
 *   - REBOUND: adopted + owner-recorded + NO thread.deleted → skip, no burial (live thread)
 *   - REBOUND: adopted + owner-recorded + thread.archived (no thread.deleted) → skip (archived blocks)
 *   - REBOUND: adopted + owner-recorded + thread.deleted + live projection reference → skip
 *   - Adopted + owner-recorded + thread.deleted → prune proceeds (thread is dead)
 *   - Capture failure → untouched so a later sweep can retry safely
 *   - Remove failure → warn, no burial event
 *   - Already buried → skipped in sweep
 *
 * No sleeps — runs sweep effect directly via runSweepOnce export.
 * maxAgeMs forced to 1ms via env var so epoch-time adoptedAt always ages out.
 * Uses real temp directories (like GraveyardOrphanAdopter.test.ts) so FileSystem
 * stat works without mocking.
 */
import { ThreadId, type OrchestrationEvent } from "@t3tools/contracts";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it, beforeEach } from "vitest";

import {
  CheckpointStore,
  type CaptureCheckpointInput,
} from "../checkpointing/Services/CheckpointStore.ts";
import { ServerConfig } from "../config.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { GitVcsDriver } from "./GitVcsDriver.ts";
import { runSweepOnce } from "./GraveyardReaper.ts";

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

const EPOCH_ISO = new Date(0).toISOString(); // always aged out with maxAgeMs=1
const FAR_FUTURE_ISO = new Date(Date.now() + 999_999_999_999).toISOString();

// ---------------------------------------------------------------------------
// Temp dir helpers
// ---------------------------------------------------------------------------

function makeTmpWorktreesDir(): { worktreesDir: string; addPath: () => string } {
  const worktreesDir = mkdtempSync(join(tmpdir(), "t3-reaper-test-"));
  let counter = 0;
  return {
    worktreesDir,
    addPath: () => {
      const p = join(worktreesDir, `repo-${counter}`, `branch-${counter++}`);
      mkdirSync(p, { recursive: true });
      return p;
    },
  };
}

// ---------------------------------------------------------------------------
// Event factories
// ---------------------------------------------------------------------------

function makeAdoptedEvent(worktreePath: string, adoptedAt = EPOCH_ISO): OrchestrationEvent {
  return {
    type: "worktree.adopted",
    aggregateKind: "worktree",
    aggregateId: worktreePath,
    sequence: 1,
    eventId: "ev-adopted",
    occurredAt: adoptedAt,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: { worktreePath, branch: null, orphanReason: "no-event-binding", adoptedAt },
  } as unknown as OrchestrationEvent;
}

function makeOwnerRecordedEvent(worktreePath: string, threadId: string): OrchestrationEvent {
  return {
    type: "worktree.owner-recorded",
    aggregateKind: "worktree",
    aggregateId: worktreePath,
    sequence: 2,
    eventId: "ev-owner",
    occurredAt: EPOCH_ISO,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: { worktreePath, threadId, branch: null, projectId: "proj-1", recordedAt: EPOCH_ISO },
  } as unknown as OrchestrationEvent;
}

function makeThreadDeletedEvent(threadId: string): OrchestrationEvent {
  return {
    type: "thread.deleted",
    aggregateKind: "thread",
    aggregateId: threadId,
    sequence: 3,
    eventId: "ev-deleted",
    occurredAt: EPOCH_ISO,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: { threadId, deletedAt: EPOCH_ISO },
  } as unknown as OrchestrationEvent;
}

function makeThreadArchivedEvent(threadId: string): OrchestrationEvent {
  return {
    type: "thread.archived",
    aggregateKind: "thread",
    aggregateId: threadId,
    sequence: 3,
    eventId: "ev-archived",
    occurredAt: EPOCH_ISO,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: { threadId, archivedAt: EPOCH_ISO, updatedAt: EPOCH_ISO },
  } as unknown as OrchestrationEvent;
}

function makeBuriedEvent(worktreePath: string): OrchestrationEvent {
  return {
    type: "worktree.buried",
    aggregateKind: "worktree",
    aggregateId: worktreePath,
    sequence: 10,
    eventId: "ev-buried",
    occurredAt: EPOCH_ISO,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: {
      worktreePath,
      threadId: "__graveyard_reaper__",
      branch: null,
      trigger: "reaper",
      finalCheckpointRef: null,
      buriedAt: EPOCH_ISO,
    },
  } as unknown as OrchestrationEvent;
}

// ---------------------------------------------------------------------------
// Mock layers
// ---------------------------------------------------------------------------

function makeEngineLayer(events: OrchestrationEvent[]): {
  layer: Layer.Layer<OrchestrationEngineService>;
  dispatched: Array<Record<string, unknown>>;
} {
  const dispatched: Array<Record<string, unknown>> = [];
  return {
    layer: Layer.succeed(OrchestrationEngineService, {
      dispatch: (command) =>
        Effect.sync(() => {
          dispatched.push(command as Record<string, unknown>);
          return { sequence: dispatched.length };
        }),
      readEvents: (_from: number) =>
        Stream.fromIterable(events) as Stream.Stream<OrchestrationEvent>,
      subscribeDomainEvents: Effect.die("unused"),
      streamDomainEvents: Stream.empty as Stream.Stream<OrchestrationEvent>,
    }),
    dispatched,
  };
}

function makeCheckpointLayer(fail: boolean) {
  return Layer.succeed(CheckpointStore, {
    isGitRepository: () => Effect.succeed(true),
    captureCheckpoint: (_input: CaptureCheckpointInput) =>
      fail
        ? Effect.fail(Object.assign(new Error("cp-fail"), { _tag: "CheckpointStoreError" }))
        : Effect.void,
    hasCheckpointRef: () => Effect.die("unused"),
    restoreCheckpoint: () => Effect.die("unused"),
    listCheckpoints: () => Effect.die("unused"),
  } as never);
}

function makeGitLayer(fail: boolean, removeCalls: string[]) {
  return Layer.succeed(
    GitVcsDriver,
    new Proxy({} as never, {
      get: (_target, prop) => {
        if (prop === "removeWorktree") {
          return (input: { readonly path: string }) =>
            Effect.sync(() => removeCalls.push(input.path)).pipe(
              Effect.andThen(
                fail
                  ? Effect.fail(Object.assign(new Error("rm-fail"), { _tag: "GitCommandError" }))
                  : Effect.void,
              ),
            );
        }
        return () => Effect.die(`unused git method: ${String(prop)}`);
      },
    }),
  );
}

/**
 * Layer 2 projection guard — controls what hasLiveThreadForWorktreePath returns.
 * Default (liveWorktreePaths=[]) returns false (no live threads). Pass the path
 * under test to simulate a live thread referencing that worktree.
 */
function makeProjectionLayer(liveWorktreePaths: string[] = []) {
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
    getThreadShellById: () => Effect.die("unused"),
    getThreadDetailById: () => Effect.die("unused"),
    getThreadWorktreeInfo: () => Effect.die("unused"),
    hasLiveThreadForWorktreePath: (p: string) => Effect.succeed(liveWorktreePaths.includes(p)),
  } as never);
}

// ---------------------------------------------------------------------------
// Run harness — invokes runSweepOnce directly (no Schedule, no forkScoped)
// ---------------------------------------------------------------------------

async function runReaperSweep(opts: {
  worktreesDir: string;
  events: OrchestrationEvent[];
  failCp?: boolean;
  failGit?: boolean;
  /** Worktree paths that a live (non-deleted) thread references in the projection DB. */
  liveWorktreePaths?: string[];
}): Promise<{
  dispatched: Array<Record<string, unknown>>;
  removeCalls: string[];
}> {
  const { layer: engineLayer, dispatched } = makeEngineLayer(opts.events);
  const removeCalls: string[] = [];

  // maxAgeMs=1 so epoch-time adoptedAt always ages out
  process.env["GITS_GRAVEYARD_MAX_AGE_MS"] = "1";
  try {
    const baseLayer = Layer.mergeAll(
      engineLayer,
      makeCheckpointLayer(opts.failCp ?? false),
      makeGitLayer(opts.failGit ?? false, removeCalls),
      Layer.succeed(ServerConfig, { worktreesDir: opts.worktreesDir } as never),
      NodeServices.layer, // provides FileSystem, Crypto
      makeProjectionLayer(opts.liveWorktreePaths ?? []),
    );

    await Effect.runPromise(runSweepOnce.pipe(Effect.provide(baseLayer)));
  } finally {
    delete process.env["GITS_GRAVEYARD_MAX_AGE_MS"];
  }

  return { dispatched, removeCalls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GraveyardReaper — sweep behaviour", () => {
  let worktreesDir: string;
  let addPath: () => string;

  beforeEach(() => {
    const tmp = makeTmpWorktreesDir();
    worktreesDir = tmp.worktreesDir;
    addPath = tmp.addPath;
  });

  it("aged adopted worktree → buried with trigger=reaper and non-null ref", async () => {
    const path = addPath();
    const events = [makeAdoptedEvent(path)];
    const { dispatched } = await runReaperSweep({ worktreesDir, events });
    const buryCmds = dispatched.filter((d) => d["type"] === "worktree.bury");
    expect(buryCmds).toHaveLength(1);
    expect(buryCmds[0]!["trigger"]).toBe("reaper");
    expect(buryCmds[0]!["finalCheckpointRef"]).not.toBeNull();
  });

  it("under-age adopted worktree → untouched", async () => {
    const path = addPath();
    const events = [makeAdoptedEvent(path, FAR_FUTURE_ISO)];
    const { dispatched } = await runReaperSweep({ worktreesDir, events });
    expect(dispatched.filter((d) => d["type"] === "worktree.bury")).toHaveLength(0);
  });

  it("REBOUND: owner-recorded + NO thread.deleted → skip (live thread blocks)", async () => {
    const path = addPath();
    const threadId = ThreadId.make("t-alive");
    const events = [
      makeAdoptedEvent(path),
      makeOwnerRecordedEvent(path, threadId),
      // no thread.deleted → thread alive → BLOCK
    ];
    const { dispatched } = await runReaperSweep({ worktreesDir, events });
    expect(dispatched.filter((d) => d["type"] === "worktree.bury")).toHaveLength(0);
  });

  it("REBOUND: owner-recorded + thread.archived (no thread.deleted) → skip (archived blocks)", async () => {
    const path = addPath();
    const threadId = ThreadId.make("t-archived");
    const events = [
      makeAdoptedEvent(path),
      makeOwnerRecordedEvent(path, threadId),
      makeThreadArchivedEvent(threadId),
      // thread.archived but NOT thread.deleted → archived thread blocks pruning
    ];
    const { dispatched } = await runReaperSweep({ worktreesDir, events });
    expect(dispatched.filter((d) => d["type"] === "worktree.bury")).toHaveLength(0);
  });

  it("owner-recorded + thread.deleted → prune proceeds (dead thread is unbound)", async () => {
    const path = addPath();
    const threadId = ThreadId.make("t-deleted");
    const events = [
      makeAdoptedEvent(path),
      makeOwnerRecordedEvent(path, threadId),
      makeThreadDeletedEvent(threadId),
    ];
    const { dispatched } = await runReaperSweep({ worktreesDir, events });
    const buryCmds = dispatched.filter((d) => d["type"] === "worktree.bury");
    expect(buryCmds).toHaveLength(1);
    expect(buryCmds[0]!["trigger"]).toBe("reaper");
  });

  it("REBOUND: owner-recorded + thread.deleted + live projection reference → skip", async () => {
    const path = addPath();
    const threadId = ThreadId.make("t-deleted-with-live-fork");
    const events = [
      makeAdoptedEvent(path),
      makeOwnerRecordedEvent(path, threadId),
      makeThreadDeletedEvent(threadId),
    ];
    const { dispatched } = await runReaperSweep({
      worktreesDir,
      events,
      liveWorktreePaths: [path],
    });
    expect(dispatched.filter((d) => d["type"] === "worktree.bury")).toHaveLength(0);
  });

  it("capture failure → no removal or burial so a later sweep can retry", async () => {
    const path = addPath();
    const events = [makeAdoptedEvent(path)];
    const { dispatched, removeCalls } = await runReaperSweep({
      worktreesDir,
      events,
      failCp: true,
    });
    const buryCmds = dispatched.filter((d) => d["type"] === "worktree.bury");
    expect(buryCmds).toHaveLength(0);
    expect(removeCalls).toEqual([]);
  });

  it("remove failure → warn, no burial event, candidate remains", async () => {
    const path = addPath();
    const events = [makeAdoptedEvent(path)];
    const { dispatched } = await runReaperSweep({ worktreesDir, events, failGit: true });
    expect(dispatched.filter((d) => d["type"] === "worktree.bury")).toHaveLength(0);
  });

  it("already-buried adopted path → skipped in sweep (no second bury)", async () => {
    const path = addPath();
    const events = [makeAdoptedEvent(path), makeBuriedEvent(path)];
    const { dispatched } = await runReaperSweep({ worktreesDir, events });
    expect(dispatched.filter((d) => d["type"] === "worktree.bury")).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Layer 2 guard: pre-W2.5 worktrees — no owner-recorded events, projection check
  // ---------------------------------------------------------------------------

  it("REBOUND (layer 2): adopted, NO owner-recorded events, live thread in projection → skip", async () => {
    // Simulates a pre-W2.5 worktree: adopted as orphan (orphanReason="no-event-binding"),
    // no worktree.owner-recorded event exists, but the projection DB shows a live thread
    // still references the path. Layer 1 (event-store) sees no owner → would prune.
    // Layer 2 (projection) blocks it: hasLiveThreadForWorktreePath returns true.
    const path = addPath();
    const events = [makeAdoptedEvent(path)]; // no owner-recorded event
    const { dispatched } = await runReaperSweep({
      worktreesDir,
      events,
      liveWorktreePaths: [path], // projection says a live thread uses this path
    });
    expect(dispatched.filter((d) => d["type"] === "worktree.bury")).toHaveLength(0);
  });

  it("layer 2: adopted, NO owner-recorded events, thread deleted (not in projection) → pruned", async () => {
    // Same pre-W2.5 scenario but the referencing thread has been deleted.
    // hasLiveThreadForWorktreePath returns false → no projection block → pruned normally.
    const path = addPath();
    const events = [makeAdoptedEvent(path)]; // no owner-recorded event
    const { dispatched } = await runReaperSweep({
      worktreesDir,
      events,
      liveWorktreePaths: [], // no live thread → unbound → prune
    });
    const buryCmds = dispatched.filter((d) => d["type"] === "worktree.bury");
    expect(buryCmds).toHaveLength(1);
    expect(buryCmds[0]!["trigger"]).toBe("reaper");
  });
});
