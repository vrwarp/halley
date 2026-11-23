import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  createCheckpoint,
  hasProtectedPathChanges,
  listCheckpoints,
  rebaseOnBase,
  sanitizeProtectedPaths,
  undoToCheckpoint,
} from '../src/checkpoints-and-git.js';
import { runAstroHygieneGuard } from '../src/verify.js';

const execFileAsync = promisify(execFile);

const identity = {
  botName: 'Halley Bot',
  botEmail: 'halley-bot@users.noreply.github.com',
  editorName: 'Sarah',
  editorEmail: 'sarah@thecrossing.website',
};

describe('workspace-runner git, protection & hygiene', () => {
  it('protects .github/** from rogue edits, creates checkpoints with Co-authored-by, and supports undo', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'halley-ws-test-'));
    try {
      await execFileAsync('git', ['init', '-b', 'main'], { cwd: tmp });
      await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: tmp });
      await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmp });

      await fs.mkdir(path.join(tmp, '.github/workflows'), { recursive: true });
      await fs.writeFile(path.join(tmp, '.github/workflows/ci.yml'), 'name: CI\n');
      await fs.mkdir(path.join(tmp, 'src/pages'), { recursive: true });
      await fs.writeFile(path.join(tmp, 'src/pages/index.astro'), '<p>Initial</p>\n');
      await execFileAsync('git', ['add', '-A'], { cwd: tmp });
      await execFileAsync('git', ['commit', '-m', 'init'], { cwd: tmp });

      const { stdout: baseShaRaw } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: tmp });
      const baseSha = baseShaRaw.trim();

      // Simulate rogue bash edit to .github/workflows/ci.yml + legitimate page edit
      await fs.writeFile(path.join(tmp, '.github/workflows/ci.yml'), 'name: HACKED\n');
      await fs.writeFile(path.join(tmp, 'src/pages/index.astro'), '<p>Updated</p>\n');

      const ckpt1 = await createCheckpoint(tmp, 'Update homepage', identity);
      expect(ckpt1).not.toBeNull();

      // Verify .github/workflows/ci.yml was automatically restored
      const ciContent = await fs.readFile(path.join(tmp, '.github/workflows/ci.yml'), 'utf8');
      expect(ciContent).toBe('name: CI\n');
      expect(await hasProtectedPathChanges(tmp, baseSha)).toEqual([]);

      // Verify Co-authored-by trailer
      const { stdout: commitBody } = await execFileAsync('git', ['log', '-1', '--format=%B'], { cwd: tmp });
      expect(commitBody).toContain('Co-authored-by: Sarah <sarah@thecrossing.website>');

      // Second edit & undo back to baseSha
      await fs.writeFile(path.join(tmp, 'src/pages/index.astro'), '<p>Updated 2</p>\n');
      await createCheckpoint(tmp, 'Second update', identity);

      const history = await listCheckpoints(tmp, baseSha);
      expect(history.length).toBe(2);

      await undoToCheckpoint(tmp, baseSha, identity);
      const restored = await fs.readFile(path.join(tmp, 'src/pages/index.astro'), 'utf8');
      expect(restored).toBe('<p>Initial</p>\n');
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('hygiene guard catches hardcoded root-relative links and missing public assets', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'halley-hygiene-test-'));
    try {
      await fs.mkdir(path.join(tmp, 'src/pages'), { recursive: true });
      await fs.mkdir(path.join(tmp, 'public/images'), { recursive: true });
      await fs.writeFile(
        path.join(tmp, 'src/pages/index.astro'),
        `<a href="/im-new">Visit</a>\n<img src={url('/images/missing.webp')} />`,
      );

      const res = await runAstroHygieneGuard(tmp, '/thecrossing.website');
      expect(res.passed).toBe(false);
      expect(res.output).toContain('hardcoded root-relative path');
      expect(res.output).toContain('missing public asset /images/missing.webp');
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('rebases cleanly and invokes conflict resolver when branches collide', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'halley-rebase-test-'));
    try {
      const bare = path.join(tmp, 'remote.git');
      const wsA = path.join(tmp, 'wsA');
      const wsB = path.join(tmp, 'wsB');

      await execFileAsync('git', ['init', '--bare', '-b', 'main', bare]);
      await execFileAsync('git', ['clone', bare, wsA]);
      await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: wsA });
      await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: wsA });
      await fs.writeFile(path.join(wsA, 'page.txt'), 'line 1\n');
      await execFileAsync('git', ['add', '-A'], { cwd: wsA });
      await execFileAsync('git', ['commit', '-m', 'init'], { cwd: wsA });
      await execFileAsync('git', ['push', 'origin', 'main'], { cwd: wsA });

      // Clone wsB on a feature branch
      await execFileAsync('git', ['clone', bare, wsB]);
      await execFileAsync('git', ['checkout', '-b', 'halley/edit-1'], { cwd: wsB });
      await fs.writeFile(path.join(wsB, 'page.txt'), 'line 1 (editor B)\n');
      await createCheckpoint(wsB, 'Edit B', identity);

      // Advance main in wsA to create a conflict
      await fs.writeFile(path.join(wsA, 'page.txt'), 'line 1 (editor A)\n');
      await execFileAsync('git', ['add', '-A'], { cwd: wsA });
      await execFileAsync('git', ['commit', '-m', 'Edit A'], { cwd: wsA });
      await execFileAsync('git', ['push', 'origin', 'main'], { cwd: wsA });

      // Rebase wsB with automated resolver
      const outcome = await rebaseOnBase(wsB, {
        baseBranch: 'main',
        identity,
        onResolveConflict: async (files) => {
          expect(files).toEqual(['page.txt']);
          await fs.writeFile(path.join(wsB, 'page.txt'), 'line 1 (A + B)\n');
          await execFileAsync('git', ['add', 'page.txt'], { cwd: wsB });
          return true;
        },
      });
      expect(outcome.status).toBe('resolved');
      expect(await fs.readFile(path.join(wsB, 'page.txt'), 'utf8')).toBe('line 1 (A + B)\n');
      expect(await sanitizeProtectedPaths(wsB)).toBe(false);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
