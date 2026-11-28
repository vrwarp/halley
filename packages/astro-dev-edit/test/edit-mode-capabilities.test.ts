import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyTailwindStylePresets,
  EditUndoStack,
  inspectAstroElement,
  listSiteImages,
  mutateAstroElement,
  patchStaticSpan,
  PerFileMutex,
  rewriteOpeningTagAttrs,
  serializeHtmlToAstro,
  writeSiteImage,
} from '../src/index.js';

async function makeTempSite(files: Record<string, string>) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'halley-edit-caps-'));
  await fs.mkdir(path.join(tmp, 'src/lib'), { recursive: true });
  await fs.writeFile(path.join(tmp, 'src/lib/url.ts'), 'export const url = (p: string) => p;\n');
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(tmp, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
  }
  return tmp;
}

describe('expanded Edit Mode capabilities & AST safety', () => {
  it('detects loops/conditionals, shared components, sole h1, and landmarks accurately', async () => {
    const src = `---
const items = ['One', 'Two'];
const showBanner = true;
---
<main>
  <h1>Welcome</h1>
  <p class="mt-4">Static paragraph</p>
  <ul>
    {items.map((item) => (
      <li class="item"><span>Static label</span> {item}</li>
    ))}
  </ul>
  {showBanner && <p class="banner">Special announcement</p>}
</main>
`;
    // Line 5: <main> -> landmark, structural blocked
    const mainEl = await inspectAstroElement(src, '5:1', 'src/pages/index.astro');
    expect(mainEl?.capabilities.structural.canDelete).toBe(false);
    expect(mainEl?.capabilities.structural.canDuplicate).toBe(false);

    // Line 6: sole <h1> -> canDuplicate true, canDelete false (SEO protection)
    const h1El = await inspectAstroElement(src, '6:3', 'src/pages/index.astro');
    expect(h1El?.capabilities.text).toBe(true);
    expect(h1El?.capabilities.structural.canDuplicate).toBe(true);
    expect(h1El?.capabilities.structural.canDelete).toBe(false);
    expect(h1El?.capabilities.structural.canMoveDown).toBe(true);
    expect(h1El?.capabilities.structural.canMoveUp).toBe(false);

    // Line 7: <p> -> canMoveUp true, canDelete true
    const pEl = await inspectAstroElement(src, '7:3', 'src/pages/index.astro');
    expect(pEl?.context.inLoopOrConditional).toBe(false);
    expect(pEl?.context.isSharedFile).toBe(false);
    expect(pEl?.capabilities.structural.canMoveUp).toBe(true);
    expect(pEl?.capabilities.structural.canDelete).toBe(true);

    // Line 10: <span> inside .map() -> inLoopOrConditional true, text editable, structural HARD-BLOCKED
    const loopSpanCol = src.split('\n')[9]!.indexOf('<span>') + 1;
    const loopSpan = await inspectAstroElement(src, `10:${loopSpanCol}`, 'src/pages/index.astro');
    expect(loopSpan?.context.inLoopOrConditional).toBe(true);
    expect(loopSpan?.capabilities.text).toBe(true);
    expect(loopSpan?.capabilities.structural.canDelete).toBe(false);
    expect(loopSpan?.capabilities.structural.canDuplicate).toBe(false);
    expect(loopSpan?.capabilities.structural.canAddAfter).toBe(false);

    // Line 13: <p> inside {showBanner && ...} -> inLoopOrConditional true, text editable, structural blocked
    const condCol = src.split('\n')[12]!.indexOf('<p ') + 1;
    const condP = await inspectAstroElement(src, `13:${condCol}`, 'src/pages/index.astro');
    expect(condP?.context.inLoopOrConditional).toBe(true);
    expect(condP?.capabilities.text).toBe(true);
    expect(condP?.capabilities.structural.canDelete).toBe(false);

    // Shared component detection
    const sharedP = await inspectAstroElement(src, '7:3', 'src/components/Banner.astro');
    expect(sharedP?.context.isSharedFile).toBe(true);
  });

  it('supports extended inline tags (u, s/del, code, small, sup, sub) in classifier & serializer', async () => {
    const src = `<p>Use <u>underline</u>, <s>strike</s>, <code>npm run dev</code>, and <small>note<sup>1</sup></small>.</p>`;
    const info = await inspectAstroElement(src, '1:1');
    expect(info?.editability).toBe('editable-static');

    const serialized = serializeHtmlToAstro(
      'Check <u>this</u> <del>old</del> <code>code</code> <small>fine<sub>2</sub></small>',
      { previewBase: '/', originalBase: '/', hasUrlHelperFile: false },
    );
    expect(serialized.astroSource).toBe(
      'Check <u>this</u> <s>old</s> <code>code</code> <small>fine<sub>2</sub></small>',
    );
  });

  it('edits href and target="_blank" on clickable container <a> cards and injects url() import', async () => {
    const tmp = await makeTempSite({
      'src/pages/connect.astro': `---
const title = 'Connect';
---
<main>
  <a href="/old-page" class="card">
    <h3>Youth Ministry</h3>
    <p>Friday nights at 7pm</p>
  </a>
</main>
`,
    });
    try {
      const abs = path.join(tmp, 'src/pages/connect.astro');
      const src = await fs.readFile(abs, 'utf8');
      const info = await inspectAstroElement(src, '5:3', 'src/pages/connect.astro');
      // Container <a> is NOT inline text-editable, but DOES have link capability!
      expect(info?.editability).toBe('dynamic');
      expect(info?.capabilities.link?.canEdit).toBe(true);
      expect(info?.capabilities.link?.href).toBe('/old-page');

      const lock = new PerFileMutex();
      const res = await mutateAstroElement({
        repoRoot: tmp,
        relFile: 'src/pages/connect.astro',
        loc: '5:3',
        expectedOuterHash: info!.outerSnapshotHash,
        mutation: { kind: 'set-link', href: '/get-connected/youth', openInNewTab: true },
        previewBase: '/p/s1/thecrossing.website',
        originalBase: '/thecrossing.website',
        fileLock: lock,
      });
      expect(res.ok).toBe(true);
      const updated = await fs.readFile(abs, 'utf8');
      expect(updated).toContain(`import { url } from '../lib/url';`);
      expect(updated).toContain(
        `<a href={url('/get-connected/youth')} class="card" target="_blank" rel="noopener noreferrer">`,
      );
      expect(updated).toContain('<h3>Youth Ministry</h3>');
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('replaces static <img> src and alt while blocking dynamic src={item.cover}', async () => {
    const tmp = await makeTempSite({
      'src/pages/gallery.astro': `---
const item = { cover: '/images/dynamic.webp' };
---
<main>
  <img src="/images/community/old.webp" alt="Old caption" class="w-full object-center" />
  <img src={item.cover} alt="Dynamic" />
</main>
`,
    });
    try {
      const abs = path.join(tmp, 'src/pages/gallery.astro');
      const src = await fs.readFile(abs, 'utf8');
      const staticImg = await inspectAstroElement(src, '5:3', 'src/pages/gallery.astro');
      expect(staticImg?.capabilities.image?.canEditSrc).toBe(true);
      expect(staticImg?.capabilities.image?.canEditAlt).toBe(true);
      expect(staticImg?.capabilities.style?.supportsFocal).toBe(true);
      expect(staticImg?.capabilities.style?.objectPosition).toBe('center');

      const dynImg = await inspectAstroElement(src, '6:3', 'src/pages/gallery.astro');
      expect(dynImg?.capabilities.image?.canEditSrc).toBe(false);
      expect(dynImg?.capabilities.image?.canEditAlt).toBe(true);

      const lock = new PerFileMutex();
      const res = await mutateAstroElement({
        repoRoot: tmp,
        relFile: 'src/pages/gallery.astro',
        loc: '5:3',
        expectedOuterHash: staticImg!.outerSnapshotHash,
        mutation: { kind: 'set-image', src: '/images/community/new-photo.webp', alt: 'New youth photo' },
        previewBase: '/p/s1/site',
        originalBase: '/site',
        fileLock: lock,
      });
      expect(res.ok).toBe(true);
      const updated = await fs.readFile(abs, 'utf8');
      expect(updated).toContain(
        `<img src={url('/images/community/new-photo.webp')} alt="New youth photo" class="w-full object-center" />`,
      );
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('swaps Tailwind preset classes while preserving responsive variants and rejecting class:list', async () => {
    expect(
      applyTailwindStylePresets(['md:text-left', 'text-left', 'text-stone-900', 'my-4'], {
        align: 'center',
        spacing: 'spacious',
      }),
    ).toEqual(['md:text-left', 'text-stone-900', 'text-center', 'my-12']);

    expect(
      applyTailwindStylePresets(['w-full', 'object-[50%_45%]', 'md:object-center'], {
        objectPosition: 'top',
      }),
    ).toEqual(['w-full', 'md:object-center', 'object-top']);

    const tmp = await makeTempSite({
      'src/pages/style.astro': `<main>
  <p class="mt-4 md:text-left text-left text-stone-800">Hello</p>
  <p class:list={['mt-4', true && 'font-bold']}>Dynamic</p>
</main>
`,
    });
    try {
      const abs = path.join(tmp, 'src/pages/style.astro');
      const src = await fs.readFile(abs, 'utf8');
      const p1 = await inspectAstroElement(src, '2:3', 'src/pages/style.astro');
      const p2 = await inspectAstroElement(src, '3:3', 'src/pages/style.astro');
      expect(p1?.capabilities.style?.canEdit).toBe(true);
      expect(p2?.capabilities.style?.canEdit).toBe(false);

      const lock = new PerFileMutex();
      const res = await mutateAstroElement({
        repoRoot: tmp,
        relFile: 'src/pages/style.astro',
        loc: '2:3',
        expectedOuterHash: p1!.outerSnapshotHash,
        mutation: { kind: 'set-style', align: 'center', spacing: 'normal' },
        previewBase: '/',
        originalBase: '/',
        fileLock: lock,
      });
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.appliedClass).toBe('mt-4 md:text-left text-stone-800 text-center my-6');
      }
      const updated = await fs.readFile(abs, 'utf8');
      expect(updated).toContain('class="mt-4 md:text-left text-stone-800 text-center my-6"');
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('performs duplicate (stripping ids), move up/down, add-block (inheriting sibling class), and delete with guardrails', async () => {
    const tmp = await makeTempSite({
      'src/pages/blocks.astro': `<main>
  <h1>Title</h1>
  <ul class="space-y-2">
    <li id="first-item" class="text-stone-800">First</li>
    <li class="text-stone-800">Second</li>
  </ul>
</main>
`,
    });
    try {
      const abs = path.join(tmp, 'src/pages/blocks.astro');
      const lock = new PerFileMutex();

      // 1. Duplicate first <li> -> strips id="first-item" and returns valid subtreeLocs
      let src = await fs.readFile(abs, 'utf8');
      const li1 = await inspectAstroElement(src, '4:5', 'src/pages/blocks.astro');
      const dup = await mutateAstroElement({
        repoRoot: tmp,
        relFile: 'src/pages/blocks.astro',
        loc: '4:5',
        expectedOuterHash: li1!.outerSnapshotHash,
        mutation: { kind: 'duplicate' },
        previewBase: '/',
        originalBase: '/',
        fileLock: lock,
      });
      expect(dup.ok).toBe(true);
      src = await fs.readFile(abs, 'utf8');
      expect(src).toContain('<li id="first-item" class="text-stone-800">First</li>');
      expect(src).toContain('<li class="text-stone-800">First</li>');
      if (dup.ok) {
        expect(dup.subtreeLocs?.length).toBe(1);
        const dupInspected = await inspectAstroElement(src, dup.newLoc, 'src/pages/blocks.astro');
        expect(dupInspected?.innerSource).toBe('First');
      }

      // 2. Move the duplicated <li> (line 5) down past "Second" (line 6)
      const dupInfo = await inspectAstroElement(src, '5:5', 'src/pages/blocks.astro');
      const moved = await mutateAstroElement({
        repoRoot: tmp,
        relFile: 'src/pages/blocks.astro',
        loc: '5:5',
        expectedOuterHash: dupInfo!.outerSnapshotHash,
        mutation: { kind: 'move', direction: 'down' },
        previewBase: '/',
        originalBase: '/',
        fileLock: lock,
      });
      expect(moved.ok).toBe(true);
      src = await fs.readFile(abs, 'utf8');
      const lines = src.split('\n');
      expect(lines[4]).toContain('Second');
      expect(lines[5]).toContain('First');

      // 3. Add a new list-item after line 6 -> inherits class="text-stone-800"
      const lastLi = await inspectAstroElement(src, '6:5', 'src/pages/blocks.astro');
      const added = await mutateAstroElement({
        repoRoot: tmp,
        relFile: 'src/pages/blocks.astro',
        loc: '6:5',
        expectedOuterHash: lastLi!.outerSnapshotHash,
        mutation: { kind: 'add-block', blockKind: 'list-item' },
        previewBase: '/',
        originalBase: '/',
        fileLock: lock,
      });
      expect(added.ok).toBe(true);
      src = await fs.readFile(abs, 'utf8');
      expect(src).toContain('<li class="text-stone-800">New list item</li>');

      // 4. Delete the newly added <li>
      if (added.ok) {
        const addedInfo = await inspectAstroElement(src, added.newLoc, 'src/pages/blocks.astro');
        const del = await mutateAstroElement({
          repoRoot: tmp,
          relFile: 'src/pages/blocks.astro',
          loc: added.newLoc,
          expectedOuterHash: addedInfo!.outerSnapshotHash,
          mutation: { kind: 'delete' },
          previewBase: '/',
          originalBase: '/',
          fileLock: lock,
        });
        expect(del.ok).toBe(true);
        src = await fs.readFile(abs, 'utf8');
        expect(src).not.toContain('New list item');
      }

      // 5. Guardrail: deleting sole <h1> is rejected with 422
      const h1 = await inspectAstroElement(src, '2:3', 'src/pages/blocks.astro');
      const delH1 = await mutateAstroElement({
        repoRoot: tmp,
        relFile: 'src/pages/blocks.astro',
        loc: '2:3',
        expectedOuterHash: h1!.outerSnapshotHash,
        mutation: { kind: 'delete' },
        previewBase: '/',
        originalBase: '/',
        fileLock: lock,
      });
      expect(delH1.ok).toBe(false);
      if (!delH1.ok) expect(delH1.code).toBe(422);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('lists and non-destructively writes site images into matching public/images/<folder>/', async () => {
    const tmp = await makeTempSite({});
    try {
      await fs.mkdir(path.join(tmp, 'public/images/community'), { recursive: true });
      await fs.writeFile(path.join(tmp, 'public/images/community/youth.webp'), Buffer.from('old-bytes'));

      const listed = await listSiteImages(tmp);
      expect(listed.map((i) => i.path)).toEqual(['/images/community/youth.webp']);

      // Uploading a file with the same name must NOT overwrite the existing file
      const saved = await writeSiteImage({
        repoRoot: tmp,
        filename: 'youth.png',
        bytes: Buffer.from('new-png-bytes'),
        existingSrc: '/images/community/youth.webp',
        previewBase: '/p/s1/site',
        originalBase: '/site',
        convertImage: async (b) => ({ bytes: b, ext: '.webp' }),
      });
      expect(saved.publicPath).toMatch(/^\/images\/community\/youth-[a-f0-9]{6}\.webp$/);
      // Original file untouched
      expect((await fs.readFile(path.join(tmp, 'public/images/community/youth.webp'))).toString()).toBe('old-bytes');
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('supports EditUndoStack undo/redo and returns 409 if file changed externally', async () => {
    const tmp = await makeTempSite({
      'src/pages/undo.astro': `<main>\n  <p>Original</p>\n</main>\n`,
    });
    try {
      const abs = path.join(tmp, 'src/pages/undo.astro');
      const lock = new PerFileMutex();
      const stack = new EditUndoStack();

      const before = await fs.readFile(abs, 'utf8');
      const info = await inspectAstroElement(before, '2:3', 'src/pages/undo.astro');
      const patched = await patchStaticSpan({
        repoRoot: tmp,
        relFile: 'src/pages/undo.astro',
        loc: '2:3',
        expectedHash: info!.snapshotHash,
        newHtml: 'Updated',
        previewBase: '/',
        originalBase: '/',
        fileLock: lock,
      });
      expect(patched.ok).toBe(true);
      if (patched.ok) {
        stack.push({
          relFile: 'src/pages/undo.astro',
          summary: 'Edited text',
          beforeSource: patched.beforeSource,
          afterSource: patched.afterSource,
        });
      }
      expect(await fs.readFile(abs, 'utf8')).toContain('<p>Updated</p>');

      const u1 = await stack.undo(tmp, lock);
      expect(u1.ok).toBe(true);
      expect(await fs.readFile(abs, 'utf8')).toContain('<p>Original</p>');

      const r1 = await stack.redo(tmp, lock);
      expect(r1.ok).toBe(true);
      expect(await fs.readFile(abs, 'utf8')).toContain('<p>Updated</p>');

      // Simulate external edit by Pi -> undo must fail with 409 rather than clobbering
      await fs.writeFile(abs, `<main>\n  <p>Pi edited this</p>\n</main>\n`);
      const uConflict = await stack.undo(tmp, lock);
      expect(uConflict.ok).toBe(false);
      if (!uConflict.ok) expect(uConflict.code).toBe(409);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('rewrites opening tag attributes without disturbing unrelated Astro expressions', () => {
    const tag = `<a class="btn" data-x={fn('a > b')} href={url('/old')} aria-label="Old">`;
    const next = rewriteOpeningTagAttrs(tag, {
      href: `href={url('/new')}`,
      target: 'target="_blank"',
      'aria-label': null,
    });
    expect(next).toBe(`<a class="btn" data-x={fn('a > b')} href={url('/new')} target="_blank">`);
  });

  it('client bridge contains zero execCommand calls and parses cleanly', async () => {
    const { buildClientBridgeScript } = await import('../src/client-bridge.js');
    const bridge = buildClientBridgeScript('/thecrossing.website');
    expect(() => new Function(bridge)).not.toThrow();
    expect(bridge).not.toContain('execCommand');
    expect(bridge).toContain('/__editor/mutate');
    expect(bridge).toContain('/__editor/undo');
    expect(bridge).toContain('/__editor/upload-image');
  });
});
