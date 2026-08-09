import type * as Effect from "effect/Effect";
import * as Context from "effect/Context";

import type {
  AutomodeDispatchResult,
  AutomodeDriverHaltInput,
  AutomodeEnqueueGoalInput,
  AutomodeGoal,
  AutomodeGoalInput,
  AutomodeGoalOutcomeInput,
  AutomodePolicy,
  AutomodePolicyUpdateInput,
  AutomodeRecordHeldPrInput,
  AutomodeRejectGoalInput,
  AutomodeSnapshot,
  AutomodeStopAllResult,
  AutomodeSupervisorError,
  DelamainSendMessageInput,
  DelamainSendMessageResult,
} from "@t3tools/contracts";

export interface AutomodeSupervisorShape {
  readonly getSnapshot: () => Effect.Effect<AutomodeSnapshot, AutomodeSupervisorError>;
  /**
   * Read the current policy from in-memory state only — no peer-list/budget IO.
   * The driver gates on mode/kill-switch every tick; a full getSnapshot there
   * would run the expensive DB/subprocess reads even while automode is off.
   */
  readonly getPolicy: () => Effect.Effect<AutomodePolicy, AutomodeSupervisorError>;
  readonly updatePolicy: (
    input: AutomodePolicyUpdateInput,
  ) => Effect.Effect<AutomodeSnapshot, AutomodeSupervisorError>;
  readonly enqueueGoal: (
    input: AutomodeEnqueueGoalInput,
  ) => Effect.Effect<AutomodeSnapshot, AutomodeSupervisorError>;
  readonly deferGoal: (input: {
    readonly goalId: string;
    readonly notBefore: string;
    readonly planningNotes: string | null;
    readonly planningBoundary: string;
  }) => Effect.Effect<AutomodeGoal, AutomodeSupervisorError>;
  readonly approveGoal: (
    input: AutomodeGoalInput,
  ) => Effect.Effect<AutomodeGoal, AutomodeSupervisorError>;
  readonly rejectGoal: (
    input: AutomodeRejectGoalInput,
  ) => Effect.Effect<AutomodeGoal, AutomodeSupervisorError>;
  readonly dispatchGoal: (
    input: AutomodeGoalInput,
  ) => Effect.Effect<AutomodeDispatchResult, AutomodeSupervisorError>;
  readonly completeGoal: (
    input: AutomodeGoalInput,
  ) => Effect.Effect<AutomodeGoal, AutomodeSupervisorError>;
  readonly failGoal: (
    input: AutomodeGoalOutcomeInput,
  ) => Effect.Effect<AutomodeGoal, AutomodeSupervisorError>;
  /** Kill switch on first, then best-effort kill every live goal's peer/workflow. Mirrors the
   * Telegram STOP command; goal status is left untouched (same as STOP today). */
  readonly stopAll: () => Effect.Effect<AutomodeStopAllResult, AutomodeSupervisorError>;
  /** Kill one goal's peer/workflow (if any) and mark it failed. Errors if the goal is unknown. */
  readonly killGoal: (
    input: AutomodeGoalInput,
  ) => Effect.Effect<AutomodeGoal, AutomodeSupervisorError>;
  readonly haltDriver: (
    input: AutomodeDriverHaltInput,
  ) => Effect.Effect<AutomodeSnapshot, AutomodeSupervisorError>;
  readonly resumeDriver: () => Effect.Effect<AutomodeSnapshot, AutomodeSupervisorError>;
  readonly recordHeldPr: (
    input: AutomodeRecordHeldPrInput,
  ) => Effect.Effect<AutomodeSnapshot, AutomodeSupervisorError>;
  readonly markRunMerged: () => Effect.Effect<AutomodeSnapshot, AutomodeSupervisorError>;
  readonly sendPeerMessage: (
    input: DelamainSendMessageInput,
  ) => Effect.Effect<DelamainSendMessageResult, AutomodeSupervisorError>;
}

export class AutomodeSupervisor extends Context.Service<
  AutomodeSupervisor,
  AutomodeSupervisorShape
>()("t3/gits/Services/AutomodeSupervisor") {}
