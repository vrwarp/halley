import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import {
  discoverSiteRoutes,
  inspectAstroElement,
  patchStaticSpan,
  PerFileMutex,
  resolveEditorRelFile,
} from '@halley/astro-dev-edit';
import {
  ChatClientMessageSchema,
  SyncStartRequestSchema,
  type ChatServerMessage,
  type ConflictResolutionRecordDto,
  type MergeReviewStateDto,
  type OptimizationFindingDto,
} from '@halley/shared';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { WebSocketServer, type WebSocket } from 'ws';
import { AstroDevManager, detectAstroSiteUrl } from './astro-manager.js';
import {
  buildOptimizationPrompt,
  runDeterministicOptimizationPrePass,
} from './astro-optimizer.js';
import {
  commitVirtualMergeResolution,
  createCheckpoint,
  ensureGitRerere,
  getGitChanges,
  hasProtectedPathChanges,
  listCheckpoints,
  mergeWithBase,
  resetToRef,
  revertSingleFile,
  runLockedGit,
  startRevertCommits,
  undoToCheckpoint,
  virtualMergeWithBase,
  type GitIdentity,
} from './checkpoints-and-git.js';
import {
  applyResolvedFile,
  buildConflictEvidencePack,
  buildContradictionRecord,
  estimateEscalationCost,
  getUpstreamCommits,
  resolvePackWithLlm,
  tryDeterministicResolve,
  type ConflictEvidencePack,
} from './conflict-protocol.js';
import { NodeModulesCacheManager } from './nm-cache.js';
import { PageCreationService, PageValidationError } from './pages.js';
import { HalleyPiRuntime } from './pi-runtime.js';
import { UploadManager } from './uploads.js';
import {
  invalidateSpeculativeVerification,
  runAllVerificationChecks,
  runSpeculativeVerification,
} from './verify.js';
import { buildChangeCards, resolveVisualReviewRoutes } from './visual-diff.js';

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
let activeHostSecret = process.env.WORKSPACE_HOST_SECRET || '';
let workspaceToken = process.env.WORKSPACE_TOKEN || 'dev-token';

const explicitEnvPersona = process.env.HALLEY_PERSONA;
const explicitEnvEditorName = process.env.HALLEY_EDITOR_NAME;
const explicitEnvEditorEmail = process.env.HALLEY_EDITOR_EMAIL;
const explicitEnvReadOnly = process.env.HALLEY_READ_ONLY;

// Scrub secrets from process.env immediately so child processes (astro dev SSR, agent bash, build scripts) never inherit them
delete process.env.WORKSPACE_TOKEN;
delete process.env.WORKSPACE_HOST_SECRET;

const MODEL_ID = process.env.HALLEY_MODEL_ID || 'haiku-latest';
const THINKING_LEVEL = (process.env.HALLEY_THINKING_LEVEL || 'high') as
  | 'off'
  | 'low'
  | 'medium'
  | 'high';
let persona: 'non-technical' | 'developer' =
  explicitEnvPersona === 'developer' ? 'developer' : 'non-technical';

let readOnly = explicitEnvReadOnly === 'true';
let prevBaseSha = '';

const gitIdentity: GitIdentity = {
  botName: process.env.HALLEY_GIT_BOT_NAME || 'Halley Bot',
  botEmail: process.env.HALLEY_GIT_BOT_EMAIL || 'halley-bot@users.noreply.github.com',
  editorName: explicitEnvEditorName || 'Halley Editor',
  editorEmail: explicitEnvEditorEmail || 'editor@example.com',
};

const SESSION_META_PATH = path.join(STATE_DIR, 'session-meta.json');
const MERGE_REVIEW_STATE_PATH = path.join(STATE_DIR, 'merge-review.json');

interface PersistedSessionMeta {
  editorName?: string;
  editorEmail?: string;
  persona?: 'non-technical' | 'developer';
  baseSha?: string;
  prevBaseSha?: string;
  readOnly?: boolean;
}

interface PersistedMergeReviewDiskState {
  review: MergeReviewStateDto;
  packs: Array<[string, ConflictEvidencePack]>;
  virtualTreeSha?: string;
  needsLlmPass?: boolean;
}

async function loadPersistedSessionMeta(): Promise<void> {
  try {
    const raw = await fs.readFile(SESSION_META_PATH, 'utf8');
    const meta = JSON.parse(raw) as PersistedSessionMeta;
    // Authoritative env vars from control-plane SQLite win on wake; fallback to persisted meta only when omitted
    if (!explicitEnvEditorName && meta.editorName) gitIdentity.editorName = meta.editorName;
    if (!explicitEnvEditorEmail && meta.editorEmail) gitIdentity.editorEmail = meta.editorEmail;
    if (!explicitEnvPersona && (meta.persona === 'developer' || meta.persona === 'non-technical')) {
      persona = meta.persona;
    }
    if (meta.baseSha) baseSha = meta.baseSha;
    if (meta.prevBaseSha) prevBaseSha = meta.prevBaseSha;
    if (explicitEnvReadOnly === undefined && typeof meta.readOnly === 'boolean') {
      readOnly = meta.readOnly;
    }
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
    ...(prevBaseSha ? { prevBaseSha } : {}),
    readOnly,
  };
  const tmp = `${SESSION_META_PATH}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(meta, null, 2), 'utf8');
  await fs.rename(tmp, SESSION_META_PATH);
}

// Single OS-process PerFileMutex shared across inline `/__editor/patch`, Pi `edit`/`write`/`bash`, and `PageCreationService`
const fileLock = new PerFileMutex();
const uploadManager = new UploadManager(path.join(STATE_DIR, 'uploads'));

const wsClients = new Set<WebSocket>();
let latestTranscript: Extract<ChatServerMessage, { type: 'transcript_state' }> | null = null;
let currentWorkspaceLocked = false;
let currentLockedFile: string | undefined;
let currentPreviewPaused = false;
let currentPreviewPauseReason: string | undefined;

function broadcast(msg: ChatServerMessage): void {
  const payload = JSON.stringify(msg);
  for (const ws of wsClients) {
    if (ws.readyState === ws.OPEN) {
      ws.send(payload);
    }
  }
}

function notifySessionDiverged(changedFilesCount?: number): void {
  if (!CONTROL_PLANE_INTERNAL_URL || !workspaceToken) return;
  const endpoint = `${CONTROL_PLANE_INTERNAL_URL.replace(/\/$/, '')}/internal/session/diverged`;
  void fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${workspaceToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(
      typeof changedFilesCount === 'number' ? { changedFilesCount } : {},
    ),
    signal: AbortSignal.timeout(5000),
  }).catch(() => {});
}

async function notifyOptimizationSettled(): Promise<void> {
  if (!CONTROL_PLANE_INTERNAL_URL || !workspaceToken) return;
  const endpoint = `${CONTROL_PLANE_INTERNAL_URL.replace(/\/$/, '')}/internal/session/optimization-settled`;
  await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${workspaceToken}`,
    },
    signal: AbortSignal.timeout(5000),
  }).catch(() => {});
}

const IDLE_SPECULATIVE_DELAY_MS = Number(process.env.HALLEY_SPECULATIVE_IDLE_MS || 15_000);
let idleSpeculativeTimer: NodeJS.Timeout | null = null;

