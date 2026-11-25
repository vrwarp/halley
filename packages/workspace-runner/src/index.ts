import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';
import { discoverSiteRoutes, PerFileMutex } from '@halley/astro-dev-edit';
import {
  ChatClientMessageSchema,
  type ChatServerMessage,
  type ConflictResolutionRecordDto,
  type MergeReviewStateDto,
} from '@halley/shared';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { WebSocketServer, type WebSocket } from 'ws';
import { AstroDevManager, detectAstroSiteUrl } from './astro-manager.js';
import {
  createCheckpoint,
  ensureGitRerere,
  getGitChanges,
  hasProtectedPathChanges,
  listCheckpoints,
  mergeWithBase,
  resetToRef,
  revertSingleFile,
  startRevertCommits,
  undoToCheckpoint,
  type GitIdentity,
} from './checkpoints-and-git.js';
import {
  applyResolvedFile,
  buildConflictEvidencePack,
  estimateEscalationCost,
  getUpstreamCommits,
  resolvePackWithLlm,
  tryDeterministicResolve,
  type ConflictEvidencePack,
} from './conflict-protocol.js';
import { PageCreationService, PageValidationError } from './pages.js';
import { detachHardlinkedNodeModules } from './nm-cache.js';
import { HalleyPiRuntime } from './pi-runtime.js';
import { UploadManager } from './uploads.js';
import { runAllVerificationChecks } from './verify.js';
import { buildChangeCards } from './visual-diff.js';

const execFileAsync = promisify(execFile);

const REPO_ROOT = process.env.HALLEY_WORKSPACE_DIR || '/workspace';
const STATE_DIR = process.env.HALLEY_STATE_DIR || '/halley-state';
const SESSION_ID = process.env.HALLEY_SESSION_ID || 'local';
const BASE_BRANCH = process.env.HALLEY_BASE_BRANCH || 'main';
let baseSha = process.env.HALLEY_BASE_SHA || '';
const RUNNER_PORT = Number(process.env.RUNNER_PORT || 4100);
const ASTRO_PORT = Number(process.env.ASTRO_PORT || 4321);
const CONTROL_PLANE_INTERNAL_URL =
  process.env.CONTROL_PLANE_INTERNAL_URL || 'http://127.0.0.1:3000';
const SUPERVISOR_URL = process.env.HALLEY_SUPERVISOR_URL || '';
const WORKSPACE_HOST_SECRET = process.env.WORKSPACE_HOST_SECRET || '';
const WORKSPACE_TOKEN = process.env.WORKSPACE_TOKEN || 'dev-token';
// Scrub WORKSPACE_TOKEN and WORKSPACE_HOST_SECRET from process.env immediately so child processes
// (astro dev SSR code, agent bash commands, verification scripts) never inherit them.
delete process.env.WORKSPACE_TOKEN;
delete process.env.WORKSPACE_HOST_SECRET;
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

const SESSION_META_PATH = path.join(STATE_DIR, 'session-meta.json');

interface PersistedSessionMeta {
  editorName?: string;
  editorEmail?: string;
  persona?: 'non-technical' | 'developer';
  baseSha?: string;
  readOnly?: boolean;
}

async function loadPersistedSessionMeta(): Promise<void> {
  try {
    const raw = await fs.readFile(SESSION_META_PATH, 'utf8');
    const meta = JSON.parse(raw) as PersistedSessionMeta;
    if (meta.editorName) gitIdentity.editorName = meta.editorName;
    if (meta.editorEmail) gitIdentity.editorEmail = meta.editorEmail;
    if (meta.persona === 'developer' || meta.persona === 'non-technical') {
      persona = meta.persona;
    }
    if (meta.baseSha) baseSha = meta.baseSha;
    if (typeof meta.readOnly === 'boolean') readOnly = meta.readOnly;
  } catch {
    // no persisted meta yet
  }
}

