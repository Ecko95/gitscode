import { AuthSessionId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerRequest } from "effect/unstable/http";

import { ServerAuth, type AuthenticatedSession } from "../auth/Services/ServerAuth.ts";
import {
  type PushNotificationPayload,
  PushNotificationService,
  type TargetedPushResult,
} from "./Services/PushNotificationService.ts";
import { pushTestRouteLayer } from "./http.ts";

const session = (role: AuthenticatedSession["role"]): AuthenticatedSession => ({
  sessionId: AuthSessionId.make(`session-${role}`),
  subject: role,
  method: "bearer-session-token",
  role,
});

const execute = (
  role: AuthenticatedSession["role"],
  body: unknown,
  result: TargetedPushResult,
  sent: Array<{ readonly endpoint: string; readonly payload: PushNotificationPayload }>,
) => {
  const request = HttpServerRequest.fromWeb(
    new Request("http://localhost/api/push/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  const dependencies = Layer.mergeAll(
    Layer.mock(ServerAuth)({
      authenticateHttpRequest: () => Effect.succeed(session(role)),
    }),
    Layer.mock(PushNotificationService)({
      getPublicConfig: () => ({ enabled: true, publicKey: "test" }),
      sendToAll: () => Effect.void,
      sendToEndpoint: (endpoint, payload) =>
        Effect.sync(() => {
          sent.push({ endpoint, payload });
          return result;
        }),
      sendForOrchestrationEvent: () => Effect.void,
    }),
  );
  return Effect.scoped(
    HttpRouter.toHttpEffect(pushTestRouteLayer).pipe(
      Effect.flatMap((handler) => handler),
      Effect.provideService(HttpServerRequest.HttpServerRequest, request),
      Effect.provide(dependencies),
    ),
  );
};

it.effect("push test route uses fixed server payload and a unique test tag", () =>
  Effect.gen(function* () {
    const sent: Array<{ readonly endpoint: string; readonly payload: PushNotificationPayload }> = [];
    const response = yield* execute(
      "owner",
      {
        endpoint: "https://push.example/device",
        kind: "proposal",
        title: "Caller title",
        body: "Caller body",
        url: "https://evil.example",
      },
      "sent",
      sent,
    );

    assert.equal(response.status, 200);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.endpoint, "https://push.example/device");
    assert.equal(sent[0]!.payload.title, "Test proposal ready");
    assert.equal(sent[0]!.payload.body, "Tap to test the guided proposal launch.");
    assert.equal(
      sent[0]!.payload.url,
      "/gits?panel=autopilot&notificationTest=proposal",
    );
    assert.match(sent[0]!.payload.tag, /^gits:test:proposal:/);
  }),
);

it.effect("push test route rejects thread-scoped sessions before sending", () =>
  Effect.gen(function* () {
    const sent: Array<{ readonly endpoint: string; readonly payload: PushNotificationPayload }> = [];
    const response = yield* execute(
      "thread-scoped",
      { endpoint: "https://push.example/device", kind: "delivery" },
      "sent",
      sent,
    );
    assert.equal(response.status, 403);
    assert.equal(sent.length, 0);
  }),
);

it.effect("push test route maps closed delivery results", () =>
  Effect.gen(function* () {
    for (const [result, status] of [
      ["disabled", 503],
      ["not-found", 404],
      ["failed", 502],
    ] as const) {
      const response = yield* execute(
        "owner",
        { endpoint: "https://push.example/device", kind: "delivery" },
        result,
        [],
      );
      assert.equal(response.status, status);
    }
  }),
);
