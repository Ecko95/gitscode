// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFs from "node:fs/promises";
import * as Os from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/unstable/process";
import { assert } from "vitest";

import {
  VcsUnsupportedOperationError,
  type VcsListRemotesResult,
  type VcsListWorkspaceFilesResult,
} from "@t3tools/contracts";
import type { VcsDriverShape } from "./VcsDriver.ts";
import { makeSessionScopedVcsDriver } from "./SessionScopedVcsDriver.ts";

// ponytail: epoch timestamp is fine for test stubs — real drivers use DateTime.now
const STUB_FRESHNESS = {
  source: "live-local" as const,
  observedAt: DateTime.makeUnsafe("1970-01-01T00:00:00.000Z") as DateTime.Utc,
  expiresAt: Option.none<DateTime.Utc>(),
};

// Minimal stub — only the fields the guard touches
const makeStubDriver = (): VcsDriverShape => ({
  capabilities: {
    kind: "git",
    supportsWorktrees: true,
    supportsBookmarks: false,
    supportsAtomicSnapshot: false,
    supportsPushDefaultRemote: true,
    ignoreClassifier: "native",
  },
  execute: (input) =>
    Effect.succeed({
      exitCode: ChildProcessSpawner.ExitCode(0),
      stdout: `ok:${input.cwd}`,
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
    }),
  detectRepository: (_cwd) => Effect.succeed(null),
  isInsideWorkTree: (_cwd) => Effect.succeed(true),
  listWorkspaceFiles: (_cwd) =>
    Effect.succeed({
      paths: [] as readonly string[],
      truncated: false,
      freshness: STUB_FRESHNESS,
    } satisfies VcsListWorkspaceFilesResult),
  listRemotes: (_cwd) =>
    Effect.succeed({
      remotes: [],
      freshness: STUB_FRESHNESS,
    } satisfies VcsListRemotesResult),
  filterIgnoredPaths: (_cwd, paths) => Effect.succeed(paths),
  initRepository: (_input) => Effect.void,
});

const ALLOWED = "/workspace/session-abc";

// Layer that provides Path + FileSystem (via NodeServices) for the session driver factory
const testLayer = Layer.mergeAll(Path.layer, NodeServices.layer);

// Construct a session driver in Effect context
const makeDriver = (options?: { root?: string; supervisorOverride?: boolean }) => {
  const driverOptions: import("./SessionScopedVcsDriver.ts").SessionScopedVcsDriverOptions =
    options?.supervisorOverride !== undefined
      ? { allowedRoot: options?.root ?? ALLOWED, supervisorOverride: options.supervisorOverride }
      : { allowedRoot: options?.root ?? ALLOWED };
  return makeSessionScopedVcsDriver(makeStubDriver(), driverOptions).pipe(
    Effect.provide(testLayer),
  );
};

