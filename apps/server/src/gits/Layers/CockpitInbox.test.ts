// @effect-diagnostics nodeBuiltinImport:off
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { ServerConfig } from "../../config.ts";
import { CockpitInbox } from "../Services/CockpitInbox.ts";
import { CockpitInboxLive } from "./CockpitInbox.ts";

const JAN_1 = Date.UTC(2026, 0, 1, 0, 0);
const APR_5 = Date.UTC(2026, 3, 5, 0, 0);

function makeLayer(baseDir?: string) {
  const config = (
    baseDir === undefined
      ? ServerConfig.layerTest(process.cwd(), { prefix: "cockpit-inbox-test-" })
      : ServerConfig.layerTest(process.cwd(), baseDir)
  ).pipe(Layer.provide(NodeServices.layer));
  return Layer.mergeAll(
    CockpitInboxLive.pipe(Layer.provideMerge(config), Layer.provideMerge(NodeServices.layer)),
    TestClock.layer(),
  );
}

function event(
  episodeId: string,
  state: "pending-review" | "waiting-quota-reset" | "completed",
  eventKey = `${episodeId}:${state}`,
) {
  return {
    episodeId,
    proposalId: `proposal-${episodeId}`,
    goalId: state === "pending-review" ? null : `goal-${episodeId}`,
    title: `Work ${episodeId}`,
    repository: "/tmp/repo",
    eventKey,
    state,
    reason: `Entered ${state}`,
    deepLink: `/gits?panel=autopilot&proposal=proposal-${episodeId}`,
  } as const;
}

describe("CockpitInbox", () => {
  it.effect(
    "deduplicates timelines, derives unread, filters, pins, and prunes only terminal items",
    () =>
      Effect.gen(function* () {
        const inbox = yield* CockpitInbox;
        yield* TestClock.setTime(JAN_1);

        yield* inbox.record(event("active", "pending-review"));
        yield* inbox.record(event("active", "pending-review"));
        assert.equal((yield* inbox.list({})).items[0]?.timeline.length, 1);

        yield* inbox.markRead({ id: "active" });
        assert.equal((yield* inbox.list({ filter: "unread" })).items.length, 0);
        yield* inbox.record(event("active", "waiting-quota-reset"));
        assert.equal((yield* inbox.list({ filter: "unread" })).items.length, 1);
        assert.equal((yield* inbox.list({ filter: "waiting" })).items[0]?.id, "active");

        yield* inbox.record(event("expired", "completed"));
        yield* inbox.record(event("pinned", "completed"));
        yield* inbox.setPinned({ id: "pinned", pinned: true });

        yield* TestClock.setTime(APR_5);
        yield* inbox.record(event("fresh", "pending-review"));
        const ids = (yield* inbox.list({})).items.map((item) => item.id);
        assert.deepEqual(new Set(ids), new Set(["active", "pinned", "fresh"]));
        assert.equal((yield* inbox.list({ filter: "completed" })).counts.completed, 1);
      }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("loads persisted items after restart", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "cockpit-inbox-restart-"));
    return Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const inbox = yield* CockpitInbox;
          yield* TestClock.setTime(JAN_1);
          yield* inbox.record(event("restart", "pending-review"));
        }).pipe(Effect.provide(makeLayer(baseDir))),
      );
      const items = yield* Effect.scoped(
        Effect.gen(function* () {
          const inbox = yield* CockpitInbox;
          return (yield* inbox.list({})).items;
        }).pipe(Effect.provide(makeLayer(baseDir))),
      );
      assert.equal(items[0]?.id, "restart");
    });
  });

  it.effect("refuses reads and writes when persisted JSON is corrupt", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "cockpit-inbox-corrupt-"));
    mkdirSync(join(baseDir, "userdata", "gits"), { recursive: true });
    writeFileSync(join(baseDir, "userdata", "gits", "cockpit-inbox.json"), "not-json\n");
    return Effect.gen(function* () {
      const inbox = yield* CockpitInbox;
      const readError = yield* Effect.flip(inbox.list({}));
      const writeError = yield* Effect.flip(inbox.record(event("blocked", "pending-review")));
      assert.match(readError.message, /unavailable/i);
      assert.match(writeError.message, /unavailable/i);
    }).pipe(Effect.provide(makeLayer(baseDir)));
  });
});
