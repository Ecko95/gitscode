import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { AutomodeSupervisorError } from "@t3tools/contracts";

/** Branch the integration line is cut from and the held PR targets. */
// ponytail: env knob with a gitscode default — the phase-3 repo registry supersedes this
// with per-repo base refs; until then GITS_AUTOMODE_BASE_REF covers non-gits deployments.
export const AUTOMODE_BASE_REF = process.env.GITS_AUTOMODE_BASE_REF?.trim() || "gits";

export interface AutomodeEnsureIntegrationBranchInput {
  readonly repo: string;
  readonly integrationBranch: string;
  readonly baseRef: string; // branch the integration line is cut from, e.g. "gits"
}

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
  /** Create the integration branch on origin from baseRef if it does not exist yet (idempotent). */
  readonly ensure_integration_branch: (
    input: AutomodeEnsureIntegrationBranchInput,
  ) => Effect.Effect<void, AutomodeSupervisorError>;
  readonly land_slice: (
    input: AutomodeLandSliceInput,
  ) => Effect.Effect<AutomodeLandResult, AutomodeSupervisorError>;
}

export class AutomodeLanding extends Context.Service<AutomodeLanding, AutomodeLandingShape>()(
  "t3/gits/Services/AutomodeLanding",
) {}
