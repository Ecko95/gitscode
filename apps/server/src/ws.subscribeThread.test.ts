import type { OrchestrationEvent, OrchestrationThread } from "@t3tools/contracts";
import { MessageId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vitest";

import { denyThreadAccess } from "./auth/Services/ServerAuth.ts";
import {
  coalescePerTick,
  debounceShellThreadEvents,
  readThreadDetailSnapshot,
  resumeThreadStream,
  TERMINAL_STREAM_BUFFER,
  terminalCallbackStream,
} from "./ws.ts";

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

describe("coalescePerTick (T7-s3 WS frame batching)", () => {
  // Effect RPC sends one wire frame per stream chunk, so chunk count == frame
  // count. A burst inside one window must collapse to a single chunk; a gap
  // opens a new one; idle windows emit nothing.
  it("collapses a same-tick burst into one frame and splits across a gap", async () => {
    const chunks = await Effect.runPromise(
      coalescePerTick(
        Stream.callback<number>((queue) =>
          Effect.gen(function* () {
            for (let value = 0; value < 5; value += 1) {
              yield* Queue.offer(queue, value);
            }
            yield* Effect.sleep("120 millis");
            for (let value = 5; value < 8; value += 1) {
              yield* Queue.offer(queue, value);
            }
            yield* Effect.sleep("120 millis");
            yield* Queue.end(queue);
          }),
        ),
      ).pipe(
        Stream.chunks,
        Stream.map((chunk) => Array.from(chunk)),
        Stream.runCollect,
        Effect.map((collected) => Array.from(collected)),
      ),
    );

    // Two frames (one per burst window), order preserved, no empty frame.
    expect(chunks).toEqual([
      [0, 1, 2, 3, 4],
      [5, 6, 7],
    ]);
  });
});

describe("resumeThreadStream (T9-s2 resume-by-sequence)", () => {
  const threadA = ThreadId.make("thread-A");
  const threadB = ThreadId.make("thread-B");

  // resumeThreadStream reads only type/aggregateKind/aggregateId, so a minimal
  // synthetic event is enough to exercise the filter + ordering seam.
  const evt = (sequence: number, aggregateId: ThreadId, type: string): OrchestrationEvent =>
    ({ sequence, aggregateKind: "thread", aggregateId, type }) as unknown as OrchestrationEvent;

  it("replays catch-up then live, keeping only this thread's detail events in order", async () => {
    // Client disconnected at sequence k=10; readEvents(10) yields 11..14 (after
    // cursor). Catch-up carries a non-detail event (dropped) and a thread-B event
    // (dropped); live carries one more detail event for thread A.
    const catchUp = Stream.fromIterable([
      evt(11, threadA, "thread.message-sent"),
      evt(12, threadA, "thread.created"), // not a thread-detail event → dropped
      evt(13, threadB, "thread.message-sent"), // wrong thread → dropped
    ]);
    const live = Stream.fromIterable([evt(14, threadA, "thread.activity-appended")]);

    const items = await Effect.runPromise(
      resumeThreadStream(catchUp, live, threadA).pipe(
        Stream.runCollect,
        Effect.map((collected) => Array.from(collected)),
      ),
    );

    // No snapshot frame; exactly the thread-A detail events, catch-up before live,
    // strictly by sequence, no gap/duplicate.
    expect(items.map((item) => item.kind)).toEqual(["event", "event"]);
    expect(items.map((item) => item.event.sequence)).toEqual([11, 14]);
  });
});

describe("debounceShellThreadEvents (T8 thread-upserted coalescing)", () => {
  const threadA = ThreadId.make("thread-A");
  const threadB = ThreadId.make("thread-B");
  const projectId2 = ProjectId.make("project-2");

  // Minimal synthetic OrchestrationEvent — only the fields debounceShellThreadEvents reads.
  const threadEvt = (sequence: number, id: ThreadId): OrchestrationEvent =>
    ({
      sequence,
      aggregateKind: "thread",
      aggregateId: id,
      type: "thread.activity-appended",
    }) as unknown as OrchestrationEvent;

  const projectEvt = (sequence: number): OrchestrationEvent =>
    ({
      sequence,
      aggregateKind: "project",
      aggregateId: projectId2,
      type: "project.created",
    }) as unknown as OrchestrationEvent;

  it("passes the first thread event per threadId per window and suppresses the rest, passes non-thread events through", async () => {
    // Throttle (first-wins): 3 events for threadA (seqs 1,2,3) in rapid succession →
    // only seq=1 passes; 2 for threadB (seqs 4,5) → only seq=4 passes; project event
    // (seq=6) always passes. All emitted synchronously — well within the 200ms cooldown.
    const events = Stream.fromIterable<OrchestrationEvent>([
      threadEvt(1, threadA),
      threadEvt(2, threadA),
      threadEvt(3, threadA),
      threadEvt(4, threadB),
      threadEvt(5, threadB),
      projectEvt(6),
    ]);

    const result = await Effect.runPromise(
      debounceShellThreadEvents(events).pipe(
        Stream.runCollect,
        Effect.map((c) => Array.from(c).map((e) => e.sequence)),
      ),
    );

    // Burst of 3 threadA events → 1 emission (seq=1); burst of 2 threadB → 1 (seq=4);
    // project event → 1. Total: 3 events become 3 (1 per unique thread + project).
    expect(result).toEqual([1, 4, 6]);
  });

  it("emits one event per cooldown window when a thread bursts across two windows", async () => {
    // Window 1 (seqs 1+2 for threadA, < 1ms apart): only seq=1 passes.
    // Window 2 (seq=3 for threadA, > 200ms later): cooldown elapsed → seq=3 passes.
    const events = Stream.callback<OrchestrationEvent>((queue) =>
      Effect.gen(function* () {
        yield* Queue.offer(queue, threadEvt(1, threadA));
        yield* Queue.offer(queue, threadEvt(2, threadA));
        yield* Effect.sleep("300 millis"); // cross the 200ms cooldown boundary
        yield* Queue.offer(queue, threadEvt(3, threadA));
        yield* Queue.end(queue);
      }),
    );

    const result = await Effect.runPromise(
      debounceShellThreadEvents(events).pipe(
        Stream.runCollect,
        Effect.map((c) => Array.from(c).map((e) => e.sequence)),
      ),
    );

    // Window 1: seq=1 passes, seq=2 suppressed. Window 2: seq=3 passes.
    expect(result).toEqual([1, 3]);
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
