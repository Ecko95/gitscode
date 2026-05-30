import type * as Effect from "effect/Effect";
import * as Context from "effect/Context";

import type {
  GitsCockpitSnapshot,
  GitsCockpitError,
  OrchestrationProjectShell,
  OrchestrationThreadShell,
} from "@t3tools/contracts";

export interface GitsPlanningScanInput {
  readonly projects: ReadonlyArray<OrchestrationProjectShell>;
  readonly threads: ReadonlyArray<OrchestrationThreadShell>;
  readonly fallbackCwd: string;
}

export interface GitsPlanningScannerShape {
  readonly scan: (
    input: GitsPlanningScanInput,
  ) => Effect.Effect<GitsCockpitSnapshot, GitsCockpitError>;
}

export class GitsPlanningScanner extends Context.Service<
  GitsPlanningScanner,
  GitsPlanningScannerShape
>()("t3/gits/Services/GitsPlanningScanner") {}
