import type { OrchestrationEvent, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export type PushAttentionEventKind = "approval" | "input" | "turn";

export interface PushNotificationPayload {
  readonly title: string;
  readonly body: string;
  readonly tag: string;
  readonly url: string;
}

export interface PushNotificationServiceShape {
  readonly getPublicConfig: () => {
    readonly enabled: boolean;
    readonly publicKey: string | null;
  };
  readonly sendToAll: (payload: PushNotificationPayload) => Effect.Effect<void>;
  readonly sendForOrchestrationEvent: (event: OrchestrationEvent) => Effect.Effect<void>;
}

export interface DerivedPushAttentionEvent {
  readonly kind: PushAttentionEventKind;
  readonly threadId: ThreadId;
  readonly tagSeed: string;
}

export class PushNotificationService extends Context.Service<
  PushNotificationService,
  PushNotificationServiceShape
>()("t3/push/Services/PushNotificationService") {}
