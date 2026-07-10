import type * as Effect from "effect/Effect";
import * as Context from "effect/Context";

import type {
  AutomodeDispatchResult,
  AutomodeDriverHaltInput,
  AutomodeEnqueueGoalInput,
  AutomodeGoal,
  AutomodeGoalInput,
  AutomodeGoalOutcomeInput,
  AutomodePolicyUpdateInput,
  AutomodeRecordHeldPrInput,
  AutomodeRejectGoalInput,
  AutomodeSnapshot,
  AutomodeSupervisorError,
  DelamainSendMessageInput,
  DelamainSendMessageResult,
} from "@t3tools/contracts";

export interface AutomodeSupervisorShape {
  readonly getSnapshot: () => Effect.Effect<AutomodeSnapshot, AutomodeSupervisorError>;
  readonly updatePolicy: (
    input: AutomodePolicyUpdateInput,
  ) => Effect.Effect<AutomodeSnapshot, AutomodeSupervisorError>;
  readonly enqueueGoal: (
    input: AutomodeEnqueueGoalInput,
  ) => Effect.Effect<AutomodeSnapshot, AutomodeSupervisorError>;
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
