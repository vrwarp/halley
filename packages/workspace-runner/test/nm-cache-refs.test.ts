/** Cross-process nm-cache coordination: prune never removes an entry another manager is linking from. */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NodeModulesCacheManager } from '../src/nm-cache.js';

const cleanup: string[] = [];
afterEach(async () => {
  for (const d of cleanup.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

async function readyEntry(cacheDir: string, hash: string, ageMs: number): Promise<void> {
  const dir = path.join(cacheDir, hash);
  await fs.mkdir(path.join(dir, 'node_modules/x'), { recursive: true });
  await fs.writeFile(path.join(dir, 'node_modules/x/index.js'), hash);
  const ready = path.join(dir, '.ready');
  await fs.writeFile(ready, 'x');
  const t = new Date(Date.now() - ageMs);
  await fs.utimes(ready, t, t);
}

describe('nm-cache shared references across managers', () => {
  it('prune in one manager skips entries another manager holds; dead holders do not block', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'halley-nmref-'));
    cleanup.push(root);
    const cacheDir = path.join(root, 'nm-cache');
    await readyEntry(cacheDir, 'newest', 1_000);
    await readyEntry(cacheDir, 'middle', 2_000);
    await readyEntry(cacheDir, 'oldest', 3_000);
    // two separate instances, as the supervisor and a runner process would have
    const linker = new NodeModulesCacheManager(cacheDir, path.join(root, 'pkg'), 1);
    const pruner = new NodeModulesCacheManager(cacheDir, path.join(root, 'pkg'), 1);
    const present = async () => (await fs.readdir(cacheDir)).filter((n) => !n.startsWith('.')).sort();

    const release = await linker.acquireSharedRef('oldest');
    expect(await pruner.hasForeignRefs('oldest')).toBe(true);
    expect(await linker.hasForeignRefs('oldest')).toBe(false); // own refs are tracked in-process
    await pruner.pruneOldCaches();
    expect(await present()).toEqual(['newest', 'oldest']); // middle pruned, referenced one kept

    await release();
    await pruner.pruneOldCaches();
    expect(await present()).toEqual(['newest']);

    // a reference left by a process that died (SIGKILL) never pins an entry forever
    await readyEntry(cacheDir, 'orphaned', 5_000);
    const refDir = path.join(cacheDir, '.refs', 'orphaned');
    await fs.mkdir(refDir, { recursive: true });
    await fs.writeFile(path.join(refDir, '2147483646-deadbeef-00000000'), '');
    await pruner.pruneOldCaches();
    expect(await present()).toEqual(['newest']);
    expect(await fs.readdir(refDir)).toEqual([]); // swept
  });
});
