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

# No git process can be running yet: any .git/index.lock / HEAD.lock under session workspaces was
# left by a git killed with the previous container (OOM, docker stop) and would block every
# checkpoint until removed. (The runner also clears stale locks at runtime.)
find "${WORKSPACES_DIR}/sessions" "${WORKSPACES_DIR}/verify-sandbox" -mindepth 2 -maxdepth 4 \
  -path '*/.git/*' \( -name index.lock -o -name HEAD.lock \) -type f -print -delete 2>/dev/null || true

exec node /app/packages/workspace-runner/dist/supervisor.js
