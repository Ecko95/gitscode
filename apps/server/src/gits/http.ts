import * as Effect from "effect/Effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";

import { browserApiCorsHeaders } from "../httpCors.ts";
import { GitsBuildInfoResolver, GitsBuildInfoResolverError } from "./Services/GitsBuildInfo.ts";
import {
  GitsSkillInventoryResolver,
  GitsSkillInventoryResolverError,
} from "./Services/GitsSkillInventory.ts";

const respondToBuildInfoError = (error: GitsBuildInfoResolverError) =>
  Effect.gen(function* () {
    yield* Effect.logError("gits build info route failed", {
      message: error.message,
      cause: error.cause,
    });
    return HttpServerResponse.jsonUnsafe(
      {
        error: error.message,
      },
      {
        status: 500,
        headers: browserApiCorsHeaders,
      },
    );
  });

export const gitsBuildInfoRouteLayer = HttpRouter.add(
  "GET",
  "/api/gits/build-info",
  Effect.gen(function* () {
    const resolver = yield* GitsBuildInfoResolver;
    const buildInfo = yield* resolver.getBuildInfo();
    return HttpServerResponse.jsonUnsafe(buildInfo, {
      status: 200,
      headers: browserApiCorsHeaders,
    });
  }).pipe(Effect.catchTag("GitsBuildInfoResolverError", respondToBuildInfoError)),
);

const respondToSkillInventoryError = (error: GitsSkillInventoryResolverError) =>
  Effect.gen(function* () {
    yield* Effect.logError("gits skills inventory route failed", {
      message: error.message,
      cause: error.cause,
    });
    return HttpServerResponse.jsonUnsafe(
      {
        error: error.message,
      },
      {
        status: 500,
        headers: browserApiCorsHeaders,
      },
    );
  });

export const gitsSkillInventoryRouteLayer = HttpRouter.add(
  "GET",
  "/api/gits/skills",
  Effect.gen(function* () {
    const resolver = yield* GitsSkillInventoryResolver;
    const snapshot = yield* resolver.getSnapshot();
    return HttpServerResponse.jsonUnsafe(snapshot, {
      status: 200,
      headers: browserApiCorsHeaders,
    });
  }).pipe(Effect.catchTag("GitsSkillInventoryResolverError", respondToSkillInventoryError)),
);
