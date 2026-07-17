import type { GitsPortsError, PortsListInput, PortsListResult } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface GitsPortsShape {
  readonly list: (input: PortsListInput) => Effect.Effect<PortsListResult, GitsPortsError>;
}

export class GitsPorts extends Context.Service<GitsPorts, GitsPortsShape>()(
  "t3/gits/Services/GitsPorts",
) {}
