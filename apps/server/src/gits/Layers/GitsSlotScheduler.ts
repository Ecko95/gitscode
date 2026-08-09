import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import {
  GitsSchedulerArming as GitsSchedulerArmingSchema,
  GitsSchedulerConfig as GitsSchedulerConfigSchema,
  GitsSchedulerGateDecision as GitsSchedulerGateDecisionSchema,
  GitsSlotSchedulerError,
  type GitsCapacitySnapshot,
  type GitsSchedulerArming,
  type GitsSchedulerConfig,
  type GitsSchedulerGateDecision,
  type GitsSchedulerSnapshot,
} from "@t3tools/contracts";

import { writeFileStringAtomically } from "../../atomicWrite.ts";
import { ServerConfig } from "../../config.ts";
import { PushNotificationService } from "../../push/Services/PushNotificationService.ts";
import { GitsCapacityMonitor } from "../Services/GitsCapacityMonitor.ts";
import {
  GitsSlotScheduler,
  type GitsSchedulerGateResult,
  type GitsSlotSchedulerShape,
} from "../Services/GitsSlotScheduler.ts";

const SCHEDULER_STATE_FILE_NAME = "automode-scheduler-state.json";
const DAY_MS = 86_400_000;
// ponytail: hard V1 night envelope (decision 11); the phase-3 repo registry owns per-repo envelopes.
const NIGHT_MAX_RUNTIME_MINUTES = 90;
const CAPACITY_MAX_USED_PERCENT_5H = 50;
// ponytail: 60s capacity memo — GitsCapacityMonitor re-parses codex session tails on every call.
const CAPACITY_MEMO_TTL_MS = 60_000;
const NIGHT_LOG_RETENTION_NIGHTS = 14;
const BOOT_DISARM_REASON = "Server restarted mid-night — re-arm required.";

// --- London time helper (the ONLY timezone-aware code in the scheduler) --------------------

export interface LondonInstant {
  /** "YYYY-MM-DD" London calendar date. */
  readonly dateKey: string;
  readonly minutesOfDay: number;
  readonly isWeekend: boolean;
}

// hourCycle "h23" explicitly — hour12:false can yield "24" at midnight on some ICU builds.
const LONDON_FORMAT = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  hourCycle: "h23",
  weekday: "short",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

export function london_instant(epochMs: number): LondonInstant {
  const parts = new Map(
    LONDON_FORMAT.formatToParts(epochMs).map((part) => [part.type, part.value] as const),
  );
  const dateKey = `${parts.get("year")}-${parts.get("month")}-${parts.get("day")}`;
  const minutesOfDay =
    Number.parseInt(parts.get("hour") ?? "0", 10) * 60 +
    Number.parseInt(parts.get("minute") ?? "0", 10);
  const weekday = parts.get("weekday");
  return { dateKey, minutesOfDay, isWeekend: weekday === "Sat" || weekday === "Sun" };
}

// --- Slot model (decision 6) ----------------------------------------------------------------

export interface GitsSchedulerSlotWindow {
  readonly days: "all" | "weekend";
  readonly start: string; // "HH:MM" London wall clock
  readonly end: string; // "HH:MM", same-day, start < end
}

export const DEFAULT_SCHEDULER_SLOTS: ReadonlyArray<GitsSchedulerSlotWindow> = [
  { days: "all", start: "00:00", end: "05:00" },
  { days: "all", start: "05:00", end: "10:00" },
  { days: "weekend", start: "10:00", end: "15:00" },
];

const SLOT_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

function minutes_of(hhmm: string): number {
  return Number.parseInt(hhmm.slice(0, 2), 10) * 60 + Number.parseInt(hhmm.slice(3, 5), 10);
}

