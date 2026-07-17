// @effect-diagnostics nodeBuiltinImport:off - exercises the Node HTTP trust boundary.
import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { AuthSessionId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
} from "effect/unstable/http";

import { AuthError, ServerAuth, type ServerAuthShape } from "../../auth/Services/ServerAuth.ts";
import { makeCodexMcpAuth } from "../Layers/CodexMcpAuth.ts";
import { CodexMcpAuth } from "../Services/CodexMcpAuth.ts";
import { codexMcpOauthRoutesLayer } from "./CodexMcpOauthRoutes.ts";

const callbackId = "callback_0123456789abcdef";
const state = "state_0123456789abcdefghijklmnopqrstuvwxyzABCDEFG";
const callbackBaseUrl = "https://gits.example.test/api/gits/mcp/oauth/callback";
const bearer = "test-session";

interface RecordedRequest {
  readonly url: string;
  readonly headers: NodeHttp.IncomingHttpHeaders;
}

const acquireHelperServer = (requests: RecordedRequest[]) =>
  Effect.acquireRelease(
    Effect.callback<{ readonly server: NodeHttp.Server; readonly port: number }>((resume) => {
      const server = NodeHttp.createServer((request, response) => {
        requests.push({ url: request.url ?? "", headers: request.headers });
        response.writeHead(200, {
          connection: "close",
          "content-type": "text/html; charset=utf-8",
          "set-cookie": "helper-secret=must-not-escape",
          "x-helper-secret": "must-not-escape",
        });
        response.end("<p>Authentication complete.</p>");
      });
      server.once("error", (cause) => resume(Effect.die(cause)));
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          resume(Effect.die("Expected helper TCP address."));
          return;
        }
        resume(Effect.succeed({ server, port: address.port }));
      });
    }),
    ({ server }) =>
      Effect.callback<void>((resume) => {
        server.closeAllConnections();
        server.close(() => resume(Effect.void));
      }),
  );

const makeServerAuthLayer = () =>
  Layer.succeed(ServerAuth, {
    authenticateHttpRequest: (request: HttpServerRequest.HttpServerRequest) =>
      request.headers.authorization === `Bearer ${bearer}`
        ? Effect.succeed({
            sessionId: AuthSessionId.make("auth-session-a"),
            subject: "test-client",
            method: "bearer-session-token",
            role: "client",
          })
        : Effect.fail(new AuthError({ message: "Authentication required.", status: 401 })),
  } as unknown as ServerAuthShape);

const makeMcpAuthLayer = (helperPort: number, ttlMs = 60_000) => {
  let nextId = 0;
  return Layer.effect(
    CodexMcpAuth,
    makeCodexMcpAuth({
      ttlMs,
      resolveAdvertisedCallbackBaseUrl: () => Effect.succeed(callbackBaseUrl),
      resolveLaunchConfig: () =>
        Effect.succeed({
          binaryPath: "codex",
          credentialHome: "/home/test/.codex",
          environment: {},
        }),
      reserveCallbackPort: () => Effect.succeed(helperPort),
      isCallbackListenerIsolated: () => Effect.succeed(true),
      startHelper: (input) =>
        Deferred.make<never>().pipe(
          Effect.map((completion) => ({
            authorizationUrl: `https://auth.example.test/authorize?redirect_uri=${encodeURIComponent(
              `${input.callbackBaseUrl}/${callbackId}`,
            )}&state=${state}`,
            completion: Deferred.await(completion),
            reload: Effect.void,
            close: Effect.void,
          })),
        ),
      randomId: () => Effect.succeed(`oauth-session-${++nextId}`),
    }),
  );
};

const withApp = <A, E>(
  ttlMs: number,
  run: (input: {
    readonly baseUrl: string;
    readonly helperRequests: RecordedRequest[];
  }) => Effect.Effect<A, E, HttpClient.HttpClient>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const helperRequests: RecordedRequest[] = [];
      const helper = yield* acquireHelperServer(helperRequests);
      const appLayer = HttpRouter.serve(codexMcpOauthRoutesLayer, {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(
        Layer.provideMerge(makeServerAuthLayer()),
        Layer.provideMerge(makeMcpAuthLayer(helper.port, ttlMs)),
        Layer.provideMerge(FetchHttpClient.layer),
        Layer.provideMerge(
          NodeHttpServer.layer(NodeHttp.createServer, { host: "127.0.0.1", port: 0 }),
        ),
        Layer.provideMerge(NodeServices.layer),
      );

      return yield* Effect.gen(function* () {
        const server = yield* HttpServer.HttpServer;
        const address = server.address;
        if (typeof address === "string" || !("port" in address)) {
          return assert.fail(`Expected TCP address, got ${String(address)}`);
        }
        return yield* run({
          baseUrl: `http://127.0.0.1:${address.port}`,
          helperRequests,
        });
      }).pipe(Effect.provide(Layer.mergeAll(appLayer, FetchHttpClient.layer)));
    }),
  );

const postJson = (baseUrl: string, path: string, body: unknown, authenticated = true) =>
  Effect.flatMap(HttpClient.HttpClient, (client) =>
    client.execute(
      HttpClientRequest.post(`${baseUrl}${path}`).pipe(
        HttpClientRequest.setHeaders(
          authenticated
            ? { accept: "application/json", authorization: `Bearer ${bearer}` }
            : { accept: "application/json" },
        ),
        HttpClientRequest.bodyJsonUnsafe(body),
      ),
    ),
  );

const start = (baseUrl: string) =>
  postJson(baseUrl, "/api/gits/mcp/oauth/start", {
    providerInstanceId: "codex",
    serverName: "supabase",
  });

