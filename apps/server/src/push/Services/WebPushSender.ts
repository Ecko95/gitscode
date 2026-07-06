import type { WebPushSubscription } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import type * as Effect from "effect/Effect";

export class WebPushSendError extends Schema.TaggedErrorClass<WebPushSendError>()(
  "WebPushSendError",
  {
    endpoint: Schema.String,
    statusCode: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Failed to send web push notification to ${this.endpoint}`;
  }
}

export interface WebPushSenderShape {
  readonly send: (
    subscription: WebPushSubscription,
    payload: string,
  ) => Effect.Effect<void, WebPushSendError>;
}

export class WebPushSender extends Context.Service<WebPushSender, WebPushSenderShape>()(
  "t3/push/Services/WebPushSender",
) {}
