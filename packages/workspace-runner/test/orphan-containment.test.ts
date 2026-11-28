import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ManualClock } from '../src/clock.js';
import { onParentDeath } from '../src/proc.js';

const procModule = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/proc.ts');

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('orphan containment', () => {
  it('fires once when the parent pid changes, never while the parent lives, and can be disposed', () => {
    const clock = new ManualClock();
    let ppid = 4242;
    let fired = 0;
    onParentDeath(() => (fired += 1), { clock, intervalMs: 1000, getPpid: () => ppid });
    clock.advance(10_000);
    expect(fired).toBe(0);
    ppid = 1; // re-parented to init: our parent died
    clock.advance(1000);
    clock.advance(5000);
    expect(fired).toBe(1);

    let disposedFired = 0;
    const dispose = onParentDeath(() => (disposedFired += 1), { clock, intervalMs: 1000, getPpid: () => ppid });
    dispose();
    ppid = 99;
    clock.advance(5000);
    expect(disposedFired).toBe(0);
  });

  it('a real child exits by itself after its parent is SIGKILLed (no orphan left running)', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'halley-orphan-'));
    try {
      const pidFile = path.join(tmp, 'child.pid');
      const childScript = path.join(tmp, 'child.mts');
      await fs.writeFile(
        childScript,
        `import fs from 'node:fs';
import { onParentDeath } from ${JSON.stringify(procModule)};
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setInterval(() => {}, 1000); // would run forever if orphaned
onParentDeath(() => process.exit(0), { intervalMs: 100 });
`,
      );
      const parentScript = path.join(tmp, 'parent.mjs');
      await fs.writeFile(
        parentScript,
        `import { spawn } from 'node:child_process';
spawn(process.execPath, ['--import', 'tsx', ${JSON.stringify(childScript)}], { stdio: 'ignore', detached: true }).unref();
setInterval(() => {}, 1000);
`,
      );
      const parent = spawn(process.execPath, [parentScript], { stdio: 'ignore', cwd: path.resolve(path.dirname(procModule), '..') });
      let childPid = 0;
      for (let i = 0; i < 200 && !childPid; i++) {
        childPid = Number(await fs.readFile(pidFile, 'utf8').catch(() => '0'));
        if (!childPid) await new Promise((r) => setTimeout(r, 50));
      }
      expect(childPid).toBeGreaterThan(0);
      expect(alive(childPid)).toBe(true);

      parent.kill('SIGKILL');
      let gone = false;
      for (let i = 0; i < 100 && !gone; i++) {
        gone = !alive(childPid);
        if (!gone) await new Promise((r) => setTimeout(r, 50));
      }
      if (!gone) process.kill(childPid, 'SIGKILL');
      expect(gone).toBe(true);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }, 20_000);
});
