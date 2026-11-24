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

export interface AstroDevManagerOptions {
  repoRoot: string;
  sessionId: string;
  astroPort: number;
  runnerPort: number;
  isReadOnly: () => boolean;
  onPatched: (evt: { file: string; loc: string }) => void;
}

export class AstroDevManager {
  private proc: ChildProcess | null = null;
  private ready = false;
  private originalBase = '/';
  private previewBase = '/';
  private wrapperConfigPath = '';
  private recentLogs: string[] = [];

  constructor(private opts: AstroDevManagerOptions) {}

  getStatus() {
    return {
      ready: this.ready,
      originalBase: this.originalBase,
      previewBase: this.previewBase,
      port: this.opts.astroPort,
      logs: this.recentLogs.slice(-40),
    };
  }

  async start(): Promise<{ originalBase: string; previewBase: string }> {
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

    const configContent = `
import userConfig from ${JSON.stringify(userConfigPath)};
import { halleyDevEdit } from ${JSON.stringify(devEditEntry)};

const baseConfig = typeof userConfig === 'function' ? await userConfig({ mode: 'development', command: 'dev' }) : userConfig;
const existingIntegrations = Array.isArray(baseConfig.integrations) ? baseConfig.integrations : [];

export default {
  ...baseConfig,
  base: ${JSON.stringify(this.previewBase)},
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
    server: {
      ...((baseConfig.vite && baseConfig.vite.server) || {}),
      allowedHosts: true,
    },
  },
};
`;
    await fs.writeFile(this.wrapperConfigPath, configContent, 'utf8');

    const astroBin = path.join(this.opts.repoRoot, 'node_modules', '.bin', 'astro');
    const relConfigPath = path.relative(this.opts.repoRoot, this.wrapperConfigPath);
    this.proc = spawn(
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

    const pushLog = (chunk: Buffer) => {
      const lines = chunk.toString('utf8').split(/\r?\n/).filter(Boolean);
      for (const l of lines) {
        this.recentLogs.push(l);
        if (this.recentLogs.length > 200) this.recentLogs.shift();
        if (l.includes('Local') || l.includes(`:${this.opts.astroPort}`) || l.includes('watching for file changes')) {
          this.ready = true;
        }
      }
    };

    this.proc.stdout?.on('data', pushLog);
    this.proc.stderr?.on('data', pushLog);
    this.proc.on('exit', (code) => {
      this.ready = false;
      this.recentLogs.push(`[astro dev exited with code ${code}]`);
    });

    // Poll local HTTP until ready (up to 30s)
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (this.proc.exitCode !== null) break;
      try {
        const res = await fetch(`http://127.0.0.1:${this.opts.astroPort}${this.previewBase}/`);
        if (res.status < 500) {
          this.ready = true;
          break;
        }
      } catch {
        // still booting
      }
      await new Promise((r) => setTimeout(r, 400));
    }

    return { originalBase: this.originalBase, previewBase: this.previewBase };
  }

  async stop(): Promise<void> {
    if (this.proc && this.proc.exitCode === null) {
      this.proc.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 500));
      if (this.proc.exitCode === null) this.proc.kill('SIGKILL');
    }
    this.ready = false;
    if (this.wrapperConfigPath) {
      await fs.rm(this.wrapperConfigPath, { force: true }).catch(() => {});
    }
  }
}
