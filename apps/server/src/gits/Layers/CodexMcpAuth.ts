// @effect-diagnostics nodeBuiltinImport:off
import { createHash, timingSafeEqual } from "node:crypto";
import { networkInterfaces } from "node:os";

import type {
  GitsCodexMcpAuthSessionState,
  GitsCodexMcpAuthStartResult,
  GitsCodexMcpAuthStatus,
} from "@t3tools/contracts";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import type { CodexMcpAuthLaunchConfig } from "../../provider/Services/ProviderAdapter.ts";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as CodexClient from "effect-codex-app-server/client";

import { ServerConfig } from "../../config.ts";
import { buildCodexInitializeParams } from "../../provider/Layers/CodexProvider.ts";
import { ProviderInstanceRegistry } from "../../provider/Services/ProviderInstanceRegistry.ts";
import {
  CodexMcpAuth,
  CodexMcpAuthError,
  type CodexMcpCallbackHandoff,
  type CodexMcpAuthShape,
  type CodexMcpAuthOwnedSessionInput,
  type SafeCodexMcpCallbackRequest,
  type StartCodexMcpAuthInput,
} from "../Services/CodexMcpAuth.ts";

const CALLBACK_PATH = "/api/gits/mcp/oauth/callback";
const CALLBACK_ID_PATTERN = /^[A-Za-z0-9._~-]{16,256}$/u;
const OAUTH_STATE_PATTERN = /^[A-Za-z0-9._~-]{32,1024}$/u;
const MAX_QUERY_LENGTH = 8_192;
const DEFAULT_TTL_MS = 3 * 60_000;
const MAX_BIND_ATTEMPTS = 3;
const isCodexMcpAuthError = Schema.is(CodexMcpAuthError);

export interface CodexMcpAuthHelperCompletion {
  readonly success: boolean;
}

export interface RunningCodexMcpAuthHelper {
  readonly authorizationUrl: string;
  readonly completion: Effect.Effect<CodexMcpAuthHelperCompletion>;
  readonly reload: Effect.Effect<void, CodexMcpAuthError>;
  readonly close: Effect.Effect<void>;
}

export interface CodexMcpAuthOptions {
  readonly ttlMs?: number;
  readonly resolveAdvertisedCallbackBaseUrl: () => Effect.Effect<string | null, CodexMcpAuthError>;
  readonly resolveLaunchConfig: (
    providerInstanceId: string,
  ) => Effect.Effect<CodexMcpAuthLaunchConfig, CodexMcpAuthError>;
  readonly reserveCallbackPort: () => Effect.Effect<number, CodexMcpAuthError>;
  readonly isCallbackPortIsolated: (port: number) => Effect.Effect<boolean>;
  readonly startHelper: (input: {
    readonly launchConfig: CodexMcpAuthLaunchConfig;
    readonly serverName: string;
    readonly callbackBaseUrl: string;
    readonly callbackPort: number;
    readonly timeoutSeconds: number;
  }) => Effect.Effect<RunningCodexMcpAuthHelper, CodexMcpAuthError>;
  readonly randomId: () => Effect.Effect<string, CodexMcpAuthError>;
}

interface CallbackLease {
  readonly expectedStateHash: Uint8Array;
  readonly localPort: number;
  readonly callbackPath: string;
  readonly expiresAtMs: number;
}

interface ActiveSession {
  readonly sessionId: string;
  readonly ownerConnectionId: string;
  readonly singleFlightKey: string;
  readonly expiresAt: string;
  readonly helper: RunningCodexMcpAuthHelper;
  readonly callbackId: string;
}

interface TerminalSession {
  readonly ownerConnectionId: string;
  readonly status: GitsCodexMcpAuthStatus;
}

function authError(code: CodexMcpAuthError["code"], message: string): CodexMcpAuthError {
  return new CodexMcpAuthError({ code, message });
}

function normalizeCallbackBaseUrl(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    url.pathname = CALLBACK_PATH;
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/u, "");
  } catch {
    return null;
  }
}

