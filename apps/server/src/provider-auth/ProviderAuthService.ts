// @effect-diagnostics nodeBuiltinImport:off
import { randomUUID } from "node:crypto";

import {
  ProviderAuthError,
  type ProviderAuthErrorCode,
  type ProviderAuthMethod,
  type ProviderAuthPrompt,
  type ProviderAuthSession,
  type ProviderAuthSessionId,
  type ProviderAuthSessionState,
  type ProviderAuthStartResult,
  type ProviderDriverKind,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import type { ProviderAdapterError } from "../provider/Errors.ts";
import type {
  ProviderAuthAdapter,
  ProviderAuthAttempt,
} from "../provider/Services/ProviderAdapter.ts";

const DEFAULT_TTL_MS = 10 * 60_000;
const DEFAULT_TERMINAL_RETENTION_MS = 30_000;
const MAX_PROMPT_LENGTH = 1_000;

type ActiveProviderAuthState = Extract<
  ProviderAuthSessionState,
  "starting" | "awaiting-user" | "waiting-provider"
>;
type TerminalProviderAuthState = Exclude<ProviderAuthSessionState, ActiveProviderAuthState>;

export interface StartProviderAuthSessionInput {
  readonly provider: ProviderDriverKind;
  readonly providerInstanceId: ProviderInstanceId;
  readonly credentialHome: string;
  readonly connectionId: string;
  readonly method: ProviderAuthMethod;
  readonly sanitizedPrompt?: string;
  readonly acceptsCode?: boolean;
  readonly cancel?: Effect.Effect<void, ProviderAuthError>;
  readonly cleanup?: Effect.Effect<void, ProviderAuthError>;
}

export interface StartManagedProviderAuthInput {
  readonly provider: ProviderDriverKind;
  readonly providerInstanceId: ProviderInstanceId;
  readonly connectionId: string;
  readonly method: ProviderAuthMethod;
  readonly adapter: ProviderAuthAdapter<ProviderAdapterError>;
  readonly refresh: Effect.Effect<void>;
  readonly verifyAuthenticated?: Effect.Effect<boolean>;
}

export interface LogoutManagedProviderAuthInput {
  readonly provider: ProviderDriverKind;
  readonly providerInstanceId: ProviderInstanceId;
  readonly adapter: ProviderAuthAdapter<ProviderAdapterError>;
  readonly refresh: Effect.Effect<void>;
}

export interface OwnedProviderAuthSessionInput {
  readonly sessionId: ProviderAuthSessionId;
  readonly connectionId: string;
}

export interface OwnedProviderAuthCodeInput extends OwnedProviderAuthSessionInput {
  readonly code: string;
}

export interface UpdateProviderAuthSessionInput {
  readonly sessionId: ProviderAuthSessionId;
  readonly state: ActiveProviderAuthState;
  readonly sanitizedPrompt?: string;
  readonly acceptsCode?: boolean;
}

export interface FinishProviderAuthSessionInput {
  readonly sessionId: ProviderAuthSessionId;
  readonly state: TerminalProviderAuthState;
}

export interface ProviderAuthServiceShape {
  readonly start: (
    input: StartProviderAuthSessionInput,
  ) => Effect.Effect<ProviderAuthSession, ProviderAuthError>;
  readonly startProvider: (
    input: StartManagedProviderAuthInput,
  ) => Effect.Effect<ProviderAuthStartResult, ProviderAuthError>;
  readonly get: (
    input: OwnedProviderAuthSessionInput,
  ) => Effect.Effect<ProviderAuthSession, ProviderAuthError>;
  readonly update: (
    input: UpdateProviderAuthSessionInput,
  ) => Effect.Effect<ProviderAuthSession, ProviderAuthError>;
  readonly finish: (input: FinishProviderAuthSessionInput) => Effect.Effect<void>;
  readonly cancel: (input: OwnedProviderAuthSessionInput) => Effect.Effect<void, ProviderAuthError>;
  readonly submitCode: (
    input: OwnedProviderAuthCodeInput,
  ) => Effect.Effect<ProviderAuthSession, ProviderAuthError>;
  readonly logoutProvider: (
    input: LogoutManagedProviderAuthInput,
  ) => Effect.Effect<void, ProviderAuthError>;
  readonly stopAll: () => Effect.Effect<void>;
}

export class ProviderAuthService extends Context.Service<
  ProviderAuthService,
  ProviderAuthServiceShape
>()("t3/provider-auth/ProviderAuthService") {}

export interface ProviderAuthServiceOptions {
  readonly ttlMs?: number;
  readonly terminalRetentionMs?: number;
  readonly randomId?: () => Effect.Effect<string, ProviderAuthError>;
}

interface ActiveSession {
  readonly ownerConnectionId: string;
  readonly singleFlightKey: string;
  readonly session: ProviderAuthSession;
  readonly cancel: Effect.Effect<void, ProviderAuthError>;
  readonly cleanup: Effect.Effect<void, ProviderAuthError>;
  readonly submitCode?: (code: string) => Effect.Effect<void, ProviderAuthError>;
}

interface TerminalSession {
  readonly ownerConnectionId: string;
  readonly session: ProviderAuthSession;
}

const authError = (code: ProviderAuthErrorCode, message: string) =>
  new ProviderAuthError({ code, message });

const notFound = () => authError("not-found", "Authentication session was not found.");

const normalizePrompt = (prompt: string): Effect.Effect<ProviderAuthPrompt, ProviderAuthError> => {
  const normalized = prompt.trim();
  return normalized.length > 0 && normalized.length <= MAX_PROMPT_LENGTH
    ? Effect.succeed(normalized as ProviderAuthPrompt)
    : Effect.fail(authError("invalid-request", "Invalid authentication request."));
};

export const makeProviderAuthService = Effect.fn("makeProviderAuthService")(function* (
  options: ProviderAuthServiceOptions = {},
) {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const terminalRetentionMs = options.terminalRetentionMs ?? DEFAULT_TERMINAL_RETENTION_MS;
  const randomId =
    options.randomId ??
    (() =>
      Effect.try({
        try: randomUUID,
        catch: () => authError("provider-failed", "Authentication could not start."),
      }));
  const serviceScope = yield* Scope.Scope;
  const lock = yield* Semaphore.make(1);
  const activeSessions = new Map<ProviderAuthSessionId, ActiveSession>();
  const terminalSessions = new Map<ProviderAuthSessionId, TerminalSession>();
  const singleFlights = new Map<string, ProviderAuthSessionId>();

  const runCleanup = (session: ActiveSession) =>
    session.cleanup.pipe(Effect.ignoreCause({ log: false }));

  const cancelAndCleanup = (session: ActiveSession) =>
    session.cancel.pipe(Effect.ignoreCause({ log: false }), Effect.andThen(runCleanup(session)));

  const moveToTerminal = (sessionId: ProviderAuthSessionId, state: TerminalProviderAuthState) =>
    lock.withPermits(1)(
      Effect.sync(() => {
        const active = activeSessions.get(sessionId);
        if (!active) return undefined;
        activeSessions.delete(sessionId);
        singleFlights.delete(active.singleFlightKey);
        terminalSessions.set(sessionId, {
          ownerConnectionId: active.ownerConnectionId,
          session: { ...active.session, state },
        });
        return active;
      }),
    );

  const forgetTerminalAfterRetention = (sessionId: ProviderAuthSessionId) =>
    Effect.sleep(Duration.millis(terminalRetentionMs)).pipe(
      Effect.andThen(
        lock.withPermits(1)(
          Effect.sync(() => {
            terminalSessions.delete(sessionId);
          }),
        ),
      ),
      Effect.forkIn(serviceScope),
      Effect.asVoid,
    );

  const expire = (sessionId: ProviderAuthSessionId) =>
    moveToTerminal(sessionId, "expired").pipe(
      Effect.flatMap((active) => {
        if (!active) {
          return lock.withPermits(1)(
            Effect.sync(() => {
              terminalSessions.delete(sessionId);
            }),
          );
        }
        return cancelAndCleanup(active).pipe(
          Effect.andThen(forgetTerminalAfterRetention(sessionId)),
        );
      }),
    );

  const watchExpiry = (sessionId: ProviderAuthSessionId) =>
    Effect.sleep(Duration.millis(ttlMs)).pipe(
      Effect.andThen(expire(sessionId)),
      Effect.forkIn(serviceScope),
    );

  const start: ProviderAuthServiceShape["start"] = (input) =>
    Effect.gen(function* () {
      const credentialHome = input.credentialHome.trim();
      const connectionId = input.connectionId.trim();
      if (!credentialHome || !connectionId || ttlMs <= 0 || terminalRetentionMs < 0) {
        return yield* authError("invalid-request", "Invalid authentication request.");
      }
      const prompt =
        input.sanitizedPrompt === undefined
          ? undefined
          : yield* normalizePrompt(input.sanitizedPrompt);
      const singleFlightKey = `${input.provider}\0${credentialHome}`;

      const session = yield* lock.withPermits(1)(
        Effect.gen(function* () {
          if (singleFlights.has(singleFlightKey)) {
            return yield* authError(
              "already-active",
              "Authentication is already active for this provider credential home.",
            );
          }
          const rawSessionId = yield* randomId().pipe(
            Effect.mapError(() => authError("provider-failed", "Authentication could not start.")),
          );
          const trimmedSessionId = rawSessionId.trim();
          if (!trimmedSessionId) {
            return yield* authError("provider-failed", "Authentication could not start.");
          }
          const sessionId = trimmedSessionId as ProviderAuthSessionId;
          if (activeSessions.has(sessionId) || terminalSessions.has(sessionId)) {
            return yield* authError("provider-failed", "Authentication could not start.");
          }
          const now = yield* Clock.currentTimeMillis;
          const publicSession: ProviderAuthSession = {
            sessionId,
            providerInstanceId: input.providerInstanceId,
            method: input.method,
            state: "starting",
            ...(prompt ? { prompt } : {}),
            acceptsCode: input.acceptsCode ?? false,
            expiresAt: DateTime.formatIso(DateTime.makeUnsafe(now + ttlMs)),
          };
          activeSessions.set(sessionId, {
            ownerConnectionId: connectionId,
            singleFlightKey,
            session: publicSession,
            cancel: input.cancel ?? Effect.void,
            cleanup: input.cleanup ?? Effect.void,
          });
          singleFlights.set(singleFlightKey, sessionId);
          return publicSession;
        }),
      );
      yield* watchExpiry(session.sessionId);
      return session;
    });

  const get: ProviderAuthServiceShape["get"] = (input) =>
    lock.withPermits(1)(
      Effect.suspend(() => {
        const session =
          activeSessions.get(input.sessionId) ?? terminalSessions.get(input.sessionId);
        return session?.ownerConnectionId === input.connectionId
          ? Effect.succeed(session.session)
          : Effect.fail(notFound());
      }),
    );

  const update: ProviderAuthServiceShape["update"] = (input) =>
    Effect.gen(function* () {
      const prompt =
        input.sanitizedPrompt === undefined
          ? undefined
          : yield* normalizePrompt(input.sanitizedPrompt);
      return yield* lock.withPermits(1)(
        Effect.suspend(() => {
          const active = activeSessions.get(input.sessionId);
          if (!active) return Effect.fail(notFound());
          const session: ProviderAuthSession = {
            ...active.session,
            state: input.state,
            ...(prompt ? { prompt } : {}),
            ...(input.acceptsCode === undefined ? {} : { acceptsCode: input.acceptsCode }),
          };
          activeSessions.set(input.sessionId, { ...active, session });
          return Effect.succeed(session);
        }),
      );
    });

  const finish: ProviderAuthServiceShape["finish"] = (input) =>
    moveToTerminal(input.sessionId, input.state).pipe(
      Effect.flatMap((active) =>
        active
          ? runCleanup(active).pipe(Effect.andThen(forgetTerminalAfterRetention(input.sessionId)))
          : Effect.void,
      ),
    );

  const cancel: ProviderAuthServiceShape["cancel"] = (input) =>
    lock
      .withPermits(1)(
        Effect.suspend(() => {
          const active = activeSessions.get(input.sessionId);
          if (!active || active.ownerConnectionId !== input.connectionId) {
            return Effect.fail(notFound());
          }
          activeSessions.delete(input.sessionId);
          singleFlights.delete(active.singleFlightKey);
          terminalSessions.set(input.sessionId, {
            ownerConnectionId: active.ownerConnectionId,
            session: { ...active.session, state: "cancelled" },
          });
          return Effect.succeed(active);
        }),
      )
      .pipe(
        Effect.flatMap((active) =>
          cancelAndCleanup(active).pipe(
            Effect.andThen(forgetTerminalAfterRetention(input.sessionId)),
          ),
        ),
      );

  const mapProviderError = (_cause: ProviderAdapterError) =>
    authError("provider-failed", "Provider authentication could not complete.");

  const attachAttempt = (
    sessionId: ProviderAuthSessionId,
    attempt: ProviderAuthAttempt<ProviderAdapterError>,
  ) => {
    const submitCode = attempt.submitCode;
    return lock.withPermits(1)(
      Effect.suspend(() => {
        const active = activeSessions.get(sessionId);
        if (!active) return Effect.fail(notFound());
        const session: ProviderAuthSession = {
          ...active.session,
          state: attempt.readiness ? "starting" : "awaiting-user",
        };
        activeSessions.set(sessionId, {
          ...active,
          session,
          cancel: attempt.cancel.pipe(Effect.mapError(mapProviderError)),
          cleanup: attempt.close,
          ...(submitCode
            ? {
                submitCode: (code: string) =>
                  submitCode(code).pipe(Effect.mapError(mapProviderError)),
              }
            : {}),
        });
        return Effect.succeed(session);
      }),
    );
  };

  const startProvider: ProviderAuthServiceShape["startProvider"] = (input) =>
    Effect.gen(function* () {
      if (!input.adapter.methods.includes(input.method)) {
        return yield* authError(
          "unsupported",
          "This provider does not support the requested authentication method.",
        );
      }
      const reserved = yield* start({
        provider: input.provider,
        providerInstanceId: input.providerInstanceId,
        credentialHome: input.adapter.credentialHome,
        connectionId: input.connectionId,
        method: input.method,
        sanitizedPrompt: "Open the verification page and follow the provider instructions.",
      });
      const attempt = yield* input.adapter.start(input.method).pipe(
        Effect.mapError(mapProviderError),
        Effect.onError(() => finish({ sessionId: reserved.sessionId, state: "failed" })),
      );
      const session = yield* attachAttempt(reserved.sessionId, attempt).pipe(
        Effect.onError(() =>
          attempt.cancel.pipe(Effect.ignoreCause({ log: false }), Effect.andThen(attempt.close)),
        ),
      );
      const readiness = attempt.readiness
        ? yield* attempt.readiness.pipe(
            Effect.mapError(mapProviderError),
            Effect.onError(() =>
              attempt.cancel.pipe(
                Effect.ignoreCause({ log: false }),
                Effect.andThen(finish({ sessionId: session.sessionId, state: "failed" })),
              ),
            ),
          )
        : undefined;
      const readySession = readiness
        ? yield* update({
            sessionId: session.sessionId,
            state: "awaiting-user",
            ...(readiness.sanitizedPrompt ? { sanitizedPrompt: readiness.sanitizedPrompt } : {}),
            acceptsCode: readiness.acceptsCode ?? false,
          })
        : session;
      const verificationUri = readiness?.verificationUri ?? attempt.verificationUri;
      const userCode = readiness?.userCode ?? attempt.userCode;
      yield* Effect.gen(function* () {
        const processSucceeded = yield* attempt.completion.pipe(Effect.orElseSucceed(() => false));
        const usedStatusProbe = processSucceeded && attempt.requiresStatusProbe === true;
        const statusProbePrepared = usedStatusProbe
          ? yield* (attempt.prepareStatusProbe ?? Effect.void).pipe(
              Effect.as(true),
              Effect.orElseSucceed(() => false),
            )
          : false;
        const succeeded = usedStatusProbe
          ? statusProbePrepared && (yield* input.verifyAuthenticated ?? Effect.succeed(false))
          : processSucceeded;
        yield* finish({
          sessionId: readySession.sessionId,
          state: succeeded ? "succeeded" : "failed",
        });
        if (!usedStatusProbe) yield* input.refresh;
      }).pipe(Effect.forkIn(serviceScope));
      return {
        session: readySession,
        ...(verificationUri ? { verificationUri } : {}),
        ...(userCode ? { userCode } : {}),
      };
    });

  const submitCode: ProviderAuthServiceShape["submitCode"] = (input) =>
    Effect.gen(function* () {
      const code = input.code.trim();
      if (!code || code.length > 4_096) {
        return yield* authError("invalid-request", "Invalid authentication request.");
      }
      const reserved = yield* lock.withPermits(1)(
        Effect.suspend(() => {
          const active = activeSessions.get(input.sessionId);
          if (!active || active.ownerConnectionId !== input.connectionId) {
            return Effect.fail(notFound());
          }
          if (!active.session.acceptsCode || !active.submitCode) {
            return Effect.fail(
              authError("invalid-request", "This authentication session is not accepting a code."),
            );
          }
          const session: ProviderAuthSession = {
            ...active.session,
            state: "waiting-provider",
            acceptsCode: false,
          };
          activeSessions.set(input.sessionId, { ...active, session });
          return Effect.succeed({ session, submitCode: active.submitCode });
        }),
      );
      yield* reserved
        .submitCode(code)
        .pipe(
          Effect.onError(() =>
            moveToTerminal(input.sessionId, "failed").pipe(
              Effect.flatMap((active) =>
                active
                  ? cancelAndCleanup(active).pipe(
                      Effect.andThen(forgetTerminalAfterRetention(input.sessionId)),
                    )
                  : Effect.void,
              ),
            ),
          ),
        );
      return reserved.session;
    });

  const logoutProvider: ProviderAuthServiceShape["logoutProvider"] = (input) => {
    const credentialHome = input.adapter.credentialHome.trim();
    const singleFlightKey = `${input.provider}\0${credentialHome}`;
    let reservation: ProviderAuthSessionId | undefined;
    return Effect.gen(function* () {
      if (!credentialHome) {
        return yield* authError("invalid-request", "Invalid authentication request.");
      }
      const reservationId = yield* randomId();
      const nextReservation =
        `logout-${input.providerInstanceId}-${reservationId}` as ProviderAuthSessionId;
      reservation = nextReservation;
      yield* lock.withPermits(1)(
        Effect.suspend(() => {
          if (singleFlights.has(singleFlightKey)) {
            return Effect.fail(
              authError(
                "already-active",
                "Authentication is already active for this provider credential home.",
              ),
            );
          }
          singleFlights.set(singleFlightKey, nextReservation);
          return Effect.void;
        }),
      );
      yield* input.adapter
        .logout()
        .pipe(Effect.mapError(mapProviderError), Effect.andThen(input.refresh));
    }).pipe(
      Effect.ensuring(
        lock.withPermits(1)(
          Effect.sync(() => {
            if (reservation && singleFlights.get(singleFlightKey) === reservation) {
              singleFlights.delete(singleFlightKey);
            }
          }),
        ),
      ),
    );
  };

  const stopAll: ProviderAuthServiceShape["stopAll"] = () =>
    lock
      .withPermits(1)(
        Effect.sync(() => {
          const active = Array.from(activeSessions.values());
          activeSessions.clear();
          terminalSessions.clear();
          singleFlights.clear();
          return active;
        }),
      )
      .pipe(
        Effect.flatMap((active) =>
          Effect.forEach(active, cancelAndCleanup, { concurrency: "unbounded", discard: true }),
        ),
      );

  yield* Effect.addFinalizer(() => stopAll());

  return {
    start,
    startProvider,
    get,
    update,
    finish,
    cancel,
    submitCode,
    logoutProvider,
    stopAll,
  } satisfies ProviderAuthServiceShape;
});

export const ProviderAuthServiceLive = Layer.effect(ProviderAuthService, makeProviderAuthService());
