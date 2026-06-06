#!/usr/bin/env bash
# confined-verify.sh — run a server-pinned verification suite against an UNTRUSTED worktree
# under OS-level confinement (gits-confine.sh, verify profile). This is the artifact the
# delamain-autopilot supervisor and the GITS verification gate call instead of running the
# repo's commands directly on the host (which is the RCE the red-team flagged, §Hardening H0/D3).
#
# The suite is SERVER-PINNED: the caller passes explicit argv arrays (e.g. ["npx","tsc","--noEmit"]),
# never the repo's own `npm run <label>` indirection, so a hostile repo cannot redefine the gate.
#
# Usage:
#   confined-verify.sh --worktree <dir> --commands-json '<json-array>'
#   confined-verify.sh --worktree <dir> --commands-file <path>
# JSON: [ {"label":"tsc","cmd":["npx","tsc","--noEmit"],"timeoutSeconds":900}, ... ]
#
# Exit: 0 if all commands exit 0; otherwise the count of failed commands.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFINE="$HERE/gits-confine.sh"
WORKTREE="" JSON="" FILE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --worktree)      WORKTREE="${2:-}"; shift 2 ;;
    --commands-json) JSON="${2:-}"; shift 2 ;;
    --commands-file) FILE="${2:-}"; shift 2 ;;
    *) echo "confined-verify: unknown arg: $1" >&2; exit 70 ;;
  esac
done
[ -n "$WORKTREE" ] || { echo "confined-verify: missing --worktree" >&2; exit 70; }
[ -d "$WORKTREE" ] || { echo "confined-verify: worktree not found: $WORKTREE" >&2; exit 70; }
command -v jq >/dev/null 2>&1 || { echo "confined-verify: jq required" >&2; exit 70; }
[ -x "$CONFINE" ] || chmod +x "$CONFINE"
[ -n "$FILE" ] && JSON="$(cat "$FILE")"
[ -n "$JSON" ] || { echo "confined-verify: provide --commands-json or --commands-file" >&2; exit 70; }
echo "$JSON" | jq -e 'type=="array" and length>0' >/dev/null 2>&1 || { echo "confined-verify: commands must be a non-empty JSON array" >&2; exit 70; }

n="$(echo "$JSON" | jq 'length')"
fails=0
echo "confined-verify: $n command(s) in confined worktree $WORKTREE"
for i in $(seq 0 $((n-1))); do
  label="$(echo "$JSON" | jq -r ".[$i].label // (\"cmd$i\")")"
  timeout_s="$(echo "$JSON" | jq -r ".[$i].timeoutSeconds // 600")"
  mapfile -t argv < <(echo "$JSON" | jq -r ".[$i].cmd[]")
  [ "${#argv[@]}" -gt 0 ] || { echo "  [skip] $label: empty cmd"; continue; }
  out="$(timeout "$timeout_s" "$CONFINE" --worktree "$WORKTREE" --profile verify --label "$label" -- "${argv[@]}" 2>&1)"
  rc=$?
  if [ "$rc" -eq 0 ]; then
    printf '  [pass] %-20s %s\n' "$label" "(${argv[*]})"
  else
    fails=$((fails+1))
    printf '  [FAIL] %-20s rc=%s %s\n' "$label" "$rc" "(${argv[*]})"
    echo "$out" | tail -n 15 | sed 's/^/         | /'
  fi
done
echo "confined-verify: $((n-fails))/$n passed"
exit "$fails"
