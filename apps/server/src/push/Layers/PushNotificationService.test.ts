import {
  CheckpointRef,
  CommandId,
  EnvironmentId,
  EventId,
  type ExecutionEnvironmentDescriptor,
  type OrchestrationEvent,
  ThreadId,
  TurnId,
  type WebPushSubscription,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerConfig, type ServerConfigShape } from "../../config.ts";
import { ServerEnvironment } from "../../environment/Services/ServerEnvironment.ts";
import {
  type PersistedWebPushSubscription,
  WebPushSubscriptionRepository,
} from "../../persistence/Services/WebPushSubscriptions.ts";
import { WebPushSendError, WebPushSender } from "../Services/WebPushSender.ts";
import { PushNotificationService } from "../Services/PushNotificationService.ts";
import {
  derivePushAttentionEvent,
  PushNotificationServiceLive,
} from "./PushNotificationService.ts";

const now = "2026-01-01T00:00:00.000Z";

const makeSubscription = (endpoint: string): WebPushSubscription => ({
  endpoint,
  expirationTime: null,
  keys: {
    p256dh: "p256dh",
    auth: "auth",
  },
});

const persisted = (subscription: WebPushSubscription): PersistedWebPushSubscription => ({
  subscription,
  userAgent: "vitest",
  createdAt: now,
  updatedAt: now,
});

const configLayer = Layer.succeed(ServerConfig, {
  vapidPublicKey: "public-key",
  vapidPrivateKey: "private-key",
  vapidSubject: "mailto:operator@example.com",
} as ServerConfigShape);

const testEnvironmentDescriptor = {
  environmentId: EnvironmentId.make("env-1"),
  label: "GITS",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "0.0.0-test",
  capabilities: { repositoryIdentity: true, ports: true },
} satisfies ExecutionEnvironmentDescriptor;

const environmentLayer = Layer.succeed(ServerEnvironment, {
  getEnvironmentId: Effect.succeed(EnvironmentId.make("env-1")),
  getDescriptor: Effect.succeed(testEnvironmentDescriptor),
});

const turnCompletedEvent = {
  type: "thread.turn-diff-completed",
  eventId: EventId.make("evt-1"),
  sequence: 1,
  aggregateKind: "thread",
  aggregateId: ThreadId.make("thread-1"),
  occurredAt: now,
  commandId: CommandId.make("cmd-1"),
  causationEventId: null,
  correlationId: CommandId.make("cmd-1"),
  metadata: {},
  payload: {
    threadId: ThreadId.make("thread-1"),
    turnId: TurnId.make("turn-1"),
    checkpointTurnCount: 1,
    checkpointRef: CheckpointRef.make("checkpoint-1"),
    status: "ready",
    files: [],
    assistantMessageId: null,
    completedAt: now,
  },
} satisfies OrchestrationEvent;

const approvalEvent = {
  type: "thread.activity-appended",
  eventId: EventId.make("evt-2"),
  sequence: 2,
  aggregateKind: "thread",
  aggregateId: ThreadId.make("thread-1"),
  occurredAt: now,
  commandId: CommandId.make("cmd-2"),
  causationEventId: null,
  correlationId: CommandId.make("cmd-2"),
  metadata: {},
  payload: {
    threadId: ThreadId.make("thread-1"),
    activity: {
      id: EventId.make("activity-1"),
      tone: "approval",
      kind: "approval.requested",
      summary: "Command approval requested",
      payload: { requestId: "approval-1" },
      turnId: TurnId.make("turn-1"),
      createdAt: now,
    },
  },
} satisfies OrchestrationEvent;

it.effect("derives attention events from turn completion and approval requests", () =>
  Effect.sync(() => {
    assert.deepStrictEqual(derivePushAttentionEvent(turnCompletedEvent), {
      kind: "turn",
      threadId: ThreadId.make("thread-1"),
      tagSeed: "turn-1:2026-01-01T00:00:00.000Z",
    });
    assert.deepStrictEqual(derivePushAttentionEvent(approvalEvent), {
      kind: "approval",
      threadId: ThreadId.make("thread-1"),
      tagSeed: "approval-1",
    });
  }),
);

