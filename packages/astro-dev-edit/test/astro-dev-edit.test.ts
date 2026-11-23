import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  inspectAstroElement,
  PerFileMutex,
  patchStaticSpan,
  serializeHtmlToAstro,
} from '../src/index.js';

describe('ast-classifier & serializer', () => {
  it('classifies static hero text with inline <span> as editable-static and dynamic {SITE.name} as dynamic', async () => {
    const sample = `---
import { url } from '../lib/url';
const SITE = { name: 'The Crossing' };
---
<section>
  <h1>Crossing generations &amp; cultures{' '}<span class="font-serif italic text-accent">together in Christ.</span></h1>
  <p class="mt-6">We are a church from singles to families.</p>
  <p>{SITE.name}</p>
</section>
`;
    // Line 6: <h1>...</h1>
    const h1 = await inspectAstroElement(sample, '6:3');
    expect(h1?.editability).toBe('editable-static');
    expect(h1?.tagName).toBe('h1');

    // Line 7: <p class="mt-6">...</p>
    const pStatic = await inspectAstroElement(sample, '7:3');
    expect(pStatic?.editability).toBe('editable-static');

    // Line 8: <p>{SITE.name}</p>
    const pDyn = await inspectAstroElement(sample, '8:3');
    expect(pDyn?.editability).toBe('dynamic');
  });

  it('serializes internal links to href={url(...)} and strips XSS tags', () => {
    const html = `Visit <strong>us</strong> or <a href="/p/sess123/thecrossing.website/im-new">plan your visit</a> and <a href="https://example.com" target="_blank">external</a><script>alert(1)</script>`;
    const res = serializeHtmlToAstro(html, {
      previewBase: '/p/sess123/thecrossing.website',
      originalBase: '/thecrossing.website',
      hasUrlHelperFile: true,
    });
    expect(res.needsUrlImport).toBe(true);
    expect(res.astroSource).toBe(
      `Visit <strong>us</strong> or <a href={url('/im-new')}>plan your visit</a> and <a href="https://example.com" target="_blank" rel="noopener noreferrer">external</a>`,
    );
  });

  it('rejects stale hash on patchStaticSpan and applies clean atomic write + url import injection', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'halley-edit-test-'));
    try {
      await fs.mkdir(path.join(tmp, 'src/pages'), { recursive: true });
      await fs.mkdir(path.join(tmp, 'src/lib'), { recursive: true });
      await fs.writeFile(path.join(tmp, 'src/lib/url.ts'), 'export const url = (p: string) => p;\n');

      const astroFile = `---
const title = 'Home';
---
<main>
  <p>Hello world</p>
</main>
`;
      const absPage = path.join(tmp, 'src/pages/index.astro');
      await fs.writeFile(absPage, astroFile);

      const inspected = await inspectAstroElement(astroFile, '5:3');
      expect(inspected?.editability).toBe('editable-static');

      const lock = new PerFileMutex();
      // Stale hash
      const stale = await patchStaticSpan({
        repoRoot: tmp,
        relFile: 'src/pages/index.astro',
        loc: '5:3',
        expectedHash: 'bad-hash',
        newHtml: 'Updated',
        previewBase: '/p/s1/thecrossing.website',
        originalBase: '/thecrossing.website',
        fileLock: lock,
      });
      expect(stale.ok).toBe(false);
      if (!stale.ok) expect(stale.code).toBe(409);

      // Valid patch with internal link
      const ok = await patchStaticSpan({
        repoRoot: tmp,
        relFile: 'src/pages/index.astro',
        loc: '5:3',
        expectedHash: inspected!.snapshotHash,
        newHtml: 'Hello <em>everyone</em> — <a href="/p/s1/thecrossing.website/im-new">visit</a>',
        previewBase: '/p/s1/thecrossing.website',
        originalBase: '/thecrossing.website',
        fileLock: lock,
      });
      expect(ok.ok).toBe(true);
      const updated = await fs.readFile(absPage, 'utf8');
      expect(updated).toContain(`import { url } from '../lib/url';`);
      expect(updated).toContain(`<p>Hello <em>everyone</em> — <a href={url('/im-new')}>visit</a></p>`);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
