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

Halley separates its runtime into two container images for security and resource efficiency:
- **`halley-control-plane`** (`docker/control-plane.Dockerfile`): Always-on gateway holding your API keys (`ANTHROPIC_API_KEY`, GitHub credentials, Google OAuth), SQLite state (`/data`), spend-capped LLM proxy, shared warm Playwright Chromium screenshot service (with 1-hour idle auto-close), and preview/HMR proxy.
- **`halley-workspace`** (`docker/workspace.Dockerfile`): Slim ephemeral per-session sandbox (Node 22 + `astro dev` + durable Pi agent + `sharp`, running as unprivileged `node`). Spawned on demand via `/var/run/docker.sock` and stopped automatically when idle.

`control-plane` automatically:
1. **Pulls `WORKSPACE_IMAGE`** from Docker Hub on the first session if it isn't cached locally yet.
2. **Detects its own user-defined Docker bridge network** (`halley-net`) so sibling `halley-ws-*` containers can resolve each other by name without manual `WORKSPACE_DOCKER_NETWORK` tuning.
3. **Syncs the git mirror via named Docker volumes** (zero host filesystem bind-mount path dependencies) and **self-heals** stale or outdated stopped session containers while preserving session volumes.

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
2. Start with [`docker-compose.prod.yml`](docker-compose.prod.yml):
   ```bash
   # Optional: expose on a custom host port such as 2243 (container port stays 3000)
   HOST_PORT=2243 docker compose -f docker-compose.prod.yml up -d
   ```
3. Verify preflight health checks at `http://<host>:<port>/api/health/doctor`.

### Option B: Synology NAS (Container Manager + Reverse Proxy)

1. Create `/volume1/docker/halley` and place [`docker-compose.prod.yml`](docker-compose.prod.yml) (renamed to `docker-compose.yml`) and `.env` inside it.
   - To expose Halley on a custom host port (e.g. `2243`), set `ports: ["2243:3000"]` (`HOST:CONTAINER`). Keep `CONTROL_PLANE_INTERNAL_URL=http://control-plane:3000` at `3000`.
   - Keep `DATA_DIR` unset (defaults to `/data` inside the container) and map `/volume1/docker/halley/data:/data`.
   - Leave **"Execute container using high privilege"** OFF and legacy **Links** empty; keep the user-defined `halley-net` bridge network (Docker's built-in default `bridge` disables container DNS).
2. In **Container Manager → Project → Create**, point to `/volume1/docker/halley` and start the project.
3. Configure HTTPS + WebSockets in **DSM → Control Panel → Login Portal → Advanced → Reverse Proxy → Create**:
   - **Source:** `HTTPS`, Hostname `halley.yourdomain.com`, Port `443`
   - **Destination:** `HTTP`, Hostname `localhost`, Port `2243` (or `3000`)
   - **Custom Header tab:** Click **Create → WebSocket** (adds `Upgrade` and `Connection` headers required for Pi streaming chat and Astro HMR).

### Option C: Build Images Locally from Source

```bash
cp .env.example .env
# When using a locally built workspace image, set WORKSPACE_IMAGE=halley-workspace:latest in .env
pnpm docker:build
docker compose up -d
```

### Preflight Diagnostics & Troubleshooting

- **`GET /api/health/doctor`**: Inspects `/var/run/docker.sock` connectivity, verifies `control-plane` is on a DNS-capable user-defined bridge network, checks whether `/data` is backed by a persistent mount, and reports whether `WORKSPACE_IMAGE` is cached locally.
- **Updating to a newer `WORKSPACE_IMAGE`:** Pull the updated image (`docker pull vrwarp/halley-workspace:latest`). Any stopped session containers on an older image ID are automatically recreated on next wake while keeping their `/halley-volume` git branch and Pi history intact.

See [`docs/prd-tdd.md`](docs/prd-tdd.md) for the full architecture PRD & Technical Design Document.