it.effect("sends configured push notifications and removes expired subscriptions", () => {
  const active = makeSubscription("https://push.example.test/active");
  const expired = makeSubscription("https://push.example.test/expired");
  const sentEndpoints: Array<string> = [];
  const deletedEndpoints: Array<string> = [];

  const layer = PushNotificationServiceLive.pipe(
    Layer.provide(configLayer),
    Layer.provide(environmentLayer),
    Layer.provide(
      Layer.succeed(WebPushSubscriptionRepository, {
        upsert: () => Effect.void,
        deleteByEndpoint: (endpoint) =>
          Effect.sync(() => {
            deletedEndpoints.push(endpoint);
          }),
        list: () => Effect.succeed([persisted(active), persisted(expired)]),
      }),
    ),
    Layer.provide(
      Layer.succeed(WebPushSender, {
        send: (subscription) =>
          Effect.sync(() => {
            sentEndpoints.push(subscription.endpoint);
          }).pipe(
            Effect.flatMap(() =>
              subscription.endpoint === expired.endpoint
                ? Effect.fail(
                    new WebPushSendError({
                      endpoint: subscription.endpoint,
                      statusCode: 410,
                    }),
                  )
                : Effect.void,
            ),
          ),
      }),
    ),
  );

  return Effect.gen(function* () {
    const service = yield* PushNotificationService;
    yield* service.sendForOrchestrationEvent(approvalEvent);

    assert.deepStrictEqual(sentEndpoints.sort(), [active.endpoint, expired.endpoint].sort());
    assert.deepStrictEqual(deletedEndpoints, [expired.endpoint]);
  }).pipe(Effect.provide(layer));
});

it.effect("sends a test only to the exact registered endpoint", () => {
  const active = makeSubscription("https://push.example.test/active");
  const other = makeSubscription("https://push.example.test/other");
  const sentEndpoints: Array<string> = [];
  const layer = PushNotificationServiceLive.pipe(
    Layer.provide(configLayer),
    Layer.provide(environmentLayer),
    Layer.provide(
      Layer.succeed(WebPushSubscriptionRepository, {
        upsert: () => Effect.void,
        deleteByEndpoint: () => Effect.void,
        list: () => Effect.succeed([persisted(active), persisted(other)]),
      }),
    ),
    Layer.provide(
      Layer.succeed(WebPushSender, {
        send: (subscription) =>
          Effect.sync(() => {
            sentEndpoints.push(subscription.endpoint);
          }),
      }),
    ),
  );

  return Effect.gen(function* () {
    const service = yield* PushNotificationService;
    const payload = { title: "Test", body: "Body", tag: "test-1", url: "/gits" };
    assert.strictEqual(yield* service.sendToEndpoint(active.endpoint, payload), "sent");
    assert.strictEqual(yield* service.sendToEndpoint("https://push.example.test/missing", payload), "not-found");
    assert.deepStrictEqual(sentEndpoints, [active.endpoint]);
  }).pipe(Effect.provide(layer));
});

it.effect("reports disabled and failed targeted delivery and deletes expired endpoints", () => {
  const expired = makeSubscription("https://push.example.test/expired");
  const deletedEndpoints: Array<string> = [];
  const repositoryLayer = Layer.succeed(WebPushSubscriptionRepository, {
    upsert: () => Effect.void,
    deleteByEndpoint: (endpoint: string) =>
      Effect.sync(() => {
        deletedEndpoints.push(endpoint);
      }),
    list: () => Effect.succeed([persisted(expired)]),
  });
  const senderLayer = Layer.succeed(WebPushSender, {
    send: () =>
      Effect.fail(new WebPushSendError({ endpoint: expired.endpoint, statusCode: 410 })),
  });
  const payload = { title: "Test", body: "Body", tag: "test-2", url: "/gits" };

  return Effect.gen(function* () {
    const configuredService = yield* PushNotificationService;
    assert.strictEqual(yield* configuredService.sendToEndpoint(expired.endpoint, payload), "failed");
    assert.deepStrictEqual(deletedEndpoints, [expired.endpoint]);

  }).pipe(
    Effect.provide(
      PushNotificationServiceLive.pipe(
        Layer.provide(configLayer),
        Layer.provide(environmentLayer),
        Layer.provide(repositoryLayer),
        Layer.provide(senderLayer),
      ),
    ),
  );
});

it.effect("reports targeted delivery as disabled without VAPID configuration", () => {
  const subscription = makeSubscription("https://push.example.test/device");
  const layer = PushNotificationServiceLive.pipe(
    Layer.provide(
      Layer.succeed(ServerConfig, {
        vapidPublicKey: undefined,
        vapidPrivateKey: undefined,
        vapidSubject: undefined,
      } as ServerConfigShape),
    ),
    Layer.provide(environmentLayer),
    Layer.provide(
      Layer.succeed(WebPushSubscriptionRepository, {
        upsert: () => Effect.void,
        deleteByEndpoint: () => Effect.void,
        list: () => Effect.succeed([persisted(subscription)]),
      }),
    ),
    Layer.provide(Layer.succeed(WebPushSender, { send: () => Effect.void })),
  );

  return Effect.gen(function* () {
    const service = yield* PushNotificationService;
    assert.strictEqual(
      yield* service.sendToEndpoint(subscription.endpoint, {
        title: "Test",
        body: "Body",
        tag: "test-3",
        url: "/gits",
      }),
      "disabled",
    );
  }).pipe(Effect.provide(layer));
});
