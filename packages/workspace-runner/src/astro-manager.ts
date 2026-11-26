import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export async function detectAstroBase(repoRoot: string): Promise<string> {
  for (const name of ['astro.config.mjs', 'astro.config.ts', 'astro.config.js']) {
    try {
      const content = await fs.readFile(path.join(repoRoot, name), 'utf8');
      const m = content.match(/\bbase\s*:\s*['"]([^'"]+)['"]/);
      if (m?.[1]) {
        const b = m[1].startsWith('/') ? m[1] : `/${m[1]}`;
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
      const content = await fs.readFile(path.join(repoRoot, name), 'utf8');
      const siteMatch = content.match(/\bsite\s*:\s*['"](https?:\/\/[^'"]+)['"]/);
      if (!siteMatch?.[1]) continue;
      const site = siteMatch[1].replace(/\/+$/, '');
      const baseMatch = content.match(/\bbase\s*:\s*['"]([^'"]+)['"]/);
      let base = '';
      if (baseMatch?.[1]) {
        const b = baseMatch[1].startsWith('/') ? baseMatch[1] : `/${baseMatch[1]}`;
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
    const astroConfigHelper = path.join(
      path.dirname(require.resolve('astro/package.json', { paths: [this.opts.repoRoot, process.cwd()] })),
      'dist/core/config/index.js',
    );
    void astroConfigHelper;

    this.wrapperConfigPath = path.join(
      os.tmpdir(),
      `halley-astro-${this.opts.sessionId}.config.mjs`,
    );

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
      onPatchedWebhookUrl: ${JSON.stringify(`http://127.0.0.1:${this.opts.runnerPort}/internal/git/notify-patched`)},
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
      allowedHosts: true,
      hmr: false,
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
      const relConfigPath = path.relative(this.opts.repoRoot, this.wrapperConfigPath);
      child = spawn(
        astroBin,
        ['dev', '--config', relConfigPath, '--host', '0.0.0.0', '--port', String(this.opts.astroPort), '--allowed-hosts'],
        {
          cwd: this.opts.repoRoot,
          env: {
            ...process.env,
            FORCE_COLOR: '0',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
    }

    this.proc = child;

    const pushLog = (chunk: Buffer, isErr: boolean) => {
      const lines = chunk.toString('utf8').split(/\r?\n/).filter(Boolean);
      for (const l of lines) {
        this.recentLogs.push(l);
        if (this.recentLogs.length > 200) this.recentLogs.shift();
        if (isErr) {
          console.error(`[halley-astro] ${l}`);
        }
        if (l.includes('Local') || l.includes(`:${this.opts.astroPort}`) || l.includes('watching for file changes')) {
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
            void this.spawnAndWait().catch((err) => {
              this.recentLogs.push(`[astro dev auto-restart failed: ${err instanceof Error ? err.message : String(err)}]`);
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

    // Poll local HTTP until ready (up to 30s), breaking immediately if stdout already reported ready
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (this.ready || this.proc !== child || child.exitCode !== null || this.paused || this.intentionalStop) {
        break;
      }
      try {
        const ok = this.opts.probeReady
          ? await this.opts.probeReady()
          : await fetch(`http://127.0.0.1:${this.opts.astroPort}${this.previewBase}/`, {
              signal: AbortSignal.timeout(3_000),
            }).then((res) => res.status < 500);
        if (ok) {
          this.ready = true;
          this.state = 'ready';
          break;
        }
      } catch {
        // still booting
      }
      if (this.ready) break;
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  private async killCurrentProc(): Promise<void> {
    const p = this.proc;
    if (p && p.exitCode === null) {
      p.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 500));
      if (p.exitCode === null) p.kill('SIGKILL');
    }
    if (this.proc === p) {
      this.proc = null;
    }
  }

  async start(): Promise<{ originalBase: string; previewBase: string }> {
    await this.ensureWrapperConfig();
    await this.spawnAndWait();
    return { originalBase: this.originalBase, previewBase: this.previewBase };
  }

  /**
   * Temporarily stops `astro dev` to free memory during production builds / verification checks.
   * Preserves the wrapper config file so `resume()` can restart cleanly.
   */
  async pause(): Promise<void> {
    this.clearRestartTimer();
    this.paused = true;
    this.intentionalStop = true;
    this.ready = false;
    this.state = 'paused';
    await this.killCurrentProc();
  }

  /** Resumes `astro dev` after `pause()`. */
  async resume(): Promise<void> {
    if (!this.wrapperConfigPath && !this.opts.spawnAstro) {
      await this.ensureWrapperConfig();
    }
    this.paused = false;
    await this.spawnAndWait();
  }

  /** Resets crash history and performs a clean restart of `astro dev`. */
  async restart(): Promise<void> {
    this.clearRestartTimer();
    this.crashTimestamps = [];
    this.intentionalStop = true;
    this.paused = false;
    await this.killCurrentProc();
    if (!this.wrapperConfigPath && !this.opts.spawnAstro) {
      await this.ensureWrapperConfig();
    }
    await this.spawnAndWait();
  }

  async stop(): Promise<void> {
    this.clearRestartTimer();
    this.intentionalStop = true;
    this.paused = false;
    await this.killCurrentProc();
    this.ready = false;
    if (this.wrapperConfigPath) {
      await fs.rm(this.wrapperConfigPath, { force: true }).catch(() => {});
    }
  }
}
