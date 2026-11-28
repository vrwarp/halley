import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { discoverSiteRoutes, inspectAstroElement } from '../src/index.js';

// Real-site fixtures live outside the repo; override with HALLEY_CROSSING_ROOT. When absent these
// tests are reported as skipped (not silently passed).
const CROSSING_ROOT =
  process.env.HALLEY_CROSSING_ROOT || '/home/antigravity/vrwarp/thecrossing.website';
const CROSSING_EXISTS = existsSync(CROSSING_ROOT);

describe.skipIf(!CROSSING_EXISTS)('real thecrossing.website templates', () => {
  it('classifies hero h1 and static subtitle as editable-static in index.astro', async () => {
    const src = await fs.readFile(path.join(CROSSING_ROOT, 'src/pages/index.astro'), 'utf8');
    // Line 78: <h1 ...>Crossing generations &amp; cultures{' '}<span ...>together in Christ.</span></h1>
    const h1 = await inspectAstroElement(src, '78:11');
    expect(h1?.editability).toBe('editable-static');
    expect(h1?.usesUrlHelper).toBe(true);

    // Line 83: <p class="mt-6 max-w-xl ...">We are a church from singles to families...</p>
    const p = await inspectAstroElement(src, '83:11');
    expect(p?.editability).toBe('editable-static');

    // Line 180 (after several multi-byte UTF-8 em/en dashes earlier in index.astro):
    // <h2 class="mt-2 font-serif text-3xl italic text-stone-900 sm:text-5xl">A multi-generational family in the East Bay.</h2>
    const lifeH2Start = await inspectAstroElement(src, '180:9');
    expect(lifeH2Start?.editability).toBe('editable-static');
    expect(lifeH2Start?.innerSource.trim()).toBe('A multi-generational family in the East Bay.');

    const lifeH2End = await inspectAstroElement(src, '180:80');
    expect(lifeH2End?.editability).toBe('editable-static');
    expect(lifeH2End?.innerSource.trim()).toBe('A multi-generational family in the East Bay.');

    // Line 68: <BaseLayout title={SITE.name}>
    const comp = await inspectAstroElement(src, '68:1');
    expect(comp?.editability).toBe('dynamic');
  });

  it('discovers internal routes from src/pages for bubble menu autocomplete', async () => {
    const routes = await discoverSiteRoutes(CROSSING_ROOT);
    const paths = routes.map((r) => r.route);
    expect(paths).toContain('/');
    expect(paths).toContain('/im-new');
    expect(paths).toContain('/get-connected/youth');
  });

  it('parses and round-trip patches static elements across every .astro page without byte drift', async () => {
    const { parse } = await import('@astrojs/compiler');
    const os = await import('node:os');
    const { PerFileMutex, patchStaticSpan } = await import('../src/index.js');

    async function collectAstroFiles(dir: string): Promise<string[]> {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const out: string[] = [];
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...(await collectAstroFiles(full)));
        else if (e.isFile() && e.name.endsWith('.astro')) out.push(full);
      }
      return out;
    }

    const files = await collectAstroFiles(path.join(CROSSING_ROOT, 'src/pages'));
    expect(files.length).toBeGreaterThan(15);

    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'halley-fullsite-ast-'));
    try {
      await fs.mkdir(path.join(tmp, 'src/lib'), { recursive: true });
      await fs.writeFile(path.join(tmp, 'src/lib/url.ts'), 'export const url = (p: string) => p;\n');
      const lock = new PerFileMutex();
      let checkedStaticCount = 0;

      for (const file of files) {
        const src = await fs.readFile(file, 'utf8');
        const parsed = await parse(src, { position: true });
        type NodeLike = {
          type?: string;
          name?: string;
          position?: { start?: { line: number; column: number } };
          children?: NodeLike[];
        };

        // Find the deepest static heading/paragraph on each page (maximizing preceding UTF-8 bytes)
        const candidates: Array<{ tag: string; loc: string }> = [];
        const walk = (n: NodeLike) => {
          if (
            n.type === 'element' &&
            n.name &&
            ['h1', 'h2', 'h3', 'p', 'blockquote'].includes(n.name) &&
            n.position?.start
          ) {
            candidates.push({
              tag: n.name,
              loc: `${n.position.start.line}:${n.position.start.column}`,
            });
          }
          for (const c of n.children ?? []) walk(c);
        };
        walk(parsed.ast as unknown as NodeLike);

        const lastCandidate = candidates[candidates.length - 1];
        if (!lastCandidate) continue;

        const info = await inspectAstroElement(src, lastCandidate.loc);
        expect(info).not.toBeNull();
        if (info?.editability === 'editable-static') {
          checkedStaticCount++;
          // Verify exact surrounding tags stay intact when patched
          expect(src.slice(info.innerEndOffset, info.innerEndOffset + lastCandidate.tag.length + 3)).toBe(
            `</${lastCandidate.tag}>`,
          );

          const rel = path.relative(CROSSING_ROOT, file);
          const dst = path.join(tmp, rel);
          await fs.mkdir(path.dirname(dst), { recursive: true });
          await fs.writeFile(dst, src, 'utf8');

          const res = await patchStaticSpan({
            repoRoot: tmp,
            relFile: rel.split(path.sep).join('/'),
            loc: lastCandidate.loc,
            expectedHash: info.snapshotHash,
            newHtml: 'Updated — test copy',
            previewBase: '/p/s1/thecrossing.website',
            originalBase: '/thecrossing.website',
            fileLock: lock,
          });
          expect(res.ok).toBe(true);
          const updated = await fs.readFile(dst, 'utf8');
          expect(updated).toContain(`>Updated — test copy</${lastCandidate.tag}>`);
        }
      }

      expect(checkedStaticCount).toBeGreaterThan(10);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
