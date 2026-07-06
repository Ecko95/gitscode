import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const textEncoder = new TextEncoder();

export const writeFileStringAtomically = (input: {
  readonly filePath: string;
  readonly contents: string;
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const targetDirectory = path.dirname(input.filePath);

      yield* fs.makeDirectory(targetDirectory, { recursive: true });
      const tempDirectory = yield* fs.makeTempDirectoryScoped({
        directory: targetDirectory,
        prefix: `${path.basename(input.filePath)}.`,
      });
      const tempPath = path.join(tempDirectory, "contents.tmp");

      const tempFile = yield* fs.open(tempPath, { flag: "w" });
      yield* tempFile.writeAll(textEncoder.encode(input.contents));
      yield* tempFile.sync;
      yield* fs.rename(tempPath, input.filePath);
      yield* fs.open(targetDirectory, { flag: "r" }).pipe(
        Effect.andThen((directory) => directory.sync),
        Effect.catch(() => Effect.void),
      );
    }),
  );
