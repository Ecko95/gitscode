#!/usr/bin/env bash
# Regression for the gits-confine.sh DNS fix: a confined `--egress host` peer must be able
# to resolve public DNS. /etc/resolv.conf is a symlink whose target lives outside the sandbox
# (WSL: /mnt/wsl/resolv.conf; systemd: /run/systemd/resolve/stub-resolv.conf); without binding
# that target the link dangles inside the jail and DNS fails with EAI_AGAIN.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
CONFINE="$HERE/../../scripts/gits-confine.sh"
WT="$(mktemp -d)"; trap 'rm -rf "$WT"' EXIT

# Confined peer with shared-host egress must resolve a public name.
out="$(bash "$CONFINE" --worktree "$WT" --profile peer --egress host \
  -- getent hosts api.openai.com 2>/dev/null || true)"
echo "$out" | grep -qiE "api\.openai\.com" \
  || { echo "FAIL: confined --egress host peer could not resolve DNS (got: '$out')"; exit 1; }

# egress=off must remain net-isolated (no resolution) — confirms the bind is gated on egress.
if bash "$CONFINE" --worktree "$WT" --profile peer --egress off \
  -- getent hosts api.openai.com >/dev/null 2>&1; then
  echo "FAIL: egress=off peer resolved DNS — net should be unshared"; exit 1
fi

echo "PASS: confined --egress host resolves DNS; egress=off stays isolated"
