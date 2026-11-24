FROM mcr.microsoft.com/playwright:v1.65.1-noble

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Ensure Node 22 + pnpm are available
RUN node -v && npm install -g pnpm@10

WORKDIR /app

COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/astro-dev-edit/package.json packages/astro-dev-edit/
COPY packages/workspace-runner/package.json packages/workspace-runner/

RUN pnpm install --filter @halley/workspace-runner... --prod=false

COPY packages/shared packages/shared
COPY packages/astro-dev-edit packages/astro-dev-edit
COPY packages/workspace-runner packages/workspace-runner

RUN pnpm --filter @halley/shared build \
 && pnpm --filter @halley/astro-dev-edit build \
 && pnpm --filter @halley/workspace-runner build

COPY docker/workspace-entrypoint.sh /usr/local/bin/halley-workspace-entrypoint.sh
RUN chmod +x /usr/local/bin/halley-workspace-entrypoint.sh \
 && mkdir -p /halley-volume /halley-pkg-cache \
 && chown -R pwuser:pwuser /app /halley-volume /halley-pkg-cache

USER pwuser

# Fail the image build immediately if the installed playwright package and base image Chromium ever drift
RUN node --input-type=module -e "import { chromium } from '/app/packages/workspace-runner/node_modules/playwright/index.mjs'; const b = await chromium.launch(); await b.close(); console.log('Playwright Chromium verified OK');"

EXPOSE 4100 4321

ENTRYPOINT ["/usr/local/bin/halley-workspace-entrypoint.sh"]
