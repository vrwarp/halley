import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  inspectAstroElement,
  PerFileMutex,
  patchStaticSpan,
  verifyPatchedSource,
  type PatchStaticSpanInput,
} from '../src/index.js';

let tmp: string;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'halley-patch-safety-'));
  await fs.mkdir(path.join(tmp, 'src/pages'), { recursive: true });
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

async function writePage(rel: string, source: string) {
  await fs.writeFile(path.join(tmp, rel), source);
}

function baseInput(over: Partial<PatchStaticSpanInput>): PatchStaticSpanInput {
  return {
    repoRoot: tmp,
    relFile: 'src/pages/index.astro',
    loc: '2:3',
    expectedHash: '',
    newHtml: 'Updated',
    previewBase: '/p/s1',
    originalBase: '/',
    fileLock: new PerFileMutex(),
    ...over,
  };
}

async function listTempFiles(): Promise<string[]> {
  return (await fs.readdir(path.join(tmp, 'src/pages'))).filter((f) => f.includes('.halley-tmp-'));
}

describe('verifyPatchedSource (patched file must parse)', () => {
  const original = '<main>\n  <p>Hello</p>\n</main>\n';

  it('accepts a well-formed patch', async () => {
    const res = await verifyPatchedSource({
      originalSource: original,
      patchedSource: '<main>\n  <p>Hi <em>there</em></p>\n</main>\n',
      newLoc: '2:3',
      expectedTagName: 'p',
      expectedInner: 'Hi <em>there</em>',
    });
    expect(res.ok).toBe(true);
  });

  it('rejects a patch that introduces a compiler error', async () => {
    const res = await verifyPatchedSource({
      originalSource: original,
      patchedSource: '<main>\n  <p>Hi <span title="oops>x</span></p>\n</main>\n',
      newLoc: '2:3',
      expectedTagName: 'p',
      expectedInner: 'Hi <span title="oops>x</span>',
    });
    expect(res.ok).toBe(false);
  });

  it('rejects a patch whose element no longer contains exactly what was written', async () => {
    const res = await verifyPatchedSource({
      originalSource: original,
      patchedSource: '<main>\n  <p>a</p><p>b</p>\n</main>\n',
      newLoc: '2:3',
      expectedTagName: 'p',
      expectedInner: 'a</p><p>b',
    });
    expect(res.ok).toBe(false);
  });

  it('rejects when the element cannot be re-found at the new loc', async () => {
    const missing = await verifyPatchedSource({
      originalSource: original,
      patchedSource: '<main>\n  Hi\n</main>\n',
      newLoc: '2:3',
      expectedTagName: 'p',
      expectedInner: 'Hi',
    });
    expect(missing.ok).toBe(false);
    const res = await verifyPatchedSource({
      originalSource: original,
      patchedSource: '<main>\n  <div>Hi</div>\n</main>\n',
      newLoc: '2:3',
      expectedTagName: 'p',
      expectedInner: 'Hi',
    });
    expect(res.ok).toBe(false);
  });
});

describe('patchStaticSpan safety', () => {
  for (const directive of ['set:html={"<b>x</b>"}', 'set:text="literal"', 'is:raw']) {
    it(`rejects elements carrying ${directive.split(/[={]/)[0]} (422, file unchanged)`, async () => {
      const source = `<main>\n  <p ${directive}>Hello</p>\n</main>\n`;
      await writePage('src/pages/index.astro', source);
      const inspected = await inspectAstroElement(source, '2:3');
      expect(inspected?.editability).toBe('dynamic');
      const res = await patchStaticSpan(baseInput({ expectedHash: inspected?.snapshotHash ?? '' }));
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe(422);
      expect(await fs.readFile(path.join(tmp, 'src/pages/index.astro'), 'utf8')).toBe(source);
    });
  }

  it('rejects set:html on a nested inline element', async () => {
    const source = '<main>\n  <p>Hi <span set:html="<b>x</b>"></span></p>\n</main>\n';
    const inspected = await inspectAstroElement(source, '2:3');
    expect(inspected?.editability).toBe('dynamic');
  });

  it('rejects non-.astro files (400) without touching them', async () => {
    for (const rel of ['src/pages/index.md', 'src/pages/index.ts', 'src/pages/index.astro.bak']) {
      const source = '<main>\n  <p>Hello</p>\n</main>\n';
      await writePage(rel, source);
      const inspected = await inspectAstroElement(source, '2:3');
      const res = await patchStaticSpan(baseInput({ relFile: rel, expectedHash: inspected!.snapshotHash }));
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe(400);
      expect(await fs.readFile(path.join(tmp, rel), 'utf8')).toBe(source);
    }
  });

  it('serializes concurrent patches on one file through PerFileMutex (no lost update, stale hash -> 409)', async () => {
    const source = '<main>\n  <p>One</p>\n  <p>Two</p>\n  <p>Three</p>\n</main>\n';
    await writePage('src/pages/index.astro', source);
    const lock = new PerFileMutex();
    const hashAt = async (loc: string) => (await inspectAstroElement(source, loc))!.snapshotHash;
    const [h2, h3, h4] = await Promise.all([hashAt('2:3'), hashAt('3:3'), hashAt('4:3')]);

    const results = await Promise.all([
      patchStaticSpan(baseInput({ fileLock: lock, loc: '2:3', expectedHash: h2, newHtml: 'Uno' })),
      patchStaticSpan(baseInput({ fileLock: lock, loc: '3:3', expectedHash: h3, newHtml: 'Dos' })),
      patchStaticSpan(baseInput({ fileLock: lock, loc: '4:3', expectedHash: h4, newHtml: 'Tres' })),
      // Same element as the first patch, with the now-stale original hash.
      patchStaticSpan(baseInput({ fileLock: lock, loc: '2:3', expectedHash: h2, newHtml: 'Eins' })),
    ]);
    expect(results.slice(0, 3).every((r) => r.ok)).toBe(true);
    const last = results[3]!;
    expect(last.ok).toBe(false);
    if (!last.ok) expect(last.code).toBe(409);

    const final = await fs.readFile(path.join(tmp, 'src/pages/index.astro'), 'utf8');
    expect(final).toBe('<main>\n  <p>Uno</p>\n  <p>Dos</p>\n  <p>Tres</p>\n</main>\n');
    expect(lock.isLocked('src/pages/index.astro')).toBe(false);
    expect(await listTempFiles()).toEqual([]);
  });
});
