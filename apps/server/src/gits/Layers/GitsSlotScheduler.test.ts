// @effect-diagnostics nodeBuiltinImport:off
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import {
  GitsCapacityError,
  type GitsCapacitySnapshot,
  type GitsProviderUsage,
  type GitsUsageWindow,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import {
  PushNotificationService,
  type PushNotificationPayload,
} from "../../push/Services/PushNotificationService.ts";
import { GitsCapacityMonitor } from "../Services/GitsCapacityMonitor.ts";
import { GitsSlotScheduler } from "../Services/GitsSlotScheduler.ts";
import {
  DEFAULT_SCHEDULER_SLOTS,
  GitsSlotSchedulerLive,
  current_night_key,
  current_slot,
  london_instant,
  next_slot_start,
  parse_scheduler_slots,
  slot_remaining_ms,
} from "./GitsSlotScheduler.ts";

// Fixed instants (London == UTC in January; BST in July).
const WED_0230 = Date.UTC(2026, 0, 7, 2, 30); // Wed 2026-01-07 02:30 London, in 00:00-05:00
const WED_0945 = Date.UTC(2026, 0, 7, 9, 45); // Wed 09:45, in 05:00-10:00, 15m runway
const WED_1200 = Date.UTC(2026, 0, 7, 12, 0); // Wed 12:00, outside all weekday slots
const WED_2200 = Date.UTC(2026, 0, 7, 22, 0); // Wed 22:00, evening arm → D+1
const SAT_1200 = Date.UTC(2026, 0, 10, 12, 0); // Sat 12:00, in weekend 10:00-15:00 slot

describe("london_instant", () => {
  it("formats a GMT winter instant", () => {
    const instant = london_instant(WED_0230);
    assert.deepEqual(instant, { dateKey: "2026-01-07", minutesOfDay: 150, isWeekend: false });
  });

  it("shifts a BST summer instant across midnight", () => {
    // 23:30 UTC on Tue 2026-07-14 is 00:30 on Wed 2026-07-15 in London (BST = UTC+1).
    const instant = london_instant(Date.UTC(2026, 6, 14, 23, 30));
    assert.deepEqual(instant, { dateKey: "2026-07-15", minutesOfDay: 30, isWeekend: false });
  });

  it("yields minute 0 at midnight (hourCycle h23 sanity)", () => {
    assert.equal(london_instant(Date.UTC(2026, 0, 7, 0, 0)).minutesOfDay, 0);
  });

  it("marks Saturday and Sunday as weekend", () => {
    assert.equal(london_instant(SAT_1200).isWeekend, true);
    assert.equal(london_instant(Date.UTC(2026, 0, 11, 12, 0)).isWeekend, true);
    assert.equal(london_instant(WED_1200).isWeekend, false);
  });
});

describe("slot math", () => {
  const slots = DEFAULT_SCHEDULER_SLOTS;

  it("finds the weekday night slots", () => {
    assert.deepEqual(current_slot(slots, WED_0230), { start: "00:00", end: "05:00" });
    assert.deepEqual(current_slot(slots, WED_0945), { start: "05:00", end: "10:00" });
    assert.equal(current_slot(slots, WED_1200), null);
  });

  it("includes the weekend day slot only on weekends", () => {
    assert.deepEqual(current_slot(slots, SAT_1200), { start: "10:00", end: "15:00" });
    assert.equal(current_slot(slots, WED_1200), null);
  });

  it("treats slot boundaries as start-inclusive, end-exclusive", () => {
    assert.deepEqual(current_slot(slots, Date.UTC(2026, 0, 7, 0, 0)), {
      start: "00:00",
      end: "05:00",
    });
    assert.deepEqual(current_slot(slots, Date.UTC(2026, 0, 7, 5, 0)), {
      start: "05:00",
      end: "10:00",
    });
    assert.equal(current_slot(slots, Date.UTC(2026, 0, 7, 10, 0)), null);
    assert.equal(current_slot(slots, Date.UTC(2026, 0, 10, 10, 0))?.end, "15:00");
    assert.equal(current_slot(slots, Date.UTC(2026, 0, 10, 15, 0)), null);
  });

  it("computes remaining slot time in wall-clock minutes", () => {
    assert.equal(slot_remaining_ms(slots, WED_0945), 15 * 60_000);
    assert.equal(slot_remaining_ms(slots, WED_1200), null);
  });

  it("selects the night key around midnight and around last-slot end", () => {
    assert.equal(current_night_key(slots, WED_0230), "2026-01-07"); // during the night
    assert.equal(current_night_key(slots, WED_2200), "2026-01-08"); // evening arm → D+1
    assert.equal(current_night_key(slots, WED_1200), "2026-01-08"); // weekday slots ended at 10:00
    assert.equal(current_night_key(slots, SAT_1200), "2026-01-10"); // Sat slot runs to 15:00
  });

  it("computes the D+1 night key calendar-wise on spring-forward eve (DST)", () => {
    // Sat 2026-03-28 23:30 London (GMT): +24h of instant arithmetic lands on 2026-03-30
    // because 2026-03-29 is a 23-hour day — the night key must still be 2026-03-29.
    assert.equal(current_night_key(slots, Date.UTC(2026, 2, 28, 23, 30)), "2026-03-29");
  });

  it("reports the next slot start when outside a window", () => {
    assert.equal(next_slot_start(slots, WED_2200), "00:00"); // tomorrow's first slot
    assert.equal(next_slot_start(slots, WED_1200), "00:00");
    assert.equal(next_slot_start(slots, Date.UTC(2026, 0, 10, 15, 30)), "00:00");
  });
});

describe("parse_scheduler_slots", () => {
  it("returns the defaults when unset", () => {
    const parsed = parse_scheduler_slots(undefined);
    assert.deepEqual(parsed, { slots: DEFAULT_SCHEDULER_SLOTS, error: null });
  });

  it("accepts a valid override", () => {
    const parsed = parse_scheduler_slots('[{"days":"all","start":"01:00","end":"02:30"}]');
    assert.equal(parsed.error, null);
    assert.deepEqual(parsed.slots, [{ days: "all", start: "01:00", end: "02:30" }]);
  });

  it("falls back to defaults on malformed JSON", () => {
    const parsed = parse_scheduler_slots("not json");
    assert.deepEqual(parsed.slots, DEFAULT_SCHEDULER_SLOTS);
    assert.isNotNull(parsed.error);
  });

  it("falls back to defaults on an inverted window", () => {
    const parsed = parse_scheduler_slots('[{"days":"all","start":"05:00","end":"05:00"}]');
    assert.deepEqual(parsed.slots, DEFAULT_SCHEDULER_SLOTS);
    assert.isNotNull(parsed.error);
  });
});

// --- Service tests ---------------------------------------------------------------------------

function usageWindow(
  label: string,
  usedPercent: number | null,
  resetAt = label === "5h" ? "2026-01-07T05:00:00.000Z" : "2026-01-14T00:00:00.000Z",
): GitsUsageWindow {
  return {
    label,
    usedPercent,
    remainingPercent: null,
    windowMinutes: label === "5h" ? 300 : 10_080,
    resetAt,
    level: "unknown",
    source: "codex-session-jsonl",
    note: null,
  };
}

function capacitySnapshot(windows: ReadonlyArray<GitsUsageWindow>): GitsCapacitySnapshot {
  const usage = (provider: "codex" | "cursor"): GitsProviderUsage => ({
    provider,
    displayName: provider,
    status: "available",
    source: "codex-session-jsonl",
    accountLabel: null,
    planLabel: null,
    windows: provider === "codex" ? windows : [],
    monthlyBudgetUsd: null,
    monthlySpendUsd: null,
    monthlyUtilizationPercent: null,
    monthlyRemainingUsd: null,
    monthlyResetAt: null,
    note: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  return {
    checkedAt: "2026-01-01T00:00:00.000Z",
    codex: usage("codex"),
    cursor: usage("cursor"),
    recommendation: {
      recommendedEngine: "codex",
      confidence: "low",
      reason: "test fixture",
      codexRemainingPercent: null,
      cursorRemainingPercent: null,
    },
    notes: [],
  };
}

const healthyCapacity = capacitySnapshot([usageWindow("5h", 10), usageWindow("weekly", 20)]);

interface MakeLayerOptions {
  readonly capacity?: Effect.Effect<GitsCapacitySnapshot, GitsCapacityError>;
  readonly pushes?: PushNotificationPayload[];
  readonly baseDir?: string;
}

function makeLayer(options?: MakeLayerOptions) {
  const capacity = Layer.mock(GitsCapacityMonitor)({
    getSnapshot: () => options?.capacity ?? Effect.succeed(healthyCapacity),
  });
  const push = Layer.mock(PushNotificationService)({
    getPublicConfig: () => ({ enabled: false, publicKey: null }),
    sendToAll: (payload) =>
      Effect.sync(() => {
        options?.pushes?.push(payload);
      }),
  });
  const config = (
    options?.baseDir !== undefined
      ? ServerConfig.layerTest(process.cwd(), options.baseDir)
      : ServerConfig.layerTest(process.cwd(), { prefix: "gits-slot-scheduler-test-" })
  ).pipe(Layer.provide(NodeServices.layer));
  return Layer.mergeAll(
    GitsSlotSchedulerLive.pipe(
      Layer.provide(capacity),
      Layer.provide(push),
      Layer.provideMerge(config),
      Layer.provideMerge(NodeServices.layer),
    ),
    TestClock.layer(),
  );
}

function schedulerStatePath(baseDir: string): string {
  return join(baseDir, "userdata", "gits", "automode-scheduler-state.json");
}

describe("GitsSlotScheduler arming", () => {
  it.effect("rejects arming while the scheduler is disabled", () =>
    Effect.gen(function* () {
      const scheduler = yield* GitsSlotScheduler;
      yield* TestClock.setTime(WED_0230);
      const error = yield* Effect.flip(scheduler.arm());
      assert.equal(error.message, "Enable the scheduler before arming.");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("arms for tonight and is idempotent for the same night", () =>
    Effect.gen(function* () {
      const scheduler = yield* GitsSlotScheduler;
      yield* TestClock.setTime(WED_0230);
      yield* scheduler.setConfig({ enabled: true });
      const armed = yield* scheduler.arm();
      assert.equal(armed.arming.status, "armed");
      assert.equal(armed.arming.nightKey, "2026-01-07");

      yield* TestClock.setTime(WED_0230 + 60_000);
      const again = yield* scheduler.arm();
      assert.equal(again.arming.armedAt, armed.arming.armedAt);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("an evening arm covers the NEXT London day", () =>
    Effect.gen(function* () {
      const scheduler = yield* GitsSlotScheduler;
      yield* TestClock.setTime(WED_2200);
      yield* scheduler.setConfig({ enabled: true });
      const armed = yield* scheduler.arm();
      assert.equal(armed.arming.nightKey, "2026-01-08");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("armed state expires (derived) once the night's last slot ends", () =>
    Effect.gen(function* () {
      const scheduler = yield* GitsSlotScheduler;
      yield* TestClock.setTime(WED_0230);
      yield* scheduler.setConfig({ enabled: true });
      yield* scheduler.arm();

      yield* TestClock.setTime(WED_1200); // weekday slots ended at 10:00
      const snapshot = yield* scheduler.getSnapshot();
      assert.equal(snapshot.arming.status, "disarmed");
      assert.equal(snapshot.arming.disarmedReason, "Armed night ended.");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("disarm records the reason and never requires an armed state", () =>
    Effect.gen(function* () {
      const scheduler = yield* GitsSlotScheduler;
      yield* TestClock.setTime(WED_0230);
      const snapshot = yield* scheduler.disarm({ reason: "manual stop" });
      assert.equal(snapshot.arming.status, "disarmed");
      assert.equal(snapshot.arming.disarmedReason, "manual stop");
      assert.equal(snapshot.automaticArmingAuthorized, false);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("approval enables automatic arming and targets the first eligible future night", () =>
    Effect.gen(function* () {
      const scheduler = yield* GitsSlotScheduler;
      yield* TestClock.setTime(WED_2200);
      const snapshot = yield* scheduler.scheduleApprovedGoal({
        eligibleAt: "2026-01-10T20:00:00.000Z",
      });
      assert.equal(snapshot.config.enabled, true);
      assert.equal(snapshot.automaticArmingAuthorized, true);
      assert.equal(snapshot.arming.status, "armed");
      assert.equal(snapshot.arming.nightKey, "2026-01-11");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("manual disarm prevents driver retargeting", () =>
    Effect.gen(function* () {
      const scheduler = yield* GitsSlotScheduler;
      yield* TestClock.setTime(WED_2200);
      yield* scheduler.scheduleApprovedGoal({ eligibleAt: null });
      yield* scheduler.disarm({ reason: "operator stop" });
      const snapshot = yield* scheduler.retargetApprovedGoal({
        eligibleAt: "2026-01-10T20:00:00.000Z",
      });
      assert.equal(snapshot.automaticArmingAuthorized, false);
      assert.equal(snapshot.arming.status, "disarmed");
    }).pipe(Effect.provide(makeLayer())),
  );
});

describe("GitsSlotScheduler gate", () => {
  const envelope = { expectedRuntimeMinutes: 60, maxActivePeers: 1 };

  const armTonight = Effect.gen(function* () {
    const scheduler = yield* GitsSlotScheduler;
    yield* TestClock.setTime(WED_0230);
    yield* scheduler.setConfig({ enabled: true });
    yield* scheduler.arm();
    return scheduler;
  });

  it.effect("bypasses when the scheduler is disabled and records nothing", () =>
    Effect.gen(function* () {
      const scheduler = yield* GitsSlotScheduler;
      yield* TestClock.setTime(WED_1200); // outside every slot — still allowed
      const result = yield* scheduler.checkStartAllowed(envelope);
      assert.deepEqual(result, { allowed: true, bypassed: true });
      assert.equal((yield* scheduler.getSnapshot()).lastGateDecision, null);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("denies when not armed for tonight", () =>
    Effect.gen(function* () {
      const scheduler = yield* GitsSlotScheduler;
      yield* TestClock.setTime(WED_0230);
      yield* scheduler.setConfig({ enabled: true });
      const result = yield* scheduler.checkStartAllowed(envelope);
      assert.deepEqual(result, {
        allowed: false,
        category: "schedule",
        reason: "Not armed for tonight",
        retryAt: null,
      });
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("denies once the armed night has ended", () =>
    Effect.gen(function* () {
      const scheduler = yield* armTonight;
      yield* TestClock.setTime(Date.UTC(2026, 0, 8, 2, 0)); // next night, old arm
      const result = yield* scheduler.checkStartAllowed(envelope);
      assert.deepEqual(result, {
        allowed: false,
        category: "schedule",
        reason: "Armed night ended",
        retryAt: null,
      });
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("denies outside the slot windows with the next slot start", () =>
    Effect.gen(function* () {
      const scheduler = yield* GitsSlotScheduler;
      yield* TestClock.setTime(WED_2200);
      yield* scheduler.setConfig({ enabled: true });
      yield* scheduler.arm(); // arms for 2026-01-08 — nightKey matches, slot does not
      const result = yield* scheduler.checkStartAllowed(envelope);
      assert.deepEqual(result, {
        allowed: false,
        category: "schedule",
        reason: "Outside slot window (next slot 00:00)",
        retryAt: "2026-01-08T00:00:00.000Z",
      });
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("denies when the night goal cap is reached", () =>
    Effect.gen(function* () {
      const scheduler = yield* armTonight;
      for (const goalId of ["g1", "g2", "g3"]) {
        yield* scheduler.recordGoalStart({ goalId, episodeId: `epi-${goalId}` });
      }
      const result = yield* scheduler.checkStartAllowed(envelope);
      assert.deepEqual(result, {
        allowed: false,
        category: "schedule",
        reason: "Night goal cap reached (3)",
        retryAt: null,
      });
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("denies the envelope violations in order", () =>
    Effect.gen(function* () {
      const scheduler = yield* armTonight;

      const peers = yield* scheduler.checkStartAllowed({ ...envelope, maxActivePeers: 2 });
      assert.deepEqual(peers, {
        allowed: false,
        category: "policy",
        reason: "Autonomy envelope requires maxActivePeers=1 (policy has 2)",
        retryAt: null,
      });

      const noCap = yield* scheduler.checkStartAllowed({
        ...envelope,
        expectedRuntimeMinutes: null,
      });
      assert.deepEqual(noCap, {
        allowed: false,
        category: "policy",
        reason: "No runtime cap configured",
        retryAt: null,
      });

      const tooLong = yield* scheduler.checkStartAllowed({
        ...envelope,
        expectedRuntimeMinutes: 120,
      });
      assert.deepEqual(tooLong, {
        allowed: false,
        category: "policy",
        reason: "Runtime cap exceeds the night envelope (~90m)",
        retryAt: null,
      });
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("denies when the slot runway is shorter than the runtime cap", () =>
    Effect.gen(function* () {
      const scheduler = yield* armTonight;
      yield* TestClock.setTime(WED_0945); // 15 minutes of runway left
      const result = yield* scheduler.checkStartAllowed(envelope);
      assert.deepEqual(result, {
        allowed: false,
        category: "schedule",
        reason: "Insufficient slot runway",
        retryAt: "2026-01-08T00:00:00.000Z",
      });
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("denies a hot codex 5h window at exactly the inclusive 50% boundary", () =>
    Effect.gen(function* () {
      const scheduler = yield* armTonight;
      const result = yield* scheduler.checkStartAllowed(envelope);
      assert.deepEqual(result, {
        allowed: false,
        category: "quota",
        reason: "Codex 5h window at 50%",
        retryAt: "2026-01-07T05:00:00.000Z",
      });
    }).pipe(
      Effect.provide(
        makeLayer({
          capacity: Effect.succeed(
            capacitySnapshot([usageWindow("5h", 50), usageWindow("weekly", 20)]),
          ),
        }),
      ),
    ),
  );

  it.effect("denies when the weekly window eats the interactive reserve", () =>
    Effect.gen(function* () {
      const scheduler = yield* armTonight;
      const result = yield* scheduler.checkStartAllowed(envelope);
      assert.deepEqual(result, {
        allowed: false,
        category: "quota",
        reason: "Codex weekly window at 85% (reserve 20%)",
        retryAt: "2026-01-14T00:00:00.000Z",
      });
    }).pipe(
      Effect.provide(
        makeLayer({
          capacity: Effect.succeed(
            capacitySnapshot([usageWindow("5h", 10), usageWindow("weekly", 85)]),
          ),
        }),
      ),
    ),
  );

  it.effect("fails closed on missing capacity telemetry", () =>
    Effect.gen(function* () {
      const scheduler = yield* armTonight;
      const result = yield* scheduler.checkStartAllowed(envelope);
      assert.deepEqual(result, {
        allowed: false,
        category: "quota",
        reason: "Codex 5h and weekly quota telemetry is missing or stale",
        retryAt: null,
      });
      const snapshot = yield* scheduler.getSnapshot();
      assert.equal(snapshot.lastGateDecision?.allowed, false);
      assert.equal(
        snapshot.lastGateDecision?.reason,
        "Codex 5h and weekly quota telemetry is missing or stale",
      );
    }).pipe(Effect.provide(makeLayer({ capacity: Effect.succeed(capacitySnapshot([])) }))),
  );

  it.effect("fails closed on a capacity monitor error", () =>
    Effect.gen(function* () {
      const scheduler = yield* armTonight;
      const result = yield* scheduler.checkStartAllowed(envelope);
      assert.deepEqual(result, {
        allowed: false,
        category: "quota",
        reason: "Codex quota telemetry unavailable (capacity monitor error)",
        retryAt: null,
      });
      const snapshot = yield* scheduler.getSnapshot();
      assert.equal(
        snapshot.lastGateDecision?.reason,
        "Codex quota telemetry unavailable (capacity monitor error)",
      );
    }).pipe(
      Effect.provide(
        makeLayer({
          capacity: Effect.fail(new GitsCapacityError({ message: "usage reader exploded" })),
        }),
      ),
    ),
  );

  it.effect("treats expired reset telemetry as stale", () =>
    Effect.gen(function* () {
      const scheduler = yield* armTonight;
      const result = yield* scheduler.checkStartAllowed(envelope);
      assert.deepEqual(result, {
        allowed: false,
        category: "quota",
        reason: "Codex 5h quota telemetry is missing or stale",
        retryAt: null,
      });
    }).pipe(
      Effect.provide(
        makeLayer({
          capacity: Effect.succeed(
            capacitySnapshot([
              usageWindow("5h", 10, "2026-01-07T02:00:00.000Z"),
              usageWindow("weekly", 20),
            ]),
          ),
        }),
      ),
    ),
  );

  it.effect("uses the later reset when both quota windows block", () =>
    Effect.gen(function* () {
      const scheduler = yield* armTonight;
      const result = yield* scheduler.checkStartAllowed(envelope);
      assert.deepEqual(result, {
        allowed: false,
        category: "quota",
        reason: "Codex 5h and weekly windows exceed their limits",
        retryAt: "2026-01-14T00:00:00.000Z",
      });
    }).pipe(
      Effect.provide(
        makeLayer({
          capacity: Effect.succeed(
            capacitySnapshot([usageWindow("5h", 60), usageWindow("weekly", 90)]),
          ),
        }),
      ),
    ),
  );

  it.effect("allows a healthy armed in-slot start and records the decision", () =>
    Effect.gen(function* () {
      const scheduler = yield* armTonight;
      const result = yield* scheduler.checkStartAllowed(envelope);
      assert.deepEqual(result, { allowed: true });
      const snapshot = yield* scheduler.getSnapshot();
      assert.equal(snapshot.lastGateDecision?.allowed, true);
      assert.equal(snapshot.lastGateDecision?.reason, null);
    }).pipe(Effect.provide(makeLayer())),
  );
});

describe("GitsSlotScheduler persistence", () => {
  it.effect("boot with a persisted armed state forces a disarm and notifies", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "gits-slot-scheduler-boot-"));
    mkdirSync(join(baseDir, "userdata", "gits"), { recursive: true });
    writeFileSync(
      schedulerStatePath(baseDir),
      JSON.stringify({
        version: 1,
        config: { enabled: true, maxGoalsPerNight: 3, weeklyMaxUsedPercent: 80 },
        arming: {
          status: "armed",
          nightKey: "2026-01-07",
          armedAt: "2026-01-07T01:00:00.000Z",
          disarmedReason: null,
        },
        nightLog: [],
        lastGateDecision: null,
        lastEvent: "Scheduler armed for 2026-01-07.",
        updatedAt: "2026-01-07T01:00:00.000Z",
      }),
    );
    const pushes: PushNotificationPayload[] = [];
    return Effect.gen(function* () {
      const scheduler = yield* GitsSlotScheduler;
      const snapshot = yield* scheduler.getSnapshot();
      assert.equal(snapshot.arming.status, "disarmed");
      assert.equal(snapshot.arming.disarmedReason, "Server restarted mid-night — re-arm required.");
      assert.equal(snapshot.lastEvent, "Server restarted mid-night — re-arm required.");
      assert.equal(pushes.length, 1);
      assert.deepEqual(pushes[0], {
        title: "GITS autonomy disarmed",
        body: "Server restarted mid-night — re-arm required.",
        tag: "gits-scheduler-boot",
        url: "/gits",
      });
    }).pipe(Effect.provide(makeLayer({ baseDir, pushes })));
  });

  it.effect("loads a sparse legacy state file via decoding defaults", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "gits-slot-scheduler-legacy-"));
    mkdirSync(join(baseDir, "userdata", "gits"), { recursive: true });
    writeFileSync(
      schedulerStatePath(baseDir),
      JSON.stringify({ version: 1, updatedAt: "2026-01-07T01:00:00.000Z" }),
    );
    return Effect.gen(function* () {
      const scheduler = yield* GitsSlotScheduler;
      const snapshot = yield* scheduler.getSnapshot();
      assert.deepEqual(snapshot.config, {
        enabled: false,
        maxGoalsPerNight: 3,
        weeklyMaxUsedPercent: 80,
      });
      assert.equal(snapshot.arming.status, "disarmed");
    }).pipe(Effect.provide(makeLayer({ baseDir })));
  });

  it.effect("prunes night-log entries older than the retention window on write", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "gits-slot-scheduler-prune-"));
    return Effect.gen(function* () {
      const scheduler = yield* GitsSlotScheduler;
      yield* TestClock.setTime(WED_0230);
      yield* scheduler.recordGoalStart({ goalId: "goal-old", episodeId: "epi-old" });

      yield* TestClock.setTime(WED_0230 + 20 * 86_400_000);
      yield* scheduler.recordGoalStart({ goalId: "goal-new", episodeId: "epi-new" });

      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const persisted = JSON.parse(readFileSync(schedulerStatePath(baseDir), "utf8")) as {
        nightLog: ReadonlyArray<{ goalId: string; episodeId: string }>;
      };
      assert.equal(persisted.nightLog.length, 1);
      assert.deepEqual(
        { goalId: persisted.nightLog[0]?.goalId, episodeId: persisted.nightLog[0]?.episodeId },
        { goalId: "goal-new", episodeId: "epi-new" },
      );
    }).pipe(Effect.provide(makeLayer({ baseDir })));
  });
});
