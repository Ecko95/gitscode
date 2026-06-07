// @effect-diagnostics nodeBuiltinImport:off - integration exercises Node HTTP + filesystem boundaries.
import * as NodeHttp from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { describe, expect, it as vitestIt } from "vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServer,
} from "effect/unstable/http";

import { type OrchestrationThread, ProjectId, ThreadId } from "@t3tools/contracts";

import { AuthControlPlane } from "../auth/Services/AuthControlPlane.ts";
import { ServerAuthLive } from "../auth/Layers/ServerAuth.ts";
import { ServerSecretStoreLive } from "../auth/Layers/ServerSecretStore.ts";
import { ServerConfig, deriveServerPaths, type ServerConfigShape } from "../config.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { orchestrationDispatchRouteLayer } from "../orchestration/http.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { WorkspacePathsLive } from "../workspace/Layers/WorkspacePaths.ts";

import { compute_turn_status, critTurnRouteLayer, critTurnStatusRouteLayer } from "./critHttp.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = "2026-06-07T00:00:00.000Z";
const PROJECT_ID = ProjectId.make("project-crit");
const MODEL_SELECTION = { instanceId: "codex", model: "gpt-5-codex" } as const;

const make_thread = (overrides: Partial<OrchestrationThread> = {}): OrchestrationThread => ({
  id: ThreadId.make("thread-crit-a"),
  projectId: PROJECT_ID,
  title: "Crit Thread",
  modelSelection: MODEL_SELECTION,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: NOW,
  updatedAt: NOW,
  archivedAt: null,
  deletedAt: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
  ...overrides,
});

const make_latest_turn = (
  overrides: Partial<NonNullable<OrchestrationThread["latestTurn"]>> = {},
): NonNullable<OrchestrationThread["latestTurn"]> => ({
  turnId: "turn-new" as NonNullable<OrchestrationThread["latestTurn"]>["turnId"],
  state: "completed",
  requestedAt: NOW,
  startedAt: NOW,
  completedAt: NOW,
  assistantMessageId: null,
  ...overrides,
});

const make_message = (id: string, text: string): OrchestrationThread["messages"][number] => ({
  id: id as OrchestrationThread["messages"][number]["id"],
  role: "assistant",
  text,
  turnId: null,
  streaming: false,
  createdAt: NOW,
  updatedAt: NOW,
});

// ---------------------------------------------------------------------------
// Pure compute_turn_status
// ---------------------------------------------------------------------------

describe("compute_turn_status", () => {
  vitestIt("returns pending when the thread has no latest turn", () => {
    expect(compute_turn_status(make_thread({ latestTurn: null }), null)).toEqual({
      state: "pending",
      assistantMessageId: null,
      reply: null,
    });
  });

  vitestIt("returns pending when the latest turn equals the baseline prior turn", () => {
    const thread = make_thread({
      latestTurn: make_latest_turn({ turnId: "turn-prior" as any, state: "completed" }),
    });
    expect(compute_turn_status(thread, "turn-prior")).toEqual({
      state: "pending",
      assistantMessageId: null,
      reply: null,
    });
  });

  vitestIt("returns pending while the new turn is still running", () => {
    const thread = make_thread({
      latestTurn: make_latest_turn({ turnId: "turn-new" as any, state: "running" }),
    });
    expect(compute_turn_status(thread, "turn-prior")).toEqual({
      state: "pending",
      assistantMessageId: null,
      reply: null,
    });
  });

  vitestIt("returns pending when completed but the assistant message is not projected yet", () => {
    const thread = make_thread({
      latestTurn: make_latest_turn({
        turnId: "turn-new" as any,
        state: "completed",
        assistantMessageId: "msg-1" as any,
      }),
      messages: [], // message not projected
    });
    expect(compute_turn_status(thread, "turn-prior")).toEqual({
      state: "pending",
      assistantMessageId: null,
      reply: null,
    });
  });

  vitestIt("returns pending when completed with a null assistantMessageId", () => {
    const thread = make_thread({
      latestTurn: make_latest_turn({
        turnId: "turn-new" as any,
        state: "completed",
        assistantMessageId: null,
      }),
    });
    expect(compute_turn_status(thread, "turn-prior")).toEqual({
      state: "pending",
      assistantMessageId: null,
      reply: null,
    });
  });

  vitestIt("returns completed + reply when the assistant message is projected", () => {
    const thread = make_thread({
      latestTurn: make_latest_turn({
        turnId: "turn-new" as any,
        state: "completed",
        assistantMessageId: "msg-1" as any,
      }),
      messages: [make_message("msg-1", "the reply")],
    });
    expect(compute_turn_status(thread, "turn-prior")).toEqual({
      state: "completed",
      assistantMessageId: "msg-1",
      reply: "the reply",
    });
  });

  vitestIt("returns error when the new turn failed", () => {
    const thread = make_thread({
      latestTurn: make_latest_turn({ turnId: "turn-new" as any, state: "error" }),
    });
    expect(compute_turn_status(thread, "turn-prior")).toEqual({
      state: "error",
      assistantMessageId: null,
      reply: null,
    });
  });

  vitestIt("returns interrupted when the new turn was interrupted", () => {
    const thread = make_thread({
      latestTurn: make_latest_turn({ turnId: "turn-new" as any, state: "interrupted" }),
    });
    expect(compute_turn_status(thread, "turn-prior")).toEqual({
      state: "interrupted",
      assistantMessageId: null,
      reply: null,
    });
  });
});

