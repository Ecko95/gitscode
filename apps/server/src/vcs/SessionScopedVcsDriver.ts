import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { VcsUnsupportedOperationError } from "@t3tools/contracts";
import type * as VcsDriver from "./VcsDriver.ts";

// ponytail: protected branch set is a constant — add env-var knob if multi-repo operator needs differ
const PROTECTED_BRANCHES = new Set(["main", "master", "gits"]);

export interface SessionScopedVcsDriverOptions {
  /** Absolute path the session is confined to. All `cwd` arguments must resolve inside it. */
  readonly allowedRoot: string;
  /**
   * When true, force-push to protected branches is permitted.
   * Set only by the supervisor for integration operations.
   */
  readonly supervisorOverride?: boolean;
}

/**
 * Wraps a VcsDriverShape and confines all operations to `allowedRoot`.
 *
 * Guards applied:
 *  1. cwd containment — every `cwd` argument must resolve inside `allowedRoot` (blocks `../` traversal)
 *  2. force-push guard — `git push --force` / `--force-with-lease` to a protected branch is
 *     rejected unless `supervisorOverride` is set
 *  3. merge/rebase deny — `git merge` and `git rebase` via `execute` are denied from session
 *     context; integration routes through the supervisor's AutomodeLanding machinery instead
 *
 * The wrapper delegates all passing calls to the underlying driver unchanged.
 * For non-session (server/supervisor) drivers, use the underlying driver directly.
 */
