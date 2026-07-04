#!/bin/sh
# git-shim — GITS session-scoped git command confinement shim.
#
# Placed first on the child process PATH so the AI agent's `git` invocations
# route through here instead of the real git binary.
#
# Policy predicates replicated from:
#   apps/server/src/vcs/SessionScopedVcsDriver.ts
# Keep in sync: any change to SessionScopedVcsDriver's allowedRoot, force-push,
# merge/rebase, worktree, remote, or config guards must be reflected here.
#
# ponytail: predicate duplication ceiling — if SessionScopedVcsDriver and this
#   shim drift, add a shared policy spec (JSON or a shared test fixture) and
#   validate both against it. Upgrade path: extract policy to a spec file and
#   generate both the TS guards and this shell from it.
#
# OS-level confinement:
# ponytail: PATH-shim stops honest-agent accidents; it does NOT stop a
#   determined agent using /usr/bin/git by absolute path, libgit2, or
#   `export PATH=...`. Real confinement requires bwrap(1) + seccomp filters
#   (Linux namespaces, user namespaces; see plan 24 §5). Upgrade when the
#   threat model escalates to adversarial agents.
#
# Env vars read at runtime (set by GitShimManager.ts per session):
#   GITS_ALLOWED_ROOT      — absolute realpath of the session's worktree root
#   GITS_PROTECTED_BRANCHES — comma-separated list: main,master,gits
#   GITS_REAL_GIT          — absolute path to the real git binary
#
# Exit codes:
#   128 — operation denied by session policy (matches git convention for
#         fatal errors; callers that check exit code ≥ 128 treat it as fatal)

set -eu

# ── Validate required env vars ────────────────────────────────────────────────

if [ -z "${GITS_REAL_GIT:-}" ]; then
	printf '{"gits_shim":"error","reason":"GITS_REAL_GIT not set — shim misconfigured"}\n' >&2
	exit 128
fi

REAL_GIT="${GITS_REAL_GIT}"
ALLOWED_ROOT="${GITS_ALLOWED_ROOT:-}"
PROTECTED="${GITS_PROTECTED_BRANCHES:-main,master,gits}"

# ── Classify subcommand ───────────────────────────────────────────────────────

SUBCMD="${1:-}"

# ── Helper: structured denial ─────────────────────────────────────────────────

deny() {
	_reason="$1"
	# Emit structured JSON to stderr for server-side detection.
	# Session ID is not available here (shell, no IPC); server correlates via
	# the session's stderr stream it's already reading.
	printf '{"gits_shim":"denied","subcmd":"%s","reason":"%s","cwd":"%s"}\n' \
		"${SUBCMD}" "${_reason}" "$(pwd)" >&2
	exit 128
}

warn_passthrough() {
	printf '{"gits_shim":"warn","subcmd":"%s","reason":"unclassified-passthrough","cwd":"%s"}\n' \
		"${SUBCMD}" "$(pwd)" >&2
}

# ── CWD containment check ─────────────────────────────────────────────────────
# Mirrors SessionScopedVcsDriver.ts assertCwd:
#   fast path: path.resolve(cwd) inside root
#   symlink path: fs.realPath(cwd) inside root

