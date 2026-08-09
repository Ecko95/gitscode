import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { writeFileStringAtomically } from "../../atomicWrite.ts";
import { ServerConfig } from "../../config.ts";
import { PushNotificationService } from "../../push/Services/PushNotificationService.ts";
import { HermesTelegramNotifier } from "../Services/HermesTelegramNotifier.ts";

export interface AutomodeNotificationInput {
  readonly key: string;
  readonly subject: string;
  readonly text: string;
  readonly url: string;
  readonly gitsEnabled: boolean;
  readonly telegramEnabled: boolean;
}

export function deliverAutomodeNotification<E1, R1, E2, R2>(
  input: AutomodeNotificationInput,
  dependencies: {
    readonly delivered: Set<string>;
    readonly push: (url: string) => Effect.Effect<void, E1, R1>;
    readonly telegram: (text: string) => Effect.Effect<void, E2, R2>;
  },
): Effect.Effect<void, never, R1 | R2> {
  const deliver = <E, R>(
    channel: "gits" | "telegram",
    enabled: boolean,
    effect: Effect.Effect<void, E, R>,
  ) => {
    const key = `${channel}:${input.key}`;
    if (!enabled || dependencies.delivered.has(key)) return Effect.void;
    return effect.pipe(
      Effect.tap(() => Effect.sync(() => dependencies.delivered.add(key))),
      Effect.ignoreCause({ log: true }),
    );
  };

  return Effect.all([
    deliver("gits", input.gitsEnabled, dependencies.push(input.url)),
    deliver("telegram", input.telegramEnabled, dependencies.telegram(input.text)),
  ]).pipe(Effect.asVoid);
}

export interface AutomodeNotificationsShape {
  readonly notify: (input: AutomodeNotificationInput) => Effect.Effect<void>;
}

const decodeDeliveredKeys = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);

export class AutomodeNotifications extends Context.Service<
  AutomodeNotifications,
  AutomodeNotificationsShape
>()("t3/gits/Layers/AutomodeNotifications") {}

export const AutomodeNotificationsLive = Layer.effect(
  AutomodeNotifications,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const push = yield* PushNotificationService;
    const telegram = yield* HermesTelegramNotifier;
    const statePath = path.join(config.stateDir, "gits", "automode-notifications-state.json");
    const delivered = new Set<string>(
      yield* fs.readFileString(statePath).pipe(
        Effect.flatMap(decodeDeliveredKeys),
        Effect.catch(() => Effect.succeed([])),
      ),
    );
    const semaphore = yield* Semaphore.make(1);

    return {
      notify: (input) =>
        semaphore.withPermits(1)(
          deliverAutomodeNotification(input, {
            delivered,
            push: (url) =>
              push.sendToAll({
                title: input.subject,
                body: input.text,
                tag: `gits:${input.key}`,
                url,
              }),
            telegram: (text) => telegram.notify({ subject: input.subject, text }),
          }).pipe(
            Effect.andThen(
              writeFileStringAtomically({
                filePath: statePath,
                contents: `${JSON.stringify([...delivered].slice(-1_000), null, 2)}\n`,
              }).pipe(
                Effect.provideService(FileSystem.FileSystem, fs),
                Effect.provideService(Path.Path, path),
                Effect.ignoreCause({ log: true }),
              ),
            ),
          ),
        ),
    };
  }),
);
