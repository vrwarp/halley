import { createServer } from 'node:http';
import path from 'node:path';
import { discoverSiteRoutes, PerFileMutex } from '@halley/astro-dev-edit';
import {
  ChatClientMessageSchema,
  type ChatServerMessage,
} from '@halley/shared';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { WebSocketServer, type WebSocket } from 'ws';
import { AstroDevManager } from './astro-manager.js';
import {
  createCheckpoint,
  getGitChanges,
  hasProtectedPathChanges,
  listCheckpoints,
  rebaseOnBase,
  revertSingleFile,
  undoToCheckpoint,
  type GitIdentity,
} from './checkpoints-and-git.js';
import { HalleyPiRuntime } from './pi-runtime.js';
import { UploadManager } from './uploads.js';
import { runAllVerificationChecks } from './verify.js';

const REPO_ROOT = process.env.HALLEY_WORKSPACE_DIR || '/workspace';
const STATE_DIR = process.env.HALLEY_STATE_DIR || '/halley-state';
const SESSION_ID = process.env.HALLEY_SESSION_ID || 'local';
const BASE_BRANCH = process.env.HALLEY_BASE_BRANCH || 'main';
const BASE_SHA = process.env.HALLEY_BASE_SHA || '';
const RUNNER_PORT = Number(process.env.RUNNER_PORT || 4100);
const ASTRO_PORT = Number(process.env.ASTRO_PORT || 4321);
const CONTROL_PLANE_INTERNAL_URL =
  process.env.CONTROL_PLANE_INTERNAL_URL || 'http://127.0.0.1:3000';
const WORKSPACE_TOKEN = process.env.WORKSPACE_TOKEN || 'dev-token';
const MODEL_ID = process.env.HALLEY_MODEL_ID || 'haiku-latest';
const THINKING_LEVEL = (process.env.HALLEY_THINKING_LEVEL || 'high') as
  | 'off'
  | 'low'
  | 'medium'
  | 'high';
let persona: 'non-technical' | 'developer' =
  process.env.HALLEY_PERSONA === 'developer' ? 'developer' : 'non-technical';

let readOnly = process.env.HALLEY_READ_ONLY === 'true';

const gitIdentity: GitIdentity = {
  botName: process.env.HALLEY_GIT_BOT_NAME || 'Halley Bot',
  botEmail: process.env.HALLEY_GIT_BOT_EMAIL || 'halley-bot@users.noreply.github.com',
  editorName: process.env.HALLEY_EDITOR_NAME || 'Halley Editor',
  editorEmail: process.env.HALLEY_EDITOR_EMAIL || 'editor@example.com',
};

const fileLock = new PerFileMutex();
const uploadManager = new UploadManager(path.join(STATE_DIR, 'uploads'));

const wsClients = new Set<WebSocket>();
let latestTranscript: Extract<ChatServerMessage, { type: 'transcript_state' }> | null = null;

function broadcast(msg: ChatServerMessage): void {
  const payload = JSON.stringify(msg);
  for (const ws of wsClients) {
    if (ws.readyState === ws.OPEN) {
      ws.send(payload);
    }
  }
}

let inlineEditTimer: NodeJS.Timeout | null = null;
function scheduleInlineCheckpoint(summary: string): void {
  if (inlineEditTimer) clearTimeout(inlineEditTimer);
  inlineEditTimer = setTimeout(async () => {
    try {
      const ckpt = await createCheckpoint(REPO_ROOT, summary, gitIdentity);
      if (ckpt) {
        const changes = await getGitChanges(REPO_ROOT, `origin/${BASE_BRANCH}`).catch(() => []);
        broadcast({
          type: 'checkpoint_created',
          checkpoint: ckpt,
          changedFilesCount: changes.length,
        });
      }
    } catch {
      // ignore background checkpoint error
    }
  }, 1500);
}

const astroManager = new AstroDevManager({
  repoRoot: REPO_ROOT,
  sessionId: SESSION_ID,
  astroPort: ASTRO_PORT,
  runnerPort: RUNNER_PORT,
  isReadOnly: () => readOnly,
  onPatched: ({ file }) => {
    scheduleInlineCheckpoint(`Inline edit in ${file}`);
  },
});

