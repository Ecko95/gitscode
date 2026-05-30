import type * as Effect from "effect/Effect";
import * as Context from "effect/Context";

import type {
  AutomodeDispatchResult,
  AutomodeEnqueueGoalInput,
  AutomodeGoal,
  AutomodeGoalInput,
  AutomodePolicyUpdateInput,
  AutomodeRejectGoalInput,
  AutomodeSnapshot,
  AutomodeSupervisorError,
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
}

export class AutomodeSupervisor extends Context.Service<
  AutomodeSupervisor,
  AutomodeSupervisorShape
>()("t3/gits/Services/AutomodeSupervisor") {}
