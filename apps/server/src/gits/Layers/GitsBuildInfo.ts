import { GitsBuildInfo as GitsBuildInfoSchema, type GitsBuildInfo } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import {
  GitsBuildInfoResolver,
  GitsBuildInfoResolverError,
  type GitsBuildInfoResolverShape,
} from "../Services/GitsBuildInfo.ts";

export interface GitsBuildInfoResolverOptions {
  readonly env?: NodeJS.ProcessEnv;
}

const decodeGitsBuildInfo = Schema.decodeUnknownSync(GitsBuildInfoSchema);
const decodeUnknownJsonString = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);
const isGitsBuildInfoResolverError = Schema.is(GitsBuildInfoResolverError);

function readOptionalEnvString(env: NodeJS.ProcessEnv, name: string): string | null {
  const value = env[name]?.trim();
  return value && value.length > 0 ? value : null;
}

function normalizeOptionalString(fieldName: string, value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new GitsBuildInfoResolverError({
      message: `Expected ${fieldName} to be a string.`,
    });
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeOptionalBoolean(fieldName: string, value: unknown): boolean | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "boolean") {
    throw new GitsBuildInfoResolverError({
      message: `Expected ${fieldName} to be a boolean.`,
    });
  }
  return value;
}

function readOptionalEnvBoolean(env: NodeJS.ProcessEnv, name: string): boolean | null {
  const value = env[name]?.trim().toLowerCase();
  if (!value) {
    return null;
  }
  if (value === "1" || value === "true" || value === "yes" || value === "on") {
    return true;
  }
  if (value === "0" || value === "false" || value === "no" || value === "off") {
    return false;
  }
  throw new GitsBuildInfoResolverError({
    message: `Expected ${name} to be a boolean string.`,
  });
}

function decodeNormalizedBuildInfo(input: {
  readonly branch: string | null;
  readonly commit: string | null;
  readonly time: string | null;
  readonly dirty: boolean | null;
  readonly sourcePath: string | null;
}): GitsBuildInfo {
  try {
    return decodeGitsBuildInfo(input);
  } catch (cause) {
    throw new GitsBuildInfoResolverError({
      message: "Failed to decode GITS build metadata.",
      cause,
    });
  }
}

function decodeBuildInfoJson(input: unknown): GitsBuildInfo {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new GitsBuildInfoResolverError({
      message: "Expected GITS build metadata JSON object.",
    });
  }

  const record = input as Record<string, unknown>;
  return decodeNormalizedBuildInfo({
    branch: normalizeOptionalString("branch", record.branch),
    commit: normalizeOptionalString("commit", record.commit),
    time: normalizeOptionalString("time", record.time ?? record.buildTime),
    dirty: normalizeOptionalBoolean("dirty", record.dirty),
    sourcePath: normalizeOptionalString("sourcePath", record.sourcePath),
  });
}

function decodeBuildInfoEnv(env: NodeJS.ProcessEnv): GitsBuildInfo {
  return decodeNormalizedBuildInfo({
    branch: readOptionalEnvString(env, "GITS_BUILD_BRANCH"),
    commit: readOptionalEnvString(env, "GITS_BUILD_COMMIT"),
    time: readOptionalEnvString(env, "GITS_BUILD_TIME"),
    dirty: readOptionalEnvBoolean(env, "GITS_BUILD_DIRTY"),
    sourcePath: readOptionalEnvString(env, "GITS_BUILD_SOURCE_PATH"),
  });
}

const readBuildInfoFile = (
  fileSystem: FileSystem.FileSystem,
  filePath: string,
): Effect.Effect<GitsBuildInfo, GitsBuildInfoResolverError> =>
  Effect.gen(function* () {
    const raw = yield* fileSystem.readFileString(filePath).pipe(
      Effect.mapError(
        (cause) =>
          new GitsBuildInfoResolverError({
            message: `Failed to read GITS build metadata file: ${filePath}.`,
            cause,
          }),
      ),
    );

    const parsed = yield* decodeUnknownJsonString(raw).pipe(
      Effect.mapError(
        (cause) =>
          new GitsBuildInfoResolverError({
            message: `Failed to parse GITS build metadata file: ${filePath}.`,
            cause,
          }),
      ),
    );

    return yield* Effect.try({
      try: () => decodeBuildInfoJson(parsed),
      catch: (cause) =>
        isGitsBuildInfoResolverError(cause)
          ? cause
          : new GitsBuildInfoResolverError({
              message: `Failed to decode GITS build metadata file: ${filePath}.`,
              cause,
            }),
    });
  });

export const makeGitsBuildInfoResolver = (options?: GitsBuildInfoResolverOptions) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return GitsBuildInfoResolver.of({
      getBuildInfo: () => {
        const env = options?.env ?? process.env;
        const filePath = env.GITS_BUILD_INFO_PATH?.trim();
        if (filePath && filePath.length > 0) {
          return readBuildInfoFile(fileSystem, filePath);
        }
        return Effect.try({
          try: () => decodeBuildInfoEnv(env),
          catch: (cause) =>
            isGitsBuildInfoResolverError(cause)
              ? cause
              : new GitsBuildInfoResolverError({
                  message: "Failed to decode GITS build metadata from environment variables.",
                  cause,
                }),
        });
      },
    } satisfies GitsBuildInfoResolverShape);
  });

export const GitsBuildInfoResolverLive = Layer.effect(
  GitsBuildInfoResolver,
  makeGitsBuildInfoResolver(),
);
