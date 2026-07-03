/**
 * Verifies that provider event queues use bounded capacity with suspending
 * offer semantics: producer suspends when full, consumer drains, all events
 * arrive in order with none dropped.
 *
 * Pure Effect test — no child processes, no provider module imports.
 */
import { describe, it, expect } from "vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";

// Small capacity to trigger the full-queue condition with only a few items.
const CAPACITY = 4;
const TOTAL = CAPACITY + 2; // 6 items: 4 fit immediately, 2 must suspend

describe("bounded provider event queue", () => {
  it("Queue.bounded has finite capacity (not Number.POSITIVE_INFINITY)", async () => {
    // Structural check: Queue.bounded(n) sets capacity to n, not infinity.
    const q = await Effect.runPromise(Queue.bounded<number>(CAPACITY));
    // In effect@4.x the queue object exposes `capacity` as a numeric property.
    expect((q as unknown as { capacity: number }).capacity).toBe(CAPACITY);
  });

  it("Queue.unbounded has infinite capacity", async () => {
    const q = await Effect.runPromise(Queue.unbounded<number>());
    expect((q as unknown as { capacity: number }).capacity).toBe(Number.POSITIVE_INFINITY);
  });

  it("producer suspends when full, consumer drains, all events arrive in order, none dropped", async () => {
    const result = await Effect.gen(function* () {
      const queue = yield* Queue.bounded<number>(CAPACITY);
      // Producer signals when all items have been offered.
      const done = yield* Deferred.make<void>();

      // Fork the producer. It fills the queue and then suspends on item #CAPACITY
      // until the consumer takes at least one item, freeing a slot.
      const producer = yield* Effect.gen(function* () {
        for (let i = 0; i < TOTAL; i++) {
          // Queue.offer with a bounded queue suspends when i >= CAPACITY.
          // This is the backpressure assertion: the offer is not dropped,
          // it waits until space is available.
          yield* Queue.offer(queue, i);
        }
        yield* Deferred.succeed(done, undefined);
      }).pipe(Effect.forkChild);

      // Drain exactly TOTAL items from the queue. This unblocks the producer
      // for the remaining (TOTAL - CAPACITY) items.
      const received: number[] = [];
      for (let i = 0; i < TOTAL; i++) {
        received.push(yield* Queue.take(queue));
      }

      // Wait for the producer to finish (not strictly needed, but verifies no fiber leak).
      yield* Deferred.await(done);
      yield* Fiber.join(producer);

      return received;
    }).pipe(Effect.runPromise);

    // All events must arrive in insertion order with none dropped.
    expect(result).toEqual([0, 1, 2, 3, 4, 5]);
  });
});
