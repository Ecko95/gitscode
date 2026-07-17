import { describe, expect, it, vi } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import {
  canProveWildcardCallbackIsolation,
  makeCodexMcpAuth,
  type CodexMcpAuthHelperCompletion,
  type RunningCodexMcpAuthHelper,
} from "./CodexMcpAuth.ts";

const callbackBaseUrl = "https://gits.example.test/api/gits/mcp/oauth/callback";
const state = "state_0123456789abcdefghijklmnopqrstuvwxyzABCDEFG";

const makeHarness = (overrides?: {
  readonly advertisedCallbackBaseUrl?: string | null;
  readonly isolated?: boolean;
  readonly credentialHome?: string;
  readonly ttlMs?: number;
  readonly randomId?: () => Effect.Effect<string, never>;
}) =>
  Effect.gen(function* () {
    const completion = yield* Deferred.make<CodexMcpAuthHelperCompletion>();
    const close = vi.fn();
    const reload = vi.fn();
    const startHelper = vi.fn(
      (input: { readonly callbackBaseUrl: string }): Effect.Effect<RunningCodexMcpAuthHelper> =>
        Effect.succeed({
          authorizationUrl: `https://auth.example.test/authorize?redirect_uri=${encodeURIComponent(
            `${input.callbackBaseUrl}/callback_0123456789abcdef`,
          )}&state=${state}`,
          completion: Deferred.await(completion),
          reload: Effect.sync(reload),
          close: Effect.sync(close),
        }),
    );
    let nextId = 0;
    const auth = yield* makeCodexMcpAuth({
      ttlMs: overrides?.ttlMs ?? 60_000,
      resolveAdvertisedCallbackBaseUrl: () =>
        Effect.succeed(overrides?.advertisedCallbackBaseUrl ?? callbackBaseUrl),
      resolveLaunchConfig: () =>
        Effect.succeed({
          binaryPath: "codex",
          credentialHome: overrides?.credentialHome ?? "/home/test/.codex",
          environment: {},
        }),
      reserveCallbackPort: () => Effect.succeed(41_337),
      isCallbackPortIsolated: () => Effect.succeed(overrides?.isolated ?? true),
      startHelper,
      randomId: overrides?.randomId ?? (() => Effect.succeed(`session_${++nextId}`)),
    });
    return { auth, completion, close, reload, startHelper };
  });

