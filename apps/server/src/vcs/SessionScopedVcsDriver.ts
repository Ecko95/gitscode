import * as Effect from "effect/Effect";
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
  const supervisorOverride = options.supervisorOverride ?? false;

  // Normalize allowedRoot once: strip trailing slash so startsWith checks are exact.
  const root = options.allowedRoot.endsWith("/")
    ? options.allowedRoot.slice(0, -1)
    : options.allowedRoot;

  function assertCwd(
    operation: string,
    cwd: string,
  ): Effect.Effect<void, VcsUnsupportedOperationError> {
    // Resolve `..` segments via Effect's Path service (wraps node:path.resolve — same semantics).
    // Symlink escapes require async FileSystem.realPath; that upgrade path is noted below.
    // ponytail: path.resolve handles ../traversal; symlink escape requires FileSystem.realPath —
    //           add that pre-check if symlink attacks become a threat surface
    const resolved = pathService.resolve(cwd);
    const ok = resolved === root || resolved.startsWith(root + "/");
    if (ok) return Effect.void;
    return Effect.fail(
      new VcsUnsupportedOperationError({
        operation: `session-guard.path-check:${operation}`,
        kind: underlying.capabilities.kind,
        detail: `cwd '${cwd}' (resolved: '${resolved}') is outside allowed root '${root}'`,
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

    // Check refspec args: bare branch name or `<local>:<remote>` — inspect the remote side.
    for (const arg of args) {
      if (arg.startsWith("-")) continue;
      if (arg === "push") continue;
      const colonIdx = arg.indexOf(":");
      const branchPart = colonIdx !== -1 ? arg.slice(colonIdx + 1) : arg;
      const bare = branchPart.replace(/^refs\/heads\//, "");
      if (PROTECTED_BRANCHES.has(bare)) {
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
