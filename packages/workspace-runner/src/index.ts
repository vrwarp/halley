import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverSiteRoutes, PerFileMutex } from '@halley/astro-dev-edit';
import { type ChatServerMessage, type MergeReviewStateDto } from '@halley/shared';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { WebSocketServer, type WebSocket } from 'ws';
import { AstroDevManager, computePreviewBase, detectAstroBase, type AstroDevManagerOptions } from './astro-manager.js';
import {
  configureGitClock,
  createCheckpoint,
  getGitChanges,
  recoverInterruptedSync,
  runLockedGit,
  type GitIdentity,
} from './checkpoints-and-git.js';
import { type ConflictEvidencePack } from './conflict-protocol.js';
import { realClock, type Clock, type TimerHandle } from './clock.js';
import { writeFileAtomic } from './fs-util.js';
import { AsyncMutex } from './mutex.js';
import {
  errCode,
  ignore,
  ignoreCodes,
  ignoreExpected,
  logger,
  readJsonBodyOrEmpty,
  requestContextMiddleware,
} from './log.js';
import { NodeModulesCacheManager } from './nm-cache.js';
import { PageCreationService } from './pages.js';
import { HalleyPiRuntime, type PiRuntimeOptions } from './pi-runtime.js';
import { RUNNER_PROTOCOL_HEADER, RUNNER_PROTOCOL_VERSION } from './runner-protocol.js';
import { registerEditorRoutes } from './routes/editor.js';
import { registerSessionRoutes } from './routes/session.js';
import { registerPagesRoutes } from './routes/pages.js';
import { registerGitRoutes } from './routes/git.js';
import { registerSyncRoutes } from './routes/sync.js';
import { registerVerifyRoutes } from './routes/verify.js';
import { registerUploadsRoutes } from './routes/uploads.js';
import { registerAgentRoutes } from './routes/agent.js';
import type { RunnerContext } from './runner-context.js';
import { createRunnerWs } from './ws.js';
import { UploadManager } from './uploads.js';
import { setProcessRunner, type ProcessRunner, onParentDeath } from './proc.js';
import {
  configureVerification,
  invalidateSpeculativeVerification,
  killActiveShellGroups,
  runSpeculativeVerification,
} from './verify.js';

export { RUNNER_PROTOCOL_HEADER, RUNNER_PROTOCOL_VERSION } from './runner-protocol.js';

export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high';

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

/** Everything the runner reads from its environment, parsed once (see `loadRunnerConfig`). */
export interface RunnerConfig {
  repoRoot: string;
  stateDir: string;
  sessionId: string;
  baseBranch: string;
  baseSha: string;
  runnerPort: number;
  astroPort: number;
  /** Bind address of the HTTP server (default 0.0.0.0). */
  hostname: string;
  controlPlaneInternalUrl: string;
  supervisorUrl: string;
  hostSecret: string;
  workspaceToken: string;
  explicitPersona?: string;
  explicitEditorName?: string;
  explicitEditorEmail?: string;
  explicitReadOnly?: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
  gitBotName: string;
  gitBotEmail: string;
  speculativeIdleMs: number;
  inlineCheckpointDebounceMs: number;
  shutdownBudgetMs: number;
  maxUploadBytes: number;
  nmCacheDir: string;
  pkgCacheDir: string;
  mirrorPath: string;
  devLocalRepo?: string;
  /** Verification runs in an isolated sandbox (no need to pause the live preview). */
  verifySandbox: boolean;
  wsHeartbeatMs: number;
  wsMaxBufferedBytes: number;
  wsMaxQueuedMessages: number;
  /** Start the HTTP + WebSocket server (false: tests drive `app.fetch` / `wsHandlers` directly). */
  listen: boolean;
}

/** Pure: parses the runner environment. The entry point scrubs the secrets from process.env after. */
export function loadRunnerConfig(env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  const stateDir = env.HALLEY_STATE_DIR || '/halley-state';
  const workspacesRoot = path.dirname(path.dirname(stateDir));
  return {
    repoRoot: env.HALLEY_WORKSPACE_DIR || '/workspace',
    stateDir,
    sessionId: env.HALLEY_SESSION_ID || 'local',
    baseBranch: env.HALLEY_BASE_BRANCH || 'main',
    baseSha: env.HALLEY_BASE_SHA || '',
    runnerPort: Number(env.RUNNER_PORT || 4100),
    astroPort: Number(env.ASTRO_PORT || 4321),
    hostname: env.RUNNER_BIND_HOST || '0.0.0.0',
    controlPlaneInternalUrl: env.CONTROL_PLANE_INTERNAL_URL || 'http://127.0.0.1:3000',
    supervisorUrl: env.HALLEY_SUPERVISOR_URL || '',
    hostSecret: env.WORKSPACE_HOST_SECRET || '',
    workspaceToken: env.WORKSPACE_TOKEN || 'dev-token',
    explicitPersona: env.HALLEY_PERSONA,
    explicitEditorName: env.HALLEY_EDITOR_NAME,
    explicitEditorEmail: env.HALLEY_EDITOR_EMAIL,
    explicitReadOnly: env.HALLEY_READ_ONLY,
    modelId: env.HALLEY_MODEL_ID || 'haiku-latest',
    thinkingLevel: (env.HALLEY_THINKING_LEVEL || 'high') as ThinkingLevel,
    gitBotName: env.HALLEY_GIT_BOT_NAME || 'Halley Bot',
    gitBotEmail: env.HALLEY_GIT_BOT_EMAIL || 'halley-bot@users.noreply.github.com',
    speculativeIdleMs: Number(env.HALLEY_SPECULATIVE_IDLE_MS || 15_000),
    inlineCheckpointDebounceMs: Number(env.HALLEY_INLINE_CHECKPOINT_DEBOUNCE_MS || 1_500),
    // Must stay below the supervisor's SIGTERM->SIGKILL grace (HALLEY_RUNNER_STOP_GRACE_MS, 5s).
    shutdownBudgetMs: Number(env.HALLEY_RUNNER_SHUTDOWN_BUDGET_MS || 4_000),
    maxUploadBytes: Number(env.HALLEY_MAX_UPLOAD_MB || 25) * 1024 * 1024,
    nmCacheDir: env.HALLEY_NM_CACHE_DIR || path.join(workspacesRoot, 'nm-cache'),
    pkgCacheDir: env.HALLEY_PKG_CACHE_DIR || path.join(workspacesRoot, 'pkg-cache'),
    mirrorPath: env.HALLEY_MIRROR_PATH || '/halley-mirror/repo.git',
    devLocalRepo: env.HALLEY_DEV_LOCAL_REPO || undefined,
    verifySandbox: Boolean(env.HALLEY_VERIFY_SANDBOX_DIR),
    wsHeartbeatMs: Number(env.HALLEY_WS_HEARTBEAT_MS || 20_000),
    wsMaxBufferedBytes: Number(env.HALLEY_WS_MAX_BUFFERED_BYTES || 4 * 1024 * 1024),
    wsMaxQueuedMessages: Number(env.HALLEY_WS_MAX_QUEUED_MESSAGES || 500),
    listen: true,
  };
}

