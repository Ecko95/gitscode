import * as Effect from "effect/Effect";
import * as Data from "effect/Data";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { AuthError, ServerAuth } from "../auth/Services/ServerAuth.ts";
import { respondToAuthError } from "../auth/http.ts";
import { browserApiCorsHeaders } from "../httpCors.ts";
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
    const summary = yield* Effect.try({
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
