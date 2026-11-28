import { spawn, type ChildProcess, type StdioOptions } from 'node:child_process';
import { realClock, type Clock, type TimerHandle } from './clock.js';
import { ignoreCodes, ignoreExpected } from './log.js';

/**
 * Signals the whole process group of a child spawned with `detached: true` (negative pid), falling
 * back to the direct child. Killing only the direct child leaves npm/pnpm/git-remote-http/esbuild
 * grandchildren running and holding locks or pipes.
 */
export function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (err) {
      // group already gone (or child not a group leader): fall through to direct kill
      ignoreCodes(err, ['ESRCH', 'EPERM'], 'proc: signal process group', { pid: child.pid, signal });
    }
  }
  try {
    child.kill(signal);
  } catch (err) {
    ignoreCodes(err, ['ESRCH'], 'proc: signal child (already exited)', { pid: child.pid, signal });
  }
}

export interface ExecGroupOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxBuffer?: number;
  /** Delay between SIGTERM and SIGKILL of the group on timeout (default 2s). */
  killGraceMs?: number;
  /** Clock for the timeout and kill escalation (default: the real clock). */
  clock?: Clock;
}

export interface ExecGroupError extends Error {
  code?: number | string | null;
  signal?: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  killed?: boolean;
}

/** Outcome of a finished (or failed-to-start) command. Never a rejection: callers branch on `code`. */
export interface ProcessResult {
  /** Exit code; 1 when the process was killed by a signal / timeout / overflow or could not start. */
  code: number;
  stdout: string;
  stderr: string;
  signal?: NodeJS.Signals | null;
  /** Killed because `timeoutMs` elapsed (the whole process group was terminated). */
  timedOut?: boolean;
  /** Killed because stdout exceeded `maxBuffer`. */
  overflow?: boolean;
  /** The process could not be spawned (ENOENT for a missing binary, EACCES, ...). */
  spawnError?: NodeJS.ErrnoException;
}

export interface ProcessSpawnOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  detached?: boolean;
  stdio?: StdioOptions;
}

/**
 * Seam for every child process the runner starts (git, npm/pnpm, cp/chmod, astro, build shells).
 * `exec` runs a command to completion in its own process group; `spawn` starts a long-running one.
 * Production uses `realProcessRunner`; tests swap in a recording/faulting runner with
 * `setProcessRunner` (or `RunnerDeps.processRunner` / `SupervisorOptions.processRunner`).
 */
export interface ProcessRunner {
  exec(cmd: string, args: readonly string[], opts?: ExecGroupOptions): Promise<ProcessResult>;
  spawn(cmd: string, args: readonly string[], opts: ProcessSpawnOptions): ChildProcess;
}

function realExec(file: string, args: readonly string[], opts: ExecGroupOptions = {}): Promise<ProcessResult> {
  const maxBuffer = opts.maxBuffer ?? 32 * 1024 * 1024;
  const killGraceMs = opts.killGraceMs ?? 2_000;
  const clock = opts.clock ?? realClock;
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(file, args as string[], {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      resolve({ code: 1, stdout: '', stderr: e.message ?? String(err), spawnError: e });
      return;
    }
    const out: Buffer[] = [];
    const errOut: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let timedOut = false;
    let overflow = false;
    let settled = false;
    let killTimer: TimerHandle | null = null;

    const terminate = () => {
      killProcessGroup(child, 'SIGTERM');
      if (!killTimer) {
        killTimer = clock.setTimeout(() => {
          killProcessGroup(child, 'SIGKILL');
          child.stdout?.destroy();
          child.stderr?.destroy();
        }, killGraceMs);
        killTimer.unref?.();
      }
    };

    const timer =
      opts.timeoutMs && opts.timeoutMs > 0
        ? clock.setTimeout(() => {
            timedOut = true;
            terminate();
          }, opts.timeoutMs)
        : null;
    timer?.unref?.();

    child.stdout?.on('data', (b: Buffer) => {
      outBytes += b.length;
      if (outBytes > maxBuffer) {
        if (!overflow) {
          overflow = true;
          terminate();
        }
        return;
      }
      out.push(b);
    });
    child.stderr?.on('data', (b: Buffer) => {
      errBytes += b.length;
      if (errBytes <= maxBuffer) errOut.push(b);
    });

    const finish = (code: number | null, signal: NodeJS.Signals | null, spawnErr?: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      if (timer) clock.clearTimeout(timer);
      if (killTimer) clock.clearTimeout(killTimer);
      const stdout = Buffer.concat(out).toString('utf8');
      const stderr = Buffer.concat(errOut).toString('utf8');
      const ok = !spawnErr && code === 0 && !timedOut && !overflow;
      const res: ProcessResult = {
        code: ok ? 0 : typeof code === 'number' && code !== 0 ? code : 1,
        stdout,
        stderr: spawnErr && !stderr ? spawnErr.message : stderr,
        signal,
      };
      if (timedOut) res.timedOut = true;
      if (overflow) res.overflow = true;
      if (spawnErr) res.spawnError = spawnErr;
      resolve(res);
    };

    child.on('error', (e) => finish(null, null, e));
    child.on('close', (code, signal) => finish(code, signal));
  });
}

