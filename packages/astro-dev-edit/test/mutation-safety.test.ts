import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EditUndoStack,
  inspectAstroElement,
  mutateAstroElement,
  PerFileMutex,
  verifyMutatedSource,
  type ElementMutation,
} from '../src/index.js';

const REL = 'src/pages/index.astro';
const temps: string[] = [];

async function makeSite(source: string, extra: Record<string, string> = {}) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'halley-mutation-safety-'));
  temps.push(tmp);
  for (const [rel, content] of Object.entries({ [REL]: source, ...extra })) {
    const abs = path.join(tmp, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
  }
  return { tmp, abs: path.join(tmp, REL) };
}

afterEach(async () => {
  await Promise.all(temps.splice(0).map((t) => fs.rm(t, { recursive: true, force: true })));
});

async function mutate(
  tmp: string,
  loc: string,
  mutation: ElementMutation,
  opts: { expectedOuterHash?: string; expectedFileHash?: string; relFile?: string; lock?: PerFileMutex } = {},
) {
  const relFile = opts.relFile ?? REL;
  let expectedOuterHash = opts.expectedOuterHash;
  if (expectedOuterHash === undefined) {
    const src = await fs.readFile(path.join(tmp, relFile), 'utf8');
    expectedOuterHash = (await inspectAstroElement(src, loc, relFile))?.outerSnapshotHash ?? '';
  }
  return mutateAstroElement({
    repoRoot: tmp,
    relFile,
    loc,
    expectedOuterHash,
    expectedFileHash: opts.expectedFileHash,
    mutation,
    previewBase: '/',
    originalBase: '/',
    fileLock: opts.lock ?? new PerFileMutex(),
  });
}

