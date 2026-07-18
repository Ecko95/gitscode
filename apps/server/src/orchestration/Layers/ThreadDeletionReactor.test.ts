import {
  CommandId,
  CorrelationId,
  EventId,
  ThreadId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { describe, expect, it } from "vitest";

import {
  logCleanupCauseUnlessInterrupted,
  threadRuntimeCleanupRequest,
} from "./ThreadDeletionReactor.ts";

const occurredAt = "2026-07-17T12:00:00.000Z";
const makeLifecycleEvent = (type: "thread.archived" | "thread.deleted"): OrchestrationEvent => {
  const threadId = ThreadId.make(`thread-${type}`);
  const common = {
    sequence: 1,
    eventId: EventId.make(`event-${type}`),
    aggregateKind: "thread" as const,
    aggregateId: threadId,
    occurredAt,
    commandId: CommandId.make(`command-${type}`),
    causationEventId: null,
    correlationId: CorrelationId.make(`correlation-${type}`),
    metadata: {},
  };
  return type === "thread.archived"
    ? {
        ...common,
        type,
        payload: { threadId, archivedAt: occurredAt, updatedAt: occurredAt },
      }
    : {
        ...common,
        type,
        payload: { threadId, deletedAt: occurredAt },
      };
};

describe("threadRuntimeCleanupRequest", () => {
  it("releases archived thread runtimes without deleting history or retiring the worktree", () => {
    expect(threadRuntimeCleanupRequest(makeLifecycleEvent("thread.archived"))).toEqual({
      threadId: ThreadId.make("thread-thread.archived"),
      deleteTerminalHistory: false,
      retireWorktree: false,
    });
  });

  it("fully cleans deleted thread runtimes", () => {
    expect(threadRuntimeCleanupRequest(makeLifecycleEvent("thread.deleted"))).toEqual({
      threadId: ThreadId.make("thread-thread.deleted"),
      deleteTerminalHistory: true,
      retireWorktree: true,
    });
  });
});

describe("logCleanupCauseUnlessInterrupted", () => {
  const threadId = ThreadId.make("thread-deletion-reactor-test");

  it("swallows ordinary cleanup failures", async () => {
    const exit = await Effect.runPromiseExit(
      logCleanupCauseUnlessInterrupted({
        effect: Effect.fail("cleanup failed"),
        message: "thread deletion cleanup skipped provider session stop",
        threadId,
      }),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("preserves interrupt causes", async () => {
    const exit = await Effect.runPromiseExit(
      logCleanupCauseUnlessInterrupted({
        effect: Effect.interrupt,
        message: "thread deletion cleanup skipped provider session stop",
        threadId,
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    }
  });
});
