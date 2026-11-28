# Halley

A hosted, chat-forward web editor for GitHub-hosted **Astro** websites. Non-technical editors sign in with Google, chat with a durable **Pi** coding agent (`@earendil-works/pi-durable`), edit static `.astro` text inline in a live `astro dev` preview (with a Notion-style floating bubble menu supporting **Bold**, **Italic**, and `url('/...')`-aware internal **Links**), and click **Publish to Live Site** to run checks, rebase, open a PR, and squash auto-merge once CI passes.

## Monorepo Packages

- [`packages/shared`](packages/shared): Shared Zod schemas, TypeScript DTOs, `postMessage` bridge contracts, and WebSocket events.
- [`packages/astro-dev-edit`](packages/astro-dev-edit): Dev-only Astro integration (`@astrojs/compiler` AST classifier, `url()`-aware serializer, Shadow DOM inline bubble menu, `/__editor/*` middleware).
- [`packages/workspace-runner`](packages/workspace-runner): Per-session Hono + `ws` runner managing `astro dev` (with `/p/:sessionId/*` base override), `@earendil-works/pi-durable` SQLite runtime, `sharp` image processing, `screenshot_page` (via control-plane), auto-checkpoints, and verification.
- [`packages/control-plane`](packages/control-plane): Gateway & orchestrator handling Google OAuth, email/domain allowlist, daily USD spend proxy for Anthropic, shared Playwright Chromium screenshot service, Docker/Local `WorkspaceDriver`, `/p/:sessionId/*` HTTP + Vite HMR WS proxy, and GitHub PR + auto-merge + Pages deploy polling.
- [`packages/web`](packages/web): Minimalist Notion/Webflow-style light React + Tailwind v4 web editor UI.

## Quick Start (Local Development)

```bash
pnpm install
cp .env.example .env.local
# Fill in .env.local (ANTHROPIC_API_KEY, GOOGLE_CLIENT_ID/SECRET, GITHUB_TOKEN or GITHUB_APP_*)
pnpm build
pnpm typecheck
pnpm test
pnpm test:e2e   # Self-contained Playwright + Astro E2E suite using local fakes (no API keys needed)
```

## Docker Setup & Deployment

Halley runs as a static **two-container** Compose stack with **no `/var/run/docker.sock` mount**:
- **`control-plane`** (`vrwarp/halley-control-plane`, `docker/control-plane.Dockerfile`): Always-on gateway holding all external secrets (`ANTHROPIC_API_KEY`, GitHub credentials, Google OAuth), SQLite state (`/data`), bare git mirror served over internal HTTP, spend-capped LLM proxy, shared warm Playwright Chromium screenshot service (with 1-hour idle auto-close), and preview/HMR proxy.
- **`workspaces`** (`vrwarp/halley-workspace`, `docker/workspace.Dockerfile`): Always-on unprivileged `node` host with **zero external API or GitHub secrets**, running a thin supervisor that manages all editing sessions as isolated subdirectories and child processes under `/workspaces` (pooled `6g` RAM ceiling, hardlinked lockfile-hashed `node_modules` cache with copy-on-change isolation, optional warm standby subprocess, soft 5-session LRU cap, and a container-wide FIFO build queue under `nice -n 10`).

### Option A: Prebuilt Docker Hub Images (Recommended for Production & NAS)

1. Copy `.env.example` to `.env` and fill in your credentials:
   ```bash
   cp .env.example .env
   ```
   Required `.env` settings:
   - `HALLEY_PUBLIC_URL` (e.g. `https://halley.yourdomain.com`)
   - `SESSION_SECRET` (`openssl rand -hex 32`)
   - `GOOGLE_CLIENT_ID` & `GOOGLE_CLIENT_SECRET` (Authorized redirect URI: `${HALLEY_PUBLIC_URL}/api/auth/google/callback`)
   - `HALLEY_ADMIN_EMAILS` & `HALLEY_ALLOWED_DOMAINS` (or `HALLEY_ALLOWED_EMAILS`)
   - `ANTHROPIC_API_KEY`
   - `HALLEY_REPO` (e.g. `owner/site-repo`) & `HALLEY_BASE_BRANCH` (`main`)
   - `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY` + `GITHUB_APP_INSTALLATION_ID` (or `GITHUB_TOKEN`)
   - Optional: `HALLEY_PUBLISH_SKIP_CI=true` merges the publish PR as soon as it is opened instead of waiting for its CI run. Halley first inspects the site's pull-request workflows and only skips the wait when every step is setup, `check`, `build` or a `verify:*` script (checks it already ran on that exact commit); otherwise, or if branch protection refuses the merge, it waits for CI as usual. The optimizer reports any CI-only steps to move into `verify:*` scripts.
2. Start with [`docker-compose.prod.yml`](docker-compose.prod.yml):
   ```bash
   # Optional: expose on a custom host port such as 2243 (container port stays 3000)
   HOST_PORT=2243 docker compose -f docker-compose.prod.yml up -d
   ```
3. Verify preflight health checks at `http://<host>:<port>/api/health/doctor`.

### Option B: Synology NAS (Container Manager + Reverse Proxy)

1. Create `/volume1/docker/halley` and place [`docker-compose.prod.yml`](docker-compose.prod.yml) (renamed to `docker-compose.yml`) and `.env` inside it.
   - To expose Halley on a custom host port (e.g. `2243`), set `ports: ["2243:3000"]` (`HOST:CONTAINER`) on `control-plane`. Keep `CONTROL_PLANE_INTERNAL_URL=http://control-plane:3000` and `WORKSPACE_HOST_URL=http://workspaces:4000`.
   - Map persistent storage: `/volume1/docker/halley/data:/data` on `control-plane` and `/volume1/docker/halley/workspaces:/workspaces` on `workspaces`.
   - Leave **"Execute container using high privilege"** OFF and do **not** mount `/var/run/docker.sock`.
2. In **Container Manager → Project → Create**, point to `/volume1/docker/halley` and start the project.
3. Configure HTTPS + WebSockets in **DSM → Control Panel → Login Portal → Advanced → Reverse Proxy → Create**:
   - **Source:** `HTTPS`, Hostname `halley.yourdomain.com`, Port `443`
   - **Destination:** `HTTP`, Hostname `localhost`, Port `2243` (or `3000`)
   - **Custom Header tab:** Click **Create → WebSocket** (adds `Upgrade` and `Connection` headers required for Pi streaming chat and Astro HMR).

### Option C: Build Images Locally from Source

```bash
cp .env.example .env
pnpm docker:build
docker compose up -d
```

### Preflight Diagnostics & Updating

- **`GET /api/health/doctor`**: Verifies `control-plane` ↔ `workspaces` connectivity, auth, and protocol version handshake, reports warm standby & active session counts, FIFO build queue status, `/workspaces` disk usage (warns above 80%), and LLM/GitHub config.
- **Updating images:** Both services share `${HALLEY_TAG:-latest}`. Always pull and recreate both `control-plane` and `workspaces` together (`docker compose -f docker-compose.prod.yml pull && docker compose -f docker-compose.prod.yml up -d`). If only one image is updated across a protocol change, `/api/health/doctor` reports a clear version mismatch error.

See [`docs/prd-tdd.md`](docs/prd-tdd.md) for the full architecture PRD & Technical Design Document.