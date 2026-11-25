#!/usr/bin/env bash
set -euo pipefail

WORKSPACES_DIR="${WORKSPACES_DIR:-/workspaces}"

if [ "$(id -u)" -eq 0 ]; then
  mkdir -p "${WORKSPACES_DIR}" "${WORKSPACES_DIR}/sessions" "${WORKSPACES_DIR}/nm-cache" "${WORKSPACES_DIR}/pkg-cache" "${WORKSPACES_DIR}/git-mirror"
  chown node:node "${WORKSPACES_DIR}" "${WORKSPACES_DIR}/sessions" "${WORKSPACES_DIR}/nm-cache" "${WORKSPACES_DIR}/pkg-cache" "${WORKSPACES_DIR}/git-mirror"
  chmod u+rwx "${WORKSPACES_DIR}"

  # Self-heal bind mounts / migrated volumes if top-level entries aren't owned by node
  if [ -n "$(find "${WORKSPACES_DIR}" -maxdepth 2 \( -not -user node -o -not -perm -u+w \) -print -quit 2>/dev/null)" ]; then
    chown -R node:node "${WORKSPACES_DIR}"
    chmod -R u+rwX "${WORKSPACES_DIR}"
  fi
  exec gosu node "$0" "$@"
fi

git config --global --add safe.directory '*'
exec node /app/packages/workspace-runner/dist/supervisor.js