function cancelSpeculativeVerify(): void {
  if (idleSpeculativeTimer) {
    clearTimeout(idleSpeculativeTimer);
    idleSpeculativeTimer = null;
  }
  invalidateSpeculativeVerification(REPO_ROOT);
}

function triggerImmediateSpeculativeVerify(): void {
  if (idleSpeculativeTimer) {
    clearTimeout(idleSpeculativeTimer);
    idleSpeculativeTimer = null;
  }
  if (shuttingDown || readOnly || piRuntime?.isBusy() || inlineEditTimer) return;
  void runSpeculativeVerification(REPO_ROOT, {
    supervisorUrl: SUPERVISOR_URL || undefined,
    hostSecret: activeHostSecret || undefined,
    sessionId: SESSION_ID,
  });
}

function scheduleIdleSpeculativeVerify(delayMs = IDLE_SPECULATIVE_DELAY_MS): void {
  cancelSpeculativeVerify();
  if (shuttingDown || readOnly || delayMs <= 0) return;
  idleSpeculativeTimer = setTimeout(async () => {
    idleSpeculativeTimer = null;
    if (shuttingDown || readOnly || piRuntime?.isBusy() || inlineEditTimer) return;
    try {
      const changes = await getGitChanges(REPO_ROOT, `origin/${BASE_BRANCH}`);
      if (changes.length === 0) return;
    } catch {
      return;
    }
    void runSpeculativeVerification(REPO_ROOT, {
      supervisorUrl: SUPERVISOR_URL || undefined,
      hostSecret: activeHostSecret || undefined,
      sessionId: SESSION_ID,
    });
  }, delayMs);
  idleSpeculativeTimer.unref?.();
}

