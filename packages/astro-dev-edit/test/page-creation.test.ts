import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  HALLEY_PLACEHOLDER_ATTR,
  slugifyPagePath,
  slugifyRouteSegment,
  validateNewPageRoute,
} from '@halley/shared';
import { describe, expect, it } from 'vitest';
import {
  discoverSiteStructure,
  extractNavGroupsFromHtml,
  generatePageSkeleton,
  isPageSourceUnlisted,
  rewriteRelativeImportsInAstroSource,
  togglePageUnlistedInSource,
} from '../src/index.js';

const CROSSING_ROOT = '/home/antigravity/vrwarp/thecrossing.website';

describe('slugify & route validation', () => {
  it('slugifies accents, punctuation, and nested segments', () => {
    expect(slugifyRouteSegment("Café & Women's Retreat 2026!")).toBe('cafe-womens-retreat-2026');
    expect(slugifyPagePath(' /Events / Spring Retreat!/ ')).toBe('events/spring-retreat');
  });

  it('validates collisions, dynamic routes, generated routes, and reserved paths', () => {
    const existingRoutes = ['/', '/events', '/events/mens-retreat'];
    const dynamicPatterns = ['/sermons/[slug]'];
    const generatedRoutes = ['/sermons/kingdom-come-matthew'];

    expect(
      validateNewPageRoute({
        section: '/events',
        slug: 'spring-retreat',
        existingRoutes,
        dynamicPatterns,
        generatedRoutes,
      }),
    ).toEqual({
      valid: true,
      route: '/events/spring-retreat',
      normalizedSlug: 'spring-retreat',
    });

    const exact = validateNewPageRoute({
      section: '/events',
      slug: 'mens-retreat',
      existingRoutes,
      dynamicPatterns,
      generatedRoutes,
    });
    expect(exact.valid).toBe(false);
    expect(exact.collisionRoute).toBe('/events/mens-retreat');

    const gen = validateNewPageRoute({
      section: '/sermons',
      slug: 'kingdom-come-matthew',
      existingRoutes,
      dynamicPatterns,
      generatedRoutes,
    });
    expect(gen.valid).toBe(false);
    expect(gen.collisionRoute).toBe('/sermons/kingdom-come-matthew');

    const dyn = validateNewPageRoute({
      section: '/sermons',
      slug: 'brand-new-sermon',
      existingRoutes,
      dynamicPatterns,
      generatedRoutes,
    });
    expect(dyn.valid).toBe(false);
    expect(dyn.error).toContain('dynamic route');

    const reserved = validateNewPageRoute({
      section: '/',
      slug: '404',
      existingRoutes,
    });
    expect(reserved.valid).toBe(false);

    const reservedPrefix = validateNewPageRoute({
      section: '/',
      slug: 'api/hello',
      existingRoutes,
    });
    expect(reservedPrefix.valid).toBe(false);
  });
});

