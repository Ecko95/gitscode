import type * as Effect from "effect/Effect";
import * as Context from "effect/Context";

import type {
  GitsSchedulerDisarmInput,
  GitsSchedulerSetConfigInput,
  GitsSchedulerSnapshot,
  GitsSlotSchedulerError,
} from "@t3tools/contracts";

export type GitsSchedulerGateResult =
  | {
      readonly allowed: true;
      /** Set ONLY by the config.enabled === false bypass — the driver must not count these starts against the night cap. */
      readonly bypassed?: true;
    }
  | {
      readonly allowed: false;
      readonly category: "schedule" | "quota" | "policy";
      readonly reason: string;
      readonly retryAt: string | null;
    };

export interface GitsSchedulerScheduleApprovedGoalInput {
  readonly eligibleAt: string | null;
}

export interface GitsSchedulerStartCheckInput {
  /** policy.maxRuntimeMinutes at gate time; null = no cap configured (fail closed). */
  readonly expectedRuntimeMinutes: number | null;
  readonly maxActivePeers: number;
}

export interface GitsSchedulerGoalStartInput {
  readonly goalId: string;
  readonly episodeId: string;
}

export interface GitsSlotSchedulerShape {
  readonly getSnapshot: () => Effect.Effect<GitsSchedulerSnapshot, GitsSlotSchedulerError>;
  readonly setConfig: (
    input: GitsSchedulerSetConfigInput,
  ) => Effect.Effect<GitsSchedulerSnapshot, GitsSlotSchedulerError>;
  readonly arm: () => Effect.Effect<GitsSchedulerSnapshot, GitsSlotSchedulerError>;
  readonly disarm: (
    input: GitsSchedulerDisarmInput,
  ) => Effect.Effect<GitsSchedulerSnapshot, GitsSlotSchedulerError>;
  readonly scheduleApprovedGoal: (
    input: GitsSchedulerScheduleApprovedGoalInput,
  ) => Effect.Effect<GitsSchedulerSnapshot, GitsSlotSchedulerError>;
  readonly checkStartAllowed: (
    input: GitsSchedulerStartCheckInput,
  ) => Effect.Effect<GitsSchedulerGateResult, GitsSlotSchedulerError>;
  readonly recordGoalStart: (
    input: GitsSchedulerGoalStartInput,
  ) => Effect.Effect<void, GitsSlotSchedulerError>;
}

export class GitsSlotScheduler extends Context.Service<GitsSlotScheduler, GitsSlotSchedulerShape>()(
  "t3/gits/Services/GitsSlotScheduler",
) {}
