#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# Shared defaults keep install and deploy commands aligned.
source "${SCRIPT_DIR}/common.sh"

usage() {
  cat <<'EOF'
Usage: install-wsl-user-service.sh [options]

Install or refresh the WSL user-systemd unit for the hosted GITS cockpit.

Options:
  --repo PATH                 Source repo used to run the deploy scripts.
  --worktree PATH             Clean deploy worktree served by systemd.
  --remote NAME               Git remote to fetch. Default: origin
  --branch NAME               Branch to deploy. Default: feat/gits-rtk-output-gateway
  --service NAME              User service name. Default: gits-cockpit.service
  --port PORT                 Hosted HTTP port inside WSL. Default: 13773
  --t3code-home PATH          T3 Code state directory. Default: $HOME/.t3
  --start                     Restart the service after installing the unit.
  --help                      Show this message.
EOF
}

gits_hosting_load_defaults
start_service=0

gits_hosting_parse_common_args "$@"

if ((${#gits_hosting_remaining_args[@]} > 0)); then
  remaining_args=("${gits_hosting_remaining_args[@]}")
  gits_hosting_remaining_args=()
  for arg in "${remaining_args[@]}"; do
    case "$arg" in
      --start)
        start_service=1
        ;;
      *)
        gits_hosting_remaining_args+=("$arg")
        ;;
    esac
  done
fi

if ((gits_hosting_help_requested)); then
  usage
  exit 0
fi

gits_hosting_require_clean_args
gits_hosting_require_command systemctl
gits_hosting_require_command node

node_path="$(command -v node)"
unit_path="$(gits_hosting_service_unit_path)"
mkdir -p "$(dirname "$unit_path")"

cat >"$unit_path" <<EOF
[Unit]
Description=Hosted GITS cockpit
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${gits_hosting_worktree}
Environment=NODE_ENV=production
Environment=T3CODE_HOME=${gits_hosting_t3code_home}
ExecStart=${node_path} apps/server/dist/bin.mjs serve --host 0.0.0.0 --port ${gits_hosting_port}
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable "$gits_hosting_service" >/dev/null

if ((start_service)); then
  systemctl --user restart "$gits_hosting_service"
fi

gits_hosting_log "Installed user service: $unit_path"
gits_hosting_log "Service command: ${node_path} apps/server/dist/bin.mjs serve --host 0.0.0.0 --port ${gits_hosting_port}"

if command -v loginctl >/dev/null 2>&1; then
  linger_status="$(loginctl show-user "$USER" -p Linger --value 2>/dev/null || true)"
  if [[ "$linger_status" != "yes" ]]; then
    gits_hosting_log "User linger is not enabled. Run: sudo loginctl enable-linger ${USER}"
  fi
fi

if ((start_service)); then
  systemctl --user --no-pager --full status "$gits_hosting_service"
else
  gits_hosting_log "Run the deploy script before the first start if ${gits_hosting_worktree}/apps/server/dist/bin.mjs does not exist yet."
fi
