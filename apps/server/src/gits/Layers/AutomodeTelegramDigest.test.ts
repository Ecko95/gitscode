// @effect-diagnostics nodeBuiltinImport:off
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { ServerConfig } from "../../config.ts";
import { AutomodeEpisodeLedger } from "../../persistence/Services/AutomodeEpisodeLedger.ts";
import { AutomodeSupervisor } from "../Services/AutomodeSupervisor.ts";
import { GitsSlotScheduler } from "../Services/GitsSlotScheduler.ts";
import { HermesTelegramNotifier } from "../Services/HermesTelegramNotifier.ts";
import { AutomodeTelegramDigest } from "../Services/AutomodeTelegramDigest.ts";
import { AutomodeTelegramDigestLive } from "./AutomodeTelegramDigest.ts";

const MORNING = Date.UTC(2026, 0, 7, 10, 0);
const DIGEST = Date.UTC(2026, 0, 7, 22, 0);

const snapshot = {
  policy: { mode: "autonomous", killSwitchEnabled: false },
  goals: [
    ...["one", "two", "three", "four", "five", "six"].map((title) => ({
      title,
      status: "queued",
    })),
    { title: "finished", status: "completed" },
    { title: "failed", status: "failed" },
  ],
  heldPrUrl: "https://github.com/t3tools/gits/pull/42",
};

function makeLayer(options: {
  readonly sent: string[];
  readonly failFirst?: boolean;
  readonly baseDir?: string;
}) {
  let attempts = 0;
  const notifier = Layer.mock(HermesTelegramNotifier)({
    notify: ({ subject, text }) =>
      Effect.sync(() => {
        attempts += 1;
        if (options.failFirst === true && attempts === 1) throw new Error("telegram unavailable");
        options.sent.push(`${subject}\n${text}`);
      }),
  });
  const supervisor = Layer.mock(AutomodeSupervisor)({
    getSnapshot: () => Effect.succeed(snapshot as never),
  });
  const scheduler = Layer.mock(GitsSlotScheduler)({
    getSnapshot: () => Effect.succeed({ goalsStartedTonight: 1 } as never),
  });
  const ledger = Layer.mock(AutomodeEpisodeLedger)({
    list_episodes: () => Effect.succeed([{ goalTitle: "finished", verdict: "pass" }] as never),
  });
  const config = ServerConfig.layerTest(
    process.cwd(),
    options.baseDir ?? { prefix: "gits-digest-test-" },
  ).pipe(Layer.provide(NodeServices.layer));
  return Layer.mergeAll(
    AutomodeTelegramDigestLive.pipe(
      Layer.provide(notifier),
      Layer.provide(supervisor),
      Layer.provide(scheduler),
      Layer.provide(ledger),
      Layer.provideMerge(config),
      Layer.provideMerge(NodeServices.layer),
    ),
    TestClock.layer(),
  );
}

describe("AutomodeTelegramDigest", () => {
  it.effect("delivers the morning report and evening digest once per London day", () => {
    const sent: string[] = [];
    return Effect.gen(function* () {
      const digest = yield* AutomodeTelegramDigest;
      yield* TestClock.setTime(MORNING);
      yield* digest.tick();
      yield* digest.tick();
      yield* TestClock.setTime(DIGEST);
      yield* digest.tick();
      yield* digest.tick();

      assert.equal(sent.length, 2);
      assert.match(sent[0] ?? "", /https:\/\/github\.com\/t3tools\/gits\/pull\/42/);
      assert.match(sent[0] ?? "", /finished/);
      assert.match(sent[0] ?? "", /failed/);
      assert.match(sent[0] ?? "", /1/);
      assert.match(sent[1] ?? "", /one/);
      assert.match(sent[1] ?? "", /five/);
      assert.notMatch(sent[1] ?? "", /six/);
    }).pipe(Effect.provide(makeLayer({ sent })));
  });

  it.effect("retries a failed delivery and retains successful dates across a fresh layer", () => {
    const sent: string[] = [];
    const baseDir = mkdtempSync(join(tmpdir(), "gits-digest-persistence-"));
    return Effect.gen(function* () {
      yield* TestClock.setTime(MORNING);
      const first = yield* AutomodeTelegramDigest;
      yield* first.tick();
      assert.equal(sent.length, 0);
      yield* first.tick();
      assert.equal(sent.length, 1);
    }).pipe(
      Effect.provide(makeLayer({ sent, failFirst: true, baseDir })),
      Effect.andThen(
        Effect.gen(function* () {
          const digest = yield* AutomodeTelegramDigest;
          yield* TestClock.setTime(MORNING);
          yield* digest.tick();
          assert.equal(sent.length, 1);
          const state = readFileSync(
            join(baseDir, "userdata", "gits", "automode-telegram-digest-state.json"),
            "utf8",
          );
          assert.match(state, /"lastDigestDate": null/);
          assert.match(state, /"lastMorningReportDate": "2026-01-07"/);
        }).pipe(Effect.provide(makeLayer({ sent, baseDir }))),
      ),
    );
  });

  it.effect("fails closed without delivery when persisted state is malformed", () => {
    const sent: string[] = [];
    const baseDir = mkdtempSync(join(tmpdir(), "gits-digest-corrupt-state-"));
    mkdirSync(join(baseDir, "userdata", "gits"), { recursive: true });
    writeFileSync(
      join(baseDir, "userdata", "gits", "automode-telegram-digest-state.json"),
      "not json",
    );
    return Effect.gen(function* () {
      yield* TestClock.setTime(MORNING);
      const digest = yield* AutomodeTelegramDigest;
      yield* digest.tick();
    }).pipe(
      Effect.provide(makeLayer({ sent, baseDir })),
      Effect.exit,
      Effect.tap((exit) => Effect.sync(() => assert.isTrue(Exit.isFailure(exit)))),
      Effect.tap(() => Effect.sync(() => assert.equal(sent.length, 0))),
    );
  });
});
