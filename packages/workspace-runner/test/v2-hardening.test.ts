import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  checkSharedContainerBashCommand,
  isDependencyMutationCommand,
} from '../src/bash-guard.js';
import { FifoBuildQueue } from '../src/build-queue.js';
import {
  commitVirtualMergeResolution,
  findFilesWithConflictMarkers,
  virtualMergeWithBase,
} from '../src/checkpoints-and-git.js';
import {
  parseMarkedConflictHunks,
  spliceResolvedHunks,
} from '../src/conflict-protocol.js';
import { runAllVerificationChecks } from '../src/verify.js';

const execFileAsync = promisify(execFile);

describe('v2 workspace-runner hardening invariants', () => {
  it('allows quoted ../ search/filter patterns in bash-guard while blocking unquoted parent traversal', () => {
    const repoRoot = '/workspaces/sessions/s1/workspace';
    // Allowed: quoted ripgrep & jq patterns inside workspace
    expect(checkSharedContainerBashCommand('rg "../lib/url" src/pages', repoRoot).allowed).toBe(true);
    expect(checkSharedContainerBashCommand("rg '../components/Header' src", repoRoot).allowed).toBe(true);
    expect(checkSharedContainerBashCommand("jq '.. | .title? // empty' src/content/sermons/acts.json", repoRoot).allowed).toBe(true);

    // Blocked: unquoted parent traversal, quoted fs traversal, direct build/dev server, process kills
    expect(checkSharedContainerBashCommand('ls ../state', repoRoot).allowed).toBe(false);
    expect(checkSharedContainerBashCommand('cat "../state/sync.json"', repoRoot).allowed).toBe(false);
    expect(checkSharedContainerBashCommand('cat ../../etc/passwd', repoRoot).allowed).toBe(false);
    expect(checkSharedContainerBashCommand('npm run build', repoRoot).allowed).toBe(false);
    expect(checkSharedContainerBashCommand('npx astro dev', repoRoot).allowed).toBe(false);
    expect(checkSharedContainerBashCommand('pkill -f astro', repoRoot).allowed).toBe(false);
    expect(isDependencyMutationCommand('pnpm install')).toBe(true);
  });

  it('FifoBuildQueue waits for preempted speculative build cleanup before granting foreground lease and supports deferSpeculativeFor', async () => {
    const queue = new FifoBuildQueue(5_000, 15_000, 2_000);
    const events: string[] = [];

    // 1. Speculative build starts
    const specLease = await queue.acquire('sess-spec', {
      priority: 'speculative',
      onPreempted: () => {
        events.push('spec-preempted');
        // Simulate 60ms child-process teardown before releasing lease
        setTimeout(() => {
          events.push('spec-cleanup-done');
          specLease.release();
        }, 60);
      },
    });
    events.push('spec-acquired');

    // 2. Foreground build arrives while speculative is still tearing down
    const fgPromise = queue.acquire('sess-fg', { priority: 'foreground' }).then((l) => {
      events.push('fg-acquired');
      return l;
    });

    const fgLease = await fgPromise;
    expect(events).toEqual([
      'spec-acquired',
      'spec-preempted',
      'spec-cleanup-done',
      'fg-acquired',
    ]);
    fgLease.release();

    // 3. deferSpeculativeFor holds back speculative builds during screenshot bursts while allowing foreground builds
    queue.deferSpeculativeFor(120);
    expect(queue.getStatus().speculativeDeferred).toBe(true);

    let specResolved = false;
    const deferredSpecPromise = queue
      .acquire('sess-spec-2', { priority: 'speculative' })
      .then((l) => {
        specResolved = true;
        return l;
      });

    await new Promise((r) => setTimeout(r, 30));
    expect(specResolved).toBe(false);

    // Foreground still acquires immediately even while speculative is deferred!
    const urgentFg = await queue.acquire('sess-fg-2', { priority: 'foreground' });
    urgentFg.release();

    const deferredSpecLease = await deferredSpecPromise;
    expect(specResolved).toBe(true);
    deferredSpecLease.release();
  });

  it('extracts and splices hunk-level conflict resolutions on large (>15 KB) .astro files without rewriting untouched lines', () => {
    const header = [
      '---',
      "import BaseLayout from '../layouts/BaseLayout.astro';",
      '---',
      '<BaseLayout title="Large Ministry Page">',
    ].join('\n');
    const fillerSection = Array.from(
      { length: 220 },
      (_, i) => `  <p data-row="${i}">Unchanged ministry paragraph line ${i} — preserved byte-for-byte.</p>`,
    ).join('\n');

    const marked = [
      header,
      '<<<<<<< ours',
      '  <h1>Welcome to Sunday Worship at 10:00 AM</h1>',
      '=======',
      '  <h1>Welcome to Sunday Worship — Main Sanctuary</h1>',
      '>>>>>>> theirs',
      fillerSection,
      '<<<<<<< ours',
      '  <footer>Questions? Email info@thecrossing.website</footer>',
      '=======',
      '  <footer>Questions? Visit the Welcome Table or email info@thecrossing.website</footer>',
      '>>>>>>> theirs',
      '</BaseLayout>',
      '',
    ].join('\n');

    expect(Buffer.byteLength(marked, 'utf8')).toBeGreaterThan(15_000);

    const hunks = parseMarkedConflictHunks(marked);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]?.oursBlock).toContain('10:00 AM');
    expect(hunks[0]?.theirsBlock).toContain('Main Sanctuary');
    expect(hunks[1]?.oursBlock).toContain('Questions? Email');

    const spliced = spliceResolvedHunks(marked, hunks, [
      { index: 1, replacement: '  <h1>Welcome to Sunday Worship at 10:00 AM — Main Sanctuary</h1>' },
      { index: 2, replacement: '  <footer>Questions? Visit the Welcome Table or email info@thecrossing.website</footer>' },
    ]);

    expect(spliced).not.toBeNull();
    expect(spliced).not.toContain('<<<<<<<');
    expect(spliced).not.toContain('=======');
    expect(spliced).not.toContain('>>>>>>>');
    expect(spliced).toContain(fillerSection);
    expect(spliced).toContain('10:00 AM — Main Sanctuary');
  });

  it('performs virtual git merge-tree conflict detection with ZERO <<<<<<< markers written to /workspace and isolates builds in verifySandboxDir', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'halley-v2-git-'));
    try {
      const bareUpstream = path.join(tmp, 'upstream.git');
      const authorClone = path.join(tmp, 'author');
      const sessionRepo = path.join(tmp, 'session');
      const verifySandbox = path.join(tmp, 'verify-sandbox');

      await execFileAsync('git', ['init', '--bare', '-b', 'main', bareUpstream]);
      await execFileAsync('git', ['clone', bareUpstream, authorClone]);
      await execFileAsync('git', ['config', 'user.name', 'Origin Bot'], { cwd: authorClone });
      await execFileAsync('git', ['config', 'user.email', 'origin@example.org'], { cwd: authorClone });

      await fs.mkdir(path.join(authorClone, 'src/pages'), { recursive: true });
      await fs.writeFile(
        path.join(authorClone, 'package.json'),
        JSON.stringify({
          name: 'v2-test-site',
          private: true,
          scripts: {
            check: 'node -e "process.exit(0)"',
            build:
              'node -e "const fs = require(\'fs\'); fs.mkdirSync(\'.astro\', { recursive: true }); fs.writeFileSync(\'.astro/build-cwd.txt\', process.cwd()); fs.mkdirSync(\'dist\', { recursive: true }); fs.writeFileSync(\'dist/index.html\', \'<h1>ok</h1>\')"',
          },
        }),
      );
      await fs.writeFile(
        path.join(authorClone, 'src/pages/index.astro'),
        '<h1>Sunday Service at 10:00 AM</h1>\n',
      );
      await execFileAsync('git', ['add', '-A'], { cwd: authorClone });
      await execFileAsync('git', ['commit', '-m', 'init'], { cwd: authorClone });
      await execFileAsync('git', ['push', 'origin', 'main'], { cwd: authorClone });

      // Clone session draft
      await execFileAsync('git', ['clone', bareUpstream, sessionRepo]);
      await execFileAsync('git', ['checkout', '-b', 'halley/s1'], { cwd: sessionRepo });

      // Upstream advances conflicting line on main
      await fs.writeFile(
        path.join(authorClone, 'src/pages/index.astro'),
        '<h1>Sunday Service at 10:30 AM (New Fall Schedule)</h1>\n',
      );
      await execFileAsync('git', ['commit', '-am', 'fall schedule'], { cwd: authorClone });
      await execFileAsync('git', ['push', 'origin', 'main'], { cwd: authorClone });

      // Session draft edits the same line
      const draftContent = '<h1>Sunday Service at 10:00 AM — Coffee at 9:30 AM</h1>\n';
      await fs.writeFile(path.join(sessionRepo, 'src/pages/index.astro'), draftContent);

      const res = await virtualMergeWithBase(sessionRepo, {
        baseBranch: 'main',
        identity: { name: 'Editor', email: 'editor@example.org' },
      });

      expect(res.status).toBe('conflict');
      expect(res.conflictedFiles).toEqual(['src/pages/index.astro']);

      // CRITICAL INVARIANT: /workspace has ZERO conflict markers and NO unmerged git index state!
      const diskContent = await fs.readFile(path.join(sessionRepo, 'src/pages/index.astro'), 'utf8');
      expect(diskContent).toBe(draftContent);
      expect(await findFilesWithConflictMarkers(sessionRepo, ['src/pages/index.astro'])).toEqual([]);
      const porcelain = await execFileAsync('git', ['status', '--porcelain'], { cwd: sessionRepo });
      expect(porcelain.stdout.trim()).toBe('');

      // Commit virtual resolution atomically via isolated index
      const commitRes = await commitVirtualMergeResolution(sessionRepo, {
        virtualTreeSha: res.virtualTreeSha,
        preSyncSha: res.preSyncSha,
        newBaseSha: res.newBaseSha,
        resolvedFiles: [
          {
            path: 'src/pages/index.astro',
            content: '<h1>Sunday Service at 10:30 AM — Coffee at 10:00 AM</h1>\n',
          },
        ],
        identity: { name: 'Editor', email: 'editor@example.org' },
      });
      expect(commitRes.ok).toBe(true);
      expect(await fs.readFile(path.join(sessionRepo, 'src/pages/index.astro'), 'utf8')).toContain(
        '10:30 AM — Coffee at 10:00 AM',
      );

      // Verify isolated sandbox build writes `dist/` inside verifySandbox, NEVER inside sessionRepo!
      await fs.writeFile(
        path.join(sessionRepo, 'src/pages/untracked-draft.astro'),
        '<h1>Untracked page</h1>\n',
      );
      const checkRes = await runAllVerificationChecks(sessionRepo, {
        verifySandboxDir: verifySandbox,
      });
      expect(checkRes.allPassed).toBe(true);

      // Build ran inside verifySandbox/workspace, kept .astro/ warm, reclaimed dist/, and never touched sessionRepo!
      const buildCwd = (
        await fs.readFile(path.join(verifySandbox, 'workspace', '.astro', 'build-cwd.txt'), 'utf8')
      ).trim();
      expect(await fs.realpath(buildCwd)).toBe(await fs.realpath(path.join(verifySandbox, 'workspace')));
      const sandboxUntrackedExists = await fs
        .access(path.join(verifySandbox, 'workspace', 'src', 'pages', 'untracked-draft.astro'))
        .then(() => true)
        .catch(() => false);
      const sessionAstroExists = await fs
        .access(path.join(sessionRepo, '.astro'))
        .then(() => true)
        .catch(() => false);
      expect(sandboxUntrackedExists).toBe(true);
      expect(sessionAstroExists).toBe(false);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
