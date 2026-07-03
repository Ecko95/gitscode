/**
 * Tests for logSequenceGap — the subscribe-sequence invariant guard in ws.ts.
 *
 * Verifies that:
 * 1. A gap (firstLiveSequence > snapshotSequence + 1) emits a structured warn.
 * 2. A healthy subscribe (no gap) is silent.
 * 3. An exact-boundary case (firstLiveSequence === snapshotSequence + 1) is also silent.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import { describe, expect, it } from "vitest";

import { logSequenceGap } from "./ws.ts";

describe("logSequenceGap", () => {
  function runWithCapture(effect: Effect.Effect<void>): Promise<string[]> {
    const messages: string[] = [];
    const testLogger = Logger.make(({ message }) => {
      messages.push(String(message));
    });
    return Effect.runPromise(
      effect.pipe(Effect.provide(Logger.layer([testLogger], { mergeWithExisting: false }))),
    ).then(() => messages);
  }

  it("logs a warning when firstLiveSequence skips past snapshot boundary", async () => {
    const messages = await runWithCapture(logSequenceGap("subscribeThread:thread-1", 5, 8));
    expect(messages.some((m) => m.includes("subscribe-sequence-gap"))).toBe(true);
  });

  it("is silent when first live sequence is exactly snapshot + 1 (healthy)", async () => {
    const messages = await runWithCapture(logSequenceGap("subscribeThread:thread-1", 5, 6));
    expect(messages).toHaveLength(0);
  });

  it("is silent when first live sequence equals snapshot (replay overlap, no gap)", async () => {
    const messages = await runWithCapture(logSequenceGap("subscribeThread:thread-1", 5, 5));
    expect(messages).toHaveLength(0);
  });

  it("includes gap label in the warning message", async () => {
    const messages = await runWithCapture(logSequenceGap("subscribeShell", 10, 15));
    expect(messages.some((m) => m.includes("subscribe-sequence-gap"))).toBe(true);
  });
});