async function savePersistedSessionMeta(): Promise<void> {
  await fs.mkdir(STATE_DIR, { recursive: true });
  const meta: PersistedSessionMeta = {
    editorName: gitIdentity.editorName,
    editorEmail: gitIdentity.editorEmail,
    persona,
    baseSha,
    readOnly,
  };
  await fs.writeFile(SESSION_META_PATH, JSON.stringify(meta, null, 2), 'utf8');
}

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
  stateDir: STATE_DIR,
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
  await loadPersistedSessionMeta();
  console.log('[halley-boot] starting_preview');
  const { originalBase, previewBase } = await astroManager.start();

  const pageService = new PageCreationService({
    repoRoot: REPO_ROOT,
    stateDir: STATE_DIR,
    baseBranch: BASE_BRANCH,
    gitIdentity,
    fileLock,
    getAstroPort: () => ASTRO_PORT,
    getPreviewBase: () => previewBase,
    onBroadcast: (msg) => broadcast(msg),
  });
  await pageService.load();

  console.log('[halley-boot] starting_ai');
  piRuntime = new HalleyPiRuntime({
    repoRoot: REPO_ROOT,
    stateDir: STATE_DIR,
    sessionId: SESSION_ID,
    previewBase,
    astroPort: ASTRO_PORT,
    controlPlaneInternalUrl: CONTROL_PLANE_INTERNAL_URL,
    workspaceToken: WORKSPACE_TOKEN,
    supervisorUrl: SUPERVISOR_URL || undefined,
    hostSecret: WORKSPACE_HOST_SECRET || undefined,
    modelId: MODEL_ID,
    thinkingLevel: THINKING_LEVEL,
    getPersona: () => persona,
    fileLock,
    uploadManager,
    pageService,
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
      astroState: astro.state,
      astroCrashCount: astro.crashCount,
      astroLastExitCode: astro.lastExitCode,
      astroPort: astro.port,
      piBusy: piRuntime?.isBusy() ?? false,
      originalBase,
      previewBase,
      readOnly,
      baseSha,
    });
  });

  app.post('/internal/astro/restart', async (c) => {
    await astroManager.restart();
    const astro = astroManager.getStatus();
    return c.json({
      ok: true,
      astroReady: astro.ready,
      astroState: astro.state,
    });
  });

  /**
   * Binds a pre-warmed standby workspace container to a real user session.
   * Updates git branch (optionally fast-forwarding from the local bare mirror if baseBranch moved),
   * sets editor identity/persona, and persists session-meta.json for future sleep/wake cycles.
   */
  app.post('/internal/claim', async (c) => {
    const body = (await c.req.json()) as {
      workingBranch: string;
      baseBranch?: string;
      editorName?: string;
      editorEmail?: string;
      persona?: 'non-technical' | 'developer';
      readOnly?: boolean;
      syncFromMirror?: boolean;
      mirrorPath?: string;
    };

    const targetBaseBranch = body.baseBranch || BASE_BRANCH;
    const mirrorPath = body.mirrorPath || process.env.HALLEY_MIRROR_PATH || '/halley-mirror/repo.git';

    if (body.syncFromMirror) {
      const hasMirror = await fs
        .access(path.join(mirrorPath, 'HEAD'))
        .then(() => true)
        .catch(() => false);
      if (hasMirror) {
        const oldHead = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT }))
          .stdout.trim();
        await execFileAsync(
          'git',
          ['fetch', mirrorPath, `+refs/heads/${targetBaseBranch}:refs/remotes/origin/${targetBaseBranch}`],
          { cwd: REPO_ROOT, maxBuffer: 16 * 1024 * 1024 },
        );
        const lockDiff = await execFileAsync(
          'git',
          ['diff', '--name-only', oldHead, `origin/${targetBaseBranch}`, '--', 'package-lock.json', 'pnpm-lock.yaml'],
          { cwd: REPO_ROOT },
        ).catch(() => ({ stdout: '' }));

        await execFileAsync(
          'git',
          ['checkout', '-B', body.workingBranch, `origin/${targetBaseBranch}`],
          { cwd: REPO_ROOT },
        );

        const changedLocks = lockDiff.stdout.trim();
        if (changedLocks) {
          await detachHardlinkedNodeModules(REPO_ROOT, STATE_DIR).catch(() => {});
          const pkgCache = process.env.HALLEY_PKG_CACHE_DIR || '/workspaces/pkg-cache';
          if (changedLocks.includes('package-lock.json')) {
            await execFileAsync(
              'npm',
              ['ci', '--cache', path.join(pkgCache, 'npm'), '--prefer-offline', '--ignore-scripts'],
              { cwd: REPO_ROOT, maxBuffer: 16 * 1024 * 1024 },
            );
          } else if (changedLocks.includes('pnpm-lock.yaml')) {
            await execFileAsync(
              'pnpm',
              ['install', '--store-dir', path.join(pkgCache, 'pnpm'), '--frozen-lockfile'],
              { cwd: REPO_ROOT, maxBuffer: 16 * 1024 * 1024 },
            );
          }
        }
      } else {
        await execFileAsync('git', ['checkout', '-B', body.workingBranch], { cwd: REPO_ROOT });
      }
    } else {
      await execFileAsync('git', ['checkout', '-B', body.workingBranch], { cwd: REPO_ROOT });
    }

    await ensureGitRerere(REPO_ROOT).catch(() => {});
    baseSha = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT })).stdout.trim();
    if (body.editorName) gitIdentity.editorName = body.editorName;
    if (body.editorEmail) gitIdentity.editorEmail = body.editorEmail;
    if (body.persona === 'developer' || body.persona === 'non-technical') {
      persona = body.persona;
    }
    if (typeof body.readOnly === 'boolean') {
      readOnly = body.readOnly;
    }
    await savePersistedSessionMeta();

    return c.json({ ok: true, baseSha, originalBase, previewBase });
  });

  app.post('/internal/read-only', async (c) => {
    const body = (await c.req.json()) as { readOnly: boolean };
    readOnly = Boolean(body.readOnly);
    await savePersistedSessionMeta().catch(() => {});
    return c.json({ ok: true, readOnly });
  });

  app.post('/internal/persona', async (c) => {
    const body = (await c.req.json()) as { persona?: string };
    persona = body.persona === 'developer' ? 'developer' : 'non-technical';
    await savePersistedSessionMeta().catch(() => {});
    return c.json({ ok: true, persona });
  });

  app.get('/internal/routes', async (c) => {
    const routes = await discoverSiteRoutes(REPO_ROOT);
    return c.json({ routes });
  });

  app.get('/internal/page-options', async (c) => {
    const capped = c.req.query('capped') === 'true';
    const options = await pageService.getPageCreationOptions(capped);
    return c.json(options);
  });

  app.post('/internal/pages', async (c) => {
    if (readOnly) return c.json({ error: 'Read-only' }, 403);
    try {
      const body = (await c.req.json()) as Record<string, unknown>;
      const capped = Boolean(body.capped);
      const isBusy = piRuntime?.isBusy() ?? false;
      const result = await pageService.createPage(body, { capped, isBusy });

      if (!capped && piRuntime) {
        const reqViewport = (body.editorContext as { viewport?: 'desktop' | 'tablet' | 'mobile' } | undefined)
          ?.viewport;
        await piRuntime.submitPageCreationRequest(
          result.pageRequest,
          result.instructions,
          isBusy ? 'followUp' : undefined,
          reqViewport,
        );
      }

      return c.json(
        {
          ok: true,
          route: result.route,
          file: result.file,
          pageRequest: result.pageRequest,
          checkpoint: result.checkpoint,
          changedFilesCount: result.changedFilesCount,
        },
        201,
      );
    } catch (err) {
      if (err instanceof PageValidationError) {
        return c.json(
          { error: err.message, collisionRoute: err.collisionRoute },
          err.statusCode,
        );
      }
      return c.json(
        { error: err instanceof Error ? err.message : 'Failed to create page' },
        400,
      );
    }
  });

  app.post('/internal/pages/:pageRequestId/retry', async (c) => {
    if (readOnly) return c.json({ error: 'Read-only' }, 403);
    const id = c.req.param('pageRequestId')!;
    const body = (await c.req.json().catch(() => ({}))) as {
      capped?: boolean;
      viewport?: 'desktop' | 'tablet' | 'mobile';
    };
    const existing = pageService.getPageRequest(id);
    if (!existing) return c.json({ error: 'Page request not found' }, 404);
    if (body.capped) {
      const updated = await pageService.updateStatus(id, 'capped');
      return c.json({ ok: true, pageRequest: updated });
    }
    const isBusy = piRuntime?.isBusy() ?? false;
    const updated = await pageService.updateStatus(id, isBusy ? 'queued' : 'writing');
    if (piRuntime && updated && existing.instructions) {
      await piRuntime.submitPageCreationRequest(
        updated,
        existing.instructions,
        isBusy ? 'followUp' : undefined,
        body.viewport,
      );
    }
    return c.json({ ok: true, pageRequest: updated });
  });

  app.delete('/internal/pages', async (c) => {
    if (readOnly) return c.json({ error: 'Read-only' }, 403);
    const route = c.req.query('route') || ((await c.req.json().catch(() => ({}))) as { route?: string }).route;
    if (!route) return c.json({ error: 'Missing route' }, 400);
    try {
      const res = await pageService.deletePage(route);
      return c.json(res);
    } catch (err) {
      if (err instanceof PageValidationError) {
        return c.json({ error: err.message }, err.statusCode);
      }
      return c.json({ error: err instanceof Error ? err.message : 'Failed to delete page' }, 400);
    }
  });

  app.post('/internal/pages/visibility', async (c) => {
    if (readOnly) return c.json({ error: 'Read-only' }, 403);
    const body = (await c.req.json()) as {
      route: string;
      unlisted: boolean;
      capped?: boolean;
      viewport?: 'desktop' | 'tablet' | 'mobile';
    };
    try {
      const res = await pageService.setPageVisibility(body.route, Boolean(body.unlisted));
      if (res.followUpPrompt && !body.capped && piRuntime) {
        await piRuntime.submitUserInput({
          requestId: `visibility-${Date.now()}`,
          text: res.followUpPrompt,
          editorContext: { currentRoute: res.route, viewport: body.viewport, mode: 'browse' },
          whenBusy: piRuntime.isBusy() ? 'followUp' : undefined,
        });
      }
      return c.json({
        ok: true,
        route: res.route,
        unlisted: res.unlisted,
        file: res.file,
        checkpoint: res.checkpoint,
        changedFilesCount: res.changedFilesCount,
      });
    } catch (err) {
      if (err instanceof PageValidationError) {
        return c.json({ error: err.message }, err.statusCode);
      }
      return c.json(
        { error: err instanceof Error ? err.message : 'Failed to update page visibility' },
        400,
      );
    }
  });

  app.post('/internal/pages/rename', async (c) => {
    if (readOnly) return c.json({ error: 'Read-only' }, 403);
    const body = (await c.req.json()) as {
      fromRoute: string;
      toSection: string;
      toSlug: string;
    };
    try {
      const res = await pageService.renamePage(body);
      return c.json(res);
    } catch (err) {
      if (err instanceof PageValidationError) {
        return c.json(
          { error: err.message, collisionRoute: err.collisionRoute },
          err.statusCode,
        );
      }
      return c.json(
        { error: err instanceof Error ? err.message : 'Failed to change page URL' },
        400,
      );
    }
  });

  app.post('/internal/git/notify-patched', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { file?: string };
    scheduleInlineCheckpoint(`Inline edit in ${body.file || 'page'}`);
    return c.json({ ok: true });
  });

  app.get('/internal/git/changes', async (c) => {
    const baseRef = c.req.query('baseRef') || `origin/${BASE_BRANCH}`;
    const changes = await getGitChanges(REPO_ROOT, baseRef);
    const checkpoints = await listCheckpoints(REPO_ROOT, baseSha);
    return c.json({ changes, checkpoints, baseSha });
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

  const handleMergeWithBase = async (c: import('hono').Context) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      baseBranch?: string;
      skipFetch?: boolean;
    };
    await ensureGitRerere(REPO_ROOT);
    const outcome = await mergeWithBase(REPO_ROOT, {
      baseBranch: body.baseBranch || BASE_BRANCH,
      identity: gitIdentity,
      skipFetch: body.skipFetch,
      onResolveConflict: async (conflictedFiles) => {
        if (!piRuntime) return false;
        return piRuntime.submitConflictResolutionPrompt(conflictedFiles);
      },
    });
    if ((outcome.status === 'clean' || outcome.status === 'resolved') && outcome.newBaseSha) {
      baseSha = outcome.newBaseSha;
      await savePersistedSessionMeta().catch(() => {});
    }
    return c.json(outcome);
  };

  app.post('/internal/git/rebase', handleMergeWithBase);
  app.post('/internal/git/sync', handleMergeWithBase);

  // Track active conflict/merge review state in memory for Sync, Publish, Revert & Escalation
  let activeMergeState: MergeReviewStateDto | null = null;
  let activeConflictPacks = new Map<string, ConflictEvidencePack>();
  let prevBaseSha = '';

  const runPostSyncTasks = async (upstreamSummary: string, newSha: string, prevSha: string) => {
    prevBaseSha = prevSha;
    baseSha = newSha;
    await savePersistedSessionMeta().catch(() => {});
    await piRuntime?.reloadAgentsMd().catch(() => {});
    if (upstreamSummary) {
      piRuntime?.addSystemContextNote(`Live site updates merged into this draft: ${upstreamSummary}`);
    }
    // Check if dependencies or astro config changed in prevSha..newSha
    if (prevSha && newSha && prevSha !== newSha) {
      const diffFiles = await execFileAsync('git', ['diff', '--name-only', `${prevSha}..${newSha}`], {
        cwd: REPO_ROOT,
      })
        .then((r) => r.stdout.split(/\r?\n/).filter(Boolean))
        .catch(() => [] as string[]);
      const needsRestart = diffFiles.some(
        (f) =>
          f === 'package.json' ||
          f === 'package-lock.json' ||
          f === 'pnpm-lock.yaml' ||
          f.startsWith('astro.config.'),
      );
      if (needsRestart) {
        await astroManager.stop().catch(() => {});
        await astroManager.start().catch(() => {});
      }
    }
  };

  app.post('/internal/context-note', async (c) => {
    const body = (await c.req.json()) as { note?: string; persist?: boolean };
    if (body.note?.trim()) {
      piRuntime?.addSystemContextNote(body.note.trim());
      if (body.persist) {
        await fs.mkdir(STATE_DIR, { recursive: true });
        await fs.writeFile(path.join(STATE_DIR, 'handoff-context.txt'), body.note.trim(), 'utf8');
      }
    }
    return c.json({ ok: true });
  });

  app.post('/internal/sync/start', async (c) => {
    if (readOnly) return c.json({ error: 'Read-only' }, 403);
    if (piRuntime?.isBusy()) {
      return c.json({ error: 'Pi is currently editing; try again once it finishes.' }, 409);
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      baseBranch?: string;
      kind?: 'sync' | 'publish' | 'revert';
      autoSyncOnly?: boolean;
      skipFetch?: boolean;
    };
    const baseBranch = body.baseBranch || BASE_BRANCH;
    const kind = body.kind ?? 'sync';

    await ensureGitRerere(REPO_ROOT);
    // Snapshot uncommitted edits into a checkpoint before merging
    await createCheckpoint(REPO_ROOT, 'Before live-site update', gitIdentity).catch(() => null);

    if (!body.skipFetch) {
      await execFileAsync('git', ['fetch', 'origin', baseBranch], { cwd: REPO_ROOT }).catch(() => {});
    }

    const baseRef = `origin/${baseBranch}`;
    const preSyncSha = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT })).stdout.trim();
    const newBaseSha = (await execFileAsync('git', ['rev-parse', baseRef], { cwd: REPO_ROOT })).stdout.trim();
    const mergeBaseSha = await execFileAsync('git', ['merge-base', 'HEAD', baseRef], { cwd: REPO_ROOT })
      .then((r) => r.stdout.trim())
      .catch(() => baseSha);

    if (mergeBaseSha === newBaseSha) {
      const review: MergeReviewStateDto = {
        mergeId: crypto.randomUUID(),
        kind,
        status: 'clean',
        preSyncSha,
        prevBaseSha: mergeBaseSha,
        newBaseSha,
        alreadyUpToDate: true,
        summary: 'Your draft is already up to date with the live site.',
        records: [],
        upstreamCommits: [],
        touchedUserFiles: [],
      };
      activeMergeState = review;
      return c.json({ review });
    }

    const upstreamCommits = await getUpstreamCommits(REPO_ROOT, mergeBaseSha, baseRef);
    const userChanged = (await getGitChanges(REPO_ROOT, mergeBaseSha)).map((ch) => ch.path);
    const upstreamChanged = await execFileAsync('git', ['diff', '--name-only', `${mergeBaseSha}..${baseRef}`], {
      cwd: REPO_ROOT,
    })
      .then((r) => r.stdout.split(/\r?\n/).filter(Boolean))
      .catch(() => [] as string[]);
    const overlap = userChanged.filter((f) => upstreamChanged.includes(f));

    // Attempt standard git merge
    let mergeClean = false;
    try {
      await execFileAsync(
        'git',
        [
          '-c',
          `user.name=${gitIdentity.botName}`,
          '-c',
          `user.email=${gitIdentity.botEmail}`,
          'merge',
          '--no-ff',
          '-m',
          `halley-sync: Updated from live site (${newBaseSha.slice(0, 7)})`,
          baseRef,
        ],
        { cwd: REPO_ROOT },
      );
      mergeClean = true;
    } catch {
      mergeClean = false;
    }

    if (mergeClean) {
      const summary =
        overlap.length > 0
          ? `Merged ${upstreamCommits.length} live update${upstreamCommits.length === 1 ? '' : 's'} into ${overlap.length} file${overlap.length === 1 ? '' : 's'} you edited — please review.`
          : `Updated with ${upstreamCommits.length} change${upstreamCommits.length === 1 ? '' : 's'} from the live site.`;
      await runPostSyncTasks(
        upstreamCommits.slice(0, 5).map((u) => u.subject).join('; '),
        newBaseSha,
        mergeBaseSha,
      );
      const review: MergeReviewStateDto = {
        mergeId: crypto.randomUUID(),
        kind,
        status: overlap.length > 0 ? 'ready_for_review' : 'applied',
        preSyncSha,
        prevBaseSha: mergeBaseSha,
        newBaseSha,
        summary,
        records: [],
        upstreamCommits,
        touchedUserFiles: overlap,
      };
      activeMergeState = review;
      return c.json({ review });
    }

    // Conflicts occurred: collect unmerged files and build evidence packs
    const unmergedOut = await execFileAsync('git', ['diff', '--name-only', '--diff-filter=U'], {
      cwd: REPO_ROOT,
    })
      .then((r) => r.stdout.trim().split(/\r?\n/).filter(Boolean))
      .catch(() => [] as string[]);

    activeConflictPacks = new Map();
    const records: ConflictResolutionRecordDto[] = [];
    let firstPassUsageUsd = 0;
    let needsAi = false;

    for (const relPath of unmergedOut) {
      const pack = await buildConflictEvidencePack(REPO_ROOT, relPath, mergeBaseSha, baseBranch);
      activeConflictPacks.set(relPath, pack);

      const det = tryDeterministicResolve(pack);
      if (det) {
        records.push(det);
      } else if (body.autoSyncOnly) {
        // Auto-sync NEVER spends AI budget without the user clicking (Q8)
        needsAi = true;
      } else {
        const res = await resolvePackWithLlm(REPO_ROOT, pack, {
          controlPlaneInternalUrl: CONTROL_PLANE_INTERNAL_URL,
          workspaceToken: WORKSPACE_TOKEN,
          modelId: piRuntime?.getResolvedModelId() || MODEL_ID,
          thinkingLevel: THINKING_LEVEL,
          purpose: 'conflict',
        });
        firstPassUsageUsd += res.usageUsd;
        records.push(res.record);
      }
    }

    if (body.autoSyncOnly && (needsAi || records.some((r) => r.status === 'needs_choice'))) {
      await execFileAsync('git', ['merge', '--abort'], { cwd: REPO_ROOT }).catch(() => {});
      return c.json({
        heldForUser: true,
        overlapCount: unmergedOut.length,
        upstreamCommits,
      });
    }

    const needsChoices = records.some((r) => r.status === 'needs_choice');
    if (!needsChoices) {
      // Apply all auto-resolved files and commit the merge
      let allApplied = true;
      for (const rec of records) {
        const applied = await applyResolvedFile(REPO_ROOT, rec.path, rec.resolvedContent ?? '');
        if (!applied.ok) allApplied = false;
      }
      if (allApplied) {
        await execFileAsync(
          'git',
          [
            '-c',
            `user.name=${gitIdentity.botName}`,
            '-c',
            `user.email=${gitIdentity.botEmail}`,
            'commit',
            '--no-edit',
          ],
          { cwd: REPO_ROOT, env: { ...process.env, GIT_EDITOR: 'true' } },
        );
        await runPostSyncTasks(
          upstreamCommits.slice(0, 5).map((u) => u.subject).join('; '),
          newBaseSha,
          mergeBaseSha,
        );
        const review: MergeReviewStateDto = {
          mergeId: crypto.randomUUID(),
          kind,
          status: 'ready_for_review',
          preSyncSha,
          prevBaseSha: mergeBaseSha,
          newBaseSha,
          summary: `Combined ${records.length} overlapping change${records.length === 1 ? '' : 's'} automatically — please review.`,
          records,
          upstreamCommits,
          touchedUserFiles: unmergedOut,
          firstPassUsageUsd,
        };
        activeMergeState = review;
        return c.json({ review });
      }
    }

    // Keep merge paused waiting for user choices (or abort on cancel)
    const review: MergeReviewStateDto = {
      mergeId: crypto.randomUUID(),
      kind,
      status: 'needs_choices',
      preSyncSha,
      prevBaseSha: mergeBaseSha,
      newBaseSha,
      summary: `${records.filter((r) => r.status === 'needs_choice').length} conflict${records.filter((r) => r.status === 'needs_choice').length === 1 ? '' : 's'} need your choice.`,
      records,
      upstreamCommits,
      touchedUserFiles: unmergedOut,
      firstPassUsageUsd,
    };
    activeMergeState = review;
    return c.json({ review });
  });

  app.post('/internal/sync/choose', async (c) => {
    if (readOnly) return c.json({ error: 'Read-only' }, 403);
    if (!activeMergeState) return c.json({ error: 'No active merge review' }, 404);

    const body = (await c.req.json()) as {
      choices: Array<{ recordId: string; optionId: string; customInstruction?: string }>;
    };

    for (const choice of body.choices) {
      const rec = activeMergeState.records.find((r) => r.id === choice.recordId);
      const pack = rec ? activeConflictPacks.get(rec.path) : undefined;
      if (!rec || !pack) continue;

      if (choice.optionId === 'custom' && choice.customInstruction?.trim()) {
        const res = await resolvePackWithLlm(
          REPO_ROOT,
          pack,
          {
            controlPlaneInternalUrl: CONTROL_PLANE_INTERNAL_URL,
            workspaceToken: WORKSPACE_TOKEN,
            modelId: piRuntime?.getResolvedModelId() || MODEL_ID,
            thinkingLevel: THINKING_LEVEL,
            purpose: 'conflict',
          },
          { customInstruction: choice.customInstruction.trim() },
        );
        rec.resolvedContent = res.record.resolvedContent ?? pack.oursContent ?? '';
        rec.resolvedPreview = res.record.resolvedPreview;
        rec.customInstruction = choice.customInstruction.trim();
        rec.chosenOptionId = 'custom';
        rec.status = 'chosen';
      } else if (choice.optionId === 'theirs') {
        rec.resolvedContent = pack.theirsContent ?? undefined;
        rec.chosenOptionId = 'theirs';
        rec.status = 'chosen';
      } else if (choice.optionId === 'ours') {
        rec.resolvedContent = pack.oursContent ?? undefined;
        rec.chosenOptionId = 'ours';
        rec.status = 'chosen';
      } else if (choice.optionId === 'combined') {
        rec.chosenOptionId = 'combined';
        rec.status = 'chosen';
      }
    }

    const stillPending = activeMergeState.records.some((r) => r.status === 'needs_choice');
    if (!stillPending) {
      for (const rec of activeMergeState.records) {
        const pack = activeConflictPacks.get(rec.path);
        const contentToWrite =
          rec.chosenOptionId === 'theirs'
            ? (pack?.theirsContent ?? null)
            : rec.chosenOptionId === 'ours'
              ? (pack?.oursContent ?? null)
              : (rec.resolvedContent ?? pack?.oursContent ?? '');
        const applied = await applyResolvedFile(REPO_ROOT, rec.path, contentToWrite);
        if (!applied.ok) {
          return c.json({ error: applied.error || `Failed to apply ${rec.path}` }, 400);
        }
      }
      await execFileAsync(
        'git',
        [
          '-c',
          `user.name=${gitIdentity.botName}`,
          '-c',
          `user.email=${gitIdentity.botEmail}`,
          'commit',
          '--no-edit',
        ],
        { cwd: REPO_ROOT, env: { ...process.env, GIT_EDITOR: 'true' } },
      ).catch(() => {});

      await runPostSyncTasks(
        activeMergeState.upstreamCommits.slice(0, 5).map((u) => u.subject).join('; '),
        activeMergeState.newBaseSha,
        activeMergeState.prevBaseSha,
      );
      activeMergeState.status = 'ready_for_review';
      activeMergeState.summary = 'All conflicts resolved — review the result below.';
    }

    return c.json({ review: activeMergeState });
  });

  app.post('/internal/sync/undo', async (c) => {
    if (readOnly) return c.json({ error: 'Read-only' }, 403);
    const body = (await c.req.json().catch(() => ({}))) as { targetSha?: string };
    const targetSha = body.targetSha || activeMergeState?.preSyncSha;
    if (!targetSha) return c.json({ error: 'No pre-sync snapshot to restore' }, 400);
    const ok = await resetToRef(REPO_ROOT, targetSha);
    if (!ok) return c.json({ error: 'Failed to undo update' }, 500);
    if (activeMergeState?.prevBaseSha) {
      baseSha = activeMergeState.prevBaseSha;
      await savePersistedSessionMeta().catch(() => {});
    }
    activeMergeState = null;
    activeConflictPacks.clear();
    return c.json({ ok: true });
  });

  app.post('/internal/sync/estimate-escalation', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      recordIds?: string[];
      userNote?: string;
      remainingBudgetUsd?: number;
      escalationModelId?: string;
      hardCeilingUsd?: number;
    };
    const selectedPacks: ConflictEvidencePack[] = [];
    for (const rec of activeMergeState?.records ?? []) {
      if (!body.recordIds || body.recordIds.length === 0 || body.recordIds.includes(rec.id)) {
        const pack = activeConflictPacks.get(rec.path);
        if (pack) selectedPacks.push(pack);
      }
    }
    const resolvedEscModel = piRuntime?.resolveModelAlias(body.escalationModelId || 'opus-latest') || 'claude-opus-4-6';
    const estimate = await estimateEscalationCost({
      packs: selectedPacks,
      controlPlaneInternalUrl: CONTROL_PLANE_INTERNAL_URL,
      workspaceToken: WORKSPACE_TOKEN,
      escalationModelId: resolvedEscModel,
      hardCeilingUsd: body.hardCeilingUsd ?? 2,
      remainingBudgetUsd: body.remainingBudgetUsd ?? 10,
      firstPassUsageUsd: activeMergeState?.firstPassUsageUsd,
      userNote: body.userNote,
    });
    return c.json({ estimate });
  });

  app.post('/internal/sync/escalate', async (c) => {
    if (readOnly) return c.json({ error: 'Read-only' }, 403);
    if (!activeMergeState) return c.json({ error: 'No active merge review to improve' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as {
      recordIds?: string[];
      userNote?: string;
      escalationModelId?: string;
      escalationThinking?: 'off' | 'low' | 'medium' | 'high';
      ceilingUsd?: number;
    };
    const resolvedEscModel = piRuntime?.resolveModelAlias(body.escalationModelId || 'opus-latest') || 'claude-opus-4-6';
    const runId = crypto.randomUUID();
    const ceilingUsd = Math.min(body.ceilingUsd ?? 2, 2);

    const advRecords: ConflictResolutionRecordDto[] = [];
    let totalUsage = 0;
    let stoppedAtCeiling = false;

    for (const rec of activeMergeState.records) {
      if (body.recordIds && body.recordIds.length > 0 && !body.recordIds.includes(rec.id)) {
        continue;
      }
      const pack = activeConflictPacks.get(rec.path);
      if (!pack) continue;
      const res = await resolvePackWithLlm(
        REPO_ROOT,
        pack,
        {
          controlPlaneInternalUrl: CONTROL_PLANE_INTERNAL_URL,
          workspaceToken: WORKSPACE_TOKEN,
          modelId: resolvedEscModel,
          thinkingLevel: body.escalationThinking ?? 'medium',
          purpose: 'conflict-escalation',
          runId,
          runCeilingUsd: ceilingUsd,
        },
        {
          rejectedAttempt: rec.resolvedContent,
          userNote: body.userNote,
        },
      );
      totalUsage += res.usageUsd;
      advRecords.push(res.record);
      if (res.stoppedAtCeiling) {
        stoppedAtCeiling = true;
        break;
      }
    }

    const identicalToFirst =
      advRecords.length > 0 &&
      advRecords.every((adv) => {
        const orig = activeMergeState!.records.find((r) => r.path === adv.path);
        return orig && orig.resolvedContent === adv.resolvedContent;
      });

    activeMergeState.advancedAttempt = {
      records: advRecords,
      usageUsd: Number(totalUsage.toFixed(4)),
      identicalToFirst,
      stoppedAtCeiling,
      message: stoppedAtCeiling
        ? `Stopped at $${totalUsage.toFixed(2)} to stay within the $${ceilingUsd.toFixed(2)} ceiling. First attempt kept.`
        : identicalToFirst
          ? 'The Advanced model reached the same result.'
          : 'Compare First vs Advanced below and choose which to keep.',
    };
    return c.json({ review: activeMergeState });
  });

  app.post('/internal/sync/apply-advanced', async (c) => {
    if (readOnly) return c.json({ error: 'Read-only' }, 403);
    if (!activeMergeState?.advancedAttempt) return c.json({ error: 'No advanced attempt available' }, 404);
    const body = (await c.req.json()) as {
      picks: Array<{ path: string; use: 'advanced' | 'first' }>;
    };
    for (const pick of body.picks) {
      if (pick.use !== 'advanced') continue;
      const adv = activeMergeState.advancedAttempt.records.find((r) => r.path === pick.path);
      if (!adv?.resolvedContent) continue;
      const applied = await applyResolvedFile(REPO_ROOT, adv.path, adv.resolvedContent);
      if (!applied.ok) return c.json({ error: applied.error }, 400);
      const orig = activeMergeState.records.find((r) => r.path === adv.path);
      if (orig) {
        orig.resolvedContent = adv.resolvedContent;
        orig.resolvedPreview = adv.resolvedPreview;
        orig.explanation = adv.explanation;
        orig.modelUsed = adv.modelUsed;
        orig.status = 'chosen';
      }
    }
    await createCheckpoint(REPO_ROOT, 'Applied Advanced merge improvements', gitIdentity).catch(() => null);
    return c.json({ review: activeMergeState });
  });

  app.post('/internal/git/revert-start', async (c) => {
    if (readOnly) return c.json({ error: 'Read-only' }, 403);
    const body = (await c.req.json()) as { shas: string[] };
    const result = await startRevertCommits(REPO_ROOT, body.shas ?? [], gitIdentity);
    if (result.status === 'conflict' && result.conflictedFiles.length > 0) {
      activeConflictPacks = new Map();
      const records: ConflictResolutionRecordDto[] = [];
      for (const relPath of result.conflictedFiles) {
        const pack = await buildConflictEvidencePack(REPO_ROOT, relPath, baseSha, BASE_BRANCH);
        activeConflictPacks.set(relPath, pack);
        const det = tryDeterministicResolve(pack);
        if (det) {
          records.push(det);
        } else {
          const res = await resolvePackWithLlm(REPO_ROOT, pack, {
            controlPlaneInternalUrl: CONTROL_PLANE_INTERNAL_URL,
            workspaceToken: WORKSPACE_TOKEN,
            modelId: piRuntime?.getResolvedModelId() || MODEL_ID,
            thinkingLevel: THINKING_LEVEL,
            purpose: 'conflict',
          });
          records.push(res.record);
        }
      }
      const headSha = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT })).stdout.trim();
      activeMergeState = {
        mergeId: crypto.randomUUID(),
        kind: 'revert',
        status: records.some((r) => r.status === 'needs_choice') ? 'needs_choices' : 'ready_for_review',
        preSyncSha: headSha,
        prevBaseSha: baseSha,
        newBaseSha: baseSha,
        summary: 'Someone updated these pages after your publication — choose what to keep.',
        records,
        upstreamCommits: [],
        touchedUserFiles: result.conflictedFiles,
      };
      return c.json({ ...result, review: activeMergeState });
    }
    return c.json(result);
  });

  app.get('/internal/review', async (c) => {
    const baseRef = c.req.query('baseRef') || `origin/${BASE_BRANCH}`;
    const changes = await getGitChanges(REPO_ROOT, baseRef);
    const cards = await buildChangeCards(REPO_ROOT, changes, {
      baseRef,
      prevBaseSha: prevBaseSha || null,
      editorName: gitIdentity.editorName,
      conflictRecords: activeMergeState?.records,
    });
    const mergedFromLiveFiles =
      prevBaseSha && baseSha && prevBaseSha !== baseSha
        ? await execFileAsync('git', ['diff', '--name-only', `${prevBaseSha}..${baseSha}`], {
            cwd: REPO_ROOT,
          })
            .then((r) => r.stdout.split(/\r?\n/).filter(Boolean))
            .catch(() => [] as string[])
        : [];

    const liveSiteUrl = await detectAstroSiteUrl(REPO_ROOT);

    return c.json({
      cards,
      pages: [],
      draftFiles: changes.map((ch) => ch.path),
      mergedFromLiveFiles,
      astroReady: astroManager.getStatus().ready,
      previewBase,
      liveSiteUrl,
      mergeReview: activeMergeState,
      baseSha,
      prevBaseSha: prevBaseSha || null,
    });
  });

  app.post('/internal/verify', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { pausePreview?: boolean };
    const shouldPause = Boolean(body.pausePreview);
    if (shouldPause) {
      broadcast({
        type: 'preview_paused',
        paused: true,
        reason: 'Running pre-publish checks…',
      });
      await astroManager.pause();
    }
    try {
      const result = await runAllVerificationChecks(REPO_ROOT, {
        supervisorUrl: SUPERVISOR_URL || undefined,
        hostSecret: WORKSPACE_HOST_SECRET || undefined,
        sessionId: SESSION_ID,
        onQueued: (position, message) => {
          broadcast({
            type: 'publish_state',
            payload: {
              state: 'verifying',
              queuePosition: position,
              queueMessage: message,
            },
          });
        },
        onAcquired: () => {
          broadcast({
            type: 'publish_state',
            payload: {
              state: 'verifying',
              queuePosition: null,
              queueMessage: null,
            },
          });
        },
      });
      return c.json(result);
    } catch (err) {
      return c.json(
        {
          allPassed: false,
          results: [
            {
              name: 'Build queue',
              command: 'halley-build-queue',
              passed: false,
              durationMs: 0,
              output: err instanceof Error ? err.message : 'Verification failed',
            },
          ],
        },
        200,
      );
    } finally {
      if (shouldPause) {
        try {
          await astroManager.resume();
        } catch (err) {
          console.error('[halley-runner] Failed to resume astro dev after verify:', err);
        }
        broadcast({ type: 'preview_paused', paused: false });
      }
    }
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
    const base = latestTranscript ?? {
      type: 'transcript_state',
      entries: [],
      live: { busy: false, streamingText: '', activeTools: [], queuedCount: 0 },
      usageUsd: 0,
    };
    return c.json({
      ...base,
      pageRequests: pageService.listPageRequests(),
    });
  });

  app.get('/internal/debug/trace', (c) => {
    if (!piRuntime) {
      return c.json({ error: 'Agent runtime is not ready yet' }, 503);
    }
    return c.json(piRuntime.getDebugTrace());
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
    ws.send(
      JSON.stringify({
        type: 'page_requests_sync',
        pageRequests: pageService.listPageRequests(),
      }),
    );
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