describe("Codex MCP OAuth HTTP routes", () => {
  it.effect("keeps capability and session controls on the authenticated GITS plane", () =>
    withApp(60_000, ({ baseUrl }) =>
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const unauthorized = yield* postJson(
          baseUrl,
          "/api/gits/mcp/oauth/start",
          { providerInstanceId: "codex", serverName: "supabase" },
          false,
        );
        assert.equal(unauthorized.status, 401);

        const capability = yield* client.execute(
          HttpClientRequest.get(`${baseUrl}/api/gits/mcp/oauth/capability`).pipe(
            HttpClientRequest.setHeader("authorization", `Bearer ${bearer}`),
          ),
        );
        assert.equal(capability.status, 200);
        assert.deepEqual(yield* capability.json, { available: true });

        const started = yield* start(baseUrl);
        if (started.status !== 200) {
          return assert.fail(`start failed (${started.status}): ${yield* started.text}`);
        }
        const result = (yield* started.json) as { sessionId: string; authorizationUrl: string };
        assert.equal(result.sessionId, "oauth-session-1");
        assert.match(result.authorizationUrl, /^https:\/\/auth\.example\.test\//u);

        const status = yield* client.execute(
          HttpClientRequest.get(
            `${baseUrl}/api/gits/mcp/oauth/status/${encodeURIComponent(result.sessionId)}`,
          ).pipe(HttpClientRequest.setHeader("authorization", `Bearer ${bearer}`)),
        );
        assert.equal(status.status, 200);
        assert.deepInclude(yield* status.json, { state: "waiting-provider" });

        const cancelled = yield* postJson(baseUrl, "/api/gits/mcp/oauth/cancel", {
          sessionId: result.sessionId,
        });
        assert.equal(cancelled.status, 204);
      }),
    ),
  );

  it.effect("rejects wrong IDs, states, methods, and oversized callback queries", () =>
    withApp(60_000, ({ baseUrl, helperRequests }) =>
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        yield* start(baseUrl);

        const wrongId = yield* client.execute(
          HttpClientRequest.get(
            `${baseUrl}/api/gits/mcp/oauth/callback/callback_wrong_identifier?state=${state}`,
          ),
        );
        assert.equal(wrongId.status, 400);

        const wrongState = yield* client.execute(
          HttpClientRequest.get(
            `${baseUrl}/api/gits/mcp/oauth/callback/${callbackId}?state=${"x".repeat(40)}`,
          ),
        );
        assert.equal(wrongState.status, 400);
        assert.equal(wrongState.headers["cache-control"], "no-store");
        assert.equal(wrongState.headers["referrer-policy"], "no-referrer");

        const wrongMethod = yield* client.execute(
          HttpClientRequest.post(
            `${baseUrl}/api/gits/mcp/oauth/callback/${callbackId}?state=${state}`,
          ),
        );
        assert.equal(wrongMethod.status, 404);

        const oversized = yield* client.execute(
          HttpClientRequest.get(
            `${baseUrl}/api/gits/mcp/oauth/callback/${callbackId}?state=${state}&code=${"a".repeat(
              8_200,
            )}`,
          ),
        );
        assert.equal(oversized.status, 400);
        assert.lengthOf(helperRequests, 0);
      }),
    ),
  );

  it.effect("expires callback leases", () =>
    withApp(10, ({ baseUrl, helperRequests }) =>
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        yield* start(baseUrl);
        yield* TestClock.adjust("30 millis");
        const expired = yield* client.execute(
          HttpClientRequest.get(
            `${baseUrl}/api/gits/mcp/oauth/callback/${callbackId}?state=${state}`,
          ),
        );
        assert.equal(expired.status, 400);
        assert.lengthOf(helperRequests, 0);
      }),
    ),
  );

  it.effect("forwards one bounded callback to fixed loopback without request credentials", () =>
    withApp(60_000, ({ baseUrl, helperRequests }) =>
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        yield* start(baseUrl);
        const callbackUrl = `${baseUrl}/api/gits/mcp/oauth/callback/${callbackId}?state=${state}&code=provider-code`;
        const response = yield* client.execute(
          HttpClientRequest.get(callbackUrl).pipe(
            HttpClientRequest.setHeaders({
              authorization: "Bearer browser-secret",
              cookie: "browser-secret=1",
              "x-forwarded-for": "203.0.113.10",
              "x-forwarded-host": "attacker.example",
            }),
          ),
        );
        if (response.status !== 200) {
          return assert.fail(`callback failed (${response.status}): ${yield* response.text}`);
        }
        assert.equal(yield* response.text, "<p>Authentication complete.</p>");
        assert.equal(response.headers["set-cookie"], undefined);
        assert.equal(response.headers["x-helper-secret"], undefined);
        assert.equal(response.headers["referrer-policy"], "no-referrer");

        assert.lengthOf(helperRequests, 1);
        const forwarded = helperRequests[0];
        assert.isDefined(forwarded);
        assert.equal(
          forwarded?.url,
          `/api/gits/mcp/oauth/callback/${callbackId}?state=${state}&code=provider-code`,
        );
        assert.equal(forwarded?.headers.authorization, undefined);
        assert.equal(forwarded?.headers.cookie, undefined);
        assert.equal(forwarded?.headers["x-forwarded-for"], undefined);
        assert.equal(forwarded?.headers["x-forwarded-host"], undefined);

        const replay = yield* client.execute(HttpClientRequest.get(callbackUrl));
        assert.equal(replay.status, 400);
        assert.lengthOf(helperRequests, 1);
      }),
    ),
  );
});
