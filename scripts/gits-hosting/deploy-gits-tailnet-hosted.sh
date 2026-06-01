#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# Shared defaults keep install and deploy commands aligned.
source "${SCRIPT_DIR}/common.sh"

usage() {
  cat <<'EOF'
Usage: deploy-gits-tailnet-hosted.sh [options]

Create or refresh the clean hosted GITS deploy worktree, build it with Bun,
write build provenance metadata, and restart the WSL user service.

Options:
  --repo PATH                    Source repo that owns the git worktree.
  --worktree PATH                Clean deploy worktree path.
  --remote NAME                  Git remote to fetch. Default: origin
  --branch NAME                  Branch to deploy. Default: feat/gits-tailnet-hosting-refresh
  --service NAME                 User service name. Default: gits-cockpit.service
  --port PORT                    Hosted HTTP port inside WSL. Default: 13773
  --t3code-home PATH             T3 Code state directory. Default: $HOME/.t3
  --metadata-relative-path PATH  Metadata JSON path inside the deploy worktree.
  --skip-install                 Skip bun install --frozen-lockfile.
  --skip-restart                 Build and write metadata without restarting systemd.
  --help                         Show this message.
EOF
}

gits_hosting_load_defaults
skip_install=0
skip_restart=0

gits_hosting_parse_common_args "$@"

if ((${#gits_hosting_remaining_args[@]} > 0)); then
  remaining_args=("${gits_hosting_remaining_args[@]}")
  gits_hosting_remaining_args=()
  for arg in "${remaining_args[@]}"; do
    case "$arg" in
      --skip-install)
        skip_install=1
        ;;
      --skip-restart)
        skip_restart=1
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
gits_hosting_require_command git
gits_hosting_require_command bun
gits_hosting_require_command node
gits_hosting_require_command systemctl
gits_hosting_assert_git_repo

service_unit_path="$(gits_hosting_service_unit_path)"
[[ -f "$service_unit_path" ]] || \
  gits_hosting_die "Missing user service unit at $service_unit_path. Run install-wsl-user-service.sh first."

gits_hosting_log "Fetching ${gits_hosting_remote}/${gits_hosting_branch} from ${gits_hosting_repo}"
git -C "$gits_hosting_repo" fetch --prune "$gits_hosting_remote" "$gits_hosting_branch"

if [[ ! -e "$gits_hosting_worktree/.git" ]]; then
  mkdir -p "$(dirname "$gits_hosting_worktree")"
  gits_hosting_log "Creating managed deploy worktree: $gits_hosting_worktree"
  git -C "$gits_hosting_repo" worktree add --force --detach \
    "$gits_hosting_worktree" "${gits_hosting_remote}/${gits_hosting_branch}"
  : >"${gits_hosting_worktree}/${GITS_HOSTING_MANAGED_SENTINEL}"
elif [[ ! -f "${gits_hosting_worktree}/${GITS_HOSTING_MANAGED_SENTINEL}" ]]; then
  gits_hosting_die \
    "Refusing to mutate $gits_hosting_worktree because ${GITS_HOSTING_MANAGED_SENTINEL} is missing."
fi

gits_hosting_log "Resetting managed worktree to ${gits_hosting_remote}/${gits_hosting_branch}"
git -C "$gits_hosting_worktree" reset --hard "${gits_hosting_remote}/${gits_hosting_branch}"
rm -rf "${gits_hosting_worktree}/apps/server/dist" "${gits_hosting_worktree}/apps/web/dist"

if ((skip_install == 0)); then
  gits_hosting_log "Installing dependencies with bun"
  (cd "$gits_hosting_worktree" && bun install --frozen-lockfile)
fi

gits_hosting_log "Building hosted server bundle"
(cd "$gits_hosting_worktree" && bun run build --filter=t3)

metadata_path="$(gits_hosting_metadata_path)"
mkdir -p "$(dirname "$metadata_path")"

commit_sha="$(git -C "$gits_hosting_worktree" rev-parse HEAD)"
commit_short_sha="$(git -C "$gits_hosting_worktree" rev-parse --short HEAD)"
build_time_utc="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
tracked_dirty="false"
if ! git -C "$gits_hosting_worktree" diff --quiet --ignore-submodules --exit-code || \
  ! git -C "$gits_hosting_worktree" diff --cached --quiet --ignore-submodules --exit-code; then
  tracked_dirty="true"
fi
node_version="$(node --version)"
bun_version="$(bun --version)"

node --input-type=module - "$metadata_path" "$gits_hosting_branch" "$gits_hosting_remote" "$commit_sha" "$commit_short_sha" \
  "$build_time_utc" "$tracked_dirty" "$gits_hosting_repo" "$gits_hosting_worktree" \
  "$node_version" "$bun_version" <<'EOF'
import fs from "node:fs";

const [
  metadataPath,
  branch,
  remote,
  commitSha,
  commitShortSha,
  buildTimeUtc,
  trackedDirty,
  sourceRepo,
  worktree,
  nodeVersion,
  bunVersion,
] = process.argv.slice(2);

const metadata = {
  branch,
  sourceRef: `${remote}/${branch}`,
  commit: commitSha,
  commitSha,
  commitShortSha,
  time: buildTimeUtc,
  buildTime: buildTimeUtc,
  buildTimeUtc,
  dirty: trackedDirty === "true",
  trackedDirty: trackedDirty === "true",
  sourcePath: worktree,
  sourceRepo,
  worktree,
  nodeVersion,
  bunVersion,
  buildCommand: "bun run build --filter=t3",
  installCommand: "bun install --frozen-lockfile",
};

fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2) + "\n");
EOF

gits_hosting_log "Wrote build metadata: $metadata_path"

if ((skip_restart == 0)); then
  gits_hosting_log "Restarting ${gits_hosting_service}"
  systemctl --user restart "$gits_hosting_service"
  systemctl --user --no-pager --full status "$gits_hosting_service"
else
  gits_hosting_log "Skipped service restart."
fi

if ((skip_restart == 0)) && command -v curl >/dev/null 2>&1; then
  gits_hosting_log "Local health check"
  curl --fail --silent --show-error --head "http://127.0.0.1:${gits_hosting_port}/gits"
fi
