// @effect-diagnostics nodeBuiltinImport:off globalDate:off
/**
 * Tests for GraveyardOrphanAdopter (plan 21 W2.3).
 *
 * Coverage:
 *   - (a) no events → worktree.adopt dispatched
 *   - (b) retiring-started but no buried → retireWorktree called (resume path)
 *   - (c) already buried → untouched (no dispatch, no retirement)
 *   - (c) already adopted → untouched
 *   - (d) owner-only + live thread → NOT adopted (healthy bound worktree)
 *   - (d) owner-only + dead/absent thread → adopt dispatched
 */
import { ThreadId, type OrchestrationEvent } from "@t3tools/contracts";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { describe, expect, it, beforeEach } from "vitest";

import {
  CheckpointStore,
  type CaptureCheckpointInput,
} from "../checkpointing/Services/CheckpointStore.ts";
import { ServerConfig } from "../config.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  RuntimeReceiptBus,
  type OrchestrationRuntimeReceipt,
} from "../orchestration/Services/RuntimeReceiptBus.ts";
import { GitVcsDriver } from "./GitVcsDriver.ts";
import { GraveyardOrphanAdopter, GraveyardOrphanAdopterLive } from "./GraveyardOrphanAdopter.ts";

// -- helpers --

function makeTmpWorktreesDir(): {
  worktreesDir: string;
  addWorktree: (repo: string, branch: string) => string;
} {
  const worktreesDir = mkdtempSync(join(tmpdir(), "t3-graveyard-test-"));
  return {
    worktreesDir,
    addWorktree: (repo: string, branch: string) => {
      const repoDir = join(worktreesDir, repo);
      const fullPath = join(repoDir, branch);
      mkdirSync(fullPath, { recursive: true });
      // make it look like a git worktree by adding a .git file
      writeFileSync(join(fullPath, ".git"), "gitdir: /fake/.git/worktrees/test\n");
      return fullPath;
    },
  };
}

function makeEngineLayer(events: OrchestrationEvent[]): {
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
      readEvents: (_from: number) =>
        Stream.fromIterable(events) as Stream.Stream<OrchestrationEvent>,
      subscribeDomainEvents: Effect.die("unused"),
      streamDomainEvents: Stream.empty as Stream.Stream<OrchestrationEvent>,
    }),
    dispatched,
  };
}

const makeNoopReceiptLayer = () =>
  Layer.succeed(RuntimeReceiptBus, {
    publish: (_receipt) => Effect.void,
    streamEventsForTest: Stream.empty as Stream.Stream<OrchestrationRuntimeReceipt>,
  });

const makeNoopCheckpointLayer = () =>
  Layer.succeed(CheckpointStore, {
    isGitRepository: () => Effect.succeed(true),
    captureCheckpoint: (_input: CaptureCheckpointInput) => Effect.void,
    hasCheckpointRef: () => Effect.die("unused"),
    restoreCheckpoint: () => Effect.die("unused"),
    listCheckpoints: () => Effect.die("unused"),
  } as never);

const makeNoopGitLayer = () =>
  Layer.succeed(
    GitVcsDriver,
    new Proxy({} as never, {
      get: (_target, prop) => {
        if (prop === "removeWorktree") {
          return (_input: unknown) => Effect.void;
        }
        return () => Effect.die(`unused git method: ${String(prop)}`);
      },
    }),
  );

// ponytail: liveThreadIds=Set — getThreadShellById returns Some for known ids, None otherwise
function makeProjectionSnapshotQueryLayer(liveThreadIds: Set<string> = new Set()) {
  return Layer.succeed(
    ProjectionSnapshotQuery,
    new Proxy({} as never, {
      get: (_target, prop) => {
        if (prop === "getThreadShellById") {
          return (threadId: string) =>
            Effect.succeed(
              liveThreadIds.has(threadId) ? Option.some({ threadId } as never) : Option.none(),
            );
        }
        if (prop === "hasLiveThreadForWorktreePath") {
          // retireWorktree's shared-worktree guard — adopter paths are orphaned,
          // so no live thread references them.
          return () => Effect.succeed(false);
        }
        return () => Effect.die(`unused projection method: ${String(prop)}`);
      },
    }),
  );
}

function makeServerConfigLayer(worktreesDir: string) {
  return Layer.succeed(ServerConfig, {
    worktreesDir,
  } as never);
}

async function runAdopter(opts: {
  worktreesDir: string;
  events: OrchestrationEvent[];
  liveThreadIds?: Set<string>;
}): Promise<{ dispatched: string[] }> {
  const { layer: engineLayer, dispatched } = makeEngineLayer(opts.events);

  const testLayer = GraveyardOrphanAdopterLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        engineLayer,
        makeNoopReceiptLayer(),
        makeNoopCheckpointLayer(),
        makeNoopGitLayer(),
        makeProjectionSnapshotQueryLayer(opts.liveThreadIds),
        makeServerConfigLayer(opts.worktreesDir),
        NodeServices.layer,
      ),
    ),
  );

  await Effect.runPromise(
    Effect.gen(function* () {
      const adopter = yield* GraveyardOrphanAdopter;
      yield* adopter.run;
    }).pipe(Effect.provide(testLayer)),
  );

  return { dispatched };
}

