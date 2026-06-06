import type * as Effect from "effect/Effect";
import * as Context from "effect/Context";

import type { GitsReviewError, GitsReviewInput, GitsReviewResult } from "@t3tools/contracts";

/**
 * GitsReviewPipeline — the repo-internal "verifier wiring" (Rev 2). For a finished peer it runs
 * the confined mechanical gate, and only if green runs the semantic verifier-critic against the
 * slice's acceptance criteria, then produces a combined triage recommendation (auto-merge vs
 * hold-for-review). It never blocks the chain. This is the unit the orchestration / a future
 * monitor invokes when a peer reaches done+pushed.
 */
export interface GitsReviewPipelineShape {
  readonly review: (input: GitsReviewInput) => Effect.Effect<GitsReviewResult, GitsReviewError>;
}

export class GitsReviewPipeline extends Context.Service<
  GitsReviewPipeline,
  GitsReviewPipelineShape
>()("t3/gits/Services/GitsReviewPipeline") {}
