import type {
  GitsCodexMcpAuthAvailability,
  GitsCodexMcpAuthStartResult,
  GitsCodexMcpAuthStatus,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const CodexMcpAuthErrorCode = Schema.Literals([
  "invalid-request",
  "not-found",
  "already-active",
  "relay-unavailable",
  "provider-unavailable",
  "provider-failed",
  "invalid-authorization-response",
  "invalid-callback",
]);
export type CodexMcpAuthErrorCode = typeof CodexMcpAuthErrorCode.Type;

export class CodexMcpAuthError extends Schema.TaggedErrorClass<CodexMcpAuthError>()(
  "CodexMcpAuthError",
  {
    code: CodexMcpAuthErrorCode,
    message: Schema.String,
  },
) {}

export interface StartCodexMcpAuthInput {
  readonly providerInstanceId: string;
  readonly serverName: string;
  readonly connectionId: string;
}

export interface CodexMcpAuthOwnedSessionInput {
  readonly sessionId: string;
  readonly connectionId: string;
}

export interface SafeCodexMcpCallbackRequest {
  readonly callbackId: string;
  readonly state: string;
  readonly rawQuery: string;
}

export interface CodexMcpCallbackHandoff {
  readonly localPort: number;
  readonly pathAndQuery: string;
}

export interface CodexMcpAuthShape {
  readonly getAvailability: () => Effect.Effect<GitsCodexMcpAuthAvailability>;
  readonly start: (
    input: StartCodexMcpAuthInput,
  ) => Effect.Effect<GitsCodexMcpAuthStartResult, CodexMcpAuthError>;
  readonly getStatus: (
    input: CodexMcpAuthOwnedSessionInput,
  ) => Effect.Effect<GitsCodexMcpAuthStatus, CodexMcpAuthError>;
  readonly cancel: (input: CodexMcpAuthOwnedSessionInput) => Effect.Effect<void, CodexMcpAuthError>;
  readonly handleCallback: (
    input: SafeCodexMcpCallbackRequest,
  ) => Effect.Effect<CodexMcpCallbackHandoff, CodexMcpAuthError>;
  readonly stopAll: () => Effect.Effect<void>;
}

export class CodexMcpAuth extends Context.Service<CodexMcpAuth, CodexMcpAuthShape>()(
  "t3/gits/Services/CodexMcpAuth",
) {}
