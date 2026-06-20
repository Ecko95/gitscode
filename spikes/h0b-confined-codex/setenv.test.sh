#!/usr/bin/env bash
# Verifies gits-confine.sh --setenv injects a var into the jailed command's env.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
CONFINE="$HERE/../../scripts/gits-confine.sh"
WT="$(mktemp -d)"
trap 'rm -rf "$WT"' EXIT

# --setenv FOO=bar must appear in the confined process env.
out="$(bash "$CONFINE" --worktree "$WT" --profile peer --egress host \
  --setenv FOO=bar -- /usr/bin/env)"
echo "$out" | grep -qx "FOO=bar" || { echo "FAIL: FOO=bar not in confined env"; echo "$out"; exit 1; }

# Repeatable: a second --setenv also lands.
out2="$(bash "$CONFINE" --worktree "$WT" --profile peer --egress host \
  --setenv FOO=bar --setenv BAZ=qux -- /usr/bin/env)"
echo "$out2" | grep -qx "BAZ=qux" || { echo "FAIL: BAZ=qux not in confined env"; exit 1; }

echo "PASS: --setenv injects vars"
