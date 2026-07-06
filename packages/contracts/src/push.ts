import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";

const PushEndpoint = TrimmedNonEmptyString.check(Schema.isMaxLength(4096));
const PushKey = TrimmedNonEmptyString.check(Schema.isMaxLength(1024));

export const WebPushSubscription = Schema.Struct({
  endpoint: PushEndpoint,
  expirationTime: Schema.NullOr(Schema.Number),
  keys: Schema.Struct({
    p256dh: PushKey,
    auth: PushKey,
  }),
});
export type WebPushSubscription = typeof WebPushSubscription.Type;

export const WebPushRegisterInput = Schema.Struct({
  subscription: WebPushSubscription,
  userAgent: Schema.optionalKey(TrimmedString.check(Schema.isMaxLength(1024))),
});
export type WebPushRegisterInput = typeof WebPushRegisterInput.Type;

export const WebPushUnregisterInput = Schema.Struct({
  endpoint: PushEndpoint,
});
export type WebPushUnregisterInput = typeof WebPushUnregisterInput.Type;

export const WebPushPublicConfig = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  publicKey: Schema.NullOr(PushKey),
});
export type WebPushPublicConfig = typeof WebPushPublicConfig.Type;
