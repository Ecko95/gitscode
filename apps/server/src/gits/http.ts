import * as Crypto from "node:crypto";

import * as Effect from "effect/Effect";
import * as Data from "effect/Data";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { AuthError, ServerAuth } from "../auth/Services/ServerAuth.ts";
import { respondToAuthError } from "../auth/http.ts";
import { ServerConfig } from "../config.ts";
import { isLoopbackHostname } from "../http.ts";
import { browserApiCorsHeaders } from "../httpCors.ts";
import {
  dispatchHermesTelegramCommand,
  parseHermesTelegramCommand,
} from "./HermesTelegramCommand.ts";
import { GitsBuildInfoResolver } from "./Services/GitsBuildInfo.ts";
import { GitsMcpInventoryResolver } from "./Services/GitsMcpInventory.ts";
import { GitsSkillInventoryResolver } from "./Services/GitsSkillInventory.ts";
import { readUsageSummary } from "./Layers/GitsUsageReader.ts";

export const authenticateGitsSession = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const serverAuth = yield* ServerAuth;
  const session = yield* serverAuth.authenticateHttpRequest(request);
  if (session.role === "thread-scoped") {
    return yield* new AuthError({
      message: "Thread-scoped sessions cannot access gits endpoints.",
      status: 403,
    });
  }
  return session;
});

class GitsUsageRouteError extends Data.TaggedError("GitsUsageRouteError")<{
  readonly cause: unknown;
}> {}

class HermesTelegramRelayRouteError extends Data.TaggedError("HermesTelegramRelayRouteError")<{
  readonly status: 400 | 401 | 403 | 503;
  readonly message: string;
}> {}

const respondToHermesTelegramRelayRouteError = (error: HermesTelegramRelayRouteError) =>
  Effect.succeed(HttpServerResponse.jsonUnsafe({ error: error.message }, { status: error.status }));

const isExpectedRelayBearer = (authorization: string | undefined, token: string): boolean => {
  if (typeof authorization !== "string") return false;
  const expected = `Bearer ${token}`;
  const providedBuffer = Buffer.from(authorization, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  return (
    providedBuffer.length === expectedBuffer.length &&
    Crypto.timingSafeEqual(providedBuffer, expectedBuffer)
  );
};

export const hermesTelegramRelayRouteLayer = HttpRouter.add(
  "POST",
  "/api/gits/hermes-telegram/command",
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const relayToken = config.hermesTelegramRelayToken;
    if (relayToken === undefined || relayToken.length === 0) {
      return yield* new HermesTelegramRelayRouteError({
        status: 503,
        message: "Hermes Telegram relay is not configured.",
      });
    }

    const request = yield* HttpServerRequest.HttpServerRequest;
    const source = request.source as {
      readonly remoteAddress?: string | null;
      readonly socket?: { readonly remoteAddress?: string | null };
    };
    const remoteAddress = source.socket?.remoteAddress ?? source.remoteAddress;
    const peerAddress =
      typeof remoteAddress === "string" ? remoteAddress.trim().replace(/^::ffff:/, "") : undefined;
    if (!peerAddress || !isLoopbackHostname(peerAddress)) {
      return yield* new HermesTelegramRelayRouteError({
        status: 403,
        message: "Hermes Telegram relay accepts loopback requests only.",
      });
    }

    if (!isExpectedRelayBearer(request.headers.authorization, relayToken)) {
      return yield* new HermesTelegramRelayRouteError({
        status: 401,
        message: "Invalid Hermes Telegram relay token.",
      });
    }

    const body = yield* request.json.pipe(
      Effect.mapError(
        () =>
          new HermesTelegramRelayRouteError({
            status: 400,
            message: "Invalid Hermes Telegram relay payload.",
          }),
      ),
    );
    if (
      typeof body !== "object" ||
      body === null ||
      Array.isArray(body) ||
      typeof (body as { readonly command?: unknown }).command !== "string"
    ) {
      return yield* new HermesTelegramRelayRouteError({
        status: 400,
        message: "Invalid Hermes Telegram relay payload.",
      });
    }

    const text = yield* dispatchHermesTelegramCommand(
      parseHermesTelegramCommand((body as { readonly command: string }).command),
    );
    return HttpServerResponse.jsonUnsafe({ text }, { status: 200 });
  }).pipe(Effect.catchTag("HermesTelegramRelayRouteError", respondToHermesTelegramRelayRouteError)),
);

