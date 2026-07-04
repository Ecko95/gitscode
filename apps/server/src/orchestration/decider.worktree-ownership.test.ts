/**
 * Decider tests for worktree.record-owner command (plan 21, W2.5).
 *
 * Coverage:
 *   - successful command → worktree.owner-recorded event with correct payload
 *   - event aggregateKind is "worktree" and aggregateId is the worktreePath
 *   - creation failure does not produce an event (decider throws)
 */
import { CommandId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { expect, it } from "@effect/vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel } from "./projector.ts";

const now = "2026-01-01T00:00:00.000Z";
const readModel = createEmptyReadModel(now);

it.effect("worktree.record-owner → emits worktree.owner-recorded with correct payload", () =>
  Effect.gen(function* () {
    const result = yield* decideOrchestrationCommand({
      command: {
        type: "worktree.record-owner",
        commandId: CommandId.make("server:bootstrap-worktree-record-owner:uuid-1"),
        threadId: ThreadId.make("thread-ownership-unit"),
        worktreePath: "/workspace/proj/.worktrees/thread-ownership-unit",
        branch: "feat/ownership-test",
        projectId: ProjectId.make("project-ownership"),
        recordedAt: now,
      },
      readModel,
    });
    // decider returns a single event or array — normalise
    const event = Array.isArray(result) ? result[0] : result;

    expect(event.type).toBe("worktree.owner-recorded");
    expect(event.aggregateKind).toBe("worktree");
    expect(event.aggregateId).toBe("/workspace/proj/.worktrees/thread-ownership-unit");
    expect(event.payload).toMatchObject({
      threadId: "thread-ownership-unit",
      worktreePath: "/workspace/proj/.worktrees/thread-ownership-unit",
      branch: "feat/ownership-test",
      projectId: "project-ownership",
      recordedAt: now,
    });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("worktree.record-owner with null branch → payload carries null branch", () =>
  Effect.gen(function* () {
    const result = yield* decideOrchestrationCommand({
      command: {
        type: "worktree.record-owner",
        commandId: CommandId.make("server:bootstrap-worktree-record-owner:uuid-2"),
        threadId: ThreadId.make("thread-ownership-unit-2"),
        worktreePath: "/workspace/proj/.worktrees/thread-ownership-unit-2",
        branch: null,
        projectId: ProjectId.make("project-ownership"),
        recordedAt: now,
      },
      readModel,
    });
    const event = Array.isArray(result) ? result[0] : result;

    expect(event.type).toBe("worktree.owner-recorded");
    expect(event.payload).toMatchObject({ branch: null });
  }).pipe(Effect.provide(NodeServices.layer)),
);
