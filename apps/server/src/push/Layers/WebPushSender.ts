import type { WebPushSubscription } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import webPush from "web-push";

import { ServerConfig } from "../../config.ts";
import { WebPushSendError, WebPushSender } from "../Services/WebPushSender.ts";

function readStatusCode(cause: unknown): number | undefined {
  if (typeof cause !== "object" || cause === null) {
    return undefined;
  }
  const statusCode = (cause as { readonly statusCode?: unknown }).statusCode;
  return typeof statusCode === "number" ? statusCode : undefined;
}

const makeWebPushSender = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const configured =
    Boolean(config.vapidPublicKey) &&
    Boolean(config.vapidPrivateKey) &&
    Boolean(config.vapidSubject);

  if (configured) {
    webPush.setVapidDetails(config.vapidSubject!, config.vapidPublicKey!, config.vapidPrivateKey!);
  }

  return {
    send: (subscription: WebPushSubscription, payload: string) => {
      if (!configured) {
        return Effect.void;
      }

      return Effect.tryPromise({
        try: () => webPush.sendNotification(subscription, payload).then(() => undefined),
        catch: (cause) =>
          new WebPushSendError({
            endpoint: subscription.endpoint,
            statusCode: readStatusCode(cause),
            cause,
          }),
      });
    },
  };
});

export const WebPushSenderLive = Layer.effect(WebPushSender, makeWebPushSender);
