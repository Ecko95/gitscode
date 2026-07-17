import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const ProviderAuthMethod = Schema.Literals([
  "device-code",
  "manual-code",
  "api-key",
  "browser-loopback",
  "guided-terminal",
]);
export type ProviderAuthMethod = typeof ProviderAuthMethod.Type;

export const ProviderAuthSessionState = Schema.Literals([
  "starting",
  "awaiting-user",
  "waiting-provider",
  "succeeded",
  "failed",
  "cancelled",
  "expired",
]);
export type ProviderAuthSessionState = typeof ProviderAuthSessionState.Type;

export const ProviderAuthSessionId = TrimmedNonEmptyString.pipe(
  Schema.brand("ProviderAuthSessionId"),
);
export type ProviderAuthSessionId = typeof ProviderAuthSessionId.Type;

export const ProviderAuthPrompt = TrimmedNonEmptyString.check(Schema.isMaxLength(1_000));
export type ProviderAuthPrompt = typeof ProviderAuthPrompt.Type;

/** Safe to retain briefly or broadcast to the initiating connection. */
export const ProviderAuthSession = Schema.Struct({
  sessionId: ProviderAuthSessionId,
  providerInstanceId: ProviderInstanceId,
  method: ProviderAuthMethod,
  state: ProviderAuthSessionState,
  prompt: Schema.optionalKey(ProviderAuthPrompt),
  acceptsCode: Schema.Boolean,
  expiresAt: IsoDateTime,
});
export type ProviderAuthSession = typeof ProviderAuthSession.Type;

/** Owner-only start response. Transient fields must never be copied into ProviderAuthSession. */
export const ProviderAuthStartResult = Schema.Struct({
  session: ProviderAuthSession,
  verificationUri: Schema.optionalKey(TrimmedNonEmptyString),
  userCode: Schema.optionalKey(TrimmedNonEmptyString),
});
export type ProviderAuthStartResult = typeof ProviderAuthStartResult.Type;

export const ProviderAuthStartInput = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  method: ProviderAuthMethod,
});
export type ProviderAuthStartInput = typeof ProviderAuthStartInput.Type;

export const ProviderAuthSessionInput = Schema.Struct({
  sessionId: ProviderAuthSessionId,
});
export type ProviderAuthSessionInput = typeof ProviderAuthSessionInput.Type;

export const ProviderAuthLogoutInput = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
});
export type ProviderAuthLogoutInput = typeof ProviderAuthLogoutInput.Type;

export const ProviderAuthErrorCode = Schema.Literals([
  "access-denied",
  "invalid-request",
  "already-active",
  "not-found",
  "unsupported",
  "provider-failed",
]);
export type ProviderAuthErrorCode = typeof ProviderAuthErrorCode.Type;

export class ProviderAuthError extends Schema.TaggedErrorClass<ProviderAuthError>()(
  "ProviderAuthError",
  {
    code: ProviderAuthErrorCode,
    message: Schema.String,
  },
) {}
