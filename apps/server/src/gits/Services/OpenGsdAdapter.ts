import type * as Effect from "effect/Effect";
import * as Context from "effect/Context";

import type {
  OpenGsdAdapterError,
  OpenGsdCommandResult,
  OpenGsdInitProjectInput,
  OpenGsdRunAutoInput,
  OpenGsdStatusResult,
} from "@t3tools/contracts";

export interface OpenGsdAdapterShape {
  readonly getStatus: () => Effect.Effect<OpenGsdStatusResult, OpenGsdAdapterError>;
  readonly initProject: (
    input: OpenGsdInitProjectInput,
  ) => Effect.Effect<OpenGsdCommandResult, OpenGsdAdapterError>;
  readonly runAuto: (
    input: OpenGsdRunAutoInput,
  ) => Effect.Effect<OpenGsdCommandResult, OpenGsdAdapterError>;
}

export class OpenGsdAdapter extends Context.Service<OpenGsdAdapter, OpenGsdAdapterShape>()(
  "t3/gits/Services/OpenGsdAdapter",
) {}
