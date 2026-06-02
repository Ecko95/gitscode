import type * as Effect from "effect/Effect";
import * as Context from "effect/Context";

import type { GitsCapacityError, GitsCapacitySnapshot } from "@t3tools/contracts";

export interface GitsCapacityMonitorShape {
  readonly getSnapshot: () => Effect.Effect<GitsCapacitySnapshot, GitsCapacityError>;
}

export class GitsCapacityMonitor extends Context.Service<
  GitsCapacityMonitor,
  GitsCapacityMonitorShape
>()("t3/gits/Services/GitsCapacityMonitor") {}
