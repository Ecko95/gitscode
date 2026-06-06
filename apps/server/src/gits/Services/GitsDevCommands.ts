import type * as Effect from "effect/Effect";
import * as Context from "effect/Context";

import type {
  GitsDevCommandError,
  GitsDevCommandInitInput,
  GitsDevCommandListInput,
  GitsDevCommandListResult,
} from "@t3tools/contracts";

export interface GitsDevCommandsShape {
  readonly listCommands: (
    input: GitsDevCommandListInput,
  ) => Effect.Effect<GitsDevCommandListResult, GitsDevCommandError>;
  readonly initCommands: (
    input: GitsDevCommandInitInput,
  ) => Effect.Effect<GitsDevCommandListResult, GitsDevCommandError>;
}

export class GitsDevCommands extends Context.Service<GitsDevCommands, GitsDevCommandsShape>()(
  "t3/gits/Services/GitsDevCommands",
) {}