/** Production `ProcessRunner`: real child processes, each `exec` in its own process group. */
export const realProcessRunner: ProcessRunner = {
  exec: realExec,
  spawn: (cmd, args, opts) => spawn(cmd, args as string[], opts),
};

let currentProcessRunner: ProcessRunner = realProcessRunner;

/** The process runner every module uses (a plain variable read: free on hot paths). */
export function getProcessRunner(): ProcessRunner {
  return currentProcessRunner;
}

/**
 * Replaces the process-wide runner (null restores the real one). Returns a function that restores
 * the previous runner, so overrides nest and tests can undo them in `finally`.
 */
export function setProcessRunner(runner: ProcessRunner | null | undefined): () => void {
  const prev = currentProcessRunner;
  currentProcessRunner = runner ?? realProcessRunner;
  return () => {
    currentProcessRunner = prev;
  };
}

/** Converts a non-zero `ProcessResult` into the execFile-compatible error `execFileGroup` rejects with. */
export function processResultError(file: string, args: readonly string[], r: ProcessResult, opts: ExecGroupOptions = {}): ExecGroupError {
  const reason = r.spawnError
    ? r.spawnError.message
    : r.timedOut
      ? `timed out after ${opts.timeoutMs}ms (process group killed)`
      : r.overflow
        ? `stdout exceeded maxBuffer ${opts.maxBuffer ?? 32 * 1024 * 1024}`
        : `exited with ${r.signal ?? r.code}`;
  const stderrText = r.spawnError ? '' : r.stderr;
  const err = new Error(
    `Command failed: ${file} ${args.join(' ')}: ${reason}${stderrText ? `\n${stderrText.trim().slice(0, 4000)}` : ''}`,
  ) as ExecGroupError;
  err.code = r.spawnError ? (r.spawnError.code ?? null) : r.signal ? null : r.code;
  err.signal = r.signal ?? null;
  err.stdout = r.stdout;
  err.stderr = r.stderr;
  err.killed = Boolean(r.timedOut || r.overflow);
  return err;
}

/**
 * `execFile` replacement that runs the command (through the current `ProcessRunner`) in its own
 * process group and, on timeout, kills the ENTIRE group (SIGTERM, then SIGKILL after `killGraceMs`).
 * Resolves `{ stdout, stderr }` on exit 0, otherwise rejects with an error carrying `code`,
 * `signal`, `stdout`, `stderr` (execFile-compatible).
 */
export async function execFileGroup(
  file: string,
  args: string[],
  opts: ExecGroupOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  const r = await currentProcessRunner.exec(file, args, opts);
  if (r.code === 0) return { stdout: r.stdout, stderr: r.stderr };
  throw processResultError(file, args, r, opts);
}