// -- tests --

describe("GraveyardOrphanAdopter", () => {
  let worktreesDir: string;
  let addWorktree: (repo: string, branch: string) => string;

  beforeEach(() => {
    const tmp = makeTmpWorktreesDir();
    worktreesDir = tmp.worktreesDir;
    addWorktree = tmp.addWorktree;
  });

  it("case (a): no events → dispatches worktree.adopt", async () => {
    addWorktree("my-repo", "feat-branch");
    const { dispatched } = await runAdopter({ worktreesDir, events: [] });
    expect(dispatched).toContain("worktree.adopt");
  });

  it("case (d): owner-only + dead/absent thread → dispatches worktree.adopt", async () => {
    const fullPath = addWorktree("my-repo", "feat-owner-dead-thread");
    const ownerEvent = {
      type: "worktree.owner-recorded",
      aggregateKind: "worktree",
      payload: {
        worktreePath: fullPath,
        threadId: ThreadId.make("t-dead"),
        branch: null,
        projectId: "proj-1",
        recordedAt: "2026-01-01T00:00:00.000Z",
      },
    } as unknown as OrchestrationEvent;

    // liveThreadIds is empty → getThreadShellById returns None → adopt
    const { dispatched } = await runAdopter({ worktreesDir, events: [ownerEvent] });
    expect(dispatched).toContain("worktree.adopt");
  });

  it("case (d): owner-only + live thread → NOT adopted (healthy bound worktree)", async () => {
    const liveThreadId = ThreadId.make("t-alive");
    const fullPath = addWorktree("my-repo", "feat-owner-live-thread");
    const ownerEvent = {
      type: "worktree.owner-recorded",
      aggregateKind: "worktree",
      payload: {
        worktreePath: fullPath,
        threadId: liveThreadId,
        branch: null,
        projectId: "proj-1",
        recordedAt: "2026-01-01T00:00:00.000Z",
      },
    } as unknown as OrchestrationEvent;

    // liveThreadIds contains this thread → getThreadShellById returns Some → skip
    const { dispatched } = await runAdopter({
      worktreesDir,
      events: [ownerEvent],
      liveThreadIds: new Set([liveThreadId]),
    });
    expect(dispatched).toHaveLength(0);
  });

  it("case (b): retiring-started without buried → calls worktree.retire.start (resume)", async () => {
    const fullPath = addWorktree("my-repo", "feat-retiring");
    const retiringEvent = {
      type: "worktree.retiring-started",
      aggregateKind: "worktree",
      payload: {
        worktreePath: fullPath,
        threadId: ThreadId.make("t-retire"),
        branch: null,
        trigger: "thread-deleted",
        initiatedAt: "2026-01-01T00:00:00.000Z",
      },
    } as unknown as OrchestrationEvent;

    // Resume: retireWorktree re-runs the full retirement → dispatches retire.start + bury
    const { dispatched } = await runAdopter({ worktreesDir, events: [retiringEvent] });
    expect(dispatched).toContain("worktree.retire.start");
  });

  it("case (c): buried → no dispatch, no adoption", async () => {
    const fullPath = addWorktree("my-repo", "feat-buried");
    const buriedEvent = {
      type: "worktree.buried",
      aggregateKind: "worktree",
      payload: {
        worktreePath: fullPath,
        threadId: ThreadId.make("t-buried"),
        branch: null,
        trigger: "retirement",
        finalCheckpointRef: null,
        buriedAt: "2026-01-01T00:00:00.000Z",
      },
    } as unknown as OrchestrationEvent;

    const { dispatched } = await runAdopter({ worktreesDir, events: [buriedEvent] });
    expect(dispatched).toHaveLength(0);
  });

  it("case (c): adopted → no dispatch", async () => {
    const fullPath = addWorktree("my-repo", "feat-already-adopted");
    const adoptedEvent = {
      type: "worktree.adopted",
      aggregateKind: "worktree",
      payload: {
        worktreePath: fullPath,
        branch: null,
        orphanReason: "no-event-binding",
        adoptedAt: "2026-01-01T00:00:00.000Z",
      },
    } as unknown as OrchestrationEvent;

    const { dispatched } = await runAdopter({ worktreesDir, events: [adoptedEvent] });
    expect(dispatched).toHaveLength(0);
  });

  it("empty worktreesDir → scan completes with no dispatch", async () => {
    const { dispatched } = await runAdopter({ worktreesDir, events: [] });
    expect(dispatched).toHaveLength(0);
  });
});
