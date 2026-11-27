#!/usr/bin/env bash
set -euo pipefail

WORKSPACES_DIR="${WORKSPACES_DIR:-/workspaces}"

if [ "$(id -u)" -eq 0 ]; then
  mkdir -p \
    "${WORKSPACES_DIR}" \
    "${WORKSPACES_DIR}/sessions" \
    "${WORKSPACES_DIR}/nm-cache" \
    "${WORKSPACES_DIR}/pkg-cache" \
    "${WORKSPACES_DIR}/git-mirror" \
    "${WORKSPACES_DIR}/verify-sandbox"
  chown node:node \
    "${WORKSPACES_DIR}" \
    "${WORKSPACES_DIR}/sessions" \
    "${WORKSPACES_DIR}/nm-cache" \
    "${WORKSPACES_DIR}/pkg-cache" \
    "${WORKSPACES_DIR}/git-mirror" \
    "${WORKSPACES_DIR}/verify-sandbox"
  chmod u+rwx "${WORKSPACES_DIR}"

  # Fast O(top-level) check: only repair non-node ownership on migrated host bind mounts
  # (never walk 200k node_modules files on normal container restarts or strip read-only nm-cache bits!)
  while IFS= read -r -d '' entry; do
    chown -R node:node "${entry}"
  done < <(find "${WORKSPACES_DIR}" -mindepth 1 -maxdepth 2 -not -user node -print0 2>/dev/null || true)

  exec gosu node /usr/bin/tini -- "$0" "$@"
fi

git config --global --add safe.directory '*'
exec node /app/packages/workspace-runner/dist/supervisor.js
