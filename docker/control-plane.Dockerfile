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
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && git config --system --add safe.directory '*'
COPY --from=docker:27-cli /usr/local/bin/docker /usr/local/bin/docker

WORKDIR /app
ENV PORT=3000
ENV DATA_DIR=/data
ENV HALLEY_WEB_DIST=/app/packages/web/dist
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY --from=builder /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/control-plane/package.json ./packages/control-plane/package.json
COPY --from=builder /app/packages/control-plane/node_modules ./packages/control-plane/node_modules

# Install Chromium (only) + OS libs for the shared screenshot service before copying app dist layers
RUN node /app/packages/control-plane/node_modules/playwright/cli.js install --with-deps chromium \
  && rm -rf /var/lib/apt/lists/* \
  && node --input-type=module -e "import { chromium } from '/app/packages/control-plane/node_modules/playwright/index.mjs'; const b = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] }); await b.close(); console.log('Playwright Chromium verified OK');"

COPY --from=builder /app/packages/shared ./packages/shared
COPY --from=builder /app/packages/control-plane/dist ./packages/control-plane/dist
COPY --from=builder /app/packages/web/dist ./packages/web/dist

EXPOSE 3000
CMD ["node", "/app/packages/control-plane/dist/index.js"]
