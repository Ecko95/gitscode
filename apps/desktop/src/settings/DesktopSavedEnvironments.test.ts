import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodePath from "@effect/platform-node/NodePath";
import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, type PersistedSavedEnvironmentRecord } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as DesktopSavedEnvironments from "./DesktopSavedEnvironments.ts";

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

const savedRegistryRecord: PersistedSavedEnvironmentRecord = {
  environmentId: EnvironmentId.make("environment-1"),
  label: "Remote environment",
  httpBaseUrl: "https://remote.example.com/",
  wsBaseUrl: "wss://remote.example.com/",
  createdAt: "2026-04-09T00:00:00.000Z",
  lastConnectedAt: "2026-04-09T01:00:00.000Z",
  desktopSsh: {
    alias: "devbox",
    hostname: "devbox.example.com",
    username: "julius",
    port: 22,
  },
};

const SavedEnvironmentRegistryDocumentProbe = Schema.Struct({
  version: Schema.Number,
  records: Schema.Array(Schema.Unknown),
});
const decodeSavedEnvironmentRegistryDocumentProbe = Schema.decodeEffect(
  Schema.fromJsonString(SavedEnvironmentRegistryDocumentProbe),
);

function makeSafeStorageLayer(input: {
  readonly available: boolean;
  readonly availabilityError?: unknown;
  readonly encryptError?: unknown;
  readonly decryptError?: unknown;
}) {
  return Layer.succeed(ElectronSafeStorage.ElectronSafeStorage, {
    isEncryptionAvailable:
      input.availabilityError === undefined
        ? Effect.succeed(input.available)
        : Effect.fail(
            new ElectronSafeStorage.ElectronSafeStorageAvailabilityError({
              cause: input.availabilityError,
            }),
          ),
    encryptString: (value) =>
      input.encryptError === undefined
        ? Effect.succeed(textEncoder.encode(`enc:${value}`))
        : Effect.fail(
            new ElectronSafeStorage.ElectronSafeStorageEncryptError({
              cause: input.encryptError,
            }),
          ),
    decryptString: (value) => {
      if (input.decryptError !== undefined) {
        return Effect.fail(
          new ElectronSafeStorage.ElectronSafeStorageDecryptError({
            cause: input.decryptError,
          }),
        );
      }

      const decoded = textDecoder.decode(value);
      if (!decoded.startsWith("enc:")) {
        return Effect.fail(
          new ElectronSafeStorage.ElectronSafeStorageDecryptError({
            cause: new Error("invalid secret"),
          }),
        );
      }
      return Effect.succeed(decoded.slice("enc:".length));
    },
  } satisfies ElectronSafeStorage.ElectronSafeStorageShape);
}

function makeLayer(
  baseDir: string,
  options?: {
    readonly availableSecretStorage?: boolean;
    readonly availabilityError?: unknown;
    readonly encryptError?: unknown;
    readonly decryptError?: unknown;
    readonly fileSystemLayer?: Layer.Layer<FileSystem.FileSystem>;
  },
) {
  const environmentLayer = DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: baseDir,
    platform: "darwin",
    processArch: "x64",
    appVersion: "1.2.3",
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/missing/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({ T3CODE_HOME: baseDir })),
    ),
  );

  const platformLayer = options?.fileSystemLayer
    ? Layer.mergeAll(options.fileSystemLayer, NodeCrypto.layer, NodePath.layer)
    : NodeServices.layer;

  return DesktopSavedEnvironments.layer.pipe(
    Layer.provideMerge(environmentLayer),
    Layer.provideMerge(
      makeSafeStorageLayer({
        available: options?.availableSecretStorage ?? true,
        availabilityError: options?.availabilityError,
        encryptError: options?.encryptError,
        decryptError: options?.decryptError,
      }),
    ),
    Layer.provideMerge(platformLayer),
  );
}

const withSavedEnvironments = <A, E, R>(
  effect: Effect.Effect<A, E, R | DesktopSavedEnvironments.DesktopSavedEnvironments>,
  options?: {
    readonly availableSecretStorage?: boolean;
    readonly availabilityError?: unknown;
    readonly encryptError?: unknown;
    readonly decryptError?: unknown;
    readonly fileSystemLayer?: Layer.Layer<FileSystem.FileSystem>;
  },
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-desktop-saved-environments-test-",
    });
    return yield* effect.pipe(Effect.provide(makeLayer(baseDir, options)));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

interface MutationBarrier {
  readonly firstRenameStarted: Deferred.Deferred<void>;
  readonly releaseFirstRename: Deferred.Deferred<void>;
  readonly secondReadStarted: Deferred.Deferred<void>;
  readonly releaseSecondRead: Deferred.Deferred<void>;
}

