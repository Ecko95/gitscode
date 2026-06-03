#!/usr/bin/env bash
# gits-confine.sh — H0 confinement spike (docs/gits/ORCHESTRATION_SELF_IMPROVEMENT_DESIGN.md §Hardening H0)
#
# Run an arbitrary command under OS-level confinement using bubblewrap (bwrap):
#   - the ONLY writable real path is the worktree
#   - HOME is an ephemeral tmpfs (no ~/.codex/auth.json, ~/.gits/secrets, telegram.env, etc.)
#   - the environment is cleared; only a minimal PATH/HOME/TERM/LANG is set
#   - npm/pnpm lifecycle scripts are force-disabled (NPM_CONFIG_IGNORE_SCRIPTS=true)
#   - network is OFF by default (--net to opt in); PID/IPC/UTS/cgroup namespaces unshared
#
# This is a SPIKE: a proof of feasibility + a measurement of friction, not production code.
# It deliberately does NOT yet integrate with the delamain peer-spawn path (see SPIKE_FINDINGS.md).
#
# Usage:
#   gits-confine.sh --worktree <dir> [--net] [--label NAME] -- <cmd> [args...]
#
# Exit code is the confined command's exit code (or 70 on wrapper misuse).

set -euo pipefail

die() { printf 'gits-confine: %s\n' "$*" >&2; exit 70; }

WORKTREE=""
NET="off"
LABEL="confined"
CMD=()

while [ $# -gt 0 ]; do
  case "$1" in
    --worktree) WORKTREE="${2:-}"; shift 2 ;;
    --net)      NET="on"; shift ;;
    --label)    LABEL="${2:-}"; shift 2 ;;
    --)         shift; CMD=("$@"); break ;;
    *)          die "unknown arg: $1 (did you forget '--' before the command?)" ;;
  esac
done

[ -n "$WORKTREE" ]   || die "missing --worktree"
[ -d "$WORKTREE" ]   || die "worktree does not exist or is not a directory: $WORKTREE"
[ "${#CMD[@]}" -gt 0 ] || die "missing command after '--'"
command -v bwrap >/dev/null 2>&1 || die "bwrap (bubblewrap) not installed"

# Absolute, symlink-resolved worktree path (the single writable mount).
WORKTREE="$(cd "$WORKTREE" && pwd -P)"

# Locate the node toolchain. KEY H0 FINDING: node/npm are commonly installed under $HOME
# (nvm/fnm/volta), right next to the secrets we exclude. We therefore bind the specific node
# install ROOT read-only (not all of $HOME), so the toolchain is available but ~/.codex,
# ~/.gits, etc. stay invisible.
NODE_BIN=""
tool_args=()
if command -v node >/dev/null 2>&1; then
  NODE_BIN="$(dirname "$(readlink -f "$(command -v node)")")"
  NODE_ROOT="$(dirname "$NODE_BIN")"
  [ -d "$NODE_ROOT" ] && tool_args+=( --ro-bind "$NODE_ROOT" "$NODE_ROOT" )
fi
# Optional extra read-only binds (colon-separated abs paths), e.g. a pnpm/bun home.
if [ -n "${GITS_CONFINE_EXTRA_ROBINDS:-}" ]; then
  IFS=':' read -r -a _extra <<< "$GITS_CONFINE_EXTRA_ROBINDS"
  for p in "${_extra[@]}"; do [ -n "$p" ] && [ -e "$p" ] && tool_args+=( --ro-bind "$p" "$p" ); done
fi

# Recreate top-level system symlinks (usr-merge: /bin -> usr/bin, etc.) or ro-bind real dirs.
sys_args=( --ro-bind /usr /usr )
for d in bin sbin lib lib64; do
  if [ -L "/$d" ]; then
    tgt="$(readlink "/$d")"; tgt="${tgt#/}"
    sys_args+=( --symlink "$tgt" "/$d" )
  elif [ -d "/$d" ]; then
    sys_args+=( --ro-bind "/$d" "/$d" )
  fi
done
# /etc is needed for the dynamic linker, ca-certificates, /etc/passwd. User secrets live in
# $HOME, not /etc, so a read-only /etc is acceptable for the spike (production can narrow this).
[ -d /etc ] && sys_args+=( --ro-bind /etc /etc )
[ -d /opt ] && sys_args+=( --ro-bind-try /opt /opt )

# Network: OFF unshares the net namespace entirely (no loopback to host services either, which
# is exactly what an untrusted peer should get); ON shares the host net for e.g. npm install
# (a KNOWN spike limitation — it also exposes localhost; see SPIKE_FINDINGS.md "net" caveat).
net_args=()
if [ "$NET" = "off" ]; then
  net_args+=( --unshare-net )
fi

PATH_IN="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
[ -n "$NODE_BIN" ] && PATH_IN="${NODE_BIN}:${PATH_IN}"

exec bwrap \
  --clearenv \
  --setenv PATH "$PATH_IN" \
  --setenv HOME /sandbox-home \
  --setenv TMPDIR /tmp \
  --setenv TERM "${TERM:-xterm}" \
  --setenv LANG "${LANG:-C.UTF-8}" \
  --setenv GITS_CONFINED "$LABEL" \
  --setenv NPM_CONFIG_IGNORE_SCRIPTS true \
  --setenv npm_config_ignore_scripts true \
  "${sys_args[@]}" \
  "${tool_args[@]}" \
  --proc /proc \
  --dev /dev \
  --tmpfs /tmp \
  --tmpfs /run \
  --tmpfs /sandbox-home \
  --bind "$WORKTREE" "$WORKTREE" \
  --chdir "$WORKTREE" \
  --unshare-user \
  --unshare-pid \
  --unshare-ipc \
  --unshare-uts \
  --unshare-cgroup \
  "${net_args[@]}" \
  --cap-drop ALL \
  --new-session \
  --die-with-parent \
  -- "${CMD[@]}"
