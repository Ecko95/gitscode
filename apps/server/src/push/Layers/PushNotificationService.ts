import type { OrchestrationEvent, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerConfig } from "../../config.ts";
import { ServerEnvironment } from "../../environment/Services/ServerEnvironment.ts";
import { WebPushSubscriptionRepository } from "../../persistence/Services/WebPushSubscriptions.ts";
import { WebPushSendError, WebPushSender } from "../Services/WebPushSender.ts";
import {
  type DerivedPushAttentionEvent,
  type PushAttentionEventKind,
  type PushNotificationPayload,
  PushNotificationService,
  type PushNotificationServiceShape,
} from "../Services/PushNotificationService.ts";

function activityRequestId(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const requestId = (payload as { readonly requestId?: unknown }).requestId;
  return typeof requestId === "string" ? requestId : null;
}

export function derivePushAttentionEvent(
  event: OrchestrationEvent,
): DerivedPushAttentionEvent | null {
  if (event.type === "thread.turn-diff-completed") {
    return {
      kind: "turn",
      threadId: event.payload.threadId,
      tagSeed: `${event.payload.turnId}:${event.payload.completedAt}`,
    };
  }

  if (event.type !== "thread.activity-appended") {
    return null;
  }

  const activity = event.payload.activity;
  if (activity.kind === "approval.requested") {
    return {
      kind: "approval",
      threadId: event.payload.threadId,
      tagSeed: activityRequestId(activity.payload) ?? activity.id,
    };
  }
  if (activity.kind === "user-input.requested") {
    return {
      kind: "input",
      threadId: event.payload.threadId,
      tagSeed: activityRequestId(activity.payload) ?? activity.id,
    };
  }
  return null;
}

function summarizeNotification(kind: PushAttentionEventKind, title: string) {
  switch (kind) {
    case "approval":
      return { title: "Approval needed", body: title };
    case "input":
      return { title: "Input needed", body: title };
    case "turn":
      return { title: "Turn completed", body: title };
  }
}

function isExpiredSubscriptionError(error: WebPushSendError): boolean {
  return error.statusCode === 404 || error.statusCode === 410;
}

function threadUrl(environmentId: string, threadId: ThreadId): string {
  return `/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`;
}

const makePushNotificationService = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const repository = yield* WebPushSubscriptionRepository;
  const sender = yield* WebPushSender;
  const serverEnvironment = yield* ServerEnvironment;

  const configured =
    Boolean(config.vapidPublicKey) &&
    Boolean(config.vapidPrivateKey) &&
    Boolean(config.vapidSubject);

  const getPublicConfig: PushNotificationServiceShape["getPublicConfig"] = () => ({
    enabled: configured,
    publicKey: configured ? (config.vapidPublicKey ?? null) : null,
  });

  const sendToAll: PushNotificationServiceShape["sendToAll"] = (payload) => {
    if (!configured) {
      return Effect.void;
    }

    return Effect.gen(function* () {
      const subscriptions = yield* repository
        .list()
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning("failed to list web push subscriptions", { cause }).pipe(
              Effect.as([]),
            ),
          ),
        );
      // Serialize the known notification payload to the wire string the push
      // service delivers; not a persisted/decoded shape.
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const body = JSON.stringify(payload);

      yield* Effect.forEach(
        subscriptions,
        (entry) =>
          sender.send(entry.subscription, body).pipe(
            Effect.catchTag("WebPushSendError", (error) =>
              isExpiredSubscriptionError(error)
                ? repository.deleteByEndpoint(entry.subscription.endpoint).pipe(Effect.ignore)
                : Effect.logWarning("failed to send web push notification", {
                    endpoint: entry.subscription.endpoint,
                    statusCode: error.statusCode,
                    cause: error.cause,
                  }),
            ),
          ),
        { concurrency: 8 },
      );
    });
  };

  const sendForOrchestrationEvent: PushNotificationServiceShape["sendForOrchestrationEvent"] = (
    event,
  ) => {
    const attention = derivePushAttentionEvent(event);
    if (attention === null) {
      return Effect.void;
    }

    return Effect.gen(function* () {
      const environment = yield* serverEnvironment.getDescriptor.pipe(
        Effect.catch((cause) =>
          Effect.logWarning("failed to prepare web push notification", {
            eventType: event.type,
            threadId: attention.threadId,
            cause,
          }).pipe(Effect.as(null)),
        ),
      );
      if (environment === null) {
        return;
      }

      // ponytail: avoid a projection lookup in the hot event reactor; the deep link
      // still lands on the exact thread, and open clients keep rich local titles.
      const summary = summarizeNotification(attention.kind, `Thread ${attention.threadId}`);
      const payload: PushNotificationPayload = {
        ...summary,
        tag: `gits:${attention.kind}:${environment.environmentId}:${attention.threadId}:${attention.tagSeed}`,
        url: threadUrl(environment.environmentId, attention.threadId),
      };
      yield* sendToAll(payload);
    });
  };

  return {
    getPublicConfig,
    sendToAll,
    sendForOrchestrationEvent,
  };
});

export const PushNotificationServiceLive = Layer.effect(
  PushNotificationService,
  makePushNotificationService,
);