let piRuntime: HalleyPiRuntime | null = null;

async function main() {
  const { originalBase, previewBase } = await astroManager.start();

  piRuntime = new HalleyPiRuntime({
    repoRoot: REPO_ROOT,
    stateDir: STATE_DIR,
    sessionId: SESSION_ID,
    previewBase,
    astroPort: ASTRO_PORT,
    controlPlaneInternalUrl: CONTROL_PLANE_INTERNAL_URL,
    workspaceToken: WORKSPACE_TOKEN,
    modelId: MODEL_ID,
    thinkingLevel: THINKING_LEVEL,
    getPersona: () => persona,
    fileLock,
    uploadManager,
    onLockChange: (locked, file) => {
      broadcast({ type: 'workspace_lock', locked, file });
    },
    onRunFinishedWithEdits: async (summary) => {
      const ckpt = await createCheckpoint(REPO_ROOT, summary, gitIdentity);
      if (ckpt) {
        const changes = await getGitChanges(REPO_ROOT, `origin/${BASE_BRANCH}`).catch(() => []);
        broadcast({
          type: 'checkpoint_created',
          checkpoint: ckpt,
          changedFilesCount: changes.length,
        });
      }
    },
    onTranscriptUpdate: (snapshot) => {
      latestTranscript = {
        type: 'transcript_state',
        ...snapshot,
      };
      broadcast(latestTranscript);
    },
  });

  await piRuntime.start();

  const app = new Hono();

  app.get('/health', (c) => {
    const astro = astroManager.getStatus();
    return c.json({
      ok: true,
      sessionId: SESSION_ID,
      astroReady: astro.ready,
      astroPort: astro.port,
      originalBase,
      previewBase,
      readOnly,
    });
  });

  app.post('/internal/read-only', async (c) => {
    const body = (await c.req.json()) as { readOnly: boolean };
    readOnly = Boolean(body.readOnly);
    return c.json({ ok: true, readOnly });
  });

  app.post('/internal/persona', async (c) => {
    const body = (await c.req.json()) as { persona?: string };
    persona = body.persona === 'developer' ? 'developer' : 'non-technical';
    return c.json({ ok: true, persona });
  });

  app.get('/internal/routes', async (c) => {
    const routes = await discoverSiteRoutes(REPO_ROOT);
    return c.json({ routes });
  });

  app.post('/internal/git/notify-patched', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { file?: string };
    scheduleInlineCheckpoint(`Inline edit in ${body.file || 'page'}`);
    return c.json({ ok: true });
  });

  app.get('/internal/git/changes', async (c) => {
    const baseRef = c.req.query('baseRef') || `origin/${BASE_BRANCH}`;
    const changes = await getGitChanges(REPO_ROOT, baseRef);
    const checkpoints = await listCheckpoints(REPO_ROOT, BASE_SHA);
    return c.json({ changes, checkpoints });
  });

  app.post('/internal/git/revert-file', async (c) => {
    if (readOnly) return c.json({ error: 'Read-only' }, 403);
    const body = (await c.req.json()) as { path: string; baseRef?: string };
    await revertSingleFile(REPO_ROOT, body.path, body.baseRef || `origin/${BASE_BRANCH}`, gitIdentity);
    return c.json({ ok: true });
  });

  app.post('/internal/git/undo', async (c) => {
    if (readOnly) return c.json({ error: 'Read-only' }, 403);
    const body = (await c.req.json()) as { targetSha: string };
    const ckpt = await undoToCheckpoint(REPO_ROOT, body.targetSha, gitIdentity);
    const changes = await getGitChanges(REPO_ROOT, `origin/${BASE_BRANCH}`).catch(() => []);
    if (ckpt) {
      broadcast({ type: 'checkpoint_created', checkpoint: ckpt, changedFilesCount: changes.length });
    }
    return c.json({ ok: true, checkpoint: ckpt, changedFilesCount: changes.length });
  });

  app.post('/internal/git/checkpoint', async (c) => {
    if (readOnly) return c.json({ error: 'Read-only' }, 403);
    const body = (await c.req.json().catch(() => ({}))) as { summary?: string };
    const ckpt = await createCheckpoint(REPO_ROOT, body.summary || 'Manual checkpoint', gitIdentity);
    return c.json({ ok: true, checkpoint: ckpt });
  });

  app.get('/internal/git/protected-diff', async (c) => {
    const baseRef = c.req.query('baseRef') || `origin/${BASE_BRANCH}`;
    const protectedFiles = await hasProtectedPathChanges(REPO_ROOT, baseRef);
    return c.json({ clean: protectedFiles.length === 0, protectedFiles });
  });

  app.post('/internal/git/rebase', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      baseBranch?: string;
      gitAskPassToken?: string;
    };
    const outcome = await rebaseOnBase(REPO_ROOT, {
      baseBranch: body.baseBranch || BASE_BRANCH,
      identity: gitIdentity,
      onResolveConflict: async (conflictedFiles) => {
        if (!piRuntime) return false;
        return piRuntime.submitConflictResolutionPrompt(conflictedFiles);
      },
    });
    return c.json(outcome);
  });

  app.post('/internal/verify', async (c) => {
    const result = await runAllVerificationChecks(REPO_ROOT);
    return c.json(result);
  });

  app.post('/internal/uploads', async (c) => {
    if (readOnly) return c.json({ error: 'Read-only' }, 403);
    const form = await c.req.formData();
    const file = form.get('file');
    if (!file || typeof file === 'string') {
      return c.json({ error: 'Missing file' }, 400);
    }
    const buf = Buffer.from(await file.arrayBuffer());
    const staged = await uploadManager.stageImage(file.name, file.type || 'image/png', buf);
    return c.json({ attachment: staged });
  });

  app.post('/internal/prompt', async (c) => {
    if (readOnly) return c.json({ error: 'Read-only' }, 403);
    const body = ChatClientMessageSchema.parse(await c.req.json());
    if (body.type === 'submit_input') {
      await piRuntime?.submitUserInput(body);
    } else if (body.type === 'abort') {
      await piRuntime?.abort();
    } else if (body.type === 'continue_run') {
      await piRuntime?.continueRun();
    }
    return c.json({ ok: true });
  });

  app.get('/internal/transcript', (c) => {
    return c.json(
      latestTranscript ?? {
        type: 'transcript_state',
        entries: [],
        live: { busy: false, streamingText: '', activeTools: [], queuedCount: 0 },
        usageUsd: 0,
      },
    );
  });

  const server = serve({
    fetch: app.fetch,
    port: RUNNER_PORT,
    hostname: '0.0.0.0',
    createServer,
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if ((req.url ?? '').startsWith('/ws')) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    } else {
      socket.destroy();
    }
  });

  wss.on('connection', (ws) => {
    wsClients.add(ws);
    if (latestTranscript) {
      ws.send(JSON.stringify(latestTranscript));
    }
    ws.on('message', async (raw) => {
      if (readOnly) {
        ws.send(JSON.stringify({ type: 'error', message: 'Session is read-only' }));
        return;
      }
      try {
        const parsed = ChatClientMessageSchema.parse(JSON.parse(raw.toString('utf8')));
        if (parsed.type === 'submit_input') {
          await piRuntime?.submitUserInput(parsed);
        } else if (parsed.type === 'abort') {
          await piRuntime?.abort();
        } else if (parsed.type === 'continue_run') {
          await piRuntime?.continueRun();
        }
      } catch (err) {
        ws.send(
          JSON.stringify({
            type: 'error',
            message: err instanceof Error ? err.message : 'Invalid command',
          }),
        );
      }
    });
    ws.on('close', () => wsClients.delete(ws));
  });

  const shutdown = async () => {
    await piRuntime?.stop();
    await astroManager.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log(
    `[halley-workspace-runner] session=${SESSION_ID} runner=:${RUNNER_PORT} astro=:${ASTRO_PORT}${previewBase}`,
  );
}

main().catch((err) => {
  console.error('[halley-workspace-runner] Fatal error:', err);
  process.exit(1);
});
