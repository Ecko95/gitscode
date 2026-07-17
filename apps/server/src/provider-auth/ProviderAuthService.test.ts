import { describe, expect, it, vi } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
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
});
