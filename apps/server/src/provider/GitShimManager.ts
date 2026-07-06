/**
 * GitShimManager — per-session PATH-injected git command confinement shim.
 *
 * Creates a session-scoped directory under `${baseDir}/gits-shims/<sessionId>/`
 * containing a `git` executable (the shim script). Prepending that directory
 * to a provider child's `PATH` causes the AI agent's bare `git` invocations to
 * route through the shim, which enforces the same policy predicates as
 * `SessionScopedVcsDriver`.
 *
 * CONFINEMENT LINE: env vars are injected only into provider child process
 * environments. `process.env` of the server is NEVER modified. The server's
 * own git operations (AutomodeLanding, GitManager, VcsStatusBroadcaster) run
 * through `VcsDriver` and are unshimmed by construction.
 *
 * HONEST LIMITATION: the shim intercepts bare `git` invocations via PATH
 * resolution only. A determined agent can bypass it via:
 *   - absolute path: /usr/bin/git
 *   - libgit2 bindings (git2, pygit2, nodegit)
 *   - rewriting PATH inside the shell
 * Real confinement against adversarial agents requires OS-level sandboxing.
 * ponytail: PATH-shim covers honest-agent accidents; upgrade to bwrap/seccomp
 *   (Linux user namespaces, plan 24 §5) when threat model escalates.
 *
 * @module provider/GitShimManager
 */
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";

import { ServerConfig } from "../config.ts";

// ── Constants ─────────────────────────────────────────────────────────────────

const SHIMS_SUBDIR = "gits-shims";

// Protected branches mirror SessionScopedVcsDriver.ts PROTECTED_BRANCHES.
// ponytail: hardcoded list; add env-var knob if multi-repo operators need
//   custom branch protection sets (none today).
const PROTECTED_BRANCHES = "main,master,gits";

// Stale shim dirs older than this are removed on startup sweep.
const STALE_THRESHOLD_MS = Duration.toMillis(Duration.hours(24));

// ── Service shape ─────────────────────────────────────────────────────────────

export interface GitShimEnv {
  /** Env vars to merge into the provider child's processEnv before spawn. */
  readonly vars: Record<string, string>;
}

export class GitShimAllocateError extends Data.TaggedError("GitShimAllocateError")<{
  readonly sessionId: string;
  readonly message: string;
  readonly cause: unknown;
}> {}

export interface GitShimManagerShape {
  /**
   * Create a shim dir for `sessionId`, write the `git` script that enforces
   * `allowedRoot` containment, and return the env vars to inject.
   *
   * Callers are responsible for calling `release(sessionId)` when the session
   * ends. Codex/Cursor/OpenCode adapters do this via a Scope finalizer;
   * ClaudeAdapter calls release explicitly in stopSessionInternal.
   */
  readonly allocate: (
    sessionId: string,
    allowedRoot: string,
  ) => Effect.Effect<GitShimEnv, GitShimAllocateError>;

  /**
   * Remove the shim dir for `sessionId` immediately.
   * No-op if the dir does not exist.
   */
  readonly release: (sessionId: string) => Effect.Effect<void>;

  /**
   * Sweep shim dirs older than 24 h. Called once at server startup.
   * Fire-and-forget safe (errors are logged, never propagated).
   */
  readonly sweepStale: () => Effect.Effect<void>;
}

// ── Context tag ───────────────────────────────────────────────────────────────

export class GitShimManager extends Context.Service<GitShimManager, GitShimManagerShape>()(
  "t3/provider/GitShimManager",
) {}

// ── Service implementation ─────────────────────────────────────────────────────

const makeGitShimManager: Effect.Effect<
  GitShimManagerShape,
  never,
  FileSystem.FileSystem | Path.Path | ServerConfig
> = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig;

  // Shim dir root: under baseDir (ext4, user-controlled, never noexec).
  // /tmp may be mounted noexec — the shim executable would silently fall
  // through to the real git binary, defeating the entire confinement.
  const shimsRoot = path.join(serverConfig.baseDir, SHIMS_SUBDIR);

  // Resolve the real git binary from the server's own PATH once at
  // startup. The shim child env gets GITS_REAL_GIT pointing here.
  // ponytail: resolve once — git path never changes at runtime for us.
  const realGit = yield* Effect.gen(function* () {
    // Walk the server's PATH entries to find the first `git` binary.
    // Cannot use `which` here (no shell); replicate it manually.
    const pathDirs = (process.env["PATH"] ?? "").split(":");
    for (const dir of pathDirs) {
      if (!dir) continue;
      const candidate = path.join(dir, "git");
      // Skip shims-root candidates (self-reference) and dirs without an
      // actual git binary — otherwise the shim execs a nonexistent path (127).
      if (candidate.startsWith(shimsRoot)) continue;
      const exists = yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false));
      if (exists) return candidate;
    }
    return "/usr/bin/git"; // safe fallback
  });

  const shimScript = gitShimScript;

  function shimDirFor(sessionId: string): string {
    return path.join(shimsRoot, sessionId);
  }

  function shimPathFor(sessionId: string): string {
    return path.join(shimDirFor(sessionId), "git");
  }

  const allocate = (
    sessionId: string,
    allowedRoot: string,
  ): Effect.Effect<GitShimEnv, GitShimAllocateError> =>
    Effect.gen(function* () {
      const shimDir = shimDirFor(sessionId);
      const shimPath = shimPathFor(sessionId);

      yield* fs.makeDirectory(shimDir, { recursive: true });
      yield* fs.writeFileString(shimPath, shimScript);
      // chmod 755: owner rwx, group rx, other rx — executable by child process.
      yield* fs.chmod(shimPath, 0o755);

      const vars: Record<string, string> = {
        // Prepend shim dir to PATH so bare `git` resolves to our script.
        PATH: `${shimDir}:${process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin"}`,
        GITS_REAL_GIT: realGit,
        GITS_ALLOWED_ROOT: allowedRoot,
        GITS_PROTECTED_BRANCHES: PROTECTED_BRANCHES,
      };

      yield* Effect.logDebug("git-shim.allocated", {
        sessionId,
        shimDir,
        allowedRoot,
      });

      return { vars } satisfies GitShimEnv;
    }).pipe(
      Effect.catch((err) => {
        // Fail closed: without the shim, a confined session would spawn with
        // unrestricted git. Surface the startup error instead.
        return Effect.logWarning("git-shim.allocate-failed", { sessionId, err }).pipe(
          Effect.andThen(
            Effect.fail(
              new GitShimAllocateError({
                sessionId,
                message: "Failed to allocate git confinement shim.",
                cause: err,
              }),
            ),
          ),
        );
      }),
    );

  const release = (sessionId: string): Effect.Effect<void> =>
    fs.remove(shimDirFor(sessionId), { recursive: true, force: true }).pipe(
      Effect.tap(() => Effect.logDebug("git-shim.released", { sessionId })),
      Effect.catch((err) => Effect.logWarning("git-shim.release-failed", { sessionId, err })),
    );

  const sweepStale = (): Effect.Effect<void> =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const nowMs = DateTime.toEpochMillis(now);

      const exists = yield* fs.stat(shimsRoot).pipe(
        Effect.map(() => true),
        Effect.catch(() => Effect.succeed(false)),
      );
      if (!exists) return;

      const entries = yield* fs
        .readDirectory(shimsRoot, { recursive: false })
        .pipe(Effect.catch(() => Effect.succeed([] as string[])));

      for (const entryName of entries) {
        const entryPath = path.join(shimsRoot, entryName);
        const stat = yield* fs.stat(entryPath).pipe(Effect.catch(() => Effect.succeed(null)));
        if (!stat) continue;

        // Use mtime to determine age. Effect FileSystem.File.Info.mtime is Option<Date>.
        const mtimeMs = Option.isSome(stat.mtime) ? stat.mtime.value.getTime() : 0;
        if (nowMs - mtimeMs > STALE_THRESHOLD_MS) {
          yield* fs.remove(entryPath, { recursive: true, force: true }).pipe(
            Effect.tap(() => Effect.logInfo("git-shim.swept-stale", { entry: entryName })),
            Effect.catch((err) =>
              Effect.logWarning("git-shim.sweep-failed", { entry: entryName, err }),
            ),
          );
        }
      }
    }).pipe(Effect.catch((err) => Effect.logWarning("git-shim.sweep-error", { err })));

  return { allocate, release, sweepStale } satisfies GitShimManagerShape;
});

// ── Live layer ────────────────────────────────────────────────────────────────

export const GitShimManagerLive: Layer.Layer<
  GitShimManager,
  never,
  FileSystem.FileSystem | Path.Path | ServerConfig
> = Layer.effect(GitShimManager, makeGitShimManager);

// ── Startup sweep ─────────────────────────────────────────────────────────────

/**
 * Run `sweepStale()` once at server startup, then repeat every 24 h.
 * Fire-and-forget — errors are logged inside sweepStale.
 */
export const gitShimStartupSweep: Effect.Effect<void, never, GitShimManager | Scope.Scope> =
  Effect.gen(function* () {
    const mgr = yield* GitShimManager;
    yield* Effect.forkScoped(
      mgr.sweepStale().pipe(
        Effect.repeat(Schedule.spaced(Duration.hours(24))),
        Effect.catch(() => Effect.void),
      ),
    );
  });