describe('AST unlisted detection, skeleton generation & helpers', () => {
  it('detects unlisted via indexable={false} and robots noindex without false positives', async () => {
    expect(
      await isPageSourceUnlisted(
        `---\nimport BaseLayout from '../layouts/BaseLayout.astro';\n---\n<BaseLayout title="Hidden" indexable={false}><p>Hi</p></BaseLayout>`,
        '.astro',
      ),
    ).toBe(true);
    expect(
      await isPageSourceUnlisted(
        `---\n---\n<html><head><meta name="robots" content="noindex, nofollow" /></head><body></body></html>`,
        '.astro',
      ),
    ).toBe(true);
    expect(
      await isPageSourceUnlisted(
        `---\nimport BaseLayout from '../layouts/BaseLayout.astro';\n---\n<BaseLayout title="Public"><p>Mentions noindex in copy</p></BaseLayout>`,
        '.astro',
      ),
    ).toBe(false);
  });

  it('derives valid skeletons from real thecrossing.website pages with rewritten import paths', async () => {
    const exists = await fs.access(CROSSING_ROOT).then(() => true).catch(() => false);
    if (!exists) return;

    const structure = await discoverSiteStructure(CROSSING_ROOT);
    expect(structure.sections.some((s) => s.section === '/events')).toBe(true);
    expect(structure.dynamicPatterns).toContain('/sermons/[slug]');
    expect(structure.generatedRoutes.length).toBeGreaterThan(5);

    // Reference at depth 1 (/give.astro) -> new page at depth 2 (/events/spring-retreat.astro)
    const skel1 = await generatePageSkeleton({
      repoRoot: CROSSING_ROOT,
      title: 'Spring Retreat',
      route: '/events/spring-retreat',
      targetFileRel: 'src/pages/events/spring-retreat.astro',
      styleLikeRoute: '/give',
      unlisted: true,
      purpose: 'Annual spring church retreat in the Santa Cruz mountains.',
    });
    expect(skel1.layoutName).toBe('BaseLayout');
    expect(skel1.content).toContain("import BaseLayout from '../../layouts/BaseLayout.astro';");
    expect(skel1.content).toContain("import PageHeader from '../../components/PageHeader.astro';");
    expect(skel1.content).toContain('indexable={false}');
    expect(skel1.content).toContain(HALLEY_PLACEHOLDER_ATTR);
    // PageHeader renders <h1>, so placeholder must use <h2>
    expect(skel1.content).toContain('<h2 ');
    expect(skel1.content).not.toContain('<h1 ');

    // Blank page picks most common layout (BaseLayout)
    const blank = await generatePageSkeleton({
      repoRoot: CROSSING_ROOT,
      title: 'Volunteer Info',
      route: '/volunteer-info',
      targetFileRel: 'src/pages/volunteer-info.astro',
      styleLikeRoute: '__blank__',
      unlisted: false,
    });
    expect(blank.layoutName).toBe('BaseLayout');
    expect(blank.content).toContain("import BaseLayout from '../layouts/BaseLayout.astro';");
    expect(blank.content).not.toContain('indexable={false}');
  });

  it('extracts top-level nav group labels from rendered header HTML', () => {
    const html = `<!doctype html><html><body>
      <header>
        <nav>
          <a href="/">Home</a>
          <div>
            <button>I'm New</button>
            <div class="absolute hidden"><a href="/im-new/our-staff">Our Staff</a></div>
          </div>
          <a href="/sermons">Sermons</a>
          <a href="/events">Events</a>
          <button aria-label="Search">Search</button>
        </nav>
      </header>
    </body></html>`;
    expect(extractNavGroupsFromHtml(html)).toEqual(["I'm New", 'Sermons', 'Events']);
  });

  it('toggles unlisted state and rewrites relative imports cleanly', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'halley-skel-toggle-'));
    try {
      await fs.mkdir(path.join(tmp, 'src/layouts'), { recursive: true });
      await fs.mkdir(path.join(tmp, 'src/pages/events'), { recursive: true });
      await fs.writeFile(
        path.join(tmp, 'src/layouts/BaseLayout.astro'),
        `---\nexport interface Props { title: string; indexable?: boolean; }\n---\n<html><body><slot /></body></html>\n`,
      );
      const pageAbs = path.join(tmp, 'src/pages/give.astro');
      const src = `---\nimport BaseLayout from '../layouts/BaseLayout.astro';\n---\n<BaseLayout title="Give"><p>Hello</p></BaseLayout>\n`;

      const hidden = await togglePageUnlistedInSource(src, pageAbs, true);
      expect(hidden).toContain('indexable={false}');
      expect(await isPageSourceUnlisted(hidden, '.astro')).toBe(true);

      const unhidden = await togglePageUnlistedInSource(hidden, pageAbs, false);
      expect(unhidden).not.toContain('indexable={false}');
      expect(await isPageSourceUnlisted(unhidden, '.astro')).toBe(false);

      const movedAbs = path.join(tmp, 'src/pages/events/give.astro');
      const rewritten = rewriteRelativeImportsInAstroSource(src, pageAbs, movedAbs);
      expect(rewritten).toContain("import BaseLayout from '../../layouts/BaseLayout.astro';");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
