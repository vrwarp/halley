import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  inspectAstroElement,
  mutateAstroElement,
  patchStaticSpan,
  PerFileMutex,
  serializeHtmlToAstro,
} from '../src/index.js';
import { buildClientBridgeScript } from '../src/client-bridge.js';

const temps: string[] = [];

async function makeTempSite(files: Record<string, string>) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'halley-nested-bugs-'));
  temps.push(tmp);
  await fs.mkdir(path.join(tmp, 'src/lib'), { recursive: true });
  await fs.writeFile(path.join(tmp, 'src/lib/url.ts'), 'export const url = (p: string) => p;\n');
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(tmp, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
  }
  return tmp;
}

afterEach(async () => {
  await Promise.all(temps.splice(0).map((t) => fs.rm(t, { recursive: true, force: true })));
});

describe('nested HTML, contentEditable hygiene, and structural container safety', () => {
  it('blocks structural Duplicate/Add/Delete on inline phrasing tags (<span>, <strong>, inline <a>) and <svg>/<path> primitives', async () => {
    const src = `<main>
  <h1>
    Crossing generations &amp; cultures{' '}
    <span class="font-serif italic text-accent">together in Christ.</span>
  </h1>
  <p>Join us — <a href="/im-new">plan your visit</a>.</p>
  <a href="/im-new" class="cta-btn">
    <span>Plan Your Visit</span>
    <svg viewBox="0 0 24 24"><path d="M5 12h14" /></svg>
  </a>
</main>
`;
    const lines = src.split('\n');
    const locOf = (lineIdx: number, needle: string) => `${lineIdx + 1}:${lines[lineIdx]!.indexOf(needle) + 1}`;

    // <h1> is a block heading -> structural allowed (except sole-h1 delete), allowedAddKinds omits list-item
    const h1 = await inspectAstroElement(src, locOf(1, '<h1>'), 'src/pages/index.astro');
    expect(h1?.editability).toBe('editable-static');
    expect(h1?.capabilities.structural.canDuplicate).toBe(true);
    expect(h1?.capabilities.structural.canAddAfter).toBe(true);
    expect(h1?.capabilities.structural.allowedAddKinds).toEqual(['paragraph', 'heading', 'image']);

    // Inline <span> inside <h1> -> editable-static text, structural blocked
    const span = await inspectAstroElement(src, locOf(3, '<span'), 'src/pages/index.astro');
    expect(span?.editability).toBe('editable-static');
    expect(span?.capabilities.structural.canDuplicate).toBe(false);
    expect(span?.capabilities.structural.canDelete).toBe(false);
    expect(span?.capabilities.structural.canAddAfter).toBe(false);
    expect(span?.capabilities.structural.allowedAddKinds).toEqual([]);

    // Inline <a> inside <p> -> text + link editable, structural blocked
    const inlineLink = await inspectAstroElement(src, locOf(5, '<a '), 'src/pages/index.astro');
    expect(inlineLink?.editability).toBe('editable-static');
    expect(inlineLink?.capabilities.link?.canEdit).toBe(true);
    expect(inlineLink?.capabilities.structural.canDuplicate).toBe(false);
    expect(inlineLink?.capabilities.structural.canAddAfter).toBe(false);

    // Standalone CTA <a> inside <main> -> link + structural allowed
    const ctaLink = await inspectAstroElement(src, locOf(6, '<a '), 'src/pages/index.astro');
    expect(ctaLink?.capabilities.link?.canEdit).toBe(true);
    expect(ctaLink?.capabilities.structural.canDuplicate).toBe(true);
    expect(ctaLink?.capabilities.structural.canAddAfter).toBe(true);

    // <svg> and <path> -> non-editable graphics, structural blocked
    const svg = await inspectAstroElement(src, locOf(8, '<svg'), 'src/pages/index.astro');
    const svgPath = await inspectAstroElement(src, locOf(8, '<path'), 'src/pages/index.astro');
    expect(svg?.editability).toBe('dynamic');
    expect(svg?.capabilities.structural.canAddAfter).toBe(false);
    expect(svgPath?.editability).toBe('dynamic');
    expect(svgPath?.capabilities.structural.canDuplicate).toBe(false);
    expect(svgPath?.capabilities.structural.canDelete).toBe(false);
    expect(svgPath?.capabilities.structural.canAddAfter).toBe(false);
  });

  it('restricts Add block below inside <ul>/<ol> strictly to list-item and rejects orphaned <li> outside lists', async () => {
    const pageSrc = `<main>
  <p class="intro">Intro copy</p>
  <ul class="list">
    <li class="item">First item</li>
  </ul>
</main>
`;
    const tmp = await makeTempSite({ 'src/pages/index.astro': pageSrc });
    const lock = new PerFileMutex();

    const pInfo = (await inspectAstroElement(pageSrc, '2:3', 'src/pages/index.astro'))!;
    expect(pInfo.capabilities.structural.allowedAddKinds).toEqual(['paragraph', 'heading', 'image']);

    // Orphaned <li> after <p> outside <ul>/<ol> -> 422
    const badLi = await mutateAstroElement({
      repoRoot: tmp,
      relFile: 'src/pages/index.astro',
      loc: '2:3',
      expectedOuterHash: pInfo.outerSnapshotHash,
      mutation: { kind: 'add-block', blockKind: 'list-item' },
      previewBase: '/',
      originalBase: '/',
      fileLock: lock,
    });
    expect(badLi.ok).toBe(false);
    if (!badLi.ok) expect(badLi.code).toBe(422);

    const liInfo = (await inspectAstroElement(pageSrc, '4:5', 'src/pages/index.astro'))!;
    expect(liInfo.capabilities.structural.allowedAddKinds).toEqual(['list-item']);

    // <p> inside <ul> after <li> -> 422
    const badPInUl = await mutateAstroElement({
      repoRoot: tmp,
      relFile: 'src/pages/index.astro',
      loc: '4:5',
      expectedOuterHash: liInfo.outerSnapshotHash,
      mutation: { kind: 'add-block', blockKind: 'paragraph' },
      previewBase: '/',
      originalBase: '/',
      fileLock: lock,
    });
    expect(badPInUl.ok).toBe(false);
    if (!badPInUl.ok) expect(badPInUl.code).toBe(422);

    // Valid list-item inside <ul> -> 200 ok
    const goodLiInUl = await mutateAstroElement({
      repoRoot: tmp,
      relFile: 'src/pages/index.astro',
      loc: '4:5',
      expectedOuterHash: liInfo.outerSnapshotHash,
      mutation: { kind: 'add-block', blockKind: 'list-item' },
      previewBase: '/',
      originalBase: '/',
      fileLock: lock,
    });
    expect(goodLiInUl.ok).toBe(true);
  });

  it('strips browser-synthesized inline style="color: rgb(...)" on newly injected contentEditable nodes while preserving authored source style attributes', async () => {
    const source = `<main>
  <h1>Crossing generations{' '}<span class="serif" style="letter-spacing: 0.02em">together in Christ.</span></h1>
</main>
`;
    const inspected = (await inspectAstroElement(source, '2:3', 'src/pages/index.astro'))!;
    expect(inspected.editability).toBe('editable-static');

    // Simulate Blink contentEditable merging text runs and injecting <span style="color: rgb(245, 158, 11); font-size: 48px;">
    const domHtml =
      `Crossing generations <span class="serif" style="letter-spacing: 0.02em">together in Christ.</span>` +
      `<span style="color: rgb(245, 158, 11); font-size: 48px;"> Welcome!</span>`;

    const res = serializeHtmlToAstro(
      domHtml,
      { previewBase: '/', originalBase: '/', hasUrlHelperFile: true },
      inspected,
    );
    // Original authored style="letter-spacing: 0.02em" stays intact, while synthesized rgb(...) span is unwrapped cleanly!
    expect(res.astroSource).toBe(
      `Crossing generations{' '}<span class="serif" style="letter-spacing: 0.02em">together in Christ.</span> Welcome!`,
    );
  });

  it('returns refreshed subtreeLocs from patchStaticSpan when editing a parent shifts child inline elements', async () => {
    const source = `<main>\n  <h1>Crossing <span class="serif">together in Christ.</span></h1>\n</main>\n`;
    const tmp = await makeTempSite({ 'src/pages/index.astro': source });
    const lock = new PerFileMutex();
    const h1 = (await inspectAstroElement(source, '2:3', 'src/pages/index.astro'))!;

    const patched = await patchStaticSpan({
      repoRoot: tmp,
      relFile: 'src/pages/index.astro',
      loc: '2:3',
      expectedHash: h1.snapshotHash,
      expectedFileHash: h1.fileHash,
      expectedContentHash: h1.contentHash,
      newHtml: 'Crossing generations &amp; cultures<br><span class="serif">together forever in Christ.</span>',
      previewBase: '/',
      originalBase: '/',
      fileLock: lock,
    });
    expect(patched.ok).toBe(true);
    if (!patched.ok) return;

    // [0] = <h1>, [1] = <br />, [2] = <span class="serif">
    expect(patched.subtreeLocs).toHaveLength(3);
    const spanNewLoc = patched.subtreeLocs![2]!;
    const disk = await fs.readFile(path.join(tmp, 'src/pages/index.astro'), 'utf8');
    const reSpan = await inspectAstroElement(disk, spanNewLoc, 'src/pages/index.astro');
    expect(reSpan?.tagName).toBe('span');
    expect(reSpan?.innerSource).toBe('together forever in Christ.');
  });

  it('enforces contentEditable removal (never contentEditable = "false"), outline suppression, beforeinput handling, and smart click promotion in client-bridge', () => {
    const bridge = buildClientBridgeScript('/thecrossing.website');
    expect(() => new Function(bridge)).not.toThrow();
    expect(bridge).not.toContain("contentEditable = 'false'");
    expect(bridge).not.toContain('contentEditable = "false"');
    expect(bridge).toContain("removeAttribute('contenteditable')");
    expect(bridge).toContain('outline: none !important');
    expect(bridge).toContain("addEventListener('beforeinput'");
    expect(bridge).toContain('selectFromClick');
    expect(bridge).toContain('flattenMatchingInlineTags');
  });
});