export const gitsBuildInfoRouteLayer = HttpRouter.add(
  "GET",
  "/api/gits/build-info",
  Effect.gen(function* () {
    yield* authenticateGitsSession;
    const resolver = yield* GitsBuildInfoResolver;
    const buildInfo = yield* resolver.getBuildInfo();
    return HttpServerResponse.jsonUnsafe(buildInfo, {
      status: 200,
      headers: browserApiCorsHeaders,
    });
  }).pipe(
    Effect.catchTags({
      AuthError: respondToAuthError,
      GitsBuildInfoResolverError: (error) =>
        Effect.gen(function* () {
          yield* Effect.logError("gits build info route failed", {
            message: error.message,
            cause: error.cause,
          });
          return HttpServerResponse.jsonUnsafe(
            { error: error.message },
            { status: 500, headers: browserApiCorsHeaders },
          );
        }),
    }),
  ),
);

export const gitsSkillInventoryRouteLayer = HttpRouter.add(
  "GET",
  "/api/gits/skills",
  Effect.gen(function* () {
    yield* authenticateGitsSession;
    const resolver = yield* GitsSkillInventoryResolver;
    const snapshot = yield* resolver.getSnapshot();
    return HttpServerResponse.jsonUnsafe(snapshot, {
      status: 200,
      headers: browserApiCorsHeaders,
    });
  }).pipe(
    Effect.catchTags({
      AuthError: respondToAuthError,
      GitsSkillInventoryResolverError: (error) =>
        Effect.gen(function* () {
          yield* Effect.logError("gits skills inventory route failed", {
            message: error.message,
            cause: error.cause,
          });
          return HttpServerResponse.jsonUnsafe(
            { error: error.message },
            { status: 500, headers: browserApiCorsHeaders },
          );
        }),
    }),
  ),
);

export const gitsMcpInventoryRouteLayer = HttpRouter.add(
  "GET",
  "/api/gits/mcp",
  Effect.gen(function* () {
    yield* authenticateGitsSession;
    const resolver = yield* GitsMcpInventoryResolver;
    const snapshot = yield* resolver.getSnapshot();
    return HttpServerResponse.jsonUnsafe(snapshot, {
      status: 200,
      headers: browserApiCorsHeaders,
    });
  }).pipe(
    Effect.catchTags({
      AuthError: respondToAuthError,
      GitsMcpInventoryResolverError: (error) =>
        Effect.gen(function* () {
          yield* Effect.logError("gits mcp inventory route failed", {
            message: error.message,
            cause: error.cause,
          });
          return HttpServerResponse.jsonUnsafe(
            { error: error.message },
            { status: 500, headers: browserApiCorsHeaders },
          );
        }),
    }),
  ),
);

export const gitsUsageRouteLayer = HttpRouter.add(
  "GET",
  "/api/gits/usage",
  Effect.gen(function* () {
    yield* authenticateGitsSession;
    const summary = yield* Effect.tryPromise({
      try: () => readUsageSummary(),
      catch: (cause) => new GitsUsageRouteError({ cause }),
    });
    return HttpServerResponse.jsonUnsafe(summary, {
      status: 200,
      headers: browserApiCorsHeaders,
    });
  }).pipe(
    Effect.catchTags({
      AuthError: respondToAuthError,
      GitsUsageRouteError: (error) =>
        Effect.gen(function* () {
          yield* Effect.logError("gits usage route failed", {
            cause: error.cause,
          });
          return HttpServerResponse.jsonUnsafe(
            { error: "Failed to read local usage logs." },
            { status: 500, headers: browserApiCorsHeaders },
          );
        }),
    }),
  ),
);
