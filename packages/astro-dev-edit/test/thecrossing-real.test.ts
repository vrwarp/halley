import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { discoverSiteRoutes, inspectAstroElement } from '../src/index.js';

const CROSSING_ROOT = '/home/antigravity/vrwarp/thecrossing.website';

describe('real thecrossing.website templates', () => {
  it('classifies hero h1 and static subtitle as editable-static in index.astro', async () => {
    const exists = await fs.access(CROSSING_ROOT).then(() => true).catch(() => false);
    if (!exists) return;

    const src = await fs.readFile(path.join(CROSSING_ROOT, 'src/pages/index.astro'), 'utf8');
    // Line 78: <h1 ...>Crossing generations &amp; cultures{' '}<span ...>together in Christ.</span></h1>
    const h1 = await inspectAstroElement(src, '78:11');
    expect(h1?.editability).toBe('editable-static');
    expect(h1?.usesUrlHelper).toBe(true);

    // Line 83: <p class="mt-6 max-w-xl ...">We are a church from singles to families...</p>
    const p = await inspectAstroElement(src, '83:11');
    expect(p?.editability).toBe('editable-static');

    // Line 68: <BaseLayout title={SITE.name}>
    const comp = await inspectAstroElement(src, '68:1');
    expect(comp?.editability).toBe('dynamic');
  });

  it('discovers internal routes from src/pages for bubble menu autocomplete', async () => {
    const exists = await fs.access(CROSSING_ROOT).then(() => true).catch(() => false);
    if (!exists) return;

    const routes = await discoverSiteRoutes(CROSSING_ROOT);
    const paths = routes.map((r) => r.route);
    expect(paths).toContain('/');
    expect(paths).toContain('/im-new');
    expect(paths).toContain('/get-connected/youth');
  });
});
