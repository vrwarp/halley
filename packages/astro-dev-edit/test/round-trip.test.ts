/**
 * Property-style round-trip tests over test/fixtures/*.astro (LF and CRLF variants):
 *  - re-saving the SAME rendered text is a byte-for-byte no-op (no write at all);
 *  - saving CHANGED text re-parses, changes only the target element's inner span, and keeps
 *    unchanged inline children, comments and entities verbatim.
 * Plus regression tests for stale-loc staleness hashing, exact loc lookup and Astro version gating.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFragment, serialize, type DefaultTreeAdapterMap } from 'parse5';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  detectAstroVersions,
  findElementsByContentHash,
  inspectAstroElement,
  PerFileMutex,
  patchStaticSpan,
  type PatchStaticSpanInput,
} from '../src/index.js';

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];
type TextNode = DefaultTreeAdapterMap['textNode'];

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const PREVIEW_BASE = '/p/s1/site';
const ORIGINAL_BASE = '/site';

let tmp: string;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'halley-round-trip-'));
  await fs.mkdir(path.join(tmp, 'src/pages'), { recursive: true });
  await fs.mkdir(path.join(tmp, 'src/lib'), { recursive: true });
  await fs.writeFile(path.join(tmp, 'src/lib/url.ts'), 'export const url = (p: string) => p;\n');
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

const REL = 'src/pages/index.astro';
const abs = () => path.join(tmp, REL);

function input(over: Partial<PatchStaticSpanInput>): PatchStaticSpanInput {
  return {
    repoRoot: tmp,
    relFile: REL,
    loc: '1:1',
    expectedHash: '',
    newHtml: '',
    previewBase: PREVIEW_BASE,
    originalBase: ORIGINAL_BASE,
    fileLock: new PerFileMutex(),
    ...over,
  };
}

/** line:byteCol (1-based) of a char offset. */
function locOf(source: string, charOffset: number): string {
  const before = source.slice(0, charOffset);
  const line = before.split('\n').length;
  const lineStart = before.lastIndexOf('\n') + 1;
  return `${line}:${Buffer.byteLength(source.slice(lineStart, charOffset), 'utf8') + 1}`;
}

/** Both loc conventions for the element carrying `marker`: start-of-tag and Astro 5 (after `>`). */
function targetLocs(source: string, marker = 'data-target'): { startLoc: string; astro5Loc: string } {
  const at = source.indexOf(marker);
  const lt = source.lastIndexOf('<', at);
  const gt = source.indexOf('>', at);
  return { startLoc: locOf(source, lt), astro5Loc: locOf(source, gt + 1) };
}

/**
 * Simulates what the browser hands the bridge as `el.innerHTML` for the rendered element: Astro
 * renders static text as written (entities are decoded by the browser), `{' '}` as its string,
 * `url('/x')` hrefs with the base, adds dev annotations / scoped-style attributes to elements,
 * and innerHTML re-serializes (`&nbsp;`, `&amp;`, `&lt;`, `&gt;`).
 */