// ---------------------------------------------------------------------------
// Route / integration wiring
// ---------------------------------------------------------------------------

const THREAD_A = ThreadId.make("thread-crit-a");
const THREAD_B = ThreadId.make("thread-crit-b");

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

interface StubOptions {
  readonly thread?: Option.Option<OrchestrationThread>;
  readonly onDispatch?: () => void;
}

const make_projection_layer = (thread: Option.Option<OrchestrationThread>) =>
  Layer.mock(ProjectionSnapshotQuery)({
    getThreadDetailById: () => Effect.succeed(thread),
  } as any);

const make_engine_layer = (onDispatch?: () => void) =>
  Layer.mock(OrchestrationEngineService)({
    readEvents: () => Stream.empty,
    streamDomainEvents: Stream.empty,
    dispatch: () => {
      onDispatch?.();
      return Effect.succeed({ sequence: 1 });
    },
  } as any);

const make_app_layer = (config: ServerConfigShape, options: StubOptions) => {
  const authLayer = ServerAuthLive.pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provide(ServerSecretStoreLive),
  );

  const routesLayer = Layer.mergeAll(
    critTurnRouteLayer,
    critTurnStatusRouteLayer,
    orchestrationDispatchRouteLayer,
  );

  return HttpRouter.serve(routesLayer, {
    disableListenLog: true,
    disableLogger: true,
  }).pipe(
    Layer.provideMerge(authLayer),
    Layer.provideMerge(make_projection_layer(options.thread ?? Option.none())),
    Layer.provideMerge(make_engine_layer(options.onDispatch)),
    Layer.provideMerge(WorkspacePathsLive),
    Layer.provideMerge(NodeHttpServer.layer(NodeHttp.createServer, { host: "127.0.0.1", port: 0 })),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(NodeServices.layer),
    Layer.provide(Layer.succeed(ServerConfig, config)),
  );
};

const with_app = <A, E>(
  options: StubOptions,
  run: (
    baseUrl: string,
    token: (subject: string) => Effect.Effect<string>,
  ) => Effect.Effect<A, E, any>,
) =>
  Effect.gen(function* () {
    const baseDir = mkdtempSync(join(tmpdir(), "t3-crit-http-test-"));
    const config = yield* make_test_server_config(baseDir);
    const appLayer = make_app_layer(config, options);

    return yield* Effect.scoped(
      Effect.gen(function* () {
        const server = yield* HttpServer.HttpServer;
        const address = server.address;
        if (typeof address === "string" || !("port" in address)) {
          return assert.fail(`Expected TCP address, got ${String(address)}`);
        }
        const baseUrl = `http://127.0.0.1:${address.port}`;
        const issueToken = (subject: string) =>
          Effect.gen(function* () {
            const authControlPlane = yield* AuthControlPlane;
            const issued = yield* authControlPlane.issueSession({
              role: "client",
              subject,
              label: `crit test ${subject}`,
            });
            return issued.token;
          }).pipe(Effect.orDie);
        return yield* run(baseUrl, issueToken);
      }).pipe(Effect.provide(Layer.mergeAll(appLayer, NodeServices.layer, FetchHttpClient.layer))),
    );
  });

const post_turn = (baseUrl: string, threadId: string, token: string | null) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const request = HttpClientRequest.post(`${baseUrl}/api/crit/turn`).pipe(
      HttpClientRequest.setHeaders(
        token === null
          ? { "content-type": "application/json" }
          : { "content-type": "application/json", authorization: `Bearer ${token}` },
      ),
      HttpClientRequest.bodyJsonUnsafe({ threadId, text: "please review" }),
    );
    return yield* client.execute(request);
  });

const get_turn_status = (
  baseUrl: string,
  threadId: string,
  priorTurnId: string | null,
  token: string | null,
) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const query =
      priorTurnId === null
        ? `threadId=${encodeURIComponent(threadId)}`
        : `threadId=${encodeURIComponent(threadId)}&priorTurnId=${encodeURIComponent(priorTurnId)}`;
    const request = HttpClientRequest.get(`${baseUrl}/api/crit/turn-status?${query}`).pipe(
      HttpClientRequest.setHeaders(token === null ? {} : { authorization: `Bearer ${token}` }),
    );
    return yield* client.execute(request);
  });

