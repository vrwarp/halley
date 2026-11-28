# Base image is pinned by digest (node:22-bookworm-slim, Node 22 / Debian bookworm). Bump it
# deliberately: `docker pull node:22-bookworm-slim && docker image inspect node:22-bookworm-slim
# --format '{{index .RepoDigests 0}}'`, then replace the FROM below.
#
# apt packages are intentionally NOT version-pinned: deb.debian.org / security.debian.org only
# serve the current revision of each package, so `pkg=<version>` pins break the build on every
# Debian security update. Reproducibility comes from the digest-pinned base (its apt sources and
# node/npm are fixed) and the frozen pnpm lockfile; rebuilding picks up Debian security fixes.
#
# Optional build-time CA (no-op by default, never written into an image layer): for builds behind a
# TLS-intercepting proxy pass `--secret id=extra_ca_cert,src=/path/to/ca.pem`; it is mounted only
# for the RUN steps that download (NODE_EXTRA_CA_CERTS for npm/pnpm).
#
# Stage layout (multi-stage only to drop build-time weight; the runtime layout under /app is
# unchanged): `base` = OS packages + pnpm + entrypoint, `build` = full install + tsc, `prod-deps` =
# production-only node_modules (no astro/vitest/typescript dev trees, no pnpm store in the image).
FROM node:22-bookworm-slim@sha256:be979e5523c76fa4d5ca4ebd3099078f220aa47ec39c48ad5b5df9314debd6eb AS base

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    ca-certificates \
    ripgrep \
    python3 \
    jq \
    gosu \
    tini \
  && rm -rf /var/lib/apt/lists/*

# Ensure Node 22 + pnpm are available and prepare directories for unprivileged node user
# (pnpm version kept in sync with "packageManager" in the root package.json)
RUN --mount=type=secret,id=extra_ca_cert,required=false \
    if [ -s /run/secrets/extra_ca_cert ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca_cert; fi \
 && node -v \
 && npm install -g pnpm@10.0.0 \
 && npm cache clean --force \
 && mkdir -p /app /workspaces \
 && chown node:node /app /workspaces

COPY docker/workspace-entrypoint.sh /usr/local/bin/halley-workspace-entrypoint.sh
RUN chmod +x /usr/local/bin/halley-workspace-entrypoint.sh

WORKDIR /app

# ---------------------------------------------------------------------------------------------
FROM base AS manifests
USER node
COPY --chown=node:node package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY --chown=node:node packages/shared/package.json packages/shared/
COPY --chown=node:node packages/astro-dev-edit/package.json packages/astro-dev-edit/
COPY --chown=node:node packages/workspace-runner/package.json packages/workspace-runner/

# ---------------------------------------------------------------------------------------------
FROM manifests AS build
RUN --mount=type=secret,id=extra_ca_cert,required=false,uid=1000 \
    --mount=type=cache,id=halley-pnpm-store,target=/home/node/.local/share/pnpm/store,uid=1000,gid=1000 \
    if [ -s /run/secrets/extra_ca_cert ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca_cert; fi \
 && pnpm install --frozen-lockfile --filter @halley/workspace-runner... --prod=false

COPY --chown=node:node packages/shared packages/shared
COPY --chown=node:node packages/astro-dev-edit packages/astro-dev-edit
COPY --chown=node:node packages/workspace-runner packages/workspace-runner

RUN pnpm --filter @halley/shared build \
 && pnpm --filter @halley/astro-dev-edit build \
 && pnpm --filter @halley/workspace-runner build

# ---------------------------------------------------------------------------------------------
FROM manifests AS prod-deps
RUN --mount=type=secret,id=extra_ca_cert,required=false,uid=1000 \
    --mount=type=cache,id=halley-pnpm-store,target=/home/node/.local/share/pnpm/store,uid=1000,gid=1000 \
    if [ -s /run/secrets/extra_ca_cert ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca_cert; fi \
 && pnpm install --frozen-lockfile --prod --filter @halley/workspace-runner...

# ---------------------------------------------------------------------------------------------
FROM base AS runtime
USER node
COPY --from=prod-deps --chown=node:node /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml ./
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=prod-deps --chown=node:node /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=prod-deps --chown=node:node /app/packages/astro-dev-edit/node_modules ./packages/astro-dev-edit/node_modules
COPY --from=prod-deps --chown=node:node /app/packages/workspace-runner/node_modules ./packages/workspace-runner/node_modules
COPY --from=build --chown=node:node /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build --chown=node:node /app/packages/shared/dist ./packages/shared/dist
COPY --from=build --chown=node:node /app/packages/astro-dev-edit/package.json ./packages/astro-dev-edit/package.json
COPY --from=build --chown=node:node /app/packages/astro-dev-edit/dist ./packages/astro-dev-edit/dist
COPY --from=build --chown=node:node /app/packages/workspace-runner/package.json ./packages/workspace-runner/package.json
COPY --from=build --chown=node:node /app/packages/workspace-runner/dist ./packages/workspace-runner/dist

ENV WORKSPACES_DIR=/workspaces
ENV SUPERVISOR_PORT=4000
EXPOSE 4000

# The supervisor's /health requires the host Bearer token once the control plane has handshaken,
# so the check treats ANY HTTP response (200, or 401 once auth is armed) as "process up and serving";
# only connection errors/timeouts/5xx fail. This is a strict superset of a TCP connect check.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --start-interval=2s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.SUPERVISOR_PORT||4000)+'/health',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.status<500?0:1),()=>process.exit(1))"]

# Fix top-level /workspaces bind-mount ownership if needed, drop root via gosu,
# and exec /usr/bin/tini as unprivileged `node` PID 1 to reap reparented grandchildren.
USER root
ENTRYPOINT ["/usr/local/bin/halley-workspace-entrypoint.sh"]
