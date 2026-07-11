/**
 * Tests for WorktreeGraveyardRetirement (plan 21 W2.2).
 *
 * Coverage:
 *   - graveyardCheckpointRef hash stability
 *   - retireWorktree: happy path (retiring-started + buried events, worktree removed)
 *   - retireWorktree: checkpoint failure → buried with null ref
 *   - retireWorktree: removeWorktree failure → no buried event
 *   - Schema replay gate: pre-widening aggregateKind values decode through widened schema
 */
import { OrchestrationAggregateKind, ThreadId, type OrchestrationEvent } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
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
import { GitVcsDriver } from "./GitVcsDriver.ts";
import { graveyardCheckpointRef, retireWorktree } from "./WorktreeGraveyardRetirement.ts";

// -- minimal mock layers --

function makeEngineLayer(): {
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
      readEvents: () => Stream.die("unused"),
      subscribeDomainEvents: Effect.die("unused"),
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

const makeCheckpointLayer = (fail: boolean) =>
  Layer.succeed(CheckpointStore, {
    isGitRepository: () => Effect.succeed(true),
    captureCheckpoint: (_input: CaptureCheckpointInput) =>
      fail
        ? Effect.fail(Object.assign(new Error("cp-fail"), { _tag: "CheckpointStoreError" }))
        : Effect.void,
    hasCheckpointRef: () => Effect.die("unused"),
    restoreCheckpoint: () => Effect.die("unused"),
    listCheckpoints: () => Effect.die("unused"),
  } as never);

const makeGitLayer = (fail: boolean) =>
  Layer.succeed(
    GitVcsDriver,
    new Proxy({} as never, {
      get: (_target, prop) => {
        if (prop === "removeWorktree") {
          return (_input: unknown) =>
            fail
              ? Effect.fail(Object.assign(new Error("rm-fail"), { _tag: "GitCommandError" }))
              : Effect.void;
        }
        return () => Effect.die(`unused git method: ${String(prop)}`);
      },
    }),
  );

const makeProjectionLayer = (sharedWithLiveThread: boolean) =>
  Layer.succeed(ProjectionSnapshotQuery, {
    hasLiveThreadForWorktreePath: () => Effect.succeed(sharedWithLiveThread),
  } as never);

// helper that runs retirement and returns dispatched/published counts
async function runRetirement({
  failCp = false,
  failGit = false,
  sharedWorktree = false,
}: { failCp?: boolean; failGit?: boolean; sharedWorktree?: boolean } = {}) {
  const { layer: engineLayer, dispatched } = makeEngineLayer();
  const { layer: receiptLayer, published } = makeReceiptLayer();
  const layer = Layer.mergeAll(
    engineLayer,
    receiptLayer,
    makeCheckpointLayer(failCp),
    makeGitLayer(failGit),
    makeProjectionLayer(sharedWorktree),
    NodeServices.layer,
  );

  await Effect.runPromise(
    retireWorktree({
      threadId: ThreadId.make("thread-retire-unit"),
      worktreePath: "/workspace/proj/.worktrees/thread-retire-unit",
      branch: "feat/graveyard",
      repoRoot: "/workspace/proj",
      trigger: "thread-deleted",
    }).pipe(Effect.provide(layer)),
  );

  return { dispatched, published };
}

// -- graveyardCheckpointRef tests --

describe("graveyardCheckpointRef", () => {
  it("produces a stable hex hash for the same path", () => {
    const ref1 = graveyardCheckpointRef("/workspace/foo/.worktrees/bar");
    const ref2 = graveyardCheckpointRef("/workspace/foo/.worktrees/bar");
    expect(ref1).toBe(ref2);
    expect(ref1).toMatch(/^refs\/t3\/graveyard\/[0-9a-f]{8}\/final$/);
  });

  it("produces different refs for different paths", () => {
    expect(graveyardCheckpointRef("/workspace/foo/.worktrees/alpha")).not.toBe(
      graveyardCheckpointRef("/workspace/foo/.worktrees/beta"),
    );
  });
});

// -- retireWorktree behaviour tests --

describe("retireWorktree", () => {
  it("emits retiring-started and buried events on happy path", async () => {
    const { dispatched, published } = await runRetirement();
    expect(dispatched).toContain("worktree.retire.start");
    expect(dispatched).toContain("worktree.bury");
    expect(published).toContain("worktree.retiring.started");
    expect(published).toContain("worktree.buried");
  });

  it("buries with null ref when checkpoint capture fails", async () => {
    const { dispatched, published } = await runRetirement({ failCp: true });
    // burial still happens — plan 21 §Failure Modes
    expect(dispatched).toContain("worktree.retire.start");
    expect(dispatched).toContain("worktree.bury");
    expect(published).toContain("worktree.buried");
  });

  it("skips buried event when removeWorktree fails", async () => {
    const { dispatched, published } = await runRetirement({ failGit: true });
    // retiring-started stays as recovery marker; buried NOT emitted
    expect(dispatched).toContain("worktree.retire.start");
    expect(dispatched).not.toContain("worktree.bury");
    expect(published).not.toContain("worktree.buried");
  });

  it("skips retirement entirely when another live thread shares the worktree", async () => {
    const { dispatched, published } = await runRetirement({ sharedWorktree: true });
    // fork shares the source worktree — removing it would destroy the survivor's cwd
    expect(dispatched).toEqual([]);
    expect(published).toEqual([]);
  });
});

// -- Schema replay gate: aggregateKind widening (plan 21 §NOTE gate (b)) --

describe("OrchestrationAggregateKind schema replay gate", () => {
  it("decodes pre-widening values (project, thread) through the widened schema", () => {
    const decode = Schema.decodeUnknownSync(OrchestrationAggregateKind);
    expect(decode("project")).toBe("project");
    expect(decode("thread")).toBe("thread");
  });

  it("decodes the new worktree aggregate kind", () => {
    expect(Schema.decodeUnknownSync(OrchestrationAggregateKind)("worktree")).toBe("worktree");
  });
});
