#!/usr/bin/env bash
set -euo pipefail

name="${GITS_DEV_NAME:-Dev command}"
cwd="${GITS_DEV_CWD:-}"
command_text="${GITS_DEV_COMMAND:-}"
local_port="${GITS_DEV_LOCAL_PORT:-}"
local_host="${GITS_DEV_LOCAL_HOST:-127.0.0.1}"
publish_tailnet="${GITS_DEV_PUBLISH_TAILNET:-0}"
serve_port="${GITS_DEV_SERVE_PORT:-}"
preview_url="${GITS_DEV_PREVIEW_URL:-}"

if [[ -z "$cwd" ]]; then
  echo "[gits-dev] GITS_DEV_CWD is required." >&2
  exit 1
fi

if [[ -z "$command_text" ]]; then
  echo "[gits-dev] GITS_DEV_COMMAND is required." >&2
  exit 1
fi

if [[ "$publish_tailnet" == "1" && -z "$local_port" ]]; then
  echo "[gits-dev] GITS_DEV_LOCAL_PORT is required when tailnet publishing is enabled." >&2
  exit 1
fi

if [[ "$publish_tailnet" == "1" && -z "$serve_port" ]]; then
  serve_port="$local_port"
fi

published=0
child_pid=""

cleanup() {
  if [[ -n "$child_pid" ]]; then
    kill "$child_pid" 2>/dev/null || true
  fi
  if [[ "$published" == "1" && -n "$serve_port" ]]; then
    tailscale serve --https="$serve_port" off >/dev/null 2>&1 || true
  fi
}

trap cleanup INT TERM EXIT

wait_for_port() {
  local host="$1"
  local port="$2"
  local attempts=120
  local sleep_seconds=0.5

  for ((i = 0; i < attempts; i += 1)); do
    if bash -lc "exec 3<>/dev/tcp/${host}/${port}" >/dev/null 2>&1; then
      return 0
    fi
    sleep "$sleep_seconds"
  done

  return 1
}

cd "$cwd"
echo "[gits-dev] Starting ${name} in ${cwd}"

bash -lc "$command_text" &
child_pid="$!"

if [[ "$publish_tailnet" == "1" ]]; then
  echo "[gits-dev] Waiting for ${local_host}:${local_port} to accept connections"
  if ! wait_for_port "$local_host" "$local_port"; then
    echo "[gits-dev] Timed out waiting for ${local_host}:${local_port}" >&2
    wait "$child_pid"
    exit $?
  fi

  echo "[gits-dev] Publishing https tailnet port ${serve_port} -> http://${local_host}:${local_port}"
  tailscale serve --bg --https="$serve_port" "http://${local_host}:${local_port}"
  published=1

  if [[ -n "$preview_url" ]]; then
    echo "[gits-dev] Preview URL: ${preview_url}"
  fi
fi

wait "$child_pid"
