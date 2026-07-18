import {
  ClientOrchestrationCommand,
  OrchestrationDispatchCommandError,
  OrchestrationGetSnapshotError,
  type OrchestrationCommand,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import type * as FileSystem from "effect/FileSystem";
import * as Effect from "effect/Effect";
import type * as Path from "effect/Path";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { respondToAuthError } from "../auth/http.ts";
import { type AuthenticatedSession, AuthError, ServerAuth } from "../auth/Services/ServerAuth.ts";
import { ServerConfig } from "../config.ts";
import { ServerRuntimeStartup } from "../serverRuntimeStartup.ts";
import { WorkspacePaths } from "../workspace/Services/WorkspacePaths.ts";
import { normalizeDispatchCommand } from "./Normalizer.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

type OrchestrationSnapshotRouteRequirements =
  | HttpServerRequest.HttpServerRequest
  | ProjectionSnapshotQuery
  | ServerAuth;

type OrchestrationDispatchRouteRequirements =
  | FileSystem.FileSystem
  | HttpServerRequest.HttpServerRequest
  | OrchestrationEngineService
  | Path.Path
  | ServerAuth
  | ServerConfig
  | ServerRuntimeStartup
  | WorkspacePaths;

const dispatchCommandWithStartup = (
  startup: ServerRuntimeStartup["Service"],
  orchestrationEngine: OrchestrationEngineService["Service"],
  normalizedCommand: OrchestrationCommand,
): Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError> =>
  startup.enqueueCommand(orchestrationEngine.dispatch(normalizedCommand, "operator")).pipe(
    Effect.mapError(
      (cause) =>
        new OrchestrationDispatchCommandError({
          message: "Failed to dispatch orchestration command.",
          cause,
        }),
    ),
  );

const respondToOrchestrationHttpError = (
  error: OrchestrationDispatchCommandError | OrchestrationGetSnapshotError,
) =>
  Effect.gen(function* () {
    if (error._tag === "OrchestrationGetSnapshotError") {
      yield* Effect.logError("orchestration http route failed", {
        message: error.message,
        cause: error.cause,
      });
      return HttpServerResponse.jsonUnsafe({ error: error.message }, { status: 500 });
    }

    return HttpServerResponse.jsonUnsafe({ error: error.message }, { status: 400 });
  });

const authenticateOwnerSession: Effect.Effect<
  AuthenticatedSession,
  AuthError,
  HttpServerRequest.HttpServerRequest | ServerAuth
> = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const serverAuth = yield* ServerAuth;
  const session = yield* serverAuth.authenticateHttpRequest(request);
  if (session.role !== "owner") {
    return yield* new AuthError({
      message: "Only owner sessions can manage projects.",
      status: 403,
    });
  }
  return session;
});

const orchestrationSnapshotHandler: Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  AuthError | OrchestrationGetSnapshotError,
  OrchestrationSnapshotRouteRequirements
> = Effect.gen(function* () {
  yield* authenticateOwnerSession;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const snapshot = yield* projectionSnapshotQuery.getSnapshot().pipe(
    Effect.mapError(
      (cause) =>
        new OrchestrationGetSnapshotError({
          message: "Failed to load orchestration snapshot.",
          cause,
        }),
    ),
  );
  return HttpServerResponse.jsonUnsafe(snapshot satisfies OrchestrationReadModel, {
    status: 200,
  });
}).pipe(
  Effect.catchTags({
    AuthError: respondToAuthError,
    OrchestrationGetSnapshotError: respondToOrchestrationHttpError,
  }),
);

const orchestrationDispatchHandler: Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  AuthError | OrchestrationDispatchCommandError,
  OrchestrationDispatchRouteRequirements
> = Effect.gen(function* () {
  yield* authenticateOwnerSession;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const startup = yield* ServerRuntimeStartup;
  const command = yield* HttpServerRequest.schemaBodyJson(ClientOrchestrationCommand).pipe(
    Effect.mapError(
      (cause) =>
        new OrchestrationDispatchCommandError({
          message: "Invalid orchestration command payload.",
          cause,
        }),
    ),
  );
  const normalizedCommand = yield* normalizeDispatchCommand(command);
  const result = yield* dispatchCommandWithStartup(startup, orchestrationEngine, normalizedCommand);
  return HttpServerResponse.jsonUnsafe(result, { status: 200 });
}).pipe(
  Effect.catchTags({
    AuthError: respondToAuthError,
    OrchestrationDispatchCommandError: respondToOrchestrationHttpError,
  }),
);

export const orchestrationSnapshotRouteLayer = HttpRouter.add(
  "GET",
  "/api/orchestration/snapshot",
  orchestrationSnapshotHandler,
);

export const orchestrationDispatchRouteLayer = HttpRouter.add(
  "POST",
  "/api/orchestration/dispatch",
  orchestrationDispatchHandler,
);
