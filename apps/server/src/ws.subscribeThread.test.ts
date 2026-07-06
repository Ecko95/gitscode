import type { OrchestrationThread } from "@t3tools/contracts";
import { ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vitest";

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
  it("reads sequence before detail so interleaved commits stay live-replayable", async () => {
    const order: string[] = [];
    let committedSequence = 10;
    const thread = makeThread();

    const result = await Effect.runPromise(
      readThreadDetailSnapshot(threadId, {
        getSnapshotSequence: () =>
          Effect.sync(() => {
            order.push("sequence");
            const snapshotSequence = committedSequence;
            committedSequence = 11;
            return { snapshotSequence };
          }),
        getThreadDetailById: () =>
          Effect.sync(() => {
            order.push("detail");
            expect(committedSequence).toBe(11);
            return Option.some(thread);
          }),
      }),
    );

    expect(order).toEqual(["sequence", "detail"]);
    expect(result.snapshotSequence).toBe(10);
    expect(11 > result.snapshotSequence).toBe(true);
    expect(Option.getOrUndefined(result.threadDetail)).toBe(thread);
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