function hashState(state: string): Uint8Array {
  return createHash("sha256").update(state, "utf8").digest();
}

function equalState(expectedHash: Uint8Array, state: string): boolean {
  const actualHash = hashState(state);
  return (
    expectedHash.byteLength === actualHash.byteLength && timingSafeEqual(expectedHash, actualHash)
  );
}

function parseAuthorizationResponse(
  authorizationUrl: string,
  callbackBaseUrl: string,
): { readonly callbackId: string; readonly callbackPath: string; readonly stateHash: Uint8Array } {
  let authorization: URL;
  let redirect: URL;
  let callbackBase: URL;
  try {
    authorization = new URL(authorizationUrl);
    const redirectValue = authorization.searchParams.get("redirect_uri");
    if (!redirectValue) throw new Error("missing redirect");
    redirect = new URL(redirectValue);
    callbackBase = new URL(callbackBaseUrl);
  } catch {
    throw authError(
      "invalid-authorization-response",
      "The provider returned an incompatible authorization response.",
    );
  }
  const state = authorization.searchParams.get("state") ?? "";
  const expectedPrefix = `${callbackBase.pathname.replace(/\/$/u, "")}/`;
  const callbackId = redirect.pathname.startsWith(expectedPrefix)
    ? redirect.pathname.slice(expectedPrefix.length)
    : "";
  if (
    authorization.protocol !== "https:" ||
    redirect.protocol !== "https:" ||
    redirect.origin !== callbackBase.origin ||
    redirect.search ||
    redirect.hash ||
    callbackId.includes("/") ||
    !CALLBACK_ID_PATTERN.test(callbackId) ||
    !OAUTH_STATE_PATTERN.test(state)
  ) {
    throw authError(
      "invalid-authorization-response",
      "The provider returned an incompatible authorization response.",
    );
  }
  return { callbackId, callbackPath: redirect.pathname, stateHash: hashState(state) };
}

const terminalMessage = (state: GitsCodexMcpAuthSessionState): string | undefined => {
  switch (state) {
    case "failed":
      return "Authentication did not complete.";
    case "cancelled":
      return "Authentication was cancelled.";
    case "expired":
      return "Authentication expired.";
    case "waiting-provider":
    case "succeeded":
      return undefined;
  }
};