describe('mutations never write a file that would not re-parse to the expected structure', () => {
  it('verifyMutatedSource rejects a dropped closing tag, an unexpected element count and a missing target', async () => {
    const original = '<div>\n  <p>One</p>\n  <p>Two</p>\n</div>\n';
    const brokenClose = '<div>\n  <p>One</p>\n  <p>Two</p>\n';
    const r1 = await verifyMutatedSource({
      originalSource: original,
      patchedSource: brokenClose,
      file: REL,
      expect: { elementDelta: 0, loc: null },
    });
    expect(r1.ok).toBe(false);

    const r2 = await verifyMutatedSource({
      originalSource: original,
      patchedSource: '<div>\n  <p>One</p>\n  <p>Two</p><p>Three</p>\n</div>\n',
      file: REL,
      expect: { elementDelta: 0, loc: null },
    });
    expect(r2.ok).toBe(false);

    const r3 = await verifyMutatedSource({
      originalSource: original,
      patchedSource: '<div>\n  <p>One</p>\n  <p>Two!</p>\n</div>\n',
      file: REL,
      expect: { elementDelta: 0, loc: '3:6', tagName: 'p', outerSource: '<p>Two</p>' },
    });
    expect(r3.ok).toBe(false);
  });

  // The compiler's end offset for unclosed / implicitly closed elements cuts mid-tag; before the
  // merge, `delete` on `<p>One` here wrote `<div>\n  v>\n`.
  it.each<[string, string, ElementMutation]>([
    ['<div>\n  <p>One\n  <p>Two</p>\n</div>\n', '2:3', { kind: 'delete' }],
    ['<div>\n  <section><p>a</p>\n</div>\n', '2:3', { kind: 'duplicate' }],
    ['<ul>\n  <li>One\n  <li>Two\n</ul>\n', '2:3', { kind: 'duplicate' }],
    ['<ul>\n  <li>One\n  <li>Two\n</ul>\n', '2:3', { kind: 'move', direction: 'down' }],
    ['<div>\n  <p class="x">a</p >\n  <p>b</p>\n</div>\n', '2:3', { kind: 'set-style', align: 'center' }],
    ['<div>\n  <p>One\n  <p>Two</p>\n</div>\n', '2:3', { kind: 'add-block', blockKind: 'paragraph' }],
  ])('refuses %j %s with 422 and leaves the file byte-identical', async (source, loc, mutation) => {
    const { tmp, abs } = await makeSite(source);
    const res = await mutate(tmp, loc, mutation, { expectedOuterHash: '' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe(422);
    expect(await fs.readFile(abs, 'utf8')).toBe(source);
    expect((await fs.readdir(path.dirname(abs))).filter((f) => f.includes('halley-tmp'))).toEqual([]);
  });

  it('refuses set:html / set:text / is:raw elements and non-.astro files', async () => {
    const source = '<main>\n  <div set:html={html} class="a"></div>\n  <p is:raw class="b">{x}</p>\n  <p>ok</p>\n</main>\n';
    const { tmp, abs } = await makeSite(source, { 'src/data/x.md': '<p>hi</p>\n' });
    for (const loc of ['2:3', '3:3']) {
      const res = await mutate(tmp, loc, { kind: 'set-style', align: 'center' });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe(422);
        expect(res.error).toMatch(/set:html|is:raw/);
      }
      const dup = await mutate(tmp, loc, { kind: 'duplicate' });
      expect(dup.ok).toBe(false);
    }
    expect(await fs.readFile(abs, 'utf8')).toBe(source);

    const md = await mutate(tmp, '1:1', { kind: 'delete' }, { relFile: 'src/data/x.md', expectedOuterHash: 'x' });
    expect(md.ok).toBe(false);
    if (!md.ok) expect(md.code).toBe(400);
    const escape = await mutate(tmp, '1:1', { kind: 'delete' }, { relFile: '../outside.astro', expectedOuterHash: 'x' });
    expect(escape.ok).toBe(false);
    if (!escape.ok) expect(escape.code).toBe(400);
  });

  it('refuses every mutation when the Astro compat gate disables direct editing', async () => {
    const source = '<main>\n  <h1>T</h1>\n  <p class="a">One</p>\n</main>\n';
    const { tmp, abs } = await makeSite(source, {
      'node_modules/astro/package.json': JSON.stringify({ name: 'astro', version: '4.16.0', main: 'index.js' }),
      'node_modules/astro/index.js': 'module.exports = {};\n',
      'package.json': JSON.stringify({ name: 'site', dependencies: { astro: '4.16.0' } }),
    });
    const res = await mutate(tmp, '3:3', { kind: 'set-style', align: 'center' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe(422);
      expect(res.error).toMatch(/Inline editing is disabled/);
    }
    expect(await fs.readFile(abs, 'utf8')).toBe(source);
  });
});

describe('mutation staleness', () => {
  it('returns Astro 5 locs (after the opening `>`) that inspect back to the mutated element', async () => {
    const source = '<main>\n  <h1>T</h1>\n  <ul>\n    <li class="a">One</li>\n    <li class="a">Two</li>\n  </ul>\n</main>\n';
    const { tmp, abs } = await makeSite(source);
    const dup = await mutate(tmp, '4:5', { kind: 'duplicate' });
    expect(dup.ok).toBe(true);
    if (!dup.ok) return;
    const after = await fs.readFile(abs, 'utf8');
    expect(dup.newLoc).toBe(`5:${'    <li class="a">'.length + 1}`);
    expect((await inspectAstroElement(after, dup.newLoc, REL))?.innerSource).toBe('One');
    expect(dup.subtreeLocs).toEqual([dup.newLoc]);

    const style = await mutate(tmp, dup.newLoc, { kind: 'set-style', align: 'center' });
    expect(style.ok).toBe(true);
    if (style.ok) {
      const re = await inspectAstroElement(await fs.readFile(abs, 'utf8'), style.newLoc, REL);
      expect(re?.outerSource).toBe('<li class="a text-center">One</li>');
      expect(re?.outerSnapshotHash).toBe(style.newOuterHash);
    }
  });

  it('relocates by content when the file changed since inspect, and 409s when ambiguous or gone', async () => {
    const source = '<main>\n  <h1>T</h1>\n  <p class="a">Target</p>\n  <p class="a">Other</p>\n</main>\n';
    const { tmp, abs } = await makeSite(source);
    const info = (await inspectAstroElement(source, '3:3', REL))!;

    // A line inserted above: the stale loc 3:3 now points at the inserted <p>.
    await fs.writeFile(abs, source.replace('<h1>T</h1>\n', '<h1>T</h1>\n  <p class="a">Inserted</p>\n'));
    const moved = await mutate(tmp, '3:3', { kind: 'set-style', align: 'center' }, {
      expectedOuterHash: info.outerSnapshotHash,
      expectedFileHash: info.fileHash,
    });
    expect(moved.ok).toBe(true);
    if (moved.ok) expect(moved.relocated).toBe(true);
    const afterMove = await fs.readFile(abs, 'utf8');
    expect(afterMove).toContain('<p class="a">Inserted</p>');
    expect(afterMove).toContain('<p class="a text-center">Target</p>');

    // Without a file hash (old clients) a stale loc whose content differs is a 409, never a mis-edit.
    const before = await fs.readFile(abs, 'utf8');
    const stale = await mutate(tmp, '3:3', { kind: 'delete' }, { expectedOuterHash: info.outerSnapshotHash });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.code).toBe(409);

    // The element now exists twice: relocation is ambiguous -> 409, file untouched.
    const dupInfo = (await inspectAstroElement(before, '5:3', REL))!;
    await fs.writeFile(abs, before.replace('<p class="a">Other</p>', '<p class="a">Other</p>\n  <p class="a">Other</p>'));
    const ambiguous = await mutate(tmp, '5:3', { kind: 'delete' }, {
      expectedOuterHash: dupInfo.outerSnapshotHash,
      expectedFileHash: dupInfo.fileHash,
    });
    expect(ambiguous.ok).toBe(false);
    if (!ambiguous.ok) {
      expect(ambiguous.code).toBe(409);
      expect(ambiguous.error).toMatch(/no longer unique/);
    }
    expect((await fs.readFile(abs, 'utf8')).match(/Other/g)).toHaveLength(2);
  });
});

describe('undo/redo never restores stale content over newer edits', () => {
  it('409s an undo after a newer edit to the file, keeps the entry, and does not clobber', async () => {
    const source = '<main>\n  <h1>T</h1>\n  <p class="a">One</p>\n</main>\n';
    const { tmp, abs } = await makeSite(source);
    const lock = new PerFileMutex();
    const stack = new EditUndoStack();
    const res = await mutate(tmp, '3:3', { kind: 'set-style', align: 'center' }, { lock });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    stack.push({ relFile: REL, summary: res.summary, beforeSource: res.beforeSource, afterSource: res.afterSource });

    // A newer edit that is not on this stack (agent, another runner/tab).
    const newer = res.afterSource.replace('One', 'One (agent)');
    await fs.writeFile(abs, newer);
    const undo = await stack.undo(tmp, lock);
    expect(undo.ok).toBe(false);
    if (!undo.ok) {
      expect(undo.code).toBe(409);
      expect(undo.canUndo).toBe(true);
    }
    expect(await fs.readFile(abs, 'utf8')).toBe(newer);

    // Once the newer edit is reverted the entry is valid again; redo is likewise guarded.
    await fs.writeFile(abs, res.afterSource);
    expect((await stack.undo(tmp, lock)).ok).toBe(true);
    expect(await fs.readFile(abs, 'utf8')).toBe(source);
    await fs.writeFile(abs, source.replace('One', 'Changed after undo'));
    const redo = await stack.redo(tmp, lock);
    expect(redo.ok).toBe(false);
    if (!redo.ok) expect(redo.code).toBe(409);
    expect(await fs.readFile(abs, 'utf8')).toContain('Changed after undo');
  });

  it('undoes stacked edits to one file in order and ignores no-op entries', async () => {
    const source = '<main>\n  <h1>T</h1>\n  <p class="a">One</p>\n</main>\n';
    const { tmp, abs } = await makeSite(source);
    const lock = new PerFileMutex();
    const stack = new EditUndoStack();
    const a = await mutate(tmp, '3:3', { kind: 'set-style', align: 'center' }, { lock });
    if (!a.ok) throw new Error(a.error);
    stack.push({ relFile: REL, summary: a.summary, beforeSource: a.beforeSource, afterSource: a.afterSource });
    const b = await mutate(tmp, a.newLoc, { kind: 'duplicate' }, { lock });
    if (!b.ok) throw new Error(b.error);
    stack.push({ relFile: REL, summary: b.summary, beforeSource: b.beforeSource, afterSource: b.afterSource });
    stack.push({ relFile: REL, summary: 'noop', beforeSource: b.afterSource, afterSource: b.afterSource });
    expect(stack.getStatus().undoCount).toBe(2);

    expect((await stack.undo(tmp, lock)).ok).toBe(true);
    expect(await fs.readFile(abs, 'utf8')).toBe(a.afterSource);
    expect((await stack.undo(tmp, lock)).ok).toBe(true);
    expect(await fs.readFile(abs, 'utf8')).toBe(source);
  });

  it('refuses to restore a non-.astro or out-of-repo path', async () => {
    const { tmp } = await makeSite('<p>x</p>\n');
    const stack = new EditUndoStack();
    stack.push({ relFile: 'package.json', summary: 's', beforeSource: '{}', afterSource: '{"a":1}' });
    const r = await stack.undo(tmp, new PerFileMutex());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(400);
    stack.push({ relFile: '../x.astro', summary: 's', beforeSource: 'a', afterSource: 'b' });
    const r2 = await stack.undo(tmp, new PerFileMutex());
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.code).toBe(400);
  });
});
