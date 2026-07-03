// @effect-diagnostics nodeBuiltinImport:off - integration exercises Node HTTP boundaries.
import * as NodeHttp from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServer,
} from "effect/unstable/http";

import { AuthControlPlane } from "../auth/Services/AuthControlPlane.ts";
import { ServerAuthLive } from "../auth/Layers/ServerAuth.ts";
import { ServerSecretStoreLive } from "../auth/Layers/ServerSecretStore.ts";
import { ServerConfig, deriveServerPaths, type ServerConfigShape } from "../config.ts";
import type { SessionRole } from "../auth/Services/SessionCredentialService.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { WorkspacePathsLive } from "../workspace/Layers/WorkspacePaths.ts";

import { GitsBuildInfoResolver } from "./Services/GitsBuildInfo.ts";
import { GitsSkillInventoryResolver } from "./Services/GitsSkillInventory.ts";
import { GitsMcpInventoryResolver } from "./Services/GitsMcpInventory.ts";
import {
  gitsBuildInfoRouteLayer,
  gitsSkillInventoryRouteLayer,
  gitsMcpInventoryRouteLayer,
} from "./http.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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

const make_stub_build_info_resolver = () =>
  Layer.succeed(GitsBuildInfoResolver, {
    getBuildInfo: () =>
      Effect.succeed({
        branch: "main",
        commit: "abc123",
        time: "2026-07-03T00:00:00Z",
        dirty: false,
        sourcePath: "/repo",
      }),
  });

const make_stub_skill_resolver = () =>
  Layer.succeed(GitsSkillInventoryResolver, {
    getSnapshot: () =>
      Effect.succeed({
        scannedAt: "2026-07-03T00:00:00.000Z",
        skills: [],
        providers: [],
        totals: {
          skillCount: 0,
          providerCount: 0,
          ratedCount: 0,
          reviewedCount: 0,
          missingPortCount: 0,
          hermesCandidateCount: 0,
        },
        warnings: [],
        insights: [],
      }),
  });

const make_stub_mcp_resolver = () =>
  Layer.succeed(GitsMcpInventoryResolver, {
    getSnapshot: () =>
      Effect.succeed({
        scannedAt: "2026-07-03T00:00:00.000Z",
        servers: [],
        providers: [],
        totals: { serverCount: 0, runningCount: 0, errorCount: 0, disabledCount: 0, toolCount: 0 },
        warnings: [],
      }),
  });

const make_app_layer = (config: ServerConfigShape) => {
  const authLayer = ServerAuthLive.pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provide(ServerSecretStoreLive),
  );

  const routesLayer = Layer.mergeAll(
    gitsBuildInfoRouteLayer,
    gitsSkillInventoryRouteLayer,
    gitsMcpInventoryRouteLayer,
  );

  return HttpRouter.serve(routesLayer, {
    disableListenLog: true,
    disableLogger: true,
  }).pipe(
    Layer.provideMerge(authLayer),
    Layer.provideMerge(make_stub_build_info_resolver()),
    Layer.provideMerge(make_stub_skill_resolver()),
    Layer.provideMerge(make_stub_mcp_resolver()),
    Layer.provideMerge(WorkspacePathsLive),
    Layer.provideMerge(NodeHttpServer.layer(NodeHttp.createServer, { host: "127.0.0.1", port: 0 })),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(NodeServices.layer),
    Layer.provide(Layer.succeed(ServerConfig, config)),
  );
};

const with_app = <A, E>(
  run: (
    baseUrl: string,
    token: (subject: string, role?: SessionRole) => Effect.Effect<string, never, AuthControlPlane>,
  ) => Effect.Effect<A, E, AuthControlPlane | HttpClient.HttpClient>,
) =>
  Effect.gen(function* () {
    const baseDir = mkdtempSync(join(tmpdir(), "t3-gits-http-test-"));
    const config = yield* make_test_server_config(baseDir);
    const appLayer = make_app_layer(config);

    return yield* Effect.scoped(
      Effect.gen(function* () {
        const server = yield* HttpServer.HttpServer;
        const address = server.address;
        if (typeof address === "string" || !("port" in address)) {
          return assert.fail(`Expected TCP address, got ${String(address)}`);
        }
        const baseUrl = `http://127.0.0.1:${address.port}`;
        const issueToken = (subject: string, role: SessionRole = "client") =>
          Effect.gen(function* () {
            const authControlPlane = yield* AuthControlPlane;
            const issued = yield* authControlPlane.issueSession({
              role,
              subject,
              label: `gits test ${subject}`,
            });
            return issued.token;
          }).pipe(Effect.orDie);
        return yield* run(baseUrl, issueToken);
      }).pipe(Effect.provide(Layer.mergeAll(appLayer, NodeServices.layer, FetchHttpClient.layer))),
    );
  });

const get_route = (baseUrl: string, path: string, token: string | null) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const request = HttpClientRequest.get(`${baseUrl}${path}`).pipe(
      HttpClientRequest.setHeaders(
        token === null
          ? { accept: "application/json" }
          : { accept: "application/json", authorization: `Bearer ${token}` },
      ),
    );
    return yield* client.execute(request);
  });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

it.layer(NodeServices.layer)("gits http routes require authentication", (it) => {
  it.effect("GET /api/gits/build-info returns 401 without credentials", () =>
    Effect.gen(function* () {
      yield* with_app((baseUrl) =>
        Effect.gen(function* () {
          const response = yield* get_route(baseUrl, "/api/gits/build-info", null);
          assert.equal(response.status, 401);
        }),
      );
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  );

  it.effect("GET /api/gits/build-info returns 200 with valid session", () =>
    Effect.gen(function* () {
      yield* with_app((baseUrl, token) =>
        Effect.gen(function* () {
          const bearer = yield* token("user-a");
          const response = yield* get_route(baseUrl, "/api/gits/build-info", bearer);
          assert.equal(response.status, 200);
          const body = (yield* response.json) as { branch: string };
          assert.equal(body.branch, "main");
        }),
      );
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  );

  it.effect("GET /api/gits/skills returns 401 without credentials", () =>
    Effect.gen(function* () {
      yield* with_app((baseUrl) =>
        Effect.gen(function* () {
          const response = yield* get_route(baseUrl, "/api/gits/skills", null);
          assert.equal(response.status, 401);
        }),
      );
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  );

  it.effect("GET /api/gits/skills returns 200 with valid session", () =>
    Effect.gen(function* () {
      yield* with_app((baseUrl, token) =>
        Effect.gen(function* () {
          const bearer = yield* token("user-a");
          const response = yield* get_route(baseUrl, "/api/gits/skills", bearer);
          assert.equal(response.status, 200);
          const body = (yield* response.json) as { skills: unknown[] };
          assert.isArray(body.skills);
        }),
      );
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  );

  it.effect("GET /api/gits/mcp returns 401 without credentials", () =>
    Effect.gen(function* () {
      yield* with_app((baseUrl) =>
        Effect.gen(function* () {
          const response = yield* get_route(baseUrl, "/api/gits/mcp", null);
          assert.equal(response.status, 401);
        }),
      );
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  );

  it.effect("GET /api/gits/mcp returns 200 with valid session", () =>
    Effect.gen(function* () {
      yield* with_app((baseUrl, token) =>
        Effect.gen(function* () {
          const bearer = yield* token("user-a");
          const response = yield* get_route(baseUrl, "/api/gits/mcp", bearer);
          assert.equal(response.status, 200);
          const body = (yield* response.json) as { servers: unknown[] };
          assert.isArray(body.servers);
        }),
      );
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  );
});