export const makeSessionScopedVcsDriver = Effect.fn("makeSessionScopedVcsDriver")(function* (
  underlying: VcsDriver.VcsDriverShape,
  options: SessionScopedVcsDriverOptions,
) {
  const pathService = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const supervisorOverride = options.supervisorOverride ?? false;

  // Normalize allowedRoot once: strip trailing slash so startsWith checks are exact.
  const root = options.allowedRoot.endsWith("/")
    ? options.allowedRoot.slice(0, -1)
    : options.allowedRoot;

  function assertCwd(
    operation: string,
    cwd: string,
  ): Effect.Effect<void, VcsUnsupportedOperationError> {
    // Fast-path: resolve `..` segments synchronously (handles ../traversal attacks).
    const resolved = pathService.resolve(cwd);
    const fastOk = resolved === root || resolved.startsWith(root + "/");
    if (!fastOk) {
      return Effect.fail(
        new VcsUnsupportedOperationError({
          operation: `session-guard.path-check:${operation}`,
          kind: underlying.capabilities.kind,
          detail: `cwd '${cwd}' (resolved: '${resolved}') is outside allowed root '${root}'`,
        }),
      );
    }
    // Symlink-escape check: resolve real path to catch symlinks inside the worktree
    // that point outside it. Falls back to cwd on ENOENT (path doesn't exist yet —
    // e.g. a new file about to be created); if the path doesn't exist there's no
    // symlink to escape through, so the fast-path check is sufficient.
    // ponytail: realPath check catches symlink escapes; ceiling is TOCTOU on very fast
    //           concurrent symlink swaps — acceptable for session-scoped confinement.
    return fs.realPath(cwd).pipe(
      Effect.orElseSucceed(() => cwd), // ENOENT/ENOTDIR — path doesn't exist, no symlink
      Effect.flatMap((real) => {
        const realOk = real === root || real.startsWith(root + "/");
        if (realOk) return Effect.void;
        return Effect.fail(
          new VcsUnsupportedOperationError({
            operation: `session-guard.symlink-escape:${operation}`,
            kind: underlying.capabilities.kind,
            detail: `cwd '${cwd}' resolves via symlink to '${real}' which is outside allowed root '${root}'`,
          }),
        );
      }),
    );
  }

  function assertNotForcePushToProtected(
    args: ReadonlyArray<string>,
  ): Effect.Effect<void, VcsUnsupportedOperationError> {
    if (supervisorOverride) return Effect.void;

    const subcommand = args[0];
    if (subcommand !== "push") return Effect.void;

    const hasForce = args.some(
      (a) => a === "--force" || a === "-f" || a.startsWith("--force-with-lease"),
    );
    if (!hasForce) return Effect.void;

    // Collect explicit refspec args (non-flag, non-remote positional args).
    // Skip the remote name (first non-flag after "push") — remaining are refspecs.
    const refspecs: string[] = [];
    let remoteSkipped = false;
    for (const arg of args) {
      if (arg === "push") continue;
      if (arg.startsWith("-")) continue;
      if (!remoteSkipped) {
        remoteSkipped = true; // first non-flag positional = remote name
        continue;
      }
      refspecs.push(arg);
    }

    if (refspecs.length === 0) {
      // Implicit upstream push with --force: we cannot cheaply resolve the tracking branch here.
      // Reject outright — confined sessions have no business force-pushing implicitly.
      // ponytail: blanket reject implicit --force push; upgrade to tracking-branch resolution
      //           if a session legitimately needs implicit force-push (none today).
      return Effect.fail(
        new VcsUnsupportedOperationError({
          operation: "session-guard.force-push",
          kind: underlying.capabilities.kind,
          detail:
            "implicit force-push (no explicit refspec) is not allowed from a session-scoped driver; specify the branch explicitly",
        }),
      );
    }

    // Check each refspec. Handles:
    //   <branch>              → remote ref = <branch>
    //   <local>:<remote>      → remote ref = <remote>
    //   HEAD:<remote>         → remote ref = <remote>
    //   refs/heads/<branch>   → normalized
    for (const refspec of refspecs) {
      const colonIdx = refspec.indexOf(":");
      const remotePart = colonIdx !== -1 ? refspec.slice(colonIdx + 1) : refspec;
      // Strip refs/heads/ prefix and empty (delete) refspec ":<branch>"
      const bare = remotePart.replace(/^refs\/heads\//, "");
      if (bare.length > 0 && PROTECTED_BRANCHES.has(bare)) {
        return Effect.fail(
          new VcsUnsupportedOperationError({
            operation: "session-guard.force-push",
            kind: underlying.capabilities.kind,
            detail: `force-push to protected branch '${bare}' is not allowed from a session-scoped driver`,
          }),
        );
      }
    }
    return Effect.void;
  }

  function assertNotMergeOrRebase(
    args: ReadonlyArray<string>,
  ): Effect.Effect<void, VcsUnsupportedOperationError> {
    const subcommand = args[0];
    // ponytail: deny merge+rebase from session — integration routes through AutomodeLanding
    //           supervisor machinery; add W5.3 actor-identity check when contracts carry it
    if (subcommand === "merge" || subcommand === "rebase") {
      return Effect.fail(
        new VcsUnsupportedOperationError({
          operation: `session-guard.${subcommand}-denied`,
          kind: underlying.capabilities.kind,
          detail: `'git ${subcommand}' is not permitted from a session-scoped driver; route through the supervisor integration command`,
        }),
      );
    }
    return Effect.void;
  }

  const execute: VcsDriver.VcsDriverShape["execute"] = (input) =>
    assertCwd("execute", input.cwd).pipe(
      Effect.flatMap(() => assertNotForcePushToProtected(input.args)),
      Effect.flatMap(() => assertNotMergeOrRebase(input.args)),
      Effect.flatMap(() => underlying.execute(input)),
    );

  const detectRepository: VcsDriver.VcsDriverShape["detectRepository"] = (cwd) =>
    assertCwd("detectRepository", cwd).pipe(Effect.flatMap(() => underlying.detectRepository(cwd)));

  const isInsideWorkTree: VcsDriver.VcsDriverShape["isInsideWorkTree"] = (cwd) =>
    assertCwd("isInsideWorkTree", cwd).pipe(Effect.flatMap(() => underlying.isInsideWorkTree(cwd)));

  const listWorkspaceFiles: VcsDriver.VcsDriverShape["listWorkspaceFiles"] = (cwd) =>
    assertCwd("listWorkspaceFiles", cwd).pipe(
      Effect.flatMap(() => underlying.listWorkspaceFiles(cwd)),
    );

  const listRemotes: VcsDriver.VcsDriverShape["listRemotes"] = (cwd) =>
    assertCwd("listRemotes", cwd).pipe(Effect.flatMap(() => underlying.listRemotes(cwd)));

  const filterIgnoredPaths: VcsDriver.VcsDriverShape["filterIgnoredPaths"] = (cwd, relativePaths) =>
    assertCwd("filterIgnoredPaths", cwd).pipe(
      Effect.flatMap(() => underlying.filterIgnoredPaths(cwd, relativePaths)),
    );

  const initRepository: VcsDriver.VcsDriverShape["initRepository"] = (input) =>
    assertCwd("initRepository", input.cwd).pipe(
      Effect.flatMap(() => underlying.initRepository(input)),
    );

  const wrappedDiffPreview: VcsDriver.VcsDriverShape["getDiffPreview"] = underlying.getDiffPreview
    ? (input) =>
        assertCwd("getDiffPreview", input.cwd).pipe(
          Effect.flatMap(() => underlying.getDiffPreview!(input)),
        )
    : undefined;

  const wrappedCheckpoints: VcsDriver.VcsDriverShape["checkpoints"] = underlying.checkpoints
    ? {
        captureCheckpoint: (input) =>
          assertCwd("checkpoints.captureCheckpoint", input.cwd).pipe(
            Effect.flatMap(() => underlying.checkpoints!.captureCheckpoint(input)),
          ),
        hasCheckpointRef: (input) =>
          assertCwd("checkpoints.hasCheckpointRef", input.cwd).pipe(
            Effect.flatMap(() => underlying.checkpoints!.hasCheckpointRef(input)),
          ),
        restoreCheckpoint: (input) =>
          assertCwd("checkpoints.restoreCheckpoint", input.cwd).pipe(
            Effect.flatMap(() => underlying.checkpoints!.restoreCheckpoint(input)),
          ),
        diffCheckpoints: (input) =>
          assertCwd("checkpoints.diffCheckpoints", input.cwd).pipe(
            Effect.flatMap(() => underlying.checkpoints!.diffCheckpoints(input)),
          ),
        deleteCheckpointRefs: (input) =>
          assertCwd("checkpoints.deleteCheckpointRefs", input.cwd).pipe(
            Effect.flatMap(() => underlying.checkpoints!.deleteCheckpointRefs(input)),
          ),
      }
    : undefined;

  return {
    capabilities: underlying.capabilities,
    execute,
    detectRepository,
    isInsideWorkTree,
    listWorkspaceFiles,
    listRemotes,
    filterIgnoredPaths,
    initRepository,
    ...(wrappedCheckpoints ? { checkpoints: wrappedCheckpoints } : {}),
    ...(wrappedDiffPreview ? { getDiffPreview: wrappedDiffPreview } : {}),
  } satisfies VcsDriver.VcsDriverShape;
});
