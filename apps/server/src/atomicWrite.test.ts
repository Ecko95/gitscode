import { describe, it, assert } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { writeFileStringAtomically } from "./atomicWrite.ts";

function mockFile(path: string, calls: Array<string>): FileSystem.File {
  return {
    [FileSystem.FileTypeId]: FileSystem.FileTypeId,
    fd: FileSystem.FileDescriptor(1),
    stat: Effect.die("not implemented"),
    seek: () => Effect.void,
    sync: Effect.sync(() => {
      calls.push(`sync:${path}`);
    }),
    read: () => Effect.succeed(FileSystem.Size(0)),
    readAlloc: () => Effect.succeed(Option.none()),
    truncate: () => Effect.void,
    write: () => Effect.succeed(FileSystem.Size(0)),
    writeAll: () =>
      Effect.sync(() => {
        calls.push(`writeAll:${path}`);
      }),
  };
}

describe("writeFileStringAtomically", () => {
  it.effect("fsyncs the temp file before rename and best-effort syncs the target directory", () => {
    const calls: Array<string> = [];
    const fileSystem = FileSystem.layerNoop({
      makeDirectory: (directory) =>
        Effect.sync(() => {
          calls.push(`makeDirectory:${directory}`);
        }),
      makeTempDirectoryScoped: (options) =>
        Effect.sync(() => `${options?.directory ?? "."}/${options?.prefix ?? ""}temp`),
      open: (path, options) =>
        Effect.sync(() => {
          calls.push(`open:${path}:${options?.flag ?? ""}`);
          return mockFile(path, calls);
        }),
      rename: (oldPath, newPath) =>
        Effect.sync(() => {
          calls.push(`rename:${oldPath}:${newPath}`);
        }),
    });

    return Effect.gen(function* () {
      yield* writeFileStringAtomically({
        filePath: "/target/settings.json",
        contents: "updated",
      });

      const writeCall = calls.findIndex((call) => call.startsWith("writeAll:"));
      const tempSyncCall = calls.findIndex((call) =>
        call.startsWith("sync:/target/settings.json.temp/contents.tmp"),
      );
      const renameCall = calls.findIndex((call) => call.startsWith("rename:"));
      const directorySyncCall = calls.findIndex((call) => call === "sync:/target");

      assert.isAtLeast(writeCall, 0);
      assert.isAtLeast(tempSyncCall, 0);
      assert.isAtLeast(renameCall, 0);
      assert.isAtLeast(directorySyncCall, 0);
      assert.isBelow(writeCall, tempSyncCall);
      assert.isBelow(tempSyncCall, renameCall);
      assert.isBelow(renameCall, directorySyncCall);
    }).pipe(Effect.provide(Layer.mergeAll(fileSystem, Path.layer)));
  });
});