describe("SessionScopedVcsDriver", () => {
  describe("path containment", () => {
    it.effect("allows cwd exactly equal to allowedRoot", () =>
      Effect.gen(function* () {
        const driver = yield* makeDriver();
        const result = yield* driver.isInsideWorkTree(ALLOWED);
        assert.isTrue(result);
      }),
    );

    it.effect("allows cwd inside allowedRoot", () =>
      Effect.gen(function* () {
        const driver = yield* makeDriver();
        const result = yield* driver.isInsideWorkTree(`${ALLOWED}/src`);
        assert.isTrue(result);
      }),
    );

    it.effect("rejects cwd outside allowedRoot", () =>
      Effect.gen(function* () {
        const driver = yield* makeDriver();
        const err = yield* Effect.flip(driver.isInsideWorkTree("/workspace/other-session"));
        assert.instanceOf(err, VcsUnsupportedOperationError);
        assert.include(err.operation, "session-guard.path-check");
      }),
    );

    it.effect("rejects ../traversal that escapes allowedRoot", () =>
      Effect.gen(function* () {
        const driver = yield* makeDriver();
        // path.resolve normalises /workspace/session-abc/../escape → /workspace/escape
        const err = yield* Effect.flip(driver.listWorkspaceFiles(`${ALLOWED}/../escape`));
        assert.instanceOf(err, VcsUnsupportedOperationError);
        assert.include(err.operation, "session-guard.path-check");
      }),
    );

    it.effect("allows deeper nested path inside allowedRoot", () =>
      Effect.gen(function* () {
        const driver = yield* makeDriver();
        const result = yield* driver.execute({
          operation: "test",
          cwd: `${ALLOWED}/deep/nested/dir`,
          args: ["status"],
        });
        assert.strictEqual(result.stdout, `ok:${ALLOWED}/deep/nested/dir`);
      }),
    );

    it.effect("rejects cwd that is a prefix match but not a child (no trailing-slash bypass)", () =>
      Effect.gen(function* () {
        // /workspace/session-abc-evil must NOT pass as a child of /workspace/session-abc
        const driver = yield* makeDriver();
        const err = yield* Effect.flip(driver.isInsideWorkTree("/workspace/session-abc-evil"));
        assert.instanceOf(err, VcsUnsupportedOperationError);
      }),
    );
  });

  describe("force-push to protected branch", () => {
    it.effect("rejects force-push to main", () =>
      Effect.gen(function* () {
        const driver = yield* makeDriver();
        const err = yield* Effect.flip(
          driver.execute({
            operation: "test-push",
            cwd: ALLOWED,
            args: ["push", "--force", "origin", "main"],
          }),
        );
        assert.instanceOf(err, VcsUnsupportedOperationError);
        assert.include(err.operation, "session-guard.force-push");
      }),
    );

    it.effect("rejects force-push to master", () =>
      Effect.gen(function* () {
        const driver = yield* makeDriver();
        const err = yield* Effect.flip(
          driver.execute({
            operation: "test-push",
            cwd: ALLOWED,
            args: ["push", "--force", "origin", "master"],
          }),
        );
        assert.instanceOf(err, VcsUnsupportedOperationError);
        assert.include(err.operation, "session-guard.force-push");
      }),
    );

    it.effect("rejects force-push to gits", () =>
      Effect.gen(function* () {
        const driver = yield* makeDriver();
        const err = yield* Effect.flip(
          driver.execute({
            operation: "test-push",
            cwd: ALLOWED,
            args: ["push", "--force", "origin", "gits"],
          }),
        );
        assert.instanceOf(err, VcsUnsupportedOperationError);
        assert.include(err.operation, "session-guard.force-push");
      }),
    );

    it.effect("allows force-push to non-protected branch", () =>
      Effect.gen(function* () {
        const driver = yield* makeDriver();
        const result = yield* driver.execute({
          operation: "test-push",
          cwd: ALLOWED,
          args: ["push", "--force", "origin", "feat/my-feature"],
        });
        assert.strictEqual(result.stdout, `ok:${ALLOWED}`);
      }),
    );

    it.effect("allows force-push to protected branch with supervisorOverride=true", () =>
      Effect.gen(function* () {
        const driver = yield* makeDriver({ supervisorOverride: true });
        const result = yield* driver.execute({
          operation: "test-push",
          cwd: ALLOWED,
          args: ["push", "--force", "origin", "main"],
        });
        assert.strictEqual(result.stdout, `ok:${ALLOWED}`);
      }),
    );

    it.effect("allows normal push to protected branch (no --force)", () =>
      Effect.gen(function* () {
        const driver = yield* makeDriver();
        const result = yield* driver.execute({
          operation: "test-push",
          cwd: ALLOWED,
          args: ["push", "origin", "main"],
        });
        assert.strictEqual(result.stdout, `ok:${ALLOWED}`);
      }),
    );

    it.effect("rejects --force-with-lease to protected branch", () =>
      Effect.gen(function* () {
        const driver = yield* makeDriver();
        const err = yield* Effect.flip(
          driver.execute({
            operation: "test-push",
            cwd: ALLOWED,
            args: ["push", "--force-with-lease", "origin", "main"],
          }),
        );
        assert.instanceOf(err, VcsUnsupportedOperationError);
        assert.include(err.operation, "session-guard.force-push");
      }),
    );
  });

  describe("merge/rebase deny", () => {
    it.effect("denies git merge from session driver", () =>
      Effect.gen(function* () {
        const driver = yield* makeDriver();
        const err = yield* Effect.flip(
          driver.execute({
            operation: "test-merge",
            cwd: ALLOWED,
            args: ["merge", "origin/main"],
          }),
        );
        assert.instanceOf(err, VcsUnsupportedOperationError);
        assert.include(err.operation, "session-guard.merge-denied");
      }),
    );

    it.effect("denies git rebase from session driver", () =>
      Effect.gen(function* () {
        const driver = yield* makeDriver();
        const err = yield* Effect.flip(
          driver.execute({
            operation: "test-rebase",
            cwd: ALLOWED,
            args: ["rebase", "main"],
          }),
        );
        assert.instanceOf(err, VcsUnsupportedOperationError);
        assert.include(err.operation, "session-guard.rebase-denied");
      }),
    );

    it.effect("allows git commit (non-blocked subcommand)", () =>
      Effect.gen(function* () {
        const driver = yield* makeDriver();
        const result = yield* driver.execute({
          operation: "test-commit",
          cwd: ALLOWED,
          args: ["commit", "-m", "test"],
        });
        assert.strictEqual(result.stdout, `ok:${ALLOWED}`);
      }),
    );
  });

  describe("symlink escape hardening", () => {
    it.effect("rejects cwd that resolves via symlink to outside allowedRoot", () =>
      // Creates a real symlink on disk: <tmpdir>/session/escape-link -> <tmpdir>/outside
      // Then verifies the guard catches it via fs.realPath.
      Effect.gen(function* () {
        const tmp = yield* Effect.tryPromise(() =>
          NodeFs.mkdtemp(NodePath.join(Os.tmpdir(), "ssvd-")),
        );
        const sessionRoot = NodePath.join(tmp, "session");
        const outside = NodePath.join(tmp, "outside");
        const symlinkPath = NodePath.join(sessionRoot, "escape-link");
        yield* Effect.tryPromise(async () => {
          await NodeFs.mkdir(sessionRoot, { recursive: true });
          await NodeFs.mkdir(outside, { recursive: true });
          await NodeFs.symlink(outside, symlinkPath);
        });
        try {
          const driver = yield* makeSessionScopedVcsDriver(makeStubDriver(), {
            allowedRoot: sessionRoot,
          }).pipe(Effect.provide(testLayer));
          const err = yield* Effect.flip(driver.isInsideWorkTree(symlinkPath));
          assert.instanceOf(err, VcsUnsupportedOperationError);
          assert.include(err.operation, "session-guard.symlink-escape");
        } finally {
          yield* Effect.tryPromise(() => NodeFs.rm(tmp, { recursive: true, force: true })).pipe(
            Effect.ignore,
          );
        }
      }),
    );

    it.effect("allows cwd that is a real path inside allowedRoot (no symlink)", () =>
      Effect.gen(function* () {
        const tmp = yield* Effect.tryPromise(() =>
          NodeFs.mkdtemp(NodePath.join(Os.tmpdir(), "ssvd-")),
        );
        const sessionRoot = NodePath.join(tmp, "session");
        const subDir = NodePath.join(sessionRoot, "src");
        yield* Effect.tryPromise(() => NodeFs.mkdir(subDir, { recursive: true }));
        try {
          const driver = yield* makeSessionScopedVcsDriver(makeStubDriver(), {
            allowedRoot: sessionRoot,
          }).pipe(Effect.provide(testLayer));
          // Should pass — real path is inside the root
          const result = yield* driver.isInsideWorkTree(subDir);
          assert.isTrue(result);
        } finally {
          yield* Effect.tryPromise(() => NodeFs.rm(tmp, { recursive: true, force: true })).pipe(
            Effect.ignore,
          );
        }
      }),
    );
  });

  describe("force-push refspec hardening", () => {
    it.effect("rejects HEAD:main refspec with --force", () =>
      Effect.gen(function* () {
        const driver = yield* makeDriver();
        const err = yield* Effect.flip(
          driver.execute({
            operation: "test-push",
            cwd: ALLOWED,
            args: ["push", "--force", "origin", "HEAD:main"],
          }),
        );
        assert.instanceOf(err, VcsUnsupportedOperationError);
        assert.include(err.operation, "session-guard.force-push");
      }),
    );

    it.effect("rejects refs/heads/main refspec with --force", () =>
      Effect.gen(function* () {
        const driver = yield* makeDriver();
        const err = yield* Effect.flip(
          driver.execute({
            operation: "test-push",
            cwd: ALLOWED,
            args: ["push", "--force", "origin", "refs/heads/main"],
          }),
        );
        assert.instanceOf(err, VcsUnsupportedOperationError);
        assert.include(err.operation, "session-guard.force-push");
      }),
    );

    it.effect("rejects implicit --force push (no refspec)", () =>
      Effect.gen(function* () {
        const driver = yield* makeDriver();
        const err = yield* Effect.flip(
          driver.execute({
            operation: "test-push",
            cwd: ALLOWED,
            // No refspec — implicit tracking push
            args: ["push", "--force", "origin"],
          }),
        );
        assert.instanceOf(err, VcsUnsupportedOperationError);
        assert.include(err.operation, "session-guard.force-push");
        assert.include(err.detail, "implicit force-push");
      }),
    );

    it.effect("allows HEAD:feature-branch refspec with --force (non-protected)", () =>
      Effect.gen(function* () {
        const driver = yield* makeDriver();
        const result = yield* driver.execute({
          operation: "test-push",
          cwd: ALLOWED,
          args: ["push", "--force", "origin", "HEAD:feat/my-feature"],
        });
        assert.strictEqual(result.stdout, `ok:${ALLOWED}`);
      }),
    );

    it.effect("supervisorOverride bypasses implicit force-push rejection", () =>
      Effect.gen(function* () {
        const driver = yield* makeDriver({ supervisorOverride: true });
        const result = yield* driver.execute({
          operation: "test-push",
          cwd: ALLOWED,
          args: ["push", "--force", "origin"],
        });
        assert.strictEqual(result.stdout, `ok:${ALLOWED}`);
      }),
    );
  });
});
