import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as CodexClient from "effect-codex-app-server/client";

import { buildCodexInitializeParams } from "./Layers/CodexProvider.ts";

export interface CodexAppServerLaunchInput {
  readonly binaryPath: string;
  readonly appServerArgs?: ReadonlyArray<string>;
  readonly cwd: string;
  readonly credentialHome: string;
  readonly environment: NodeJS.ProcessEnv;
}

export interface OpenCodexAppServerResult {
  readonly client: CodexClient.CodexAppServerClientShape;
  readonly close: Effect.Effect<void>;
}

function definedEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

/** Starts one isolated, initialized app-server whose scope is owned by the returned handle. */
export const openCodexAppServer = Effect.fn("openCodexAppServer")(function* (
  input: CodexAppServerLaunchInput,
) {
  const helperScope = yield* Scope.make("sequential");
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const close = Scope.close(helperScope, Exit.void);
  const context = yield* Layer.build(
    CodexClient.layerCommand({
      command: input.binaryPath,
      args: [...(input.appServerArgs ?? []), "app-server"],
      cwd: input.cwd,
      inheritProcessEnv: false,
      env: {
        ...definedEnvironment(input.environment),
        CODEX_HOME: input.credentialHome,
      },
    }),
  ).pipe(
    Effect.provideService(Scope.Scope, helperScope),
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
    Effect.onError(() => close),
  );
  const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
    Effect.provide(context),
  );
  yield* client
    .request("initialize", buildCodexInitializeParams())
    .pipe(Effect.onError(() => close));
  yield* client.notify("initialized", undefined).pipe(Effect.onError(() => close));
  return { client, close } satisfies OpenCodexAppServerResult;
});