function makeMutationBarrier() {
  return Effect.all({
    firstRenameStarted: Deferred.make<void>(),
    releaseFirstRename: Deferred.make<void>(),
    secondReadStarted: Deferred.make<void>(),
    releaseSecondRead: Deferred.make<void>(),
  });
}

function makeMutationBarrierFileSystemLayer(input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly getBarrier: () => MutationBarrier | null;
}) {
  let currentBarrier: MutationBarrier | null = null;
  let readCount = 0;
  let renameCount = 0;

  const readBarrier = () => {
    const nextBarrier = input.getBarrier();
    if (nextBarrier !== currentBarrier) {
      currentBarrier = nextBarrier;
      readCount = 0;
      renameCount = 0;
    }
    return currentBarrier;
  };

  return Layer.succeed(FileSystem.FileSystem, {
    ...input.fileSystem,
    readFileString: (path) =>
      Effect.gen(function* () {
        const barrier = readBarrier();
        if (barrier !== null) {
          readCount += 1;
          if (readCount === 2) {
            yield* Deferred.succeed(barrier.secondReadStarted, undefined);
            yield* Deferred.await(barrier.releaseSecondRead);
          }
        }
        return yield* input.fileSystem.readFileString(path);
      }),
    rename: (from, to) =>
      Effect.gen(function* () {
        const barrier = readBarrier();
        if (barrier !== null) {
          renameCount += 1;
          if (renameCount === 1) {
            yield* Deferred.succeed(barrier.firstRenameStarted, undefined);
            yield* Deferred.await(barrier.releaseFirstRename);
          }
        }
        yield* input.fileSystem.rename(from, to);
      }),
  } satisfies FileSystem.FileSystem);
}

function runConcurrentMutationPair<A, E1, B, E2>(
  firstMutation: Effect.Effect<A, E1>,
  secondMutation: Effect.Effect<B, E2>,
  barrier: MutationBarrier,
) {
  return Effect.gen(function* () {
    const firstFiber = yield* firstMutation.pipe(Effect.forkScoped);
    yield* Deferred.await(barrier.firstRenameStarted);

    const secondMutationAttempted = yield* Deferred.make<void>();
    const secondFiber = yield* Deferred.succeed(secondMutationAttempted, undefined).pipe(
      Effect.andThen(secondMutation),
      Effect.forkScoped,
    );
    yield* Deferred.await(secondMutationAttempted);
    yield* Effect.yieldNow;

    const secondReadStartedEarly = Option.isSome(yield* Deferred.poll(barrier.secondReadStarted));
    if (secondReadStartedEarly) {
      yield* Deferred.succeed(barrier.releaseSecondRead, undefined);
      yield* Fiber.join(secondFiber);
      yield* Deferred.succeed(barrier.releaseFirstRename, undefined);
    } else {
      yield* Deferred.succeed(barrier.releaseFirstRename, undefined);
      yield* Deferred.await(barrier.secondReadStarted);
      yield* Deferred.succeed(barrier.releaseSecondRead, undefined);
    }

    yield* Fiber.join(firstFiber);
    yield* Fiber.join(secondFiber);
    assert.isFalse(secondReadStartedEarly);
  });
}

