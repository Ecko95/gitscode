import type * as Effect from "effect/Effect";
import * as Context from "effect/Context";

import type { AutomodeBudgetUsage, AutomodeSupervisorError } from "@t3tools/contracts";

export interface AutomodeUsageMeterShape {
  readonly readBudgetUsage: () => Effect.Effect<AutomodeBudgetUsage, AutomodeSupervisorError>;
}

export class AutomodeUsageMeter extends Context.Service<
  AutomodeUsageMeter,
  AutomodeUsageMeterShape
>()("t3/gits/Services/AutomodeUsageMeter") {}
