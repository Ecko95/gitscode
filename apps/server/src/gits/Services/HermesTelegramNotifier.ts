import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class HermesTelegramNotifierError extends Schema.TaggedErrorClass<HermesTelegramNotifierError>()(
  "HermesTelegramNotifierError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export interface HermesTelegramNotifierShape {
  readonly notify: (input: {
    readonly subject: string;
    readonly text: string;
  }) => Effect.Effect<void, HermesTelegramNotifierError>;
}

export class HermesTelegramNotifier extends Context.Service<
  HermesTelegramNotifier,
  HermesTelegramNotifierShape
>()("t3/gits/Services/HermesTelegramNotifier") {}