describe("DesktopSavedEnvironments", () => {
  it.effect("treats a missing registry as empty and allows the first write", () =>
    withSavedEnvironments(
      Effect.gen(function* () {
        const savedEnvironments = yield* DesktopSavedEnvironments.DesktopSavedEnvironments;

        assert.deepEqual(yield* savedEnvironments.getRegistry, []);
        yield* savedEnvironments.setRegistry([savedRegistryRecord]);
        assert.deepEqual(yield* savedEnvironments.getRegistry, [savedRegistryRecord]);
      }),
    ),
  );

  it.effect("persists and reloads saved environment metadata", () =>
    withSavedEnvironments(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const savedEnvironments = yield* DesktopSavedEnvironments.DesktopSavedEnvironments;
        yield* savedEnvironments.setRegistry([savedRegistryRecord]);

        assert.deepEqual(yield* savedEnvironments.getRegistry, [savedRegistryRecord]);
        const persisted = yield* decodeSavedEnvironmentRegistryDocumentProbe(
          yield* fileSystem.readFileString(environment.savedEnvironmentRegistryPath),
        );
        assert.equal(persisted.version, 1);
        assert.lengthOf(persisted.records, 1);
      }),
    ),
  );

  it.effect("loads lenient saved environment registry documents", () =>
    withSavedEnvironments(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const savedEnvironments = yield* DesktopSavedEnvironments.DesktopSavedEnvironments;
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(
          environment.savedEnvironmentRegistryPath,
          `{
            // Same optional envelope shape as browser saved environments.
            "version": 1,
            "records": [
              {
                "environmentId": "${savedRegistryRecord.environmentId}",
                "label": "Remote environment",
                "httpBaseUrl": "https://remote.example.com/",
                "wsBaseUrl": "wss://remote.example.com/",
                "createdAt": "2026-04-09T00:00:00.000Z",
                "lastConnectedAt": "2026-04-09T01:00:00.000Z",
                "desktopSsh": {
                  "alias": "devbox",
                  "hostname": "devbox.example.com",
                  "username": "julius",
                  "port": 22,
                },
              },
            ],
          }\n`,
        );

        assert.deepEqual(yield* savedEnvironments.getRegistry, [savedRegistryRecord]);
      }),
    ),
  );

  it.effect("persists encrypted saved environment secrets when encryption is available", () =>
    withSavedEnvironments(
      Effect.gen(function* () {
        const savedEnvironments = yield* DesktopSavedEnvironments.DesktopSavedEnvironments;
        yield* savedEnvironments.setRegistry([savedRegistryRecord]);

        assert.isTrue(
          yield* savedEnvironments.setSecret({
            environmentId: savedRegistryRecord.environmentId,
            secret: "bearer-token",
          }),
        );

        assert.deepEqual(
          yield* savedEnvironments.getSecret(savedRegistryRecord.environmentId),
          Option.some("bearer-token"),
        );
      }),
    ),
  );

  it.effect("returns false when writing secrets while encryption is unavailable", () =>
    withSavedEnvironments(
      Effect.gen(function* () {
        const savedEnvironments = yield* DesktopSavedEnvironments.DesktopSavedEnvironments;
        yield* savedEnvironments.setRegistry([savedRegistryRecord]);

        assert.isFalse(
          yield* savedEnvironments.setSecret({
            environmentId: savedRegistryRecord.environmentId,
            secret: "next-token",
          }),
        );
      }),
      { availableSecretStorage: false },
    ),
  );

  it.effect("surfaces typed safe storage availability failures", () => {
    const cause = new Error("safe storage unavailable");
    return withSavedEnvironments(
      Effect.gen(function* () {
        const savedEnvironments = yield* DesktopSavedEnvironments.DesktopSavedEnvironments;
        yield* savedEnvironments.setRegistry([savedRegistryRecord]);

        const error = yield* savedEnvironments
          .setSecret({
            environmentId: savedRegistryRecord.environmentId,
            secret: "next-token",
          })
          .pipe(Effect.flip);

        assert.instanceOf(error, ElectronSafeStorage.ElectronSafeStorageAvailabilityError);
        assert.equal(error.cause, cause);
      }),
      { availabilityError: cause },
    );
  });

  it.effect("removes saved environment secrets", () =>
    withSavedEnvironments(
      Effect.gen(function* () {
        const savedEnvironments = yield* DesktopSavedEnvironments.DesktopSavedEnvironments;
        yield* savedEnvironments.setRegistry([savedRegistryRecord]);
        yield* savedEnvironments.setSecret({
          environmentId: savedRegistryRecord.environmentId,
          secret: "bearer-token",
        });

        yield* savedEnvironments.removeSecret(savedRegistryRecord.environmentId);

        assert.isTrue(
          Option.isNone(yield* savedEnvironments.getSecret(savedRegistryRecord.environmentId)),
        );
      }),
    ),
  );

  it.effect("treats empty saved environment documents as empty", () =>
    withSavedEnvironments(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const savedEnvironments = yield* DesktopSavedEnvironments.DesktopSavedEnvironments;
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(environment.savedEnvironmentRegistryPath, "{}\n");

        assert.deepEqual(yield* savedEnvironments.getRegistry, []);
        assert.isTrue(
          Option.isNone(yield* savedEnvironments.getSecret(savedRegistryRecord.environmentId)),
        );
      }),
    ),
  );

  it.effect("fails closed and preserves malformed saved environment documents", () =>
    withSavedEnvironments(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const savedEnvironments = yield* DesktopSavedEnvironments.DesktopSavedEnvironments;
        const malformedDocument = "{not-json";
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(
          environment.savedEnvironmentRegistryPath,
          malformedDocument,
        );

        const readExit = yield* Effect.exit(savedEnvironments.getRegistry);
        assert.equal(readExit._tag, "Failure");

        const mutationExit = yield* Effect.exit(
          savedEnvironments.setRegistry([savedRegistryRecord]),
        );
        assert.equal(mutationExit._tag, "Failure");
        assert.equal(
          yield* fileSystem.readFileString(environment.savedEnvironmentRegistryPath),
          malformedDocument,
        );
      }),
    ),
  );

  it.effect("fails a mutation without writing when the registry cannot be read", () => {
    const readError = PlatformError.systemError({
      _tag: "PermissionDenied",
      module: "FileSystem",
      method: "readFileString",
      description: "permission denied",
      pathOrDescriptor: "saved-environments.json",
    });
    const writeAttempts: string[] = [];
    let storedBytes = "persisted registry bytes";
    const fileSystemLayer = FileSystem.layerNoop({
      readFileString: () => Effect.fail(readError),
      writeFileString: (path, bytes) =>
        Effect.sync(() => {
          writeAttempts.push(path);
          storedBytes = bytes;
        }),
    });

    return withSavedEnvironments(
      Effect.gen(function* () {
        const savedEnvironments = yield* DesktopSavedEnvironments.DesktopSavedEnvironments;
        const mutationExit = yield* Effect.exit(
          savedEnvironments.setRegistry([savedRegistryRecord]),
        );

        assert.equal(mutationExit._tag, "Failure");
        if (mutationExit._tag === "Failure") {
          const error = Cause.squash(mutationExit.cause);
          assert.instanceOf(error, DesktopSavedEnvironments.DesktopSavedEnvironmentsReadError);
          assert.equal(error.cause, readError);
        }
        assert.deepEqual(writeAttempts, []);
        assert.equal(storedBytes, "persisted registry bytes");
      }),
      { fileSystemLayer },
    );
  });

  it.effect("returns false when writing a secret without metadata", () =>
    withSavedEnvironments(
      Effect.gen(function* () {
        const savedEnvironments = yield* DesktopSavedEnvironments.DesktopSavedEnvironments;

        assert.isFalse(
          yield* savedEnvironments.setSecret({
            environmentId: savedRegistryRecord.environmentId,
            secret: "bearer-token",
          }),
        );
      }),
    ),
  );

  it.effect("preserves encrypted secrets when metadata is rewritten", () =>
    withSavedEnvironments(
      Effect.gen(function* () {
        const savedEnvironments = yield* DesktopSavedEnvironments.DesktopSavedEnvironments;
        yield* savedEnvironments.setRegistry([savedRegistryRecord]);
        yield* savedEnvironments.setSecret({
          environmentId: savedRegistryRecord.environmentId,
          secret: "bearer-token",
        });

        yield* savedEnvironments.setRegistry([savedRegistryRecord]);

        assert.deepEqual(yield* savedEnvironments.getRegistry, [savedRegistryRecord]);
        assert.deepEqual(
          yield* savedEnvironments.getSecret(savedRegistryRecord.environmentId),
          Option.some("bearer-token"),
        );
      }),
    ),
  );

  it.effect("serializes metadata rewrites behind the secret write they preserve", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      let activeBarrier: MutationBarrier | null = null;
      const fileSystemLayer = makeMutationBarrierFileSystemLayer({
        fileSystem,
        getBarrier: () => activeBarrier,
      });

      return yield* withSavedEnvironments(
        Effect.gen(function* () {
          const savedEnvironments = yield* DesktopSavedEnvironments.DesktopSavedEnvironments;
          yield* savedEnvironments.setRegistry([savedRegistryRecord]);

          const secretFirstRecord = {
            ...savedRegistryRecord,
            label: "Metadata written after secret",
          };
          activeBarrier = yield* makeMutationBarrier();
          yield* runConcurrentMutationPair(
            savedEnvironments.setSecret({
              environmentId: savedRegistryRecord.environmentId,
              secret: "first-token",
            }),
            savedEnvironments.setRegistry([secretFirstRecord]),
            activeBarrier,
          );
          activeBarrier = null;

          assert.deepEqual(yield* savedEnvironments.getRegistry, [secretFirstRecord]);
          assert.deepEqual(
            yield* savedEnvironments.getSecret(savedRegistryRecord.environmentId),
            Option.some("first-token"),
          );
        }),
        { fileSystemLayer },
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("serializes secret removal behind the secret write it observes", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      let activeBarrier: MutationBarrier | null = null;
      const fileSystemLayer = makeMutationBarrierFileSystemLayer({
        fileSystem,
        getBarrier: () => activeBarrier,
      });

      return yield* withSavedEnvironments(
        Effect.gen(function* () {
          const savedEnvironments = yield* DesktopSavedEnvironments.DesktopSavedEnvironments;
          yield* savedEnvironments.setRegistry([savedRegistryRecord]);

          activeBarrier = yield* makeMutationBarrier();
          yield* runConcurrentMutationPair(
            savedEnvironments.setSecret({
              environmentId: savedRegistryRecord.environmentId,
              secret: "transient-token",
            }),
            savedEnvironments.removeSecret(savedRegistryRecord.environmentId),
            activeBarrier,
          );
          activeBarrier = null;

          assert.isTrue(
            Option.isNone(yield* savedEnvironments.getSecret(savedRegistryRecord.environmentId)),
          );
        }),
        { fileSystemLayer },
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
