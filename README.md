# Halley

A hosted, chat-forward web editor for GitHub-hosted **Astro** websites. Non-technical editors sign in with Google, chat with a durable **Pi** coding agent (`@earendil-works/pi-durable`), edit static `.astro` text inline in a live `astro dev` preview (with a Notion-style floating bubble menu supporting **Bold**, **Italic**, and `url('/...')`-aware internal **Links**), and click **Publish to Live Site** to run checks, rebase, open a PR, and squash auto-merge once CI passes.

## Monorepo Packages

- [`packages/shared`](packages/shared): Shared Zod schemas, TypeScript DTOs, `postMessage` bridge contracts, and WebSocket events.
- [`packages/astro-dev-edit`](packages/astro-dev-edit): Dev-only Astro integration (`@astrojs/compiler` AST classifier, `url()`-aware serializer, Shadow DOM inline bubble menu, `/__editor/*` middleware).
- [`packages/workspace-runner`](packages/workspace-runner): Per-session Hono + `ws` runner managing `astro dev` (with `/p/:sessionId/*` base override), `@earendil-works/pi-durable` SQLite runtime, `sharp` image processing, Playwright `screenshot_page`, auto-checkpoints, and verification.
- [`packages/control-plane`](packages/control-plane): Gateway & orchestrator handling Google OAuth, email/domain allowlist, daily USD spend proxy for Anthropic, Docker/Local `WorkspaceDriver`, `/p/:sessionId/*` HTTP + Vite HMR WS proxy, and GitHub PR + auto-merge + Pages deploy polling.
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

Halley runs two container types:
- **`halley-control-plane`** (`docker/control-plane.Dockerfile`): Serves the web UI, Google OAuth, Anthropic spend-capped proxy, preview/HMR proxy, and GitHub PR/auto-merge orchestrator.
- **`halley-workspace`** (`docker/workspace.Dockerfile`): Ephemeral per-session container running `astro dev`, the durable Pi agent, `sharp`, and Playwright.

`docker-compose.yml` mounts `/var/run/docker.sock` into `control-plane` so it can spawn `WORKSPACE_IMAGE` containers on the `halley_halley-net` bridge network.

### 1. Configure `.env`

```bash
cp .env.example .env
```

Set at minimum:
- `HALLEY_PUBLIC_URL` (e.g. `https://edit.yourchurch.org` or `http://localhost:3000`)
- `SESSION_SECRET` (random 32+ char string)
- `GOOGLE_CLIENT_ID` & `GOOGLE_CLIENT_SECRET` (with redirect URI `${HALLEY_PUBLIC_URL}/api/auth/google/callback`)
- `HALLEY_ADMIN_EMAILS` & `HALLEY_ALLOWED_DOMAINS` (or `HALLEY_ALLOWED_EMAILS`)
- `ANTHROPIC_API_KEY` (default model: `haiku-latest` with `HALLEY_THINKING_LEVEL=high`)
- `HALLEY_REPO` (e.g. `owner/site-repo`) & `HALLEY_BASE_BRANCH` (`main`)
- GitHub auth: either `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY` + `GITHUB_APP_INSTALLATION_ID`, or `GITHUB_TOKEN`

### 2. Build Locally & Start

`docker compose up -d` builds `control-plane`, and `pnpm docker:build:workspace` builds the `halley-workspace:latest` image that `control-plane` spawns per session:

```bash
pnpm docker:build:workspace
docker compose up -d --build
```

*(Or build both images with `pnpm docker:build` before running `docker compose up -d`.)*

### 3. Or Use Prebuilt Docker Hub Images

If you use the automated [Docker Hub push workflow](.github/workflows/dockerhub-push.yml) (which pushes `<DOCKERHUB_USERNAME>/halley-control-plane:latest` and `<DOCKERHUB_USERNAME>/halley-workspace:latest` on merges to `main`):

1. Add `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` to your GitHub repository **Settings → Secrets and variables → Actions**.
2. In `.env`, set:
   ```bash
   WORKSPACE_IMAGE=<your-dockerhub-username>/halley-workspace:latest
   ```
3. Pull the workspace image and run `control-plane` using `<your-dockerhub-username>/halley-control-plane:latest`:
   ```bash
   docker pull <your-dockerhub-username>/halley-workspace:latest
   docker compose up -d
   ```

See [`docs/prd-tdd.md`](docs/prd-tdd.md) for the full architecture PRD & Technical Design Document.