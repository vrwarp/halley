#!/usr/bin/env bash
set -euo pipefail

VOLUME_DIR="/halley-volume"
WORKSPACE_DIR="${VOLUME_DIR}/workspace"
STATE_DIR="${VOLUME_DIR}/state"

if [ "$(id -u)" -eq 0 ]; then
  mkdir -p "${VOLUME_DIR}" "${STATE_DIR}" /halley-pkg-cache
  chown node:node "${VOLUME_DIR}" /halley-pkg-cache
  chmod u+rwx "${VOLUME_DIR}" /halley-pkg-cache
  # Always guarantee STATE_DIR (pi.sqlite, WAL/SHM/journal, uploads, meta) is writable by node
  chown -R node:node "${STATE_DIR}"
  chmod -R u+rwX "${STATE_DIR}"

  # Self-heal workspace/repo files migrated from older image UIDs (e.g. pwuser 1001 -> node 1000) or root
  if [ -n "$(find "${VOLUME_DIR}" -maxdepth 3 \( -not -user node -o -not -perm -u+w \) -print -quit 2>/dev/null)" ]; then
    chown -R node:node "${VOLUME_DIR}"
    chmod -R u+rwX "${VOLUME_DIR}"
  fi
  if [ -n "$(find /halley-pkg-cache -maxdepth 2 \( -not -user node -o -not -perm -u+w \) -print -quit 2>/dev/null)" ]; then
    chown -R node:node /halley-pkg-cache
    chmod -R u+rwX /halley-pkg-cache
  fi
  if [ -d /halley-mirror ]; then
    chmod -R a+rX /halley-mirror 2>/dev/null || true
  fi
  exec gosu node "$0" "$@"
fi

mkdir -p "${STATE_DIR}"
git config --global --add safe.directory '*'

if [ ! -d "${WORKSPACE_DIR}/.git" ]; then
  echo "[halley-boot] cloning_repo"
  git clone "${HALLEY_MIRROR_PATH:-/halley-mirror}" "${WORKSPACE_DIR}"
  cd "${WORKSPACE_DIR}"
  git remote set-url origin "https://github.com/${HALLEY_REPO}.git"
  git checkout -B "${HALLEY_WORKING_BRANCH:-halley/standby}" "${HALLEY_BASE_BRANCH}"
  git config rerere.enabled true
  git config rerere.autoupdate true
  export HALLEY_BASE_SHA="$(git rev-parse HEAD)"
else
  cd "${WORKSPACE_DIR}"
  git config rerere.enabled true || true
  git config rerere.autoupdate true || true
  if [ -z "${HALLEY_BASE_SHA:-}" ]; then
    export HALLEY_BASE_SHA="$(git rev-parse "origin/${HALLEY_BASE_BRANCH}" 2>/dev/null || git rev-parse HEAD)"
  fi
fi

# Install dependencies on first boot or on wake after 7-day node_modules pruning
if [ ! -d "${WORKSPACE_DIR}/node_modules" ]; then
  echo "[halley-boot] installing_deps"
  if [ -f package-lock.json ]; then
    npm ci --cache /halley-pkg-cache/npm --prefer-offline --ignore-scripts
  elif [ -f pnpm-lock.yaml ]; then
    pnpm install --store-dir /halley-pkg-cache/pnpm --frozen-lockfile
  elif [ -f package.json ]; then
    npm install --cache /halley-pkg-cache/npm --prefer-offline --ignore-scripts
  fi
fi

export HALLEY_WORKSPACE_DIR="${WORKSPACE_DIR}"
export HALLEY_STATE_DIR="${STATE_DIR}"

echo "[halley-boot] starting_preview"
exec node /app/packages/workspace-runner/dist/index.js