function renderedInnerHtml(innerSource: string, keepComments: boolean): string {
  let html = innerSource
    .replace(/\{\s*(['"`])([ \t\r\n]*)\1\s*\}/g, '$2')
    .replace(/href=\{url\(\s*'([^']+)'\s*\)\}/g, (_m, p: string) => `href="${ORIGINAL_BASE}${p}"`)
    .replace(/\r\n/g, '\n'); // browsers normalize CRLF in parsed text
  if (!keepComments) html = html.replace(/<!--[\s\S]*?-->/g, '');
  const frag = parseFragment(html);
  const annotate = (nodes: Node[]) => {
    for (const n of nodes) {
      if ('tagName' in n) {
        const el = n as Element;
        el.attrs.push(
          { name: 'data-astro-cid-abc123', value: '' },
          { name: 'data-astro-source-file', value: '/repo/src/pages/index.astro' },
          { name: 'data-astro-source-loc', value: '9:9' },
        );
        annotate(el.childNodes);
      }
    }
  };
  annotate(frag.childNodes);
  return serialize(frag);
}

/** Appends " EDITED" to the last top-level text node that has visible text. */
function editLastTopLevelText(innerHtml: string): string {
  const frag = parseFragment(innerHtml);
  const texts = frag.childNodes.filter((n) => n.nodeName === '#text' && (n as TextNode).value.trim());
  const t = (texts[texts.length - 1] ?? null) as TextNode | null;
  if (t) {
    const m = /^([\s\S]*?)(\s*)$/.exec(t.value)!;
    t.value = `${m[1]} EDITED${m[2]}`;
  } else {
    frag.childNodes.push({ nodeName: '#text', value: ' EDITED', parentNode: frag } as unknown as Node);
  }
  return serialize(frag);
}

const fixtureFiles = (await fs.readdir(FIXTURES)).filter((f) => f.endsWith('.astro')).sort();
const variants = fixtureFiles.flatMap((f) => [
  { name: f, crlf: false },
  ...(f.includes('crlf') ? [] : [{ name: `${f} (CRLF)`, crlf: true, file: f }]),
]);

async function loadFixture(v: { name: string; crlf: boolean; file?: string }) {
  const raw = await fs.readFile(path.join(FIXTURES, v.file ?? v.name), 'utf8');
  return v.crlf ? raw.replace(/\r?\n/g, '\r\n') : raw;
}

describe('round trip over fixtures', () => {
  it('has a ~20 fixture corpus', () => {
    expect(fixtureFiles.length).toBeGreaterThanOrEqual(20);
  });

  for (const v of variants) {
    for (const keepComments of [true, false]) {
      describe(`${v.name}${keepComments ? '' : ' (comments not rendered)'}`, () => {
        it('re-saving the same text is a byte-for-byte no-op for both loc conventions', async () => {
          const source = await loadFixture(v);
          await fs.writeFile(abs(), source);
          const before = await fs.stat(abs());
          for (const loc of Object.values(targetLocs(source))) {
            const inspected = await inspectAstroElement(source, loc, { file: REL });
            expect(inspected?.editability, `${loc}: ${inspected?.reason}`).toBe('editable-static');
            const res = await patchStaticSpan(
              input({
                loc,
                expectedHash: inspected!.snapshotHash,
                newHtml: renderedInnerHtml(inspected!.innerSource, keepComments),
              }),
            );
            expect(res.ok, JSON.stringify(res)).toBe(true);
            if (res.ok) expect(res.updatedSource).toBe(inspected!.innerSource);
          }
          expect(await fs.readFile(abs(), 'utf8')).toBe(source);
          expect((await fs.stat(abs())).mtimeMs).toBe(before.mtimeMs);
        });

        it('file changed between inspect and patch: lands on the target element (relocated when moved)', async () => {
          const source = await loadFixture(v);
          const eol = v.crlf ? '\r\n' : '\n';
          const { astro5Loc } = targetLocs(source);
          const inspected = (await inspectAstroElement(source, astro5Loc, { file: REL }))!;
          const unique = (await findElementsByContentHash(source, inspected.contentHash!, REL)).length === 1;
          // Unrelated edit after the element plus a different-length line inserted before its line.
          const lineStart = source.lastIndexOf('\n', inspected.elementStartOffset!) + 1;
          const insert = `<!-- moved by agent -->${eol}`;
          const changed = source.slice(0, lineStart) + insert + source.slice(lineStart) + `<!-- tail -->${eol}`;
          await fs.writeFile(abs(), changed);
          const newHtml = editLastTopLevelText(renderedInnerHtml(inspected.innerSource, keepComments));
          const res = await patchStaticSpan(
            input({
              loc: astro5Loc,
              expectedHash: inspected.snapshotHash,
              expectedFileHash: inspected.fileHash,
              expectedContentHash: inspected.contentHash,
              newHtml,
            }),
          );
          if (!unique) {
            expect(res.ok).toBe(false);
            if (!res.ok) expect(res.code).toBe(409);
            expect(await fs.readFile(abs(), 'utf8')).toBe(changed);
            return;
          }
          expect(res.ok, JSON.stringify(res)).toBe(true);
          if (!res.ok) return;
          // (Not always `relocated`: a stale loc can overflow onto the same element's next line.)
          const after = await fs.readFile(abs(), 'utf8');
          const start = inspected.innerStartOffset + insert.length;
          const tailLen = changed.length - (inspected.innerEndOffset + insert.length);
          expect(after.slice(0, start)).toBe(changed.slice(0, start));
          expect(after.slice(after.length - tailLen)).toBe(changed.slice(changed.length - tailLen));
          expect(after.slice(start, after.length - tailLen)).toBe(res.updatedSource);
          const re = await inspectAstroElement(after, res.newLoc, { file: REL });
          expect(re?.innerSource).toBe(res.updatedSource);
          expect(re?.fileHash).toBe(res.newFileHash);
          expect(re?.contentHash).toBe(res.newContentHash);
        });

        it('changed text re-parses and changes only the target span, keeping unchanged parts verbatim', async () => {
          const source = await loadFixture(v);
          await fs.writeFile(abs(), source);
          const { astro5Loc } = targetLocs(source);
          const inspected = (await inspectAstroElement(source, astro5Loc, { file: REL }))!;
          const newHtml = editLastTopLevelText(renderedInnerHtml(inspected.innerSource, keepComments));
          const res = await patchStaticSpan(input({ loc: astro5Loc, expectedHash: inspected.snapshotHash, newHtml }));
          expect(res.ok, JSON.stringify(res)).toBe(true);
          if (!res.ok) return;

          const after = await fs.readFile(abs(), 'utf8');
          // Only the inner span changed (no url import needed: no new internal links).
          expect(after.slice(0, inspected.innerStartOffset)).toBe(source.slice(0, inspected.innerStartOffset));
          const tailLen = source.length - inspected.innerEndOffset;
          expect(after.slice(after.length - tailLen)).toBe(source.slice(inspected.innerEndOffset));
          const newInner = after.slice(inspected.innerStartOffset, after.length - tailLen);
          expect(newInner).toBe(res.updatedSource);
          expect(newInner).toContain('EDITED');

          // Re-parses to the same, still-editable element.
          const re = await inspectAstroElement(after, res.newLoc, { file: REL });
          expect(re?.editability).toBe('editable-static');
          expect(re?.innerSource).toBe(newInner);
          expect(re?.snapshotHash).toBe(res.newHash);

          // Unchanged inline children (all attributes, original tag names) and comments survive.
          for (const child of inspected.innerTree ?? []) {
            expect(newInner).toContain(inspected.innerSource.slice(child.start, child.end));
          }
          for (const c of inspected.innerSource.match(/<!--[\s\S]*?-->/g) ?? []) {
            expect(newInner).toContain(c);
          }
          // Entities in the original are written as entities again.
          for (const ent of inspected.innerSource.match(/&[a-z]+;/gi) ?? []) {
            expect(newInner).toContain(ent);
          }
          expect(newInner).not.toContain(' ');
          expect(newInner).not.toMatch(/data-astro-(cid|source)/);
        });
      });
    }
  }
});

describe('staleness hash binds the element, not just its text', () => {
  const twoLinks = [
    '<main>',
    '  <p><a href="/learn">Learn more</a></p>',
    '  <p><a href="/learn">Learn more</a></p>',
    '</main>',
    '',
  ].join('\n');

  it('rejects a stale loc that lands on another element with identical inner text (409, no write)', async () => {
    await fs.writeFile(abs(), twoLinks);
    // Inspect the SECOND link (line 3, Astro 5 loc = just after `<a href="/learn">`).
    const loc = '3:22';
    const inspected = await inspectAstroElement(twoLinks, loc, { file: REL });
    expect(inspected?.tagName).toBe('a');
    expect(inspected?.innerSource).toBe('Learn more');

    // An agent inserts a line above: the FIRST link now sits on line 3 at the same column.
    const shifted = twoLinks.replace('<main>\n', '<main>\n  <h2>News</h2>\n');
    await fs.writeFile(abs(), shifted);
    const res = await patchStaticSpan(
      input({ loc, expectedHash: inspected!.snapshotHash, newHtml: 'Read the docs' }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe(409);
    expect(await fs.readFile(abs(), 'utf8')).toBe(shifted);
  });

  const paras = ['<main>', '  <p>Alpha text</p>', '  <p>Beta text!</p>', '  <p>Gamma</p>', '</main>', ''].join('\n');
  const inspectWithFile = async (source: string, loc: string) => {
    const i = (await inspectAstroElement(source, loc, { file: REL }))!;
    expect(i.editability).toBe('editable-static');
    return {
      loc,
      expectedHash: i.snapshotHash,
      expectedFileHash: i.fileHash,
      expectedContentHash: i.contentHash,
    };
  };

  it('duplicated equal-length paragraph above (offset + line prefix unchanged) -> 409, no write', async () => {
    // Inspect "Beta text!" (line 3); the agent then duplicates that paragraph. Line 3 now holds
    // an identical copy at the same offset with the same line prefix, so the v2 element hash
    // still matches — only the file hash reveals the change, and the content is ambiguous.
    const ctx = await inspectWithFile(paras, '3:6');
    const dup = paras.replace('  <p>Beta text!</p>\n', '  <p>Beta text!</p>\n  <p>Beta text!</p>\n');
    await fs.writeFile(abs(), dup);
    const res = await patchStaticSpan(input({ ...ctx, newHtml: 'Changed' }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe(409);
    expect(await fs.readFile(abs(), 'utf8')).toBe(dup);
  });

  it('equal-length line inserted above whose content differs -> relocates to the real target', async () => {
    // "Alpha text" and "Beta text!" lines are the same length: duplicating line 2 puts an Alpha
    // copy at line 3 with identical offset/line prefix, which the v2 hash alone cannot detect
    // if the inner text also matched. With fileHash the patch is relocated by content.
    const ctx = await inspectWithFile(paras, '3:6');
    const dup = paras.replace('  <p>Alpha text</p>\n', '  <p>Alpha text</p>\n  <p>Alpha text</p>\n');
    await fs.writeFile(abs(), dup);
    const res = await patchStaticSpan(input({ ...ctx, newHtml: 'Changed' }));
    expect(res.ok && res.relocated && res.newLoc).toBe('4:6');
    expect(await fs.readFile(abs(), 'utf8')).toBe(dup.replace('Beta text!', 'Changed'));
  });

  it('unrelated edit elsewhere between inspect and patch -> patches the right element in place', async () => {
    const ctx = await inspectWithFile(paras, '3:6');
    const edited = paras.replace('Gamma', 'Gamma, edited by the agent');
    await fs.writeFile(abs(), edited);
    const res = await patchStaticSpan(input({ ...ctx, newHtml: 'Changed' }));
    expect(res.ok, JSON.stringify(res)).toBe(true);
    if (res.ok) {
      expect(res.relocated).toBe(false);
      expect(res.newLoc).toBe('3:6');
    }
    expect(await fs.readFile(abs(), 'utf8')).toBe(edited.replace('Beta text!', 'Changed'));
  });

  it('element moved by lines of a different length inserted above, unique -> relocated', async () => {
    const ctx = await inspectWithFile(paras, '3:6');
    const moved = paras.replace('<main>\n', '<main>\n  <h2>A much longer heading line</h2>\n  <hr />\n');
    await fs.writeFile(abs(), moved);
    const res = await patchStaticSpan(input({ ...ctx, newHtml: 'Changed' }));
    expect(res.ok, JSON.stringify(res)).toBe(true);
    if (res.ok) {
      expect(res.relocated).toBe(true);
      expect(res.newLoc).toBe('5:6');
      expect(res.newFileHash).toBe((await inspectAstroElement(moved.replace('Beta text!', 'Changed'), '5:6'))!.fileHash);
    }
    expect(await fs.readFile(abs(), 'utf8')).toBe(moved.replace('Beta text!', 'Changed'));
  });

  it('back-to-back edits to different elements inspected before either save both succeed', async () => {
    await fs.writeFile(abs(), paras);
    const a = await inspectWithFile(paras, '2:6');
    const b = await inspectWithFile(paras, '3:6');
    const lock = new PerFileMutex();
    const r1 = await patchStaticSpan(input({ ...a, fileLock: lock, newHtml: 'Alpha, now longer' }));
    const r2 = await patchStaticSpan(input({ ...b, fileLock: lock, newHtml: 'Beta 2' }));
    expect(r1.ok && r2.ok, JSON.stringify([r1, r2])).toBe(true);
    // Chained edit of the same element with the returned tokens (file hash matches -> in place).
    if (!r2.ok) return;
    const r3 = await patchStaticSpan(
      input({
        loc: r2.newLoc,
        expectedHash: r2.newHash,
        expectedFileHash: r2.newFileHash,
        expectedContentHash: r2.newContentHash,
        fileLock: lock,
        newHtml: 'Beta 3',
      }),
    );
    expect(r3.ok && r3.relocated, JSON.stringify(r3)).toBe(false);
    expect(r3.ok).toBe(true);
    expect(await fs.readFile(abs(), 'utf8')).toBe(
      paras.replace('Alpha text', 'Alpha, now longer').replace('Beta text!', 'Beta 3'),
    );
  });

  it('a content-changed element (edited on disk since inspect) -> 409', async () => {
    const ctx = await inspectWithFile(paras, '3:6');
    const edited = paras.replace('Beta text!', 'Beta text?');
    await fs.writeFile(abs(), edited);
    const res = await patchStaticSpan(input({ ...ctx, newHtml: 'Changed' }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe(409);
    expect(await fs.readFile(abs(), 'utf8')).toBe(edited);
  });

  it('hash depends on file path, opening tag and offset', async () => {
    const a = await inspectAstroElement(twoLinks, '2:22', { file: REL });
    const b = await inspectAstroElement(twoLinks, '3:22', { file: REL });
    const other = await inspectAstroElement(twoLinks, '2:22', { file: 'src/pages/other.astro' });
    const attrChanged = twoLinks.replace('<a href="/learn">', '<a href="/learn" class="x">');
    const c = await inspectAstroElement(attrChanged, '2:32', { file: REL });
    expect(a?.innerSource).toBe(b?.innerSource);
    expect(new Set([a?.snapshotHash, b?.snapshotHash, other?.snapshotHash, c?.snapshotHash]).size).toBe(4);
  });

  it('still accepts hashes from inspect callers that do not pass the file path', async () => {
    await fs.writeFile(abs(), twoLinks);
    const unbound = await inspectAstroElement(twoLinks, '3:22');
    const res = await patchStaticSpan(input({ loc: '3:22', expectedHash: unbound!.snapshotHash, newHtml: 'Docs' }));
    expect(res.ok).toBe(true);
    expect(await fs.readFile(abs(), 'utf8')).toBe(twoLinks.replace(/Learn more<\/a><\/p>\n<\/main>/, 'Docs</a></p>\n</main>'));
  });
});

describe('exact element lookup (Astro 5 locs point just after the opening tag)', () => {
  const nested = '<main>\n  <p><b>Bold</b> rest</p>\n  <p>Lead <b>bold</b></p>\n</main>\n';

  it('<p><b>…</b></p>: the p loc (== b start offset) resolves to p, not the child', async () => {
    // `  <p>` -> loc 2:6, which is exactly where `<b>` starts.
    const p = await inspectAstroElement(nested, '2:6');
    expect(p?.tagName).toBe('p');
    expect(p?.innerSource).toBe('<b>Bold</b> rest');
  });

  it("the child's own Astro 5 loc resolves to the child", async () => {
    const b = await inspectAstroElement(nested, '2:9');
    expect(b?.tagName).toBe('b');
    expect(b?.innerSource).toBe('Bold');
  });

  it('start-of-tag locs still work when unambiguous', async () => {
    expect((await inspectAstroElement(nested, '2:3'))?.tagName).toBe('p');
    expect((await inspectAstroElement(nested, '3:11'))?.tagName).toBe('b');
  });

  it('fuzzy fallback is used only when unique', async () => {
    // Inside the opening tag of the second <p> (unique candidate).
    expect((await inspectAstroElement(nested, '3:4'))?.tagName).toBe('p');
    // 1 byte before `<b>` inside "<p><b>": candidates p (inside its opening tag) and b
    // (|start - target| <= 2) -> ambiguous -> null, never the wrong element.
    expect(await inspectAstroElement(nested, '2:5')).toBeNull();
  });
});

describe('Astro version gating', () => {
  async function fakeAstro(version: string) {
    const dir = path.join(tmp, 'node_modules/astro');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'astro', version, main: 'index.js' }));
    await fs.writeFile(path.join(dir, 'index.js'), 'module.exports = {};\n');
  }

  it('detects the site Astro and the bundled compiler versions', async () => {
    await fakeAstro('5.18.2');
    const info = await detectAstroVersions(tmp);
    expect(info.siteAstro).toBe('5.18.2');
    expect(info.bundledCompiler).toMatch(/^2\./);
    expect(info.disabledReason).toBeUndefined();
  });

  it('disables inline editing for an unsupported Astro major (patch refused, file untouched)', async () => {
    await fakeAstro('4.16.0');
    const info = await detectAstroVersions(tmp);
    expect(info.disabledReason).toMatch(/Astro 4\.16\.0/);

    const source = '<main>\n  <p>Hello</p>\n</main>\n';
    await fs.writeFile(abs(), source);
    const inspected = await inspectAstroElement(source, '2:6', { disabledReason: info.disabledReason });
    expect(inspected?.editability).toBe('dynamic');
    const res = await patchStaticSpan(input({ loc: '2:6', expectedHash: inspected!.snapshotHash, newHtml: 'Hi' }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe(422);
    expect(await fs.readFile(abs(), 'utf8')).toBe(source);
  });
});

describe('structural edits keep untouched source verbatim', () => {
  const opts = { previewBase: PREVIEW_BASE, originalBase: ORIGINAL_BASE, hasUrlHelperFile: false };
  const source =
    '<p>Hi&nbsp;there <a href="/x" data-track="cta" hidden>link</a> and <!-- note --> more &mdash; end</p>\n';

  it('adding bold elsewhere keeps the existing link (all attributes) and entities', async () => {
    const { serializeHtmlToAstro } = await import('../src/index.js');
    const inspected = (await inspectAstroElement(source, '1:4'))!;
    const dom =
      'Hi&nbsp;there <a href="/x" data-track="cta" hidden="" data-astro-source-loc="1:20">link</a> and <b>bold</b> more — end';
    const out = serializeHtmlToAstro(dom, opts, inspected).astroSource;
    expect(out).toContain('<a href="/x" data-track="cta" hidden>link</a>');
    expect(out).toContain('Hi&nbsp;there ');
    expect(out).toContain('<strong>bold</strong>');
    expect(out).toContain('&mdash; end');
  });

  it('removing the link unwraps it and keeps the rest', async () => {
    const { serializeHtmlToAstro } = await import('../src/index.js');
    const inspected = (await inspectAstroElement(source, '1:4'))!;
    const out = serializeHtmlToAstro('Hi&nbsp;there link and  more — end', opts, inspected).astroSource;
    expect(out).toBe('Hi&nbsp;there link and  more &mdash; end');
  });

  it('changing a link href re-serializes only that link', async () => {
    const { serializeHtmlToAstro } = await import('../src/index.js');
    const inspected = (await inspectAstroElement(source, '1:4'))!;
    const dom = 'Hi&nbsp;there <a href="/y" data-track="cta" hidden="">link</a> and  more — end';
    const out = serializeHtmlToAstro(dom, opts, inspected).astroSource;
    expect(out).toBe('Hi&nbsp;there <a href="/y" data-track="cta" hidden="">link</a> and <!-- note --> more &mdash; end');
  });
});
