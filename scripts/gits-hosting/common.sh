#!/usr/bin/env bash

if [[ -n "${GITS_HOSTING_COMMON_SH_LOADED:-}" ]]; then
  return 0
fi
readonly GITS_HOSTING_COMMON_SH_LOADED=1

readonly GITS_HOSTING_DEFAULT_REMOTE="origin"
readonly GITS_HOSTING_DEFAULT_BRANCH="feat/gits-rtk-output-gateway"
readonly GITS_HOSTING_DEFAULT_REPO="${HOME}/dev/projects/t3code"
readonly GITS_HOSTING_DEFAULT_WORKTREE="${HOME}/dev/projects/t3code-gits-hosted"
readonly GITS_HOSTING_DEFAULT_SERVICE="gits-cockpit.service"
readonly GITS_HOSTING_DEFAULT_PORT="13773"
readonly GITS_HOSTING_DEFAULT_TAILNET_HTTPS_PORT="8443"
readonly GITS_HOSTING_DEFAULT_T3CODE_HOME="${HOME}/.t3"
readonly GITS_HOSTING_DEFAULT_METADATA_RELATIVE_PATH="apps/server/dist/gits-build-metadata.json"
readonly GITS_HOSTING_MANAGED_SENTINEL=".gits-hosting-managed"

gits_hosting_load_defaults() {
  gits_hosting_repo="${GITS_HOSTING_REPO:-$GITS_HOSTING_DEFAULT_REPO}"
  gits_hosting_worktree="${GITS_HOSTING_WORKTREE:-$GITS_HOSTING_DEFAULT_WORKTREE}"
  gits_hosting_remote="${GITS_HOSTING_REMOTE:-$GITS_HOSTING_DEFAULT_REMOTE}"
  gits_hosting_branch="${GITS_HOSTING_BRANCH:-$GITS_HOSTING_DEFAULT_BRANCH}"
  gits_hosting_service="${GITS_HOSTING_SERVICE:-$GITS_HOSTING_DEFAULT_SERVICE}"
  gits_hosting_port="${GITS_HOSTING_PORT:-$GITS_HOSTING_DEFAULT_PORT}"
  gits_hosting_tailnet_https_port="${GITS_HOSTING_TAILNET_HTTPS_PORT:-$GITS_HOSTING_DEFAULT_TAILNET_HTTPS_PORT}"
  gits_hosting_t3code_home="${T3CODE_HOME:-$GITS_HOSTING_DEFAULT_T3CODE_HOME}"
  gits_hosting_metadata_relative_path="${GITS_HOSTING_METADATA_RELATIVE_PATH:-$GITS_HOSTING_DEFAULT_METADATA_RELATIVE_PATH}"
  gits_hosting_help_requested=0
  gits_hosting_remaining_args=()
}

gits_hosting_log() {
  printf '[gits-hosting] %s\n' "$*"
}

gits_hosting_die() {
  printf '[gits-hosting] ERROR: %s\n' "$*" >&2
  exit 1
}

gits_hosting_require_command() {
  local command_name="$1"
  command -v "$command_name" >/dev/null 2>&1 || gits_hosting_die "Missing required command: $command_name"
}

gits_hosting_require_option_value() {
  local option_name="$1"
  local option_value="${2:-}"
  [[ -n "$option_value" ]] || gits_hosting_die "Option $option_name requires a value."
}

gits_hosting_parse_common_args() {
  gits_hosting_remaining_args=()
  while (($#)); do
    case "$1" in
      --repo)
        gits_hosting_require_option_value "$1" "${2:-}"
        gits_hosting_repo="$2"
        shift 2
        ;;
      --worktree)
        gits_hosting_require_option_value "$1" "${2:-}"
        gits_hosting_worktree="$2"
        shift 2
        ;;
      --remote)
        gits_hosting_require_option_value "$1" "${2:-}"
        gits_hosting_remote="$2"
        shift 2
        ;;
      --branch)
        gits_hosting_require_option_value "$1" "${2:-}"
        gits_hosting_branch="$2"
        shift 2
        ;;
      --service)
        gits_hosting_require_option_value "$1" "${2:-}"
        gits_hosting_service="$2"
        shift 2
        ;;
      --port)
        gits_hosting_require_option_value "$1" "${2:-}"
        gits_hosting_port="$2"
        shift 2
        ;;
      --tailnet-https-port)
        gits_hosting_require_option_value "$1" "${2:-}"
        gits_hosting_tailnet_https_port="$2"
        shift 2
        ;;
      --t3code-home)
        gits_hosting_require_option_value "$1" "${2:-}"
        gits_hosting_t3code_home="$2"
        shift 2
        ;;
      --metadata-relative-path)
        gits_hosting_require_option_value "$1" "${2:-}"
        gits_hosting_metadata_relative_path="$2"
        shift 2
        ;;
      --help|-h)
        gits_hosting_help_requested=1
        shift
        ;;
      *)
        gits_hosting_remaining_args+=("$1")
        shift
        ;;
    esac
  done
}

gits_hosting_require_clean_args() {
  if ((${#gits_hosting_remaining_args[@]} > 0)); then
    gits_hosting_die "Unexpected arguments: ${gits_hosting_remaining_args[*]}"
  fi
}

gits_hosting_service_unit_path() {
  printf '%s/systemd/user/%s' "${XDG_CONFIG_HOME:-$HOME/.config}" "$gits_hosting_service"
}

gits_hosting_metadata_path() {
  printf '%s/%s' "$gits_hosting_worktree" "$gits_hosting_metadata_relative_path"
}

gits_hosting_assert_git_repo() {
  git -C "$gits_hosting_repo" rev-parse --is-inside-work-tree >/dev/null 2>&1 || \
    gits_hosting_die "Repo path is not a git worktree: $gits_hosting_repo"
}
