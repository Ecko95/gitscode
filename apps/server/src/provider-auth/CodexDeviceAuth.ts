import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as CodexErrors from "effect-codex-app-server/errors";
import type * as CodexSchema from "effect-codex-app-server/schema";

import {
  openCodexAppServer,
  type CodexAppServerLaunchInput,
} from "../provider/codexAppServerClient.ts";

export interface CodexDeviceAuthHandle {
  readonly verificationUri: string;
  readonly userCode: string;
  readonly completion: Effect.Effect<boolean>;
  readonly cancel: Effect.Effect<void, CodexErrors.CodexAppServerError>;
  readonly close: Effect.Effect<void>;
}

function validVerificationUri(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

export const startCodexDeviceAuth = Effect.fn("startCodexDeviceAuth")(function* (
  input: CodexAppServerLaunchInput,
) {
  const opened = yield* openCodexAppServer(input);
  const completion = yield* Deferred.make<boolean>();
  let expectedLoginId: string | undefined;
  const earlyNotifications: CodexSchema.V2AccountLoginCompletedNotification[] = [];
  yield* opened.client.handleServerNotification("account/login/completed", (notification) => {
    if (!expectedLoginId) {
      earlyNotifications.push(notification);
      return Effect.void;
    }
    return notification.loginId === expectedLoginId
      ? Deferred.succeed(completion, notification.success).pipe(Effect.asVoid)
      : Effect.void;
  });
  const response = yield* opened.client
    .request("account/login/start", { type: "chatgptDeviceCode" })
    .pipe(Effect.onError(() => opened.close));
  if (response.type !== "chatgptDeviceCode" || !validVerificationUri(response.verificationUrl)) {
    yield* opened.close;
    return yield* CodexErrors.CodexAppServerRequestError.invalidRequest(
      "Codex returned an invalid device authorization response.",
    );
  }
  expectedLoginId = response.loginId;
  const earlyCompletion = earlyNotifications.find(
    (notification) => notification.loginId === expectedLoginId,
  );
  if (earlyCompletion) {
    yield* Deferred.succeed(completion, earlyCompletion.success);
  }
  return {
    verificationUri: response.verificationUrl,
    userCode: response.userCode,
    completion: Deferred.await(completion),
    cancel: opened.client
      .request("account/login/cancel", { loginId: response.loginId })
      .pipe(Effect.asVoid),
    close: opened.close,
  } satisfies CodexDeviceAuthHandle;
});

export const logoutCodexAccount = Effect.fn("logoutCodexAccount")(function* (
  input: CodexAppServerLaunchInput,
) {
  const opened = yield* openCodexAppServer(input);
  yield* opened.client.request("account/logout", undefined).pipe(Effect.ensuring(opened.close));
});
