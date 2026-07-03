#!/usr/bin/env bash
# Native-Linux ingress: publish the local GITS cockpit to the tailnet via
# `tailscale serve`. On WSL the Windows-side Set-GitsTailnetPortProxy.ps1 does
# this instead; this script is a no-op when WSL_DISTRO_NAME is set so both
# topologies can call it unconditionally from a wrapper.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${SCRIPT_DIR}/common.sh"

usage() {
  cat <<'EOF'
Usage: configure-tailscale-serve.sh [options]

Publish the local GITS cockpit to the tailnet via `tailscale serve`.
Skipped automatically when WSL_DISTRO_NAME is set (use Set-GitsTailnetPortProxy.ps1
from an elevated Windows PowerShell session instead).

Options:
  --host HOST               Cockpit bind host. Default: 127.0.0.1
  --port PORT               Cockpit bind port. Default: 13773
  --tailnet-https-port PORT HTTPS port advertised on the tailnet. Default: 8443
  --skip-serve              Configure guards only; do not call tailscale serve.
  --verify-only             Run guards without changing tailscale serve config.
  --help                    Show this message.
EOF
}

gits_hosting_load_defaults
skip_serve=0
verify_only=0

gits_hosting_parse_common_args "$@"

if ((${#gits_hosting_remaining_args[@]} > 0)); then
  remaining_args=("${gits_hosting_remaining_args[@]}")
  gits_hosting_remaining_args=()
  for arg in "${remaining_args[@]}"; do
    case "$arg" in
      --skip-serve)
        skip_serve=1
        ;;
      --verify-only)
        verify_only=1
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

# ponytail: WSL guard — portproxy is managed by Set-GitsTailnetPortProxy.ps1
# on the Windows side; Tailscale Serve from inside WSL sees the wrong NIC.
if [[ -n "${WSL_DISTRO_NAME:-}" ]]; then
  gits_hosting_log "WSL_DISTRO_NAME=${WSL_DISTRO_NAME} — skipping tailscale serve (use Set-GitsTailnetPortProxy.ps1 on Windows instead)."
  exit 0
fi

gits_hosting_require_command tailscale

tailscale_cmd="$(command -v tailscale)"
listen_address="${gits_hosting_host}"
local_port="${gits_hosting_port}"
tailnet_https_port="${gits_hosting_tailnet_https_port}"

# Guard: Funnel must not be enabled on the HTTPS port.
gits_hosting_log "Checking Funnel status for :${tailnet_https_port}"
funnel_status="$(tailscale funnel status 2>&1 || true)"
if printf '%s\n' "$funnel_status" | grep -qE ":${tailnet_https_port}([^0-9]|$).*Funnel on"; then
  gits_hosting_die "Funnel is enabled on :${tailnet_https_port}. Remove that public Funnel route before serving GITS."
fi

# Guard: no existing serve config must advertise Funnel on the backend port.
gits_hosting_log "Checking tailscale serve status for :${local_port}"
serve_status_before="$(tailscale serve status 2>&1 || true)"
if printf '%s\n' "$serve_status_before" | grep -qE ":${local_port}([^0-9]|$).*Funnel on"; then
  gits_hosting_die "Existing tailscale serve config for :${local_port} is public (Funnel). Remove it first."
fi

if ((skip_serve || verify_only)); then
  gits_hosting_log "Skipped tailscale serve config change (--skip-serve or --verify-only)."
else
  gits_hosting_log "Publishing ${listen_address}:${local_port} to the tailnet on :${tailnet_https_port}"
  tailscale serve \
    --bg \
    --yes \
    "--https=${tailnet_https_port}" \
    "http://${listen_address}:${local_port}"
fi

# Verify: serve must be tailnet-only (no Funnel) after the change.
serve_status="$(tailscale serve status 2>&1 || true)"
printf '%s\n' "$serve_status"

port_lines="$(printf '%s\n' "$serve_status" | grep -E ":${tailnet_https_port}([^0-9]|$)" || true)"
if [[ -z "$port_lines" ]]; then
  gits_hosting_die "tailscale serve status does not show :${tailnet_https_port} — serve may not have applied."
fi
if printf '%s\n' "$port_lines" | grep -qi "Funnel on"; then
  gits_hosting_die "tailscale serve :${tailnet_https_port} is public (Funnel). Refusing to accept this config."
fi
if ! printf '%s\n' "$port_lines" | grep -qi "tailnet only"; then
  gits_hosting_die "tailscale serve :${tailnet_https_port} does not say 'tailnet only'. Check the config."
fi

gits_hosting_log "tailscale serve :${tailnet_https_port} → http://${listen_address}:${local_port} (tailnet only) — OK"
gits_hosting_log "Funnel status:"
tailscale funnel status || true