check_cwd() {
	if [ -z "${ALLOWED_ROOT}" ]; then
		# No root configured — deny all write ops.
		deny "GITS_ALLOWED_ROOT not set"
	fi

	# Strip trailing slash to match TS normalisation.
	NORM_ROOT="${ALLOWED_ROOT%/}"

	# Resolve symlinks if realpath is available; fall back to pwd.
	if command -v realpath >/dev/null 2>&1; then
		RESOLVED="$(realpath "$(pwd)" 2>/dev/null || pwd)"
	else
		RESOLVED="$(pwd)"
	fi

	case "${RESOLVED}" in
		"${NORM_ROOT}" | "${NORM_ROOT}"/*)
			: ;; # inside root — ok
		*)
			deny "cwd '${RESOLVED}' outside allowed root '${NORM_ROOT}'"
			;;
	esac
}

# ── Force-push guard ──────────────────────────────────────────────────────────
# Mirrors SessionScopedVcsDriver.ts assertNotForcePushToProtected.
# Parses $@ for --force / -f / --force-with-lease then checks refspecs.

check_push() {
	HAS_FORCE=0
	for arg in "$@"; do
		case "${arg}" in
			--force | -f | --force-with-lease | --force-with-lease=*)
				HAS_FORCE=1
				;;
		esac
	done
	if [ "${HAS_FORCE}" -eq 0 ]; then
		return 0
	fi

	# Collect explicit refspecs: skip flags, skip the remote (first non-flag positional).
	REMOTE_SKIPPED=0
	REFSPECS=""
	for arg in "$@"; do
		case "${arg}" in
			push | -* ) continue ;;
		esac
		if [ "${REMOTE_SKIPPED}" -eq 0 ]; then
			REMOTE_SKIPPED=1
			continue # first non-flag positional = remote name
		fi
		REFSPECS="${REFSPECS} ${arg}"
	done

	if [ -z "${REFSPECS}" ]; then
		# Implicit force-push: blanket reject (matches TS driver behaviour).
		deny "implicit force-push (no explicit refspec) is not allowed from a session"
	fi

	# Check each refspec against protected branch list.
	IFS=","
	for refspec in ${REFSPECS}; do
		# Extract remote side: <local>:<remote> → remote; bare → same.
		case "${refspec}" in
			*:*) REMOTE="${refspec##*:}" ;;
			*)   REMOTE="${refspec}" ;;
		esac
		# Strip refs/heads/ prefix.
		BARE="${REMOTE#refs/heads/}"
		if [ -z "${BARE}" ]; then continue; fi # delete refspec ":<branch>"
		for protected in ${PROTECTED}; do
			if [ "${BARE}" = "${protected}" ]; then
				deny "force-push to protected branch '${BARE}' is not allowed from a session"
			fi
		done
	done
	IFS=" "
}

# ── Route by subcommand ───────────────────────────────────────────────────────

case "${SUBCMD}" in

	# ── Read-only pass-through ────────────────────────────────────────────────
	status | log | diff | show | "branch" | "ls-files" | "rev-parse" | \
	describe | shortlog | "stash" | blame | "cat-file" )
		# Note: `branch -d`/`branch -D` is a write op but we don't classify
		# sub-flags here — branch without -D/-d is typically read. The TS driver
		# does not guard branch deletions either (only push + merge/rebase).
		exec "${REAL_GIT}" "$@"
		;;

	# ── Write ops: cwd containment ────────────────────────────────────────────
	add | commit | restore | checkout | switch | clean | apply | "cherry-pick" | tag )
		check_cwd
		exec "${REAL_GIT}" "$@"
		;;

	# ── Push: cwd + force-push guard ─────────────────────────────────────────
	push )
		check_cwd
		check_push "$@"
		exec "${REAL_GIT}" "$@"
		;;

	# ── Merge / rebase: unconditional deny ───────────────────────────────────
	# Sessions route integration through the supervisor AutomodeLanding machinery.
	# Mirrors SessionScopedVcsDriver.ts assertNotMergeOrRebase.
	merge | rebase )
		deny "git ${SUBCMD} is not permitted from a session; route through the supervisor integration command"
		;;

	# ── Worktree ops: deny — sessions must not manipulate the worktree graph ─
	worktree )
		WORKTREE_SUBCMD="${2:-}"
		case "${WORKTREE_SUBCMD}" in
			add | remove | prune )
				deny "git worktree ${WORKTREE_SUBCMD} is not permitted from a session"
				;;
			* )
				# worktree list / worktree lock are read-only — pass through
				exec "${REAL_GIT}" "$@"
				;;
		esac
		;;

	# ── Remote mutation: deny ─────────────────────────────────────────────────
	"remote" )
		REMOTE_SUBCMD="${2:-}"
		case "${REMOTE_SUBCMD}" in
			add | remove | set-url )
				deny "git remote ${REMOTE_SUBCMD} is not permitted from a session"
				;;
			* )
				exec "${REAL_GIT}" "$@"
				;;
		esac
		;;

	# ── Config: deny --global/--system; allow --local inside allowedRoot ──────
	config )
		for arg in "$@"; do
			case "${arg}" in
				--global | --system )
					deny "git config ${arg} is not permitted from a session (local config only)"
					;;
			esac
		done
		# --local or no scope flag: apply cwd containment.
		check_cwd
		exec "${REAL_GIT}" "$@"
		;;

	# ── Unclassified: pass-through with warning ───────────────────────────────
	# Deny-by-default is not chosen here because it would break legitimate agent
	# workflows in unpredictable ways. Real isolation requires OS-level confinement.
	# ponytail: warn+passthrough ceiling — switch to deny when a risk case is
	#   identified; OS-level (bwrap/seccomp) for hard isolation.
	* )
		warn_passthrough
		exec "${REAL_GIT}" "$@"
		;;
esac
