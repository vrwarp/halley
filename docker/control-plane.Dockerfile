FROM node:22-bookworm-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@10

WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/control-plane/package.json packages/control-plane/
COPY packages/web/package.json packages/web/

RUN pnpm install --frozen-lockfile --filter @halley/control-plane... --filter @halley/web...

COPY packages/shared packages/shared
COPY packages/control-plane packages/control-plane
COPY packages/web packages/web

RUN pnpm --filter @halley/shared build \
 && pnpm --filter @halley/web build \
 && pnpm --filter @halley/control-plane build

FROM node:22-bookworm-slim AS runner
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates gosu tini \
  && rm -rf /var/lib/apt/lists/* \
  && git config --system --add safe.directory '*' \
  && mkdir -p /app /data /ms-playwright \
  && chown -R node:node /app /data /ms-playwright

COPY docker/control-plane-entrypoint.sh /usr/local/bin/halley-control-plane-entrypoint.sh
RUN chmod +x /usr/local/bin/halley-control-plane-entrypoint.sh

WORKDIR /app
ENV PORT=3000
ENV DATA_DIR=/data
ENV HALLEY_WEB_DIST=/app/packages/web/dist
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY --from=builder --chown=node:node /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/packages/control-plane/package.json ./packages/control-plane/package.json
COPY --from=builder --chown=node:node /app/packages/control-plane/node_modules ./packages/control-plane/node_modules

# Install Chromium (only) + OS libs for the shared screenshot service before copying app dist layers
RUN node /app/packages/control-plane/node_modules/playwright/cli.js install --with-deps chromium \
  && chmod -R a+rX /ms-playwright \
  && rm -rf /var/lib/apt/lists/* \
  && gosu node node --input-type=module -e "import { chromium } from '/app/packages/control-plane/node_modules/playwright/index.mjs'; const b = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] }); await b.close(); console.log('Playwright Chromium verified OK as non-root node');"

COPY --from=builder --chown=node:node /app/packages/shared ./packages/shared
COPY --from=builder --chown=node:node /app/packages/control-plane/dist ./packages/control-plane/dist
COPY --from=builder --chown=node:node /app/packages/web/dist ./packages/web/dist

EXPOSE 3000
USER root
ENTRYPOINT ["/usr/local/bin/halley-control-plane-entrypoint.sh"]
