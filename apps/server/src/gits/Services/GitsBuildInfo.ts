import type { GitsBuildInfo } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class GitsBuildInfoResolverError extends Schema.TaggedErrorClass<GitsBuildInfoResolverError>()(
  "GitsBuildInfoResolverError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export interface GitsBuildInfoResolverShape {
  readonly getBuildInfo: () => Effect.Effect<GitsBuildInfo, GitsBuildInfoResolverError>;
}

export class GitsBuildInfoResolver extends Context.Service<
  GitsBuildInfoResolver,
  GitsBuildInfoResolverShape
>()("t3/gits/Services/GitsBuildInfo/GitsBuildInfoResolver") {}
