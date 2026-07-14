import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface AutomodeTelegramDigestShape {
  readonly tick: () => Effect.Effect<void>;
}

export class AutomodeTelegramDigest extends Context.Service<
  AutomodeTelegramDigest,
  AutomodeTelegramDigestShape
>()("t3/gits/Services/AutomodeTelegramDigest") {}
