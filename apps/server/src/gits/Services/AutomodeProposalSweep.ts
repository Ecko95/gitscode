import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface AutomodeProposalSweepShape {
  readonly tick: () => Effect.Effect<void>;
}

export class AutomodeProposalSweep extends Context.Service<
  AutomodeProposalSweep,
  AutomodeProposalSweepShape
>()("t3/gits/Services/AutomodeProposalSweep") {}