/** GITS_SCHEDULER_SLOTS_JSON override; invalid input falls back to the defaults with an error message. */
export function parse_scheduler_slots(raw: string | undefined): {
  readonly slots: ReadonlyArray<GitsSchedulerSlotWindow>;
  readonly error: string | null;
} {
  if (raw === undefined || raw.trim().length === 0) {
    return { slots: DEFAULT_SCHEDULER_SLOTS, error: null };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error("expected a non-empty array of slots");
    }
    const slots = parsed.map((entry): GitsSchedulerSlotWindow => {
      const candidate = entry as { days?: unknown; start?: unknown; end?: unknown } | null;
      const days = candidate?.days;
      const start = candidate?.start;
      const end = candidate?.end;
      if (
        (days !== "all" && days !== "weekend") ||
        typeof start !== "string" ||
        typeof end !== "string" ||
        !SLOT_TIME_PATTERN.test(start) ||
        !SLOT_TIME_PATTERN.test(end) ||
        minutes_of(start) >= minutes_of(end)
      ) {
        throw new Error(`invalid slot entry ${JSON.stringify(entry)}`);
      }
      return { days, start, end };
    });
    return { slots, error: null };
  } catch (cause) {
    return {
      slots: DEFAULT_SCHEDULER_SLOTS,
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

function day_slots(
  slots: ReadonlyArray<GitsSchedulerSlotWindow>,
  isWeekend: boolean,
): ReadonlyArray<GitsSchedulerSlotWindow> {
  return slots.filter((slot) => slot.days === "all" || isWeekend);
}

export function current_slot(
  slots: ReadonlyArray<GitsSchedulerSlotWindow>,
  epochMs: number,
): { readonly start: string; readonly end: string } | null {
  const now = london_instant(epochMs);
  const slot = day_slots(slots, now.isWeekend).find(
    (candidate) =>
      minutes_of(candidate.start) <= now.minutesOfDay &&
      now.minutesOfDay < minutes_of(candidate.end),
  );
  return slot === undefined ? null : { start: slot.start, end: slot.end };
}

// ponytail: wall-clock minutes — off by ±1h exactly two nights/year (DST transitions inside
// 00:00-05:00); autumn denies more (safe), spring overestimates runway bounded by the runtime cap.
export function slot_remaining_ms(
  slots: ReadonlyArray<GitsSchedulerSlotWindow>,
  epochMs: number,
): number | null {
  const slot = current_slot(slots, epochMs);
  return slot === null
    ? null
    : (minutes_of(slot.end) - london_instant(epochMs).minutesOfDay) * 60_000;
}

function last_slot_end_minutes(
  slots: ReadonlyArray<GitsSchedulerSlotWindow>,
  isWeekend: boolean,
): number {
  return Math.max(...day_slots(slots, isWeekend).map((slot) => minutes_of(slot.end)), 0);
}

/**
 * Autonomy day: if now is before the end of today's last slot, tonight IS today; otherwise
 * tonight is tomorrow, computed calendar-wise from today's date key — instant +24h skips a
 * calendar day when called 23:00–23:59 London on spring-forward eve (a 23-hour day).
 */
export function current_night_key(
  slots: ReadonlyArray<GitsSchedulerSlotWindow>,
  epochMs: number,
): string {
  const now = london_instant(epochMs);
  if (now.minutesOfDay < last_slot_end_minutes(slots, now.isWeekend)) {
    return now.dateKey;
  }
  // Noon UTC of calendar day D+1 is always calendar day D+1 in London (offset 0 or +1).
  const [year, month, day] = now.dateKey.split("-").map(Number);
  return london_instant(Date.UTC(year ?? 0, (month ?? 1) - 1, (day ?? 0) + 1, 12)).dateKey;
}

export function next_slot_start(
  slots: ReadonlyArray<GitsSchedulerSlotWindow>,
  epochMs: number,
): string {
  const now = london_instant(epochMs);
  const laterToday = day_slots(slots, now.isWeekend)
    .map((slot) => slot.start)
    .filter((start) => minutes_of(start) > now.minutesOfDay)
    .sort((left, right) => minutes_of(left) - minutes_of(right))[0];
  if (laterToday !== undefined) {
    return laterToday;
  }
  const tomorrow = london_instant(epochMs + DAY_MS);
  const tomorrowStarts = day_slots(slots, tomorrow.isWeekend)
    .map((slot) => slot.start)
    .sort((left, right) => minutes_of(left) - minutes_of(right));
  return tomorrowStarts[0] ?? "00:00";
}

export function next_slot_start_at(
  slots: ReadonlyArray<GitsSchedulerSlotWindow>,
  epochMs: number,
): string | null {
  let wasInSlot = current_slot(slots, epochMs) !== null;
  const minute = Math.floor(epochMs / 60_000) * 60_000;
  for (let offset = 1; offset <= 48 * 60; offset += 1) {
    const candidate = minute + offset * 60_000;
    const inSlot = current_slot(slots, candidate) !== null;
    if (inSlot && !wasInSlot) return DateTime.formatIso(DateTime.makeUnsafe(candidate));
    wasInSlot = inSlot;
  }
  return null;
}

// --- Persisted state ------------------------------------------------------------------------

const DEFAULT_SCHEDULER_CONFIG: GitsSchedulerConfig = {
  enabled: false,
  maxGoalsPerNight: 3,
  weeklyMaxUsedPercent: 80,
};

const DISARMED_ARMING: GitsSchedulerArming = {
  status: "disarmed",
  nightKey: null,
  armedAt: null,
  disarmedReason: null,
};

const PersistedNightLogEntry = Schema.Struct({
  nightKey: Schema.String,
  goalId: Schema.String,
  episodeId: Schema.String,
  startedAt: Schema.String,
});
type PersistedNightLogEntry = typeof PersistedNightLogEntry.Type;

const PersistedSchedulerState = Schema.Struct({
  version: Schema.Literal(1),
  config: GitsSchedulerConfigSchema.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SCHEDULER_CONFIG)),
  ),
  arming: GitsSchedulerArmingSchema.pipe(
    Schema.withDecodingDefault(Effect.succeed(DISARMED_ARMING)),
  ),
  automaticArmingAuthorized: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  nightLog: Schema.Array(PersistedNightLogEntry).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  lastGateDecision: Schema.NullOr(GitsSchedulerGateDecisionSchema).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  lastEvent: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  updatedAt: Schema.String,
});
type PersistedSchedulerState = typeof PersistedSchedulerState.Type;

