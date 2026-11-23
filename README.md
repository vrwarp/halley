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
```

## Docker Compose Deployment

```bash
pnpm docker:build
docker compose up -d
```

See [`docs/prd-tdd.md`](docs/prd-tdd.md) for the full architecture PRD & Technical Design Document.