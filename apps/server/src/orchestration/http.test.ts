// @effect-diagnostics nodeBuiltinImport:off - integration exercises Node HTTP boundaries.
import * as NodeHttp from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthSessionId,
  CommandId,
  ProjectId,
  type ClientOrchestrationCommand,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServer,
} from "effect/unstable/http";

import {
  AuthError,
  type AuthenticatedSession,
  ServerAuth,
  type ServerAuthShape,
} from "../auth/Services/ServerAuth.ts";
import { ServerConfig, deriveServerPaths, type ServerConfigShape } from "../config.ts";
import { PersistenceSqlError, type ProjectionRepositoryError } from "../persistence/Errors.ts";
import {
  makeCommandGate,
  ServerRuntimeStartup,
  type ServerRuntimeStartupShape,
} from "../serverRuntimeStartup.ts";
import { WorkspacePaths } from "../workspace/Services/WorkspacePaths.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import { orchestrationDispatchRouteLayer, orchestrationSnapshotRouteLayer } from "./http.ts";

const make_test_server_config = (baseDir: string) =>
  Effect.gen(function* () {
    const derivedPaths = yield* deriveServerPaths(baseDir, undefined);
    return {
      logLevel: "Info",
      traceMinLevel: "Info",
      traceTimingEnabled: true,
      traceBatchWindowMs: 200,
      traceMaxBytes: 10 * 1024 * 1024,
      traceMaxFiles: 10,
      otlpTracesUrl: undefined,
      otlpMetricsUrl: undefined,
      otlpExportIntervalMs: 10_000,
      otlpServiceName: "t3-server",
      mode: "web",
      port: 0,
      host: "127.0.0.1",
      cwd: process.cwd(),
      baseDir,
      ...derivedPaths,
      staticDir: undefined,
      devUrl: undefined,
      noBrowser: true,
      startupPresentation: "browser",
      desktopBootstrapToken: undefined,
      autoBootstrapProjectFromCwd: false,
      logWebSocketEvents: false,
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
    } satisfies ServerConfigShape;
  });

const ownerSession: AuthenticatedSession = {
  sessionId: AuthSessionId.make("session-owner"),
  subject: "owner",
  method: "bearer-session-token",
  role: "owner",
};

const make_auth_layer = (session: AuthenticatedSession | AuthError) =>
  Layer.succeed(ServerAuth, {
    getDescriptor: () => Effect.die("unused"),
    getSessionState: () => Effect.die("unused"),
    exchangeBootstrapCredential: () => Effect.die("unused"),
    exchangeBootstrapCredentialForBearerSession: () => Effect.die("unused"),
    issuePairingCredential: () => Effect.die("unused"),
    listPairingLinks: () => Effect.die("unused"),
    revokePairingLink: () => Effect.die("unused"),
    listClientSessions: () => Effect.die("unused"),
    revokeClientSession: () => Effect.die("unused"),
    revokeOtherClientSessions: () => Effect.die("unused"),
    authenticateHttpRequest: () =>
      session instanceof AuthError ? Effect.fail(session) : Effect.succeed(session),
    authenticateWebSocketUpgrade: () => Effect.die("unused"),
    issueWebSocketToken: () => Effect.die("unused"),
    issueStartupPairingUrl: () => Effect.die("unused"),
  } satisfies ServerAuthShape);

const emptySnapshot = {
  projects: [],
  threads: [],
  snapshotSequence: 0,
  updatedAt: "2026-07-06T00:00:00.000Z",
} satisfies OrchestrationReadModel;

const make_snapshot_layer = (
  snapshotEffect: Effect.Effect<OrchestrationReadModel, ProjectionRepositoryError> = Effect.succeed(
    emptySnapshot,
  ),
) =>
  Layer.mock(ProjectionSnapshotQuery)({
    // ponytail: route tests only exercise getSnapshot; the rest are never reached.
    getSnapshot: () => snapshotEffect,
  } as any);

const make_workspace_paths_layer = () =>
  Layer.succeed(WorkspacePaths, {
    normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
    resolveRelativePathWithinRoot: ({ workspaceRoot, relativePath }) =>
      Effect.succeed({ absolutePath: `${workspaceRoot}/${relativePath}`, relativePath }),
  });

const make_startup_layer = (startup: ServerRuntimeStartupShape) =>
  Layer.succeed(ServerRuntimeStartup, startup);

