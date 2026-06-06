import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { GitsReviewError, type GitsReviewResult } from "@t3tools/contracts";

import {
  GitsReviewPipeline,
  type GitsReviewPipelineShape,
} from "../Services/GitsReviewPipeline.ts";
import { GitsVerificationGate } from "../Services/GitsVerificationGate.ts";
import { GitsSemanticVerifier } from "../Services/GitsSemanticVerifier.ts";
import { GitsSliceCriteriaStore } from "../Services/GitsSliceCriteriaStore.ts";

function toError(message: string, cause?: unknown) {
  return new GitsReviewError({ message, ...(cause === undefined ? {} : { cause }) });
}

export const makeGitsReviewPipeline = Effect.gen(function* () {
  const gate = yield* GitsVerificationGate;
  const verifier = yield* GitsSemanticVerifier;
  const criteriaStore = yield* GitsSliceCriteriaStore;

  const review: GitsReviewPipelineShape["review"] = (input) =>
    Effect.gen(function* () {
      const criteria = yield* criteriaStore
        .load({ sliceId: input.sliceId })
        .pipe(Effect.mapError((c) => toError(`Failed to load criteria for ${input.sliceId}.`, c)));

      const mechanical = yield* gate
        .run({
          worktree: input.worktree,
          commands: input.verificationCommands,
          requireConfinement: true,
        })
        .pipe(Effect.mapError((c) => toError("Mechanical gate failed to run.", c)));

      // Red gate → already a hold; skip the (codex-costing) semantic pass.
      if (!mechanical.passed) {
        const failed = mechanical.results
          .filter((r) => !r.passed)
          .map((r) => r.label)
          .join(", ");
        const checkedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
        return {
          sliceId: input.sliceId,
          recommendation: "hold-for-review",
          mechanicalPassed: false,
          mechanical,
          semantic: null,
          criteriaSource: criteria.source,
          summary: `Mechanical gate failed${failed ? ` (${failed})` : ""}; held for review.`,
          checkedAt,
        } satisfies GitsReviewResult;
      }

      // Green → run the semantic verifier-critic against the slice's acceptance criteria.
      const semantic = yield* verifier
        .verify({
          worktree: input.worktree,
          baseRef: input.baseRef,
          acceptanceCriteria: criteria.acceptanceCriteria,
          sliceTitle: criteria.title,
          ...(input.model ? { model: input.model } : {}),
        })
        .pipe(Effect.mapError((c) => toError("Semantic verifier failed.", c)));

      const checkedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
      return {
        sliceId: input.sliceId,
        recommendation: semantic.recommendation,
        mechanicalPassed: true,
        mechanical,
        semantic,
        criteriaSource: criteria.source,
        summary: `Gate green; verifier=${semantic.verdict}/${semantic.confidence} (${criteria.source} criteria) → ${semantic.recommendation}.`,
        checkedAt,
      } satisfies GitsReviewResult;
    });

  return { review } satisfies GitsReviewPipelineShape;
});

// Requires GitsVerificationGate + GitsSemanticVerifier + GitsSliceCriteriaStore — provided by the
// surrounding GitsLayerLive (this layer is merged AFTER those three).
export const GitsReviewPipelineLive = Layer.effect(GitsReviewPipeline, makeGitsReviewPipeline);
