import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { makeGitsBuildInfoResolver } from "./GitsBuildInfo.ts";

describe("GitsBuildInfoResolverLive", () => {
  it.effect("prefers the configured metadata file over environment variables", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-gits-build-info-",
      });
      const filePath = path.join(tempDir, "build-info.json");
      yield* fileSystem.writeFileString(
        filePath,
        `{"branch":"feat/file","commitSha":"file-commit","buildTimeUtc":"2026-06-02T10:00:00.000Z","trackedDirty":false,"worktree":"/srv/file-build"}`,
      );

      const resolver = yield* makeGitsBuildInfoResolver({
        env: {
          GITS_BUILD_INFO_PATH: filePath,
          GITS_BUILD_BRANCH: "feat/env",
          GITS_BUILD_COMMIT: "env-commit",
          GITS_BUILD_TIME: "2026-06-01T10:00:00.000Z",
          GITS_BUILD_DIRTY: "true",
          GITS_BUILD_SOURCE_PATH: "/srv/env-build",
        },
      });
      const buildInfo = yield* resolver.getBuildInfo();

      expect(buildInfo).toEqual({
        branch: "feat/file",
        commit: "file-commit",
        time: "2026-06-02T10:00:00.000Z",
        dirty: false,
        sourcePath: "/srv/file-build",
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("falls back to environment variables when no metadata file is configured", () =>
    Effect.gen(function* () {
      const resolver = yield* makeGitsBuildInfoResolver({
        env: {
          GITS_BUILD_BRANCH: "feat/env",
          GITS_BUILD_COMMIT: "env-commit",
          GITS_BUILD_TIME: "2026-06-02T11:00:00.000Z",
          GITS_BUILD_DIRTY: "true",
          GITS_BUILD_SOURCE_PATH: "/srv/env-build",
        },
      });
      const buildInfo = yield* resolver.getBuildInfo();

      expect(buildInfo).toEqual({
        branch: "feat/env",
        commit: "env-commit",
        time: "2026-06-02T11:00:00.000Z",
        dirty: true,
        sourcePath: "/srv/env-build",
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
