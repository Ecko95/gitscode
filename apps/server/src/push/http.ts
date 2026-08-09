import { randomUUID } from "node:crypto";

import {
  WebPushPublicConfig,
  WebPushRegisterInput,
  WebPushTestInput,
  type WebPushTestKind,
  type WebPushTestResult,
  WebPushUnregisterInput,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { AuthError, ServerAuth } from "../auth/Services/ServerAuth.ts";
import { respondToAuthError } from "../auth/http.ts";
import { ServerConfig } from "../config.ts";
import { browserApiCorsHeaders } from "../httpCors.ts";
import { WebPushSubscriptionRepository } from "../persistence/Services/WebPushSubscriptions.ts";
import {
  type PushNotificationPayload,
  PushNotificationService,
} from "./Services/PushNotificationService.ts";

export const TEST_PUSH_PAYLOADS = {
  delivery: {
    title: "GITS notification test",
    body: "Android PWA delivery is working. Tap to confirm.",
    url: "/gits?panel=autopilot&notificationTest=delivery",
  },
  proposal: {
    title: "Test proposal ready",
    body: "Tap to test the guided proposal launch.",
    url: "/gits?panel=autopilot&notificationTest=proposal",
  },
} satisfies Record<WebPushTestKind, Omit<PushNotificationPayload, "tag">>;

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

export const pushTestRouteLayer = HttpRouter.add(
  "POST",
  "/api/push/test",
  Effect.gen(function* () {
    yield* authenticatePushSession;
    const input = yield* HttpServerRequest.schemaBodyJson(WebPushTestInput).pipe(
      Effect.mapError(
        (cause) =>
          new AuthError({
            message: "Invalid web push test payload.",
            status: 400,
            cause,
          }),
      ),
    );
    const service = yield* Effect.serviceOption(PushNotificationService);
    const fixed = TEST_PUSH_PAYLOADS[input.kind];
    const result = yield* Option.match(service, {
      onNone: () => Effect.succeed("disabled" as const),
      onSome: (available) =>
        available.sendToEndpoint(input.endpoint, {
          ...fixed,
          tag: `gits:test:${input.kind}:${randomUUID()}`,
        }),
    });
    if (result === "sent") {
      return HttpServerResponse.jsonUnsafe(
        { accepted: true, url: fixed.url } satisfies WebPushTestResult,
        { status: 200, headers: browserApiCorsHeaders },
      );
    }
    const [status, error] =
      result === "disabled"
        ? [503, "Web push is not configured."]
        : result === "not-found"
          ? [404, "This device subscription is not registered."]
          : [502, "The push provider rejected the test notification."];
    return HttpServerResponse.jsonUnsafe({ error }, { status, headers: browserApiCorsHeaders });
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);
