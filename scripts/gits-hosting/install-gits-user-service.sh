#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# Shared defaults keep install and deploy commands aligned.
source "${SCRIPT_DIR}/common.sh"

usage() {
  cat <<'EOF'
Usage: install-gits-user-service.sh [options]

Install or refresh the systemd user unit for the hosted GITS cockpit.
Works on any systemd-capable Linux host, including WSL2.

Options:
  --repo PATH                 Source repo used to run the deploy scripts.
  --worktree PATH             Clean deploy worktree served by systemd.
  --remote NAME               Git remote to fetch. Default: origin
  --branch NAME               Branch to deploy. Default: gits
  --service NAME              User service name. Default: gits-cockpit.service
  --host HOST                 Hosted HTTP bind host. Default: 127.0.0.1
  --port PORT                 Hosted HTTP port. Default: 13773
  --t3code-home PATH          T3 Code state directory. Default: $HOME/.t3
  --memory-max VALUE          systemd MemoryMax= for the service cgroup. Default: 6G
  --node-heap-mb MB           Node --max-old-space-size in MiB. Default: 4096
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
node_bin_dir="$(dirname "$node_path")"
# systemd user units inherit a minimal PATH that omits the Node/nvm bin dir where `codex`
# (@openai/codex, a `#!/usr/bin/env node` script) and `node` itself live. Without it the hosted
# server cannot spawn provider CLIs ("Codex CLI (`codex`) is not installed or not on PATH").
service_path="${node_bin_dir}:${HOME}/.bun/bin:${HOME}/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
unit_path="$(gits_hosting_service_unit_path)"
metadata_path="$(gits_hosting_metadata_path)"
mkdir -p "$(dirname "$unit_path")"

dev_env_lines=""
for dev_var in GITS_DEV_ALLOWED_HOSTS GITS_DEV_BIND_HOST GITS_DEV_TAILSCALE_SERVE; do
  dev_value="${!dev_var:-}"
  if [[ -n "$dev_value" ]]; then
    dev_env_lines+="Environment=${dev_var}=${dev_value}"$'\n'
  fi
done

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
Environment=GITS_BUILD_INFO_PATH=${metadata_path}
Environment=GITS_CONFINE_BIN=${gits_hosting_worktree}/scripts/gits-confine.sh
Environment=PATH=${service_path}
${dev_env_lines}ExecStart=${node_path} --max-old-space-size=${gits_hosting_node_heap_mb} apps/server/dist/bin.mjs serve --host ${gits_hosting_host} --port ${gits_hosting_port}
Restart=on-failure
RestartSec=3
MemoryMax=${gits_hosting_memory_max}

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable "$gits_hosting_service" >/dev/null

if ((start_service)); then
  systemctl --user restart "$gits_hosting_service"
fi

gits_hosting_log "Installed user service: $unit_path"
gits_hosting_log "Service command: ${node_path} --max-old-space-size=${gits_hosting_node_heap_mb} apps/server/dist/bin.mjs serve --host ${gits_hosting_host} --port ${gits_hosting_port}"
gits_hosting_log "Build metadata path: $metadata_path"

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
