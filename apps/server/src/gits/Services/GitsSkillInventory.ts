import type { GitsSkillInventorySnapshot } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class GitsSkillInventoryResolverError extends Schema.TaggedErrorClass<GitsSkillInventoryResolverError>()(
  "GitsSkillInventoryResolverError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export interface GitsSkillInventoryResolverShape {
  readonly getSnapshot: () => Effect.Effect<
    GitsSkillInventorySnapshot,
    GitsSkillInventoryResolverError
  >;
}

export class GitsSkillInventoryResolver extends Context.Service<
  GitsSkillInventoryResolver,
  GitsSkillInventoryResolverShape
>()("t3/gits/Services/GitsSkillInventory/GitsSkillInventoryResolver") {}
