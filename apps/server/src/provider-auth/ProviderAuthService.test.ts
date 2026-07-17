import { describe, expect, it, vi } from "@effect/vitest";
import {
  ProviderAuthCapabilityId,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";

import { makeProviderAuthService } from "./ProviderAuthService.ts";

const startInput = {
  provider: ProviderDriverKind.make("codex"),
  providerInstanceId: ProviderInstanceId.make("codex_personal"),
  credentialHome: "/home/test/.codex-personal",
  connectionId: "owner-a",
  method: "device-code" as const,
  sanitizedPrompt: "Continue in your browser.",
  acceptsCode: false,
};

const makeHarness = (options?: {
  readonly ttlMs?: number;
  readonly terminalRetentionMs?: number;
}) =>
  Effect.gen(function* () {
    let nextId = 0;
    const auth = yield* makeProviderAuthService({
      ttlMs: options?.ttlMs ?? 60_000,
      terminalRetentionMs: options?.terminalRetentionMs ?? 5_000,
      randomId: () => Effect.succeed(`provider-auth-${++nextId}`),
    });
    return { auth };
  });

describe("ProviderAuthService", () => {
  it.effect("cancels and cleans active provider sessions when the server scope shuts down", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make("sequential");
      const cancel = vi.fn();
      const cleanup = vi.fn();
      const { auth } = yield* makeHarness().pipe(Effect.provideService(Scope.Scope, scope));
      yield* auth.start({
        ...startInput,
        cancel: Effect.sync(cancel),
        cleanup: Effect.sync(cleanup),
      });

      yield* Scope.close(scope, Exit.void);

      expect(cancel).toHaveBeenCalledTimes(1);
      expect(cleanup).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("enforces single-flight per provider and resolved credential home", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { auth } = yield* makeHarness();
        const first = yield* auth.start(startInput);

        expect(first).toMatchObject({
          sessionId: "provider-auth-1",
          providerInstanceId: "codex_personal",
          state: "starting",
        });

        const duplicate = yield* auth
          .start({
            ...startInput,
            providerInstanceId: ProviderInstanceId.make("codex_work"),
            connectionId: "owner-b",
          })
          .pipe(Effect.result);
        if (duplicate._tag !== "Failure") throw new Error("expected duplicate start to fail");
        expect(duplicate.failure.code).toBe("already-active");

        const otherHome = yield* auth.start({
          ...startInput,
          providerInstanceId: ProviderInstanceId.make("codex_work"),
          credentialHome: "/home/test/.codex-work",
        });
        expect(otherHome.sessionId).toBe("provider-auth-2");

        const otherProvider = yield* auth.start({
          ...startInput,
          provider: ProviderDriverKind.make("claudeAgent"),
          providerInstanceId: ProviderInstanceId.make("claude"),
          method: "manual-code",
        });
        expect(otherProvider.sessionId).toBe("provider-auth-3");
      }),
    ),
  );

  it.effect("allows only the initiating connection to read or cancel a session", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cleanup = vi.fn();
        const { auth } = yield* makeHarness();
        const started = yield* auth.start({
          ...startInput,
          cleanup: Effect.sync(cleanup),
        });

        expect(
          yield* auth.get({ sessionId: started.sessionId, connectionId: "owner-a" }),
        ).toMatchObject({ state: "starting" });

        const hidden = yield* auth
          .get({ sessionId: started.sessionId, connectionId: "owner-b" })
          .pipe(Effect.result);
        if (hidden._tag !== "Failure") throw new Error("expected owner isolation to fail");
        expect(hidden.failure.code).toBe("not-found");

        const deniedCancel = yield* auth
          .cancel({ sessionId: started.sessionId, connectionId: "owner-b" })
          .pipe(Effect.result);
        if (deniedCancel._tag !== "Failure") throw new Error("expected cancel to be denied");
        expect(deniedCancel.failure.code).toBe("not-found");
        expect(cleanup).not.toHaveBeenCalled();

        yield* auth.cancel({ sessionId: started.sessionId, connectionId: "owner-a" });
        expect(cleanup).toHaveBeenCalledTimes(1);
        expect(
          yield* auth.get({ sessionId: started.sessionId, connectionId: "owner-a" }),
        ).toMatchObject({ state: "cancelled" });

        const restarted = yield* auth.start(startInput);
        expect(restarted.sessionId).toBe("provider-auth-2");
      }),
    ),
  );

  it.effect("expires sessions, cleans resources, and removes the terminal tombstone", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cleanup = vi.fn();
        const { auth } = yield* makeHarness({ ttlMs: 1_000, terminalRetentionMs: 500 });
        const started = yield* auth.start({
          ...startInput,
          cleanup: Effect.sync(cleanup),
        });

        yield* TestClock.adjust(Duration.seconds(1));
        expect(cleanup).toHaveBeenCalledTimes(1);
        expect(
          yield* auth.get({ sessionId: started.sessionId, connectionId: "owner-a" }),
        ).toMatchObject({ state: "expired" });

        yield* TestClock.adjust(Duration.millis(501));
        const removed = yield* auth
          .get({ sessionId: started.sessionId, connectionId: "owner-a" })
          .pipe(Effect.result);
        if (removed._tag !== "Failure") throw new Error("expected expired session cleanup");
        expect(removed.failure.code).toBe("not-found");
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("releases resources and the single-flight key on terminal completion", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cleanup = vi.fn();
        const { auth } = yield* makeHarness();
        const started = yield* auth.start({
          ...startInput,
          cleanup: Effect.sync(cleanup),
        });

        yield* auth.finish({ sessionId: started.sessionId, state: "succeeded" });
        expect(cleanup).toHaveBeenCalledTimes(1);
        expect(
          yield* auth.get({ sessionId: started.sessionId, connectionId: "owner-a" }),
        ).toMatchObject({ state: "succeeded" });

        const restarted = yield* auth.start(startInput);
        expect(restarted.sessionId).toBe("provider-auth-2");
      }),
    ),
  );

  it.effect("removes cancelled and completed tombstones after retention", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { auth } = yield* makeHarness({ terminalRetentionMs: 500 });
        const cancelled = yield* auth.start(startInput);
        yield* auth.cancel({ sessionId: cancelled.sessionId, connectionId: "owner-a" });
        const completed = yield* auth.start(startInput);
        yield* auth.finish({ sessionId: completed.sessionId, state: "succeeded" });

        yield* TestClock.adjust(Duration.millis(501));
        for (const sessionId of [cancelled.sessionId, completed.sessionId]) {
          const result = yield* auth
            .get({ sessionId, connectionId: "owner-a" })
            .pipe(Effect.result);
          if (result._tag !== "Failure") throw new Error("expected terminal session cleanup");
          expect(result.failure.code).toBe("not-found");
        }
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect(
    "keeps device-code details owner-response-only and trusts completion notifications",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const completion = yield* Deferred.make<boolean>();
          const cancel = vi.fn();
          const close = vi.fn();
          const refresh = vi.fn();
          const start = vi.fn(() =>
            Effect.succeed({
              verificationUri: "https://login.example.test/device?state=secret-state",
              userCode: "ABCD-EFGH",
              completion: Deferred.await(completion),
              cancel: Effect.sync(cancel),
              close: Effect.sync(close),
            }),
          );
          const { auth } = yield* makeHarness();
          const capabilityId = ProviderAuthCapabilityId.make("reported-device-flow");

          const result = yield* auth.startProvider({
            provider: startInput.provider,
            providerInstanceId: startInput.providerInstanceId,
            connectionId: startInput.connectionId,
            method: "device-code",
            capabilityId,
            adapter: {
              credentialHome: startInput.credentialHome,
              methods: ["device-code"],
              start,
              logout: () => Effect.void,
            },
            refresh: Effect.sync(refresh),
          });

          expect(start).toHaveBeenCalledWith("device-code", capabilityId);

          expect(result.verificationUri).toContain("login.example.test/device");
          expect(result.userCode).toBe("ABCD-EFGH");
          expect(result.session.state).toBe("awaiting-user");
          expect(
            yield* auth.get({
              sessionId: result.session.sessionId,
              connectionId: startInput.connectionId,
            }),
          ).not.toHaveProperty("verificationUri");
          expect(
            Object.values(
              yield* auth.get({
                sessionId: result.session.sessionId,
                connectionId: startInput.connectionId,
              }),
            ),
          ).not.toContain("ABCD-EFGH");

          yield* Deferred.succeed(completion, true);
          yield* Effect.yieldNow;
          yield* Effect.yieldNow;
          expect(
            yield* auth.get({
              sessionId: result.session.sessionId,
              connectionId: startInput.connectionId,
            }),
          ).toMatchObject({ state: "succeeded" });
          expect(cancel).not.toHaveBeenCalled();
          expect(close).toHaveBeenCalledTimes(1);
          expect(refresh).toHaveBeenCalledTimes(1);
        }),
      ),
  );

  it.effect("cancels and times out the provider-native login before closing it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const completion = yield* Deferred.make<boolean>();
        const cancel = vi.fn();
        const close = vi.fn();
        const { auth } = yield* makeHarness({ ttlMs: 1_000, terminalRetentionMs: 500 });
        const adapter = {
          credentialHome: startInput.credentialHome,
          methods: ["device-code" as const],
          start: () =>
            Effect.succeed({
              verificationUri: "https://login.example.test/device",
              userCode: "ABCD-EFGH",
              completion: Deferred.await(completion),
              cancel: Effect.sync(cancel),
              close: Effect.sync(close),
            }),
          logout: () => Effect.void,
        };

        const first = yield* auth.startProvider({
          provider: startInput.provider,
          providerInstanceId: startInput.providerInstanceId,
          connectionId: startInput.connectionId,
          method: "device-code",
          adapter,
          refresh: Effect.void,
        });
        yield* auth.cancel({
          sessionId: first.session.sessionId,
          connectionId: startInput.connectionId,
        });
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(close).toHaveBeenCalledTimes(1);

        const second = yield* auth.startProvider({
          provider: startInput.provider,
          providerInstanceId: startInput.providerInstanceId,
          connectionId: startInput.connectionId,
          method: "device-code",
          adapter,
          refresh: Effect.void,
        });
        yield* TestClock.adjust(Duration.seconds(1));
        expect(cancel).toHaveBeenCalledTimes(2);
        expect(close).toHaveBeenCalledTimes(2);
        expect(
          yield* auth.get({
            sessionId: second.session.sessionId,
            connectionId: startInput.connectionId,
          }),
        ).toMatchObject({ state: "expired" });
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect(
    "submits one owner-only manual code and verifies guided login with the status probe",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const completion = yield* Deferred.make<boolean>();
          const submitted: string[] = [];
          const statusProbeOrder: string[] = [];
          const verifyAuthenticated = vi.fn(() => {
            statusProbeOrder.push("verify");
            return true;
          });
          const prepareStatusProbe = vi.fn(() => {
            statusProbeOrder.push("prepare");
          });
          const refresh = vi.fn();
          const { auth } = yield* makeHarness();
          const result = yield* auth.startProvider({
            provider: ProviderDriverKind.make("claudeAgent"),
            providerInstanceId: ProviderInstanceId.make("claude-work"),
            connectionId: "owner-a",
            method: "manual-code",
            adapter: {
              credentialHome: "/home/test/.claude-work",
              methods: ["manual-code"],
              start: () =>
                Effect.succeed({
                  readiness: Effect.succeed({
                    verificationUri: "https://claude.ai/oauth/authorize?state=private-state",
                    sanitizedPrompt:
                      "Open the Claude authorization page, then paste the code shown in your browser.",
                    acceptsCode: true as const,
                  }),
                  completion: Deferred.await(completion),
                  submitCode: (code: string) =>
                    Effect.sync(() => submitted.push(code)).pipe(Effect.asVoid),
                  requiresStatusProbe: true,
                  prepareStatusProbe: Effect.sync(prepareStatusProbe),
                  cancel: Effect.void,
                  close: Effect.void,
                }),
              logout: () => Effect.void,
            },
            refresh: Effect.sync(refresh),
            verifyAuthenticated: Effect.sync(verifyAuthenticated),
          });

          expect(result.verificationUri).toContain("claude.ai/oauth/authorize");
          expect(result.session).toMatchObject({
            state: "awaiting-user",
            acceptsCode: true,
            method: "manual-code",
          });

          const hidden = yield* auth
            .submitCode({
              sessionId: result.session.sessionId,
              connectionId: "owner-b",
              code: "private-code",
            })
            .pipe(Effect.result);
          if (hidden._tag !== "Failure") throw new Error("expected owner isolation to fail");
          expect(hidden.failure.code).toBe("not-found");

          const waiting = yield* auth.submitCode({
            sessionId: result.session.sessionId,
            connectionId: "owner-a",
            code: "private-code",
          });
          expect(waiting).toMatchObject({ state: "waiting-provider", acceptsCode: false });
          expect(submitted).toEqual(["private-code"]);
          expect(Object.values(waiting).join(" ")).not.toContain("private-code");

          const repeated = yield* auth
            .submitCode({
              sessionId: result.session.sessionId,
              connectionId: "owner-a",
              code: "second-code",
            })
            .pipe(Effect.result);
          if (repeated._tag !== "Failure") throw new Error("expected repeat submission to fail");
          expect(repeated.failure.code).toBe("invalid-request");

          yield* Deferred.succeed(completion, true);
          yield* Effect.yieldNow;
          yield* Effect.yieldNow;
          expect(
            yield* auth.get({
              sessionId: result.session.sessionId,
              connectionId: "owner-a",
            }),
          ).toMatchObject({ state: "succeeded", acceptsCode: false });
          expect(verifyAuthenticated).toHaveBeenCalledTimes(1);
          expect(prepareStatusProbe).toHaveBeenCalledTimes(1);
          expect(statusProbeOrder).toEqual(["prepare", "verify"]);
          expect(refresh).not.toHaveBeenCalled();
        }),
      ),
  );

  it.effect(
    "fails a zero-exit guided login when the provider status probe is unauthenticated",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { auth } = yield* makeHarness();
          const result = yield* auth.startProvider({
            provider: ProviderDriverKind.make("claudeAgent"),
            providerInstanceId: ProviderInstanceId.make("claude-work"),
            connectionId: "owner-a",
            method: "manual-code",
            adapter: {
              credentialHome: "/home/test/.claude-work",
              methods: ["manual-code"],
              start: () =>
                Effect.succeed({
                  readiness: Effect.succeed({
                    verificationUri: "https://claude.ai/oauth/authorize",
                    sanitizedPrompt: "Continue in your browser.",
                    acceptsCode: true as const,
                  }),
                  completion: Effect.succeed(true),
                  submitCode: () => Effect.void,
                  requiresStatusProbe: true,
                  cancel: Effect.void,
                  close: Effect.void,
                }),
              logout: () => Effect.void,
            },
            refresh: Effect.void,
            verifyAuthenticated: Effect.succeed(false),
          });

          yield* Effect.yieldNow;
          yield* Effect.yieldNow;
          expect(
            yield* auth.get({
              sessionId: result.session.sessionId,
              connectionId: "owner-a",
            }),
          ).toMatchObject({ state: "failed" });
        }),
      ),
  );

  it.effect("rejects unsupported methods and refreshes after logout", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const start = vi.fn();
        const logout = vi.fn();
        const refresh = vi.fn();
        const { auth } = yield* makeHarness();
        const adapter = {
          credentialHome: startInput.credentialHome,
          methods: ["device-code" as const],
          start: () => {
            start();
            return Effect.never;
          },
          logout: () => Effect.sync(logout),
        };

        const unsupported = yield* auth
          .startProvider({
            provider: startInput.provider,
            providerInstanceId: startInput.providerInstanceId,
            connectionId: startInput.connectionId,
            method: "api-key",
            adapter,
            refresh: Effect.void,
          })
          .pipe(Effect.result);
        if (unsupported._tag !== "Failure") throw new Error("expected unsupported method");
        expect(unsupported.failure.code).toBe("unsupported");
        expect(start).not.toHaveBeenCalled();

        yield* auth.logoutProvider({
          provider: startInput.provider,
          providerInstanceId: startInput.providerInstanceId,
          adapter,
          refresh: Effect.sync(refresh),
        });
        expect(logout).toHaveBeenCalledTimes(1);
        expect(refresh).toHaveBeenCalledTimes(1);
      }),
    ),
  );
});
