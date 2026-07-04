/**
 * Tests for GraveyardOrphanAdopter (plan 21 W2.3).
 *
 * Coverage:
 *   - (a) no events → worktree.adopt dispatched
 *   - (b) retiring-started but no buried → retireWorktree called (resume path)
 *   - (c) already buried → untouched (no dispatch, no retirement)
 *   - (c) already adopted → untouched
 *   - owner-only → treated as case (a), adopt dispatched
 */
import { ThreadId, type OrchestrationEvent } from "@t3tools/contracts";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { describe, expect, it, beforeEach } from "vitest";

import {
  CheckpointStore,
  type CaptureCheckpointInput,
} from "../checkpointing/Services/CheckpointStore.ts";
import { ServerConfig } from "../config.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import {
  RuntimeReceiptBus,
  type OrchestrationRuntimeReceipt,
} from "../orchestration/Services/RuntimeReceiptBus.ts";
import { GitVcsDriver } from "./GitVcsDriver.ts";
import { GraveyardOrphanAdopterLive } from "./GraveyardOrphanAdopter.ts";

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

function makeServerConfigLayer(worktreesDir: string) {
  return Layer.succeed(ServerConfig, {
    worktreesDir,
  } as never);
}

async function runAdopter(opts: {
  worktreesDir: string;
  events: OrchestrationEvent[];
}): Promise<{ dispatched: string[] }> {
  const { layer: engineLayer, dispatched } = makeEngineLayer(opts.events);

  const testLayer = GraveyardOrphanAdopterLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        engineLayer,
        makeNoopReceiptLayer(),
        makeNoopCheckpointLayer(),
        makeNoopGitLayer(),
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

// -- import the service class --
import { GraveyardOrphanAdopter } from "./GraveyardOrphanAdopter.ts";

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

  it("case (a): owner-only → dispatches worktree.adopt (no retirement history)", async () => {
    const fullPath = addWorktree("my-repo", "feat-owner-only");
    const ownerEvent = {
      type: "worktree.owner-recorded",
      aggregateKind: "worktree",
      payload: {
        worktreePath: fullPath,
        threadId: ThreadId.make("t-1"),
        branch: null,
        projectId: "proj-1",
        recordedAt: new Date().toISOString(),
      },
    } as unknown as OrchestrationEvent;

    const { dispatched } = await runAdopter({ worktreesDir, events: [ownerEvent] });
    expect(dispatched).toContain("worktree.adopt");
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
        initiatedAt: new Date().toISOString(),
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
        buriedAt: new Date().toISOString(),
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
        adoptedAt: new Date().toISOString(),
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
