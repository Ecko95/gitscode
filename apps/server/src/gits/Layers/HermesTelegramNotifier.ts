// @effect-diagnostics nodeBuiltinImport:off
import { execFile } from "node:child_process";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  HermesTelegramNotifier,
  HermesTelegramNotifierError,
  type HermesTelegramNotifierShape,
} from "../Services/HermesTelegramNotifier.ts";
import { makeHermesEnv, resolveHermesHome } from "./HermesCliAdapter.ts";

const COMMAND_TIMEOUT_MS = 30_000;

function send({ subject, text }: { readonly subject: string; readonly text: string }) {
  return new Promise<void>((resolve, reject) => {
    execFile(
      "hermes",
      ["send", "--to", "telegram", "--quiet", "--subject", subject, text],
      {
        encoding: "utf8",
        env: makeHermesEnv(resolveHermesHome().hermesHome),
        timeout: COMMAND_TIMEOUT_MS,
      },
      (error) => (error ? reject(error) : resolve()),
    );
  });
}

export const makeHermesTelegramNotifier = Effect.succeed({
  notify: (input) =>
    Effect.tryPromise({
      try: () => send(input),
      catch: (cause) =>
        new HermesTelegramNotifierError({
          message: "Hermes Telegram delivery failed.",
          cause,
        }),
    }),
} satisfies HermesTelegramNotifierShape);

export const HermesTelegramNotifierLive = Layer.effect(
  HermesTelegramNotifier,
  makeHermesTelegramNotifier,
);
