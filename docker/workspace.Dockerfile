FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    ca-certificates \
    ripgrep \
    python3 \
    jq \
    gosu \
  && rm -rf /var/lib/apt/lists/*

# Ensure Node 22 + pnpm are available and prepare directories for unprivileged node user
RUN node -v \
 && npm install -g pnpm@10 \
 && mkdir -p /app /workspaces \
 && chown node:node /app /workspaces

COPY docker/workspace-entrypoint.sh /usr/local/bin/halley-workspace-entrypoint.sh
RUN chmod +x /usr/local/bin/halley-workspace-entrypoint.sh

WORKDIR /app
USER node

COPY --chown=node:node package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY --chown=node:node packages/shared/package.json packages/shared/
COPY --chown=node:node packages/astro-dev-edit/package.json packages/astro-dev-edit/
COPY --chown=node:node packages/workspace-runner/package.json packages/workspace-runner/

RUN pnpm install --frozen-lockfile --filter @halley/workspace-runner... --prod=false

COPY --chown=node:node packages/shared packages/shared
COPY --chown=node:node packages/astro-dev-edit packages/astro-dev-edit
COPY --chown=node:node packages/workspace-runner packages/workspace-runner

RUN pnpm --filter @halley/shared build \
 && pnpm --filter @halley/astro-dev-edit build \
 && pnpm --filter @halley/workspace-runner build

ENV WORKSPACES_DIR=/workspaces
ENV SUPERVISOR_PORT=4000
EXPOSE 4000

# Start entrypoint as root solely to self-heal /workspaces volume ownership (e.g. NAS bind mounts),
# then immediately drop privileges to unprivileged `node` via gosu.
USER root
ENTRYPOINT ["/usr/local/bin/halley-workspace-entrypoint.sh"]
