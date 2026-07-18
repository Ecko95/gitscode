import type {
  AuthBearerBootstrapResult,
  AuthBootstrapResult,
  AuthClientMetadata,
  AuthClientSession,
  AuthCreatePairingCredentialInput,
  AuthPairingLink,
  AuthPairingCredentialResult,
  AuthSessionId,
  AuthSessionState,
  ServerAuthDescriptor,
  ServerAuthSessionMethod,
  AuthWebSocketTokenResult,
} from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import type { SessionRole } from "./SessionCredentialService.ts";

export interface AuthenticatedSession {
  readonly sessionId: AuthSessionId;
  readonly subject: string;
  readonly method: ServerAuthSessionMethod;
  readonly role: SessionRole;
  readonly expiresAt?: DateTime.DateTime;
}

export class AuthError extends Data.TaggedError("AuthError")<{
  readonly message: string;
  readonly status?: 400 | 401 | 403 | 500;
  readonly cause?: unknown;
}> {}

/**
 * Centralized policy: a `thread-scoped` session (minted only for the crit
 * sidecar, subject-bound to a single threadId) is denied at the broad realtime
 * surfaces — minting a ws-token, opening the `/ws` upgrade, and reading
 * arbitrary attachments. Owner and ordinary client sessions are unaffected.
 *
 * Returns an `AuthError({ status: 403 })` to reject, or `null` to allow. Kept
 * as a pure predicate so every surface enforces the same rule from one place.
 */
export function denyThreadScopedRealtime(session: {
  readonly role: SessionRole;
}): AuthError | null {
  if (session.role === "thread-scoped") {
    return new AuthError({
      message: "Thread-scoped sessions cannot open a realtime connection.",
      status: 403,
    });
  }
  return null;
}

/**
 * Thread-visibility rule for per-thread realtime bindings: a `thread-scoped`
 * session may only bind to its own thread (`subject === threadId`); owner and
 * client sessions have full thread visibility. This is the same
 * `session.subject === threadId` capability the crit HTTP endpoints enforce
 * (`critHttp.ts` `authorize`), centralized here so `subscribeThread` authorizes
 * the thread↔client binding from one place (T7 isolation half). Returns an
 * `AuthError({ status: 403 })` to refuse, or `null` to allow.
 */
export function denyThreadAccess(
  session: {
    readonly role: SessionRole;
    readonly subject: string;
  },
  threadId: string,
): AuthError | null {
  if (session.role === "thread-scoped" && session.subject !== threadId) {
    return new AuthError({
      message: "Session is not authorized for this thread.",
      status: 403,
    });
  }
  return null;
}

export interface ServerAuthShape {
  readonly getDescriptor: () => Effect.Effect<ServerAuthDescriptor>;
  readonly getSessionState: (
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<AuthSessionState, never>;
  readonly exchangeBootstrapCredential: (
    credential: string,
    requestMetadata: AuthClientMetadata,
  ) => Effect.Effect<
    {
      readonly response: AuthBootstrapResult;
      readonly sessionToken: string;
    },
    AuthError
  >;
  readonly exchangeBootstrapCredentialForBearerSession: (
    credential: string,
    requestMetadata: AuthClientMetadata,
  ) => Effect.Effect<AuthBearerBootstrapResult, AuthError>;
  readonly issuePairingCredential: (
    input?: AuthCreatePairingCredentialInput & {
      readonly role?: SessionRole;
    },
  ) => Effect.Effect<AuthPairingCredentialResult, AuthError>;
  readonly listPairingLinks: () => Effect.Effect<ReadonlyArray<AuthPairingLink>, AuthError>;
  readonly revokePairingLink: (id: string) => Effect.Effect<boolean, AuthError>;
  readonly listClientSessions: (
    currentSessionId: AuthSessionId,
  ) => Effect.Effect<ReadonlyArray<AuthClientSession>, AuthError>;
  readonly revokeClientSession: (
    currentSessionId: AuthSessionId,
    targetSessionId: AuthSessionId,
  ) => Effect.Effect<boolean, AuthError>;
  readonly revokeOtherClientSessions: (
    currentSessionId: AuthSessionId,
  ) => Effect.Effect<number, AuthError>;
  readonly authenticateHttpRequest: (
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<AuthenticatedSession, AuthError>;
  readonly authenticateWebSocketUpgrade: (
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<AuthenticatedSession, AuthError>;
  readonly issueWebSocketToken: (
    session: AuthenticatedSession,
  ) => Effect.Effect<AuthWebSocketTokenResult, AuthError>;
  readonly issueStartupPairingUrl: (baseUrl: string) => Effect.Effect<string, AuthError>;
}

export class ServerAuth extends Context.Service<ServerAuth, ServerAuthShape>()(
  "t3/auth/Services/ServerAuth",
) {}
