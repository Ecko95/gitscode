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
  HttpServerRequest,
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
import { AutomodeSupervisor, type AutomodeSupervisorShape } from "./Services/AutomodeSupervisor.ts";
import { DelamainAdapter, type DelamainAdapterShape } from "./Services/DelamainAdapter.ts";
import { GitsMcpInventoryResolver } from "./Services/GitsMcpInventory.ts";
import { GitsSkillInventoryResolver } from "./Services/GitsSkillInventory.ts";
import { GitsSlotScheduler, type GitsSlotSchedulerShape } from "./Services/GitsSlotScheduler.ts";
import {
  gitsBuildInfoRouteLayer,
  gitsMcpInventoryRouteLayer,
  gitsSkillInventoryRouteLayer,
  gitsUsageRouteLayer,
  hermesTelegramRelayRouteLayer,
} from "./http.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const make_test_server_config = (baseDir: string, hermesTelegramRelayToken?: string) =>
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
      devAllowedHosts: [],
      devBindHost: "127.0.0.1",
      devTailscaleServeEnabled: false,
      hermesTelegramRelayToken,
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

const make_stub_telegram_services = (calls: string[]) =>
  Layer.mergeAll(
    Layer.succeed(AutomodeSupervisor, {} as AutomodeSupervisorShape),
    Layer.succeed(DelamainAdapter, {} as DelamainAdapterShape),
    Layer.succeed(GitsSlotScheduler, {
      arm: () => {
        calls.push("arm");
        return Effect.succeed({});
      },
    } as unknown as GitsSlotSchedulerShape),
  );

const make_app_layer = (config: ServerConfigShape, calls: string[]) => {
  const authLayer = ServerAuthLive.pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provide(ServerSecretStoreLive),
  );

  const routesLayer = Layer.mergeAll(
    gitsBuildInfoRouteLayer,
    gitsSkillInventoryRouteLayer,
    gitsMcpInventoryRouteLayer,
    gitsUsageRouteLayer,
    hermesTelegramRelayRouteLayer,
  );

  return HttpRouter.serve(routesLayer, {
    disableListenLog: true,
    disableLogger: true,
  }).pipe(
    Layer.provideMerge(authLayer),
    Layer.provideMerge(make_stub_build_info_resolver()),
    Layer.provideMerge(make_stub_skill_resolver()),
    Layer.provideMerge(make_stub_mcp_resolver()),
    Layer.provideMerge(make_stub_telegram_services(calls)),
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
  options: { readonly hermesTelegramRelayToken?: string | null; readonly calls?: string[] } = {},
) =>
  Effect.gen(function* () {
    const baseDir = mkdtempSync(join(tmpdir(), "t3-gits-http-test-"));
    const config = yield* make_test_server_config(
      baseDir,
      options.hermesTelegramRelayToken === null
        ? undefined
        : (options.hermesTelegramRelayToken ?? "relay-token"),
    );
    const appLayer = make_app_layer(config, options.calls ?? []);

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

const post_hermes_telegram_command = (
  baseUrl: string,
  options: {
    readonly authorization?: string;
    readonly body: string | { readonly command: string };
  },
) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const request = HttpClientRequest.post(`${baseUrl}/api/gits/hermes-telegram/command`).pipe(
      HttpClientRequest.setHeaders({
        "content-type": "application/json",
        ...(options.authorization === undefined ? {} : { authorization: options.authorization }),
      }),
      typeof options.body === "string"
        ? HttpClientRequest.bodyText(options.body)
        : HttpClientRequest.bodyJsonUnsafe(options.body),
    );
    return yield* client.execute(request);
  });

