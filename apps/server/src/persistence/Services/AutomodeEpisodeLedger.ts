import {
  GitsReviewResult,
  GitsVerifierConfidence,
  GitsVerifierRecommendation,
  GitsVerifierVerdict,
  IsoDateTime,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { AutomodeEpisodeLedgerRepositoryError } from "../Errors.ts";

// Mirror the (module-private) string bounds used in packages/contracts/src/gits.ts.
const PathString = TrimmedNonEmptyString.check(Schema.isMaxLength(4096));
const SummaryString = TrimmedNonEmptyString.check(Schema.isMaxLength(10_000));

export const AutomodeEpisode = Schema.Struct({
  id: TrimmedNonEmptyString,
  // Episode thread (decision 23): null for rows recorded before migration 036.
  episodeId: Schema.NullOr(TrimmedNonEmptyString),
  repo: PathString,
  goalId: TrimmedNonEmptyString,
  goalTitle: TrimmedNonEmptyString,
  sliceBranch: Schema.NullOr(TrimmedNonEmptyString),
  verdict: GitsVerifierVerdict,
  confidence: Schema.NullOr(GitsVerifierConfidence),
  recommendation: GitsVerifierRecommendation,
  flagged: Schema.Boolean,
  summary: SummaryString,
  review: GitsReviewResult,
  createdAt: IsoDateTime,
});
export type AutomodeEpisode = typeof AutomodeEpisode.Type;

export const ListAutomodeEpisodesInput = Schema.Struct({
  repo: Schema.optional(PathString),
  limit: Schema.optional(Schema.Number),
});
export type ListAutomodeEpisodesInput = typeof ListAutomodeEpisodesInput.Type;

export interface AutomodeEpisodeLedgerShape {
  readonly record_episode: (
    episode: AutomodeEpisode,
  ) => Effect.Effect<void, AutomodeEpisodeLedgerRepositoryError>;
  readonly list_episodes: (
    input: ListAutomodeEpisodesInput,
  ) => Effect.Effect<ReadonlyArray<AutomodeEpisode>, AutomodeEpisodeLedgerRepositoryError>;
}

export class AutomodeEpisodeLedger extends Context.Service<
  AutomodeEpisodeLedger,
  AutomodeEpisodeLedgerShape
>()("t3/persistence/Services/AutomodeEpisodeLedger") {}
