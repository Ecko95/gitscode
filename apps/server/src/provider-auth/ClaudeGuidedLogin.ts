import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import { ProviderAdapterRequestError } from "../provider/Errors.ts";
import type { PtyAdapterShape, PtyProcess } from "../terminal/Services/PTY.ts";
import { HTTPS_URL, stripTerminalControls } from "./terminalSanitize.ts";

const MAX_TRANSCRIPT_LENGTH = 32_768;
const MAX_CODE_LENGTH = 4_096;
const SAFE_PROMPT =
  "Open the Claude authorization page, then paste the code shown in your browser.";

export interface ClaudeGuidedLoginInput {
  readonly pty: PtyAdapterShape;
  readonly binaryPath: string;
  readonly credentialHome: string;
  readonly environment: NodeJS.ProcessEnv;
}

export interface ClaudeGuidedLoginReadiness {
  readonly verificationUri: string;
  readonly sanitizedPrompt: string;
  readonly acceptsCode: true;
}

export interface ClaudeGuidedLoginHandle {
  readonly readiness: Effect.Effect<ClaudeGuidedLoginReadiness, ProviderAdapterRequestError>;
  readonly completion: Effect.Effect<boolean>;
  readonly submitCode: (code: string) => Effect.Effect<void, ProviderAdapterRequestError>;
  readonly cancel: Effect.Effect<void, ProviderAdapterRequestError>;
  readonly close: Effect.Effect<void>;
}

const requestError = (method: string, detail: string) =>
  new ProviderAdapterRequestError({ provider: "claudeAgent", method, detail });

function findVerificationUri(transcript: string): string | undefined {
  const candidate = stripTerminalControls(transcript).match(HTTPS_URL)?.[0];
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function killProcess(process: PtyProcess): Effect.Effect<void, ProviderAdapterRequestError> {
  return Effect.try({
    try: () => process.kill(),
    catch: () => requestError("auth/login/cancel", "Claude sign-in could not be cancelled."),
  });
}

export const startClaudeGuidedLogin = Effect.fn("startClaudeGuidedLogin")(function* (
  input: ClaudeGuidedLoginInput,
): Effect.fn.Return<ClaudeGuidedLoginHandle, ProviderAdapterRequestError> {
  const process = yield* input.pty
    .spawn({
      shell: input.binaryPath,
      args: ["auth", "login"],
      cwd: input.credentialHome,
      cols: 80,
      rows: 24,
      env: input.environment,
    })
    .pipe(
      Effect.mapError(() =>
        requestError("auth/login", "Claude sign-in could not start its private terminal."),
      ),
    );
  const readiness = yield* Deferred.make<ClaudeGuidedLoginReadiness, ProviderAdapterRequestError>();
  const completion = yield* Deferred.make<boolean>();
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);
  let transcript = "";
  let exited = false;
  let cancelled = false;
  let closed = false;
  let submitted = false;

  const unsubscribeData = process.onData((chunk) => {
    transcript = `${transcript}${chunk}`.slice(-MAX_TRANSCRIPT_LENGTH);
    const verificationUri = findVerificationUri(transcript);
    if (!verificationUri) return;
    runFork(
      Deferred.succeed(readiness, {
        verificationUri,
        sanitizedPrompt: SAFE_PROMPT,
        acceptsCode: true as const,
      }),
    );
  });
  const unsubscribeExit = process.onExit((event) => {
    exited = true;
    runFork(Deferred.succeed(completion, event.exitCode === 0));
    runFork(
      Deferred.fail(
        readiness,
        requestError("auth/login", "Claude sign-in ended before authorization was ready."),
      ),
    );
  });

  const submitCode = (code: string) =>
    Effect.suspend(() => {
      const normalized = code.trim();
      if (
        submitted ||
        exited ||
        cancelled ||
        closed ||
        normalized.length === 0 ||
        normalized.length > MAX_CODE_LENGTH
      ) {
        return Effect.fail(
          requestError("auth/login/code", "Claude authorization code could not be submitted."),
        );
      }
      submitted = true;
      return Effect.try({
        try: () => process.write(`${normalized}\r`),
        catch: () =>
          requestError("auth/login/code", "Claude authorization code could not be submitted."),
      });
    });

  const cancel = Effect.suspend(() => {
    if (cancelled || exited || closed) return Effect.void;
    cancelled = true;
    runFork(Deferred.succeed(completion, false));
    return killProcess(process);
  });

  const close = Effect.sync(() => {
    if (closed) return;
    closed = true;
    transcript = "";
    runFork(Deferred.succeed(completion, false));
    runFork(
      Deferred.fail(
        readiness,
        requestError("auth/login", "Claude sign-in ended before authorization was ready."),
      ),
    );
    unsubscribeData();
    unsubscribeExit();
  });

  return {
    readiness: Deferred.await(readiness),
    completion: Deferred.await(completion),
    submitCode,
    cancel,
    close,
  } satisfies ClaudeGuidedLoginHandle;
});

export const logoutClaudeAccount = Effect.fn("logoutClaudeAccount")(function* (
  input: ClaudeGuidedLoginInput,
) {
  const process = yield* input.pty
    .spawn({
      shell: input.binaryPath,
      args: ["auth", "logout"],
      cwd: input.credentialHome,
      cols: 80,
      rows: 24,
      env: input.environment,
    })
    .pipe(
      Effect.mapError(() =>
        requestError("auth/logout", "Claude sign-out could not start its private terminal."),
      ),
    );
  const completion = yield* Deferred.make<number>();
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);
  const unsubscribe = process.onExit((event) => {
    runFork(Deferred.succeed(completion, event.exitCode));
  });
  const exitCode = yield* Deferred.await(completion).pipe(
    Effect.onInterrupt(() => killProcess(process).pipe(Effect.ignoreCause({ log: false }))),
    Effect.ensuring(Effect.sync(unsubscribe)),
  );
  if (exitCode !== 0) {
    return yield* requestError("auth/logout", "Claude sign-out did not complete.");
  }
});
