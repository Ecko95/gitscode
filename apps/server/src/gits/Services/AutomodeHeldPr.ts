import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { AutomodeSupervisorError } from "@t3tools/contracts";

export interface AutomodeOpenHeldPrInput {
  readonly repo: string;
  readonly integrationBranch: string; // PR head
  readonly baseBranch: string; // PR base, e.g. "gits"
  readonly title: string;
  readonly body: string;
}

export type AutomodeOpenHeldPrResult =
  | { readonly status: "opened"; readonly url: string; readonly number: number }
  | { readonly status: "rejected"; readonly reason: string };

export interface AutomodeDetectMergeInput {
  readonly repo: string;
  readonly prNumber: number;
}

export interface AutomodeHeldPrShape {
  readonly open_held_pr: (
    input: AutomodeOpenHeldPrInput,
  ) => Effect.Effect<AutomodeOpenHeldPrResult, AutomodeSupervisorError>;
  readonly detect_merge: (
    input: AutomodeDetectMergeInput,
  ) => Effect.Effect<{ readonly merged: boolean }, AutomodeSupervisorError>;
}

export class AutomodeHeldPr extends Context.Service<AutomodeHeldPr, AutomodeHeldPrShape>()(
  "t3/gits/Services/AutomodeHeldPr",
) {}
