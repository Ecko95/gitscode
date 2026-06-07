import type { GitsMcpInventorySnapshot } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class GitsMcpInventoryResolverError extends Schema.TaggedErrorClass<GitsMcpInventoryResolverError>()(
  "GitsMcpInventoryResolverError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export interface GitsMcpInventoryResolverShape {
  readonly getSnapshot: () => Effect.Effect<
    GitsMcpInventorySnapshot,
    GitsMcpInventoryResolverError
  >;
}

export class GitsMcpInventoryResolver extends Context.Service<
  GitsMcpInventoryResolver,
  GitsMcpInventoryResolverShape
>()("t3/gits/Services/GitsMcpInventory/GitsMcpInventoryResolver") {}
