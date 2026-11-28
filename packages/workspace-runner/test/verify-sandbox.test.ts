/** The shared verify sandbox never reuses another session's dependency tree or a stale `.astro/`. */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { syncVerifySandboxToTree } from '../src/verify.js';

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await exec('git', args, { cwd })).stdout.trim();
const cleanup: string[] = [];
afterEach(async () => {
  for (const d of cleanup.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

async function session(root: string, name: string, deps: Record<string, string>): Promise<{ repo: string; tree: string }> {
  const repo = path.join(root, name);
  await fs.mkdir(path.join(repo, 'src/pages'), { recursive: true });
  await git(repo, 'init', '-q', '-b', 'main');
  await fs.writeFile(path.join(repo, 'package.json'), JSON.stringify({ name, dependencies: deps }));
  await fs.writeFile(path.join(repo, 'astro.config.mjs'), 'export default {};\n');
  await fs.writeFile(path.join(repo, 'src/pages/index.astro'), `<p>${name}</p>\n`);
  await fs.writeFile(path.join(repo, '.gitignore'), 'node_modules\n');
  await git(repo, 'add', '-A');
  await git(repo, '-c', 'user.name=T', '-c', 'user.email=t@x.test', 'commit', '-qm', 'init');
  // the session's own installed tree (marker file tells them apart)
  await fs.mkdir(path.join(repo, 'node_modules/astro'), { recursive: true });
  await fs.writeFile(path.join(repo, 'node_modules/astro/owner.txt'), name);
  return { repo, tree: await git(repo, 'rev-parse', 'HEAD^{tree}') };
}

describe('shared verify sandbox', () => {
  it('points node_modules at the current session and wipes .astro/ when deps or astro config differ', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'halley-vsb-'));
    cleanup.push(root);
    process.env.HALLEY_NPM_VERSION = '10.0.0'; // deterministic dependency hash, no npm spawn
    try {
      const sandbox = path.join(root, 'verify-sandbox');
      const a = await session(root, 'a', { astro: '5.0.0' });
      const b = await session(root, 'b', { astro: '5.1.0', sharp: '0.33.0' });
      const owner = async (dir: string) => fs.readFile(path.join(dir, 'node_modules/astro/owner.txt'), 'utf8');
      const astroMarker = (dir: string) => path.join(dir, '.astro/data-store.json');

      const dirA = await syncVerifySandboxToTree(a.repo, a.tree, sandbox);
      expect(await owner(dirA)).toBe('a');
      await fs.mkdir(path.join(dirA, '.astro'), { recursive: true });
      await fs.writeFile(astroMarker(dirA), '{"from":"a"}');

      // same session again: the warm .astro cache is kept
      await syncVerifySandboxToTree(a.repo, a.tree, sandbox);
      expect(await fs.readFile(astroMarker(dirA), 'utf8')).toBe('{"from":"a"}');

      // another session with different dependencies: its own tree, cold .astro
      const dirB = await syncVerifySandboxToTree(b.repo, b.tree, sandbox);
      expect(dirB).toBe(dirA);
      expect(await owner(dirB)).toBe('b');
      await expect(fs.stat(astroMarker(dirB))).rejects.toMatchObject({ code: 'ENOENT' });

      // same deps but an astro config change also invalidates the cache
      await fs.mkdir(path.join(dirB, '.astro'), { recursive: true });
      await fs.writeFile(astroMarker(dirB), '{"from":"b"}');
      await fs.writeFile(path.join(b.repo, 'astro.config.mjs'), 'export default { base: "/x" };\n');
      await git(b.repo, 'add', '-A');
      await git(b.repo, '-c', 'user.name=T', '-c', 'user.email=t@x.test', 'commit', '-qm', 'config');
      const tree2 = await git(b.repo, 'rev-parse', 'HEAD^{tree}');
      await syncVerifySandboxToTree(b.repo, tree2, sandbox);
      await expect(fs.stat(astroMarker(dirB))).rejects.toMatchObject({ code: 'ENOENT' });

      // a session without its own node_modules never inherits the previous session's link
      await fs.rm(path.join(a.repo, 'node_modules'), { recursive: true, force: true });
      await syncVerifySandboxToTree(a.repo, a.tree, sandbox);
      await expect(fs.lstat(path.join(dirA, 'node_modules'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      delete process.env.HALLEY_NPM_VERSION;
    }
  });
});
