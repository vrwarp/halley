/**
 * Vitest globalSetup for the e2e suite (runs in the main vitest process).
 *
 * Every test and hook already has a timeout, so a run that is still alive long after that can only be
 * stuck outside a test: a worker that never exits because something keeps its event loop alive (a
 * leaked child process, socket or timer). Instead of hanging silently until CI kills the job, dump the
 * process tree and this process's active handles, then fail the run.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LIMIT_MS = Number(process.env.HALLEY_E2E_WATCHDOG_MS || 8 * 60_000);
/** Every e2e stack lives under an os.tmpdir() dir with this prefix (see startStack). */
const STACK_MARKER = path.join(os.tmpdir(), 'halley-e2e-');

/** Last-resort cleanup: SIGKILL any process whose environment points into an e2e stack dir. */
function sweepStackProcesses(): number {
  if (process.platform !== 'linux') return 0;
  let killed = 0;
  for (const entry of fs.readdirSync('/proc')) {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid === process.pid) continue;
    let environ = '';
    try {
      environ = fs.readFileSync(`/proc/${pid}/environ`, 'utf8');
    } catch {
      continue; // exited meanwhile, or not readable
    }
    if (!environ.includes(STACK_MARKER)) continue;
    try {
      process.kill(pid, 'SIGKILL');
      killed += 1;
    } catch {
      // already gone
    }
  }
  return killed;
}

export default function setup(): () => void {
  const timer = setTimeout(() => {
    console.error(`\n[e2e-watchdog] suite still running after ${Math.round(LIMIT_MS / 1000)}s; dumping state and failing.`);
    try {
      console.error(execFileSync('ps', ['-eo', 'pid,ppid,pgid,etime,stat,cmd', '--forest'], { encoding: 'utf8' }));
    } catch (err) {
      console.error('[e2e-watchdog] ps failed:', err);
    }
    const handles = (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles?.() ?? [];
    const summary = handles.map((h) => (h as { constructor?: { name?: string } })?.constructor?.name ?? typeof h);
    console.error('[e2e-watchdog] active handles in vitest main:', summary.join(', '));
    console.error(`[e2e-watchdog] killed ${sweepStackProcesses()} e2e stack process(es) before exiting.`);
    process.exit(1);
  }, LIMIT_MS);
  timer.unref();
  return () => {
    clearTimeout(timer);
    const leaked = sweepStackProcesses();
    if (leaked > 0) console.warn(`[e2e-watchdog] teardown killed ${leaked} leaked e2e stack process(es).`);
  };
}
