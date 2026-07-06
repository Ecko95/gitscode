import {
  WebPushPublicConfig,
  WebPushRegisterInput,
  WebPushUnregisterInput,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { AuthError, ServerAuth } from "../auth/Services/ServerAuth.ts";
import { respondToAuthError } from "../auth/http.ts";
import { ServerConfig } from "../config.ts";
import { browserApiCorsHeaders } from "../httpCors.ts";
import { WebPushSubscriptionRepository } from "../persistence/Services/WebPushSubscriptions.ts";

const authenticatePushSession = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const serverAuth = yield* ServerAuth;
  const session = yield* serverAuth.authenticateHttpRequest(request);
  if (session.role === "thread-scoped") {
    return yield* new AuthError({
      message: "Thread-scoped sessions cannot manage web push subscriptions.",
      status: 403,
    });
  }
  return session;
});

export const pushPublicConfigRouteLayer = HttpRouter.add(
  "GET",
  "/api/push/config",
  Effect.gen(function* () {
    yield* authenticatePushSession;
    const config = yield* ServerConfig;
    const enabled =
      Boolean(config.vapidPublicKey) &&
      Boolean(config.vapidPrivateKey) &&
      Boolean(config.vapidSubject);
    return HttpServerResponse.jsonUnsafe(
      {
        enabled,
        publicKey: enabled ? (config.vapidPublicKey ?? null) : null,
      } satisfies WebPushPublicConfig,
      {
        status: 200,
        headers: browserApiCorsHeaders,
      },
    );
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

export const pushRegisterRouteLayer = HttpRouter.add(
  "POST",
  "/api/push/subscriptions",
  Effect.gen(function* () {
    yield* authenticatePushSession;
    const payload = yield* HttpServerRequest.schemaBodyJson(WebPushRegisterInput).pipe(
      Effect.mapError(
        (cause) =>
          new AuthError({
            message: "Invalid web push subscription payload.",
            status: 400,
            cause,
          }),
      ),
    );
    const repository = yield* WebPushSubscriptionRepository;
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* repository.upsert({
      subscription: payload.subscription,
      userAgent: payload.userAgent ?? null,
      now,
    });
    return HttpServerResponse.empty({ status: 204, headers: browserApiCorsHeaders });
  }).pipe(
    Effect.catchTags({
      AuthError: respondToAuthError,
      PersistenceSqlError: (error) =>
        Effect.logError("web push registration failed", { cause: error }).pipe(
          Effect.as(
            HttpServerResponse.jsonUnsafe(
              { error: "Failed to persist web push subscription." },
              { status: 500, headers: browserApiCorsHeaders },
            ),
          ),
        ),
      PersistenceDecodeError: (error) =>
        Effect.logError("web push registration decode failed", { cause: error }).pipe(
          Effect.as(
            HttpServerResponse.jsonUnsafe(
              { error: "Invalid web push subscription." },
              { status: 400, headers: browserApiCorsHeaders },
            ),
          ),
        ),
    }),
  ),
);

export const pushUnregisterRouteLayer = HttpRouter.add(
  "POST",
  "/api/push/subscriptions/delete",
  Effect.gen(function* () {
    yield* authenticatePushSession;
    const payload = yield* HttpServerRequest.schemaBodyJson(WebPushUnregisterInput).pipe(
      Effect.mapError(
        (cause) =>
          new AuthError({
            message: "Invalid web push unsubscribe payload.",
            status: 400,
            cause,
          }),
      ),
    );
    const repository = yield* WebPushSubscriptionRepository;
    yield* repository.deleteByEndpoint(payload.endpoint);
    return HttpServerResponse.empty({ status: 204, headers: browserApiCorsHeaders });
  }).pipe(
    Effect.catchTags({
      AuthError: respondToAuthError,
      PersistenceSqlError: (error) =>
        Effect.logError("web push unregistration failed", { cause: error }).pipe(
          Effect.as(
            HttpServerResponse.jsonUnsafe(
              { error: "Failed to delete web push subscription." },
              { status: 500, headers: browserApiCorsHeaders },
            ),
          ),
        ),
      PersistenceDecodeError: (error) =>
        Effect.logError("web push unregistration decode failed", { cause: error }).pipe(
          Effect.as(
            HttpServerResponse.jsonUnsafe(
              { error: "Invalid web push unsubscribe payload." },
              { status: 400, headers: browserApiCorsHeaders },
            ),
          ),
        ),
    }),
  ),
);
