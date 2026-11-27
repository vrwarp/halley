import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function stripJsComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

export async function detectAstroBase(repoRoot: string): Promise<string> {
  for (const name of ['astro.config.mjs', 'astro.config.ts', 'astro.config.js']) {
    try {
      const content = stripJsComments(await fs.readFile(path.join(repoRoot, name), 'utf8'));
      const m = content.match(/\bbase\s*:\s*(['"`])([^'"`]+)\1/);
      if (m?.[2]) {
        const b = m[2].startsWith('/') ? m[2] : `/${m[2]}`;
        return b === '/' ? '/' : b.replace(/\/$/, '');
      }
    } catch {
      // try next
    }
  }
  return '/';
}

export async function detectAstroSiteUrl(repoRoot: string): Promise<string | null> {
  for (const name of ['astro.config.mjs', 'astro.config.ts', 'astro.config.js']) {
    try {
      const content = stripJsComments(await fs.readFile(path.join(repoRoot, name), 'utf8'));
      const siteMatch = content.match(/\bsite\s*:\s*(['"`])(https?:\/\/[^'"`]+)\1/);
      if (!siteMatch?.[2]) continue;
      const site = siteMatch[2].replace(/\/+$/, '');
      const baseMatch = content.match(/\bbase\s*:\s*(['"`])([^'"`]+)\1/);
      let base = '';
      if (baseMatch?.[2]) {
        const b = baseMatch[2].startsWith('/') ? baseMatch[2] : `/${baseMatch[2]}`;
        base = b === '/' ? '' : b.replace(/\/+$/, '');
      }
      return `${site}${base}`;
    } catch {
      // try next
    }
  }
  return null;
}

export function computePreviewBase(sessionId: string, originalBase: string): string {
  const suffix = originalBase === '/' ? '' : originalBase;
  return `/p/${sessionId}${suffix}`;
}

export async function findAstroConfigFile(repoRoot: string): Promise<string> {
  for (const name of ['astro.config.mjs', 'astro.config.ts', 'astro.config.js']) {
    const full = path.join(repoRoot, name);
    try {
      await fs.access(full);
      return full;
    } catch {
      // continue
    }
  }
  throw new Error('No astro.config.{mjs,ts,js} found in repository');
}

export type AstroDevState = 'starting' | 'ready' | 'paused' | 'crashed';

export interface AstroDevManagerOptions {
  repoRoot: string;
  stateDir?: string;
  sessionId: string;
  astroPort: number;
  runnerPort: number;
  isReadOnly: () => boolean;
  onPatched: (evt: { file: string; loc: string }) => void;
  /** Backoff delays (ms) for unexpected-exit auto-restarts. Default: [2000, 5000, 15000]. */
  restartDelaysMs?: number[];
  /** Window (ms) in which unexpected exits count toward the restart limit. Default: 5 min. */
  crashWindowMs?: number;
  /** Optional custom spawner for unit testing. */
  spawnAstro?: () => ChildProcess;
  /** Optional readiness probe override for unit testing. */
  probeReady?: () => Promise<boolean>;
}

const DEFAULT_RESTART_DELAYS_MS = [2_000, 5_000, 15_000];
const DEFAULT_CRASH_WINDOW_MS = 5 * 60_000;

function signalProcessGroup(proc: ChildProcess, signal: NodeJS.Signals): void {
  if (proc.pid) {
    try {
      process.kill(-proc.pid, signal);
      return;
    } catch {
      // Fallback to direct child signal if not a group leader
    }
  }
  try {
    proc.kill(signal);
  } catch {
    // already exited
  }
}

export class AstroDevManager {
  private proc: ChildProcess | null = null;
  private ready = false;
  private state: AstroDevState = 'starting';
  private originalBase = '/';
  private previewBase = '/';
  private wrapperConfigPath = '';
  private recentLogs: string[] = [];
  private intentionalStop = false;
  private paused = false;
  private crashTimestamps: number[] = [];
  private crashCount = 0;
  private lastExitCode: number | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly restartDelaysMs: number[];
  private readonly crashWindowMs: number;

  constructor(private opts: AstroDevManagerOptions) {
    this.restartDelaysMs = opts.restartDelaysMs ?? DEFAULT_RESTART_DELAYS_MS;
    this.crashWindowMs = opts.crashWindowMs ?? DEFAULT_CRASH_WINDOW_MS;
  }

  getStatus() {
    return {
      ready: this.ready,
      state: this.state,
      originalBase: this.originalBase,
      previewBase: this.previewBase,
      port: this.opts.astroPort,
      crashCount: this.crashCount,
      lastExitCode: this.lastExitCode,
      logs: this.recentLogs.slice(-40),
    };
  }

  private clearRestartTimer(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  private async ensureWrapperConfig(): Promise<void> {
    if (this.opts.spawnAstro) return;
    this.originalBase = await detectAstroBase(this.opts.repoRoot);
    this.previewBase = computePreviewBase(this.opts.sessionId, this.originalBase);
    const userConfigPath = await findAstroConfigFile(this.opts.repoRoot);
    const devEditEntry = import.meta.resolve('@halley/astro-dev-edit');

    const configDir = this.opts.stateDir
      ? path.join(this.opts.stateDir, 'astro-wrapper')
      : os.tmpdir();
    await fs.mkdir(configDir, { recursive: true });
    this.wrapperConfigPath = path.join(configDir, `halley-astro-${this.opts.sessionId}.config.mjs`);

    const astroCacheDir = this.opts.stateDir
      ? path.join(this.opts.stateDir, 'astro-cache')
      : path.join(os.tmpdir(), `halley-astro-cache-${this.opts.sessionId}`);
    const viteCacheDir = this.opts.stateDir
      ? path.join(this.opts.stateDir, 'vite-cache')
      : path.join(os.tmpdir(), `halley-vite-cache-${this.opts.sessionId}`);
    await fs.mkdir(astroCacheDir, { recursive: true });
    await fs.mkdir(viteCacheDir, { recursive: true });

    const configContent = `
import userConfig from ${JSON.stringify(userConfigPath)};
import { halleyDevEdit } from ${JSON.stringify(devEditEntry)};

const baseConfig = typeof userConfig === 'function' ? await userConfig({ mode: 'development', command: 'dev' }) : userConfig;
const existingIntegrations = Array.isArray(baseConfig.integrations) ? baseConfig.integrations : [];

export default {
  ...baseConfig,
  base: ${JSON.stringify(this.previewBase)},
  cacheDir: ${JSON.stringify(astroCacheDir)},
  integrations: [
    ...existingIntegrations,
    halleyDevEdit({
      repoRoot: ${JSON.stringify(this.opts.repoRoot)},
      previewBase: ${JSON.stringify(this.previewBase)},
      originalBase: ${JSON.stringify(this.originalBase)},
      enableLocalEndpoints: false,
    }),
  ],
  server: {
    ...(baseConfig.server || {}),
    host: '0.0.0.0',
    port: ${this.opts.astroPort},
    allowedHosts: true,
  },
  vite: {
    ...(baseConfig.vite || {}),
    cacheDir: ${JSON.stringify(viteCacheDir)},
    server: {
      ...((baseConfig.vite && baseConfig.vite.server) || {}),
      strictPort: true,
      allowedHosts: true,
      hmr: false,
      fs: {
        ...((baseConfig.vite && baseConfig.vite.server && baseConfig.vite.server.fs) || {}),
        strict: false,
      },
    },
  },
};
`;
    await fs.writeFile(this.wrapperConfigPath, configContent, 'utf8');
  }

  private async spawnAndWait(): Promise<void> {
    this.clearRestartTimer();
    this.intentionalStop = false;
    this.paused = false;
    this.ready = false;
    this.state = 'starting';

    let child: ChildProcess;
    if (this.opts.spawnAstro) {
      child = this.opts.spawnAstro();
    } else {
      const rawAstroBin = path.join(this.opts.repoRoot, 'node_modules', '.bin', 'astro');
      const astroBin = await fs.realpath(rawAstroBin).catch(() => rawAstroBin);
      const realRepoRoot = await fs
        .realpath(this.opts.repoRoot)
        .catch(() => path.resolve(this.opts.repoRoot));
      const realWrapperDir = await fs
        .realpath(path.dirname(this.wrapperConfigPath))
        .catch(() => path.resolve(path.dirname(this.wrapperConfigPath)));
      const realWrapperPath = path.join(realWrapperDir, path.basename(this.wrapperConfigPath));
      // Astro 5 `resolveConfigPath` uses `path.join(root, configFile)` rather than `path.resolve`,
      // so `--config` MUST be relative to `repoRoot` when stored outside `repoRoot` in `stateDir`.
      const configArg = path.relative(realRepoRoot, realWrapperPath);
      child = spawn(
        astroBin,
        [
          'dev',
          '--config',
          configArg,
          '--host',
          '0.0.0.0',
          '--port',
          String(this.opts.astroPort),
          '--allowed-hosts',
        ],
        {
          cwd: realRepoRoot,
          detached: true,
          env: {
            ...process.env,
            FORCE_COLOR: '0',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
    }

    this.proc = child;

    const listenUrlRe = new RegExp(
      `https?:\\/\\/(?:localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0|\\[::1?\\]):${this.opts.astroPort}\\b`,
      'i',
    );

    const pushLog = (chunk: Buffer, isErr: boolean) => {
      const lines = chunk.toString('utf8').split(/\r?\n/).filter(Boolean);
      for (const l of lines) {
        this.recentLogs.push(l);
        if (this.recentLogs.length > 200) this.recentLogs.shift();
        if (isErr) {
          console.error(`[halley-astro] ${l}`);
          continue;
        }
        if (listenUrlRe.test(l) || l.includes('watching for file changes')) {
          this.ready = true;
          this.state = 'ready';
        }
      }
    };

    child.stdout?.on('data', (chunk: Buffer) => pushLog(chunk, false));
    child.stderr?.on('data', (chunk: Buffer) => pushLog(chunk, true));
    child.on('exit', (code, signal) => {
      if (this.proc !== child) return;
      this.ready = false;
      this.lastExitCode = code;
      const exitMsg = `[astro dev exited with code ${code}${signal ? ` (${signal})` : ''}]`;
      this.recentLogs.push(exitMsg);

      if (this.paused) {
        this.state = 'paused';
        return;
      }
      if (this.intentionalStop) {
        return;
      }

      console.error(`[halley-astro] ${exitMsg}`);
      this.crashCount += 1;
      const now = Date.now();
      this.crashTimestamps = this.crashTimestamps.filter((ts) => now - ts < this.crashWindowMs);
      this.crashTimestamps.push(now);

      if (this.crashTimestamps.length <= this.restartDelaysMs.length) {
        const delay = this.restartDelaysMs[this.crashTimestamps.length - 1] ?? 15_000;
        this.state = 'starting';
        this.recentLogs.push(
          `[astro dev crashed (${this.crashTimestamps.length}/${this.restartDelaysMs.length}); restarting in ${delay}ms]`,
        );
        this.clearRestartTimer();
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null;
          if (!this.intentionalStop && !this.paused) {
            void this.enqueueOp(() => this.spawnAndWait()).catch((err) => {
              this.recentLogs.push(
                `[astro dev auto-restart failed: ${err instanceof Error ? err.message : String(err)}]`,
              );
              this.state = 'crashed';
            });
          }
        }, delay);
        this.restartTimer.unref?.();
      } else {
        this.state = 'crashed';
        this.recentLogs.push('[astro dev exceeded restart limit; marked crashed]');
      }
    });

    // Poll deterministic HTTP /__editor/health endpoint (up to 45s on Ryzen V1500B)
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      if (this.ready || this.proc !== child || child.exitCode !== null || this.paused || this.intentionalStop) {
        break;
      }
      try {
        const ok = this.opts.probeReady
          ? await this.opts.probeReady()
          : await fetch(`http://127.0.0.1:${this.opts.astroPort}${this.previewBase}/__editor/health`, {
              signal: AbortSignal.timeout(3_000),
            }).then((res) => res.ok);
        if (ok) {
          this.ready = true;
          this.state = 'ready';
          break;
        }
      } catch {
        // still booting
      }
      if (this.ready) break;
      await new Promise((r) => setTimeout(r, 350));
    }
  }

  private opQueue: Promise<unknown> = Promise.resolve();

  private enqueueOp<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.opQueue.then(fn, fn);
    this.opQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async killCurrentProc(): Promise<void> {
    const p = this.proc;
    if (p && p.exitCode === null) {
      const waitExit = (timeoutMs: number) =>
        new Promise<boolean>((resolve) => {
          if (p.exitCode !== null) {
            resolve(true);
            return;
          }
          const onExit = () => {
            clearTimeout(t);
            resolve(true);
          };
          const t = setTimeout(() => {
            p.off?.('exit', onExit);
            resolve(p.exitCode !== null);
          }, timeoutMs);
          t.unref?.();
          p.once('exit', onExit);
        });

      signalProcessGroup(p, 'SIGTERM');
      const exitedGracefully = await waitExit(1_500);
      if (!exitedGracefully && p.exitCode === null) {
        signalProcessGroup(p, 'SIGKILL');
        await waitExit(1_000);
      }
      p.stdout?.destroy?.();
      p.stderr?.destroy?.();
    }
    if (this.proc === p) {
      this.proc = null;
    }
  }

  async start(): Promise<{ originalBase: string; previewBase: string }> {
    return this.enqueueOp(async () => {
      await this.ensureWrapperConfig();
      await this.spawnAndWait();
      return { originalBase: this.originalBase, previewBase: this.previewBase };
    });
  }

  async pause(): Promise<void> {
    return this.enqueueOp(async () => {
      this.clearRestartTimer();
      this.paused = true;
      this.intentionalStop = true;
      this.ready = false;
      this.state = 'paused';
      await this.killCurrentProc();
    });
  }

  async resume(): Promise<void> {
    return this.enqueueOp(async () => {
      if (!this.paused && this.ready && this.proc && this.proc.exitCode === null) {
        return;
      }
      await this.ensureWrapperConfig();
      await this.spawnAndWait();
    });
  }

  async restart(): Promise<void> {
    return this.enqueueOp(async () => {
      this.clearRestartTimer();
      this.intentionalStop = true;
      this.paused = false;
      this.ready = false;
      this.crashCount = 0;
      this.crashTimestamps = [];
      await this.killCurrentProc();
      await this.ensureWrapperConfig();
      await this.spawnAndWait();
    });
  }

  async stop(): Promise<void> {
    return this.enqueueOp(async () => {
      this.clearRestartTimer();
      this.intentionalStop = true;
      this.paused = false;
      this.ready = false;
      await this.killCurrentProc();
      if (this.wrapperConfigPath) {
        await fs.unlink(this.wrapperConfigPath).catch(() => {});
      }
    });
  }
}
