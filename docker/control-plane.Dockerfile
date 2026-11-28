# Base image is pinned by digest (node:22-bookworm-slim, Node 22 / Debian bookworm). Bump it
# deliberately: `docker pull node:22-bookworm-slim && docker image inspect node:22-bookworm-slim
# --format '{{index .RepoDigests 0}}'`, then replace every FROM below.
#
# apt packages are intentionally NOT version-pinned: deb.debian.org / security.debian.org only
# serve the current revision of each package, so `pkg=<version>` pins break the build on every
# Debian security update. Reproducibility comes from the digest-pinned base (its apt sources and
# node/npm are fixed) and the frozen pnpm lockfile; rebuilding picks up Debian security fixes.
#
# Optional build-time CA (no-op by default, never written into an image layer): for builds behind a
# TLS-intercepting proxy pass `--secret id=extra_ca_cert,src=/path/to/ca.pem`; it is mounted only
# for the RUN steps that download (NODE_EXTRA_CA_CERTS for npm/pnpm/playwright).

FROM node:22-bookworm-slim@sha256:be979e5523c76fa4d5ca4ebd3099078f220aa47ec39c48ad5b5df9314debd6eb AS builder

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
# Keep in sync with "packageManager" in the root package.json.
RUN --mount=type=secret,id=extra_ca_cert,required=false \
    if [ -s /run/secrets/extra_ca_cert ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca_cert; fi \
 && npm install -g pnpm@10.0.0

WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/control-plane/package.json packages/control-plane/
COPY packages/web/package.json packages/web/

RUN --mount=type=secret,id=extra_ca_cert,required=false \
    if [ -s /run/secrets/extra_ca_cert ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca_cert; fi \
 && pnpm install --frozen-lockfile --filter @halley/control-plane... --filter @halley/web...

COPY packages/shared packages/shared
COPY packages/control-plane packages/control-plane
COPY packages/web packages/web

RUN pnpm --filter @halley/shared build \
 && pnpm --filter @halley/web build \
 && pnpm --filter @halley/control-plane build

FROM node:22-bookworm-slim@sha256:be979e5523c76fa4d5ca4ebd3099078f220aa47ec39c48ad5b5df9314debd6eb AS runner
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
RUN --mount=type=secret,id=extra_ca_cert,required=false \
    if [ -s /run/secrets/extra_ca_cert ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca_cert; fi \
  && node /app/packages/control-plane/node_modules/playwright/cli.js install --with-deps chromium \
  && chmod -R a+rX /ms-playwright \
  && rm -rf /var/lib/apt/lists/* \
  && gosu node node --input-type=module -e "import { chromium } from '/app/packages/control-plane/node_modules/playwright/index.mjs'; const b = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] }); await b.close(); console.log('Playwright Chromium verified OK as non-root node');"

COPY --from=builder --chown=node:node /app/packages/shared ./packages/shared
COPY --from=builder --chown=node:node /app/packages/control-plane/dist ./packages/control-plane/dist
COPY --from=builder --chown=node:node /app/packages/web/dist ./packages/web/dist

EXPOSE 3000
# /api/health is unauthenticated (and checks the DB). Uses Node's built-in fetch: no curl in image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --start-interval=2s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
USER root
ENTRYPOINT ["/usr/local/bin/halley-control-plane-entrypoint.sh"]
