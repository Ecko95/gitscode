#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${SCRIPT_DIR}/common.sh"

usage() {
  cat <<'EOF'
Usage: deploy-subject28-gits.sh [deploy options]

Install or refresh the systemd user service, deploy the latest origin/gits
into the managed hosted worktree, and print the active Tailnet build info URL.

On WSL (WSL_DISTRO_NAME set): the tailscale-serve step is skipped; run
Set-GitsTailnetPortProxy.ps1 from an elevated Windows PowerShell session to
publish the service to the tailnet.

On native Linux (WSL_DISTRO_NAME unset): configure-tailscale-serve.sh wires
`tailscale serve` directly from Linux — no Windows portproxy needed.

This wrapper targets:
  https://subject28.taild6d729.ts.net:8443

It inherits all common hosting options, but defaults to:
  --repo     $HOME/dev/projects/t3code-gits
  --remote   origin
  --branch   gits
  --worktree $HOME/dev/projects/t3code-gits-hosted
  --service  gits-cockpit.service
  --host     127.0.0.1
  --port     13773
EOF
}

gits_hosting_load_defaults
gits_hosting_parse_common_args "$@"

if ((gits_hosting_help_requested)); then
  usage
  exit 0
fi

gits_hosting_require_clean_args

"${SCRIPT_DIR}/install-gits-user-service.sh" \
  --repo "$gits_hosting_repo" \
  --worktree "$gits_hosting_worktree" \
  --remote "$gits_hosting_remote" \
  --branch "$gits_hosting_branch" \
  --host "$gits_hosting_host" \
  --port "$gits_hosting_port" \
  --service "$gits_hosting_service" \
  --t3code-home "$gits_hosting_t3code_home"

"${SCRIPT_DIR}/deploy-gits-tailnet-hosted.sh" \
  --repo "$gits_hosting_repo" \
  --worktree "$gits_hosting_worktree" \
  --remote "$gits_hosting_remote" \
  --branch "$gits_hosting_branch" \
  --host "$gits_hosting_host" \
  --port "$gits_hosting_port" \
  --service "$gits_hosting_service" \
  --t3code-home "$gits_hosting_t3code_home"

# On native Linux, wire tailscale serve directly. On WSL, this is a no-op
# (the caller runs Set-GitsTailnetPortProxy.ps1 from Windows PowerShell instead).
"${SCRIPT_DIR}/configure-tailscale-serve.sh" \
  --host "$gits_hosting_host" \
  --port "$gits_hosting_port" \
  --tailnet-https-port "$gits_hosting_tailnet_https_port"

printf '%s/api/gits/build-info\n' "$GITS_HOSTING_DEFAULT_TAILNET_URL"
