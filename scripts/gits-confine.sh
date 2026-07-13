#!/usr/bin/env bash
# gits-confine.sh — OS-level confinement for GITS peer execution and verification.
# Implements §Hardening H0 of docs/gits/ORCHESTRATION_SELF_IMPROVEMENT_DESIGN.md.
# Origin: spikes/h0-confinement/ (feasibility proof). This is the canonical, profiled version.
#
# Two profiles:
#   verify  (default) — run an UNTRUSTED repo's verification under maximum lockdown:
#                       worktree-only writes, NO credentials, network OFF, npm lifecycle
#                       scripts DISABLED. Closes the unsandboxed-verification RCE.
#   peer              — run a coding peer (codex/cursor) that genuinely needs a provider
#                       credential + network: bind ONLY the named credential(s) read-only
#                       (everything else in $HOME stays invisible) and apply an egress policy.
#
# Usage:
#   gits-confine.sh --worktree <dir> [--profile verify|peer] [--label NAME]
#                   [--cred <abs-path> ...]            # peer: minimal credential(s), ro
#                   [--egress off|host|proxy=<addr>]   # peer net policy (default: off)
#                   [--ignore-scripts on|off]          # override profile default
#                   [--ro <abs-path> ...]              # extra read-only binds (toolchains)
#                   [--setenv KEY=VAL ...]             # inject extra env vars into the jail
#                   -- <cmd> [args...]
#
# Exit code = the confined command's exit code (or 70 on wrapper misuse).
set -euo pipefail

die() { printf 'gits-confine: %s\n' "$*" >&2; exit 70; }
warn() { printf 'gits-confine: WARNING: %s\n' "$*" >&2; }

WORKTREE="" PROFILE="verify" LABEL="confined" EGRESS="" IGNORE_SCRIPTS=""
CREDS=() EXTRA_RO=() CMD=() USER_ENV=()
while [ $# -gt 0 ]; do
  case "$1" in
    --worktree) WORKTREE="${2:-}"; shift 2 ;;
    --profile)  PROFILE="${2:-}"; shift 2 ;;
    --label)    LABEL="${2:-}"; shift 2 ;;
    --cred)     CREDS+=("${2:-}"); shift 2 ;;
    --ro)       EXTRA_RO+=("${2:-}"); shift 2 ;;
    --egress)   EGRESS="${2:-}"; shift 2 ;;
    --ignore-scripts) IGNORE_SCRIPTS="${2:-}"; shift 2 ;;
    --setenv)   USER_ENV+=("${2:-}"); shift 2 ;;
    --)         shift; CMD=("$@"); break ;;
    *)          die "unknown arg: $1 (forget '--' before the command?)" ;;
  esac
done

[ -n "$WORKTREE" ] || die "missing --worktree"
[ -d "$WORKTREE" ] || die "worktree not found: $WORKTREE"
[ "${#CMD[@]}" -gt 0 ] || die "missing command after '--'"
command -v bwrap >/dev/null 2>&1 || die "bwrap (bubblewrap) not installed"
case "$PROFILE" in verify|peer) ;; *) die "unknown --profile: $PROFILE" ;; esac
WORKTREE="$(cd "$WORKTREE" && pwd -P)"

# Profile defaults --------------------------------------------------------------------------
if [ "$PROFILE" = "verify" ]; then
  : "${EGRESS:=off}"                 # untrusted verification never needs network
  : "${IGNORE_SCRIPTS:=on}"          # and never runs the repo's lifecycle scripts
  [ "${#CREDS[@]}" -eq 0 ] || warn "creds bound under 'verify' profile — verification should need none"
else
  : "${EGRESS:=off}"                 # peer default off too; opt into egress explicitly
  : "${IGNORE_SCRIPTS:=off}"         # a peer may legitimately run installs (contained by the sandbox)
fi

# System + toolchain binds (recreate usr-merge symlinks; bind node root since it lives in $HOME)
sys_args=( --ro-bind /usr /usr )
for d in bin sbin lib lib64; do
  if [ -L "/$d" ]; then tgt="$(readlink "/$d")"; sys_args+=( --symlink "${tgt#/}" "/$d" )
  elif [ -d "/$d" ]; then sys_args+=( --ro-bind "/$d" "/$d" ); fi
done
[ -d /etc ] && sys_args+=( --ro-bind /etc /etc )
[ -d /opt ] && sys_args+=( --ro-bind-try /opt /opt )

NODE_BIN=""
if command -v node >/dev/null 2>&1; then
  NODE_BIN="$(dirname "$(readlink -f "$(command -v node)")")"
  NODE_ROOT="$(dirname "$NODE_BIN")"
  [ -d "$NODE_ROOT" ] && sys_args+=( --ro-bind "$NODE_ROOT" "$NODE_ROOT" )
