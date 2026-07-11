import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { PushNotificationService } from "../Services/PushNotificationService.ts";

export const PushNotificationReactorLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const orchestrationEngine = yield* OrchestrationEngineService;
    const pushNotifications = yield* PushNotificationService;
    const domainEvents = yield* orchestrationEngine.subscribeDomainEvents;

    yield* Stream.runForEach(Stream.fromSubscription(domainEvents), (event) =>
      pushNotifications.sendForOrchestrationEvent(event).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("web push notification reactor failed", {
            eventType: event.type,
            sequence: event.sequence,
            cause,
          }),
        ),
      ),
    ).pipe(Effect.forkScoped);
  }),
);
