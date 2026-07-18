// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off -- fake NDJSON peer log.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { ProviderAdapterRequestError } from "../provider/Errors.ts";
import { logoutCodexAccount, startCodexDeviceAuth } from "./CodexDeviceAuth.ts";
import { makeProviderAuthService } from "./ProviderAuthService.ts";

interface FakeLogEntry {
  readonly method: string;
  readonly params?: unknown;
  readonly codexHome?: string;
}

const readLog = Effect.fn("readFakeCodexAuthLog")(function* (path: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const contents = yield* fileSystem.readFileString(path);
  return contents
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as FakeLogEntry);
});

const makeLaunchInput = Effect.fn("makeFakeCodexAuthLaunchInput")(function* (
  mode: "success" | "failure" | "pending",
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "codex-auth-test-" });
  const logPath = path.join(directory, "requests.ndjson");
  const fixturePath = path.join(import.meta.dirname, "fixtures/codex-auth-app-server.mjs");
  return {
    logPath,
    launch: {
      binaryPath: process.execPath,
      appServerArgs: [fixturePath],
      cwd: directory,
      credentialHome: path.join(directory, ".codex-test"),
      environment: {
        PATH: process.env["PATH"],
        HOME: process.env["HOME"],
        FAKE_CODEX_AUTH_LOG: logPath,
        FAKE_CODEX_AUTH_MODE: mode,
      },
    },
  };
});

it.layer(NodeServices.layer)("Codex device authentication", (it) => {
  it.effect("starts structured device-code login and trusts its completion notification", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { launch, logPath } = yield* makeLaunchInput("success");
        const auth = yield* startCodexDeviceAuth(launch);

        expect(auth.verificationUri).toBe("https://auth.example.test/device");
        expect(auth.userCode).toBe("ABCD-EFGH");
        expect(yield* auth.completion).toBe(true);
        yield* auth.close;

        const log = yield* readLog(logPath);
        expect(log.find((entry) => entry.method === "account/login/start")?.params).toEqual({
          type: "chatgptDeviceCode",
        });
        expect(log.every((entry) => entry.codexHome === launch.credentialHome)).toBe(true);
      }),
    ),
  );

  it.effect("sends the exact login id on cancel and calls structured logout", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const pending = yield* makeLaunchInput("pending");
        const auth = yield* startCodexDeviceAuth(pending.launch);
        yield* auth.cancel;
        yield* auth.close;

        const logout = yield* makeLaunchInput("pending");
        yield* logoutCodexAccount(logout.launch);

        expect(
          (yield* readLog(pending.logPath)).find((entry) => entry.method === "account/login/cancel")
            ?.params,
        ).toEqual({ loginId: "fake-login-id" });
        expect(
          (yield* readLog(logout.logPath)).some((entry) => entry.method === "account/logout"),
        ).toBe(true);
      }),
    ),
  );

  it.effect("cancels the app-server login when the private session times out", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { launch, logPath } = yield* makeLaunchInput("pending");
        const providerAuth = yield* makeProviderAuthService({
          ttlMs: 1_000,
          terminalRetentionMs: 500,
          randomId: () => Effect.succeed("provider-auth-timeout"),
        });
        const mapError = () =>
          new ProviderAdapterRequestError({
            provider: ProviderDriverKind.make("codex"),
            method: "account/login/start",
            detail: "Fake Codex auth failed.",
          });
        const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const provideSpawner = <A, E>(
          effect: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner>,
        ) =>
          effect.pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
          );

        const started = yield* providerAuth.startProvider({
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          connectionId: "owner-a",
          method: "device-code",
          adapter: {
            credentialHome: launch.credentialHome,
            methods: ["device-code"],
            start: () =>
              provideSpawner(startCodexDeviceAuth(launch)).pipe(
                Effect.map((handle) => ({
                  ...handle,
                  cancel: handle.cancel.pipe(Effect.mapError(mapError)),
                })),
                Effect.mapError(mapError),
              ),
            logout: () =>
              provideSpawner(logoutCodexAccount(launch)).pipe(Effect.mapError(mapError)),
          },
          refresh: Effect.void,
        });

        yield* TestClock.adjust(Duration.seconds(1));
        expect(
          yield* providerAuth.get({
            sessionId: started.session.sessionId,
            connectionId: "owner-a",
          }),
        ).toMatchObject({ state: "expired" });
        expect(
          (yield* readLog(logPath)).some((entry) => entry.method === "account/login/cancel"),
        ).toBe(true);
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );
});