export const makeCodexMcpAuth = Effect.fn("makeCodexMcpAuth")(function* (
  options: CodexMcpAuthOptions,
) {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const serviceScope = yield* Scope.Scope;
  const lock = yield* Semaphore.make(1);
  const sessions = new Map<string, ActiveSession>();
  const terminalSessions = new Map<string, TerminalSession>();
  const singleFlights = new Map<string, string>();
  const callbackLeases = new Map<string, CallbackLease>();

  const finish = (
    sessionId: string,
    state: Exclude<GitsCodexMcpAuthSessionState, "waiting-provider">,
  ) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const session = sessions.get(sessionId);
        if (!session) return;
        sessions.delete(sessionId);
        singleFlights.delete(session.singleFlightKey);
        callbackLeases.delete(session.callbackId);
        const message = terminalMessage(state);
        terminalSessions.set(sessionId, {
          ownerConnectionId: session.ownerConnectionId,
          status: {
            sessionId,
            state,
            expiresAt: session.expiresAt,
            ...(message ? { message } : {}),
          },
        });
        if (state === "succeeded") {
          yield* session.helper.reload.pipe(Effect.ignore);
        }
        yield* session.helper.close.pipe(Effect.ignore);
      }),
    );

  const watchSession = (session: ActiveSession) =>
    Effect.race(
      session.helper.completion.pipe(
        Effect.map((completion) =>
          completion.success ? ("succeeded" as const) : ("failed" as const),
        ),
      ),
      Effect.sleep(Duration.millis(ttlMs)).pipe(Effect.as("expired" as const)),
    ).pipe(
      Effect.flatMap((state) => finish(session.sessionId, state)),
      Effect.forkIn(serviceScope),
    );

  const start: CodexMcpAuthShape["start"] = (input: StartCodexMcpAuthInput) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const serverName = input.serverName.trim();
        if (!serverName || serverName.length > 200 || !input.connectionId.trim()) {
          return yield* authError("invalid-request", "Invalid MCP authentication request.");
        }
        const callbackBaseUrl = normalizeCallbackBaseUrl(
          yield* options.resolveAdvertisedCallbackBaseUrl(),
        );
        if (!callbackBaseUrl) {
          return yield* authError(
            "relay-unavailable",
            "MCP browser authentication requires a compatible advertised HTTPS endpoint.",
          );
        }
        const launchConfig = yield* options
          .resolveLaunchConfig(input.providerInstanceId)
          .pipe(
            Effect.mapError(() =>
              authError("provider-unavailable", "The selected Codex instance is unavailable."),
            ),
          );
        const singleFlightKey = `${launchConfig.credentialHome}\0${serverName}`;
        if (singleFlights.has(singleFlightKey)) {
          return yield* authError(
            "already-active",
            "Authentication is already active for this MCP server.",
          );
        }

        let helper: RunningCodexMcpAuthHelper | undefined;
        let callbackPort = 0;
        for (let attempt = 0; attempt < MAX_BIND_ATTEMPTS && !helper; attempt += 1) {
          callbackPort = yield* options
            .reserveCallbackPort()
            .pipe(
              Effect.mapError(() =>
                authError("relay-unavailable", "A private callback port is unavailable."),
              ),
            );
          if (!(yield* options.isCallbackPortIsolated(callbackPort))) {
            return yield* authError(
              "relay-unavailable",
              "The temporary callback listener cannot be proven private.",
            );
          }
          helper = yield* options
            .startHelper({
              launchConfig,
              serverName,
              callbackBaseUrl,
              callbackPort,
              timeoutSeconds: Math.max(1, Math.ceil(ttlMs / 1_000)),
            })
            .pipe(
              Effect.option,
              Effect.map((result) => (result._tag === "Some" ? result.value : undefined)),
            );
        }
        if (!helper) {
          return yield* authError("provider-failed", "Codex MCP authentication could not start.");
        }

        const parsed = yield* Effect.try({
          try: () => parseAuthorizationResponse(helper.authorizationUrl, callbackBaseUrl),
          catch: (cause) =>
            isCodexMcpAuthError(cause)
              ? cause
              : authError(
                  "invalid-authorization-response",
                  "The provider returned an incompatible authorization response.",
                ),
        }).pipe(Effect.onError(() => helper.close.pipe(Effect.ignore)));
        if (callbackLeases.has(parsed.callbackId)) {
          yield* helper.close.pipe(Effect.ignore);
          return yield* authError(
            "invalid-authorization-response",
            "The provider returned an incompatible authorization response.",
          );
        }
        const sessionId = yield* options.randomId().pipe(
          Effect.mapError(() => authError("provider-failed", "Authentication could not start.")),
          Effect.onError(() => helper.close.pipe(Effect.ignore)),
        );
        const now = yield* Clock.currentTimeMillis;
        const expiresAtMs = now + ttlMs;
        const expiresAt = DateTime.formatIso(DateTime.makeUnsafe(expiresAtMs));
        const session: ActiveSession = {
          sessionId,
          ownerConnectionId: input.connectionId,
          singleFlightKey,
          expiresAt,
          helper,
          callbackId: parsed.callbackId,
        };
        sessions.set(sessionId, session);
        singleFlights.set(singleFlightKey, sessionId);
        callbackLeases.set(parsed.callbackId, {
          expectedStateHash: parsed.stateHash,
          localPort: callbackPort,
          callbackPath: parsed.callbackPath,
          expiresAtMs,
        });
        yield* watchSession(session);
        return {
          sessionId,
          authorizationUrl: helper.authorizationUrl,
          expiresAt,
        } satisfies GitsCodexMcpAuthStartResult;
      }),
    );

  const findOwnedStatus = (
    input: CodexMcpAuthOwnedSessionInput,
  ): Effect.Effect<GitsCodexMcpAuthStatus, CodexMcpAuthError> => {
    const active = sessions.get(input.sessionId);
    if (active?.ownerConnectionId === input.connectionId) {
      return Effect.succeed({
        sessionId: active.sessionId,
        state: "waiting-provider",
        expiresAt: active.expiresAt,
      });
    }
    const terminal = terminalSessions.get(input.sessionId);
    return terminal?.ownerConnectionId === input.connectionId
      ? Effect.succeed(terminal.status)
      : Effect.fail(authError("not-found", "Authentication session was not found."));
  };

  const getStatus: CodexMcpAuthShape["getStatus"] = (input) =>
    lock.withPermits(1)(Effect.suspend(() => findOwnedStatus(input)));

  const cancel: CodexMcpAuthShape["cancel"] = (input) =>
    lock
      .withPermits(1)(
        Effect.suspend(() => {
          const session = sessions.get(input.sessionId);
          if (!session || session.ownerConnectionId !== input.connectionId) {
            return Effect.fail(authError("not-found", "Authentication session was not found."));
          }
          return Effect.succeed(session.sessionId);
        }),
      )
      .pipe(Effect.flatMap((sessionId) => finish(sessionId, "cancelled")));

  const handleCallback: CodexMcpAuthShape["handleCallback"] = (
    input: SafeCodexMcpCallbackRequest,
  ): Effect.Effect<CodexMcpCallbackHandoff, CodexMcpAuthError> =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        if (
          input.rawQuery.length > MAX_QUERY_LENGTH ||
          !CALLBACK_ID_PATTERN.test(input.callbackId)
        ) {
          return yield* authError("invalid-callback", "OAuth callback was rejected.");
        }
        const lease = callbackLeases.get(input.callbackId);
        const now = yield* Clock.currentTimeMillis;
        if (
          !lease ||
          lease.expiresAtMs <= now ||
          !OAUTH_STATE_PATTERN.test(input.state) ||
          !equalState(lease.expectedStateHash, input.state)
        ) {
          return yield* authError("invalid-callback", "OAuth callback was rejected.");
        }
        callbackLeases.delete(input.callbackId);
        return {
          localPort: lease.localPort,
          pathAndQuery: `${lease.callbackPath}?${input.rawQuery}`,
        };
      }),
    );

  const stopAll: CodexMcpAuthShape["stopAll"] = () =>
    Effect.forEach(Array.from(sessions.keys()), (sessionId) => finish(sessionId, "cancelled"), {
      concurrency: 1,
      discard: true,
    });

  yield* Effect.addFinalizer(() => stopAll());

  return CodexMcpAuth.of({ start, getStatus, cancel, handleCallback, stopAll });
});

