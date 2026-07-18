import {
  ProviderAuthCapabilityId,
  type OpenCodeSettings,
  type ProviderAuthCapability,
  type ProviderAuthMethod,
  type ProviderDriverKind,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";

import {
  ProviderAdapterRequestError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../provider/Errors.ts";
import type { ProviderAuthAttempt } from "../provider/Services/ProviderAdapter.ts";
import type { ProviderAuthAdapter } from "../provider/Services/ProviderAdapter.ts";
import type { OpenCodeRuntimeShape } from "../provider/opencodeRuntime.ts";

export interface OpenCodeReportedAuthMethod {
  readonly type: "oauth" | "api";
  readonly label: string;
}

interface OpenCodeAuthorization {
  readonly url: string;
  readonly method: "auto" | "code";
  readonly instructions: string;
}

/** Narrow adapter over the connected OpenCode server API, intentionally easy to fake. */
export interface OpenCodeAuthApi {
  readonly methods: () => Promise<
    Readonly<Record<string, ReadonlyArray<OpenCodeReportedAuthMethod>>>
  >;
  readonly authorize: (providerId: string, methodIndex: number) => Promise<OpenCodeAuthorization>;
  readonly callback: (providerId: string, methodIndex: number, code?: string) => Promise<boolean>;
  readonly setApiKey: (providerId: string, key: string) => Promise<boolean>;
}

interface OpenCodeAuthSelection {
  readonly capability: ProviderAuthCapability;
  readonly providerId: string;
  readonly methodIndex: number;
}

const DEVICE_CODE = /\benter\s+code\s*:\s*([a-z0-9][a-z0-9-]{2,63})\b/i;

const requestError = (provider: ProviderDriverKind, method: string) =>
  new ProviderAdapterRequestError({
    provider,
    method,
    detail: "OpenCode authentication could not complete.",
  });

const validationError = (provider: ProviderDriverKind, issue: string) =>
  new ProviderAdapterValidationError({
    provider,
    operation: "providerAuth.start",
    issue,
  });

function capabilityId(providerId: string, methodIndex: number): ProviderAuthCapabilityId | null {
  const value = `opencode:${encodeURIComponent(providerId)}:${methodIndex}`;
  return value.length <= 512 ? ProviderAuthCapabilityId.make(value) : null;
}

const loadSelections = Effect.fn("loadOpenCodeAuthSelections")(function* (
  api: OpenCodeAuthApi,
  provider = "opencode" as ProviderDriverKind,
) {
  const reported = yield* Effect.tryPromise({
    try: () => api.methods(),
    catch: () => requestError(provider, "provider.auth"),
  });
  return openCodeAuthSelections(reported);
});

function openCodeAuthSelections(
  reported: Readonly<Record<string, ReadonlyArray<OpenCodeReportedAuthMethod>>>,
): ReadonlyArray<OpenCodeAuthSelection> {
  const selections: OpenCodeAuthSelection[] = [];
  for (const [providerId, methods] of Object.entries(reported)) {
    if (!providerId.trim()) continue;
    methods.forEach((method, methodIndex) => {
      const id = capabilityId(providerId, methodIndex);
      const label = method.label.trim();
      if (!id || !label || label.length > 200) return;
      selections.push({
        capability: {
          id,
          method: method.type === "api" ? "api-key" : "oauth",
          label,
        },
        providerId,
        methodIndex,
      });
    });
  }
  return selections;
}

export function openCodeAuthCapabilities(
  reported: Readonly<Record<string, ReadonlyArray<OpenCodeReportedAuthMethod>>>,
): ReadonlyArray<ProviderAuthCapability> {
  return openCodeAuthSelections(reported).map((selection) => selection.capability);
}

export const discoverOpenCodeAuthCapabilities = Effect.fn("discoverOpenCodeAuthCapabilities")(
  function* (api: OpenCodeAuthApi) {
    return (yield* loadSelections(api)).map((selection) => selection.capability);
  },
);

function validVerificationUri(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

function completionHandle() {
  return Effect.gen(function* () {
    const completion = yield* Deferred.make<boolean>();
    let finished = false;
    const finish = (succeeded: boolean) =>
      Effect.suspend(() => {
        if (finished) return Effect.void;
        finished = true;
        return Deferred.succeed(completion, succeeded).pipe(Effect.asVoid);
      });
    return { completion: Deferred.await(completion), finish };
  });
}

export const startOpenCodeAuth = Effect.fn("startOpenCodeAuth")(function* (input: {
  readonly provider: ProviderDriverKind;
  readonly api: OpenCodeAuthApi;
  readonly capabilityId: ProviderAuthCapabilityId;
  readonly method: ProviderAuthMethod;
}): Effect.fn.Return<ProviderAuthAttempt<ProviderAdapterError>, ProviderAdapterError> {
  const selection = (yield* loadSelections(input.api, input.provider)).find(
    (candidate) => candidate.capability.id === input.capabilityId,
  );
  if (!selection) {
    return yield* validationError(
      input.provider,
      "The selected OpenCode authentication method is no longer available.",
    );
  }
  if (selection.capability.method !== input.method) {
    return yield* validationError(
      input.provider,
      "The selected OpenCode authentication method does not match the request.",
    );
  }

  const handle = yield* completionHandle();
  const cancel = handle.finish(false);

  if (selection.capability.method === "api-key") {
    let submitted = false;
    return {
      readiness: Effect.succeed({
        sanitizedPrompt: `Enter the credential for ${selection.capability.label}.`,
        acceptsCode: true,
      }),
      submitCode: (code) =>
        Effect.suspend((): Effect.Effect<void, ProviderAdapterError> => {
          const key = code.trim();
          if (submitted || !key || key.length > 4_096) {
            return Effect.fail(
              validationError(input.provider, "The OpenCode API key could not be submitted."),
            );
          }
          submitted = true;
          return Effect.tryPromise({
            try: () => input.api.setApiKey(selection.providerId, key),
            catch: () => requestError(input.provider, "auth.set"),
          }).pipe(Effect.flatMap(handle.finish));
        }),
      completion: handle.completion,
      cancel,
      close: handle.finish(false),
    };
  }

  const authorization = yield* Effect.tryPromise({
    try: () => input.api.authorize(selection.providerId, selection.methodIndex),
    catch: () => requestError(input.provider, "provider.oauth.authorize"),
  });
  const verificationUri = validVerificationUri(authorization.url);
  if (!verificationUri) {
    return yield* validationError(
      input.provider,
      "OpenCode returned an invalid authorization URL.",
    );
  }

  if (authorization.method === "code") {
    let submitted = false;
    return {
      readiness: Effect.succeed({
        verificationUri,
        sanitizedPrompt: "Open the verification page, then enter the authorization code.",
        acceptsCode: true,
      }),
      submitCode: (code) =>
        Effect.suspend((): Effect.Effect<void, ProviderAdapterError> => {
          const normalized = code.trim();
          if (submitted || !normalized || normalized.length > 4_096) {
            return Effect.fail(
              validationError(
                input.provider,
                "The OpenCode authorization code could not be submitted.",
              ),
            );
          }
          submitted = true;
          return Effect.tryPromise({
            try: () => input.api.callback(selection.providerId, selection.methodIndex, normalized),
            catch: () => requestError(input.provider, "provider.oauth.callback"),
          }).pipe(Effect.flatMap(handle.finish));
        }),
      completion: handle.completion,
      cancel,
      close: handle.finish(false),
    };
  }

  const userCode = authorization.instructions.match(DEVICE_CODE)?.[1];
  return {
    readiness: Effect.succeed({
      verificationUri,
      ...(userCode ? { userCode } : {}),
      sanitizedPrompt: userCode
        ? "Open the verification page and enter the device code."
        : "Open the verification page and finish authentication.",
      acceptsCode: false,
    }),
    completion: Effect.tryPromise({
      try: () => input.api.callback(selection.providerId, selection.methodIndex),
      catch: () => requestError(input.provider, "provider.oauth.callback"),
    }).pipe(
      Effect.flatMap((succeeded) => handle.finish(succeeded)),
      Effect.andThen(handle.completion),
    ),
    cancel,
    close: handle.finish(false),
  };
});

function toOpenCodeAuthApi(client: OpencodeClient): OpenCodeAuthApi {
  return {
    methods: async () => {
      const result = await client.provider.auth();
      if (!result.data) throw new Error("OpenCode auth methods were unavailable.");
      return result.data;
    },
    authorize: async (providerId, methodIndex) => {
      const result = await client.provider.oauth.authorize({
        providerID: providerId,
        method: methodIndex,
      });
      if (!result.data) throw new Error("OpenCode authorization did not start.");
      return result.data;
    },
    callback: async (providerId, methodIndex, code) => {
      const result = await client.provider.oauth.callback({
        providerID: providerId,
        method: methodIndex,
        ...(code ? { code } : {}),
      });
      return result.data === true;
    },
    setApiKey: async (providerId, key) => {
      const result = await client.auth.set({
        providerID: providerId,
        auth: { type: "api", key },
      });
      return result.data === true;
    },
  };
}

function openCodeCredentialHome(input: {
  readonly settings: OpenCodeSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string;
}): string {
  const serverUrl = input.settings.serverUrl.trim();
  if (serverUrl) {
    try {
      const url = new URL(serverUrl);
      url.username = "";
      url.password = "";
      url.search = "";
      url.hash = "";
      return `opencode-server:${url.toString()}`;
    } catch {
      return "opencode-server:configured";
    }
  }
  const dataHome = input.environment.XDG_DATA_HOME?.trim();
  if (dataHome) return `${dataHome}/opencode`;
  const home = input.environment.HOME?.trim();
  return home ? `${home}/.local/share/opencode` : `${input.cwd}/.opencode`;
}

export function makeOpenCodeAuthAdapter(input: {
  readonly settings: OpenCodeSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly runtime: OpenCodeRuntimeShape;
}): ProviderAuthAdapter<ProviderAdapterError> {
  const provider = "opencode" as ProviderDriverKind;
  return {
    credentialHome: openCodeCredentialHome(input),
    methods: ["oauth", "api-key"],
    start: (method, selectedCapabilityId) =>
      Effect.gen(function* () {
        if (!selectedCapabilityId) {
          return yield* validationError(
            provider,
            "OpenCode requires a reported authentication method selection.",
          );
        }
        const scope = yield* Scope.make("sequential");
        const closeScope = Scope.close(scope, Exit.void);
        const attempt = yield* Effect.gen(function* () {
          const server = yield* input.runtime.connectToOpenCodeServer({
            binaryPath: input.settings.binaryPath,
            serverUrl: input.settings.serverUrl,
            environment: input.environment,
          });
          const client = input.runtime.createOpenCodeSdkClient({
            baseUrl: server.url,
            directory: input.cwd,
            ...(input.settings.serverPassword.trim()
              ? { serverPassword: input.settings.serverPassword }
              : {}),
          });
          return yield* startOpenCodeAuth({
            provider,
            api: toOpenCodeAuthApi(client),
            capabilityId: selectedCapabilityId,
            method,
          });
        }).pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.mapError((cause) =>
            "_tag" in cause &&
            (cause._tag === "ProviderAdapterRequestError" ||
              cause._tag === "ProviderAdapterValidationError")
              ? cause
              : requestError(provider, "provider.auth.connect"),
          ),
          Effect.onError(() => closeScope),
        );
        let closed = false;
        const close = Effect.suspend(() => {
          if (closed) return Effect.void;
          closed = true;
          return attempt.close.pipe(Effect.ensuring(closeScope));
        });
        return { ...attempt, close };
      }),
    logout: () =>
      Effect.fail(
        validationError(
          provider,
          "Disconnect OpenCode upstream providers through their reported provider controls.",
        ),
      ),
  };
}
