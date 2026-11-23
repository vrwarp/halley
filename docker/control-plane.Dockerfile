FROM node:22-bookworm-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@10

WORKDIR /app
COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/control-plane/package.json packages/control-plane/
COPY packages/web/package.json packages/web/

RUN pnpm install --filter @halley/control-plane... --filter @halley/web...

COPY packages/shared packages/shared
COPY packages/control-plane packages/control-plane
COPY packages/web packages/web

RUN pnpm --filter @halley/shared build \
 && pnpm --filter @halley/web build \
 && pnpm --filter @halley/control-plane build

FROM node:22-bookworm-slim AS runner
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates docker-cli \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/shared ./packages/shared
COPY --from=builder /app/packages/control-plane ./packages/control-plane
COPY --from=builder /app/packages/web/dist ./packages/web/dist

ENV PORT=3000
ENV DATA_DIR=/data
ENV HALLEY_WEB_DIST=/app/packages/web/dist

EXPOSE 3000
CMD ["node", "/app/packages/control-plane/dist/index.js"]
