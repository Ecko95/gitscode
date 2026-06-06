import type * as Effect from "effect/Effect";
import * as Context from "effect/Context";

import type {
  GitsSliceCriteria,
  GitsSliceCriteriaError,
  GitsSliceCriteriaLoadInput,
  GitsSliceCriteriaSaveInput,
} from "@t3tools/contracts";

/**
 * GitsSliceCriteriaStore — reads/writes per-slice acceptance criteria (Rev 2). Criteria are
 * authored at planning time and stored at `<stateDir>/gits/slices/<sliceId>.md`. The peer prompt
 * builds to them and the verifier-critic judges against them. A missing file loads as
 * `source: "derived"` with empty criteria, signalling the verifier to derive provisional ones.
 */
export interface GitsSliceCriteriaStoreShape {
  readonly load: (
    input: GitsSliceCriteriaLoadInput,
  ) => Effect.Effect<GitsSliceCriteria, GitsSliceCriteriaError>;
  readonly save: (
    input: GitsSliceCriteriaSaveInput,
  ) => Effect.Effect<GitsSliceCriteria, GitsSliceCriteriaError>;
}

export class GitsSliceCriteriaStore extends Context.Service<
  GitsSliceCriteriaStore,
  GitsSliceCriteriaStoreShape
>()("t3/gits/Services/GitsSliceCriteriaStore") {}