fi
# Bun lives in $HOME too (~/.bun) — without a bind every `bun run …` verification
# command dies with execvp ENOENT inside the jail. Bind ONLY ~/.bun/bin (bun + bunx):
# the wider ~/.bun root would expose install/cache (private-registry tarballs), and
# in-jail bun never reads the host cache anyway (BUN_INSTALL unset, HOME is tmpfs).
# NOTE: the ignore-scripts env below is honored by npm/node only — bun does not read
# npm_config_ignore_scripts, so bun repos rely on the OS jail, not script suppression.
BUN_BIN=""
if command -v bun >/dev/null 2>&1; then
  BUN_BIN="$(dirname "$(readlink -f "$(command -v bun)")")"
  [ -d "$BUN_BIN" ] && sys_args+=( --ro-bind "$BUN_BIN" "$BUN_BIN" )
fi
for p in "${EXTRA_RO[@]}"; do [ -n "$p" ] && [ -e "$p" ] && sys_args+=( --ro-bind "$p" "$p" ); done

# Minimal credentials (peer profile): bind ONLY what was named, read-only. Everything else in
# $HOME — ~/.codex, ~/.gits/hermes, ~/.gits/secrets, telegram.env, cursor dashboard token — is
# absent because $HOME is a fresh tmpfs.
cred_args=()
for c in "${CREDS[@]}"; do
  [ -n "$c" ] || continue
  [ -e "$c" ] || { warn "cred not found, skipping: $c"; continue; }
  case "$c" in /*) ;; *) die "--cred must be an absolute path: $c" ;; esac
  cred_args+=( --ro-bind "$c" "$c" )
done

# Egress policy ----------------------------------------------------------------------------
net_args=() ; proxy_env=()
case "$EGRESS" in
  off)        net_args+=( --unshare-net ) ;;
  host)       warn "egress=host shares the HOST network namespace (exposes localhost; NOT an allowlist). Use only for trusted repos." ;;
  proxy=*)    addr="${EGRESS#proxy=}"
              warn "egress=proxy sets HTTP(S)_PROXY=$addr but cannot ENFORCE an allowlist without passt/pasta or root nftables (absent here). A hostile peer can bypass the proxy over the shared net. Treat as advisory until userspace-net lands."
              proxy_env+=( --setenv HTTPS_PROXY "$addr" --setenv HTTP_PROXY "$addr" --setenv https_proxy "$addr" --setenv http_proxy "$addr" ) ;;
  *)          die "unknown --egress: $EGRESS (off | host | proxy=<addr>)" ;;
esac

# DNS for shared-network peers: /etc/resolv.conf is commonly a symlink whose target lives
# OUTSIDE the sandbox (WSL: /mnt/wsl/resolv.conf; systemd: /run/systemd/resolve/stub-resolv.conf).
# The /etc bind brings the symlink but NOT its target, leaving a dangling link and broken DNS
# (EAI_AGAIN). When the peer actually has network, bind the target at its own path so the link
# resolves. No-op for egress=off (net unshared) or a real-file /etc/resolv.conf.
dns_args=()
if [ "$EGRESS" != "off" ]; then
  resolv_target="$(readlink -f /etc/resolv.conf 2>/dev/null || true)"
  if [ -n "$resolv_target" ] && [ -f "$resolv_target" ] && [ "$resolv_target" != "/etc/resolv.conf" ]; then
    dns_args+=( --ro-bind "$resolv_target" "$resolv_target" )
  fi
fi

# Scripts policy
script_env=()
if [ "$IGNORE_SCRIPTS" = "on" ]; then
  script_env+=( --setenv NPM_CONFIG_IGNORE_SCRIPTS true --setenv npm_config_ignore_scripts true )
fi

PATH_IN="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
[ -n "$NODE_BIN" ] && PATH_IN="${NODE_BIN}:${PATH_IN}"
[ -n "$BUN_BIN" ] && PATH_IN="${BUN_BIN}:${PATH_IN}"

# User-supplied env (e.g. CODEX_HOME for a confined codex peer). KEY=VAL form.
user_env_args=()
for kv in "${USER_ENV[@]}"; do
  [ -n "$kv" ] || continue
  case "$kv" in
    *=*) user_env_args+=( --setenv "${kv%%=*}" "${kv#*=}" ) ;;
    *)   die "--setenv expects KEY=VAL, got: $kv" ;;
  esac
done

exec bwrap \
  --clearenv \
  --setenv PATH "$PATH_IN" \
  --setenv HOME /sandbox-home \
  --setenv TMPDIR /tmp \
  --setenv TERM "${TERM:-xterm}" \
  --setenv LANG "${LANG:-C.UTF-8}" \
  --setenv GITS_CONFINED "$PROFILE:$LABEL" \
  "${user_env_args[@]}" \
  "${script_env[@]}" \
  "${proxy_env[@]}" \
  "${sys_args[@]}" \
  "${cred_args[@]}" \
  --proc /proc --dev /dev \
  --tmpfs /tmp --tmpfs /run --tmpfs /sandbox-home \
  "${dns_args[@]}" \
  --bind "$WORKTREE" "$WORKTREE" \
  --chdir "$WORKTREE" \
  --unshare-user --unshare-pid --unshare-ipc --unshare-uts --unshare-cgroup \
  "${net_args[@]}" \
  --cap-drop ALL --new-session --die-with-parent \
  -- "${CMD[@]}"