/** The subset of `HalleyPiRuntime` the runner uses; tests inject a fake. */
export type PiRuntimeLike = Pick<
  HalleyPiRuntime,
  | 'start'
  | 'stop'
  | 'isBusy'
  | 'reloadAgentsMd'
  | 'addSystemContextNote'
  | 'getResolvedModelId'
  | 'submitPageCreationRequest'
  | 'submitUserInput'
  | 'submitOptimizationRequest'
  | 'abort'
  | 'continueRun'
  | 'getDebugTrace'
  | 'resolveModelAlias'
>;

/** The subset of `AstroDevManager` the runner uses; tests inject a fake. */
export type AstroManagerLike = Pick<
  AstroDevManager,
  'start' | 'stop' | 'pause' | 'resume' | 'restart' | 'getStatus'
>;

export interface RunnerDeps {
  /** Drives the runner's timers and the repo's verification runs (shell timeouts, backoffs). */
  clock?: Clock;
  /**
   * Child-process seam (git, npm/pnpm, build shells, astro). Installed process-wide for the
   * runner's lifetime and restored on shutdown; omit for real processes.
   */
  processRunner?: ProcessRunner;
  randomUUID?: () => string;
  createPiRuntime?: (opts: PiRuntimeOptions) => PiRuntimeLike;
  createAstroManager?: (opts: AstroDevManagerOptions) => AstroManagerLike;
  /** Receives the handle before boot completes (so a SIGTERM during boot can still shut down cleanly). */
  onCreated?: (handle: RunnerHandle) => void;
}

/** Per-socket delivery state for ordering, heartbeat and backpressure. */
export interface WsClientState {
  missedPongs: number;
  /** Ordered events waiting for `bufferedAmount` to drain (never dropped; bounded). */
  queue: string[];
  /** Latest transcript_state held back by backpressure (latest-wins). */
  pendingTranscript: string | null;
  /** Last `seq` sent on this connection (per-connection counter; see WebSocket delivery). */
  seq: number;
}

export interface RunnerWsHandlers {
  /** Attaches a connected socket (sends the snapshot, wires message/pong/close handlers). */
  handleConnection: (ws: WebSocket) => void;
  /** Runs one heartbeat round (ping all; terminate sockets that missed 2 pongs). */
  heartbeat: () => void;
  clientCount: () => number;
  /** Highest number of consecutive unanswered pings across open clients (0 when all answered). */
  maxMissedPongs: () => number;
  /** Current WS ordering state. */
  sequence: () => { epoch: string; seq: number };
}

export interface RunnerHandle {
  app: Hono;
  server?: ReturnType<typeof serve>;
  wss: WebSocketServer;
  wsHandlers: RunnerWsHandlers;
  /** Stops timers, astro dev and the Pi runtime (bounded by `shutdownBudgetMs`). Never exits the process. */
  shutdown: () => Promise<void>;
  /** Resolves once astro dev + Pi are started (createRunner already awaited it). */
  ready: Promise<void>;
  bootTimings: Record<string, number>;
}

/**
 * Builds a workspace runner. Importing this module has no side effects; the process entry point
 * at the bottom calls `createRunner(loadRunnerConfig())` only when run as the main module.
 */