const execute_hermes_telegram_route = (
  config: ServerConfigShape,
  source: { readonly socket?: { readonly remoteAddress?: string } },
) => {
  const baseRequest = HttpServerRequest.fromWeb(
    new Request("http://localhost/api/gits/hermes-telegram/command", {
      method: "POST",
      headers: {
        authorization: "Bearer relay-token",
        "content-type": "application/json",
        host: "localhost",
      },
      body: JSON.stringify({ command: "ARM" }),
    }),
  );
  const request = Object.assign(baseRequest, {
    source: new Proxy(baseRequest.source, {
      get(target, property) {
        return property === "socket" ? source.socket : Reflect.get(target, property, target);
      },
    }),
  });

  return Effect.scoped(
    HttpRouter.toHttpEffect(hermesTelegramRelayRouteLayer).pipe(
      Effect.flatMap((handler) => handler),
      Effect.provideService(HttpServerRequest.HttpServerRequest, request),
      Effect.provide(make_stub_telegram_services([])),
      Effect.provideService(ServerConfig, config),
    ),
  );
};

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

  it.effect("GET /api/gits/build-info returns 200 with owner session", () =>
    Effect.gen(function* () {
      yield* with_app((baseUrl, token) =>
        Effect.gen(function* () {
          const bearer = yield* token("owner-a", "owner");
          const response = yield* get_route(baseUrl, "/api/gits/build-info", bearer);
          assert.equal(response.status, 200);
        }),
      );
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  );

  it.effect("GET /api/gits/build-info rejects thread-scoped sessions with 403", () =>
    Effect.gen(function* () {
      yield* with_app((baseUrl, token) =>
        Effect.gen(function* () {
          const bearer = yield* token("thread-a", "thread-scoped");
          const response = yield* get_route(baseUrl, "/api/gits/build-info", bearer);
          assert.equal(response.status, 403);
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

  it.effect("GET /api/gits/usage returns 200 with valid session", () =>
    Effect.gen(function* () {
      yield* with_app((baseUrl, token) =>
        Effect.gen(function* () {
          const bearer = yield* token("user-a");
          const response = yield* get_route(baseUrl, "/api/gits/usage", bearer);
          assert.equal(response.status, 200);
          const body = (yield* response.json) as { currency: string; sources: unknown[] };
          assert.equal(body.currency, "USD");
          assert.isArray(body.sources);
        }),
      );
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  );
});

it.layer(NodeServices.layer)("Hermes Telegram relay route", (it) => {
  it.effect("POST rejects a non-loopback peer despite a spoofed loopback Host", () =>
    Effect.gen(function* () {
      const baseDir = mkdtempSync(join(tmpdir(), "t3-gits-http-test-"));
      const config = yield* make_test_server_config(baseDir, "relay-token");
      const response = yield* execute_hermes_telegram_route(config, {
        socket: { remoteAddress: "10.0.0.24" },
      });
      assert.equal(response.status, 403);
    }),
  );

  it.effect("POST rejects missing and incorrect relay bearer tokens", () =>
    Effect.gen(function* () {
      yield* with_app((baseUrl) =>
        Effect.gen(function* () {
          const missing = yield* post_hermes_telegram_command(baseUrl, {
            body: { command: "ARM" },
          });
          const incorrect = yield* post_hermes_telegram_command(baseUrl, {
            authorization: "Bearer not-the-relay-token",
            body: { command: "ARM" },
          });
          assert.equal(missing.status, 401);
          assert.equal(incorrect.status, 401);
        }),
      );
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  );

  it.effect("POST rejects malformed JSON", () =>
    Effect.gen(function* () {
      yield* with_app((baseUrl) =>
        Effect.gen(function* () {
          const response = yield* post_hermes_telegram_command(baseUrl, {
            authorization: "Bearer relay-token",
            body: "{",
          });
          assert.equal(response.status, 400);
        }),
      );
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  );

  it.effect("POST dispatches a valid command only through the expected service operation", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      yield* with_app(
        (baseUrl) =>
          Effect.gen(function* () {
            const response = yield* post_hermes_telegram_command(baseUrl, {
              authorization: "Bearer relay-token",
              body: { command: "ARM" },
            });
            assert.equal(response.status, 200);
            assert.deepEqual(yield* response.json, { text: "Scheduler armed." });
            assert.deepEqual(calls, ["arm"]);
          }),
        { calls },
      );
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  );

  it.effect("POST returns 503 before parsing commands when the relay token is absent", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      yield* with_app(
        (baseUrl) =>
          Effect.gen(function* () {
            const response = yield* post_hermes_telegram_command(baseUrl, {
              body: "{",
            });
            assert.equal(response.status, 503);
            assert.deepEqual(calls, []);
          }),
        { hermesTelegramRelayToken: null, calls },
      );
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  );
});
