#!/usr/bin/env bash
# H0b spike: determine the exact confined `codex exec` invocation that authenticates
# and completes a trivial task. Records the working recipe for delamain Task 5.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
CONFINE="$HERE/../../scripts/gits-confine.sh"
PEER_HOME="${CODEX_HOME:-$HOME/.delamain/peer-codex-home}"

if [ ! -f "$PEER_HOME/auth.json" ]; then
  echo "SKIPPED: no codex peer auth at $PEER_HOME/auth.json (log a peer in first)"; exit 0
fi

WT="$(mktemp -d)"; ( cd "$WT" && git init -q && git -c user.email=s@s -c user.name=s commit -q --allow-empty -m init )
trap 'rm -rf "$WT"' EXIT
PROMPT='Create a file named HELLO.txt containing exactly the word HELLO, then stop.'

try() { # $1 = label, rest = gits-confine args before `-- codex …`
  local label="$1"; shift
  echo "=== $label ==="
  printf '%s' "$PROMPT" | timeout 180 bash "$CONFINE" "$@" \
    -- codex exec --json -C "$WT" - >"/tmp/h0b-$label.out" 2>&1
  local rc=$?
  if [ -f "$WT/HELLO.txt" ] && grep -q HELLO "$WT/HELLO.txt"; then
    echo "  RESULT: WORKS (rc=$rc, file written)"; rm -f "$WT/HELLO.txt"; return 0
  fi
  echo "  RESULT: FAILED (rc=$rc) — tail of /tmp/h0b-$label.out:"; tail -8 "/tmp/h0b-$label.out" | sed 's/^/    /'
  return 1
}

# Recipe A: CODEX_HOME points at the bound cred dir (creds read-only).
try recipeA --worktree "$WT" --profile peer --egress host \
  --cred "$PEER_HOME/auth.json" --cred "$PEER_HOME/config.toml" \
  --setenv "CODEX_HOME=$PEER_HOME" || true

# Recipe B: bind the whole peer-home dir read-only (codex may read siblings).
try recipeB --worktree "$WT" --profile peer --egress host \
  --ro "$PEER_HOME" --setenv "CODEX_HOME=$PEER_HOME" || true

echo "DONE — record the first WORKS recipe in SPIKE_FINDINGS.md"
