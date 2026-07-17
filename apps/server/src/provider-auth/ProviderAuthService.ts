// @effect-diagnostics nodeBuiltinImport:off
import { randomUUID } from "node:crypto";

import type {
  ProviderAuthMethod,
  ProviderAuthPrompt,
  ProviderAuthSession,
  ProviderAuthSessionId,
  ProviderAuthSessionState,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

const DEFAULT_TTL_MS = 10 * 60_000;
const DEFAULT_TERMINAL_RETENTION_MS = 30_000;
const MAX_PROMPT_LENGTH = 1_000;

type ActiveProviderAuthState = Extract<
  ProviderAuthSessionState,
  "starting" | "awaiting-user" | "waiting-provider"
>;
type TerminalProviderAuthState = Exclude<ProviderAuthSessionState, ActiveProviderAuthState>;

export const ProviderAuthErrorCode = Schema.Literals([
  "invalid-request",
  "already-active",
  "not-found",
  "failed",
]);
export type ProviderAuthErrorCode = typeof ProviderAuthErrorCode.Type;

export class ProviderAuthError extends Schema.TaggedErrorClass<ProviderAuthError>()(
  "ProviderAuthError",
  {
    code: ProviderAuthErrorCode,
    message: Schema.String,
  },
) {}

export interface StartProviderAuthSessionInput {
  readonly provider: ProviderDriverKind;
  readonly providerInstanceId: ProviderInstanceId;
  readonly credentialHome: string;
  readonly connectionId: string;
  readonly method: ProviderAuthMethod;
  readonly sanitizedPrompt?: string;
  readonly acceptsCode?: boolean;
  readonly cleanup?: Effect.Effect<void, ProviderAuthError>;
}

export interface OwnedProviderAuthSessionInput {
  readonly sessionId: ProviderAuthSessionId;
  readonly connectionId: string;
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
  readonly get: (
    input: OwnedProviderAuthSessionInput,
  ) => Effect.Effect<ProviderAuthSession, ProviderAuthError>;
  readonly update: (
    input: UpdateProviderAuthSessionInput,
  ) => Effect.Effect<ProviderAuthSession, ProviderAuthError>;
  readonly finish: (input: FinishProviderAuthSessionInput) => Effect.Effect<void>;
  readonly cancel: (input: OwnedProviderAuthSessionInput) => Effect.Effect<void, ProviderAuthError>;
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
  readonly cleanup: Effect.Effect<void, ProviderAuthError>;
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
        catch: () => authError("failed", "Authentication could not start."),
      }));
  const serviceScope = yield* Scope.Scope;
  const lock = yield* Semaphore.make(1);
  const activeSessions = new Map<ProviderAuthSessionId, ActiveSession>();
  const terminalSessions = new Map<ProviderAuthSessionId, TerminalSession>();
  const singleFlights = new Map<string, ProviderAuthSessionId>();

  const runCleanup = (session: ActiveSession) =>
    session.cleanup.pipe(Effect.ignoreCause({ log: false }));

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
        return runCleanup(active).pipe(
          Effect.andThen(Effect.sleep(Duration.millis(terminalRetentionMs))),
          Effect.andThen(
            lock.withPermits(1)(
              Effect.sync(() => {
                terminalSessions.delete(sessionId);
              }),
            ),
          ),
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
            Effect.mapError(() => authError("failed", "Authentication could not start.")),
          );
          const trimmedSessionId = rawSessionId.trim();
          if (!trimmedSessionId) {
            return yield* authError("failed", "Authentication could not start.");
          }
          const sessionId = trimmedSessionId as ProviderAuthSessionId;
          if (activeSessions.has(sessionId) || terminalSessions.has(sessionId)) {
            return yield* authError("failed", "Authentication could not start.");
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
      Effect.flatMap((active) => (active ? runCleanup(active) : Effect.void)),
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
      .pipe(Effect.flatMap(runCleanup));

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
          Effect.forEach(active, runCleanup, { concurrency: "unbounded", discard: true }),
        ),
      );

  yield* Effect.addFinalizer(() => stopAll());

  return { start, get, update, finish, cancel, stopAll } satisfies ProviderAuthServiceShape;
});

export const ProviderAuthServiceLive = Layer.effect(ProviderAuthService, makeProviderAuthService());