const make_app_layer = (
  config: ServerConfigShape,
  options: {
    readonly authLayer?: Layer.Layer<ServerAuth>;
    readonly engineLayer?: Layer.Layer<OrchestrationEngineService>;
    readonly snapshotLayer?: Layer.Layer<ProjectionSnapshotQuery>;
    readonly startupLayer?: Layer.Layer<ServerRuntimeStartup>;
  },
) => {
  const routesLayer = Layer.mergeAll(
    orchestrationDispatchRouteLayer,
    orchestrationSnapshotRouteLayer,
  );
  return HttpRouter.serve(routesLayer, {
    disableListenLog: true,
    disableLogger: true,
  }).pipe(
    Layer.provideMerge(options.authLayer ?? make_auth_layer(ownerSession)),
    Layer.provideMerge(
      options.engineLayer ??
        Layer.mock(OrchestrationEngineService)({
          dispatch: () => Effect.succeed({ sequence: 1 }),
          readEvents: () => Stream.empty,
          streamDomainEvents: Stream.empty,
        } as any),
    ),
    Layer.provideMerge(options.snapshotLayer ?? make_snapshot_layer()),
    Layer.provideMerge(
      options.startupLayer ??
        make_startup_layer({
          awaitCommandReady: Effect.void,
          markHttpListening: Effect.void,
          enqueueCommand: (effect) => effect,
        }),
    ),
    Layer.provideMerge(make_workspace_paths_layer()),
    Layer.provideMerge(NodeHttpServer.layer(NodeHttp.createServer, { host: "127.0.0.1", port: 0 })),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(NodeServices.layer),
    Layer.provide(Layer.succeed(ServerConfig, config)),
  );
};

const with_app = <A, E>(
  options: Parameters<typeof make_app_layer>[1],
  run: (baseUrl: string) => Effect.Effect<A, E, HttpClient.HttpClient | Scope.Scope>,
) =>
  Effect.gen(function* () {
    const baseDir = mkdtempSync(join(tmpdir(), "t3-orchestration-http-test-"));
    const config = yield* make_test_server_config(baseDir);
    const appLayer = make_app_layer(config, options);

    return yield* Effect.scoped(
      Effect.gen(function* () {
        const server = yield* HttpServer.HttpServer;
        const address = server.address;
        if (typeof address === "string" || !("port" in address)) {
          return assert.fail(`Expected TCP address, got ${String(address)}`);
        }
        return yield* run(`http://127.0.0.1:${address.port}`);
      }).pipe(Effect.provide(Layer.mergeAll(appLayer, NodeServices.layer, FetchHttpClient.layer))),
    );
  });

const post_dispatch = (baseUrl: string, command: ClientOrchestrationCommand) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const request = HttpClientRequest.post(`${baseUrl}/api/orchestration/dispatch`).pipe(
      HttpClientRequest.setHeaders({ "content-type": "application/json" }),
      HttpClientRequest.bodyJsonUnsafe(command),
    );
    return yield* client.execute(request);
  });

const get_snapshot = (baseUrl: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return yield* client.execute(HttpClientRequest.get(`${baseUrl}/api/orchestration/snapshot`));
  });

const deleteProjectCommand = {
  type: "project.delete",
  commandId: CommandId.make("cmd-http-dispatch"),
  projectId: ProjectId.make("project-http-dispatch"),
} satisfies ClientOrchestrationCommand;

it.layer(NodeServices.layer)("orchestration http routes", (it) => {
  it.effect(
    "POST /api/orchestration/dispatch queues command dispatch behind startup readiness",
    () =>
      Effect.gen(function* () {
        const commandGate = yield* makeCommandGate;
        const dispatchCount = yield* Ref.make(0);
        const startupLayer = make_startup_layer({
          awaitCommandReady: commandGate.awaitCommandReady,
          markHttpListening: Effect.void,
          enqueueCommand: commandGate.enqueueCommand,
        });
        const engineLayer = Layer.mock(OrchestrationEngineService)({
          dispatch: () =>
            Ref.updateAndGet(dispatchCount, (count) => count + 1).pipe(Effect.as({ sequence: 42 })),
          readEvents: () => Stream.empty,
          streamDomainEvents: Stream.empty,
        } as any);

        yield* with_app({ engineLayer, startupLayer }, (baseUrl) =>
          Effect.gen(function* () {
            const responseFiber = yield* post_dispatch(baseUrl, deleteProjectCommand).pipe(
              Effect.forkScoped,
            );

            yield* Effect.yieldNow;
            assert.equal(yield* Ref.get(dispatchCount), 0);

            yield* commandGate.signalCommandReady;
            const response = yield* Fiber.join(responseFiber);
            assert.equal(response.status, 200);
            assert.equal(yield* Ref.get(dispatchCount), 1);
          }),
        );
      }).pipe(Effect.provide(FetchHttpClient.layer)),
  );

  it.effect("POST /api/orchestration/dispatch maps auth failures to 401", () =>
    Effect.gen(function* () {
      yield* with_app(
        {
          authLayer: make_auth_layer(
            new AuthError({ message: "Missing credentials.", status: 401 }),
          ),
        },
        (baseUrl) =>
          Effect.gen(function* () {
            const response = yield* post_dispatch(baseUrl, deleteProjectCommand);
            assert.equal(response.status, 401);
          }),
      );
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  );

  it.effect("GET /api/orchestration/snapshot preserves infra failures as 500", () =>
    Effect.gen(function* () {
      yield* with_app(
        {
          snapshotLayer: make_snapshot_layer(
            Effect.fail(
              new PersistenceSqlError({
                operation: "test.getSnapshot",
                detail: "database unavailable",
              }),
            ),
          ),
        },
        (baseUrl) =>
          Effect.gen(function* () {
            const response = yield* get_snapshot(baseUrl);
            assert.equal(response.status, 500);
          }),
      );
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  );
});