const post_orchestration_dispatch = (baseUrl: string, token: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const request = HttpClientRequest.post(`${baseUrl}/api/orchestration/dispatch`).pipe(
      HttpClientRequest.setHeaders({
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      }),
      HttpClientRequest.bodyJsonUnsafe({ type: "project.list" }),
    );
    return yield* client.execute(request);
  });

it.layer(NodeServices.layer)("crit http routes", (it) => {
  it.effect("POST /api/crit/turn succeeds for a subject-bound token and dispatches", () =>
    Effect.gen(function* () {
      let dispatched = false;
      yield* with_app(
        {
          thread: Option.some(
            make_thread({
              id: THREAD_A,
              latestTurn: make_latest_turn({ turnId: "turn-prior" as any }),
            }),
          ),
          onDispatch: () => {
            dispatched = true;
          },
        },
        (baseUrl, token) =>
          Effect.gen(function* () {
            const bearer = yield* token(THREAD_A);
            const response = yield* post_turn(baseUrl, THREAD_A, bearer);
            assert.equal(response.status, 200);
            const body = (yield* response.json) as { priorTurnId: string | null };
            assert.equal(body.priorTurnId, "turn-prior");
            assert.isTrue(dispatched);
          }),
      );
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  );

  it.effect("GET /api/crit/turn-status succeeds for a subject-bound token", () =>
    Effect.gen(function* () {
      yield* with_app(
        {
          thread: Option.some(
            make_thread({
              id: THREAD_A,
              latestTurn: make_latest_turn({
                turnId: "turn-new" as any,
                state: "completed",
                assistantMessageId: "msg-1" as any,
              }),
              messages: [make_message("msg-1", "the answer")],
            }),
          ),
        },
        (baseUrl, token) =>
          Effect.gen(function* () {
            const bearer = yield* token(THREAD_A);
            const response = yield* get_turn_status(baseUrl, THREAD_A, "turn-prior", bearer);
            assert.equal(response.status, 200);
            const body = (yield* response.json) as {
              state: string;
              reply: string | null;
            };
            assert.equal(body.state, "completed");
            assert.equal(body.reply, "the answer");
          }),
      );
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  );

  it.effect("POST /api/crit/turn rejects a token minted for a different thread (403)", () =>
    Effect.gen(function* () {
      yield* with_app({ thread: Option.some(make_thread({ id: THREAD_B })) }, (baseUrl, token) =>
        Effect.gen(function* () {
          const bearerForA = yield* token(THREAD_A);
          const response = yield* post_turn(baseUrl, THREAD_B, bearerForA);
          assert.equal(response.status, 403);
        }),
      );
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  );

  it.effect("GET /api/crit/turn-status rejects a token minted for a different thread (403)", () =>
    Effect.gen(function* () {
      yield* with_app({ thread: Option.some(make_thread({ id: THREAD_B })) }, (baseUrl, token) =>
        Effect.gen(function* () {
          const bearerForA = yield* token(THREAD_A);
          const response = yield* get_turn_status(baseUrl, THREAD_B, null, bearerForA);
          assert.equal(response.status, 403);
        }),
      );
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  );

  it.effect("POST /api/crit/turn rejects a request with no token (401)", () =>
    Effect.gen(function* () {
      yield* with_app({ thread: Option.some(make_thread({ id: THREAD_A })) }, (baseUrl) =>
        Effect.gen(function* () {
          const response = yield* post_turn(baseUrl, THREAD_A, null);
          assert.equal(response.status, 401);
        }),
      );
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  );

  it.effect("GET /api/crit/turn-status rejects a request with an invalid token (401)", () =>
    Effect.gen(function* () {
      yield* with_app({ thread: Option.some(make_thread({ id: THREAD_A })) }, (baseUrl) =>
        Effect.gen(function* () {
          const response = yield* get_turn_status(baseUrl, THREAD_A, null, "not-a-real-token");
          assert.equal(response.status, 401);
        }),
      );
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  );

  it.effect("the client-role crit token is rejected by /api/orchestration/dispatch", () =>
    Effect.gen(function* () {
      // The crit sidecar token is minted with role:"client" + subject:threadId.
      // The owner-gated orchestration endpoints reject it (its `role !== "owner"`
      // trips `authenticateOwnerSession`), so the broad capability stays
      // unreachable by the sidecar token. The owner gate surfaces this as a 400
      // (OrchestrationDispatchCommandError), never a 2xx — the load-bearing
      // property is that the dispatch is refused, not the exact status code.
      yield* with_app({ thread: Option.some(make_thread({ id: THREAD_A })) }, (baseUrl, token) =>
        Effect.gen(function* () {
          const bearer = yield* token(THREAD_A);
          const response = yield* post_orchestration_dispatch(baseUrl, bearer);
          assert.isTrue(
            response.status >= 400,
            `expected the client token to be refused by the owner endpoint, got ${response.status}`,
          );
          assert.notEqual(response.status, 200);
          assert.equal(response.status, 400);
        }),
      );
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  );
});
