import * as Effect from "effect/Effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { ServerAuth } from "../auth/Services/ServerAuth.ts";
import { respondToAuthError } from "../auth/http.ts";
import { browserApiCorsHeaders } from "../httpCors.ts";
import { GitsBuildInfoResolver, GitsBuildInfoResolverError } from "./Services/GitsBuildInfo.ts";
import {
  GitsMcpInventoryResolver,
  GitsMcpInventoryResolverError,
} from "./Services/GitsMcpInventory.ts";
import {
  GitsSkillInventoryResolver,
  GitsSkillInventoryResolverError,
} from "./Services/GitsSkillInventory.ts";

export const gitsBuildInfoRouteLayer = HttpRouter.add(
  "GET",
  "/api/gits/build-info",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* ServerAuth;
    yield* serverAuth.authenticateHttpRequest(request);
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
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* ServerAuth;
    yield* serverAuth.authenticateHttpRequest(request);
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
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* ServerAuth;
    yield* serverAuth.authenticateHttpRequest(request);
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
