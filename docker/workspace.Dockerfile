FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    ca-certificates \
    ripgrep \
    python3 \
    jq \
  && rm -rf /var/lib/apt/lists/*

# Ensure Node 22 + pnpm are available and prepare directories for unprivileged node user
RUN node -v \
 && npm install -g pnpm@10 \
 && mkdir -p /app /halley-volume /halley-pkg-cache \
 && chown node:node /app /halley-volume /halley-pkg-cache

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

EXPOSE 4100 4321

ENTRYPOINT ["/usr/local/bin/halley-workspace-entrypoint.sh"]