const decodePersistedSchedulerState = Schema.decodeUnknownEffect(
  Schema.fromJsonString(PersistedSchedulerState),
);

interface SchedulerState {
  readonly config: GitsSchedulerConfig;
  readonly arming: GitsSchedulerArming;
  readonly automaticArmingAuthorized: boolean;
  readonly nightLog: ReadonlyArray<PersistedNightLogEntry>;
  readonly lastGateDecision: GitsSchedulerGateDecision | null;
  readonly lastEvent: string | null;
  readonly updatedAt: string;
}

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const nowEpochMs = DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));

function toSchedulerError(message: string, cause?: unknown) {
  return new GitsSlotSchedulerError({
    message,
    ...(cause === undefined ? {} : { cause }),
  });
}

function default_state(updatedAt: string): SchedulerState {
  return {
    config: DEFAULT_SCHEDULER_CONFIG,
    arming: DISARMED_ARMING,
    automaticArmingAuthorized: false,
    nightLog: [],
    lastGateDecision: null,
    lastEvent: "Scheduler initialized (disabled).",
    updatedAt,
  };
}

function persistSchedulerState(statePath: string, state: SchedulerState) {
  const persisted: PersistedSchedulerState = {
    version: 1,
    ...state,
    nightLog: [...state.nightLog],
  };
  return writeFileStringAtomically({
    filePath: statePath,
    contents: `${JSON.stringify(persisted, null, 2)}\n`,
  }).pipe(
    Effect.mapError((cause) =>
      toSchedulerError(`Failed to persist scheduler state at ${statePath}.`, cause),
    ),
  );
}

