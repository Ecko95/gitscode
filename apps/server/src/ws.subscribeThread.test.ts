import type { OrchestrationThread } from "@t3tools/contracts";
import { MessageId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vitest";

import { denyThreadAccess } from "./auth/Services/ServerAuth.ts";
import { readThreadDetailSnapshot, TERMINAL_STREAM_BUFFER, terminalCallbackStream } from "./ws.ts";

const threadId = ThreadId.make("thread-1");
const projectId = ProjectId.make("project-1");

function makeThread(): OrchestrationThread {
  return {
    id: threadId,
    projectId,
    title: "Thread 1",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    parentThreadId: null,
    forkedFromMessageId: null,
    latestTurn: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    visualPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
  };
}

describe("subscribeThread initial snapshot", () => {
  it("requires a consistent thread detail snapshot from one service call", async () => {
    const eventSequence = 11;
    const threadWithEvent: OrchestrationThread = {
      ...makeThread(),
      messages: [
        {
          id: MessageId.make("message-1"),
          role: "user" as const,
          text: "event included",
          attachments: [],
          turnId: null,
          streaming: false,
          createdAt: "2026-01-01T00:00:01.000Z",
          updatedAt: "2026-01-01T00:00:01.000Z",
        },
      ],
    };

    const scenarios: ReadonlyArray<{
      readonly label: string;
      readonly snapshotSequence: number;
      readonly threadDetail: Option.Option<OrchestrationThread>;
    }> = [
      {
        label: "event present",
        snapshotSequence: eventSequence,
        threadDetail: Option.some(threadWithEvent),
      },
      {
        label: "event absent",
        snapshotSequence: eventSequence - 1,
        threadDetail: Option.some(makeThread()),
      },
    ];

    for (const scenario of scenarios) {
      const result = await Effect.runPromise(
        readThreadDetailSnapshot(threadId, {
          getThreadDetailSnapshot: () =>
            Effect.succeed({
              snapshotSequence: scenario.snapshotSequence,
              threadDetail: scenario.threadDetail,
            }),
        }),
      );

      const detail = Option.getOrUndefined(result.threadDetail);
      const hasEvent = (detail?.messages.length ?? 0) > 0;
      expect(result.snapshotSequence).toBe(scenario.snapshotSequence);
      expect(
        hasEvent
          ? eventSequence <= result.snapshotSequence
          : eventSequence > result.snapshotSequence,
      ).toBe(true);
    }
  });
});

describe("subscribeThread authorization (T7 isolation half)", () => {
  const threadA = ThreadId.make("thread-A");
  const threadB = ThreadId.make("thread-B");

  it("lets a thread-scoped session bind to its own thread but refuses any other", () => {
    // Session S is scoped to thread A (subject === A): it may subscribe to A,
    // and is refused for B — so no per-aggregate queue is ever registered for B
    // and B events can never reach S, independent of the client-side filter.
    const sessionScopedToA = { role: "thread-scoped" as const, subject: threadA };

    expect(denyThreadAccess(sessionScopedToA, threadA)).toBeNull();

    const refused = denyThreadAccess(sessionScopedToA, threadB);
    expect(refused).not.toBeNull();
    expect(refused?.status).toBe(403);
  });

  it("keeps full thread visibility for owner and client sessions", () => {
    expect(denyThreadAccess({ role: "owner", subject: "owner-bootstrap" }, threadB)).toBeNull();
    expect(denyThreadAccess({ role: "client", subject: "client-x" }, threadB)).toBeNull();
  });
});

describe("terminalCallbackStream", () => {
  it("keeps a bounded sliding tail under a burst from a stalled consumer", async () => {
    const burstSize = TERMINAL_STREAM_BUFFER + 5;

    const values = await Effect.runPromise(
      terminalCallbackStream<number>((queue) =>
        Effect.gen(function* () {
          for (let value = 0; value < burstSize; value += 1) {
            yield* Queue.offer(queue, value);
          }
          yield* Queue.end(queue);
        }),
      ).pipe(
        Stream.runCollect,
        Effect.map((chunk) => Array.from(chunk)),
      ),
    );

    expect(values).toHaveLength(TERMINAL_STREAM_BUFFER);
    expect(values[0]).toBe(burstSize - TERMINAL_STREAM_BUFFER);
    expect(values.at(-1)).toBe(burstSize - 1);
  });
});
