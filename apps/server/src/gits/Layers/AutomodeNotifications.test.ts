import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { deliverAutomodeNotification } from "./AutomodeNotifications.ts";

describe("deliverAutomodeNotification", () => {
  it.effect("routes independently and deduplicates stable event keys", () =>
    Effect.gen(function* () {
      const delivered = new Set<string>();
      const push: string[] = [];
      const telegram: string[] = [];
      const input = {
        key: "proposal:p1:created",
        subject: "New Motoko proposal",
        text: "Improve retries",
        url: "/gits?panel=autopilot&proposal=p1",
        gitsEnabled: true,
        telegramEnabled: false,
      };
      const dependencies = {
        delivered,
        push: (url: string) => Effect.sync(() => push.push(url)).pipe(Effect.asVoid),
        telegram: (text: string) => Effect.sync(() => telegram.push(text)).pipe(Effect.asVoid),
      };

      yield* deliverAutomodeNotification(input, dependencies);
      yield* deliverAutomodeNotification(input, dependencies);

      assert.deepEqual(push, ["/gits?panel=autopilot&proposal=p1"]);
      assert.deepEqual(telegram, []);

      yield* deliverAutomodeNotification(
        { ...input, key: "proposal:p2:created", gitsEnabled: false, telegramEnabled: true },
        dependencies,
      );
      assert.deepEqual(telegram, ["Improve retries"]);
    }),
  );

  it.effect("does not fail state transitions when delivery fails", () =>
    Effect.gen(function* () {
      const delivered = new Set<string>();
      yield* deliverAutomodeNotification(
        {
          key: "goal:g1:failed",
          subject: "Automode attention needed",
          text: "Goal failed",
          url: "/gits?panel=autopilot&section=goals",
          gitsEnabled: true,
          telegramEnabled: true,
        },
        {
          delivered,
          push: () => Effect.fail("push failed"),
          telegram: () => Effect.fail("telegram failed"),
        },
      );
      assert.isFalse(delivered.has("gits:goal:g1:failed"));
      assert.isFalse(delivered.has("telegram:goal:g1:failed"));
    }),
  );
});