// ── Inline shim script ────────────────────────────────────────────────────────
// The shell script is embedded here so the server module is self-contained —
// no runtime asset path resolution needed. The canonical authoritative source
// is `apps/server/src/provider/assets/git-shim.sh`; this string MUST stay in
// sync with that file.
// ponytail: inline duplication ceiling — if the script grows or needs
//   parameterisation, read the asset file at startup instead of embedding.

const gitShimScript = `#!/bin/sh
# git-shim — GITS session-scoped git command confinement shim.
# Materialized per-session by GitShimManager.ts.
# Policy predicates mirror SessionScopedVcsDriver.ts — keep in sync.
# ponytail: duplication ceiling; see GitShimManager.ts inline comment.
# ponytail: OS-level confinement (bwrap/seccomp, plan 24 §5) is the upgrade
#   path when threat model escalates to adversarial agents.

set -eu

if [ -z "\${GITS_REAL_GIT:-}" ]; then
	printf '{"gits_shim":"error","reason":"GITS_REAL_GIT not set"}\n' >&2
	exit 128
fi

REAL_GIT="\${GITS_REAL_GIT}"
ALLOWED_ROOT="\${GITS_ALLOWED_ROOT:-}"
PROTECTED="\${GITS_PROTECTED_BRANCHES:-main,master,gits}"
SUBCMD="\${1:-}"

deny() {
	printf '{"gits_shim":"denied","subcmd":"%s","reason":"%s","cwd":"%s"}\n' \
		"\${SUBCMD}" "\$1" "\$(pwd)" >&2
	exit 128
}

warn_passthrough() {
	printf '{"gits_shim":"warn","subcmd":"%s","reason":"unclassified-passthrough","cwd":"%s"}\n' \
		"\${SUBCMD}" "\$(pwd)" >&2
}

check_cwd() {
	if [ -z "\${ALLOWED_ROOT}" ]; then deny "GITS_ALLOWED_ROOT not set"; fi
	NORM_ROOT="\${ALLOWED_ROOT%/}"
	if command -v realpath >/dev/null 2>&1; then
		RESOLVED="\$(realpath "\$(pwd)" 2>/dev/null || pwd)"
	else
		RESOLVED="\$(pwd)"
	fi
	case "\${RESOLVED}" in
		"\${NORM_ROOT}" | "\${NORM_ROOT}"/*)  : ;;
		*) deny "cwd '\${RESOLVED}' outside allowed root '\${NORM_ROOT}'" ;;
	esac
}

check_push() {
	HAS_FORCE=0
	for arg in "\$@"; do
		case "\${arg}" in --force|-f|--force-with-lease|--force-with-lease=*) HAS_FORCE=1;; esac
	done
	[ "\${HAS_FORCE}" -eq 0 ] && return 0
	REMOTE_SKIPPED=0; REFSPECS=""
	for arg in "\$@"; do
		case "\${arg}" in push|-*) continue;; esac
		if [ "\${REMOTE_SKIPPED}" -eq 0 ]; then REMOTE_SKIPPED=1; continue; fi
		REFSPECS="\${REFSPECS} \${arg}"
	done
	[ -z "\${REFSPECS}" ] && deny "implicit force-push not allowed from a session"
	IFS=","
	for refspec in \${REFSPECS}; do
		case "\${refspec}" in *:*) REMOTE="\${refspec##*:}";; *) REMOTE="\${refspec}";; esac
		BARE="\${REMOTE#refs/heads/}"
		[ -z "\${BARE}" ] && continue
		for protected in \${PROTECTED}; do
			[ "\${BARE}" = "\${protected}" ] && deny "force-push to protected branch '\${BARE}' not allowed from a session"
		done
	done
	IFS=" "
}

case "\${SUBCMD}" in
	status|log|diff|show|branch|ls-files|rev-parse|describe|shortlog|blame|cat-file)
		exec "\${REAL_GIT}" "\$@";;
	add|commit|restore|checkout|switch|clean|apply|cherry-pick|tag)
		check_cwd; exec "\${REAL_GIT}" "\$@";;
	push)
		check_cwd; check_push "\$@"; exec "\${REAL_GIT}" "\$@";;
	merge|rebase)
		deny "git \${SUBCMD} not permitted from a session; route through supervisor integration";;
	worktree)
		case "\${2:-}" in
			add|remove|prune) deny "git worktree \${2:-} not permitted from a session";;
			*) exec "\${REAL_GIT}" "\$@";;
		esac;;
	remote)
		case "\${2:-}" in
			add|remove|set-url) deny "git remote \${2:-} not permitted from a session";;
			*) exec "\${REAL_GIT}" "\$@";;
		esac;;
	config)
		for arg in "\$@"; do
			case "\${arg}" in
				--global|--system) deny "git config \${arg} not permitted from a session";;
			esac
		done
		check_cwd; exec "\${REAL_GIT}" "\$@";;
	*)
		warn_passthrough; exec "\${REAL_GIT}" "\$@";;
esac
`;
