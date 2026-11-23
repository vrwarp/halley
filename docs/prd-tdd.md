# Architecture PRD & Technical Design Doc: Chat-Forward Astro GitHub Web Editor

## 1. Executive Summary & Market Context

### Problem Statement
Non-technical or semi-technical site maintainers want to edit an Astro website hosted on GitHub (such as `vrwarp/thecrossing.website`) through natural-language conversation while still being able to click directly on rendered text to fine-tune copy. Existing tools solve only half of the problem:
- **Local dev-only visual editors** ([`astro-dev-edit`](https://github.com/janjcwebtech/astro-dev-edit), [`@opacedev/astro-visual-editor`](https://github.com/OpaceDigitalAgency/astro-visual-editor), [`@sudodevstudio/astro-ai`](https://github.com/SudoDevStudio/astro-ai/)) run only inside a local `astro dev` process and lack a hosted GitHub workspace or multi-turn web chat runtime.
- **Git-backed headless CMSs** ([CloudCannon](https://cloudcannon.com/), [TinaCMS](https://tina.io/), [`@plinto/astro`](https://github.com/maxmart/plinto)) require refactoring sites into rigid CMS schemas, MDX blocks, or component contracts—breaking down on sites that mix static `.astro` templates, TypeScript data modules (`src/data/site.ts`), frontmatter arrays, and JSON content collections (`src/content/sermons/*.json`).

### Solution
A **hosted, chat-agent-forward web editor** powered by the **Pi harness** (`@earendil-works/pi-coding-agent` / `@earendil-works/pi-durable`) paired with a **live `astro dev` preview** and **dev-mode `contenteditable` overlay**:
1. **Chat-Forward Primary Workflow:** Users describe changes in natural language (content updates, new pages, layout/Tailwind tweaks, sermon JSON additions, nav updates). Pi edits the cloned repository directly and `astro dev` hot-reloads the preview.
2. **Direct `contenteditable` Fine-Tuning:** Users toggle **Edit Mode** in the preview iframe to click static `.astro` text and edit inline. Edits patch exact source spans on disk via `data-astro-source-file` and `data-astro-source-loc`.
3. **Seamless Agentic Handoff:** When a user clicks an element backed by a frontmatter array, `src/data/site.ts`, or a JSON content collection (which AST span patching cannot safely rewrite), the overlay sends the element's source location, DOM path, and text to Pi as structured context so the user can edit it conversationally.
4. **GitHub-Native Publishing:** All edits happen on an isolated working branch, with live `git diff` review and one-click commit/push/PR creation.

---

## 2. Product Requirements Document (PRD)

### 2.1 Target Users & Core Flows
- **Site Maintainers / Editors:** Connect a GitHub repo, preview the live site, click-to-edit typos inline, or ask the chat agent to update schedules, add sermon series, or restyle sections—then open a Pull Request.
- **Developers:** Retain 100% ownership of standard Astro code (no proprietary CMS lock-in, zero editor runtime shipped in `astro build`).

### 2.2 Functional Requirements
| ID | Requirement | Priority |
|---|---|---|
| **FR-1** | **GitHub OAuth & Repo Connection:** Authenticate via GitHub App/OAuth, select repo + base branch, and create an isolated working branch (`editor/<session-id>`). | P0 |
| **FR-2** | **Hosted `astro dev` Preview:** Boot an isolated container running `astro dev`, proxy HTTP + Vite HMR WebSockets into a split-pane `<iframe>` (respecting `astro.config.mjs` `base` paths). | P0 |
| **FR-3** | **Pi Chat-Forward Agent:** Stream Pi responses, tool calls, and diffs in a chat sidebar; support interrupting (`steer`) and queuing (`followUp`) mid-run. | P0 |
| **FR-4** | **Inline `contenteditable` Mode:** Snapshot `data-astro-source-file` and `data-astro-source-loc` in dev mode; allow inline editing of static `.astro` text nodes with atomic disk writes and stale-span checks. | P0 |
| **FR-5** | **Click-to-Context Handoff:** Clicking any non-static/data-driven element (e.g., `ministries` loop item, `SITE.serviceTime`, `sermons/*.json`) attaches its source metadata + DOM snippet to the Pi chat prompt. | P1 |
| **FR-6** | **Verification Gates:** Run `astro check` (and optional repo scripts like `verify:seo`) before PR creation; surface errors to Pi for auto-repair. | P1 |
| **FR-7** | **Diff, Undo & GitHub PR:** Show `git diff` per file, allow reverting individual files or edits, and commit/push/open a GitHub PR. | P0 |

### 2.3 Non-Functional Requirements
- **Zero Production Footprint:** No editor scripts, `contenteditable` attributes, or source-location metadata in `npm run build` (`dist/`).
- **Process Isolation:** Every repo workspace runs inside its own sandboxed container/micro-VM; `astro dev` and Pi tools never share host credentials or other tenants' filesystems.
- **Resilience:** Agent runs and session transcripts survive browser refreshes and transient disconnects.

---

## 3. Technical Design Document (TDD)

### 3.1 System Architecture

```text
┌─────────────────────────────────────────────────────────────────────────┐
│ Web Editor UI (Browser)                                                 │
│  ┌──────────────────────────────┐  ┌─────────────────────────────────┐  │
│  │ Pi Chat Sidebar              │  │ Live Preview <iframe>           │  │
│  │ - Streaming messages/tools   │  │ - Proxied astro dev + Vite HMR  │  │
│  │ - Element context chips      │◄─┼─► Injected Dev-Edit Bridge      │  │
│  │ - Diff viewer & PR button    │  │   (Browse / Edit / Select mode) │  │
│  └──────────────┬───────────────┘  └────────────────┬────────────────┘  │
└─────────────────┼───────────────────────────────────┼───────────────────┘
                  │ WebSocket / SSE                   │ HTTP + WS (HMR)
┌─────────────────▼───────────────────────────────────▼───────────────────┐
│ Control Plane / Gateway (Auth, GitHub App, Proxy, Session Routing)      │
└─────────────────┬───────────────────────────────────┬───────────────────┘
                  │                                   │
┌─────────────────▼───────────────────────────────────▼───────────────────┐
│ Isolated Workspace Container (1 per active repo/session)                │
│                                                                         │
│  ┌─────────────────────────┐       ┌─────────────────────────────────┐  │
│  │ Pi Agent Runtime        │       │ Astro Dev Server (`astro dev`)  │  │
│  │ - pi-coding-agent (SDK  │       │ - Injected `dev-editor`         │  │
│  │   or RPC) / pi-durable  │       │   Astro integration (dev-only)  │  │
│  │ - Built-in file/bash    │       │ - Vite HMR WebSocket            │  │
│  │   tools + custom tools  │       │ - Patch API: POST /__edit       │  │
│  └────────────┬────────────┘       └────────────────┬────────────────┘  │
│               │          Shared File Lock           │                   │
│               └──────────────────┬──────────────────┘                   │
│                                  ▼                                      │
│                     /workspace (Cloned Git Repo)                        │
└─────────────────────────────────────────────────────────────────────────┘
```

### 3.2 Workspace Container & Astro `base` Path Proxying
- **Cold-start optimization:** Maintain base Node 22+ container images; cache `node_modules` by `package-lock.json` hash so `npm ci --ignore-scripts` completes in seconds.
- **`base` path handling:** Repos like `thecrossing.website` configure `base: '/thecrossing.website'` in `astro.config.mjs`. The Control Plane proxy must route `/preview/<workspaceId>/*` while forwarding the configured `base` prefix (or injecting a dev-only `base` override if needed, though preserving `base` ensures `url(...)` helpers behave identically to production).
- **Dev-only integration injection:** Instead of permanently modifying the user's `astro.config.mjs`, launch `astro dev` with a wrapper/loader or temporary `.astro` integration hook that registers the dev-edit integration only in memory/process, keeping `git status` clean.

### 3.3 `contenteditable` ↔ `.astro` Source Patching Engine
1. **Source Attribute Snapshotting:**
   - In `astro dev`, Astro emits `data-astro-source-file` and `data-astro-source-loc` (`line:col`) on elements before its dev toolbar strips them.
   - An injected client script (using the same MutationObserver/early-capture pattern as [`astro-dev-edit`](https://github.com/janjcwebtech/astro-dev-edit)) snapshots `{ file, loc }` onto a `WeakMap<Element, SourceLoc>` as nodes mount.
2. **Editability Classification:**
   - When the user clicks an element in **Edit Mode**, the client sends `{ file, loc, currentText, tagName }` to the container's dev middleware (`POST /__editor/inspect`).
   - The server parses the `.astro` file with `@astrojs/compiler` AST to verify whether `loc` points to a **static text node** (or safe inline markup like `<strong>`, `<em>`, `<a>`, `<br>`) vs. an **expression** (`{SITE.serviceTime}`, `{item.title}`).
   - **Static span:** Client sets `contentEditable = "true"` on the element. On blur/Cmd+S, client posts `{ file, loc, originalText, newText }` to `POST /__editor/patch`. The server acquires the per-file write lock, verifies the disk bytes at `loc` still match `originalText` (preventing stale/corrupted writes), escapes HTML entities, splices the new text into the `.astro` file, and lets Vite HMR update the DOM.
   - **Dynamic/Data-driven span:** Client highlights the element as "Agent-editable" and sends `{ file, loc, renderedText, route, outerHTML }` via `window.parent.postMessage` to the Pi Chat Sidebar, pre-filling an element context chip.

### 3.4 Pi Harness Integration
- **Runtime Choice:**
  - **Single-container / simple:** Use `@earendil-works/pi-coding-agent` via TypeScript **SDK** (`createAgentSession` / `AgentSessionRuntime`) inside a lightweight Node server in the workspace container, or **RPC mode** (`pi --mode rpc`) over JSONL.
  - **Production multi-tab / crash-resilient:** Use **`@earendil-works/pi-durable`** backed by SQLite (`openNodeSqliteStorage`) inside the workspace volume so browser refreshes or container restarts resume mid-turn without losing context.
- **Session & Context Assembly:**
  - Set `cwd` to `/workspace`. Pi automatically discovers the repo's `AGENTS.md` (e.g., `thecrossing.website` already has an `AGENTS.md` with project conventions!).
  - Inject a system-prompt section (or Pi skill) explaining the repo's Astro structure, `contenteditable` handoff format, and required verification commands (`npm run check`, `npm run verify:seo`).
  - When a user sends a chat message with an attached element chip, inject the `{ file, loc, route, renderedText }` metadata into the user message or via `transformContext` so Pi jumps straight to the right file (`src/data/site.ts`, `src/content/sermons/*.json`, etc.).
- **Concurrency Control (`beforeToolCall`):**
  - Register a Pi `beforeToolCall` hook (or extension) that acquires the same per-file lock used by `POST /__editor/patch` before `edit`/`write` executes, and notifies the preview iframe to temporarily pause `contenteditable` saves while Pi is actively writing.
- **Streaming & Queueing:**
  - Forward Pi's `message_update`, `tool_execution_start`/`end`, and `agent_settled` events over WebSocket to the chat UI.
  - If the user submits a correction while Pi is streaming, call `session.steer(...)`; for next-task requests, call `session.followUp(...)`.

### 3.5 Git & GitHub Workflow
1. **Branching:** On workspace boot, `git checkout -b pi-editor/<timestamp>-<shortid>`.
2. **Diff & Rollback:** Editor UI queries `git status --porcelain` and `git diff` after `agent_settled` or any `POST /__editor/patch`. Users can discard individual file changes via `git checkout -- <file>`.
3. **Pre-PR Verification:** Before enabling/completing "Create PR", run `npm run check` (`astro check`) and `npm run build` (or repo-specific checks like `verify:seo`). If errors occur, feed them back to Pi to fix.
4. **Publish:** Push branch via GitHub App installation token (kept in the Control Plane, never exposed to Pi's bash environment) and open a PR against `main`.

---

## 4. Phased Implementation Plan

1. **Phase 1 — Local Prototype (Pi + `astro-dev-edit` + `thecrossing.website`):**
   - Run `astro dev` with `astro-dev-edit` (or a minimal custom Vite/Astro dev-edit middleware) alongside Pi SDK/RPC in a local split-pane web app.
   - Wire `postMessage` element selection → Pi chat context + shared file lock.
2. **Phase 2 — Containerization & Proxy:**
   - Package the workspace runner into a Docker/micro-VM image with `base`-path-aware HTTP + Vite HMR WebSocket proxying.
3. **Phase 3 — GitHub App & Durable Sessions:**
   - Add GitHub OAuth/App repo cloning, branch/diff UI, `astro check` pre-PR gate, and migrate the agent loop to `@earendil-works/pi-durable` for crash/refresh resilience.