type NetworkInterfacesMap = ReturnType<typeof networkInterfaces>;

export function canProveWildcardCallbackIsolation(
  interfaces: NetworkInterfacesMap = networkInterfaces(),
): boolean {
  const entries = Object.values(interfaces).flatMap((interfaceEntries) => interfaceEntries ?? []);
  return entries.length > 0 && entries.every((entry) => entry.internal);
}

function definedEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

const makeCodexMcpAuthLive = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const registry = yield* ProviderInstanceRegistry;
  const netService = yield* NetService.NetService;
  const crypto = yield* Crypto.Crypto;
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const reserveCallbackPort = Effect.fn("CodexMcpAuth.reserveCallbackPort")(function* () {
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const bytes = yield* crypto
        .randomBytes(2)
        .pipe(
          Effect.mapError(() => authError("relay-unavailable", "A callback port is unavailable.")),
        );
      const randomValue = ((bytes[0] ?? 0) << 8) | (bytes[1] ?? 0);
      const port = 49_152 + (randomValue % (65_536 - 49_152));
      if (yield* netService.canListenOnHost(port, "0.0.0.0")) {
        return port;
      }
    }
    return yield* authError("relay-unavailable", "A callback port is unavailable.");
  });

  const startHelper: CodexMcpAuthOptions["startHelper"] = (input) =>
    Effect.gen(function* () {
      const helperScope = yield* Scope.make("sequential");
      const completion = yield* Deferred.make<CodexMcpAuthHelperCompletion>();
      const clientContext = yield* Layer.build(
        CodexClient.layerCommand({
          command: input.launchConfig.binaryPath,
          args: [
            "-c",
            `mcp_oauth_callback_port=${input.callbackPort}`,
            "-c",
            // @effect-diagnostics-next-line preferSchemaOverJson:off -- TOML string quoting.
            `mcp_oauth_callback_url=${JSON.stringify(input.callbackBaseUrl)}`,
            "app-server",
          ],
          cwd: config.cwd,
          inheritProcessEnv: false,
          env: {
            ...definedEnvironment(input.launchConfig.environment),
            CODEX_HOME: input.launchConfig.credentialHome,
          },
        }),
      ).pipe(
        Effect.provideService(Scope.Scope, helperScope),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
        Effect.mapError(() =>
          authError("provider-failed", "Codex MCP authentication could not start."),
        ),
        Effect.onError(() => Scope.close(helperScope, Exit.void)),
      );
      const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
        Effect.provide(clientContext),
      );
      yield* client.handleServerNotification("mcpServer/oauthLogin/completed", (notification) =>
        notification.name === input.serverName
          ? Deferred.succeed(completion, { success: notification.success }).pipe(Effect.asVoid)
          : Effect.void,
      );
      yield* client.request("initialize", buildCodexInitializeParams()).pipe(
        Effect.mapError(() =>
          authError("provider-failed", "Codex MCP authentication could not start."),
        ),
        Effect.onError(() => Scope.close(helperScope, Exit.void)),
      );
      yield* client.notify("initialized", undefined).pipe(
        Effect.mapError(() =>
          authError("provider-failed", "Codex MCP authentication could not start."),
        ),
        Effect.onError(() => Scope.close(helperScope, Exit.void)),
      );
      const response = yield* client
        .request("mcpServer/oauth/login", {
          name: input.serverName,
          timeoutSecs: input.timeoutSeconds,
        })
        .pipe(
          Effect.mapError(() =>
            authError("provider-failed", "Codex MCP authentication could not start."),
          ),
          Effect.onError(() => Scope.close(helperScope, Exit.void)),
        );
      return {
        authorizationUrl: response.authorizationUrl,
        completion: Deferred.await(completion),
        reload: client.request("config/mcpServer/reload", undefined).pipe(
          Effect.asVoid,
          Effect.mapError(() => authError("provider-failed", "Codex MCP status refresh failed.")),
        ),
        close: Scope.close(helperScope, Exit.void),
      } satisfies RunningCodexMcpAuthHelper;
    });

  return yield* makeCodexMcpAuth({
    resolveAdvertisedCallbackBaseUrl: () => Effect.succeed(config.mcpOauthCallbackUrl ?? null),
    resolveLaunchConfig: (providerInstanceId) =>
      registry.getInstance(ProviderInstanceId.make(providerInstanceId)).pipe(
        Effect.flatMap((instance) => {
          if (
            instance?.driverKind !== "codex" ||
            instance.adapter.getCodexMcpAuthLaunchConfig === undefined
          ) {
            return Effect.fail(
              authError("provider-unavailable", "The selected Codex instance is unavailable."),
            );
          }
          return Effect.succeed(instance.adapter.getCodexMcpAuthLaunchConfig());
        }),
      ),
    reserveCallbackPort,
    isCallbackPortIsolated: () => Effect.succeed(canProveWildcardCallbackIsolation()),
    startHelper,
    randomId: () =>
      crypto.randomUUIDv4.pipe(
        Effect.mapError(() => authError("provider-failed", "Authentication could not start.")),
      ),
  });
});

export const CodexMcpAuthLive = Layer.effect(CodexMcpAuth, makeCodexMcpAuthLive);
