#!/usr/bin/env bash
set -euo pipefail

DATA_DIR="${DATA_DIR:-/data}"

if [ "$(id -u)" -eq 0 ]; then
  mkdir -p "${DATA_DIR}" "${DATA_DIR}/git-mirror"
  chown node:node "${DATA_DIR}" "${DATA_DIR}/git-mirror"
  while IFS= read -r -d '' entry; do
    chown -R node:node "${entry}"
  done < <(find "${DATA_DIR}" -mindepth 1 -maxdepth 2 -not -user node -print0 2>/dev/null || true)
  exec gosu node /usr/bin/tini -- "$0" "$@"
fi

git config --global --add safe.directory '*'
exec node /app/packages/control-plane/dist/index.js
