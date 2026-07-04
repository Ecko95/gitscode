/**
 * GitShimManager unit tests.
 *
 * Tests: shim creation, env vars shape, server PATH isolation, session teardown.
 */
import * as nodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { ServerConfig } from "../config.ts";
import { GitShimManager, GitShimManagerLive } from "./GitShimManager.ts";

// ── Shared test layer ─────────────────────────────────────────────────────────
// Provides GitShimManager + FileSystem + Path + ServerConfig to all tests.
// ServerConfig.layerTest creates a scoped temp dir for baseDir.
// NodeServices provides FileSystem + Path needed by both ServerConfig and GitShimManagerLive.

const testLayer = GitShimManagerLive.pipe(
	Layer.provideMerge(
		ServerConfig.layerTest(process.cwd(), { prefix: "gits-shim-test-" }).pipe(
			Layer.provideMerge(NodeServices.layer),
		),
	),
);

it.layer(testLayer)("GitShimManager", (it) => {
	describe("allocate", () => {
		it.effect("creates shim env vars and an executable shim file", () =>
			Effect.gen(function* () {
				const mgr = yield* GitShimManager;
				const nodeFs = yield* FileSystem.FileSystem;
				const config = yield* ServerConfig;

				const sessionId = "test-alloc-1";
				const allowedRoot = config.baseDir;
				const result = yield* mgr.allocate(sessionId, allowedRoot);

				// PATH must prepend the shim dir
				const shimDir = nodePath.join(config.baseDir, "gits-shims", sessionId);
				const pathEntries = (result.vars["PATH"] ?? "").split(nodePath.delimiter);
				if (pathEntries[0] !== shimDir) {
					throw new Error(`Expected PATH to start with '${shimDir}', got '${pathEntries[0]}'`);
				}

				// GITS_REAL_GIT must be non-empty
				if (!result.vars["GITS_REAL_GIT"]) {
					throw new Error("Expected GITS_REAL_GIT to be set");
				}

				// GITS_ALLOWED_ROOT must match session cwd
				if (result.vars["GITS_ALLOWED_ROOT"] !== allowedRoot) {
					throw new Error(`Expected GITS_ALLOWED_ROOT '${allowedRoot}', got '${result.vars["GITS_ALLOWED_ROOT"]}'`);
				}

				// GITS_PROTECTED_BRANCHES must contain standard set
				const branches = result.vars["GITS_PROTECTED_BRANCHES"] ?? "";
				if (!branches.includes("main") || !branches.includes("gits")) {
					throw new Error(`Expected protected branches to include main,gits. Got: ${branches}`);
				}

				// Shim file must exist
				const shimPath = nodePath.join(shimDir, "git");
				const stat = yield* nodeFs.stat(shimPath);
				if (stat.type !== "File") {
					throw new Error(`Expected shim at ${shimPath} to be a file, got ${stat.type}`);
				}

				yield* mgr.release(sessionId);
			}),
		);

		it.effect("shim script starts with #!/bin/sh and contains policy env vars", () =>
			Effect.gen(function* () {
				const mgr = yield* GitShimManager;
				const nodeFs = yield* FileSystem.FileSystem;
				const config = yield* ServerConfig;
				const sessionId = "test-script-header";

				yield* mgr.allocate(sessionId, config.baseDir);
				const shimPath = nodePath.join(config.baseDir, "gits-shims", sessionId, "git");
				const content = yield* nodeFs.readFileString(shimPath);

				if (!content.startsWith("#!/bin/sh")) {
					throw new Error("Shim script must start with #!/bin/sh");
				}
				if (!content.includes("GITS_REAL_GIT") || !content.includes("GITS_ALLOWED_ROOT")) {
					throw new Error("Shim script must reference policy env vars");
				}

				yield* mgr.release(sessionId);
			}),
		);
	});

	describe("release", () => {
		it.effect("removes the shim directory", () =>
			Effect.gen(function* () {
				const mgr = yield* GitShimManager;
				const nodeFs = yield* FileSystem.FileSystem;
				const config = yield* ServerConfig;
				const sessionId = "test-session-release";

				yield* mgr.allocate(sessionId, config.baseDir);
				const shimDir = nodePath.join(config.baseDir, "gits-shims", sessionId);

				const existsBefore = yield* nodeFs.stat(shimDir).pipe(
					Effect.map(() => true),
					Effect.catch(() => Effect.succeed(false)),
				);
				if (!existsBefore) {
					throw new Error("Shim dir should exist after allocate");
				}

				yield* mgr.release(sessionId);

				const existsAfter = yield* nodeFs.stat(shimDir).pipe(
					Effect.map(() => true),
					Effect.catch(() => Effect.succeed(false)),
				);
				if (existsAfter) {
					throw new Error("Shim dir should be removed after release");
				}
			}),
		);

		it.effect("is a no-op for unknown session ids", () =>
			Effect.gen(function* () {
				const mgr = yield* GitShimManager;
				// Should not throw
				yield* mgr.release("nonexistent-session-xyz");
			}),
		);
	});

	describe("PATH isolation", () => {
		it.effect("server process.env.PATH is unchanged after allocate/release", () =>
			Effect.gen(function* () {
				const mgr = yield* GitShimManager;
				const config = yield* ServerConfig;
				const originalPath = process.env["PATH"];

				yield* mgr.allocate("test-path-isolation", config.baseDir);

				if (process.env["PATH"] !== originalPath) {
					throw new Error("server PATH was mutated by allocate");
				}

				yield* mgr.release("test-path-isolation");

				if (process.env["PATH"] !== originalPath) {
					throw new Error("server PATH was mutated by release");
				}
			}),
		);
	});

	describe("sweepStale", () => {
		it.effect("is a no-op when shimsRoot subdir does not yet exist", () =>
			Effect.gen(function* () {
				const mgr = yield* GitShimManager;
				// baseDir exists (created by ServerConfig.layerTest) but gits-shims/ subdir does not.
				// sweepStale must not throw.
				yield* mgr.sweepStale();
			}),
		);
	});
});
