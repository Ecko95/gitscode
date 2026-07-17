import type { ProviderAuthMethod, ProviderDriverKind } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import {
  ProviderAdapterRequestError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../provider/Errors.ts";
import type {
  ProviderAuthAdapter,
  ProviderAuthAttempt,
} from "../provider/Services/ProviderAdapter.ts";
import type { PtyAdapterShape, PtyProcess } from "../terminal/Services/PTY.ts";
import { HTTPS_URL, stripTerminalControls } from "./terminalSanitize.ts";

const MAX_TRANSCRIPT_LENGTH = 32_768;
const SAFE_PROMPT = "Open the GitHub verification page and enter the one-time code.";
const ONE_TIME_CODE = /\bone-time\s+code\s*:\s*([a-z0-9]{4}-[a-z0-9]{4})\b/i;

export interface GitHubAuthInput {
  readonly provider: ProviderDriverKind;
  readonly pty: PtyAdapterShape;
  readonly binaryPath: string;
  readonly hostname: string;
  readonly credentialHome: string;
  readonly environment: NodeJS.ProcessEnv;
}

export interface GitHubDeviceLoginReadiness {
  readonly verificationUri: string;
  readonly userCode: string;
  readonly sanitizedPrompt: string;
  readonly acceptsCode: false;
}

export type GitHubDeviceLoginHandle = ProviderAuthAttempt<ProviderAdapterError> & {
  readonly readiness: Effect.Effect<GitHubDeviceLoginReadiness, ProviderAdapterError>;
};

const requestError = (input: GitHubAuthInput, method: string, detail: string) =>
  new ProviderAdapterRequestError({ provider: input.provider, method, detail });

const validationError = (input: GitHubAuthInput, issue: string) =>
  new ProviderAdapterValidationError({
    provider: input.provider,
    operation: "providerAuth.start",
    issue,
  });

function normalizedHostname(input: GitHubAuthInput): string | null {
  const hostname = input.hostname.trim().toLowerCase();
  if (!hostname || !/^[a-z0-9.-]+$/.test(hostname) || hostname.includes("..")) return null;
  return hostname;
}

function findReadiness(
  input: GitHubAuthInput,
  transcript: string,
): GitHubDeviceLoginReadiness | undefined {
  const hostname = normalizedHostname(input);
  if (!hostname) return undefined;
  const visible = stripTerminalControls(transcript);
  const userCode = visible.match(ONE_TIME_CODE)?.[1];
  const candidate = visible.match(HTTPS_URL)?.[0];
  if (!userCode || !candidate) return undefined;
  try {
    const url = new URL(candidate);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hostname.toLowerCase() !== hostname
    ) {
      return undefined;
    }
    return {
      verificationUri: url.toString(),
      userCode,
      sanitizedPrompt: SAFE_PROMPT,
      acceptsCode: false,
    };
  } catch {
    return undefined;
  }
}

function privateEnvironment(input: GitHubAuthInput): NodeJS.ProcessEnv {
  return { ...input.environment, GH_PROMPT_DISABLED: "1" };
}

function killProcess(
  input: GitHubAuthInput,
  process: PtyProcess,
): Effect.Effect<void, ProviderAdapterRequestError> {
  return Effect.try({
    try: () => process.kill(),
    catch: () => requestError(input, "auth/login/cancel", "GitHub sign-in could not be cancelled."),
  });
}

export const startGitHubDeviceLogin = Effect.fn("startGitHubDeviceLogin")(function* (
  input: GitHubAuthInput,
): Effect.fn.Return<GitHubDeviceLoginHandle, ProviderAdapterError> {
  const hostname = normalizedHostname(input);
  if (!hostname) return yield* validationError(input, "The GitHub hostname is invalid.");

  const process = yield* input.pty
    .spawn({
      shell: input.binaryPath,
      args: ["auth", "login", "--hostname", hostname, "--git-protocol", "https", "--web"],
      cwd: input.credentialHome,
      cols: 80,
      rows: 24,
      env: privateEnvironment(input),
    })
    .pipe(
      Effect.mapError(() =>
        requestError(input, "auth/login", "GitHub sign-in could not start its private terminal."),
      ),
    );
  const readiness = yield* Deferred.make<GitHubDeviceLoginReadiness, ProviderAdapterError>();
  const completion = yield* Deferred.make<boolean>();
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);
  let transcript = "";
  let exited = false;
  let cancelled = false;
  let closed = false;

  const failReadiness = () =>
    Deferred.fail(
      readiness,
      requestError(input, "auth/login", "GitHub sign-in ended before authorization was ready."),
    );
  const unsubscribeData = process.onData((chunk) => {
    transcript = `${transcript}${chunk}`.slice(-MAX_TRANSCRIPT_LENGTH);
    const ready = findReadiness(input, transcript);
    if (ready) runFork(Deferred.succeed(readiness, ready));
  });
  const unsubscribeExit = process.onExit((event) => {
    exited = true;
    transcript = "";
    runFork(Deferred.succeed(completion, event.exitCode === 0));
    runFork(failReadiness());
  });

  const cancel = Effect.suspend(() => {
    if (cancelled || exited || closed) return Effect.void;
    cancelled = true;
    transcript = "";
    runFork(Deferred.succeed(completion, false));
    runFork(failReadiness());
    return killProcess(input, process);
  });

  const close = Effect.sync(() => {
    if (closed) return;
    closed = true;
    transcript = "";
    runFork(Deferred.succeed(completion, false));
    runFork(failReadiness());
    unsubscribeData();
    unsubscribeExit();
  });

  return {
    readiness: Deferred.await(readiness),
    completion: Deferred.await(completion),
    cancel,
    close,
  };
});

export const logoutGitHubAccount = Effect.fn("logoutGitHubAccount")(function* (
  input: GitHubAuthInput,
) {
  const hostname = normalizedHostname(input);
  if (!hostname) return yield* validationError(input, "The GitHub hostname is invalid.");
  const process = yield* input.pty
    .spawn({
      shell: input.binaryPath,
      args: ["auth", "logout", "--hostname", hostname],
      cwd: input.credentialHome,
      cols: 80,
      rows: 24,
      env: privateEnvironment(input),
    })
    .pipe(
      Effect.mapError(() =>
        requestError(input, "auth/logout", "GitHub sign-out could not start its private terminal."),
      ),
    );
  const completion = yield* Deferred.make<number>();
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);
  const unsubscribe = process.onExit((event) => {
    runFork(Deferred.succeed(completion, event.exitCode));
  });
  const exitCode = yield* Deferred.await(completion).pipe(
    Effect.onInterrupt(() => killProcess(input, process).pipe(Effect.ignoreCause({ log: false }))),
    Effect.ensuring(Effect.sync(unsubscribe)),
  );
  if (exitCode !== 0) {
    return yield* requestError(input, "auth/logout", "GitHub sign-out did not complete.");
  }
});

export function makeGitHubAuthAdapter(
  input: GitHubAuthInput,
): ProviderAuthAdapter<ProviderAdapterError> {
  return {
    credentialHome: input.credentialHome,
    methods: ["device-code"],
    start: (method: ProviderAuthMethod) =>
      method === "device-code"
        ? startGitHubDeviceLogin(input)
        : Effect.fail(validationError(input, "GitHub CLI only supports device-code sign-in.")),
    logout: () => logoutGitHubAccount(input),
  };
}
