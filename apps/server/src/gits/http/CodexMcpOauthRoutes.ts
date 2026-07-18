import { GitsCodexMcpAuthSessionInput, GitsCodexMcpAuthStartInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";

import { respondToAuthError } from "../../auth/http.ts";
import { browserApiCorsHeaders } from "../../httpCors.ts";
import { authenticateGitsSession } from "../http.ts";
import { CodexMcpAuth, CodexMcpAuthError } from "../Services/CodexMcpAuth.ts";

const CallbackPathParams = Schema.Struct({ callbackId: Schema.String });

const invalidRequest = () =>
  new CodexMcpAuthError({
    code: "invalid-request",
    message: "Invalid MCP authentication request.",
  });

const authErrorStatus = (error: CodexMcpAuthError): 400 | 404 | 409 | 502 | 503 => {
  switch (error.code) {
    case "not-found":
    case "provider-unavailable":
      return 404;
    case "already-active":
      return 409;
    case "provider-failed":
      return 502;
    case "relay-unavailable":
      return 503;
    case "invalid-request":
    case "invalid-authorization-response":
    case "invalid-callback":
      return 400;
  }
};

const respondToMcpAuthError = (error: CodexMcpAuthError) =>
  Effect.succeed(
    HttpServerResponse.jsonUnsafe(
      { error: error.message },
      { status: authErrorStatus(error), headers: browserApiCorsHeaders },
    ),
  );

const callbackResponseHeaders = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
} as const;

const respondToCallbackError = () =>
  Effect.succeed(
    HttpServerResponse.jsonUnsafe(
      { error: "OAuth callback was rejected." },
      { status: 400, headers: callbackResponseHeaders },
    ),
  );

export const codexMcpOauthCapabilityRouteLayer = HttpRouter.add(
  "GET",
  "/api/gits/mcp/oauth/capability",
  Effect.gen(function* () {
    yield* authenticateGitsSession;
    const auth = yield* CodexMcpAuth;
    return HttpServerResponse.jsonUnsafe(yield* auth.getAvailability(), {
      status: 200,
      headers: browserApiCorsHeaders,
    });
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

export const codexMcpOauthStartRouteLayer = HttpRouter.add(
  "POST",
  "/api/gits/mcp/oauth/start",
  Effect.gen(function* () {
    const session = yield* authenticateGitsSession;
    const input = yield* HttpServerRequest.schemaBodyJson(GitsCodexMcpAuthStartInput).pipe(
      Effect.mapError(invalidRequest),
    );
    const auth = yield* CodexMcpAuth;
    const result = yield* auth.start({ ...input, connectionId: session.sessionId });
    return HttpServerResponse.jsonUnsafe(result, {
      status: 200,
      headers: browserApiCorsHeaders,
    });
  }).pipe(
    Effect.catchTags({
      AuthError: respondToAuthError,
      CodexMcpAuthError: respondToMcpAuthError,
    }),
  ),
);

export const codexMcpOauthStatusRouteLayer = HttpRouter.add(
  "GET",
  "/api/gits/mcp/oauth/status/:sessionId",
  Effect.gen(function* () {
    const session = yield* authenticateGitsSession;
    const input = yield* HttpRouter.schemaPathParams(GitsCodexMcpAuthSessionInput).pipe(
      Effect.mapError(invalidRequest),
    );
    const auth = yield* CodexMcpAuth;
    const status = yield* auth.getStatus({ ...input, connectionId: session.sessionId });
    return HttpServerResponse.jsonUnsafe(status, {
      status: 200,
      headers: browserApiCorsHeaders,
    });
  }).pipe(
    Effect.catchTags({
      AuthError: respondToAuthError,
      CodexMcpAuthError: respondToMcpAuthError,
    }),
  ),
);

export const codexMcpOauthCancelRouteLayer = HttpRouter.add(
  "POST",
  "/api/gits/mcp/oauth/cancel",
  Effect.gen(function* () {
    const session = yield* authenticateGitsSession;
    const input = yield* HttpServerRequest.schemaBodyJson(GitsCodexMcpAuthSessionInput).pipe(
      Effect.mapError(invalidRequest),
    );
    const auth = yield* CodexMcpAuth;
    yield* auth.cancel({ ...input, connectionId: session.sessionId });
    return HttpServerResponse.empty({ status: 204, headers: browserApiCorsHeaders });
  }).pipe(
    Effect.catchTags({
      AuthError: respondToAuthError,
      CodexMcpAuthError: respondToMcpAuthError,
    }),
  ),
);

export const codexMcpOauthCallbackRouteLayer = HttpRouter.add(
  "GET",
  "/api/gits/mcp/oauth/callback/:callbackId",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    const path = yield* HttpRouter.schemaPathParams(CallbackPathParams).pipe(Effect.option);
    if (Option.isNone(url) || Option.isNone(path)) {
      return yield* invalidRequest();
    }
    const states = url.value.searchParams.getAll("state");
    const queryStart = request.url.indexOf("?");
    const rawQuery = queryStart >= 0 ? request.url.slice(queryStart + 1) : "";
    if (states.length !== 1) {
      return yield* new CodexMcpAuthError({
        code: "invalid-callback",
        message: "OAuth callback was rejected.",
      });
    }

    const auth = yield* CodexMcpAuth;
    const handoff = yield* auth.handleCallback({
      callbackId: path.value.callbackId,
      state: states[0] ?? "",
      rawQuery,
    });
    const client = yield* HttpClient.HttpClient;
    const upstream = yield* client
      .execute(
        HttpClientRequest.get(`http://127.0.0.1:${handoff.localPort}${handoff.pathAndQuery}`),
      )
      .pipe(Effect.option);
    if (Option.isNone(upstream)) {
      return HttpServerResponse.text("OAuth callback relay failed.", {
        status: 502,
        headers: callbackResponseHeaders,
      });
    }
    const body = yield* upstream.value.arrayBuffer.pipe(Effect.option);
    if (Option.isNone(body)) {
      return HttpServerResponse.text("OAuth callback relay failed.", {
        status: 502,
        headers: callbackResponseHeaders,
      });
    }
    return HttpServerResponse.uint8Array(new Uint8Array(body.value), {
      status: upstream.value.status,
      ...(upstream.value.headers["content-type"]
        ? { contentType: upstream.value.headers["content-type"] }
        : {}),
      headers: {
        ...callbackResponseHeaders,
        "X-Content-Type-Options": "nosniff",
      },
    });
  }).pipe(Effect.catchTag("CodexMcpAuthError", respondToCallbackError)),
);

export const codexMcpOauthRoutesLayer = Layer.mergeAll(
  codexMcpOauthCapabilityRouteLayer,
  codexMcpOauthStartRouteLayer,
  codexMcpOauthStatusRouteLayer,
  codexMcpOauthCancelRouteLayer,
  codexMcpOauthCallbackRouteLayer,
);