/**
 * Returns `nodeOptions` with every `--max-old-space-size` / `--max_old_space_size` flag removed and
 * a single `--max-old-space-size=<mb>` appended, preserving all other flags.
 */
export function withMaxOldSpace(nodeOptions: string | undefined, mb: number): string {
  // Handles both `--max-old-space-size=1024` and the space-separated `--max-old-space-size 1024`
  const cleaned: string[] = [];
  const rawTokens = (nodeOptions ?? '').split(/\s+/).filter(Boolean);
  for (let i = 0; i < rawTokens.length; i++) {
    const tok = rawTokens[i]!;
    if (/^--max[-_]old[-_]space[-_]size$/.test(tok)) {
      i++; // skip its value
      continue;
    }
    if (/^--max[-_]old[-_]space[-_]size=/.test(tok)) continue;
    cleaned.push(tok);
  }
  if (Number.isFinite(mb) && mb > 0) cleaned.push(`--max-old-space-size=${Math.floor(mb)}`);
  return cleaned.join(' ');
}

export function envInt(name: string, fallback: number, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/**
 * Linux-only blast-radius containment: SIGKILLs every process (other than this one) whose
 * environment contains `name=value` exactly. Runners export HALLEY_SESSION_ID to all children, and
 * astro dev / builds run in their OWN process groups (so group kills of the runner miss them);
 * after a runner dies hard (OOM, SIGKILL) this reaps its orphaned astro dev, builds and agent
 * shells so they stop holding ports, RAM and the shared verify sandbox. Returns the number killed.
 */
export async function killProcessesWithEnv(name: string, value: string): Promise<number> {
  if (!value || process.platform !== 'linux') return 0;
  const { readdir, readFile } = await import('node:fs/promises');
  let entries: string[];
  try {
    entries = await readdir('/proc');
  } catch (err) {
    ignoreCodes(err, ['ENOENT'], 'proc: /proc not readable; cannot reap session processes');
    return 0;
  }
  const needle = Buffer.from(`${name}=${value}\0`);
  let killed = 0;
  await Promise.all(
    entries.map(async (entry) => {
      if (!/^\d+$/.test(entry)) return;
      const pid = Number(entry);
      if (pid === process.pid || pid === 1) return;
      let env: Buffer;
      try {
        env = await readFile(`/proc/${pid}/environ`);
      } catch (err) {
        // exited, or not ours (EACCES)
        ignoreCodes(err, ['ENOENT', 'ESRCH', 'EACCES', 'EPERM'], 'proc: read environ', { pid });
        return;
      }
      if (env.length === 0) return;
      // match at start of block or after a NUL separator
      const idx = env.indexOf(needle);
      if (idx === -1 || (idx > 0 && env[idx - 1] !== 0)) return;
      try {
        process.kill(pid, 'SIGKILL');
        killed++;
      } catch (err) {
        ignoreCodes(err, ['ESRCH'], 'proc: kill session process (already gone)', { pid });
      }
    }),
  );
  return killed;
}

/**
 * Orphan containment: calls `onParentGone` once if this process is re-parented (its parent died,
 * e.g. was SIGKILLed, so the OS handed it to init / a subreaper). Without this, a runner whose
 * supervisor died — or a local supervisor whose control plane died — keeps running unsupervised,
 * holding ports, memory and its own astro dev / build children. Cheap: one integer compare per tick.
 */
export function onParentDeath(
  onParentGone: () => void,
  opts: { clock?: Clock; intervalMs?: number; getPpid?: () => number } = {},
): () => void {
  const clock = opts.clock ?? realClock;
  const getPpid = opts.getPpid ?? (() => process.ppid);
  const original = getPpid();
  let fired = false;
  const timer = clock.setInterval(() => {
    if (fired) return;
    if (getPpid() !== original) {
      fired = true;
      clock.clearTimeout(timer);
      onParentGone();
    }
  }, opts.intervalMs ?? 2_000);
  timer.unref?.();
  return () => {
    fired = true;
    clock.clearTimeout(timer);
  };
}
