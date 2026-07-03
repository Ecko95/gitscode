#!/usr/bin/env bash
# ponytail: backward-compat shim — callers that pre-date the rename still work.
# New scripts should call install-gits-user-service.sh directly.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
exec "${SCRIPT_DIR}/install-gits-user-service.sh" "$@"