export async function createRunner(config: RunnerConfig, deps: RunnerDeps = {}): Promise<RunnerHandle> {
  const clock = deps.clock ?? realClock;
  const restoreProcessRunner = deps.processRunner ? setProcessRunner(deps.processRunner) : null;
  const restoreVerifyClock = configureVerification(config.repoRoot, { clock });
  const restoreGitClock = configureGitClock(clock);
  const randomUUID = deps.randomUUID ?? (() => crypto.randomUUID());
  const REPO_ROOT = config.repoRoot;
  const STATE_DIR = config.stateDir;
  const SESSION_ID = config.sessionId;
  const BASE_BRANCH = config.baseBranch;
  let baseSha = config.baseSha;
  const RUNNER_PORT = config.runnerPort;
  const ASTRO_PORT = config.astroPort;
  const CONTROL_PLANE_INTERNAL_URL = config.controlPlaneInternalUrl;
  const SUPERVISOR_URL = config.supervisorUrl;
  let activeHostSecret = config.hostSecret;
  let workspaceToken = config.workspaceToken;
  const explicitEnvPersona = config.explicitPersona;
  const explicitEnvEditorName = config.explicitEditorName;
  const explicitEnvEditorEmail = config.explicitEditorEmail;
  const explicitEnvReadOnly = config.explicitReadOnly;
  const MODEL_ID = config.modelId;
  const THINKING_LEVEL = config.thinkingLevel;
  let persona: 'non-technical' | 'developer' =
    explicitEnvPersona === 'developer' ? 'developer' : 'non-technical';
  let readOnly = explicitEnvReadOnly === 'true';
  let prevBaseSha = '';

  const gitIdentity: GitIdentity = {
    botName: config.gitBotName,
    botEmail: config.gitBotEmail,
    editorName: explicitEnvEditorName || 'Halley Editor',
    editorEmail: explicitEnvEditorEmail || 'editor@example.com',
  };

  const SESSION_META_PATH = path.join(STATE_DIR, 'session-meta.json');
  const MERGE_REVIEW_STATE_PATH = path.join(STATE_DIR, 'merge-review.json');

  async function loadPersistedSessionMeta(): Promise<void> {
    let raw: string;
    try {
      raw = await fs.readFile(SESSION_META_PATH, 'utf8');
    } catch (err) {
      ignoreCodes(err, ['ENOENT'], 'runner: read persisted session meta (none yet)');
      return;
    }
    let meta: PersistedSessionMeta;
    try {
      meta = JSON.parse(raw) as PersistedSessionMeta;
    } catch (err) {
      // env from the control plane is authoritative anyway; the file is rewritten on boot
      logger.error('runner: persisted session meta is corrupt; ignoring it', { err, path: SESSION_META_PATH });
      return;
    }
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
    await writeFileAtomic(SESSION_META_PATH, JSON.stringify(meta, null, 2), { durable: true });
  }

  /** Persists session meta; failures are logged (state is re-sent by the control plane on wake). */
  const saveMetaLogged = (context: string) =>
    savePersistedSessionMeta().catch((err) =>
      logger.error('runner: failed to persist session meta', { err, context }),
    );

  /** getGitChanges for best-effort counts in responses/broadcasts: an error is logged, never thrown. */
  const changesOrEmpty = (baseRef = `origin/${BASE_BRANCH}`) =>
    getGitChanges(REPO_ROOT, baseRef).catch((err) => {
      ignore(err, 'runner: list git changes for change count', { baseRef });
      return [] as Awaited<ReturnType<typeof getGitChanges>>;
    });

  /** Current HEAD commit sha, or null (unborn HEAD / git failure, logged). */
  const resolveHeadSha = async (): Promise<string | null> => {
    const res = await runLockedGit(REPO_ROOT, ['rev-parse', '--verify', '-q', 'HEAD']);
    const sha = res.stdout.trim();
    if (res.code === 0 && /^[0-9a-f]{40,64}$/i.test(sha)) return sha;
    ignore(res.stderr || 'no HEAD', 'runner: resolve HEAD sha');
    return null;
  };

  const syncPageRequestsLogged = (context: string) =>
    pageService
      .syncPageRequestsFromDisk()
      .catch((err) => ignore(err, 'runner: sync page requests from disk', { context }));

  // Single OS-process PerFileMutex shared across inline `/__editor/patch`, Pi `edit`/`write`/`bash`, and `PageCreationService`
  const fileLock = new PerFileMutex();
  const uploadManager = new UploadManager(path.join(STATE_DIR, 'uploads'));

  // ---------------------------------------------------------------------------------------------
  // WebSocket delivery: ordering (`epoch` + `seq`), heartbeat and backpressure.
  //
  // Every server->client frame carries `epoch` (random per runner boot) and `seq`: a monotonic
  // counter PER CONNECTION, stamped at the moment the frame is written to that socket, so each
  // client sees 1, 2, 3, ... with no gaps unless a frame was really lost. (A single global counter
  // made one tab's unicast frames look like gaps to every other tab, causing needless resyncs.)
  // A client seeing `seq > last + 1` or a new `epoch` resyncs.
  // ---------------------------------------------------------------------------------------------
  const wsEpoch = randomUUID();
  const wsClients = new Map<WebSocket, WsClientState>();
  let latestTranscript: Extract<ChatServerMessage, { type: 'transcript_state' }> | null = null;
  let currentWorkspaceLocked = false;
  let currentLockedFile: string | undefined;
  let currentPreviewPaused = false;
  let currentPreviewPauseReason: string | undefined;

  /** Appends the ordering fields to an already-serialized JSON object (avoids re-stringifying large transcripts). */
  function withSeq(payload: string, seq: number): string {
    const close = payload.lastIndexOf('}');
    if (close === -1) return payload;
    const body = payload.slice(0, close).trimEnd();
    const sep = body.endsWith('{') ? '' : ',';
    return `${body}${sep}"seq":${seq},"epoch":${JSON.stringify(wsEpoch)}}`;
  }

  function rawSend(ws: WebSocket, unstamped: string): void {
    const state = wsClients.get(ws);
    if (!state) return;
    const payload = withSeq(unstamped, ++state.seq);
    try {
      ws.send(payload, (err) => {
        if (err) ignoreExpected(err, 'ws: send failed (socket closing)');
        else if (wsClients.get(ws)) flushClient(ws);
      });
    } catch (err) {
      ignore(err, 'ws: send threw');
    }
  }

  function closeForBackpressure(ws: WebSocket, state: WsClientState): void {
    logger.warn('ws: client too slow; closing so it resyncs', {
      queued: state.queue.length,
      bufferedAmount: ws.bufferedAmount,
    });
    wsClients.delete(ws);
    try {
      ws.close(1013, 'Backpressure: resync required');
    } catch (err) {
      ignore(err, 'ws: close slow client');
      ws.terminate();
    }
  }

  /** Delivers queued events (in order), then a held-back transcript, while the socket has room. */
  function flushClient(ws: WebSocket): void {
    const state = wsClients.get(ws);
    if (!state || ws.readyState !== ws.OPEN) return;
    while (state.queue.length > 0 && ws.bufferedAmount <= config.wsMaxBufferedBytes) {
      rawSend(ws, state.queue.shift()!);
    }
    if (state.queue.length === 0 && state.pendingTranscript && ws.bufferedAmount <= config.wsMaxBufferedBytes) {
      const t = state.pendingTranscript;
      state.pendingTranscript = null;
      rawSend(ws, t);
    }
    if (state.queue.length > 0 || state.pendingTranscript) scheduleFlush();
  }

  let flushTimer: TimerHandle | null = null;
  function scheduleFlush(): void {
    if (flushTimer) return;
    flushTimer = clock.setTimeout(() => {
      flushTimer = null;
      for (const ws of wsClients.keys()) flushClient(ws);
    }, 100);
    flushTimer.unref?.();
  }

  /** Sends one message to one client. `kind: 'state'` may be coalesced; events are queued, never dropped. */
  function deliver(ws: WebSocket, payload: string, kind: 'event' | 'state' | 'transcript'): void {
    const state = wsClients.get(ws);
    if (!state || ws.readyState !== ws.OPEN) return;
    const congested = ws.bufferedAmount > config.wsMaxBufferedBytes;
    if (kind === 'transcript') {
      if (congested || state.queue.length > 0) {
        state.pendingTranscript = payload; // latest wins; seq is stamped when actually sent
        scheduleFlush();
        return;
      }
      rawSend(ws, payload);
      return;
    }
    if (congested || state.queue.length > 0) {
      state.queue.push(payload);
      if (state.queue.length > config.wsMaxQueuedMessages) {
        closeForBackpressure(ws, state);
        return;
      }
      scheduleFlush();
      return;
    }
    rawSend(ws, payload);
  }

  /** Unicast to one client (snapshot, errors). */
  function safeSend(ws: WebSocket, payload: string): void {
    deliver(ws, payload, 'state');
  }

  function broadcastRaw(payload: string): void {
    for (const ws of wsClients.keys()) deliver(ws, payload, 'event');
  }

  function broadcastTranscript(payload: string): void {
    for (const ws of wsClients.keys()) deliver(ws, payload, 'transcript');
  }

  function broadcast(msg: ChatServerMessage): void {
    broadcastRaw(JSON.stringify(msg));
  }

  /** Tells connected clients that a background checkpoint failed instead of failing silently (W3). */
  function reportCheckpointFailure(context: string, err: unknown): void {
    logger.error(`checkpoint failed: ${context}`, { err });
    broadcast({
      type: 'error',
      message: `Halley could not save a checkpoint of your latest changes (${context}). Your edits are still on disk; we will retry on the next change. ${err instanceof Error ? err.message : ''}`.trim(),
    });
  }

  let lastTranscriptPayload = '';

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
      signal: clock.timeoutSignal(5000),
    }).catch((err) =>
      // the control plane re-derives divergence on its next poll; this is only a fast path
      ignoreExpected(err, 'runner: notify control plane of divergence'),
    );
  }

  async function notifyOptimizationSettled(): Promise<void> {
    if (!CONTROL_PLANE_INTERNAL_URL || !workspaceToken) return;
    const endpoint = `${CONTROL_PLANE_INTERNAL_URL.replace(/\/$/, '')}/internal/session/optimization-settled`;
    await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${workspaceToken}`,
      },
      signal: clock.timeoutSignal(5000),
    }).catch((err) => ignore(err, 'runner: notify control plane that optimization settled'));
  }

  const IDLE_SPECULATIVE_DELAY_MS = config.speculativeIdleMs;
  let idleSpeculativeTimer: TimerHandle | null = null;

  function cancelSpeculativeVerify(): void {
    if (idleSpeculativeTimer) {
      clock.clearTimeout(idleSpeculativeTimer);
      idleSpeculativeTimer = null;
    }
    invalidateSpeculativeVerification(REPO_ROOT);
  }

  function triggerImmediateSpeculativeVerify(): void {
    if (idleSpeculativeTimer) {
      clock.clearTimeout(idleSpeculativeTimer);
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
    idleSpeculativeTimer = clock.setTimeout(async () => {
      idleSpeculativeTimer = null;
      if (shuttingDown || readOnly || piRuntime?.isBusy() || inlineEditTimer) return;
      try {
        const changes = await getGitChanges(REPO_ROOT, `origin/${BASE_BRANCH}`);
        if (changes.length === 0) return;
      } catch (err) {
        ignore(err, 'runner: list changes before idle speculative verify');
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

  let inlineEditTimer: TimerHandle | null = null;
  /** Debounced inline checkpoint currently being written (busy for LRU eviction). */
  let inlineCheckpointInFlight: Promise<void> | null = null;
  /** Foreground `/internal/verify` runs in progress (busy for LRU eviction). */
  let activeVerifyRuns = 0;
  function cancelInlineEditTimer(): void {
    if (inlineEditTimer) {
      clock.clearTimeout(inlineEditTimer);
      inlineEditTimer = null;
    }
  }
  function scheduleInlineCheckpoint(summary: string): void {
    cancelSpeculativeVerify();
    cancelInlineEditTimer();
    inlineEditTimer = clock.setTimeout(() => {
      inlineEditTimer = null;
      const run = (async () => {
        try {
          const ckpt = await createCheckpoint(REPO_ROOT, summary, gitIdentity);
          if (ckpt) {
            const changes = await changesOrEmpty();
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
        } catch (err) {
          reportCheckpointFailure('inline edit', err);
        }
      })();
      inlineCheckpointInFlight = run;
      void run.finally(() => {
        if (inlineCheckpointInFlight === run) inlineCheckpointInFlight = null;
      });
    }, config.inlineCheckpointDebounceMs);
    inlineEditTimer.unref?.();
  }

  const astroOptions: AstroDevManagerOptions = {
    repoRoot: REPO_ROOT,
    stateDir: STATE_DIR,
    sessionId: SESSION_ID,
    astroPort: ASTRO_PORT,
    runnerPort: RUNNER_PORT,
    isReadOnly: () => readOnly,
    onPatched: ({ file }) => {
      scheduleInlineCheckpoint(`Inline edit in ${file}`);
    },
    clock,
  };
  const astroManager: AstroManagerLike = deps.createAstroManager
    ? deps.createAstroManager(astroOptions)
    : new AstroDevManager(astroOptions);

  let piRuntime: PiRuntimeLike | null = null;

  let shuttingDown = false;
  const SHUTDOWN_BUDGET_MS = config.shutdownBudgetMs;
  let wsHeartbeatTimer: TimerHandle | null = null;
  // eslint-disable-next-line prefer-const
  let closeServer: () => void = () => undefined;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    cancelSpeculativeVerify();
    cancelInlineEditTimer();
    if (wsHeartbeatTimer) clock.clearTimeout(wsHeartbeatTimer);
    if (flushTimer) clock.clearTimeout(flushTimer);
    killActiveShellGroups('SIGTERM');
    let budgetTimer: TimerHandle | null = null;
    const budget = new Promise<void>((resolve) => {
      budgetTimer = clock.setTimeout(() => {
        logger.warn('runner shutdown budget exceeded; exiting', { budgetMs: SHUTDOWN_BUDGET_MS });
        resolve();
      }, SHUTDOWN_BUDGET_MS);
      budgetTimer.unref?.();
    });
    // astro dev and the Pi harness stop in parallel, bounded by the budget
    await Promise.race([
      Promise.allSettled([
        astroManager.stop().catch((e) => ignore(e, 'shutdown: stop astro dev')),
        piRuntime?.stop().catch((e) => ignore(e, 'shutdown: stop pi runtime')),
      ]),
      budget,
    ]);
    clock.clearTimeout(budgetTimer);
    killActiveShellGroups('SIGKILL');
    for (const ws of wsClients.keys()) ws.terminate();
    wsClients.clear();
    closeServer();
    restoreVerifyClock();
    restoreGitClock();
    restoreProcessRunner?.();
  };

  // ---------------------------------------------------------------------------------------------
  // Boot (part 1, before the HTTP server listens): persisted state + crash recovery.
  // ---------------------------------------------------------------------------------------------
  const bootTimings: Record<string, number> = {};
  const bootT0 = clock.now();
  const timed = async <T>(phase: string, fn: () => Promise<T>): Promise<T> => {
    const t = clock.now();
    try {
      return await fn();
    } finally {
      bootTimings[phase] = clock.now() - t;
    }
  };
  let booted = false;
  let bootFailed: unknown = null;

  await loadPersistedSessionMeta();
  // W4: finish (or discard) a sync merge interrupted by a crash before anything can checkpoint
  try {
    const recovery = await timed('syncRecovery', () => recoverInterruptedSync(REPO_ROOT));
    if (recovery.action === 'completed' && recovery.intent?.kind === 'sync' && recovery.intent.newBaseSha) {
      if (recovery.intent.prevBaseSha) prevBaseSha = recovery.intent.prevBaseSha;
      baseSha = recovery.intent.newBaseSha;
    }
    if (recovery.action !== 'none') {
      logger.warn('runner: recovered interrupted sync on startup', { recovery });
    }
  } catch (err) {
    logger.error('runner: interrupted sync recovery failed on startup', { err });
  }
  // Persist authoritative env metadata immediately so disk matches control-plane SQLite
  await saveMetaLogged('boot');

  // Same derivation astro-manager uses for its wrapper config; refreshed from astroManager.start()
  let originalBase = await detectAstroBase(REPO_ROOT);
  let previewBase = computePreviewBase(SESSION_ID, originalBase);

  const pageService = new PageCreationService({
    repoRoot: REPO_ROOT,
    stateDir: STATE_DIR,
    baseBranch: BASE_BRANCH,
    gitIdentity,
    fileLock,
    getAstroPort: () => ASTRO_PORT,
    getPreviewBase: () => previewBase,
    clock,
    onBroadcast: (msg) => {
      broadcast(msg);
      if (msg.type === 'checkpoint_created') {
        notifySessionDiverged();
      }
    },
  });

  const piOptions = (): PiRuntimeOptions => ({
    clock,
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
      let ckpt: Awaited<ReturnType<typeof createCheckpoint>> = null;
      try {
        ckpt = await createCheckpoint(REPO_ROOT, summary, gitIdentity);
      } catch (err) {
        reportCheckpointFailure('AI edit', err);
        return;
      }
      if (ckpt) {
        const changes = await changesOrEmpty();
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
      // W8: identical consecutive states (e.g. a tick that only touched internal docs) are not resent
      const payload = JSON.stringify(latestTranscript);
      if (payload === lastTranscriptPayload) return;
      lastTranscriptPayload = payload;
      broadcastTranscript(payload);
    },
  });

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
      await writeFileAtomic(MERGE_REVIEW_STATE_PATH, JSON.stringify(payload, null, 2), { durable: true });
    } catch (err) {
      // Non-fatal for the request, but a lost review state means conflict choices vanish on wake
      logger.error('failed to persist merge review state', { err, path: MERGE_REVIEW_STATE_PATH });
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
  } catch (err) {
    // ENOENT: no persisted merge state; corrupt JSON is logged (the review must be restarted)
    if (errCode(err) === 'ENOENT') ignoreExpected(err, 'runner: no persisted merge review state');
    else logger.error('runner: persisted merge review state is unreadable', { err, path: MERGE_REVIEW_STATE_PATH });
  }

  const runnerNmCache = new NodeModulesCacheManager(config.nmCacheDir, config.pkgCacheDir, 2);

  const app = new Hono();

  app.onError((err, c) => {
    logger.error('runner: request failed', { err, method: c.req.method, path: c.req.path });
    return c.json({ error: err instanceof Error ? err.message : 'Internal error' }, 500);
  });

  app.use('*', requestContextMiddleware());

  // Every runner response carries the protocol version so the supervisor/control plane can detect skew
  app.use('*', async (c, next) => {
    await next();
    c.header(RUNNER_PROTOCOL_HEADER, String(RUNNER_PROTOCOL_VERSION));
  });

  // Until astro dev + Pi are up only health endpoints answer (the server listens early so the
  // supervisor sees boot progress instead of connection refusals).
  app.use('*', async (c, next) => {
    if (booted) return next();
    const pathname = new URL(c.req.url).pathname;
    if (pathname === '/health' || pathname.endsWith('/__editor/health')) return next();
    return c.json(
      {
        error: bootFailed ? 'Workspace failed to start' : 'Workspace is still starting',
        booting: !bootFailed,
      },
      503,
    );
  });

  const isRunnerBusy = (): boolean =>
    (piRuntime?.isBusy() ?? false) ||
    activeSyncOps > 0 ||
    activeMergeState?.status === 'needs_choices' ||
    // W-LRU: a debounced inline edit not yet checkpointed, a checkpoint being written, or a
    // foreground verify must not be killed by LRU eviction
    inlineEditTimer !== null ||
    inlineCheckpointInFlight !== null ||
    activeVerifyRuns > 0;

  // LRU eviction handshake: the supervisor asks to drain right before SIGTERM. Draining is granted
  // only when idle and makes the runner refuse new work, so nothing can start in between.
  let draining = false;
  let drainTimer: TimerHandle | null = null;
  app.post('/internal/drain', async (c) => {
    const body = (await readJsonBodyOrEmpty(c)) as { cancel?: boolean };
    if (drainTimer) clock.clearTimeout(drainTimer);
    drainTimer = null;
    if (body.cancel) {
      draining = false;
      return c.json({ ok: true, drained: false });
    }
    if (isRunnerBusy()) {
      draining = false;
      return c.json({ ok: true, drained: false, busy: true });
    }
    draining = true;
    // Self-heal if the stop never comes (supervisor crashed mid-eviction)
    drainTimer = clock.setTimeout(() => {
      draining = false;
      drainTimer = null;
    }, 30_000);
    drainTimer.unref?.();
    return c.json({ ok: true, drained: true });
  });
  app.use('*', async (c, next) => {
    if (!draining || c.req.method === 'GET' || c.req.method === 'HEAD') return next();
    return c.json({ error: 'Workspace is going to sleep; reconnect to wake it.', draining: true }, 503);
  });

  /**
   * Every endpoint that rewrites the working tree / HEAD runs through ONE async mutex (FIFO), so an
   * undo can never interleave with a sync merge, a revert or a partial-undo exclusion. All of them
   * refuse with the same 409 while the agent is mid-turn (it edits the same files), checked again
   * once the mutex is acquired. `restore-sha` is exempt from the busy check: it is publish's
   * rollback of its own exclude-paths commit and must always be able to run (it auto-saves first).
   */
  const TREE_MUTATING_ROUTES = new Set([
    '/internal/git/revert-file',
    '/internal/git/exclude-paths',
    '/internal/git/restore-sha',
    '/internal/git/undo',
    '/internal/git/revert-start',
    '/internal/sync/start',
    '/internal/sync/choose',
    '/internal/sync/undo',
    '/internal/sync/escalate',
    '/internal/sync/apply-advanced',
  ]);
  const PI_BUSY_EXEMPT_ROUTES = new Set(['/internal/git/restore-sha']);
  const PI_BUSY_MESSAGE = 'Pi is currently editing; try again once it finishes.';
  const treeMutex = new AsyncMutex();
  app.use('/internal/*', async (c, next) => {
    if (c.req.method !== 'POST' || !TREE_MUTATING_ROUTES.has(c.req.path)) return next();
    const piBlocks = () => !PI_BUSY_EXEMPT_ROUTES.has(c.req.path) && (piRuntime?.isBusy() ?? false);
    if (piBlocks()) return c.json({ error: PI_BUSY_MESSAGE, piBusy: true }, 409);
    activeSyncOps += 1; // queued + running tree operations count as busy (LRU drain)
    try {
      let refused: Response | undefined;
      await treeMutex.run(async () => {
        if (piBlocks()) {
          refused = c.json({ error: PI_BUSY_MESSAGE, piBusy: true }, 409);
          return;
        }
        await next();
      });
      if (refused) return refused;
    } finally {
      activeSyncOps = Math.max(0, activeSyncOps - 1);
    }
  });

  app.get('/health', (c) => {
    const astro = astroManager.getStatus();
    const piBusy = piRuntime?.isBusy() ?? false;
    const busy = isRunnerBusy();
    return c.json({
      ok: true,
      protocolVersion: RUNNER_PROTOCOL_VERSION,
      sessionId: SESSION_ID,
      // Ready only once the whole runner (Pi included) accepts requests
      astroReady: astro.ready && booted,
      booting: !booted && !bootFailed,
      bootFailed: bootFailed ? (bootFailed instanceof Error ? bootFailed.message : String(bootFailed)) : undefined,
      bootTimings,
      astroState: astro.state,
      astroCrashCount: astro.crashCount,
      astroLastExitCode: astro.lastExitCode,
      astroPort: astro.port,
      astroLogs: astro.logs.slice(-10),
      piBusy,
      busy,
      pendingInlineCheckpoint: inlineEditTimer !== null || inlineCheckpointInFlight !== null,
      activeVerifyRuns,
      originalBase,
      previewBase,
      readOnly,
      baseSha,
      wsClients: wsClients.size,
    });
  });

  let routesInflight: Promise<Awaited<ReturnType<typeof discoverSiteRoutes>>> | null = null;
  const loadRoutesDedup = () => {
    if (!routesInflight) {
      routesInflight = discoverSiteRoutes(REPO_ROOT).finally(() => {
        routesInflight = null;
      });
    }
    return routesInflight;
  };

  // Route modules get an explicit, typed view of the runner's state (getters/setters for the
  // mutable parts, so a module always reads the current value).
  const ctx: RunnerContext = {
    config,
    randomUUID,
    REPO_ROOT,
    STATE_DIR,
    SESSION_ID,
    BASE_BRANCH,
    get baseSha() {
      return baseSha;
    },
    set baseSha(v) {
      baseSha = v;
    },
    CONTROL_PLANE_INTERNAL_URL,
    SUPERVISOR_URL,
    get activeHostSecret() {
      return activeHostSecret;
    },
    set activeHostSecret(v) {
      activeHostSecret = v;
    },
    get workspaceToken() {
      return workspaceToken;
    },
    set workspaceToken(v) {
      workspaceToken = v;
    },
    MODEL_ID,
    THINKING_LEVEL,
    get persona() {
      return persona;
    },
    set persona(v) {
      persona = v;
    },
    get readOnly() {
      return readOnly;
    },
    set readOnly(v) {
      readOnly = v;
    },
    get prevBaseSha() {
      return prevBaseSha;
    },
    set prevBaseSha(v) {
      prevBaseSha = v;
    },
    gitIdentity,
    savePersistedSessionMeta,
    saveMetaLogged,
    changesOrEmpty,
    resolveHeadSha,
    syncPageRequestsLogged,
    fileLock,
    uploadManager,
    get latestTranscript() {
      return latestTranscript;
    },
    set latestTranscript(v) {
      latestTranscript = v;
    },
    get currentPreviewPaused() {
      return currentPreviewPaused;
    },
    set currentPreviewPaused(v) {
      currentPreviewPaused = v;
    },
    get currentPreviewPauseReason() {
      return currentPreviewPauseReason;
    },
    set currentPreviewPauseReason(v) {
      currentPreviewPauseReason = v;
    },
    broadcast,
    reportCheckpointFailure,
    notifySessionDiverged,
    notifyOptimizationSettled,
    cancelSpeculativeVerify,
    triggerImmediateSpeculativeVerify,
    scheduleIdleSpeculativeVerify,
    get activeVerifyRuns() {
      return activeVerifyRuns;
    },
    set activeVerifyRuns(v) {
      activeVerifyRuns = v;
    },
    cancelInlineEditTimer,
    scheduleInlineCheckpoint,
    astroManager,
    get piRuntime() {
      return piRuntime;
    },
    set piRuntime(v) {
      piRuntime = v;
    },
    get originalBase() {
      return originalBase;
    },
    set originalBase(v) {
      originalBase = v;
    },
    get previewBase() {
      return previewBase;
    },
    set previewBase(v) {
      previewBase = v;
    },
    pageService,
    get activeMergeState() {
      return activeMergeState;
    },
    set activeMergeState(v) {
      activeMergeState = v;
    },
    get activeConflictPacks() {
      return activeConflictPacks;
    },
    set activeConflictPacks(v) {
      activeConflictPacks = v;
    },
    get activeVirtualTreeSha() {
      return activeVirtualTreeSha;
    },
    set activeVirtualTreeSha(v) {
      activeVirtualTreeSha = v;
    },
    get activeMergeNeedsLlmPass() {
      return activeMergeNeedsLlmPass;
    },
    set activeMergeNeedsLlmPass(v) {
      activeMergeNeedsLlmPass = v;
    },
    get activeSyncOps() {
      return activeSyncOps;
    },
    set activeSyncOps(v) {
      activeSyncOps = v;
    },
    persistMergeReviewState,
    runnerNmCache,
    loadRoutesDedup,
    clock,
    wsClients,
    wsEpoch,
    safeSend,
    get lastTranscriptPayload() {
      return lastTranscriptPayload;
    },
    set lastTranscriptPayload(v) {
      lastTranscriptPayload = v;
    },
    get currentWorkspaceLocked() {
      return currentWorkspaceLocked;
    },
    set currentWorkspaceLocked(v) {
      currentWorkspaceLocked = v;
    },
    get currentLockedFile() {
      return currentLockedFile;
    },
    set currentLockedFile(v) {
      currentLockedFile = v;
    },
    get draining() {
      return draining;
    },
    set draining(v) {
      draining = v;
    },
    get shuttingDown() {
      return shuttingDown;
    },
    set shuttingDown(v) {
      shuttingDown = v;
    },
    get wsHeartbeatTimer() {
      return wsHeartbeatTimer;
    },
    set wsHeartbeatTimer(v) {
      wsHeartbeatTimer = v;
    },
    get ready() {
      return ready;
    },
  };

  registerEditorRoutes(app, ctx);
  registerSessionRoutes(app, ctx);
  registerPagesRoutes(app, ctx);
  registerGitRoutes(app, ctx);
  registerSyncRoutes(app, ctx);
  registerVerifyRoutes(app, ctx);
  registerUploadsRoutes(app, ctx);
  registerAgentRoutes(app, ctx);

  // ---------------------------------------------------------------------------------------------
  // WebSocket handlers
  // ---------------------------------------------------------------------------------------------
  const { wss, wsHandlers } = createRunnerWs(ctx);

  let server: ReturnType<typeof serve> | undefined;
  if (config.listen) {
    server = serve({
      fetch: app.fetch,
      port: RUNNER_PORT,
      hostname: config.hostname,
      createServer,
    });
    server.on('upgrade', (req, socket, head) => {
      if ((req.url ?? '').startsWith('/ws') && booted) {
        wss.handleUpgrade(req, socket, head, (ws) => {
          wss.emit('connection', ws, req);
        });
      } else {
        socket.destroy();
      }
    });
    wss.on('connection', (ws) => wsHandlers.handleConnection(ws));
    const srv = server;
    closeServer = () => {
      srv.close((err) => {
        if (err) ignoreExpected(err, 'runner: close http server');
      });
      wss.close();
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Boot (part 2, server already listening): astro dev and the Pi runtime start in parallel.
  // ---------------------------------------------------------------------------------------------
  const ready = (async () => {
    console.log('[halley-boot] starting_preview');
    const astroPromise = timed('astroReady', () => astroManager.start()).then((res) => {
      originalBase = res.originalBase;
      previewBase = res.previewBase;
      if (!booted) console.log('[halley-boot] starting_ai');
    });
    const piPromise = timed('piReady', async () => {
      await pageService.load();
      await pageService
        .syncPageRequestsFromDisk({ reconcileInterrupted: true, broadcast: false })
        .catch((err) => ignore(err, 'runner: reconcile interrupted page requests on boot'));
      const created = deps.createPiRuntime ? deps.createPiRuntime(piOptions()) : new HalleyPiRuntime(piOptions());
      await created.start();
      piRuntime = created;
    });
    const results = await Promise.allSettled([astroPromise, piPromise]);
    const failure = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failure) throw failure.reason;
    bootTimings.total = clock.now() - bootT0;
    booted = true;
    logger.info('runner: boot phases', { phasesMs: bootTimings });
    console.log(
      `[halley-workspace-runner] session=${SESSION_ID} runner=:${RUNNER_PORT} astro=:${ASTRO_PORT}${previewBase}`,
    );
  })();
  ready.catch((err) => {
    bootFailed = err ?? new Error('boot failed');
  });

  const handle: RunnerHandle = { app, server, wss, wsHandlers, shutdown, ready, bootTimings };
  deps.onCreated?.(handle);
  try {
    await ready;
  } catch (err) {
    await shutdown();
    throw err;
  }
  return handle;
}

const isMain =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]!) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const config = loadRunnerConfig(process.env);
  // Scrub secrets from process.env immediately so child processes (astro dev SSR, agent bash, build scripts) never inherit them
  delete process.env.WORKSPACE_TOKEN;
  delete process.env.WORKSPACE_HOST_SECRET;
  // Fail-stop on unknown state (see supervisor): the supervisor records the exit and the session
  // restarts cleanly on the next request.
  let fatal = false;
  process.on('uncaughtException', (err) => {
    logger.error('runner: uncaughtException; shutting down', { err });
    if (fatal) return;
    fatal = true;
    const hardExit = setTimeout(() => process.exit(1), 8_000);
    hardExit.unref();
    void (runner ? runner.shutdown() : Promise.resolve()).finally(() => process.exit(1));
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('runner: unhandledRejection', { err: reason });
  });
  let runner: RunnerHandle | null = null;
  let exiting = false;
  const exitAfterShutdown = () => {
    if (exiting) return;
    exiting = true;
    void (runner ? runner.shutdown() : Promise.resolve()).finally(() => process.exit(0));
  };
  process.on('SIGINT', exitAfterShutdown);
  process.on('SIGTERM', exitAfterShutdown);
  // The supervisor always spawns us; if it is gone (SIGKILL / OOM) nobody can stop or route to this
  // runner any more, so exit (taking our astro dev and build process groups with us).
  onParentDeath(() => {
    logger.warn('runner: supervisor process died; shutting down');
    exitAfterShutdown();
  });
  createRunner(config, {
    onCreated: (h) => {
      runner = h;
    },
  })
    .catch((err) => {
      console.error('[halley-workspace-runner] Fatal error:', err);
      process.exit(1);
    });
}
