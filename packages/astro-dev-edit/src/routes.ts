import fs from 'node:fs/promises';
import path from 'node:path';

export interface SiteRouteEntry {
  route: string;
  label: string;
  unlisted?: boolean;
}

const PAGE_EXTS = new Set(['.astro', '.md', '.mdx']);

async function walkPages(dir: string, pagesRoot: string, out: SiteRouteEntry[]): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkPages(full, pagesRoot, out);
      continue;
    }
    const ext = path.extname(entry.name);
    if (!PAGE_EXTS.has(ext)) continue;
    // Skip dynamic template brackets like [slug].astro or 404.astro
    if (entry.name.includes('[') || entry.name === '404.astro') continue;

    const rel = path.relative(pagesRoot, full).split(path.sep).join('/');
    let route = '/' + rel.slice(0, -ext.length);
    if (route === '/index') {
      route = '/';
    } else if (route.endsWith('/index')) {
      route = route.slice(0, -'/index'.length) || '/';
    }
    let unlisted = false;
    try {
      const src = await fs.readFile(full, 'utf8');
      if (/indexable\s*=\s*\{?\s*false\s*\}?|noindex/i.test(src)) {
        unlisted = true;
      }
    } catch {
      // ignore
    }
    out.push({
      route,
      label: route === '/' ? 'Home (/)' : route,
      unlisted,
    });
  }
}

export async function discoverSiteRoutes(repoRoot: string): Promise<SiteRouteEntry[]> {
  const pagesRoot = path.join(repoRoot, 'src', 'pages');
  const routes: SiteRouteEntry[] = [];
  await walkPages(pagesRoot, pagesRoot, routes);
  routes.sort((a, b) => a.route.localeCompare(b.route));
  return routes;
}