describe("CodexMcpAuth", () => {
  it.effect("enforces one owner-scoped session per credential home and server", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { auth } = yield* makeHarness();
        const started = yield* auth.start({
          providerInstanceId: "codex",
          serverName: "supabase",
          connectionId: "owner-a",
        });

        expect(started.authorizationUrl).toContain("https://auth.example.test/authorize");
        expect(started.sessionId).toBe("session_1");
        expect(
          yield* auth.getStatus({ sessionId: started.sessionId, connectionId: "owner-a" }),
        ).toMatchObject({ state: "waiting-provider", sessionId: "session_1" });

        const second = yield* auth
          .start({
            providerInstanceId: "codex-work",
            serverName: "supabase",
            connectionId: "owner-b",
          })
          .pipe(Effect.result);
        if (second._tag !== "Failure") throw new Error("expected duplicate start to fail");
        expect(second.failure.code).toBe("already-active");

        const statusAsOtherOwner = yield* auth
          .getStatus({ sessionId: started.sessionId, connectionId: "owner-b" })
          .pipe(Effect.result);
        if (statusAsOtherOwner._tag !== "Failure") {
          throw new Error("expected owner isolation to hide the session");
        }
        expect(statusAsOtherOwner.failure.code).toBe("not-found");
        expect(statusAsOtherOwner.failure.message).not.toContain("auth.example");
        expect(statusAsOtherOwner.failure.message).not.toContain(state);
      }),
    ),
  );

  it.effect("cancels, completes, reloads, and releases the single-flight key", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const first = yield* makeHarness();
        const started = yield* first.auth.start({
          providerInstanceId: "codex",
          serverName: "supabase",
          connectionId: "owner-a",
        });
        yield* first.auth.cancel({ sessionId: started.sessionId, connectionId: "owner-a" });
        expect(first.close).toHaveBeenCalledTimes(1);
        expect(
          yield* first.auth.getStatus({
            sessionId: started.sessionId,
            connectionId: "owner-a",
          }),
        ).toMatchObject({ state: "cancelled" });

        const restarted = yield* first.auth.start({
          providerInstanceId: "codex",
          serverName: "supabase",
          connectionId: "owner-a",
        });
        yield* Deferred.succeed(first.completion, { success: true });
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        expect(first.reload).toHaveBeenCalledTimes(1);
        expect(first.close).toHaveBeenCalledTimes(2);
        expect(
          yield* first.auth.getStatus({
            sessionId: restarted.sessionId,
            connectionId: "owner-a",
          }),
        ).toMatchObject({ state: "succeeded" });
      }),
    ),
  );

  it.effect("expires the helper and never exposes its authorization query in status", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { auth, close } = yield* makeHarness({ ttlMs: 1_000 });
        const started = yield* auth.start({
          providerInstanceId: "codex",
          serverName: "supabase",
          connectionId: "owner-a",
        });
        yield* TestClock.adjust(Duration.seconds(2));

        const status = yield* auth.getStatus({
          sessionId: started.sessionId,
          connectionId: "owner-a",
        });
        expect(status.state).toBe("expired");
        expect(Object.hasOwn(status, "authorizationUrl")).toBe(false);
        expect(Object.values(status)).not.toContain(state);
        expect(close).toHaveBeenCalledTimes(1);
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("rejects incompatible HTTPS endpoints and unproven listener isolation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const insecure = yield* makeHarness({
          advertisedCallbackBaseUrl: "http://gits.example.test",
        });
        const insecureResult = yield* insecure.auth
          .start({
            providerInstanceId: "codex",
            serverName: "supabase",
            connectionId: "owner-a",
          })
          .pipe(Effect.result);
        if (insecureResult._tag !== "Failure") throw new Error("expected insecure URL to fail");
        expect(insecureResult.failure.code).toBe("relay-unavailable");
        expect(insecure.startHelper).not.toHaveBeenCalled();

        const exposed = yield* makeHarness({ isolated: false });
        const exposedResult = yield* exposed.auth
          .start({
            providerInstanceId: "codex",
            serverName: "supabase",
            connectionId: "owner-a",
          })
          .pipe(Effect.result);
        if (exposedResult._tag !== "Failure") {
          throw new Error("expected unproven listener isolation to fail");
        }
        expect(exposedResult.failure.code).toBe("relay-unavailable");
        expect(exposed.startHelper).not.toHaveBeenCalled();
      }),
    ),
  );

  it.effect("closes a started helper when session registration fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { auth, close } = yield* makeHarness({
          randomId: () => Effect.fail(new Error("random unavailable") as never),
        });
        const result = yield* auth
          .start({
            providerInstanceId: "codex",
            serverName: "supabase",
            connectionId: "owner-a",
          })
          .pipe(Effect.result);

        expect(result._tag).toBe("Failure");
        expect(close).toHaveBeenCalledTimes(1);
      }),
    ),
  );

  it.effect("rejects a duplicate callback lease identifier", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { auth, close } = yield* makeHarness();
        yield* auth.start({
          providerInstanceId: "codex",
          serverName: "supabase",
          connectionId: "owner-a",
        });
        const result = yield* auth
          .start({
            providerInstanceId: "codex",
            serverName: "postgres",
            connectionId: "owner-a",
          })
          .pipe(Effect.result);

        if (result._tag !== "Failure") throw new Error("expected duplicate lease to fail");
        expect(result.failure.code).toBe("invalid-authorization-response");
        expect(close).toHaveBeenCalledTimes(1);
      }),
    ),
  );

  it("proves wildcard callback isolation only with loopback interfaces", () => {
    expect(canProveWildcardCallbackIsolation({})).toBe(false);
    expect(
      canProveWildcardCallbackIsolation({
        lo: [{ internal: true }],
      } as never),
    ).toBe(true);
    expect(
      canProveWildcardCallbackIsolation({
        lo: [{ internal: true }],
        eth0: [{ internal: false }],
      } as never),
    ).toBe(false);
  });
});