function loadSchedulerState(statePath: string, fallback: SchedulerState) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs.exists(statePath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return fallback;
    }

    const raw = yield* fs
      .readFileString(statePath)
      .pipe(
        Effect.mapError((cause) =>
          toSchedulerError(`Failed to read scheduler state at ${statePath}.`, cause),
        ),
      );
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      return fallback;
    }

    return yield* decodePersistedSchedulerState(trimmed).pipe(
      Effect.matchCauseEffect({
        onFailure: (cause) =>
          Effect.logWarning("failed to parse scheduler state, using disabled defaults", {
            path: statePath,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as(fallback)),
        onSuccess: (state) =>
          Effect.succeed<SchedulerState>({
            config: state.config,
            arming: state.arming,
            automaticArmingAuthorized: state.automaticArmingAuthorized,
            nightLog: state.nightLog,
            lastGateDecision: state.lastGateDecision,
            lastEvent: state.lastEvent,
            updatedAt: state.updatedAt,
          }),
      }),
    );
  });
}

// --- Layer ----------------------------------------------------------------------------------

export const GitsSlotSchedulerLive = Layer.effect(
  GitsSlotScheduler,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const capacityMonitor = yield* GitsCapacityMonitor;
    const push = yield* PushNotificationService;

    const slotsParse = parse_scheduler_slots(process.env.GITS_SCHEDULER_SLOTS_JSON);
    if (slotsParse.error !== null) {
      yield* Effect.logWarning("gits.scheduler.slots-override-invalid, using default slots", {
        error: slotsParse.error,
      });
    }
    const slots = slotsParse.slots;

    const initializedAt = yield* nowIso;
    const statePath = pathService.join(config.stateDir, "gits", SCHEDULER_STATE_FILE_NAME);
    const persistedIn = (state: SchedulerState) =>
      persistSchedulerState(statePath, state).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, pathService),
      );

    const loaded = yield* loadSchedulerState(statePath, default_state(initializedAt));

    // Boot invariant (decision 8): a restart mid-night forfeits the night — force disarm,
    // warn, and notify so the operator knows tonight will not run without a re-arm.
    let initialState = loaded;
    if (loaded.arming.status === "armed") {
      initialState = {
        ...loaded,
        arming: {
          status: "disarmed",
          nightKey: null,
          armedAt: null,
          disarmedReason: BOOT_DISARM_REASON,
        },
        automaticArmingAuthorized: false,
        lastEvent: BOOT_DISARM_REASON,
        updatedAt: initializedAt,
      };
      yield* persistedIn(initialState);
      yield* Effect.logWarning("gits.scheduler.boot-disarmed", {
        nightKey: loaded.arming.nightKey,
      });
      yield* push.sendToAll({
        title: "GITS autonomy disarmed",
        body: BOOT_DISARM_REASON,
        tag: "gits-scheduler-boot",
        url: "/gits",
      });
    }

    const stateRef = yield* Ref.make<SchedulerState>(initialState);
    const writeSemaphore = yield* Semaphore.make(1);
    const capacityMemoRef = yield* Ref.make<{
      readonly at: number;
      readonly snapshot: GitsCapacitySnapshot;
    } | null>(null);

    const commitState = (
      updater: (state: SchedulerState) => Effect.Effect<SchedulerState, GitsSlotSchedulerError>,
    ) =>
      writeSemaphore.withPermits(1)(
        Effect.gen(function* () {
          const nextState = yield* updater(yield* Ref.get(stateRef));
          yield* persistedIn(nextState);
          yield* Ref.set(stateRef, nextState);
          return nextState;
        }),
      );

    // Effective arming is DERIVED from persisted arming + clock: expiry is never written
    // back outside arm/disarm/boot, so a polled snapshot stays truthful without writes.
    const effectiveArming = (state: SchedulerState, epochMs: number): GitsSchedulerArming => {
      if (state.arming.status !== "armed") {
        return state.arming;
      }
      const currentNightKey = current_night_key(slots, epochMs);
      return state.arming.nightKey === null || state.arming.nightKey >= currentNightKey
        ? state.arming
        : { ...state.arming, status: "disarmed", disarmedReason: "Armed night ended." };
    };

    const goalsStartedTonight = (state: SchedulerState, epochMs: number): number => {
      const nightKey = current_night_key(slots, epochMs);
      return state.nightLog.filter((entry) => entry.nightKey === nightKey).length;
    };

    const snapshotFromState = (
      state: SchedulerState,
      epochMs: number,
      checkedAt: string,
    ): GitsSchedulerSnapshot => ({
      config: state.config,
      arming: effectiveArming(state, epochMs),
      automaticArmingAuthorized: state.automaticArmingAuthorized,
      currentSlot: current_slot(slots, epochMs),
      slotRemainingMs: slot_remaining_ms(slots, epochMs),
      goalsStartedTonight: goalsStartedTonight(state, epochMs),
      lastGateDecision: state.lastGateDecision,
      lastEvent: state.lastEvent,
      checkedAt,
    });

    const readCapacity = Effect.gen(function* () {
      const epochMs = yield* nowEpochMs;
      const memo = yield* Ref.get(capacityMemoRef);
      if (memo !== null && epochMs - memo.at < CAPACITY_MEMO_TTL_MS) {
        return memo.snapshot;
      }
      const snapshot = yield* capacityMonitor.getSnapshot();
      yield* Ref.set(capacityMemoRef, { at: epochMs, snapshot });
      return snapshot;
    });

    const capacityDecision = (weeklyMaxUsedPercent: number) =>
      Effect.gen(function* () {
        const epochMs = yield* nowEpochMs;
        const result = yield* readCapacity.pipe(Effect.result);
        if (Result.isFailure(result)) {
          yield* Effect.logWarning("gits.scheduler.capacity-check-failed", {
            error: result.failure.message,
          });
          return {
            deny: "Codex quota telemetry unavailable (capacity monitor error)",
            retryAt: null,
          } as const;
        }
        const windows = result.success.codex.windows;
        const fiveHour = windows.find((window) => window.label === "5h");
        const weekly = windows.find((window) => window.label === "weekly");
        const missing = [["5h", fiveHour] as const, ["weekly", weekly] as const].filter(
          ([, window]) => {
            const resetAt =
              window?.resetAt === null ? Number.NaN : Date.parse(window?.resetAt ?? "");
            return (
              window?.usedPercent === null ||
              window?.usedPercent === undefined ||
              !Number.isFinite(resetAt) ||
              resetAt <= epochMs
            );
          },
        );
        if (missing.length > 0) {
          return {
            deny: `Codex ${missing.map(([label]) => label).join(" and ")} quota telemetry is missing or stale`,
            retryAt: null,
          } as const;
        }
        const fiveHourBlocked = fiveHour!.usedPercent! >= CAPACITY_MAX_USED_PERCENT_5H;
        const weeklyBlocked = weekly!.usedPercent! >= weeklyMaxUsedPercent;
        if (fiveHourBlocked && weeklyBlocked) {
          return {
            deny: "Codex 5h and weekly windows exceed their limits",
            retryAt: [fiveHour!.resetAt!, weekly!.resetAt!].sort().at(-1)!,
          } as const;
        }
        if (fiveHourBlocked) {
          return {
            deny: `Codex 5h window at ${fiveHour!.usedPercent}%`,
            retryAt: fiveHour!.resetAt!,
          } as const;
        }
        if (weeklyBlocked) {
          return {
            deny: `Codex weekly window at ${weekly!.usedPercent}% (reserve ${100 - weeklyMaxUsedPercent}%)`,
            retryAt: weekly!.resetAt!,
          } as const;
        }
        return { deny: null, retryAt: null } as const;
      });

    const scheduleApprovedGoal = (
      input: { readonly eligibleAt: string | null },
      authorize: boolean,
    ) =>
      Effect.gen(function* () {
        const epochMs = yield* nowEpochMs;
        const armedAt = yield* nowIso;
        const eligibleAtMs = input.eligibleAt === null ? epochMs : Date.parse(input.eligibleAt);
        if (!Number.isFinite(eligibleAtMs)) {
          return yield* toSchedulerError("Approved goal has an invalid eligibility time.");
        }
        const nextState = yield* commitState((state) => {
          if (!authorize && !state.automaticArmingAuthorized) return Effect.succeed(state);
          const nightKey = current_night_key(slots, Math.max(epochMs, eligibleAtMs));
          return Effect.succeed({
            ...state,
            config: { ...state.config, enabled: true },
            arming: { status: "armed", nightKey, armedAt, disarmedReason: null } as const,
            automaticArmingAuthorized: authorize || state.automaticArmingAuthorized,
            lastEvent: `Approved work scheduled for ${nightKey}.`,
            updatedAt: armedAt,
          });
        });
        return snapshotFromState(nextState, epochMs, armedAt);
      });

    const scheduler: GitsSlotSchedulerShape = {
      getSnapshot: () =>
        Effect.gen(function* () {
          const epochMs = yield* nowEpochMs;
          const checkedAt = yield* nowIso;
          return snapshotFromState(yield* Ref.get(stateRef), epochMs, checkedAt);
        }),
      setConfig: (input) =>
        Effect.gen(function* () {
          const epochMs = yield* nowEpochMs;
          const updatedAt = yield* nowIso;
          const nextState = yield* commitState((state) =>
            Effect.succeed({
              ...state,
              config: {
                enabled: input.enabled ?? state.config.enabled,
                maxGoalsPerNight: input.maxGoalsPerNight ?? state.config.maxGoalsPerNight,
                weeklyMaxUsedPercent:
                  input.weeklyMaxUsedPercent ?? state.config.weeklyMaxUsedPercent,
              },
              lastEvent: "Scheduler config updated.",
              updatedAt,
            }),
          );
          return snapshotFromState(nextState, epochMs, updatedAt);
        }),
      arm: () =>
        Effect.gen(function* () {
          const epochMs = yield* nowEpochMs;
          const armedAt = yield* nowIso;
          const nightKey = current_night_key(slots, epochMs);
          const nextState = yield* commitState((state) =>
            Effect.gen(function* () {
              if (!state.config.enabled) {
                return yield* toSchedulerError("Enable the scheduler before arming.");
              }
              // Idempotent for the same night: keep the original armedAt.
              if (state.arming.status === "armed" && state.arming.nightKey === nightKey) {
                return state;
              }
              return {
                ...state,
                arming: { status: "armed", nightKey, armedAt, disarmedReason: null } as const,
                lastEvent: `Scheduler armed for ${nightKey}.`,
                updatedAt: armedAt,
              };
            }),
          );
          return snapshotFromState(nextState, epochMs, armedAt);
        }),
      disarm: (input) =>
        Effect.gen(function* () {
          const epochMs = yield* nowEpochMs;
          const updatedAt = yield* nowIso;
          const reason = input.reason ?? "Disarmed by operator.";
          const nextState = yield* commitState((state) =>
            Effect.succeed({
              ...state,
              // Decision 7: disarm gates future STARTS only — never touches a running goal.
              arming: {
                status: "disarmed",
                nightKey: null,
                armedAt: null,
                disarmedReason: reason,
              } as const,
              automaticArmingAuthorized: false,
              lastEvent: `Scheduler disarmed: ${reason}`,
              updatedAt,
            }),
          );
          return snapshotFromState(nextState, epochMs, updatedAt);
        }),
      scheduleApprovedGoal: (input) => scheduleApprovedGoal(input, true),
      retargetApprovedGoal: (input) => scheduleApprovedGoal(input, false),
      checkStartAllowed: (input) =>
        Effect.gen(function* () {
          const epochMs = yield* nowEpochMs;
          const state = yield* Ref.get(stateRef);

          // 1. Disabled scheduler = bypass (today's interactive behavior). Records nothing;
          // the bypassed flag tells the driver not to count the start against the night cap.
          if (!state.config.enabled) {
            return { allowed: true, bypassed: true } as const satisfies GitsSchedulerGateResult;
          }

          let reason: string | null = null;
          let category: "schedule" | "quota" | "policy" = "schedule";
          let retryAt: string | null = null;
          const currentNightKey = current_night_key(slots, epochMs);

          if (effectiveArming(state, epochMs).status !== "armed") {
            // 2. Effective arming for tonight (reuses the derived-expiry helper): a persisted
            // arm that is no longer effective means the armed night ended.
            reason =
              state.arming.status === "armed" ? "Armed night ended" : "Not armed for tonight";
          } else if (state.arming.nightKey !== currentNightKey) {
            reason = `Armed for future night ${state.arming.nightKey}`;
          } else if (current_slot(slots, epochMs) === null) {
            // 3. Slot window.
            retryAt = next_slot_start_at(slots, epochMs);
            reason = `Outside slot window (next slot ${next_slot_start(slots, epochMs)})`;
          } else if (goalsStartedTonight(state, epochMs) >= state.config.maxGoalsPerNight) {
            // 4. Night goal cap (decision 11).
            reason = `Night goal cap reached (${state.config.maxGoalsPerNight})`;
          } else if (input.maxActivePeers > 1) {
            category = "policy";
            // 5. Envelope (decision 11).
            reason = `Autonomy envelope requires maxActivePeers=1 (policy has ${input.maxActivePeers})`;
          } else if (input.expectedRuntimeMinutes === null) {
            category = "policy";
            reason = "No runtime cap configured";
          } else if (input.expectedRuntimeMinutes > NIGHT_MAX_RUNTIME_MINUTES) {
            category = "policy";
            reason = `Runtime cap exceeds the night envelope (~${NIGHT_MAX_RUNTIME_MINUTES}m)`;
          } else if (
            input.expectedRuntimeMinutes * 60_000 >
            (slot_remaining_ms(slots, epochMs) ?? 0)
          ) {
            // 6. Runway (decision 7).
            reason = "Insufficient slot runway";
            retryAt = next_slot_start_at(slots, epochMs);
          } else {
            // 7. Capacity (decision 20).
            const capacity = yield* capacityDecision(state.config.weeklyMaxUsedPercent);
            reason = capacity.deny;
            category = "quota";
            retryAt = capacity.retryAt;
          }

          const decision: GitsSchedulerGateDecision = {
            at: yield* nowIso,
            allowed: reason === null,
            reason,
          };
          const previous = state.lastGateDecision;
          if (
            previous === null ||
            previous.allowed !== decision.allowed ||
            previous.reason !== decision.reason
          ) {
            // Persist only when the decision changes; same-reason ticks update the live Ref only.
            yield* commitState((current) =>
              Effect.succeed({ ...current, lastGateDecision: decision, updatedAt: decision.at }),
            );
          } else {
            yield* Ref.update(stateRef, (current) => ({ ...current, lastGateDecision: decision }));
          }

          return reason === null
            ? ({ allowed: true } as const)
            : ({ allowed: false, category, reason, retryAt } as const);
        }),
      recordGoalStart: (input) =>
        Effect.gen(function* () {
          const epochMs = yield* nowEpochMs;
          const startedAt = yield* nowIso;
          const nightKey = current_night_key(slots, epochMs);
          // ponytail: prune by London date-key string compare (lexicographic == chronological).
          const cutoff = london_instant(epochMs - NIGHT_LOG_RETENTION_NIGHTS * DAY_MS).dateKey;
          yield* commitState((state) =>
            Effect.succeed({
              ...state,
              nightLog: [
                ...state.nightLog.filter((entry) => entry.nightKey >= cutoff),
                { nightKey, goalId: input.goalId, episodeId: input.episodeId, startedAt },
              ],
              lastEvent: `Recorded goal start ${input.goalId} for ${nightKey}.`,
              updatedAt: startedAt,
            }),
          );
        }),
    };

    return scheduler;
  }),
);
