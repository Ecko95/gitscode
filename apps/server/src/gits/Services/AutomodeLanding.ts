import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { AutomodeSupervisorError } from "@t3tools/contracts";

export interface AutomodeLandSliceInput {
  readonly repo: string;
  readonly integrationBranch: string;
  readonly baseRef: string; // branch the integration line is cut from, e.g. "gits"
  readonly sliceBranch: string;
}

export type AutomodeLandResult =
  | { readonly status: "landed" }
  | { readonly status: "rejected"; readonly reason: string };

export interface AutomodeLandingShape {
  readonly land_slice: (
    input: AutomodeLandSliceInput,
  ) => Effect.Effect<AutomodeLandResult, AutomodeSupervisorError>;
}

export class AutomodeLanding extends Context.Service<AutomodeLanding, AutomodeLandingShape>()(
  "t3/gits/Services/AutomodeLanding",
) {}
