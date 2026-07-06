import type { WebPushSubscription } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { WebPushSubscriptionRepositoryError } from "../Errors.ts";

export interface PersistedWebPushSubscription {
  readonly subscription: WebPushSubscription;
  readonly userAgent: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WebPushSubscriptionRepositoryShape {
  readonly upsert: (input: {
    readonly subscription: WebPushSubscription;
    readonly userAgent: string | null;
    readonly now: string;
  }) => Effect.Effect<void, WebPushSubscriptionRepositoryError>;
  readonly deleteByEndpoint: (
    endpoint: string,
  ) => Effect.Effect<void, WebPushSubscriptionRepositoryError>;
  readonly list: () => Effect.Effect<
    ReadonlyArray<PersistedWebPushSubscription>,
    WebPushSubscriptionRepositoryError
  >;
}

export class WebPushSubscriptionRepository extends Context.Service<
  WebPushSubscriptionRepository,
  WebPushSubscriptionRepositoryShape
>()("t3/persistence/Services/WebPushSubscriptionRepository") {}