let inlineEditTimer: NodeJS.Timeout | null = null;
function cancelInlineEditTimer(): void {
  if (inlineEditTimer) {
    clearTimeout(inlineEditTimer);
    inlineEditTimer = null;
  }
}
function scheduleInlineCheckpoint(summary: string): void {
  cancelSpeculativeVerify();
  cancelInlineEditTimer();
  inlineEditTimer = setTimeout(async () => {
    inlineEditTimer = null;
    try {
      const ckpt = await createCheckpoint(REPO_ROOT, summary, gitIdentity);
      if (ckpt) {
        const changes = await getGitChanges(REPO_ROOT, `origin/${BASE_BRANCH}`).catch(() => []);
        broadcast({
          type: 'checkpoint_created',
          checkpoint: ckpt,
          changedFilesCount: changes.length,
        });
        notifySessionDiverged(changes.length);
        if (changes.length > 0) {
          scheduleIdleSpeculativeVerify();
        }
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

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  cancelSpeculativeVerify();
  cancelInlineEditTimer();
  await Promise.allSettled([
    astroManager.stop().catch(() => {}),
    piRuntime?.stop().catch(() => {}),
  ]);
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

async function main() {
  await loadPersistedSessionMeta();
  // Persist authoritative env metadata immediately so disk matches control-plane SQLite
  await savePersistedSessionMeta().catch(() => {});

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
    onBroadcast: (msg) => {
      broadcast(msg);
      if (msg.type === 'checkpoint_created') {
        notifySessionDiverged();
      }
    },
  });
  await pageService.load();
  await pageService
    .syncPageRequestsFromDisk({ reconcileInterrupted: true, broadcast: false })
    .catch(() => {});

  console.log('[halley-boot] starting_ai');
  piRuntime = new HalleyPiRuntime({
    repoRoot: REPO_ROOT,
    stateDir: STATE_DIR,
    sessionId: SESSION_ID,
    previewBase,
    astroPort: ASTRO_PORT,
    controlPlaneInternalUrl: CONTROL_PLANE_INTERNAL_URL,
    workspaceToken,
    getWorkspaceToken: () => workspaceToken,
    supervisorUrl: SUPERVISOR_URL || undefined,
    hostSecret: activeHostSecret || undefined,
    modelId: MODEL_ID,
    thinkingLevel: THINKING_LEVEL,
    getPersona: () => persona,
    fileLock,
    uploadManager,
    pageService,
    onLockChange: (locked, file) => {
      currentWorkspaceLocked = locked;
      currentLockedFile = locked ? file : undefined;
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
        notifySessionDiverged(changes.length);
        if (changes.length > 0) {
          scheduleIdleSpeculativeVerify();
        }
      }
    },
    pauseAstroForBuild: async () => {
      currentPreviewPaused = true;
      currentPreviewPauseReason = 'Running site checks…';
      broadcast({ type: 'preview_paused', paused: true, reason: 'Running site checks…' });
      await astroManager.pause();
    },
    resumeAstroAfterBuild: async () => {
      await astroManager.resume();
      currentPreviewPaused = false;
      currentPreviewPauseReason = undefined;
      broadcast({ type: 'preview_paused', paused: false });
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

  // Persistent virtual merge review state (survives sleep/wake with zero working-tree markers)
  let activeMergeState: MergeReviewStateDto | null = null;
  let activeConflictPacks = new Map<string, ConflictEvidencePack>();
  let activeVirtualTreeSha: string | undefined;
  let activeMergeNeedsLlmPass = false;
  let activeSyncOps = 0;

  const persistMergeReviewState = async () => {
    try {
      await fs.mkdir(STATE_DIR, { recursive: true });
      if (!activeMergeState) {
        await fs.rm(MERGE_REVIEW_STATE_PATH, { force: true });
        return;
      }
      const payload: PersistedMergeReviewDiskState = {
        review: activeMergeState,
        packs: Array.from(activeConflictPacks.entries()),
        ...(activeVirtualTreeSha ? { virtualTreeSha: activeVirtualTreeSha } : {}),
        ...(activeMergeNeedsLlmPass ? { needsLlmPass: true } : {}),
      };
      const tmp = `${MERGE_REVIEW_STATE_PATH}.tmp-${process.pid}`;
      await fs.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8');
      await fs.rename(tmp, MERGE_REVIEW_STATE_PATH);
    } catch {
      // non-fatal
    }
  };

  try {
    const rawMerge = await fs.readFile(MERGE_REVIEW_STATE_PATH, 'utf8');
    const parsed = JSON.parse(rawMerge) as PersistedMergeReviewDiskState;
    if (parsed?.review) {
      activeMergeState = parsed.review;
      activeConflictPacks = new Map(parsed.packs ?? []);
      activeVirtualTreeSha = parsed.virtualTreeSha;
      activeMergeNeedsLlmPass = Boolean(parsed.needsLlmPass);
    }
  } catch {
    // no persisted merge state
  }

  const nmCacheDir =
    process.env.HALLEY_NM_CACHE_DIR || path.join(path.dirname(path.dirname(STATE_DIR)), 'nm-cache');
  const pkgCacheDir =
    process.env.HALLEY_PKG_CACHE_DIR || path.join(path.dirname(path.dirname(STATE_DIR)), 'pkg-cache');
  const runnerNmCache = new NodeModulesCacheManager(nmCacheDir, pkgCacheDir, 2);

  const app = new Hono();

  app.get('/health', (c) => {
    const astro = astroManager.getStatus();
    const piBusy = piRuntime?.isBusy() ?? false;
    const busy = piBusy || activeSyncOps > 0 || activeMergeState?.status === 'needs_choices';
    return c.json({
      ok: true,
      sessionId: SESSION_ID,
      astroReady: astro.ready,
      astroState: astro.state,
      astroCrashCount: astro.crashCount,
      astroLastExitCode: astro.lastExitCode,
      astroPort: astro.port,
      astroLogs: astro.logs.slice(-10),
      piBusy,
      busy,
      originalBase,
      previewBase,
      readOnly,
      baseSha,
    });
  });

  // ==========================================================================
  // Single-Writer Inline Editor Endpoints (`/__editor/*` or `/p/:id/.../__editor/*`)
  // ==========================================================================
  let routesInflight: Promise<Awaited<ReturnType<typeof discoverSiteRoutes>>> | null = null;
  const loadRoutesDedup = () => {
    if (!routesInflight) {
      routesInflight = discoverSiteRoutes(REPO_ROOT).finally(() => {
        routesInflight = null;
      });
    }
    return routesInflight;
  };

  app.use('*', async (c, next) => {
    const pathname = new URL(c.req.url).pathname;
    if (c.req.method === 'GET' && pathname.endsWith('/__editor/health')) {
      return c.json({ ok: true, astroReady: astroManager.getStatus().ready });
    }
    if (c.req.method === 'GET' && pathname.endsWith('/__editor/routes')) {
      const routes = await loadRoutesDedup();
      return c.json({ routes });
    }
    if (c.req.method === 'POST' && pathname.endsWith('/__editor/inspect')) {
      try {
        const body = (await c.req.json()) as { file?: string; loc?: string };
        const relFile = resolveEditorRelFile(REPO_ROOT, String(body.file ?? ''));
        if (relFile.startsWith('..') || relFile === '.github' || relFile.startsWith('.github/')) {
          return c.json({ editability: 'dynamic', reason: 'Protected path' });
        }
        const abs = path.resolve(REPO_ROOT, relFile);
        const source = await fs.readFile(abs, 'utf8');
        const inspected = await inspectAstroElement(source, String(body.loc ?? ''));
        if (!inspected) {
          return c.json({ editability: 'dynamic', reason: 'Unmapped AST node' });
        }
        return c.json({
          editability: inspected.editability,
          reason: inspected.reason,
          snapshotHash: inspected.snapshotHash,
          tagName: inspected.tagName,
        });
      } catch (err) {
        return c.json(
          {
            editability: 'dynamic',
            error: err instanceof Error ? err.message : 'Inspect failed',
          },
          400,
        );
      }
    }
    if (c.req.method === 'POST' && pathname.endsWith('/__editor/patch')) {
      if (readOnly) {
        return c.json({ error: 'Session is read-only' }, 403);
      }
      try {
        const body = (await c.req.json()) as {
          file?: string;
          loc?: string;
          expectedHash?: string;
          newHtml?: string;
        };
        const relFile = resolveEditorRelFile(REPO_ROOT, String(body.file ?? ''));
        const astroStatus = astroManager.getStatus();
        const result = await patchStaticSpan({
          repoRoot: REPO_ROOT,
          relFile,
          loc: String(body.loc ?? ''),
          expectedHash: String(body.expectedHash ?? ''),
          newHtml: String(body.newHtml ?? ''),
          previewBase: astroStatus.previewBase || previewBase,
          originalBase: astroStatus.originalBase || originalBase,
          fileLock,
        });
        if (!result.ok) {
          return c.json({ error: result.error }, result.code);
        }
        scheduleInlineCheckpoint(`Inline edit in ${relFile}`);
        return c.json({
          ok: true,
          updatedSource: result.updatedSource,
          newHash: result.newHash,
          newLoc: result.newLoc,
          topLineDelta: result.topLineDelta,
          afterLine: result.afterLine,
          afterLineDelta: result.afterLineDelta,
          sameLineEndCol: result.sameLineEndCol,
          sameLineByteDelta: result.sameLineByteDelta,
        });
      } catch (err) {
        return c.json(
          { error: err instanceof Error ? err.message : 'Patch failed' },
          500,
        );
      }
    }
    return next();
  });

  app.post('/internal/token', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      workspaceToken?: string;
      hostSecret?: string;
    };
    if (body.hostSecret?.trim()) {
      activeHostSecret = body.hostSecret.trim();
    }
    if (!body.workspaceToken || !body.workspaceToken.trim()) {
      return c.json({ error: 'Missing workspaceToken' }, 400);
    }
    workspaceToken = body.workspaceToken.trim();
    return c.json({ ok: true });
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
   * Binds a pre-warmed standby workspace to a real user session.
   * When `syncFromMirror` is false (normal case since supervisor recycles standby slots when
   * `origin/main` advances), performs a zero-file-churn `git symbolic-ref` branch rename so
   * Chokidar fires zero events and pre-rendered Vite/Tailwind JIT caches stay hot!
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
      workspaceToken?: string;
      hostSecret?: string;
    };

    if (body.workspaceToken?.trim()) {
      workspaceToken = body.workspaceToken.trim();
    }
    if (body.hostSecret?.trim()) {
      activeHostSecret = body.hostSecret.trim();
    }

    const targetBaseBranch = body.baseBranch || BASE_BRANCH;
    const mirrorPath = body.mirrorPath || process.env.HALLEY_MIRROR_PATH || '/halley-mirror/repo.git';
    let needsAstroRestart = false;

    if (body.syncFromMirror) {
      const hasMirror = await fs
        .access(path.join(mirrorPath, 'HEAD'))
        .then(() => true)
        .catch(() => false);
      if (hasMirror) {
        const oldHead = (await runLockedGit(REPO_ROOT, ['rev-parse', 'HEAD'])).stdout.trim();
        await runLockedGit(
          REPO_ROOT,
          ['fetch', mirrorPath, `+refs/heads/${targetBaseBranch}:refs/remotes/origin/${targetBaseBranch}`],
          undefined,
          30_000,
        );
        const changedFilesOut = await runLockedGit(REPO_ROOT, [
          'diff',
          '--name-only',
          oldHead,
          `origin/${targetBaseBranch}`,
        ]);
        const changedList = changedFilesOut.stdout.split(/\r?\n/).filter(Boolean);

        const changedLocks = changedList.some(
          (f) => f === 'package.json' || f === 'package-lock.json' || f === 'pnpm-lock.yaml',
        );
        if (changedLocks || changedList.some((f) => f.startsWith('astro.config.'))) {
          needsAstroRestart = true;
          await astroManager.pause().catch(() => {});
        }

        await runLockedGit(REPO_ROOT, [
          'checkout',
          '-B',
          body.workingBranch,
          `origin/${targetBaseBranch}`,
        ]);

        if (changedLocks) {
          await runnerNmCache.ensureSessionNodeModules({
            workspaceDir: REPO_ROOT,
            stateDir: STATE_DIR,
            devLocalRepo: process.env.HALLEY_DEV_LOCAL_REPO || undefined,
          });
        }
        await piRuntime?.reloadAgentsMd().catch(() => {});
      } else {
        const curSha = (await runLockedGit(REPO_ROOT, ['rev-parse', 'HEAD'])).stdout.trim();
        await runLockedGit(REPO_ROOT, ['update-ref', `refs/heads/${body.workingBranch}`, curSha]);
        await runLockedGit(REPO_ROOT, ['symbolic-ref', 'HEAD', `refs/heads/${body.workingBranch}`]);
      }
    } else {
      // Zero working-tree churn branch rename
      const curSha = (await runLockedGit(REPO_ROOT, ['rev-parse', 'HEAD'])).stdout.trim();
      await runLockedGit(REPO_ROOT, ['update-ref', `refs/heads/${body.workingBranch}`, curSha]);
      await runLockedGit(REPO_ROOT, ['symbolic-ref', 'HEAD', `refs/heads/${body.workingBranch}`]);
    }

    if (needsAstroRestart) {
      await astroManager.restart().catch(() => {});
    }

    await ensureGitRerere(REPO_ROOT).catch(() => {});
    baseSha = (await runLockedGit(REPO_ROOT, ['rev-parse', 'HEAD'])).stdout.trim();
    if (body.editorName) gitIdentity.editorName = body.editorName;
    if (body.editorEmail) gitIdentity.editorEmail = body.editorEmail;
    if (body.persona === 'developer' || body.persona === 'non-technical') {
      persona = body.persona;
    }
    if (typeof body.readOnly === 'boolean') {
      readOnly = body.readOnly;
    }
    await savePersistedSessionMeta();

    const astroStatus = astroManager.getStatus();
    return c.json({
      ok: true,
      baseSha,
      originalBase: astroStatus.originalBase || originalBase,
      previewBase: astroStatus.previewBase || previewBase,
    });
  });

  app.post('/internal/read-only', async (c) => {
    const body = (await c.req.json()) as { readOnly: boolean };
    readOnly = Boolean(body.readOnly);
    if (readOnly) cancelSpeculativeVerify();
    await savePersistedSessionMeta().catch(() => {});
    return c.json({ ok: true, readOnly });
  });

  app.post('/internal/persona', async (c) => {
    const body = (await c.req.json()) as { persona?: string };
    persona = body.persona === 'developer' ? 'developer' : 'non-technical';
    await savePersistedSessionMeta().catch(() => {});
    return c.json({ ok: true, persona });
  });

  app.post('/internal/owner', async (c) => {
    const body = (await c.req.json()) as {
      editorName?: string;
      editorEmail?: string;
      persona?: string;
    };
    if (body.editorName?.trim()) gitIdentity.editorName = body.editorName.trim();
    if (body.editorEmail?.trim()) gitIdentity.editorEmail = body.editorEmail.trim();
    if (body.persona === 'developer' || body.persona === 'non-technical') {
      persona = body.persona;
    }
    await savePersistedSessionMeta().catch(() => {});
    return c.json({ ok: true });
  });

  app.get('/internal/routes', async (c) => {
    const routes = await loadRoutesDedup();
    return c.json({ routes });
  });

  app.get('/internal/page-options', async (c) => {
    const capped = c.req.query('capped') === 'true';
    const options = await pageService.getPageCreationOptions(capped);
    return c.json(options);
  });

  app.post('/internal/pages', async (c) => {
    if (readOnly) return c.json({ error: 'Read-only' }, 403);
    cancelSpeculativeVerify();
    try {
      const body = (await c.req.json()) as Record<string, unknown>;
      const capped = Boolean(body.capped);
      const isBusy = piRuntime?.isBusy() ?? false;
      const result = await pageService.createPage(body, { capped, isBusy });

      if (!capped && piRuntime) {
        const reqViewport = (
          body.editorContext as { viewport?: 'desktop' | 'tablet' | 'mobile' } | undefined
        )?.viewport;
        await piRuntime.submitPageCreationRequest(
          result.pageRequest,
          result.instructions,
          isBusy ? 'followUp' : undefined,
          reqViewport,
        );
      } else {
        scheduleIdleSpeculativeVerify();
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
    cancelSpeculativeVerify();
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
    cancelSpeculativeVerify();
    const route =
      c.req.query('route') ||
      ((await c.req.json().catch(() => ({}))) as { route?: string }).route;
    if (!route) return c.json({ error: 'Missing route' }, 400);
    try {
      const res = await pageService.deletePage(route);
      scheduleIdleSpeculativeVerify();
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
    cancelSpeculativeVerify();
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
      } else {
        scheduleIdleSpeculativeVerify();
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
    cancelSpeculativeVerify();
    const body = (await c.req.json()) as {
      fromRoute: string;
      toSection: string;
      toSlug: string;
    };
    try {
      const res = await pageService.renamePage(body);
      scheduleIdleSpeculativeVerify();
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
    cancelSpeculativeVerify();
    cancelInlineEditTimer();
    const body = (await c.req.json()) as { path: string; baseRef?: string };
    await revertSingleFile(REPO_ROOT, body.path, body.baseRef || `origin/${BASE_BRANCH}`, gitIdentity);
    await pageService.syncPageRequestsFromDisk().catch(() => {});
    const changes = await getGitChanges(REPO_ROOT, `origin/${BASE_BRANCH}`).catch(() => []);
    const checkpoints = await listCheckpoints(REPO_ROOT, baseSha).catch(() => []);
    if (checkpoints[0]) {
      broadcast({
        type: 'checkpoint_created',
        checkpoint: checkpoints[0],
        changedFilesCount: changes.length,
      });
    }
    notifySessionDiverged(changes.length);
    if (changes.length > 0) {
      scheduleIdleSpeculativeVerify();
    }
    return c.json({ ok: true, changedFilesCount: changes.length });
  });

  /**
   * Transactionally excludes unticked Undo paths right before verification, returning
   * `preExcludeSha` so `PublishService` can restore the unticked files if checks fail.
   */
  app.post('/internal/git/exclude-paths', async (c) => {
    if (readOnly) return c.json({ error: 'Read-only' }, 403);
    cancelSpeculativeVerify();
    cancelInlineEditTimer();
    const body = (await c.req.json()) as { paths?: string[]; baseRef?: string };
    const paths = (body.paths ?? []).filter((p) => p && !p.startsWith('.github'));
    if (paths.length === 0) {
      return c.json({ ok: true, preExcludeSha: null });
    }
    await createCheckpoint(REPO_ROOT, 'Before partial-undo selection', gitIdentity);
    const preExcludeSha = (await runLockedGit(REPO_ROOT, ['rev-parse', 'HEAD'])).stdout.trim();
    const baseRef = body.baseRef || `origin/${BASE_BRANCH}`;
    for (const relPath of paths) {
      const inBase = await runLockedGit(REPO_ROOT, ['cat-file', '-e', `${baseRef}:${relPath}`]);
      if (inBase.code === 0) {
        await runLockedGit(REPO_ROOT, ['checkout', baseRef, '--', relPath]);
      } else {
        await fs.rm(path.join(REPO_ROOT, relPath), { force: true });
        await runLockedGit(REPO_ROOT, ['rm', '-f', '--ignore-unmatch', relPath]);
      }
    }
    await createCheckpoint(
      REPO_ROOT,
      `Exclude ${paths.length} unselected file${paths.length === 1 ? '' : 's'} from Undo`,
      gitIdentity,
    );
    const changes = await getGitChanges(REPO_ROOT, baseRef).catch(() => []);
    return c.json({ ok: true, preExcludeSha, changedFilesCount: changes.length });
  });

  app.post('/internal/git/restore-sha', async (c) => {
    if (readOnly) return c.json({ error: 'Read-only' }, 403);
    const body = (await c.req.json()) as { targetSha?: string };
    if (!body.targetSha) return c.json({ error: 'Missing targetSha' }, 400);
    const ok = await resetToRef(REPO_ROOT, body.targetSha);
    if (!ok) return c.json({ error: 'Failed to restore SHA' }, 500);
    const changes = await getGitChanges(REPO_ROOT, `origin/${BASE_BRANCH}`).catch(() => []);
    return c.json({ ok: true, changedFilesCount: changes.length });
  });

  app.post('/internal/git/undo', async (c) => {
    if (readOnly) return c.json({ error: 'Read-only' }, 403);
    cancelSpeculativeVerify();
    cancelInlineEditTimer();
    const body = (await c.req.json()) as { targetSha: string };
    const ckpt = await undoToCheckpoint(REPO_ROOT, body.targetSha, gitIdentity);
    await pageService.syncPageRequestsFromDisk().catch(() => {});
    const changes = await getGitChanges(REPO_ROOT, `origin/${BASE_BRANCH}`).catch(() => []);
    if (ckpt) {
      broadcast({ type: 'checkpoint_created', checkpoint: ckpt, changedFilesCount: changes.length });
    }
    notifySessionDiverged(changes.length);
    if (changes.length > 0) {
      scheduleIdleSpeculativeVerify();
    }
    return c.json({ ok: true, checkpoint: ckpt, changedFilesCount: changes.length });
  });

  app.post('/internal/git/checkpoint', async (c) => {
    if (readOnly) return c.json({ error: 'Read-only' }, 403);
    cancelInlineEditTimer();
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

  const runPostSyncTasks = async (upstreamSummary: string, newSha: string, prevSha: string) => {
    prevBaseSha = prevSha;
    baseSha = newSha;
    await savePersistedSessionMeta().catch(() => {});
    await piRuntime?.reloadAgentsMd().catch(() => {});
    if (upstreamSummary) {
      piRuntime?.addSystemContextNote(`Live site updates merged into this draft: ${upstreamSummary}`);
    }
    if (prevSha && newSha && prevSha !== newSha) {
      const diffFiles = (
        await runLockedGit(REPO_ROOT, ['diff', '--name-only', `${prevSha}..${newSha}`])
      ).stdout
        .split(/\r?\n/)
        .filter(Boolean);
      const changedDeps = diffFiles.some(
        (f) => f === 'package.json' || f === 'package-lock.json' || f === 'pnpm-lock.yaml',
      );
      const changedConfig = diffFiles.some((f) => f.startsWith('astro.config.'));
      if (changedDeps) {
        await astroManager.pause().catch(() => {});
        await runnerNmCache
          .ensureSessionNodeModules({
            workspaceDir: REPO_ROOT,
            stateDir: STATE_DIR,
            devLocalRepo: process.env.HALLEY_DEV_LOCAL_REPO || undefined,
          })
          .catch(() => {});
        await astroManager.restart().catch(() => {});
      } else if (changedConfig) {
        await astroManager.restart().catch(() => {});
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
    cancelInlineEditTimer();
    activeSyncOps += 1;
    try {
      const rawBody = await c.req.json().catch(() => ({}));
      const parsedBody = SyncStartRequestSchema.safeParse(rawBody);
      const body = (parsedBody.success ? parsedBody.data : rawBody) as {
        baseBranch?: string;
        kind?: 'sync' | 'publish' | 'revert';
        autoSyncOnly?: boolean;
        autoApplyCleanOnly?: boolean;
        skipFetch?: boolean;
      };
      const baseBranch = body.baseBranch || BASE_BRANCH;
      const kind = body.kind ?? 'sync';
      const baseRef = `origin/${baseBranch}`;

      // If we already deferred an LLM conflict pass from PublishModal open (`autoApplyCleanOnly: true`)
      // and now the user clicked Publish/Resolve (`!autoApplyCleanOnly && !autoSyncOnly`), run the LLM pass on those virtual packs!
      const vres = await virtualMergeWithBase(REPO_ROOT, {
        baseBranch,
        identity: gitIdentity,
        skipFetch: body.skipFetch,
        fetchAuthBearer: activeHostSecret || workspaceToken || undefined,
      });

      if (vres.status === 'error') {
        return c.json({ error: vres.error || 'Failed to sync with live site' }, 502);
      }

      if (vres.status === 'clean' && vres.alreadyUpToDate) {
        if (activeMergeState && activeMergeState.newBaseSha === vres.newBaseSha) {
          return c.json({
            review: {
              ...activeMergeState,
              alreadyUpToDate: true,
            },
          });
        }
        const review: MergeReviewStateDto = {
          mergeId: crypto.randomUUID(),
          kind,
          status: 'clean',
          preSyncSha: vres.preSyncSha,
          prevBaseSha: prevBaseSha || vres.prevBaseSha,
          newBaseSha: vres.newBaseSha,
          alreadyUpToDate: true,
          summary: 'Your draft is already up to date with the live site.',
          records: [],
          upstreamCommits: [],
          touchedUserFiles: [],
        };
        return c.json({ review });
      }

      cancelSpeculativeVerify();

      const upstreamCommits = await getUpstreamCommits(REPO_ROOT, vres.prevBaseSha, baseRef);

      if (vres.status === 'clean') {
        const userChanged = (await getGitChanges(REPO_ROOT, vres.prevBaseSha)).map((ch) => ch.path);
        const upstreamChanged = (
          await runLockedGit(REPO_ROOT, ['diff', '--name-only', `${vres.prevBaseSha}..${baseRef}`])
        ).stdout
          .split(/\r?\n/)
          .filter(Boolean);
        const overlap = userChanged.filter((f) => upstreamChanged.includes(f));

        const summary =
          overlap.length > 0
            ? `Merged ${upstreamCommits.length} live update${upstreamCommits.length === 1 ? '' : 's'} into ${overlap.length} file${overlap.length === 1 ? '' : 's'} you edited — please review.`
            : `Updated with ${upstreamCommits.length} change${upstreamCommits.length === 1 ? '' : 's'} from the live site.`;
        await runPostSyncTasks(
          upstreamCommits.slice(0, 5).map((u) => u.subject).join('; '),
          vres.newBaseSha,
          vres.prevBaseSha,
        );
        const review: MergeReviewStateDto = {
          mergeId: crypto.randomUUID(),
          kind,
          status: overlap.length > 0 ? 'ready_for_review' : 'applied',
          preSyncSha: vres.preSyncSha,
          prevBaseSha: vres.prevBaseSha,
          newBaseSha: vres.newBaseSha,
          summary,
          records: [],
          upstreamCommits,
          touchedUserFiles: overlap,
        };
        activeMergeState = review;
        activeConflictPacks.clear();
        activeVirtualTreeSha = undefined;
        activeMergeNeedsLlmPass = false;
        await persistMergeReviewState();
        return c.json({ review });
      }

      // Virtual merge hit conflicts — `/workspace` is completely untouched and free of `<<<<<<<` markers!
      activeConflictPacks = new Map();
      activeVirtualTreeSha = vres.virtualTreeSha;
      const records: ConflictResolutionRecordDto[] = [];
      let firstPassUsageUsd = 0;
      let needsAi = false;

      for (const relPath of vres.conflictedFiles) {
        const pack = await buildConflictEvidencePack(
          REPO_ROOT,
          relPath,
          vres.prevBaseSha,
          baseBranch,
          kind,
          {
            baseSha: vres.prevBaseSha,
            oursSha: vres.preSyncSha,
            theirsSha: vres.newBaseSha,
            virtualTreeSha: vres.virtualTreeSha,
          },
        );
        activeConflictPacks.set(relPath, pack);

        const det = tryDeterministicResolve(pack);
        if (det) {
          records.push(det);
        } else if (body.autoSyncOnly) {
          needsAi = true;
        } else if (body.autoApplyCleanOnly) {
          // PublishModal open preflight: $0 cost, zero disk mutation, build clear choice card until Publish/Resolve
          needsAi = true;
          records.push(
            buildContradictionRecord(pack, {
              explanation:
                'Both your draft and the live site changed this section. Click Publish to combine automatically, or pick a version below.',
              modelUsed: 'deferred',
            }),
          );
        } else {
          const res = await resolvePackWithLlm(REPO_ROOT, pack, {
            controlPlaneInternalUrl: CONTROL_PLANE_INTERNAL_URL,
            workspaceToken,
            modelId: piRuntime?.getResolvedModelId() || MODEL_ID,
            thinkingLevel: THINKING_LEVEL,
            purpose: 'conflict',
          });
          firstPassUsageUsd += res.usageUsd;
          records.push(res.record);
        }
      }

      if (body.autoSyncOnly && (needsAi || records.some((r) => r.status === 'needs_choice'))) {
        activeConflictPacks.clear();
        activeVirtualTreeSha = undefined;
        return c.json({
          heldForUser: true,
          overlapCount: vres.conflictedFiles.length,
          upstreamCommits,
        });
      }

      const needsChoices = records.some((r) => r.status === 'needs_choice');
      if (!needsChoices) {
        const committed = await commitVirtualMergeResolution(REPO_ROOT, {
          virtualTreeSha: vres.virtualTreeSha,
          preSyncSha: vres.preSyncSha,
          newBaseSha: vres.newBaseSha,
          resolvedFiles: records.map((rec) => ({
            path: rec.path,
            content: rec.resolvedContent ?? '',
          })),
          identity: gitIdentity,
        });
        if (committed.ok) {
          await runPostSyncTasks(
            upstreamCommits.slice(0, 5).map((u) => u.subject).join('; '),
            vres.newBaseSha,
            vres.prevBaseSha,
          );
          const review: MergeReviewStateDto = {
            mergeId: crypto.randomUUID(),
            kind,
            status: 'ready_for_review',
            preSyncSha: vres.preSyncSha,
            prevBaseSha: vres.prevBaseSha,
            newBaseSha: vres.newBaseSha,
            summary: `Combined ${records.length} overlapping change${records.length === 1 ? '' : 's'} automatically — please review.`,
            records,
            upstreamCommits,
            touchedUserFiles: vres.conflictedFiles,
            firstPassUsageUsd,
          };
          activeMergeState = review;
          activeVirtualTreeSha = undefined;
          activeMergeNeedsLlmPass = false;
          await persistMergeReviewState();
          return c.json({ review });
        }
      }

      const review: MergeReviewStateDto = {
        mergeId: crypto.randomUUID(),
        kind,
        status: 'needs_choices',
        preSyncSha: vres.preSyncSha,
        prevBaseSha: vres.prevBaseSha,
        newBaseSha: vres.newBaseSha,
        summary: `${records.filter((r) => r.status === 'needs_choice').length} conflict${records.filter((r) => r.status === 'needs_choice').length === 1 ? '' : 's'} need your choice.`,
        records,
        upstreamCommits,
        touchedUserFiles: vres.conflictedFiles,
        firstPassUsageUsd,
      };
      activeMergeState = review;
      activeMergeNeedsLlmPass = Boolean(body.autoApplyCleanOnly && needsAi);
      await persistMergeReviewState();
      return c.json({ review });
    } finally {
      activeSyncOps = Math.max(0, activeSyncOps - 1);
    }
  });

  app.post('/internal/sync/choose', async (c) => {
    if (readOnly) return c.json({ error: 'Read-only' }, 403);
    if (!activeMergeState) return c.json({ error: 'No active merge review' }, 404);
    cancelSpeculativeVerify();
    cancelInlineEditTimer();
    activeSyncOps += 1;
    try {
      const body = (await c.req.json()) as {
        choices: Array<{ recordId: string; optionId: string; customInstruction?: string }>;
      };

      for (const choice of body.choices) {
        const rec = activeMergeState.records.find((r) => r.id === choice.recordId);
        const pack = rec ? activeConflictPacks.get(rec.path) : undefined;
        if (!rec || !pack) continue;

        if (choice.optionId === 'custom') {
          if (!choice.customInstruction?.trim()) {
            return c.json(
              { error: 'Please enter instructions for what you want Halley to do.' },
              400,
            );
          }
          const res = await resolvePackWithLlm(
            REPO_ROOT,
            pack,
            {
              controlPlaneInternalUrl: CONTROL_PLANE_INTERNAL_URL,
              workspaceToken,
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
        const resolvedList = activeMergeState.records.map((rec) => {
          const pack = activeConflictPacks.get(rec.path);
          const content =
            rec.chosenOptionId === 'theirs'
              ? (pack?.theirsContent ?? null)
              : rec.chosenOptionId === 'ours'
                ? (pack?.oursContent ?? null)
                : (rec.resolvedContent ?? pack?.oursContent ?? '');
          return { path: rec.path, content };
        });

        if (activeMergeState.kind !== 'revert' || activeVirtualTreeSha) {
          const committed = await commitVirtualMergeResolution(REPO_ROOT, {
            virtualTreeSha: activeVirtualTreeSha,
            preSyncSha: activeMergeState.preSyncSha,
            newBaseSha: activeMergeState.newBaseSha,
            resolvedFiles: resolvedList,
            identity: gitIdentity,
            commitMessage:
              activeMergeState.kind === 'revert'
                ? 'halley-checkpoint: Undo published edit (resolved conflicts)'
                : undefined,
          });
          if (!committed.ok) {
            return c.json({ error: committed.error }, 400);
          }
        } else {
          for (const item of resolvedList) {
            const applied = await applyResolvedFile(REPO_ROOT, item.path, item.content);
            if (!applied.ok) {
              return c.json({ error: applied.error || `Failed to apply ${item.path}` }, 400);
            }
          }
          await runLockedGit(
            REPO_ROOT,
            [
              '-c',
              `user.name=${gitIdentity.botName}`,
              '-c',
              `user.email=${gitIdentity.botEmail}`,
              'commit',
              '--no-edit',
            ],
            { GIT_EDITOR: 'true' },
          );
        }

        if (activeMergeState.kind !== 'revert') {
          await runPostSyncTasks(
            activeMergeState.upstreamCommits.slice(0, 5).map((u) => u.subject).join('; '),
            activeMergeState.newBaseSha,
            activeMergeState.prevBaseSha,
          );
        }
        activeMergeState.status = 'ready_for_review';
        activeMergeState.summary = 'All conflicts resolved — review the result below.';
        activeVirtualTreeSha = undefined;
        activeMergeNeedsLlmPass = false;
      }

      await persistMergeReviewState();
      return c.json({ review: activeMergeState });
    } finally {
      activeSyncOps = Math.max(0, activeSyncOps - 1);
    }
  });

  app.post('/internal/sync/undo', async (c) => {
    if (readOnly) return c.json({ error: 'Read-only' }, 403);
    cancelSpeculativeVerify();
    cancelInlineEditTimer();
    const body = (await c.req.json().catch(() => ({}))) as { targetSha?: string };
    const targetSha = body.targetSha || activeMergeState?.preSyncSha;
    if (!targetSha) return c.json({ error: 'No pre-sync snapshot to restore' }, 400);
    // If the conflict was purely virtual (`needs_choices`), HEAD wasn't even moved unless the user edited later!
    if (activeMergeState?.status !== 'needs_choices' || body.targetSha) {
      const ok = await resetToRef(REPO_ROOT, targetSha);
      if (!ok) return c.json({ error: 'Failed to undo update' }, 500);
      if (activeMergeState?.prevBaseSha) {
        baseSha = activeMergeState.prevBaseSha;
        await savePersistedSessionMeta().catch(() => {});
      }
    }
    activeMergeState = null;
    activeConflictPacks.clear();
    activeVirtualTreeSha = undefined;
    activeMergeNeedsLlmPass = false;
    await persistMergeReviewState();
    await pageService.syncPageRequestsFromDisk().catch(() => {});
    const changes = await getGitChanges(REPO_ROOT, `origin/${BASE_BRANCH}`).catch(() => []);
    return c.json({ ok: true, changedFilesCount: changes.length });
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
    const resolvedEscModel =
      piRuntime?.resolveModelAlias(body.escalationModelId || 'opus-latest') || 'claude-opus-4-6';
    const estimate = await estimateEscalationCost({
      packs: selectedPacks,
      controlPlaneInternalUrl: CONTROL_PLANE_INTERNAL_URL,
      workspaceToken,
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
    activeSyncOps += 1;
    try {
      const body = (await c.req.json().catch(() => ({}))) as {
        recordIds?: string[];
        userNote?: string;
        escalationModelId?: string;
        escalationThinking?: 'off' | 'low' | 'medium' | 'high';
        ceilingUsd?: number;
      };
      const resolvedEscModel =
        piRuntime?.resolveModelAlias(body.escalationModelId || 'opus-latest') || 'claude-opus-4-6';
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
            workspaceToken,
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
      await persistMergeReviewState();
      return c.json({ review: activeMergeState });
    } finally {
      activeSyncOps = Math.max(0, activeSyncOps - 1);
    }
  });

  app.post('/internal/sync/apply-advanced', async (c) => {
    if (readOnly) return c.json({ error: 'Read-only' }, 403);
    if (!activeMergeState?.advancedAttempt) {
      return c.json({ error: 'No advanced attempt available' }, 404);
    }
    cancelSpeculativeVerify();
    cancelInlineEditTimer();
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
    const ckpt = await createCheckpoint(
      REPO_ROOT,
      'Applied Advanced merge improvements',
      gitIdentity,
    ).catch(() => null);
    const changes = await getGitChanges(REPO_ROOT, `origin/${BASE_BRANCH}`).catch(() => []);
    if (ckpt) {
      broadcast({
        type: 'checkpoint_created',
        checkpoint: ckpt,
        changedFilesCount: changes.length,
      });
    }
    notifySessionDiverged(changes.length);
    await persistMergeReviewState();
    scheduleIdleSpeculativeVerify();
    return c.json({ review: activeMergeState });
  });

  app.post('/internal/git/revert-start', async (c) => {
    if (readOnly) return c.json({ error: 'Read-only' }, 403);
    cancelSpeculativeVerify();
    cancelInlineEditTimer();
    activeSyncOps += 1;
    try {
      const body = (await c.req.json()) as { shas: string[] };
      const targetShas = body.shas ?? [];
      const result = await startRevertCommits(REPO_ROOT, targetShas, gitIdentity);
      if (result.status === 'conflict' && result.conflictedFiles.length > 0) {
        activeConflictPacks = new Map();
        activeVirtualTreeSha = result.virtualTreeSha;
        const records: ConflictResolutionRecordDto[] = [];
        for (const relPath of result.conflictedFiles) {
          const virtualRefs =
            result.virtualTreeSha && result.preRevertSha && result.targetParentSha && targetShas[0]
              ? {
                  baseSha: targetShas[0],
                  oursSha: result.preRevertSha,
                  theirsSha: result.targetParentSha,
                  virtualTreeSha: result.virtualTreeSha,
                }
              : undefined;
          const pack = await buildConflictEvidencePack(
            REPO_ROOT,
            relPath,
            baseSha,
            BASE_BRANCH,
            'revert',
            virtualRefs,
          );
          activeConflictPacks.set(relPath, pack);
          const det = tryDeterministicResolve(pack);
          if (det) {
            records.push(det);
          } else {
            const res = await resolvePackWithLlm(REPO_ROOT, pack, {
              controlPlaneInternalUrl: CONTROL_PLANE_INTERNAL_URL,
              workspaceToken,
              modelId: piRuntime?.getResolvedModelId() || MODEL_ID,
              thinkingLevel: THINKING_LEVEL,
              purpose: 'conflict',
            });
            records.push(res.record);
          }
        }
        const headSha = (await runLockedGit(REPO_ROOT, ['rev-parse', 'HEAD'])).stdout.trim();
        const needsChoices = records.some((r) => r.status === 'needs_choice');
        let resolvedAndCommitted = false;
        if (!needsChoices) {
          if (result.virtualTreeSha && result.targetParentSha) {
            const committed = await commitVirtualMergeResolution(REPO_ROOT, {
              virtualTreeSha: result.virtualTreeSha,
              preSyncSha: headSha,
              newBaseSha: result.targetParentSha,
              resolvedFiles: records.map((rec) => ({
                path: rec.path,
                content: rec.resolvedContent ?? '',
              })),
              identity: gitIdentity,
              commitMessage: `halley-checkpoint: Undo published edit (${targetShas.map((s) => s.slice(0, 7)).join(', ')})\n\nCo-authored-by: ${gitIdentity.editorName} <${gitIdentity.editorEmail}>`,
            });
            if (committed.ok) {
              // Convert commit to single-parent checkpoint on HEAD so history stays linear
              const treeSha = (
                await runLockedGit(REPO_ROOT, ['rev-parse', `${committed.mergeCommitSha}^{tree}`])
              ).stdout.trim();
              const linearRes = await runLockedGit(
                REPO_ROOT,
                [
                  'commit-tree',
                  treeSha,
                  '-p',
                  headSha,
                  '-m',
                  `halley-checkpoint: Undo published edit (${targetShas.map((s) => s.slice(0, 7)).join(', ')})\n\nCo-authored-by: ${gitIdentity.editorName} <${gitIdentity.editorEmail}>`,
                ],
                {
                  GIT_AUTHOR_NAME: gitIdentity.botName,
                  GIT_AUTHOR_EMAIL: gitIdentity.botEmail,
                  GIT_COMMITTER_NAME: gitIdentity.botName,
                  GIT_COMMITTER_EMAIL: gitIdentity.botEmail,
                },
              );
              const linearSha = linearRes.stdout.trim();
              if (linearRes.code === 0 && /^[0-9a-f]{40}$/i.test(linearSha)) {
                await runLockedGit(REPO_ROOT, ['update-ref', 'HEAD', linearSha]);
                result.revertCheckpointSha = linearSha;
              } else {
                result.revertCheckpointSha = committed.mergeCommitSha;
              }
              resolvedAndCommitted = true;
              activeVirtualTreeSha = undefined;
            }
          } else {
            let allApplied = true;
            for (const rec of records) {
              const applied = await applyResolvedFile(
                REPO_ROOT,
                rec.path,
                rec.resolvedContent ?? '',
              );
              if (!applied.ok) allApplied = false;
            }
            if (allApplied) {
              await runLockedGit(
                REPO_ROOT,
                [
                  '-c',
                  `user.name=${gitIdentity.botName}`,
                  '-c',
                  `user.email=${gitIdentity.botEmail}`,
                  'commit',
                  '--no-edit',
                ],
                { GIT_EDITOR: 'true' },
              );
              const newHead = (await runLockedGit(REPO_ROOT, ['rev-parse', 'HEAD'])).stdout.trim();
              if (newHead && newHead !== headSha) {
                result.revertCheckpointSha = newHead;
                resolvedAndCommitted = true;
              }
            }
          }
        }
        await pageService.syncPageRequestsFromDisk().catch(() => {});
        const changes = await getGitChanges(REPO_ROOT, `origin/${BASE_BRANCH}`).catch(() => []);
        activeMergeState = {
          mergeId: crypto.randomUUID(),
          kind: 'revert',
          status: !needsChoices && resolvedAndCommitted ? 'ready_for_review' : 'needs_choices',
          preSyncSha: headSha,
          prevBaseSha: baseSha,
          newBaseSha: result.targetParentSha || baseSha,
          summary:
            !needsChoices && resolvedAndCommitted
              ? 'Combined your undo with newer live-site updates — please review.'
              : 'Someone updated these pages after your publication — choose what to keep.',
          records,
          upstreamCommits: [],
          touchedUserFiles: result.conflictedFiles,
        };
        await persistMergeReviewState();
        return c.json({ ...result, changedFilesCount: changes.length, review: activeMergeState });
      }
      await pageService.syncPageRequestsFromDisk().catch(() => {});
      const changes = await getGitChanges(REPO_ROOT, `origin/${BASE_BRANCH}`).catch(() => []);
      return c.json({ ...result, changedFilesCount: changes.length });
    } finally {
      activeSyncOps = Math.max(0, activeSyncOps - 1);
    }
  });

  app.get('/internal/review', async (c) => {
    const baseRef = c.req.query('baseRef') || `origin/${BASE_BRANCH}`;
    const activeRoute = c.req.query('activeRoute') || null;
    const changes = await getGitChanges(REPO_ROOT, baseRef);
    const cards = await buildChangeCards(REPO_ROOT, changes, {
      baseRef,
      prevBaseSha: prevBaseSha || null,
      editorName: gitIdentity.editorName,
      conflictRecords: activeMergeState?.records,
    });
    const targetRoutes = resolveVisualReviewRoutes(cards, activeRoute);
    const mergedFromLiveFiles =
      prevBaseSha && baseSha && prevBaseSha !== baseSha
        ? (await runLockedGit(REPO_ROOT, ['diff', '--name-only', `${prevBaseSha}..${baseSha}`]))
            .stdout
            .split(/\r?\n/)
            .filter(Boolean)
        : [];

    const liveSiteUrl = await detectAstroSiteUrl(REPO_ROOT);

    return c.json({
      cards,
      pages: [],
      targetRoutes,
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

  app.post('/internal/verify/speculative', (c) => {
    if (readOnly) return c.json({ ok: false, reason: 'read-only' });
    triggerImmediateSpeculativeVerify();
    return c.json({ ok: true });
  });

  app.post('/internal/verify', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { pausePreview?: boolean };
    // Never need to pause live astro dev when isolated verify-sandbox is active
    const shouldPause = Boolean(body.pausePreview) && !process.env.HALLEY_VERIFY_SANDBOX_DIR;
    if (shouldPause) {
      currentPreviewPaused = true;
      currentPreviewPauseReason = 'Running pre-publish checks…';
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
        hostSecret: activeHostSecret || undefined,
        sessionId: SESSION_ID,
        priority: 'foreground',
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
        currentPreviewPaused = false;
        currentPreviewPauseReason = undefined;
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

  app.post('/internal/optimize/start', async (c) => {
    if (readOnly) return c.json({ error: 'Read-only' }, 403);
    cancelSpeculativeVerify();
    const body = (await c.req.json().catch(() => ({}))) as {
      findings?: OptimizationFindingDto[];
      modelId?: string;
      defaultModelId?: string;
      thinkingLevel?: 'off' | 'low' | 'medium' | 'high';
    };
    const findings = body.findings ?? [];

    const prePass = await runDeterministicOptimizationPrePass(REPO_ROOT, findings, gitIdentity);
    if (prePass.checkpoint) {
      const changes = await getGitChanges(REPO_ROOT, `origin/${BASE_BRANCH}`).catch(() => []);
      broadcast({
        type: 'checkpoint_created',
        checkpoint: prePass.checkpoint,
        changedFilesCount: changes.length,
      });
      notifySessionDiverged();
    }

    if (prePass.agentFindings.length > 0 && piRuntime) {
      const promptText = buildOptimizationPrompt({
        agentFindings: prePass.agentFindings,
        completedDeterministic: prePass.completedSummaries,
      });
      await piRuntime.submitOptimizationRequest(promptText, {
        modelId: body.modelId || MODEL_ID,
        defaultModelId: body.defaultModelId || MODEL_ID,
        thinkingLevel: body.thinkingLevel,
        defaultThinkingLevel: THINKING_LEVEL,
        onSettled: () => notifyOptimizationSettled(),
      });
    } else {
      await notifyOptimizationSettled();
      if (prePass.completedSummaries.length > 0) {
        scheduleIdleSpeculativeVerify(1_000);
      }
    }

    return c.json({
      ok: true,
      completedDeterministic: prePass.completedSummaries,
      agentRefactorCount: prePass.agentFindings.length,
      checkpoint: prePass.checkpoint,
    });
  });

  app.post('/internal/prompt', async (c) => {
    if (readOnly) return c.json({ error: 'Read-only' }, 403);
    const body = ChatClientMessageSchema.parse(await c.req.json());
    if (body.type === 'submit_input') {
      cancelSpeculativeVerify();
      await piRuntime?.submitUserInput(body);
    } else if (body.type === 'abort') {
      await piRuntime?.abort();
    } else if (body.type === 'continue_run') {
      cancelSpeculativeVerify();
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

  const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
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
    ws.send(
      JSON.stringify({
        type: 'session_state_sync',
        workspaceLocked: currentWorkspaceLocked,
        lockedFile: currentLockedFile,
        previewPaused: currentPreviewPaused,
        previewPauseReason: currentPreviewPauseReason,
        astroReady: astroManager.getStatus().ready,
        mergeReview: activeMergeState,
      } satisfies ChatServerMessage),
    );
    ws.on('message', async (raw) => {
      if (readOnly) {
        ws.send(JSON.stringify({ type: 'error', message: 'Session is read-only' }));
        return;
      }
      try {
        const parsed = ChatClientMessageSchema.parse(JSON.parse(raw.toString('utf8')));
        if (parsed.type === 'submit_input') {
          cancelSpeculativeVerify();
          await piRuntime?.submitUserInput(parsed);
        } else if (parsed.type === 'abort') {
          await piRuntime?.abort();
        } else if (parsed.type === 'continue_run') {
          cancelSpeculativeVerify();
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

  console.log(
    `[halley-workspace-runner] session=${SESSION_ID} runner=:${RUNNER_PORT} astro=:${ASTRO_PORT}${previewBase}`,
  );
}

main().catch((err) => {
  console.error('[halley-workspace-runner] Fatal error:', err);
  process.exit(1);
});
