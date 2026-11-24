#!/usr/bin/env bash
set -euo pipefail

VOLUME_DIR="/halley-volume"
WORKSPACE_DIR="${VOLUME_DIR}/workspace"
STATE_DIR="${VOLUME_DIR}/state"

mkdir -p "${STATE_DIR}"
git config --global --add safe.directory '*'

if [ ! -d "${WORKSPACE_DIR}/.git" ]; then
  git clone "${HALLEY_MIRROR_PATH:-/halley-mirror}" "${WORKSPACE_DIR}"
  cd "${WORKSPACE_DIR}"
  git remote set-url origin "https://github.com/${HALLEY_REPO}.git"
  git checkout -B "${HALLEY_WORKING_BRANCH}" "${HALLEY_BASE_BRANCH}"
  export HALLEY_BASE_SHA="$(git rev-parse HEAD)"

  if [ -f package-lock.json ]; then
    npm ci --cache /halley-pkg-cache/npm --prefer-offline --ignore-scripts
  elif [ -f pnpm-lock.yaml ]; then
    pnpm install --store-dir /halley-pkg-cache/pnpm --frozen-lockfile
  elif [ -f package.json ]; then
    npm install --cache /halley-pkg-cache/npm --prefer-offline --ignore-scripts
  fi
else
  cd "${WORKSPACE_DIR}"
  if [ -z "${HALLEY_BASE_SHA:-}" ]; then
    export HALLEY_BASE_SHA="$(git rev-parse "origin/${HALLEY_BASE_BRANCH}" 2>/dev/null || git rev-parse HEAD)"
  fi
fi

export HALLEY_WORKSPACE_DIR="${WORKSPACE_DIR}"
export HALLEY_STATE_DIR="${STATE_DIR}"

exec node /app/packages/workspace-runner/dist/index.js
